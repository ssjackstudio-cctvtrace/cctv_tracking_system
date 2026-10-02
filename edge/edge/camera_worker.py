"""One thread per camera: read RTSP → detect + track people → count line
crossings → queue visit / cctv_event rows for Supabase."""

from __future__ import annotations

import logging
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Callable

import cv2
import numpy as np

from .line_counter import CountLine, LineCounter

log = logging.getLogger("camera")

PERSON = 0  # COCO class id for "person"


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

    def latest(self) -> tuple[int, np.ndarray | None]:
        with self._lock:
            return self._frame_no, self._frame

    def run(self) -> None:
        is_file = isinstance(self.source, str) and not self.source.lower().startswith("rtsp")
        while not self.stop_event.is_set():
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
        insert: Callable[[str, dict[str, Any]], None],
        offer_snapshot: Callable[[str, bytes], None] | None,
        snapshot_seconds: float,
        show: bool = False,
    ):
        super().__init__(name=f"cam-{camera['camera_name']}", daemon=True)
        self.camera = camera
        self.grabber = FrameGrabber(camera["camera_name"], source)
        self.model_path, self.confidence, self.image_size, self.anchor = model_path, confidence, image_size, anchor
        self.insert, self.offer_snapshot, self.snapshot_seconds = insert, offer_snapshot, snapshot_seconds
        self.show = show
        self.counter = LineCounter(CountLine.from_json(camera.get("count_line")))
        self.stop_event = threading.Event()
        self.last_frame_at = 0.0  # used for camera.last_seen_at
        self.preview: np.ndarray | None = None  # for --show
        self._visits: dict[int, str] = {}  # tracker id → visit_id
        self._session = uuid.uuid4().hex[:6]  # tracker ids restart at 1 after a restart
        self.counts = {"In": 0, "Out": 0}

    # Called by main when the dashboard changes the camera (e.g. a new count line)
    def update_camera(self, camera: dict[str, Any]) -> None:
        self.camera = camera
        self.counter.set_line(CountLine.from_json(camera.get("count_line")))

    def stop(self) -> None:
        self.stop_event.set()
        self.grabber.stop_event.set()

    def run(self) -> None:
        from ultralytics import YOLO  # imported here so --help works without it

        model = YOLO(self.model_path)
        self.grabber.start()
        log.info("started (model %s)", self.model_path)
        if self.counter.line is None:
            log.warning("no count line yet — draw it on the Camera page; counting is paused")

        last_no, last_snapshot = 0, 0.0
        while not self.stop_event.is_set():
            frame_no, frame = self.grabber.latest()
            if frame is None or frame_no == last_no:
                time.sleep(0.01)
                continue
            last_no = frame_no
            now = time.time()
            self.last_frame_at = now
            h, w = frame.shape[:2]

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
            conf_by_id: dict[int, float] = {}
            boxes = result.boxes
            if boxes is not None and boxes.id is not None:
                for (x1, y1, x2, y2), tid, conf in zip(
                    boxes.xyxy.tolist(), boxes.id.int().tolist(), boxes.conf.tolist()
                ):
                    y = y2 if self.anchor == "bottom" else (y1 + y2) / 2
                    points[tid] = (((x1 + x2) / 2) / w, y / h)
                    conf_by_id[tid] = conf

            for crossing in self.counter.update(points, now=now):
                self._record(crossing.track_id, crossing.direction, conf_by_id.get(crossing.track_id, 0.0))

            if self.offer_snapshot and now - last_snapshot >= self.snapshot_seconds:
                ok, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 70])
                if ok:
                    self.offer_snapshot(self.camera["camera_id"], jpeg.tobytes())
                last_snapshot = now

            if self.show:
                self.preview = self._draw(frame.copy(), points)

        self.grabber.stop_event.set()

    def _record(self, tid: int, direction: str, conf: float) -> None:
        cam = self.camera
        visit_id = self._visits.get(tid)
        if visit_id is None:
            # One visit per tracked person. Gender / age / member stay at their
            # defaults ("Unknown") until phase 2 adds those models.
            visit_id = str(uuid.uuid4())
            self._visits[tid] = visit_id
            self.insert(
                "visit",
                {
                    "visit_id": visit_id,
                    "branch_id": cam["branch_id"],
                    "track_id": f"{cam['camera_name']}-{self._session}-{tid}",
                },
            )
        self.insert(
            "cctv_event",
            {
                "camera_id": cam["camera_id"],
                "visit_id": visit_id,
                "direction": direction,
                "confidence": round(conf * 100, 2),
                "event_time": datetime.now(timezone.utc).isoformat(),
            },
        )
        self.counts[direction] += 1
        log.info("person %s %s  (since start: In %d / Out %d)", tid, direction, self.counts["In"], self.counts["Out"])
        if len(self._visits) > 5000:  # keep memory small on long runs
            for k in list(self._visits)[:2500]:
                del self._visits[k]

    def _draw(self, img: np.ndarray, points: dict[int, tuple[float, float]]) -> np.ndarray:
        h, w = img.shape[:2]
        line = self.counter.line
        if line:
            s = (int(line.start[0] * w), int(line.start[1] * h))
            e = (int(line.end[0] * w), int(line.end[1] * h))
            cv2.line(img, s, e, (0, 220, 255), 2)
            mid = ((s[0] + e[0]) // 2, (s[1] + e[1]) // 2)
            dx, dy = e[0] - s[0], e[1] - s[1]
            n = max((dx * dx + dy * dy) ** 0.5, 1)
            tip = (int(mid[0] + dy / n * 40), int(mid[1] - dx / n * 40))  # points to the "In" side
            cv2.arrowedLine(img, mid, tip, (0, 200, 0), 2, tipLength=0.3)
            cv2.putText(img, "IN", tip, cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 200, 0), 2)
        for tid, (x, y) in points.items():
            cv2.circle(img, (int(x * w), int(y * h)), 5, (255, 80, 0), -1)
            cv2.putText(img, str(tid), (int(x * w) + 6, int(y * h)), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 80, 0), 1)
        cv2.putText(img, f"In {self.counts['In']}  Out {self.counts['Out']}", (10, 25),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)
        return img
