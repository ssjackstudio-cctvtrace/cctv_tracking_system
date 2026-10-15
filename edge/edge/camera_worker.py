"""One thread per camera: read RTSP → detect + track people → count people
walking into the In area → queue visit / cctv_event rows for Supabase.
Also keeps each person's latest box for the website's live video."""

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

import cv2
import numpy as np

from .demographics import Demographics, Estimate
from .line_counter import CountLine, LineCounter
from .visitors import Visitor, VisitorRegistry, appearance

log = logging.getLogger("camera")

PERSON = 0  # COCO class id for "person"

# camera.active_status: "Active" only while live, open pictures arrive
NO_FRAME_SECONDS = 20  # no new picture for this long → stream lost → Inactive
DARK_SECONDS = 5  # picture almost all black for this long → camera closed → Inactive
DARK_MEAN, DARK_STD = 12, 6  # "almost all black": low brightness and almost no detail (0–255 scale)

# Gender / age: look at each person's face a few times while they are tracked
FACE_SAMPLES = 5  # faces averaged per person
FACE_EVERY_SECONDS = 0.5  # gap between two looks at the same person
FACES_PER_FRAME = 1  # faces checked per frame (~0.15 s each on the CPU; keeps counting smooth)
TRACK_DONE_SECONDS = 10  # person not seen for this long → final gender / age sent

# Camera power: while the camera is off (no answer on its RTSP port) the box
# only knocks every few seconds; tracking starts by itself once it powers on.
POWER_CHECK_SECONDS = 5

# Full body: only people whose feet are visible take part in In / Out.
# A box cut off by the bottom of the picture, or much wider than a standing
# person (e.g. only the head and shoulders), is followed but not counted yet.
FULL_BODY_RATIO = float(os.getenv("FULL_BODY_RATIO", "1.2"))  # box height / width
BOTTOM_EDGE = 0.985  # box bottom below this share of the picture = feet cut off
FOOT_INSET = 0.25  # feet = bottom corners of the box, moved in by this share of its width

# Look of each person's clothes (to keep one track_id for one person on all cameras)
LOOK_SAMPLES = 5  # looks averaged per tracked person
LOOK_EVERY_SECONDS = 0.5
FORGET_TRACK_SECONDS = 30  # tracker id not seen this long → forget it on this camera


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
        self._estimates: dict[int, Estimate] = {}  # tracker id → averaged gender / age
        self._last_look: dict[int, float] = {}  # tracker id → last time its face was checked
        self._last_seen: dict[int, float] = {}  # tracker id → last frame it was in
        self.counter = LineCounter(CountLine.from_json(camera.get("count_line")))
        self.stop_event = threading.Event()
        self.last_frame_at = 0.0  # used for camera.last_seen_at
        self.dark_since: float | None = None  # when the picture went black (camera closed)
        self.reported_status: str | None = None  # active_status last sent to Supabase
        self.preview: np.ndarray | None = None  # for --show
        # Visitors inside the shop, shared by all cameras of this box (one track_id per person)
        self.registry = registry or VisitorRegistry()
        self._visitor: dict[int, Visitor] = {}  # tracker id → visitor it is
        self._look: dict[int, np.ndarray] = {}  # tracker id → averaged clothes look
        self._look_n: dict[int, int] = {}
        self._look_at: dict[int, float] = {}
        self._seen_at: dict[int, float] = {}  # tracker id → last time in the picture
        self._last_forget = 0.0
        self._session = uuid.uuid4().hex[:6]  # tracker ids restart at 1 after a restart
        self.counts = {"In": 0, "Out": 0}
        # Newest people boxes for the live video: [{"track", "b": [x1, y1, x2, y2] (0-1), "area"}]
        self.live_boxes: list[dict[str, Any]] = []
        self.live_frame_no = 0

    def track_name(self, tid: int) -> str:
        """Same text as visit.track_id, e.g. ABT-01-3f9a2c-7."""
        return f"{self.camera['camera_name']}-{self._session}-{tid}"

    def _feet(self, box: tuple[float, float, float, float], w: int, h: int) -> list[tuple[float, float]]:
        """Points that must all be inside an area for it to count: both feet
        (bottom corners of the box). Empty while the full body is not visible."""
        x1, y1, x2, y2 = box
        bw, bh = max(x2 - x1, 1.0), y2 - y1
        if self.anchor == "center":  # camera looking straight down: no feet to see
            return [(((x1 + x2) / 2) / w, ((y1 + y2) / 2) / h)]
        if y2 >= h * BOTTOM_EDGE or bh / bw < FULL_BODY_RATIO:
            return []
        inset = bw * FOOT_INSET
        return [((x1 + inset) / w, y2 / h), ((x2 - inset) / w, y2 / h)]

    # Called by main when the dashboard changes the camera (e.g. a new count line)
    def update_camera(self, camera: dict[str, Any]) -> None:
        self.camera = camera
        self.counter.set_line(CountLine.from_json(camera.get("count_line")))

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
        self.grabber.start()
        log.info("started (model %s)", self.model_path)
        if self.counter.line is None:
            log.warning("no count line / In area yet — draw it on the Camera page; counting is paused")

        last_no, last_snapshot, last_dark_check = 0, 0.0, 0.0
        paused = False  # True while the camera picture is closed (black)
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
                tracker="bytetrack.yaml",
                verbose=False,
            )[0]

            points: dict[int, tuple[float, float]] = {}
            feet: dict[int, list[tuple[float, float]]] = {}
            conf_by_id: dict[int, float] = {}
            box_by_id: dict[int, tuple[float, float, float, float]] = {}
            boxes = result.boxes
            if boxes is not None and boxes.id is not None:
                for (x1, y1, x2, y2), tid, conf in zip(
                    boxes.xyxy.tolist(), boxes.id.int().tolist(), boxes.conf.tolist()
                ):
                    y = y2 if self.anchor == "bottom" else (y1 + y2) / 2
                    points[tid] = (((x1 + x2) / 2) / w, y / h)
                    feet[tid] = self._feet((x1, y1, x2, y2), w, h)
                    conf_by_id[tid] = conf
                    box_by_id[tid] = (x1, y1, x2, y2)

            self._follow(frame, box_by_id, now)

            if demo.enabled:
                self._look_at_faces(demo, frame, box_by_id, now)

            for crossing in self.counter.update(feet, now=now):
                self._record(crossing.track_id, crossing.direction, conf_by_id.get(crossing.track_id, 0.0),
                             frame, box_by_id.get(crossing.track_id))

            # For the website's live video: where each person is in this frame
            self.live_boxes = [
                {
                    "track": self._visitor[tid].track_id if tid in self._visitor else self.track_name(tid),
                    "b": [round(x1 / w, 4), round(y1 / h, 4), round(x2 / w, 4), round(y2 / h, 4)],
                    "area": self.counter.area_of(tid),
                }
                for tid, (x1, y1, x2, y2) in box_by_id.items()
            ]
            self.live_frame_no = frame_no

            if self.offer_snapshot and now - last_snapshot >= self.snapshot_seconds:
                ok, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 70])
                if ok:
                    self.offer_snapshot(self.camera["camera_id"], jpeg.tobytes())
                last_snapshot = now

            if self.show:
                self.preview = self._draw(frame.copy(), points)

        self.grabber.stop_event.set()

    # ---------- Who is who (one track_id per person on all cameras) ----------
    def _follow(self, frame: np.ndarray, box_by_id: dict[int, tuple[float, float, float, float]], now: float) -> None:
        """Every frame: note who is seen, learn how they look, drop old trackers."""
        cam_id = self.camera["camera_id"]
        for tid, box in box_by_id.items():
            self._seen_at[tid] = now
            v = self._visitor.get(tid)
            if v is not None and v.left:  # counted Out on another camera (or forgotten)
                del self._visitor[tid]
                v = None
            if v is not None:
                self.registry.seen(v, cam_id, now)
            if self._look_n.get(tid, 0) < LOOK_SAMPLES and now - self._look_at.get(tid, 0.0) >= LOOK_EVERY_SECONDS:
                self._look_at[tid] = now
                self._add_look(tid, appearance(frame, box))
                if v is not None:
                    v.add_look(self._look.get(tid))

        for tid in [t for t, seen in self._seen_at.items() if now - seen > FORGET_TRACK_SECONDS]:
            for d in (self._seen_at, self._visitor, self._look, self._look_n, self._look_at):
                d.pop(tid, None)
        if now - self._last_forget > 10:
            self._last_forget = now
            self.registry.forget_old()

    def _add_look(self, tid: int, sig: np.ndarray | None) -> None:
        if sig is None:
            return
        n = self._look_n.get(tid, 0)
        self._look[tid] = sig if n == 0 else (self._look[tid] * n + sig) / (n + 1)
        self._look_n[tid] = n + 1

    def _record(self, tid: int, direction: str, conf: float, frame: np.ndarray | None = None,
                box: tuple[float, float, float, float] | None = None) -> None:
        cam = self.camera
        cam_id = cam["camera_id"]
        v = self._visitor.get(tid)
        if v is not None and v.left:
            v = None

        if direction == "Out":
            if v is None:
                return  # never In as a known visitor: Out is not recorded
            self._event(v, "Out", conf, tid)
            self.registry.leave(v)  # visit ends; coming back later is a new visit
            self._visitor.pop(tid, None)
            return

        # In: someone already inside (seen by this or another camera) keeps their track_id
        if tid not in self._look and frame is not None and box is not None:
            self._add_look(tid, appearance(frame, box))
        if v is None:
            v = self.registry.match(self._look.get(tid), cam_id)
            if v is not None:
                log.info("person %s is %s (same person, seen before)", tid, v.track_id)
        if v is None:
            # New visitor: one visit row, with the gender / age estimated so far
            # (updated later as more faces are seen). Member stays empty.
            v = Visitor(visit_id=str(uuid.uuid4()), track_id=self.track_name(tid))
            row = {"visit_id": v.visit_id, "branch_id": cam["branch_id"], "track_id": v.track_id}
            est = self._estimates.get(tid)
            if est and est.samples:
                row.update(est.visit_fields())
                v.sent_faces = est.samples
            self.insert("visit", row, cam_id)
            self.registry.add(v)
        v.add_look(self._look.get(tid))
        self._visitor[tid] = v
        self.registry.seen(v, cam_id)
        if cam_id not in v.cameras_in:  # one In per camera per visit
            v.cameras_in.add(cam_id)
            self._event(v, "In", conf, tid)

    def _event(self, v: Visitor, direction: str, conf: float, tid: int) -> None:
        self.insert(
            "cctv_event",
            {
                "camera_id": self.camera["camera_id"],
                "visit_id": v.visit_id,
                "direction": direction,
                "confidence": round(conf * 100, 2),
                "event_time": datetime.now(timezone.utc).isoformat(),
            },
        )
        self.counts[direction] += 1
        log.info("person %s (%s) %s  (since start: In %d / Out %d, inside now %d)", tid, v.track_id, direction,
                 self.counts["In"], self.counts["Out"], self.registry.count())

    # ---------- Gender / age ----------
    def _look_at_faces(self, demo: Demographics, frame: np.ndarray,
                       box_by_id: dict[int, tuple[float, float, float, float]], now: float) -> None:
        for tid in box_by_id:
            self._last_seen[tid] = now
        # People who still need faces, those with the fewest first
        due = [
            tid for tid in box_by_id
            if self._estimates.get(tid, Estimate()).samples < FACE_SAMPLES
            and now - self._last_look.get(tid, 0.0) >= FACE_EVERY_SECONDS
        ]
        due.sort(key=lambda t: self._estimates.get(t, Estimate()).samples)
        for tid in due[:FACES_PER_FRAME]:
            self._last_look[tid] = now
            found = demo.from_person(frame, box_by_id[tid])
            if found is None:
                continue  # no clear face this time (turned away, too small, blurred)
            est = self._estimates.setdefault(tid, Estimate())
            est.add(*found)
            if est.samples in (1, 3, FACE_SAMPLES):  # first guess, better guess, final
                self._send_estimate(tid)

        # People gone for a while: send their final estimate and forget them
        for tid in [t for t, seen in self._last_seen.items() if now - seen > TRACK_DONE_SECONDS]:
            self._send_estimate(tid)
            for d in (self._estimates, self._last_look, self._last_seen):
                d.pop(tid, None)

    def _send_estimate(self, tid: int) -> None:
        """Write the person's newest gender / age to their visit row, if they
        already have one (a visit is made when they cross the count line)."""
        est, v = self._estimates.get(tid), self._visitor.get(tid)
        if not est or v is None or not self.update or est.samples <= v.sent_faces:
            return
        self.update("visit", est.visit_fields(), camera_id=self.camera["camera_id"], visit_id=f"eq.{v.visit_id}")
        v.sent_faces = est.samples

    def _draw(self, img: np.ndarray, points: dict[int, tuple[float, float]]) -> np.ndarray:
        h, w = img.shape[:2]
        line = self.counter.line
        if line:
            zone = np.array([(int(x * w), int(y * h)) for x, y in line.in_zone], np.int32)
            tint = img.copy()
            cv2.fillPoly(tint, [zone], (0, 160, 0))  # In area: green tint
            img = cv2.addWeighted(tint, 0.18, img, 0.82, 0)
            pts = np.array([(int(x * w), int(y * h)) for x, y in line.points], np.int32)
            cv2.polylines(img, [pts], False, (0, 220, 255), 2)
            cx, cy = zone.mean(axis=0).astype(int)
            cv2.putText(img, "IN", (int(cx), int(cy)), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 200, 0), 2)
        for tid, (x, y) in points.items():
            cv2.circle(img, (int(x * w), int(y * h)), 5, (255, 80, 0), -1)
            est = self._estimates.get(tid)
            text = f"{tid} {est.label()}" if est else str(tid)  # e.g. "7 F 29"
            cv2.putText(img, text, (int(x * w) + 6, int(y * h)), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 80, 0), 1)
        cv2.putText(img, f"In {self.counts['In']}  Out {self.counts['Out']}", (10, 25),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)
        return img
