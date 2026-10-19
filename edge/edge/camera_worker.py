"""One thread per camera: read RTSP → detect + track people (full body only)
→ place each person in 3D on the shop floor → link them to ONE visitor shared
by all cameras → count In / Out and the shop areas they walk into → queue
visit / cctv_event rows for Supabase.
Also keeps each person's latest box (and 3D position) for the website's live video."""

from __future__ import annotations

import logging
import os
import socket
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
from .line_counter import CountLine, LineCounter
from .space3d import Region, ShopPlan, Space
from .reid import Look, Recognizer, comparable, compare
from .visitors import KEEP_SECONDS, MAX_DISTANCE, Visitor, VisitorRegistry

log = logging.getLogger("camera")

PERSON = 0  # COCO class id for "person"

# camera.active_status: "Active" only while live, open pictures arrive
NO_FRAME_SECONDS = 20  # no new picture for this long → stream lost → Inactive
DARK_SECONDS = 5  # picture almost all black for this long → camera closed → Inactive
DARK_MEAN, DARK_STD = 12, 6  # "almost all black": low brightness and almost no detail (0–255 scale)

# Gender / age: look at each full-body person a few times (all cameras together)
FACE_SAMPLES = int(os.getenv("DEMOGRAPHIC_SAMPLES", "8"))  # looks (face + whole body) averaged per visitor
FACE_EVERY_SECONDS = 0.5  # gap between two looks at the same person
FACES_PER_FRAME = 1  # people looked at per frame (~0.15 s each on the CPU; keeps counting smooth)
TRACK_DONE_SECONDS = 10  # person not seen for this long → final gender / age sent

# Camera power: while the camera is off (no answer on its RTSP port) the box
# only knocks every few seconds; tracking starts by itself once it powers on.
POWER_CHECK_SECONDS = 5

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
# floor, and the floor spot would be wrongly far away (e.g. "Outside Shop").
# So the body height measured from the box must look like a whole person:
# at least FOOT_MIN_HEIGHT, and not much shorter than this person's height
# measured before (on this or another camera). Otherwise the feet are hidden.
FOOT_MIN_HEIGHT = float(os.getenv("FOOT_MIN_HEIGHT", "1.2"))  # metres
FOOT_HEIGHT_SHARE = float(os.getenv("FOOT_HEIGHT_SHARE", "0.85"))  # of the person's known height
# Feet hidden but height known (seen before with feet): the floor spot under
# the HEAD is used for the shop area (e.g. standing behind the Counter), not for In / Out
FLOOR_FROM_HEAD = os.getenv("FLOOR_FROM_HEAD", "on").lower() not in ("off", "0", "false", "no")
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
# A new person's visit is only made after this long, so a camera whose view
# overlaps another camera's has time to see that it is someone already inside
NEW_VISITOR_HOLD_SECONDS = float(os.getenv("NEW_VISITOR_HOLD_SECONDS", "1.0"))

# Shop areas (camera.floor_areas → regions): the feet must stay in an area this
# long before the visitor counts as being there (one cctv_event per area entered)
REGION_STEADY_FRAMES = 3
REGION_MIN_SECONDS = float(os.getenv("REGION_MIN_SECONDS", "1.0"))


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

    def latest(self) -> tuple[int, np.ndarray | None]:
        with self._lock:
            return self._frame_no, self._frame

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


@dataclass
class Person:
    """One person in the current picture."""

    tid: int  # tracker number on this camera
    box: tuple[float, float, float, float]  # pixels x1, y1, x2, y2
    conf: float
    full: bool  # whole body (head to feet) visible
    foot: tuple[float, float]  # where the feet touch the floor (0-1)
    head: tuple[float, float]  # top of the head (0-1)
    feet: list[tuple[float, float]]  # points for the count line (empty unless full body)
    floor: tuple[float, float] | None = None  # floor spot in metres (calibrated camera)
    height: float | None = None  # body height in metres
    from_head: bool = False  # floor spot from the head + known height (feet hidden): areas only, not In / Out


@dataclass
class _RegionState:
    current: str | None = None  # region id the person is steadily in on this camera ("" = none)
    region: Region | None = None
    candidate: str | None = None
    streak: int = 0
    since: float = 0.0


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
    ):
        super().__init__(name=f"cam-{camera['camera_name']}", daemon=True)
        self.camera = camera
        self.grabber = FrameGrabber(camera["camera_name"], source)
        self.model_path, self.confidence, self.image_size, self.anchor = model_path, confidence, image_size, anchor
        self.insert, self.offer_snapshot, self.snapshot_seconds = insert, offer_snapshot, snapshot_seconds
        self.show = show
        self.update = update  # update(table, values, **filters), for a visit's gender / age
        self._estimates: dict[int, Estimate] = {}  # tracker id → gender / age seen BEFORE it is linked to a visitor
        self._last_look: dict[int, float] = {}  # tracker id → last time its face / body was checked
        self.counter = LineCounter(CountLine.from_json(camera.get("count_line")))
        # 3D floor + shop areas; the automatic floor (camera 3.25 m high) until the Camera page saves one
        self.space = Space.from_json(camera.get("floor_areas")) or Space.automatic()
        # The whole shop on one floor plan (3D shop floor map → branch.floor_plan): areas and In / Out
        self.shop = ShopPlan.from_json(camera.get("shop_plan"))
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
        self._from_outside: set[int] = set()  # tracker ids seen in the Out area (walked in from outside)
        self._tried_at: dict[int, float] = {}  # tracker id → last time it was compared with the visitors
        # tracker id → (time it went In, confidence, walked in from outside), no visitor yet
        self._pending: dict[int, tuple[float, float, bool]] = {}
        self._regions: dict[int, _RegionState] = {}
        self._session = uuid.uuid4().hex[:6]  # tracker ids restart at 1 after a restart
        self._used_track_ids: set[str] = set()  # track_ids given to visits: never given again
        self.counts = {"In": 0, "Out": 0}
        # Newest people for the live video:
        # [{"track", "b": [x1, y1, x2, y2] (0-1), "area", "visit", "full", "xyz", "region", "kind", "g", "a", "s"}]
        self.live_boxes: list[dict[str, Any]] = []
        self.live_frame_no = 0

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
            # Feet really on the floor? A box cut by a table is short for this person
            if p.height is None or p.height < FOOT_MIN_HEIGHT or (known is not None and p.height < known * FOOT_HEIGHT_SHARE):
                p.full, p.floor, p.height = False, None, None
            else:
                hs = self._heights.setdefault(tid, [])
                hs.append(p.height)
                del hs[:-HEIGHT_SAMPLES]
        if p.full:
            inset = bw * FOOT_INSET
            p.feet = [((x1 + inset) / w, foot_y / h), ((x2 - inset) / w, foot_y / h)]
        elif FLOOR_FROM_HEAD and calibrated and known is not None and y1 > h * TOP_EDGE:
            # feet hidden, head seen, height known: stand the person under their head
            p.floor, p.height, p.from_head = self.space.floor_from_head(head, known), known, True
            if p.floor is None:
                p.from_head = False
        return p

    def _known_height(self, tid: int) -> float | None:
        """This person's body height (metres), measured earlier with their feet
        seen: on this camera (median), or by any camera (their visitor)."""
        hs = self._heights.get(tid)
        if hs and len(hs) >= 3:
            return float(np.median(hs))
        v = self._link.get(tid)
        return v.height if v is not None and not v.left else None

    def _shop_on(self) -> bool:
        """The shop plan decides areas and In / Out: this camera is placed on it."""
        return self.shop is not None and self.space is not None and self.space.shared

    # Called by main when the dashboard changes the camera (e.g. a new count line or areas)
    def update_camera(self, camera: dict[str, Any]) -> None:
        if camera.get("floor_areas") != self.camera.get("floor_areas"):
            self.space = Space.from_json(camera.get("floor_areas")) or Space.automatic()
            self._regions.clear()
        if camera.get("shop_plan") != self.camera.get("shop_plan"):
            self.shop = ShopPlan.from_json(camera.get("shop_plan"))
            self._regions.clear()
        self.camera = camera
        self.counter.set_line(CountLine.from_json(camera.get("count_line")))
        for tid, v in self._link.items():  # a new line forgets who was In: keep linked people able to go Out
            if not v.left:
                self.counter.mark_in(tid)

    def stop(self) -> None:
        self.stop_event.set()
        self.grabber.stop_event.set()

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
        tracker = TRACKER if os.path.isfile(TRACKER) else "bytetrack.yaml"
        self.grabber.start()
        log.info("started (model %s, tracker %s)", self.model_path, os.path.basename(tracker))
        if self._shop_on():
            log.info("placed on the shop floor map: In / Out and areas come from where the feet stand on the shop plan")
        elif self.counter.line is None:
            log.warning("no count line / In area yet — draw it on the Camera page; counting is paused")
        if not self.space.shared:
            log.info("camera not placed on the shop plan yet (Camera page → Shop areas (3D)): people are "
                     "matched across cameras by their face, clothes and body only")

        last_no, last_snapshot, last_dark_check = 0, 0.0, 0.0
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
            by_tid = {p.tid: p for p in people}

            self._identify(frame, people, now)

            # In / Out: from the shop plan (feet confirmed, not from the head), or from the count line
            areas = {p.tid: (("in" if self.shop.inside(p.floor) else "out") if p.floor and not p.from_head else None)
                     for p in people} if self._shop_on() else None
            for crossing in self.counter.update({p.tid: p.feet for p in people}, now=now, areas=areas):
                p = by_tid.get(crossing.track_id)
                self._record(crossing.track_id, crossing.direction, p.conf if p else 0.0, now, crossing.from_out)
            self._make_visitors(frame, by_tid, now)
            self._walk_regions(people, now)

            if demo.enabled:
                self._look_at_people(demo, frame, people, now)

            # For the website's live video: where each person is in this frame, and who they are
            self.live_boxes = [self._live_box(p, w, h) for p in people]
            self.live_frame_no = frame_no

            if self.offer_snapshot and now - last_snapshot >= self.snapshot_seconds:
                ok, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 70])
                if ok:
                    self.offer_snapshot(self.camera["camera_id"], jpeg.tobytes())
                last_snapshot = now

            if self.show:
                self.preview = self._draw(frame.copy(), people)

        self.grabber.stop_event.set()

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
            "area": self.counter.area_of(p.tid),
            "visit": v is not None,  # linked to a visitor (has a visit row / track_id)
            "full": p.full,
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
            if self.counter.area_of(tid) == "out":
                self._from_outside.add(tid)

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
                                        inside_only=tid not in self._from_outside)
                how = "recognised, seen by another camera" if v is not None and v.seen_on.keys() - {cam_id} \
                    else "recognised, seen a moment ago"
            elif v is None:
                # standing outside: can only be a visitor who just went Out (keeps their track_id label)
                v = self.registry.match(self._look.get(tid), self._plan(p), exclude=busy, now=now, outside_only=True)
                how = "recognised, outside the shop"
            if v is not None:
                self._attach(tid, v, now, how)
                busy.add(v.visit_id)
                self.registry.seen(v, cam_id, now, self._plan(p), p.height, p.conf)

        # Forget tracker numbers gone for a long time (the visitor ends KEEP_SECONDS after no camera sees them)
        for tid in [t for t, seen in self._seen_at.items() if now - seen > FORGET_TRACK_SECONDS]:
            v = self._link.get(tid)
            if v is not None:
                self._send_estimate(v, final=True)
            self._from_outside.discard(tid)
            for d in (self._seen_at, self._spot, self._link, self._look, self._look_n, self._look_at,
                      self._tried_at, self._pending, self._regions, self._estimates, self._last_look,
                      self._mismatch):
                d.pop(tid, None)

    def _check_look(self, tid: int, look: Look | None, now: float) -> None:
        """Add a new look of this tracker number. If it is linked to a visitor
        but now clearly looks like ANOTHER person (other face / clothes / body)
        a few times in a row, the tracker mixed two people up: the link is
        dropped, so the other person never gets this visitor's track_id."""
        if look is None or look.empty:
            return
        v = self._link.get(tid)
        if v is not None and comparable(look, v.look) and compare(look, v.look) is None:
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
                v.add_look(look)

    def _unlinked_inside(self, tid: int, now: float) -> None:
        """A person in this camera's In area lost their visitor (track_id ended,
        or tracker mix-up): recognise them again, or make a new visit for them,
        like someone who just went In."""
        if (self.counter.line is not None or self._shop_on()) and self.counter.area_of(tid) == "in":
            self._pending.setdefault(tid, (now, 0.0, False))

    def _plan(self, p: Person) -> tuple[float, float] | None:
        """Floor spot on the SHOP plan (shared by all cameras), or None when this
        camera is not placed on the plan: then its floor is its own and cannot be
        compared with the other cameras' floor spots."""
        return p.floor if self.space is not None and self.space.shared else None

    def _may_be_inside(self, p: Person) -> bool:
        """Only people inside the shop are compared with the visitors inside, so
        a passer-by outside who dresses alike never takes a visitor's track_id."""
        if self._shop_on():
            if self.counter.area_of(p.tid) == "out":
                return False  # feet seen outside the shop
        elif self.counter.line is not None and not self.counter.line.all_in:
            if self.counter.area_of(p.tid) != "in":
                return False
        st = self._regions.get(p.tid)
        if st is not None and st.region is not None and st.region.kind == "Outside Shop":
            return False
        return True

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
            if comparable(sig, v.look):
                same = compare(sig, v.look)
                if same is None or same > MAX_DISTANCE:
                    continue  # another person
            elif lost_for > RELINK_BLIND_SECONDS or d >= RELINK_PICTURE_DISTANCE / 2:
                continue  # nothing to recognise them by yet: too far / too late to be sure
            best, best_d = (old, v), d
        if best is None:
            return None
        del self._link[best[0]]
        return best[1]

    def _attach(self, tid: int, v: Visitor, now: float, how: str) -> None:
        self._link[tid] = v
        self._mismatch.pop(tid, None)
        if not v.outside:
            self.counter.mark_in(tid, now)  # inside: walking out through this camera's Out area is Out
        look = self._look.get(tid)
        if look is not None:
            with self.registry._lock:
                v.add_look(look)
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

    # ---------- In / Out ----------
    def _record(self, tid: int, direction: str, conf: float, when: float, from_out: bool = False) -> None:
        v = self._link.get(tid)
        if v is not None and v.left:
            v = None
        if direction == "Out":
            if v is not None:
                self._went_out(v, conf, tid, when)
            return  # never In as a known visitor: Out is not recorded
        if v is not None:
            if v.outside and not from_out:
                return  # went Out on another camera and is still at the door: not back in
            self._camera_in(v, conf, tid, when)  # already known (linked): this camera's own In event
        else:
            self._pending.setdefault(tid, (when, conf, from_out))  # new person? decided in _make_visitors

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
                v = self.registry.match(sig, self._plan(p), exclude=busy, now=now, inside_only=True) or \
                    self.registry.reclaim(sig, self._plan(p), busy, now)
                if v is not None:
                    self._attach(tid, v, now, "recognised, back after being hidden")
                    self.registry.seen(v, cam_id, now, self._plan(p), p.height, p.conf)
                    self._camera_in(v, conf, tid, when)
                    continue
            v, created = self.registry.find_or_create(
                sig, self._plan(p), busy, lambda: self._new_visitor(tid, sig, p, now), now=now,
                visible_only=from_out or tid in self._from_outside,
            )
            self._attach(tid, v, now, "new visitor" if created else "recognised, seen by another camera")
            self.registry.seen(v, cam_id, now, self._plan(p), p.height, p.conf)
            self._camera_in(v, conf, tid, when)

    def _new_visitor(self, tid: int, sig: Look | None, p: Person, now: float) -> Visitor:
        """First camera to see this person go In: one visit row, with this
        camera's track_id (never used for anyone else). Member stays empty."""
        cam = self.camera
        v = Visitor(visit_id=str(uuid.uuid4()), track_id=self._new_track_id(tid), first_camera=cam["camera_id"])
        v.add_look(sig)
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
        """In event of this camera for this visit (once per camera per visit).
        A visitor who went Out and walks back in within KEEP_SECONDS keeps the
        same visit / track_id."""
        if v.outside and self.registry.come_back(v):
            log.info("person %s (%s) came back into the shop", tid, v.track_id)
        if not self.registry.first_in(v, self.camera["camera_id"]):
            return
        st = self._regions.get(tid)
        r = st.region if st is not None else None
        inside_area = r is not None and r.kind in ("Counter", "Purchasing")
        self._event(v, "In", conf, tid, r.kind if inside_area else "Purchasing", when,
                    area=r.name if inside_area else None)

    def _went_out(self, v: Visitor, conf: float, tid: int, when: float, area: str | None = None) -> None:
        if not self.registry.leave(v, when):
            return  # already outside (Out recorded before): no second Out until they come back in
        self._send_estimate(v, final=True)
        # The person keeps their track_id label while a camera sees them outside, and
        # KEEP_SECONDS after the last camera saw them; then the track_id ends for good
        self._event(v, "Out", conf, tid, "Outside Shop", when, area=area)

    # ---------- Shop areas (3D regions) ----------
    def _walk_regions(self, people: list[Person], now: float) -> None:
        """Which area (Counter, Point of Purchase display, ...) each full-body
        person stands in. A visitor walking into an area gets ONE cctv_event
        (whichever camera sees it first): direction "In", track_region = the
        area's kind. Walking into an "Outside Shop" area counts as Out
        (track_region "Outside Shop").
        Camera placed on the shop floor map: the area comes from the SHOP plan
        (same areas for all cameras), only where the feet are confirmed on the
        floor (or under the head of a person whose height is known). Feet
        hidden: the person keeps the area they were in (no guessing)."""
        shop = self._shop_on()
        if not shop and (self.space is None or not self.space.regions):
            return
        cam_id = self.camera["camera_id"]
        for p in people:
            if shop:
                if p.floor is None:
                    continue  # feet hidden, height not known yet: keep the area they were in
                r = self.shop.region_at(p.floor)
                if p.from_head and r.kind == "Outside Shop":
                    continue  # Out only when the feet are seen outside
            else:
                if not p.full:
                    continue  # partly hidden: keep the area they were in
                r = self.space.region_at(p.foot, p.floor, p.height)
            key = r.id if r is not None else ""
            st = self._regions.setdefault(p.tid, _RegionState())
            if key == st.current:
                st.candidate, st.streak = None, 0
                continue
            if key != st.candidate:
                st.candidate, st.streak, st.since = key, 0, now
            st.streak += 1
            if st.streak < REGION_STEADY_FRAMES or now - st.since < REGION_MIN_SECONDS:
                continue
            st.current, st.region, st.candidate, st.streak = key, r, None, 0
            v = self._link.get(p.tid)
            if v is None or v.left:
                continue  # not a visitor (yet): shown on the live video only
            if r is not None and r.kind == "Outside Shop":
                self._went_out(v, p.conf, p.tid, now, area=r.name)
                continue
            if self.registry.set_region(v, r, cam_id) and r is not None:
                self._event(v, "In", p.conf, p.tid, r.kind, now, area=r.name, count=False)

    def _event(self, v: Visitor, direction: str, conf: float, tid: int, region: str, when: float | None = None,
               area: str | None = None, count: bool = True) -> None:
        """direction is only "In" or "Out"; track_region says where the person was:
        In → "Purchasing" or "Counter", Out → "Outside Shop". (area = the area's
        name, for the log only.)"""
        self.insert(
            "cctv_event",
            {
                "camera_id": self.camera["camera_id"],
                "visit_id": v.visit_id,
                "direction": direction,
                "track_region": region,  # "Outside Shop" | "Purchasing" | "Counter"
                "confidence": round(conf * 100, 2),
                "event_time": datetime.fromtimestamp(when or time.time(), timezone.utc).isoformat(),
            },
        )
        if count and direction in self.counts:  # entrance In / Out only (not areas walked into)
            self.counts[direction] += 1
        log.info("person %s (%s) %s → %s%s  (inside now %d)", tid, v.track_id, direction,
                 region, f" ({area})" if area else "", self.registry.count())

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
        line = self.counter.line
        if line:
            zone = np.array([(int(x * w), int(y * h)) for x, y in line.in_zone], np.int32)
            tint = img.copy()
            cv2.fillPoly(tint, [zone], (0, 160, 0))  # In area: green tint
            img = cv2.addWeighted(tint, 0.18, img, 0.82, 0)
            pts = np.array([(int(x * w), int(y * h)) for x, y in line.points], np.int32)
            if len(pts) >= 2:
                cv2.polylines(img, [pts], False, (0, 220, 255), 2)
            cx, cy = zone.mean(axis=0).astype(int)
            cv2.putText(img, "IN", (int(cx), int(cy)), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 200, 0), 2)
        if self.space is not None:
            for r in self.space.regions:  # shop areas: outline on the floor
                if len(r.image) >= 3:
                    poly = np.array([(int(x * w), int(y * h)) for x, y in r.image], np.int32)
                    cv2.polylines(img, [poly], True, (255, 160, 0), 2)
                    cv2.putText(img, r.name, tuple(poly[0]), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 160, 0), 1)
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
