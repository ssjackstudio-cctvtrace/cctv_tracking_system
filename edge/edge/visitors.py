"""One visitor = one person inside the shop = one visit row = one track_id,
shared by ALL cameras of this edge box (all 4 cameras send their video over
the same Wi-Fi router to this one box, so the box sees every camera at once).

Rules
  - The FIRST camera that sees a new person go In creates the visit row, and
    its track_id (e.g. ABT-01-3f9a2c-7) is the person's track_id for the whole
    visit.
  - Every other camera that sees the same person (at the same time, because
    the views overlap, or later, in another part of the shop) is LINKED to
    that visitor: it may record its own cctv_event rows (In once per camera,
    areas entered), but always with the same visit_id / track_id. It never
    makes a second visit for a person already inside.
  - A link is never dropped while the person is inside, even when the
    camera's tracker loses them for a moment and gives them a new number:
    the new number is linked back to the same visitor.
  - Only Out (on any camera) ends the visit. If the person comes back later,
    that is a new visit.

Is this the same person? The registry compares, for every visitor inside:
  1. Floor position (cameras calibrated in "Areas (3D)"): all cameras use the
     same shop floor coordinates in metres, so one person seen by two cameras
     at once is at the same floor spot. A visitor seen somewhere else on the
     floor right now cannot be this person.
  2. Look of the clothes (colour of the upper and lower body), for cameras
     without calibration and for people walking from one camera's view into
     another camera's view.
  3. A visitor already followed on this camera as a different person, in the
     same picture, is never a match (two people side by side).
Two cameras that see a new person at the same moment ask the registry one at
a time (find_or_create), so only one visit row can be made.

Only numbers are kept in memory; no picture is saved or sent.
REID_MAX_DISTANCE and SAME_PLACE_METRES in .env make matching stricter or looser.
"""

from __future__ import annotations

import math
import os
import threading
import time
from dataclasses import dataclass, field
from typing import Callable

import cv2
import numpy as np

from .demographics import Estimate

MAX_DISTANCE = float(os.getenv("REID_MAX_DISTANCE", "0.45"))  # 0 = identical look, 1 = nothing alike
FORGET_MINUTES = float(os.getenv("VISITOR_FORGET_MINUTES", "60"))  # not seen by any camera this long → forgotten
SAME_PLACE_METRES = float(os.getenv("SAME_PLACE_METRES", "0.9"))  # two cameras' floor spots this close = same person
POSITION_FRESH_SECONDS = 1.5  # a visitor's floor spot is "now" for this long after it was seen
H_BINS, S_BINS = 16, 8


def appearance(frame: np.ndarray, box: tuple[float, float, float, float]) -> np.ndarray | None:
    """Clothes colour signature of one person box: hue/saturation histograms of
    the upper body and the lower body (head and feet left out)."""
    h, w = frame.shape[:2]
    x1, y1, x2, y2 = (int(v) for v in box)
    x1, x2 = max(0, x1), min(w, x2)
    y1, y2 = max(0, y1), min(h, y2)
    bh, bw = y2 - y1, x2 - x1
    if bh < 40 or bw < 16:
        return None  # too small to judge
    # trim the sides (background) a little
    x1, x2 = x1 + bw // 8, x2 - bw // 8
    parts = []
    for top, bottom in ((0.18, 0.55), (0.55, 0.92)):  # upper body, lower body
        crop = frame[y1 + int(bh * top): y1 + int(bh * bottom), x1:x2]
        if crop.size == 0:
            return None
        hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
        # ignore very dark / very bright pixels (shadows, light): their hue means nothing
        mask = cv2.inRange(hsv, (0, 0, 30), (180, 255, 245))
        hist = cv2.calcHist([hsv], [0, 1], mask, [H_BINS, S_BINS], [0, 180, 0, 256]).flatten()
        total = hist.sum()
        if total <= 0:
            return None
        parts.append(hist / total)
    return np.concatenate(parts).astype(np.float32)


def distance(a: np.ndarray, b: np.ndarray) -> float:
    """0 = same look, 1 = nothing alike (Bhattacharyya, average of upper / lower body)."""
    n = H_BINS * S_BINS
    d = [cv2.compareHist(a[i:i + n], b[i:i + n], cv2.HISTCMP_BHATTACHARYYA) for i in (0, n)]
    return float(sum(d) / 2)


@dataclass(eq=False)
class Visitor:
    visit_id: str
    track_id: str  # given by the first camera that saw the person go In; never changes
    first_camera: str = ""
    signature: np.ndarray | None = None
    samples: int = 0
    cameras_in: set[str] = field(default_factory=set)  # cameras that already recorded In for this visit
    seen_on: dict[str, float] = field(default_factory=dict)  # camera_id → last time seen there
    last_seen: float = field(default_factory=time.time)
    floor: tuple[float, float] | None = None  # newest floor spot (metres), from any calibrated camera
    floor_at: float = 0.0
    height: float | None = None  # body height (metres), running average
    region: str | None = None  # id of the area the person is in now ("" = none)
    region_name: str | None = None
    region_kind: str | None = None
    region_camera: str | None = None  # camera that set the area
    estimate: Estimate = field(default_factory=Estimate)  # gender / age from all cameras
    sent_faces: int = 0  # samples already written to the visit row
    left: bool = False  # counted Out: visit ended

    def add_look(self, sig: np.ndarray | None) -> None:
        """Keep a running average of how the visitor looks (several frames, several cameras)."""
        if sig is None:
            return
        if self.signature is None:
            self.signature, self.samples = sig.copy(), 1
        else:
            k = min(self.samples, 9)
            self.signature = (self.signature * k + sig) / (k + 1)
            self.samples += 1


class VisitorRegistry:
    """Visitors inside the shop right now, shared by all camera threads."""

    def __init__(self, max_distance: float = MAX_DISTANCE, forget_minutes: float = FORGET_MINUTES,
                 same_place: float = SAME_PLACE_METRES):
        self.max_distance = max_distance
        self.forget_seconds = forget_minutes * 60
        self.same_place = same_place
        self._inside: dict[str, Visitor] = {}  # visit_id → visitor
        self._lock = threading.RLock()

    # ---------- who is this person? ----------
    def _score(self, v: Visitor, sig: np.ndarray | None, floor: tuple[float, float] | None,
               now: float) -> float | None:
        """Lower = more alike. None = cannot be this visitor."""
        if v.left:
            return None
        app = distance(sig, v.signature) if sig is not None and v.signature is not None else None
        fresh = floor is not None and v.floor is not None and now - v.floor_at <= POSITION_FRESH_SECONDS
        if fresh:
            d = math.dist(floor, v.floor)  # type: ignore[arg-type]
            if d > self.same_place:
                return None  # that visitor is somewhere else on the floor right now
            if app is not None and app > min(0.95, self.max_distance * 1.6):
                return None  # same spot but clearly different clothes
            # same floor spot: strong evidence (ranks before look-only matches)
            return d / self.same_place * 0.6 + (app / self.max_distance if app is not None else 0.5) * 0.4
        if app is None or app >= self.max_distance:
            return None
        return 1.0 + app / self.max_distance

    def _match_locked(self, sig, floor, exclude: set[str], now: float) -> Visitor | None:
        best, best_s = None, None
        for v in self._inside.values():
            if v.visit_id in exclude:
                continue
            s = self._score(v, sig, floor, now)
            if s is not None and (best_s is None or s < best_s):
                best, best_s = v, s
        return best

    def match(self, sig: np.ndarray | None, floor: tuple[float, float] | None = None,
              exclude: set[str] | None = None, now: float | None = None) -> Visitor | None:
        """The visitor inside who is most likely this person, or None.
        exclude = visit_ids already followed as other people in this camera's picture."""
        if sig is None and floor is None:
            return None
        with self._lock:
            return self._match_locked(sig, floor, exclude or set(), time.time() if now is None else now)

    def find_or_create(self, sig, floor, exclude: set[str], create: Callable[[], Visitor],
                       now: float | None = None) -> tuple[Visitor, bool]:
        """Same as match, and if nobody matches, create the visitor — in one step,
        so two cameras seeing the same new person at once make only ONE visit."""
        now = time.time() if now is None else now
        with self._lock:
            v = self._match_locked(sig, floor, exclude, now) if (sig is not None or floor is not None) else None
            if v is not None:
                return v, False
            v = create()
            self._inside[v.visit_id] = v
            return v, True

    # ---------- updates ----------
    def seen(self, visitor: Visitor, camera_id: str, now: float | None = None,
             floor: tuple[float, float] | None = None, height: float | None = None) -> None:
        now = time.time() if now is None else now
        with self._lock:
            visitor.seen_on[camera_id] = now
            visitor.last_seen = now
            if floor is not None:
                visitor.floor, visitor.floor_at = floor, now
            if height is not None:
                visitor.height = height if visitor.height is None else visitor.height * 0.8 + height * 0.2

    def first_in(self, visitor: Visitor, camera_id: str) -> bool:
        """True once per camera per visit: this camera records its In event now."""
        with self._lock:
            if visitor.left or camera_id in visitor.cameras_in:
                return False
            visitor.cameras_in.add(camera_id)
            return True

    def set_region(self, visitor: Visitor, region, camera_id: str) -> bool:
        """The person is steadily in this area (or in none). True when the area
        changed, i.e. a cctv_event should be recorded (once, whichever camera saw it)."""
        with self._lock:
            if visitor.left:
                return False
            new = region.id if region is not None else None
            if new == visitor.region:
                return False
            if new is None:
                # only the camera that saw the person walk in can say they walked out of it
                # (another camera may simply not cover that area)
                if visitor.region_camera not in (None, camera_id):
                    return False
                visitor.region = visitor.region_name = visitor.region_kind = visitor.region_camera = None
                return False
            visitor.region, visitor.region_name, visitor.region_kind = new, region.name, region.kind
            visitor.region_camera = camera_id
            return True

    def leave(self, visitor: Visitor) -> bool:
        """Counted Out: the visit ends. False if it had already ended (Out seen by another camera)."""
        with self._lock:
            if visitor.left:
                return False
            visitor.left = True
            self._inside.pop(visitor.visit_id, None)
            return True

    def forget_old(self, now: float | None = None) -> None:
        """Visitors no camera has seen for a long time (left unseen): stop matching them."""
        now = time.time() if now is None else now
        with self._lock:
            for vid in [k for k, v in self._inside.items() if now - v.last_seen > self.forget_seconds]:
                self._inside.pop(vid).left = True

    def count(self) -> int:
        with self._lock:
            return len(self._inside)
