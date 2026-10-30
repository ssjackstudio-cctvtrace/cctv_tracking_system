"""One thread per camera: read RTSP → detect + track people (full body only)
→ place each person in 3D on the shop floor → link them to ONE visitor shared
by all cameras → record In / Passed By / Out from the shop areas they walk
into (Purchasing, Counter, Traffic, see space3d.py) → queue visit /
cctv_event rows for Supabase.
Also keeps each person's latest box (and 3D position) for the website's live video."""

from __future__ import annotations

import logging
import os
import socket
import subprocess
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Callable
from urllib.parse import urlsplit

import math
from dataclasses import dataclass

import cv2
import numpy as np

from .demographics import Demographics, Estimate
from .space3d import INSIDE_KINDS, OUT_OF_RANGE, TRAFFIC, Region, Space
from .reid import Look, Recognizer, comparable, compare
from .biometrics import EVERY_SECONDS as BODY_EVERY_SECONDS, LEARN_SECONDS as BODY_LEARN_SECONDS, \
    PER_FRAME as BODY_PER_FRAME, PartEncoder
from .visitors import KEEP_SECONDS, MAX_DISTANCE, Visitor, VisitorRegistry, look_distance

log = logging.getLogger("camera")

PERSON = 0  # COCO class id for "person"

# camera.active_status: "Active" only while live, open pictures arrive
NO_FRAME_SECONDS = 20  # no new picture for this long → stream lost → Inactive
DARK_SECONDS = 5  # picture almost all black for this long → camera closed → Inactive
DARK_MEAN, DARK_STD = 12, 6  # "almost all black": low brightness and almost no detail (0–255 scale)

# Gender / age: look at each full-body person a few times (all cameras together)
# Photo of each track_id for the Suspicious same person list (Camera page)
PHOTO_MIN_PIXELS = 60  # person at least this tall in the picture
PHOTO_EVERY_SECONDS = float(os.getenv("PERSON_PHOTO_EVERY_SECONDS", "10"))  # a better photo at most this often
PHOTO_BETTER = 1.2  # replaced only by a photo at least 20% better
PHOTO_MAX_WIDTH = 960  # whole camera picture, landscape, scaled down to this width (pixels)
PHOTO_BOX = (0, 200, 255)  # BGR orange: the person's box and track_id label
FACE_SAMPLES = int(os.getenv("DEMOGRAPHIC_SAMPLES", "8"))  # looks (face + whole body) averaged per visitor
FACE_EVERY_SECONDS = 0.5  # gap between two looks at the same person
FACES_PER_FRAME = 1  # people looked at per frame (~0.15 s each on the CPU; keeps counting smooth)
TRACK_DONE_SECONDS = 10  # person not seen for this long → final gender / age sent

# Camera power: while the camera is off (no answer on its RTSP port) the box
# only knocks every few seconds; tracking starts by itself once it powers on.
POWER_CHECK_SECONDS = 5

# Hardware video decoding (RK3588). Unpacking 4 camera streams on the CPU, above
# all stream1 (high resolution), uses most of the box's CPU and makes tracking
# lag. With HW_DECODE=auto (default) the box's ffmpeg unpacks each RTSP stream
# with the chip's video decoder (h264_rkmpp / hevc_rkmpp) and hands over the
# full-size picture; without that ffmpeg (e.g. on a Windows PC) OpenCV is used
# as before. HW_DECODE=off: always OpenCV.
HW_DECODE = os.getenv("HW_DECODE", "auto").strip().lower()
FFMPEG = os.getenv("FFMPEG", "ffmpeg")
FFPROBE = os.getenv("FFPROBE", "ffprobe")
HW_DECODERS = {"h264": "h264_rkmpp", "hevc": "hevc_rkmpp"}  # camera codec → hardware decoder
DECODE_MAX_FPS = float(os.getenv("DECODE_MAX_FPS", "0"))  # > 0: hand over at most this many pictures per second
# Wider pictures are shrunk to this width. Tapo stream1 is 2880x1620: 1920x1080 keeps faces 3x
# larger than stream2 for much less work. 0 = full size.
DECODE_MAX_WIDTH = int(os.getenv("DECODE_MAX_WIDTH", "1920"))
# With the RK3588's RGA (2D engine, ffmpeg filter scale_rkrga) the picture is also shrunk on the chip
# and handed over in the decoder's own colour format (NV12); it becomes BGR (OpenCV) only when the
# program uses it. Measured on the box with 4 cameras at 2880x1620: ~80% CPU instead of ~680%.
HW_FAILS_BEFORE_CPU = 3  # hardware decoding failed this many times in a row → OpenCV ...
HW_RETRY_SECONDS = 600  # ... for 10 minutes, then the hardware decoder is tried again
_hw_decoders: set[str] | None = None
_hw_rga: bool | None = None
_hw_lock = threading.Lock()


def hardware_decoders() -> set[str]:
    """Rockchip hardware decoders the box's ffmpeg has (empty set = none / no ffmpeg). Checked once."""
    global _hw_decoders
    with _hw_lock:
        if _hw_decoders is None:
            _hw_decoders = set()
            if HW_DECODE not in ("off", "0", "false", "no"):
                try:
                    out = subprocess.run([FFMPEG, "-hide_banner", "-decoders"], capture_output=True,
                                         text=True, timeout=10).stdout
                    _hw_decoders = {w for line in out.splitlines() for w in line.split() if w.endswith("_rkmpp")}
                except (OSError, subprocess.SubprocessError):
                    pass
                log.info("video decoding: %s", "RK3588 hardware decoder (ffmpeg rkmpp)" if _hw_decoders
                         else "CPU (OpenCV) — no ffmpeg with rkmpp decoders found")
        return _hw_decoders


def hardware_rga() -> bool:
    """The box's ffmpeg has the RGA filter scale_rkrga (shrink + colour format on the chip). Checked once."""
    global _hw_rga
    with _hw_lock:
        if _hw_rga is None:
            try:
                out = subprocess.run([FFMPEG, "-hide_banner", "-filters"], capture_output=True,
                                     text=True, timeout=10).stdout
                _hw_rga = any(line.split()[1:2] == ["scale_rkrga"] for line in out.splitlines())
            except (OSError, subprocess.SubprocessError):
                _hw_rga = False
        return _hw_rga

# Full body: only people whose WHOLE body is visible (head, upper body,
# lower body and feet) take part in In / Out, areas, 3D and gender / age.
# With a pose model (MODEL=yolo11n-pose...) the body parts are checked one by
# one; with a plain person model the box must not be cut off by the top or
# bottom of the picture and must be tall like a standing person.
# Someone partly hidden is still followed (and keeps their track_id label),
# but is not counted until the full body is seen.
FULL_BODY_RATIO = float(os.getenv("FULL_BODY_RATIO", "1.2"))  # box height / width
# Feet confirmed: the box may END above the feet (legs hidden by a table or a
# shelf) without touching the picture border. Then its bottom is not on the
# floor, and the floor spot would be wrongly far away (e.g. on the Traffic walkway).
# So the body height measured from the box must look like a whole person:
# at least FOOT_MIN_HEIGHT, and not much shorter than this person's height
# measured before (on this or another camera). Otherwise the feet are hidden.
FOOT_MIN_HEIGHT = float(os.getenv("FOOT_MIN_HEIGHT", "1.0"))  # metres
FOOT_HEIGHT_SHARE = float(os.getenv("FOOT_HEIGHT_SHARE", "0.85"))  # of the person's known height
HEIGHT_SAMPLES = 15  # confirmed heights kept per tracked person (median)
BOTTOM_EDGE = 0.985  # box bottom below this share of the picture = feet cut off
TOP_EDGE = 0.01  # box top above this share of the picture = head cut off
MIN_BODY_PIXELS = 60  # smaller people are too far away to judge
FOOT_INSET = 0.25  # feet = bottom corners of the box, moved in by this share of its width
KEYPOINT_CONF = float(os.getenv("KEYPOINT_CONF", "0.45"))  # pose model: a body part is visible above this
HEAD, SHOULDERS, HIPS, ANKLES = (0, 1, 2, 3, 4), (5, 6), (11, 12), (15, 16)  # COCO body points

# Tracker: ByteTrack, keeping a lost person's number longer than the default
# (fewer new numbers after someone walks behind a shelf)
TRACKER = os.getenv("TRACKER") or os.path.join(os.path.dirname(__file__), "..", "trackers", "bytetrack_cctv.yaml")

# Look of each person: face + attire + whole body (reid.py), to keep one
# track_id for one person on all cameras, and never give it to someone else
LOOK_SAMPLES = 8  # looks averaged per tracked person
LOOK_EVERY_SECONDS = 0.5
RECOGNIZE_PER_FRAME = int(os.getenv("RECOGNIZE_PER_FRAME", "1"))  # face + body models run for this many people per frame
SWITCH_LOOKS = 2  # a linked tracker number that looks like ANOTHER person this many times in a row = tracker mixed people up
FORGET_TRACK_SECONDS = 30  # tracker id not seen this long → forget it on this camera
LINK_EVERY_SECONDS = 0.25  # how often an unlinked person is compared with the visitors remembered
LOST_RELINK_SECONDS = min(10.0, KEEP_SECONDS)  # a linked person lost this recently ...
RELINK_PICTURE_DISTANCE = 0.15  # ... and a new number this close (share of the picture), with the same look = same person
RELINK_BLIND_SECONDS = 1.5  # no look yet: only a number that appears right where they were lost, this soon
# A followed person who sits down, crouches, lies down (desk-napping, sleeping) or picks up luggage gets a
# very different box, and the tracker often gives them a NEW number on the same spot. A new number whose box
# overlaps the box where a followed person was lost this recently is that person: no move check (people who
# sit or sleep do not move, and would be taken for an object), and their track_id is kept.
POSTURE_RELINK_SECONDS = float(os.getenv("POSTURE_RELINK_SECONDS", "5.0"))
POSTURE_OVERLAP = float(os.getenv("POSTURE_OVERLAP", "0.4"))  # share of the smaller box covered by the other
# A new person's visit is only made after this long, so a camera whose view
# overlaps another camera's has time to see that it is someone already inside
NEW_VISITOR_HOLD_SECONDS = float(os.getenv("NEW_VISITOR_HOLD_SECONDS", "1.0"))

# Shop areas (camera.floor_areas → regions): the feet must stay in an area this
# long before the visitor counts as being there. Purchasing / Counter = In,
# Traffic = Passed By, anywhere else = Out of Range (Out), see _walk_regions
REGION_STEADY_FRAMES = 3
REGION_MIN_SECONDS = float(os.getenv("REGION_MIN_SECONDS", "1.0"))

# Only things that MOVE are people. A mannequin, a bag on a stand or a poster can
# look like a person to the detector, but it never moves. A new tracker number
# must move (box centre) at least MOVE_MIN_SHARE of its own height before it is
# treated as a person (followed, recognised, counted). If it has not moved after
# STATIC_SECONDS it is an object: ignored on this camera from then on (not shown,
# no track_id, no events). Should it move after all, it becomes a person.
MOVE_CHECK = os.getenv("MOVE_CHECK", "on").strip().lower() not in ("off", "0", "false", "no")
MOVE_MIN_SHARE = float(os.getenv("MOVE_MIN_SHARE", "0.15"))  # 0.15 of a 1.7 m person ≈ 25 cm
STATIC_SECONDS = float(os.getenv("STATIC_SECONDS", "8"))
MOVE_FRAMES = 2  # the move must be seen this many frames in a row (one odd box is not a move)
MOVE_SIZE_RANGE = (0.7, 1.4)  # box height vs. first box: outside this the box was cut / covered, not moved

# Things that are moved BY people (a trolley, a suitcase being pulled, a box being
# carried) also move, so moving alone does not prove "person". Two more checks:
#  - a new tracker number only becomes a person once the detector was SURE at least
#    once (confidence >= PERSON_CONF_PEAK). Objects that look a bit like a person stay
#    below it; real people reach it within a second. Low-confidence boxes still keep
#    an EXISTING person followed while they are partly hidden (see trackers/bytetrack_cctv.yaml).
#  - a full-body box wider on the floor than MAX_BODY_WIDTH metres is a person merged
#    with what they push / carry: not used for areas, 3D or looks until it separates.
PERSON_CONF_PEAK = float(os.getenv("PERSON_CONF_PEAK", "0.50"))
MAX_BODY_WIDTH = float(os.getenv("MAX_BODY_WIDTH", "1.1"))  # metres

# Feet hidden (behind a display table, the counter, another shopper) but the head is
# seen: the floor spot is worked out from the TOP of the head and the person's known
# height (or AVG_PERSON_HEIGHT when the feet are behind a saved obstacle), so the
# position does not jump and the person stays in the right area.
AVG_PERSON_HEIGHT = float(os.getenv("AVG_PERSON_HEIGHT", "1.65"))  # metres
OBSTACLE_SHORT = 1.45  # metres: a box ending on an obstacle and "shorter" than this = legs hidden behind it

# Obstacles: every OBSTACLE_SECONDS the box also looks for furniture / objects
# standing on the floor (COCO classes below) and for "people" that never move
# (mannequins). Ones seen in OBSTACLE_HITS scans in a row are sent with the live
# video, so the Floor map on the Camera details page can show and save them.
OBSTACLE_SECONDS = float(os.getenv("OBSTACLE_SECONDS", "30"))  # 0 = off
OBSTACLE_HITS = 2
OBSTACLE_CLASSES = {13: "bench", 24: "backpack", 26: "handbag", 28: "suitcase", 56: "chair", 57: "couch",
                    58: "potted plant", 60: "table", 62: "tv / screen", 63: "laptop", 72: "refrigerator"}

# Live video: send the picture the AI looked at, with the boxes found in it, so the
# boxes sit exactly on the people (sending the newest picture with older boxes made
# every box trail behind the person it belongs to). If the AI falls behind by more
# than LIVE_SYNC_MAX_AGE seconds, the newest picture is sent without boxes instead.
LIVE_SYNC = os.getenv("LIVE_SYNC", "on").strip().lower() not in ("off", "0", "false", "no")
LIVE_SYNC_MAX_AGE = float(os.getenv("LIVE_SYNC_MAX_AGE", "1.5"))


def cut_head(y1: float, h: int) -> bool:
    """The top of the box touches the top of the picture: the head is cut off."""
    return y1 <= h * TOP_EDGE


def camera_powered_on(source: str | int) -> bool:
    """True when the camera answers on its RTSP port (usually 554), i.e. it is
    switched on and on the network. Files / webcams always count as on."""
    if not (isinstance(source, str) and source.lower().startswith("rtsp")):
        return True
    url = urlsplit(source)
    try:
        with socket.create_connection((url.hostname, url.port or 554), timeout=2):
            return True
    except OSError:
        return False


class FrameGrabber(threading.Thread):
    """Reads the RTSP stream non-stop and keeps only the newest frame, so the
    AI always works on "now" instead of falling behind. Reconnects by itself."""

    def __init__(self, name: str, source: str | int):
        super().__init__(name=f"grab-{name}", daemon=True)
        self.source = source
        self._frame: np.ndarray | None = None
        self._frame_no = 0
        self._lock = threading.Lock()
        self.stop_event = threading.Event()
        self.connected = False
        self.powered: bool | None = None  # camera switched on? (None = not checked yet)
        self._hw_fails = 0  # hardware decoding runs in a row that gave no picture
        self._hw_off_until = 0.0  # OpenCV (CPU) until then, after hardware decoding kept failing
        self._ffmpeg: subprocess.Popen | None = None
        self._nv12: np.ndarray | None = None  # newest picture in NV12 (hardware decoding with RGA)
        self._bgr_no = -1  # picture number that self._frame was converted from

    def latest(self) -> tuple[int, np.ndarray | None]:
        with self._lock:
            no, frame, nv12, bgr_no = self._frame_no, self._frame, self._nv12, self._bgr_no
        if nv12 is None or bgr_no == no:
            return no, frame
        # NV12 → BGR only for pictures the program uses (most are skipped: it takes the newest)
        bgr = cv2.cvtColor(nv12, cv2.COLOR_YUV2BGR_NV12)
        with self._lock:
            if self._frame_no == no:
                self._frame, self._bgr_no = bgr, no
        return no, bgr

    def run(self) -> None:
        is_file = isinstance(self.source, str) and not self.source.lower().startswith("rtsp")
        while not self.stop_event.is_set():
            # Camera off: wait quietly, then start again as soon as it powers on
            if not camera_powered_on(self.source):
                self.connected = False
                if self.powered is not False:
                    log.info("camera is OFF (no answer) — tracking stopped, waiting for it to power on")
                self.powered = False
                self.stop_event.wait(POWER_CHECK_SECONDS)
                continue
            if self.powered is not True:
                log.info("camera is ON — starting live tracking")
            self.powered = True

            # RTSP camera + RK3588 decoder: the chip unpacks the video, not the CPU
            if not is_file and isinstance(self.source, str) and time.time() >= self._hw_off_until \
                    and hardware_decoders():
                if self._read_hw():
                    self._hw_fails = 0
                    if not self.stop_event.is_set():
                        log.warning("stream dropped, reconnecting")
                else:
                    self._hw_fails += 1
                    if self._hw_fails >= HW_FAILS_BEFORE_CPU:
                        self._hw_fails = 0
                        self._hw_off_until = time.time() + HW_RETRY_SECONDS
                        log.warning("hardware decoding failed %d times — using the CPU (OpenCV) for this camera "
                                    "for %d minutes", HW_FAILS_BEFORE_CPU, HW_RETRY_SECONDS // 60)
                self.connected = False
                self.stop_event.wait(2)
                continue

            cap = cv2.VideoCapture(self.source)
            if not cap.isOpened():
                self.connected = False
                log.warning("cannot open stream, retrying in 5s")
                time.sleep(5)
                continue
            self.connected = True
            fps = cap.get(cv2.CAP_PROP_FPS) or 15
            while not self.stop_event.is_set():
                ok, frame = cap.read()
                if not ok:
                    if is_file:  # test video finished → play it again
                        cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                        continue
                    log.warning("stream dropped, reconnecting")
                    break
                with self._lock:
                    self._frame, self._frame_no = frame, self._frame_no + 1
                if is_file:
                    time.sleep(1 / fps)  # play files at real speed
            cap.release()
            self.connected = False
            time.sleep(2)

    def _probe(self) -> tuple[str, int, int] | None:
        """Codec, width and height of the camera's video, or None."""
        cmd = [FFPROBE, "-v", "error", "-analyzeduration", "1000000", "-probesize", "1000000",
               "-rtsp_transport", "tcp", "-select_streams", "v:0",
               "-show_entries", "stream=codec_name,width,height", "-of", "csv=p=0", str(self.source)]
        try:
            out = subprocess.run(cmd, capture_output=True, text=True, timeout=20).stdout.strip().splitlines()
        except (OSError, subprocess.SubprocessError):
            return None
        for line in out:
            parts = [x.strip() for x in line.split(",")]
            nums = [int(x) for x in parts if x.isdigit()]
            codec = next((x for x in parts if x and not x.isdigit()), "")
            if codec and len(nums) >= 2 and nums[0] > 0 and nums[1] > 0:
                return codec, nums[0], nums[1]
        return None

    def _read_hw(self) -> bool:
        """Unpack the RTSP stream with the RK3588 video decoder (ffmpeg rkmpp) and
        keep the newest full-size BGR picture, like the OpenCV path. Returns True
        when pictures arrived (the stream later dropped / stopped), False when
        hardware decoding did not work at all."""
        info = self._probe()
        if info is None:
            log.warning("hardware decoding: could not read the stream's format")
            return False
        codec, w, h = info
        if 0 < DECODE_MAX_WIDTH < w:  # shrink, keeping the shape (even numbers for the video filters)
            w, h = DECODE_MAX_WIDTH // 2 * 2, max(2, round(h * DECODE_MAX_WIDTH / w / 2) * 2)
        decoder = HW_DECODERS.get(codec)
        if decoder not in hardware_decoders():
            log.warning("hardware decoding: no rkmpp decoder for %s video", codec)
            return False
        rga = hardware_rga()
        if rga:
            w = max(16, w // 16 * 16)  # RGA likes widths in steps of 16 (1920, 2880 already are)
        cmd = [FFMPEG, "-hide_banner", "-loglevel", "error", "-nostdin",
               "-rtsp_transport", "tcp", "-timeout", "10000000",  # no data for 10 s = stream lost
               "-analyzeduration", "1000000", "-probesize", "1000000",  # start within ~2 s
               "-fflags", "nobuffer", "-flags", "low_delay"]
        if rga:  # decoded pictures stay on the chip until RGA has shrunk them
            cmd += ["-hwaccel", "rkmpp", "-hwaccel_output_format", "drm_prime"]
        cmd += ["-c:v", decoder, "-i", str(self.source), "-an", "-sn", "-dn"]
        if rga:
            filters = [f"scale_rkrga=w={w}:h={h}:format=nv12", "hwdownload", "format=nv12"]
        else:  # no RGA: shrink and convert on the CPU (slower)
            filters = [f"scale={w}:{h}:flags=bilinear"] if info[1:] != (w, h) else []
        if DECODE_MAX_FPS > 0:
            filters.append(f"fps={DECODE_MAX_FPS:g}")
        if filters:
            cmd += ["-vf", ",".join(filters)]
        cmd += ["-pix_fmt", "nv12" if rga else "bgr24", "-f", "rawvideo", "pipe:1"]
        try:
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
        except OSError as exc:
            log.warning("hardware decoding: cannot start ffmpeg: %s", exc)
            return False
        self._ffmpeg = proc
        threading.Thread(target=self._ffmpeg_errors, args=(proc,), name=f"{self.name}-ffmpeg", daemon=True).start()
        shape = (h * 3 // 2, w) if rga else (h, w, 3)  # NV12: full-size brightness + half-size colour
        size, got = int(np.prod(shape)), 0
        try:
            while not self.stop_event.is_set():
                frame = np.empty(shape, np.uint8)
                buf, n = memoryview(frame).cast("B"), 0
                while n < size:
                    r = proc.stdout.readinto(buf[n:])  # type: ignore[union-attr]
                    if not r:
                        break
                    n += r
                if n < size:
                    break  # ffmpeg stopped: stream dropped / camera gone
                if not got:
                    log.info("hardware decoding %s %dx%d with %s%s", codec, w, h, decoder, " + RGA" if rga else "")
                got += 1
                self.connected = True
                with self._lock:
                    if rga:
                        self._nv12, self._frame_no = frame, self._frame_no + 1
                    else:
                        self._frame, self._frame_no = frame, self._frame_no + 1
        finally:
            self._stop_ffmpeg()
            with self._lock:  # back to plain BGR pictures (OpenCV / next connection)
                if self._nv12 is not None and self._bgr_no != self._frame_no:
                    self._frame, self._bgr_no = cv2.cvtColor(self._nv12, cv2.COLOR_YUV2BGR_NV12), self._frame_no
                self._nv12 = None
        return got > 0

    def _ffmpeg_errors(self, proc: subprocess.Popen) -> None:
        """ffmpeg's error messages into the log (the first few per connection)."""
        shown = 0
        for line in iter(proc.stderr.readline, b""):  # type: ignore[union-attr]
            text = line.decode("utf-8", "replace").strip()
            if text and shown < 5:
                log.warning("ffmpeg: %s", text.replace(str(self.source), "<camera>"))
                shown += 1

    def _stop_ffmpeg(self) -> None:
        proc, self._ffmpeg = self._ffmpeg, None
        if proc is None or proc.poll() is not None:
            return
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()


@dataclass
class Person:
    """One person in the current picture."""

    tid: int  # tracker number on this camera
    box: tuple[float, float, float, float]  # pixels x1, y1, x2, y2
    conf: float
    full: bool  # whole body (head to feet) visible
    foot: tuple[float, float]  # where the feet touch the floor (0-1)
    head: tuple[float, float]  # top of the head (0-1)
    feet: list[tuple[float, float]]  # bottom corners of the box at the feet (empty unless full body)
    floor: tuple[float, float] | None = None  # floor spot in metres (calibrated camera)
    height: float | None = None  # body height in metres
    est_feet: bool = False  # feet hidden: foot / floor worked out from the head and the body height


@dataclass
class _RegionState:
    current: str | None = None  # region id the person is steadily in on this camera ("" = none)
    region: Region | None = None
    kind: str | None = None  # track_region of the steady spot: Purchasing / Counter / Traffic / Out of Range
    candidate: str | None = None
    streak: int = 0
    since: float = 0.0


@dataclass
class _Motion:
    """Has this tracker number moved yet? (see MOVE_CHECK)"""

    first: float  # time first seen
    anchor: tuple[float, float, float]  # box centre x, y and box height (pixels) when first seen
    seen: float = 0.0
    moving: bool = False  # moved: a person
    static: bool = False  # never moved for STATIC_SECONDS: an object, ignored
    hits: int = 0  # frames in a row that showed a move
    peak: float = 0.0  # highest detection confidence seen (see PERSON_CONF_PEAK)
    box: tuple[float, float, float, float] | None = None  # newest box (pixels), for obstacles


class CameraWorker(threading.Thread):
    def __init__(
        self,
        camera: dict[str, Any],
        source: str | int,
        model_path: str,
        confidence: float,
        image_size: int,
        anchor: str,
        insert: Callable[..., None],
        offer_snapshot: Callable[[str, bytes], None] | None,
        snapshot_seconds: float,
        show: bool = False,
        update: Callable[..., None] | None = None,
        registry: VisitorRegistry | None = None,
        offer_photo: Callable[[str, bytes], None] | None = None,
        body_matcher: Any = None,
    ):
        super().__init__(name=f"cam-{camera['camera_name']}", daemon=True)
        self.camera = camera
        self.grabber = FrameGrabber(camera["camera_name"], source)
        self.model_path, self.confidence, self.image_size, self.anchor = model_path, confidence, image_size, anchor
        self.insert, self.offer_snapshot, self.snapshot_seconds = insert, offer_snapshot, snapshot_seconds
        self.show = show
        self.update = update  # update(table, values, **filters), for a visit's gender / age
        self.offer_photo = offer_photo  # offer_photo(visit_id, jpeg): photo of a track_id (Suspicious same person)
        # Staff / members recognised by body parts from any side (biometrics.py); None = off
        self.body_matcher = body_matcher
        self._parts: PartEncoder | None = None  # made in run() (its model belongs to this thread)
        self._body_at: dict[int, float] = {}  # tracker id → last time its body parts were compared
        self._estimates: dict[int, Estimate] = {}  # tracker id → gender / age seen BEFORE it is linked to a visitor
        self._last_look: dict[int, float] = {}  # tracker id → last time its face / body was checked
        # 3D floor + shop areas; the automatic floor (camera 3.25 m high) until the Camera page saves one
        self.space = Space.from_json(camera.get("floor_areas")) or Space.automatic()
        self._heights: dict[int, list[float]] = {}  # tracker id → body heights measured with the feet seen
        self.stop_event = threading.Event()
        self.last_frame_at = 0.0  # used for camera.last_seen_at
        self.dark_since: float | None = None  # when the picture went black (camera closed)
        self.reported_status: str | None = None  # active_status last sent to Supabase
        self.preview: np.ndarray | None = None  # for --show
        # Visitors inside the shop, shared by all cameras of this box (one track_id per person)
        self.registry = registry or VisitorRegistry()
        self._link: dict[int, Visitor] = {}  # tracker id → visitor it is (kept while the person is remembered)
        self._look: dict[int, Look] = {}  # tracker id → averaged face / attire / body look (full body only)
        self._look_n: dict[int, int] = {}
        self._look_at: dict[int, float] = {}
        self._mismatch: dict[int, int] = {}  # tracker id → looks in a row that do not fit its visitor
        self._recog: Recognizer | None = None  # made in run() (its models belong to this thread)
        self._seen_at: dict[int, float] = {}  # tracker id → last time in the picture
        self._spot: dict[int, tuple[float, float]] = {}  # tracker id → last feet point in the picture (0-1)
        self._from_outside: set[int] = set()  # tracker ids seen on the Traffic walkway (walked in from outside)
        self._tried_at: dict[int, float] = {}  # tracker id → last time it was compared with the visitors
        # tracker id → (time it went In, confidence, walked in from outside), no visitor yet
        self._pending: dict[int, tuple[float, float, bool]] = {}
        self._regions: dict[int, _RegionState] = {}
        # tracker id → (time it stepped onto the Traffic walkway, confidence), not known yet: Passed By
        self._passing: dict[int, tuple[float, float]] = {}
        self._motion: dict[int, _Motion] = {}  # tracker id → has it moved (person) or not (object)
        self._session = uuid.uuid4().hex[:6]  # tracker ids restart at 1 after a restart
        self._used_track_ids: set[str] = set()  # track_ids given to visits: never given again
        self.counts = {"In": 0, "Out": 0}
        # Newest people for the live video:
        # [{"track", "b": [x1, y1, x2, y2] (0-1), "area", "visit", "full", "xyz", "region", "kind", "g", "a", "s"}]
        self.live_boxes: list[dict[str, Any]] = []
        self.live_frame_no = 0
        # (frame no, picture the AI looked at, its boxes, time): sent together by the live video
        self.live: tuple[int, np.ndarray, list[dict[str, Any]], float] | None = None
        # Obstacles found on the floor (furniture, mannequins), for the Floor map:
        # [{"id", "label", "b": [x1, y1, x2, y2] (0-1)}]
        self.obstacles_live: list[dict[str, Any]] = []
        self._obstacle_seen: list[dict[str, Any]] = []  # candidates with their hit counts
        self._obstacle_model: Any = None

    def track_name(self, tid: int) -> str:
        """Same text as visit.track_id, e.g. ABT-01-3f9a2c-7."""
        return f"{self.camera['camera_name']}-{self._session}-{tid}"

    def _new_track_id(self, tid: int) -> str:
        """A track_id never given before: if this tracker number already had a
        visit (the tracker mixed up two people), the new person gets e.g. ...-7.2"""
        name, n = self.track_name(tid), 1
        while name in self._used_track_ids:
            n += 1
            name = f"{self.track_name(tid)}.{n}"
        self._used_track_ids.add(name)
        return name

    # ---------- Full body ----------
    def _person(self, tid: int, box: tuple[float, float, float, float], conf: float,
                kp_xy: np.ndarray | None, kp_conf: np.ndarray | None, w: int, h: int) -> Person:
        x1, y1, x2, y2 = box
        bw, bh = max(x2 - x1, 1.0), max(y2 - y1, 1.0)
        cx = (x1 + x2) / 2
        if self.anchor == "center":  # camera looking straight down: no feet / head to see
            c = (cx / w, ((y1 + y2) / 2) / h)
            return Person(tid, box, conf, True, c, c, [c])

        cut = y2 >= h * BOTTOM_EDGE or y1 <= h * TOP_EDGE or bh < MIN_BODY_PIXELS
        foot_y = y2
        if kp_xy is not None and kp_conf is not None:
            seen = kp_conf >= KEYPOINT_CONF
            parts = [any(seen[i] for i in group) for group in (HEAD, SHOULDERS, HIPS, ANKLES)]
            full = not cut and all(parts)  # head, upper body, lower body and feet
            if full:
                ankles = [kp_xy[i] for i in ANKLES if seen[i]]
                foot_y = min(y2, max(float(a[1]) for a in ankles) + 0.03 * bh)  # sole a little below the ankle
                cx = float(np.mean([a[0] for a in ankles]))
        else:
            full = not cut and bh / bw >= FULL_BODY_RATIO
        foot = (cx / w, foot_y / h)
        head = (((x1 + x2) / 2) / w, y1 / h)
        p = Person(tid, box, conf, full, foot, head, [])
        calibrated = self.space is not None and self.space.calibrated
        known = self._known_height(tid)
        if full and calibrated:
            p.floor = self.space.floor_of(foot)
            p.height = self.space.height_of(p.floor, head) if p.floor is not None else None
            # Feet really on the floor? A box cut by a table is short for this person.
            # (No believable height, e.g. 3D floor not adjusted yet: the box is trusted as before.)
            if p.height is not None and (p.height < FOOT_MIN_HEIGHT or (known is not None and p.height < known * FOOT_HEIGHT_SHARE)):
                p.full, p.floor, p.height = False, None, None
            elif (p.height is None or p.height < OBSTACLE_SHORT) and \
                    self.space.behind_obstacle((x1 / w, y1 / h, x2 / w, y2 / h)) is not None:
                p.full, p.floor, p.height = False, None, None  # box ends on a saved table / counter: legs hidden
            elif p.floor is not None and self._too_wide(box, w, h):
                p.full, p.floor, p.height = False, None, None  # person + trolley / big box in one box
            elif p.height is not None:
                hs = self._heights.setdefault(tid, [])
                hs.append(p.height)
                del hs[:-HEIGHT_SAMPLES]
        if not p.full and calibrated and not cut_head(y1, h):
            self._feet_from_head(p, w, h, known)
        if p.full:  # feet confirmed on the floor: they may count for In / Out and areas
            inset = bw * FOOT_INSET
            p.feet = [((x1 + inset) / w, foot_y / h), ((x2 - inset) / w, foot_y / h)]
        return p

    def _too_wide(self, box: tuple[float, float, float, float], w: int, h: int) -> bool:
        """The box's bottom edge is wider on the floor than one person can be."""
        x1, _, x2, y2 = box
        a = self.space.floor_of((x1 / w, y2 / h))
        b = self.space.floor_of((x2 / w, y2 / h))
        return a is not None and b is not None and math.dist(a, b) > MAX_BODY_WIDTH

    def _feet_from_head(self, p: Person, w: int, h: int, known: float | None) -> None:
        """Feet hidden (box ends above the floor: a table, the counter, a display
        or another shopper in front), head seen: floor spot from the top of the
        head and the body height. Known height of this person first; behind a
        saved obstacle, the average height will do."""
        x1, y1, x2, y2 = p.box
        if y2 - y1 < MIN_BODY_PIXELS * 0.6:
            return
        height = known
        if height is None and self.space.behind_obstacle((x1 / w, y1 / h, x2 / w, y2 / h)) is not None:
            height = AVG_PERSON_HEIGHT
        if height is None:
            return
        floor = self.space.floor_from_head(p.head, height)
        foot = self.space.to_picture(floor[0], floor[1], 0.0) if floor is not None else None
        # the worked-out feet must be BELOW the bottom of the box (really hidden) and in the picture
        if foot is None or not (-0.02 <= foot[0] <= 1.02 and y2 / h - 0.01 <= foot[1] <= 1.05):
            return
        p.floor, p.height, p.foot, p.est_feet = floor, height, foot, True

    def _known_height(self, tid: int) -> float | None:
        """This person's body height (metres), measured earlier with their feet
        seen: on this camera (median), or by any camera (their visitor)."""
        hs = self._heights.get(tid)
        if hs and len(hs) >= 3:
            return float(np.median(hs))
        v = self._link.get(tid)
        return v.height if v is not None and not v.left else None

    # Called by main when the dashboard changes the camera (e.g. new shop areas)
    def update_camera(self, camera: dict[str, Any]) -> None:
        if camera.get("floor_areas") != self.camera.get("floor_areas"):
            self.space = Space.from_json(camera.get("floor_areas")) or Space.automatic()
            self._regions.clear()
        self.camera = camera

    def stop(self) -> None:
        self.stop_event.set()
        self.grabber.stop_event.set()
        self.grabber._stop_ffmpeg()  # hardware decoding: end ffmpeg now (also ends a hung stream)

    # "Active": the stream is connected and the camera picture is open.
    # "Inactive": not connected, no new picture lately, or the picture is
    # black (camera closed, e.g. Tapo privacy mode).
    def active_status(self) -> str:
        now = time.time()
        if not self.grabber.connected or now - self.last_frame_at > NO_FRAME_SECONDS:
            return "Inactive"
        if self.dark_since is not None and now - self.dark_since >= DARK_SECONDS:
            return "Inactive"
        return "Active"

    def run(self) -> None:
        from ultralytics import YOLO  # imported here so --help works without it

        model = YOLO(self.model_path)
        demo = Demographics()  # gender / age models (off if the model files are missing)
        self._recog = Recognizer()  # face / whole-body recognition models (attire only if missing)
        if self.body_matcher is not None:
            self._parts = PartEncoder(self._recog.body_net)
        tracker = TRACKER if os.path.isfile(TRACKER) else "bytetrack.yaml"
        self.grabber.start()
        log.info("started (model %s, tracker %s)", self.model_path, os.path.basename(tracker))
        if not self.space.counting:
            log.warning("no shop areas yet — draw Purchasing / Counter / Traffic on the Camera page "
                        "(or tick Inside only); counting is paused")
        if not self.space.shared:
            log.info("camera not placed on the shop plan yet (Camera page → Shop areas (3D)): people are "
                     "matched across cameras by their face, clothes and body only")

        last_no, last_snapshot, last_dark_check = 0, 0.0, 0.0
        last_obstacles = time.time() - OBSTACLE_SECONDS + 10  # first scan 10 s after start
        paused = False  # True while the camera picture is closed (black)
        pose_logged = False
        while not self.stop_event.is_set():
            frame_no, frame = self.grabber.latest()
            if frame is None or frame_no == last_no:
                if not self.grabber.connected:
                    self.preview = None  # camera off: --show closes its window
                    time.sleep(0.5)
                else:
                    time.sleep(0.01)
                continue
            last_no = frame_no
            now = time.time()
            self.last_frame_at = now
            h, w = frame.shape[:2]

            # Camera closed? (the picture turns almost all black)
            if now - last_dark_check >= 1:
                last_dark_check = now
                mean, std = cv2.meanStdDev(cv2.resize(frame, (64, 36)))
                if float(mean.mean()) < DARK_MEAN and float(std.mean()) < DARK_STD:
                    if self.dark_since is None:
                        self.dark_since = now
                else:
                    if self.dark_since is not None and now - self.dark_since >= DARK_SECONDS:
                        log.info("camera picture open again — tracking resumed")
                    self.dark_since = None

            # Camera closed (Tapo privacy mode / black picture): no people to
            # track, so skip the AI and close the --show window until it opens
            if self.dark_since is not None and now - self.dark_since >= DARK_SECONDS:
                if not paused:
                    log.info("camera picture closed — tracking paused")
                    paused = True
                self.preview = None
                self.live_boxes = []
                self.live = None
                continue
            paused = False

            result = model.track(
                frame,
                persist=True,
                classes=[PERSON],
                conf=self.confidence,
                imgsz=self.image_size,
                tracker=tracker,
                verbose=False,
            )[0]

            people: list[Person] = []
            boxes = result.boxes
            if boxes is not None and boxes.id is not None:
                kps = getattr(result, "keypoints", None)
                kp_xy = kp_conf = None
                if kps is not None and getattr(kps, "conf", None) is not None:
                    kp_xy, kp_conf = kps.xy.cpu().numpy(), kps.conf.cpu().numpy()
                    if not pose_logged:
                        log.info("pose model: full body checked part by part (head, upper body, lower body, feet)")
                        pose_logged = True
                for i, ((x1, y1, x2, y2), tid, conf) in enumerate(
                    zip(boxes.xyxy.tolist(), boxes.id.int().tolist(), boxes.conf.tolist())
                ):
                    people.append(self._person(
                        tid, (x1, y1, x2, y2), conf,
                        kp_xy[i] if kp_xy is not None else None, kp_conf[i] if kp_conf is not None else None, w, h,
                    ))
            people, waiting = self._moving(people, now)  # only people who move; objects are dropped
            by_tid = {p.tid: p for p in people}

            self._identify(frame, people, now)
            self._walk_regions(frame, people, now)  # In / Passed By / Out from the shop areas
            self._make_visitors(frame, by_tid, now)
            self._make_passers(frame, by_tid, now)  # people on the walkway: Passed By

            if demo.enabled:
                self._look_at_people(demo, frame, people, now)
            if self.offer_photo:
                self._take_photos(frame, people, now)

            # For the website's live video: where each person is in this frame, and who they are
            self.live_boxes = [self._live_box(p, w, h) for p in people + waiting]
            self.live_frame_no = frame_no
            self.live = (frame_no, frame, self.live_boxes, time.time())  # picture + its boxes, together

            if OBSTACLE_SECONDS > 0 and now - last_obstacles >= OBSTACLE_SECONDS:
                last_obstacles = now
                self._scan_obstacles(frame, now)

            if self.offer_snapshot and now - last_snapshot >= self.snapshot_seconds:
                ok, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 70])
                if ok:
                    self.offer_snapshot(self.camera["camera_id"], jpeg.tobytes())
                last_snapshot = now

            if self.show:
                self.preview = self._draw(frame.copy(), people + waiting)

        self.grabber.stop_event.set()

    def _moving(self, people: list[Person], now: float) -> tuple[list[Person], list[Person]]:
        """Split the detections into (people: they have moved, so they are
        followed and counted, waiting: not moved yet, shown on the live video
        only with "Show everyone detected"). Objects that never moved for
        STATIC_SECONDS are left out of both: they are not tracked any more.
        A detection the detector was never sure about (PERSON_CONF_PEAK) also
        waits: things pushed or carried by people move too."""
        moving: list[Person] = []
        waiting: list[Person] = []
        present = {p.tid for p in people}
        for p in people:
            x1, y1, x2, y2 = p.box
            cx, cy, bh = (x1 + x2) / 2, (y1 + y2) / 2, max(y2 - y1, 1.0)
            m = self._motion.get(p.tid)
            if m is None:
                m = self._motion[p.tid] = _Motion(now, (cx, cy, bh))
                if self._on_lost_person(p.tid, p.box, now, present) is not None:
                    # a followed person with a new tracker number (sat down, lay down, crouched):
                    # a person already, whether they move or not
                    m.moving, m.peak = True, PERSON_CONF_PEAK
            m.seen, m.box = now, p.box
            m.peak = max(m.peak, p.conf)
            if m.peak < PERSON_CONF_PEAK:
                waiting.append(p)  # detector never sure yet: may be an object (a trolley, a bag)
                continue
            if not MOVE_CHECK:
                moving.append(p)
                continue
            if not m.moving:
                ax, ay, ah = m.anchor
                shift = math.hypot(cx - ax, cy - ay) / ah
                size = bh / ah
                if shift >= MOVE_MIN_SHARE and MOVE_SIZE_RANGE[0] <= size <= MOVE_SIZE_RANGE[1]:
                    m.hits += 1
                else:
                    m.hits = 0
                if m.hits >= MOVE_FRAMES:
                    if m.static:
                        log.info("detection %s moved after all: a person, tracked again", p.tid)
                    m.moving, m.static = True, False
                elif not m.static and now - m.first >= STATIC_SECONDS:
                    m.static = True
                    log.info("detection %s has not moved for %.0f s: not a person (object), ignored",
                             p.tid, STATIC_SECONDS)
            if m.moving:
                moving.append(p)
            elif not m.static:
                waiting.append(p)
        for tid in [t for t, m in self._motion.items() if now - m.seen > FORGET_TRACK_SECONDS]:
            del self._motion[tid]
        return moving, waiting

    def _scan_obstacles(self, frame: np.ndarray, now: float) -> None:
        """Furniture / objects standing on the floor, and "people" that never
        move (mannequins). Kept when seen OBSTACLE_HITS scans in a row at the
        same place; sent with the live video for the Floor map."""
        h, w = frame.shape[:2]
        found: list[tuple[str, tuple[float, float, float, float]]] = []
        try:
            if self._obstacle_model is None:
                from ultralytics import YOLO

                self._obstacle_model = YOLO(self.model_path)  # own copy: never disturbs the people tracker
            res = self._obstacle_model.predict(frame, classes=list(OBSTACLE_CLASSES), conf=0.35,
                                               imgsz=self.image_size, verbose=False)[0]
            if res.boxes is not None:
                for (x1, y1, x2, y2), c in zip(res.boxes.xyxy.tolist(), res.boxes.cls.int().tolist()):
                    found.append((OBSTACLE_CLASSES.get(c, "object"), (x1 / w, y1 / h, x2 / w, y2 / h)))
        except Exception as exc:  # never stop the people tracking for this
            log.warning("obstacle scan failed: %s", exc)
            return
        for m in self._motion.values():  # mannequins / stands detected as a "person" that never moved
            if m.static and m.box is not None and now - m.seen < OBSTACLE_SECONDS:
                x1, y1, x2, y2 = m.box
                found.append(("mannequin / stand", (x1 / w, y1 / h, x2 / w, y2 / h)))

        def iou(a, b) -> float:
            ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
            iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
            inter = ix * iy
            union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
            return inter / union if union > 0 else 0.0

        kept: list[dict[str, Any]] = []
        for label, b in found:
            old = next((o for o in self._obstacle_seen if iou(o["box"], b) >= 0.5), None)
            hits = old["hits"] + 1 if old else 1
            if old:
                self._obstacle_seen.remove(old)
            kept.append({"label": label, "box": b, "hits": hits})
        self._obstacle_seen = kept  # not seen again in this scan: dropped
        self.obstacles_live = [
            {"id": f"o{i + 1}", "label": o["label"], "b": [round(v, 4) for v in o["box"]]}
            for i, o in enumerate(o for o in kept if o["hits"] >= OBSTACLE_HITS)
        ]

    def _live_box(self, p: Person, w: int, h: int) -> dict[str, Any]:
        x1, y1, x2, y2 = p.box
        v = self._link.get(p.tid)
        if v is not None and v.left:
            v = None
        est = v.estimate if v is not None else self._estimates.get(p.tid)
        f = est.visit_fields() if est is not None and est.samples else None
        st = self._regions.get(p.tid)
        region = st.region if st is not None else None
        return {
            "track": v.track_id if v is not None else self.track_name(p.tid),
            "b": [round(x1 / w, 4), round(y1 / h, 4), round(x2 / w, 4), round(y2 / h, 4)],
            "area": "in" if st is not None and st.kind in INSIDE_KINDS else (
                "out" if st is not None and st.kind is not None else None),
            "visit": v is not None,  # linked to a visitor (has a visit row / track_id)
            "full": p.full,
            "est": p.est_feet,  # feet hidden: floor spot worked out from the head
            "xyz": [round(p.floor[0], 2), round(p.floor[1], 2), round(p.height or 1.7, 2)] if p.floor else None,
            "region": region.name if region else None,
            "kind": region.kind if region else None,
            "g": f["est_gender"] if f else None,
            "a": f["est_age"] if f else None,
            "s": f["demographic_score"] if f else None,
        }

    # ---------- Who is who (one track_id per person on all cameras) ----------
    def _identify(self, frame: np.ndarray, people: list[Person], now: float) -> None:
        """Every frame: keep each tracked person linked to their visitor,
        recognise new tracker numbers (face, attire, whole body) against the
        people the box remembers, learn how people look."""
        cam_id = self.camera["camera_id"]
        present = {p.tid for p in people}
        for tid in [t for t, v in self._link.items() if v.left]:  # track_id ended (unseen KEEP_SECONDS)
            del self._link[tid]
            if tid in present:
                self._unlinked_inside(tid, now)
        # visitors followed in this picture right now: nobody else in the picture can be them
        busy = {self._link[t].visit_id for t in present if t in self._link}

        # Looks: attire for everyone due; face + whole body for a few people per frame
        # (people not linked yet first: they need recognising before they get a track_id)
        due = [p for p in people if p.full and self._look_n.get(p.tid, 0) < LOOK_SAMPLES
               and now - self._look_at.get(p.tid, 0.0) >= LOOK_EVERY_SECONDS]
        due.sort(key=lambda p: (p.tid in self._link, self._look_n.get(p.tid, 0)))
        for i, p in enumerate(due):
            self._look_at[p.tid] = now
            look = self._recog.look(frame, p.box, p.height, heavy=i < RECOGNIZE_PER_FRAME) if self._recog \
                else None
            self._check_look(p.tid, look, now)  # partly hidden bodies give wrong looks: full body only

        for p in people:
            tid = p.tid
            self._seen_at[tid] = now
            self._spot[tid] = p.foot

            v = self._link.get(tid)
            if v is not None:  # already linked: the label stays the same while the person is followed
                self.registry.seen(v, cam_id, now, self._plan(p), p.height, p.conf)
                continue
            if now - self._tried_at.get(tid, 0.0) < LINK_EVERY_SECONDS:
                continue
            self._tried_at[tid] = now
            v = self._relink_lost(p, present, busy, now)
            how = "same person, new tracker number"
            if v is None and self._may_be_inside(p):
                # someone who walked in from outside can only be a visitor another camera sees now
                v = self.registry.match(self._look.get(tid), self._plan(p), exclude=busy, now=now,
                                        visible_only=tid in self._from_outside,
                                        inside_only=tid not in self._from_outside, camera_id=cam_id)
                how = "recognised, seen by another camera" if v is not None and v.seen_on.keys() - {cam_id} \
                    else "recognised, seen a moment ago"
            elif v is None:
                # standing outside: a visitor who went Out (keeps their track_id label), or one
                # who was inside a few seconds ago and just walked out with a new tracker number
                # (then their Passed By is recorded by _walk_regions)
                v = self.registry.match(self._look.get(tid), self._plan(p), exclude=busy, now=now,
                                        outside_only=True, just_out=True, camera_id=cam_id)
                how = "recognised, outside the shop" if v is None or v.outside else "recognised, just walked out"
            if v is not None:
                self._attach(tid, v, now, how)
                busy.add(v.visit_id)
                self.registry.seen(v, cam_id, now, self._plan(p), p.height, p.conf)

        self._recognise_body(frame, people, now)

        # Forget tracker numbers gone for a long time (the visitor ends KEEP_SECONDS after no camera sees them)
        for tid in [t for t, seen in self._seen_at.items() if now - seen > FORGET_TRACK_SECONDS]:
            v = self._link.get(tid)
            if v is not None:
                self._send_estimate(v, final=True)
            self._from_outside.discard(tid)
            for d in (self._seen_at, self._spot, self._link, self._look, self._look_n, self._look_at,
                      self._tried_at, self._pending, self._regions, self._estimates, self._last_look,
                      self._mismatch, self._passing, self._body_at):
                d.pop(tid, None)

    def _recognise_body(self, frame: np.ndarray, people: list[Person], now: float) -> None:
        """Staff / members by body parts, from any angle (biometrics.py): people with a
        track_id who are not recognised yet, every BODY_EVERY_SECONDS; people already
        recognised keep being sampled every BODY_LEARN_SECONDS while followed (turning,
        sitting, crouching, carrying things), so every camera learns how they look from
        all sides. A few people per frame."""
        m = self.body_matcher
        if m is None or self._parts is None or not m.ready:
            return
        h = frame.shape[0]
        done = 0
        for p in sorted(people, key=lambda q: self._body_at.get(q.tid, 0.0)):  # longest waiting first
            if done >= BODY_PER_FRAME:
                break
            v = self._link.get(p.tid)
            if v is None:
                continue
            known = m.known(v.visit_id)
            if now - self._body_at.get(p.tid, 0.0) < (BODY_LEARN_SECONDS if known else BODY_EVERY_SECONDS):
                continue
            self._body_at[p.tid] = now
            feats = self._parts.live_features(frame, p.box, p.full and not p.est_feet, cut_head(p.box[1], h))
            done += 1
            if not feats:
                continue
            if known:
                m.learn(v, feats, self._parts.model_name)
            else:
                m.observe(v, self.camera["camera_id"], feats, self._parts.model_name)

    def _check_look(self, tid: int, look: Look | None, now: float) -> None:
        """Add a new look of this tracker number. If it is linked to a visitor
        but now clearly looks like ANOTHER person (other face / clothes / body)
        a few times in a row, the tracker mixed two people up: the link is
        dropped, so the other person never gets this visitor's track_id."""
        if look is None or look.empty:
            return
        v = self._link.get(tid)
        # Compared with what THIS camera saw of the visitor (same angle, same light), never with
        # the other cameras' looks: those differ for the same person and made the box drop a
        # correct link ("tracker mixed up two people") and hand out a new track_id.
        own = v.looks.get(self.camera["camera_id"]) if v is not None else None
        if own is not None and comparable(look, own) and compare(look, own) is None:
            self._mismatch[tid] = self._mismatch.get(tid, 0) + 1
            if self._mismatch[tid] >= SWITCH_LOOKS:
                log.info("person %s no longer looks like %s (tracker mixed up two people): new identity",
                         tid, v.track_id)
                del self._link[tid]
                for d in (self._look, self._look_n, self._mismatch, self._estimates, self._last_look):
                    d.pop(tid, None)
                self._add_look(tid, look)
                self._unlinked_inside(tid, now)
            return
        self._mismatch.pop(tid, None)
        self._add_look(tid, look)
        if v is not None:
            with self.registry._lock:
                v.add_look(look, self.camera["camera_id"])

    def _unlinked_inside(self, tid: int, now: float) -> None:
        """A person in a shop area (Purchasing / Counter) lost their visitor
        (track_id ended, or tracker mix-up): recognise them again, or make a
        new visit for them, like someone who just went In."""
        st = self._regions.get(tid)
        if st is not None and st.kind in INSIDE_KINDS:
            self._pending.setdefault(tid, (now, 0.0, False))

    def _plan(self, p: Person) -> tuple[float, float] | None:
        """Floor spot on the SHOP plan (shared by all cameras), or None when this
        camera is not placed on the plan: then its floor is its own and cannot be
        compared with the other cameras' floor spots."""
        return p.floor if self.space is not None and self.space.shared else None

    def _may_be_inside(self, p: Person) -> bool:
        """Only people inside the shop are compared with the visitors inside, so
        a passer-by outside who dresses alike never takes a visitor's track_id.
        Outside = steadily on the Traffic walkway, or Out of Range."""
        st = self._regions.get(p.tid)
        return st is None or st.kind is None or st.kind in INSIDE_KINDS

    def _relink_lost(self, p: Person, present: set[int], busy: set[str], now: float) -> Visitor | None:
        """The tracker lost a linked person for a moment and gave them a new
        number: the new number near the spot where they were lost, WITH THE
        SAME LOOK (face / attire / body), is the same visitor (same track_id).
        Without a look yet, only a number that appears right on that spot,
        straight away. So a different person walking past the same spot (e.g.
        the entrance) never gets the lost person's track_id."""
        best, best_d = None, RELINK_PICTURE_DISTANCE
        sig = self._look.get(p.tid)
        for old, v in self._link.items():
            if old in present or v.left or v.visit_id in busy:
                continue
            lost_for = now - self._seen_at.get(old, 0.0)
            if lost_for > LOST_RELINK_SECONDS or old not in self._spot:
                continue
            d = math.dist(self._spot[old], p.foot)
            if d >= best_d:
                continue
            ok, same = look_distance(sig, v, self.camera["camera_id"])  # this camera's look first
            if ok:
                if same is None or same > MAX_DISTANCE:
                    continue  # another person
            elif lost_for > RELINK_BLIND_SECONDS or d >= RELINK_PICTURE_DISTANCE / 2:
                continue  # nothing to recognise them by yet: too far / too late to be sure
            best, best_d = (old, v), d
        if best is None:
            # posture change (sat / lay down, crouched, picked something up): the new box covers the old one
            old = self._on_lost_person(p.tid, p.box, now, present)
            if old is not None and self._link[old].visit_id not in busy and not self._link[old].left:
                best = (old, self._link[old])
        if best is None:
            return None
        del self._link[best[0]]
        return best[1]

    def _on_lost_person(self, tid: int, box: tuple[float, float, float, float], now: float,
                        present: set[int]) -> int | None:
        """Tracker number of a followed person lost in the last POSTURE_RELINK_SECONDS
        whose last box overlaps this box (POSTURE_OVERLAP), best overlap first."""
        best, best_share = None, POSTURE_OVERLAP
        for old in self._link:
            if old == tid or old in present:  # still in the picture: not lost
                continue
            if now - self._seen_at.get(old, 0.0) > POSTURE_RELINK_SECONDS:
                continue
            mo = self._motion.get(old)
            if mo is None or mo.box is None:
                continue
            ax1, ay1, ax2, ay2 = mo.box
            bx1, by1, bx2, by2 = box
            inter = max(0.0, min(ax2, bx2) - max(ax1, bx1)) * max(0.0, min(ay2, by2) - max(ay1, by1))
            smaller = min((ax2 - ax1) * (ay2 - ay1), (bx2 - bx1) * (by2 - by1))
            share = inter / smaller if smaller > 0 else 0.0
            if share >= best_share:
                best, best_share = old, share
        return best

    def _attach(self, tid: int, v: Visitor, now: float, how: str) -> None:
        self._link[tid] = v
        self._mismatch.pop(tid, None)
        look = self._look.get(tid)
        if look is not None:
            with self.registry._lock:
                v.add_look(look, self.camera["camera_id"])
        est = self._estimates.pop(tid, None)  # gender / age seen before the link
        if est is not None and est.samples:
            with self.registry._lock:
                v.estimate.merge(est)
            self._send_estimate(v)
        log.info("person %s is %s (%s)", tid, v.track_id, how)

    def _add_look(self, tid: int, look: Look | None) -> None:
        if look is None or look.empty:
            return
        cur = self._look.get(tid)
        if cur is None:
            self._look[tid] = look.copy()
        else:
            cur.add(look)
        self._look_n[tid] = self._look_n.get(tid, 0) + 1

    # ---------- In (new people) ----------
    def _make_visitors(self, frame: np.ndarray, by_tid: dict[int, Person], now: float) -> None:
        """People who went In without being linked to a visitor: wait a moment
        (another camera may already know them), recognise them, then link or
        make a new visit. Someone who appeared INSIDE (did not walk in from
        outside) is first given back to a visitor hidden for a few seconds
        (same look): a new visit is only made when nobody matches."""
        cam_id = self.camera["camera_id"]
        for tid, (when, conf, from_out) in list(self._pending.items()):
            v = self._link.get(tid)
            if v is not None and not v.left:
                del self._pending[tid]
                if not (v.outside and not from_out):
                    self._camera_in(v, conf, tid, when)
                continue
            p = by_tid.get(tid)
            if p is None or not p.full or now - when < NEW_VISITOR_HOLD_SECONDS:
                continue  # hidden / not full body yet / still waiting
            del self._pending[tid]
            conf = conf or p.conf
            if tid not in self._look and self._recog is not None:
                self._add_look(tid, self._recog.look(frame, p.box, p.height, heavy=True))
            sig = self._look.get(tid)
            busy = {self._link[t].visit_id for t in by_tid if t in self._link and not self._link[t].left}
            if not from_out:
                v = self.registry.match(sig, self._plan(p), exclude=busy, now=now, inside_only=True,
                                        camera_id=cam_id) or \
                    self.registry.reclaim(sig, self._plan(p), busy, now, camera_id=cam_id)
                if v is not None:
                    self._attach(tid, v, now, "recognised, back after being hidden")
                    self.registry.seen(v, cam_id, now, self._plan(p), p.height, p.conf)
                    self._camera_in(v, conf, tid, when)
                    continue
            v, created = self.registry.find_or_create(
                sig, self._plan(p), busy, lambda: self._new_visitor(tid, sig, p, now), now=now,
                visible_only=from_out or tid in self._from_outside,
                camera_id=cam_id, when=when,  # overlapping cameras: hand off to the visitor another camera sees
            )
            self._attach(tid, v, now, "new visitor" if created else "recognised, seen by another camera")
            self.registry.seen(v, cam_id, now, self._plan(p), p.height, p.conf)
            self._camera_in(v, conf, tid, when)

    def _make_passers(self, frame: np.ndarray, by_tid: dict[int, Person], now: float) -> None:
        """People steadily on the Traffic walkway who are not linked to a
        visitor yet. First recognised (the same person on another camera, a
        passer-by seen before, or a visitor who just walked out of the shop);
        nobody matches: a new visit / track_id with a Passed By event
        (track_region Traffic). If they then walk into a Purchasing / Counter
        area, the same track_id gets its In event."""
        cam_id = self.camera["camera_id"]
        for tid, (when, conf) in list(self._passing.items()):
            v = self._link.get(tid)
            if v is not None and not v.left:
                del self._passing[tid]  # recognised meanwhile: _act records what is needed
                continue
            st = self._regions.get(tid)
            if st is None or st.kind != TRAFFIC:
                del self._passing[tid]  # no longer on the walkway (walked in: In from _act)
                continue
            p = by_tid.get(tid)
            if p is None or not p.full or now - when < NEW_VISITOR_HOLD_SECONDS:
                continue  # hidden / not full body / still waiting (another camera may know them)
            del self._passing[tid]
            if tid not in self._look and self._recog is not None:
                self._add_look(tid, self._recog.look(frame, p.box, p.height, heavy=True))
            sig = self._look.get(tid)
            busy = {self._link[t].visit_id for t in by_tid if t in self._link and not self._link[t].left}
            v, created = self.registry.find_or_create_outside(
                sig, self._plan(p), busy, lambda: self._new_passer(tid, sig, p, now), camera_id=cam_id, now=now)
            self._attach(tid, v, now, "new passer-by" if created else "recognised on the walkway")
            self.registry.seen(v, cam_id, now, self._plan(p), p.height, p.conf)
            self.registry.where(v, cam_id, False, now)
            if created:
                self._event(v, "Passed By", conf or p.conf, tid, TRAFFIC, when,
                            area=st.region.name if st.region is not None else None, count=False)

    def _new_passer(self, tid: int, sig: Look | None, p: Person, now: float) -> Visitor:
        """A new person first seen on the Traffic walkway: one visit row (track_id),
        outside the shop until they walk into a Purchasing / Counter area."""
        v = self._new_visitor(tid, sig, p, now)
        v.outside = True
        v.traffic_at[self.camera["camera_id"]] = now
        return v

    def _recognise_leaving(self, tid: int, p: Person | None, frame: np.ndarray | None, conf: float,
                           now: float) -> Visitor | None:
        """A person this camera saw in a shop area walked out (Traffic / Out of
        Range), but this tracker number is not linked to a visitor yet (the
        person went In on ANOTHER camera, or this camera gave them a new
        number, or their visit was still being decided). Find the visitor they
        are, so the Passed By / Out is recorded for the EXISTING track_id,
        never a new one.
        Nobody matches: a person who stayed inside at least
        NEW_VISITOR_HOLD_SECONDS gets their visit now (In, then the caller
        records Passed By / Out); someone who only stepped in and out gets
        nothing."""
        pending = self._pending.pop(tid, None)  # walked out: never make a visit for them later
        if p is None:
            return None
        cam_id = self.camera["camera_id"]
        if tid not in self._look and self._recog is not None and frame is not None:
            self._add_look(tid, self._recog.look(frame, p.box, p.height, heavy=True))
        sig = self._look.get(tid)
        # visitors followed as OTHER people in this picture right now cannot be this person
        busy = {lv.visit_id for t, lv in self._link.items()
                if t != tid and not lv.left and self._seen_at.get(t) == now}
        v = self.registry.recognise(sig, self._plan(p), busy, cam_id, now,
                                    when=pending[0] if pending else None) or \
            self.registry.reclaim(sig, self._plan(p), busy, now, camera_id=cam_id)
        if v is not None or pending is None:
            return v
        when, in_conf, from_out = pending
        if now - when < NEW_VISITOR_HOLD_SECONDS:
            return None  # only stepped in and straight out
        v, created = self.registry.find_or_create(
            sig, self._plan(p), busy, lambda: self._new_visitor(tid, sig, p, now), now=now,
            visible_only=from_out or tid in self._from_outside, camera_id=cam_id, when=when)
        if not created and v.outside:
            return v  # went Out already on another camera: _went_out records nothing more
        self.registry.seen(v, cam_id, now, self._plan(p), p.height, p.conf)
        self._camera_in(v, in_conf or conf, tid, when)
        return v

    def _new_visitor(self, tid: int, sig: Look | None, p: Person, now: float) -> Visitor:
        """First camera to see this person go In: one visit row, with this
        camera's track_id (never used for anyone else). Member stays empty."""
        cam = self.camera
        v = Visitor(visit_id=str(uuid.uuid4()), track_id=self._new_track_id(tid), first_camera=cam["camera_id"])
        v.add_look(sig, cam["camera_id"])
        v.floor, v.floor_at, v.height = self._plan(p), now, p.height
        v.seen_on[cam["camera_id"]] = now
        v.last_conf = p.conf
        row = {"visit_id": v.visit_id, "branch_id": cam["branch_id"], "track_id": v.track_id}
        est = self._estimates.pop(tid, None)
        if est is not None and est.samples:
            v.estimate = est
            row.update(est.visit_fields())
            v.sent_faces = est.samples
        self.insert("visit", row, cam["camera_id"])
        return v

    def _camera_in(self, v: Visitor, conf: float, tid: int, when: float) -> None:
        """In event: the visitor walked into the shop (a Purchasing / Counter
        area), or into the other kind of area inside the shop. Once per
        change, whichever camera sees it first. A visitor who went Out / Passed
        By and walks back in within OUTSIDE_KEEP_SECONDS (5 min) keeps the same
        visit / track_id."""
        cam_id = self.camera["camera_id"]
        st = self._regions.get(tid)
        r = st.region if st is not None else None
        kind = st.kind if st is not None and st.kind in INSIDE_KINDS else "Purchasing"
        was_out, first = v.outside, v.region_kind is None
        self.registry.where(v, cam_id, True, when)
        changed, came_back = self.registry.enter(v, kind, r.name if r is not None else None, cam_id, when)
        if came_back:
            log.info("person %s (%s) came back into the shop", tid, v.track_id)
        self.registry.first_in(v, cam_id, when)  # time this camera saw them go In (overlap handoff)
        if changed:
            self._event(v, "In", conf, tid, kind, when, area=r.name if r is not None else None,
                        count=first or was_out)

    def _went_out(self, v: Visitor, conf: float, tid: int, when: float, direction: str = "Passed By",
                  region: str = TRAFFIC, area: str | None = None) -> None:
        """Left the shop: "Passed By" on the Traffic walkway (the stay in the
        shop ends), or "Out" to Out of Range."""
        if not self.registry.leave(v, when):
            return  # already outside (recorded before): nothing more until they come back in
        self._send_estimate(v, final=True)
        # The person is still followed outside (nothing more is recorded) and keeps their
        # track_id while a camera sees them, and OUTSIDE_KEEP_SECONDS (5 min) after the last
        # camera saw them; walking back in within that time = same visit, same track_id
        self._event(v, direction, conf, tid, region, when, area=area)

    # ---------- Shop areas (3D regions) → In / Passed By / Out ----------
    def _walk_regions(self, frame: np.ndarray, people: list[Person], now: float) -> None:
        """Where each full-body person stands steadily (REGION_STEADY_FRAMES
        frames and REGION_MIN_SECONDS): a Purchasing / Counter area (inside
        the shop), the Traffic walkway, or Out of Range (no area there; on an
        inside-only camera that is Purchasing). Then:
          inside              → In (new visitor, came back, or the other kind of area)
          inside → Traffic    → Passed By, track_region Traffic (the stay ends)
          inside → Out of Range → Out, track_region Out of Range
        Only people whose feet are confirmed on the floor (p.full), or worked
        out from the head when hidden behind a table / another shopper
        (p.est_feet); otherwise they keep the spot they were in."""
        if self.space is None or not self.space.counting:
            return
        for p in people:
            if not p.full and not p.est_feet:
                continue  # partly hidden, feet unknown: keep the area they were in
            r = self.space.region_at(p.foot, None, p.height)  # flat: the feet point in the outline drawn on the picture
            kind = self.space.kind_at(r)
            if kind == TRAFFIC:
                self._from_outside.add(p.tid)  # on the walkway: walked in from outside
            key = r.id if r is not None else ""
            st = self._regions.setdefault(p.tid, _RegionState())
            if key == st.current:
                st.candidate, st.streak = None, 0
            else:
                if key != st.candidate:
                    st.candidate, st.streak, st.since = key, 0, now
                st.streak += 1
                if st.streak >= REGION_STEADY_FRAMES and now - st.since >= REGION_MIN_SECONDS:
                    st.current, st.region, st.kind, st.candidate, st.streak = key, r, kind, None, 0
            if st.current is not None:
                self._act(frame, p, st, now)

    def _act(self, frame: np.ndarray, p: Person, st: _RegionState, now: float) -> None:
        """Events for one person steadily in a spot (see _walk_regions)."""
        cam_id, tid = self.camera["camera_id"], p.tid
        v = self._link.get(tid)
        if v is not None and v.left:
            v = None
        inside = True if st.kind in INSIDE_KINDS else (False if st.kind == TRAFFIC else None)
        if inside:
            if v is None:  # new person? recognised or made a visit in _make_visitors
                self._pending.setdefault(tid, (now, p.conf, tid in self._from_outside))
            else:
                self._camera_in(v, p.conf, tid, now)
            return
        # Outside the shop: the Traffic walkway, or Out of Range
        out_of_range = inside is None
        linked = v is not None
        if v is None:
            if tid not in self._pending:
                if not out_of_range:  # on the walkway, not known yet: Passed By (_make_passers)
                    self._passing.setdefault(tid, (st.since or now, p.conf))
                return
            v = self._recognise_leaving(tid, p, frame, p.conf, now)  # the EXISTING track_id
            if v is None:
                return
        self.registry.where(v, cam_id, None if out_of_range else False, now)
        if self.registry.may_leave(v, cam_id, out_of_range, now):
            self._went_out(v, p.conf, tid, now, "Out" if out_of_range else "Passed By",
                           OUT_OF_RANGE if out_of_range else TRAFFIC,
                           area=st.region.name if st.region is not None else None)
        if not linked:
            self._attach(tid, v, now, "recognised while walking out")
            self.registry.seen(v, cam_id, now, self._plan(p), p.height, p.conf)

    def _event(self, v: Visitor, direction: str, conf: float, tid: int, region: str, when: float | None = None,
               area: str | None = None, count: bool = True) -> None:
        """direction: "In" (track_region Purchasing / Counter), "Passed By"
        (Traffic) or "Out" (Out of Range). (area = the area's name, for the
        log only.)"""
        self.insert(
            "cctv_event",
            {
                "camera_id": self.camera["camera_id"],
                "visit_id": v.visit_id,
                "direction": direction,
                "track_region": region,  # "Purchasing" | "Counter" | "Traffic" | "Out of Range"
                "confidence": round(conf * 100, 2),
                "event_time": datetime.fromtimestamp(when or time.time(), timezone.utc).isoformat(),
            },
        )
        key = "In" if direction == "In" else "Out"
        if count:  # came into the shop / left it (not moving between areas inside)
            self.counts[key] += 1
        log.info("person %s (%s) %s → %s%s  (inside now %d)", tid, v.track_id, direction,
                 region, f" ({area})" if area else "", self.registry.count())

    # ---------- Photo of each track_id (Camera page: Suspicious same person) ----------
    def _take_photos(self, frame: np.ndarray, people: list[Person], now: float) -> None:
        """Keep the clearest moment of each visitor (bigger, sharper, face seen,
        whole body) and send it to the PhotoUploader, so an admin can compare two
        track_ids by eye before merging them. The photo is the WHOLE camera picture
        (landscape, as the camera sees it) with this person's box and track_id
        drawn on it, so where they stand and who is around them is visible too.
        A visitor's photo is replaced only by a clearly better one, at most every
        PHOTO_EVERY_SECONDS."""
        h, w = frame.shape[:2]
        for p in people:
            v = self._link.get(p.tid)
            if v is None or v.left:
                continue
            x1, y1, x2, y2 = p.box
            bh = y2 - y1
            if bh < PHOTO_MIN_PIXELS:
                continue  # too small to recognise anyone
            look = self._look.get(p.tid)
            q = bh * p.conf * (1.0 if p.full else 0.6) * (1.6 if look is not None and look.face is not None else 1.0)
            with self.registry._lock:
                if v.photo_q and (now - v.photo_at < PHOTO_EVERY_SECONDS or q < v.photo_q * PHOTO_BETTER):
                    continue
            mx, my = (x2 - x1) * 0.08, bh * 0.04
            cx1, cy1 = max(0, int(x1 - mx)), max(0, int(y1 - my))
            cx2, cy2 = min(w, int(x2 + mx)), min(h, int(y2 + my))
            crop = frame[cy1:cy2, cx1:cx2]
            if crop.size == 0:
                continue
            # blurred (moving fast): count it less
            sharp = cv2.Laplacian(cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY), cv2.CV_64F).var()
            q *= 0.5 + 0.5 * min(1.0, sharp / 120.0)
            with self.registry._lock:
                if v.photo_q and q < v.photo_q * PHOTO_BETTER:
                    continue
                v.photo_q, v.photo_at = q, now
            ok, jpeg = cv2.imencode(".jpg", self._labelled_picture(frame, p.box, v.track_id),
                                    [cv2.IMWRITE_JPEG_QUALITY, 80])
            if ok:
                self.offer_photo(v.visit_id, jpeg.tobytes())

    def _labelled_picture(self, frame: np.ndarray, box: tuple[float, float, float, float],
                          track_id: str) -> np.ndarray:
        """The whole camera picture, scaled to PHOTO_MAX_WIDTH (landscape kept), with
        the person's box and a "track_id · camera · time" label, like the live video."""
        h, w = frame.shape[:2]
        scale = min(1.0, PHOTO_MAX_WIDTH / w)
        img = cv2.resize(frame, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA) \
            if scale < 1.0 else frame.copy()
        x1, y1, x2, y2 = (int(round(c * scale)) for c in box)
        ih, iw = img.shape[:2]
        thick = max(2, iw // 320)
        cv2.rectangle(img, (x1, y1), (x2, y2), PHOTO_BOX, thick)
        text = f"{track_id}  {self.camera['camera_name']}  {datetime.now().strftime('%H:%M:%S')}"
        font, fs = cv2.FONT_HERSHEY_SIMPLEX, max(0.45, iw / 1400)
        (tw, th), base = cv2.getTextSize(text, font, fs, 1)
        pad = 4
        lx = min(max(0, x1), max(0, iw - tw - 2 * pad))
        ly = y1 - th - base - 2 * pad if y1 - th - base - 2 * pad >= 0 else min(y2, ih - th - base - 2 * pad)
        cv2.rectangle(img, (lx, ly), (lx + tw + 2 * pad, ly + th + base + 2 * pad), PHOTO_BOX, -1)
        cv2.putText(img, text, (lx + pad, ly + pad + th), font, fs, (0, 0, 0), 1, cv2.LINE_AA)
        return img

    # ---------- Gender / age (whole body) ----------
    def _look_at_people(self, demo: Demographics, frame: np.ndarray, people: list[Person], now: float) -> None:
        def estimate_of(p: Person) -> Estimate:
            v = self._link.get(p.tid)
            return v.estimate if v is not None and not v.left else self._estimates.setdefault(p.tid, Estimate())

        # Full-body people who still need looks, those with the fewest first
        due = [
            p for p in people
            if p.full and estimate_of(p).samples < FACE_SAMPLES
            and now - self._last_look.get(p.tid, 0.0) >= FACE_EVERY_SECONDS
        ]
        due.sort(key=lambda p: estimate_of(p).samples)
        for p in due[:FACES_PER_FRAME]:
            self._last_look[p.tid] = now
            found = demo.from_whole_person(frame, p.box)
            v = self._link.get(p.tid)
            est = estimate_of(p)
            with self.registry._lock:
                for gender_probs, age_probs, weight in found:
                    est.add(gender_probs, age_probs, weight)
                height = v.height if v is not None and v.height is not None else p.height
                if height is not None:
                    est.height = height
            if v is not None and found:
                self._send_estimate(v)

    def _send_estimate(self, v: Visitor, final: bool = False) -> None:
        """Write the visitor's newest gender / age to their visit row: first
        guess, every 2 more looks, the last look, and when they are gone."""
        if not self.update:
            return
        with self.registry._lock:
            n = v.estimate.samples
            if n <= v.sent_faces or not (final or v.sent_faces == 0 or n - v.sent_faces >= 2 or n >= FACE_SAMPLES):
                return
            v.sent_faces = n
            values = v.estimate.visit_fields()
        self.update("visit", values, camera_id=self.camera["camera_id"], visit_id=f"eq.{v.visit_id}")

    def _draw(self, img: np.ndarray, people: list[Person]) -> np.ndarray:
        h, w = img.shape[:2]
        if self.space is not None:
            colors = {"Counter": (60, 30, 225), "Purchasing": (235, 100, 40), TRAFFIC: (20, 150, 250)}  # BGR
            for r in self.space.regions:  # shop areas: outline on the floor
                if len(r.image) >= 3:
                    poly = np.array([(int(x * w), int(y * h)) for x, y in r.image], np.int32)
                    color = colors.get(r.kind, (255, 160, 0))
                    cv2.polylines(img, [poly], True, color, 2)
                    cv2.putText(img, r.name, tuple(poly[0]), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 1)
        for p in people:
            x, y = int(p.foot[0] * w), int(p.foot[1] * h)
            v = self._link.get(p.tid)
            color = (0, 200, 0) if v is not None else ((255, 80, 0) if p.full else (160, 160, 160))
            cv2.circle(img, (x, y), 5, color, -1)
            est = v.estimate if v is not None else self._estimates.get(p.tid)
            name = v.track_id.rsplit("-", 1)[-1] if v is not None else str(p.tid)
            text = f"{name} {est.label()}" if est and est.samples else name  # e.g. "7 F 29"
            if p.floor:
                text += f" ({p.floor[0]:.1f},{p.floor[1]:.1f},{p.height or 0:.1f}m)"
            cv2.putText(img, text, (x + 6, y), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 1)
        cv2.putText(img, f"In {self.counts['In']}  Out {self.counts['Out']}", (10, 25),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)
        return img
