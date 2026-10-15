"""One visitor = one person inside the shop = one visit row = one track_id,
shared by ALL cameras of this edge box.

When a camera sees a person go In, it asks the registry: "is this someone
already inside?" The registry compares the look of the person's clothes
(colour histograms of the upper and lower body) with every visitor inside.
  - Same look  → same visitor: the camera reuses that visit_id / track_id.
  - No match   → new visitor: new visit row, new track_id.
So a person who walks from camera 1 into camera 2's view keeps the track_id
they got on camera 1, and each camera may still record its own In / Out event
for them. Out (on any camera) ends the visit: the visitor leaves the registry,
and if they come back later they are a new visit.

Only colour numbers are kept in memory; no picture is saved or sent.
Matching by clothes colour is not perfect (two people in the same black
shirt can be mixed up; different camera colours can split one person), so
REID_MAX_DISTANCE in .env lets you make it stricter or looser.
"""

from __future__ import annotations

import os
import threading
import time
from dataclasses import dataclass, field

import cv2
import numpy as np

MAX_DISTANCE = float(os.getenv("REID_MAX_DISTANCE", "0.45"))  # 0 = identical look, 1 = nothing alike
FORGET_MINUTES = float(os.getenv("VISITOR_FORGET_MINUTES", "60"))  # not seen by any camera this long → forgotten
LIVE_SECONDS = 3.0  # a visitor seen on a camera this recently is "busy" there (cannot be a second person)
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
    track_id: str
    signature: np.ndarray | None = None
    samples: int = 0
    cameras_in: set[str] = field(default_factory=set)  # cameras that already recorded In for this visit
    seen_on: dict[str, float] = field(default_factory=dict)  # camera_id → last time seen there
    last_seen: float = field(default_factory=time.time)
    sent_faces: int = 0  # face samples already written to the visit row
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

    def __init__(self, max_distance: float = MAX_DISTANCE, forget_minutes: float = FORGET_MINUTES):
        self.max_distance = max_distance
        self.forget_seconds = forget_minutes * 60
        self._inside: dict[str, Visitor] = {}  # visit_id → visitor
        self._lock = threading.Lock()

    def match(self, sig: np.ndarray | None, camera_id: str, now: float | None = None) -> Visitor | None:
        """The visitor inside who looks most like sig and is not already being
        followed as someone else on this camera, or None."""
        if sig is None:
            return None
        now = time.time() if now is None else now
        best, best_d = None, self.max_distance
        with self._lock:
            for v in self._inside.values():
                if v.left or v.signature is None:
                    continue
                if now - v.seen_on.get(camera_id, -1e9) < LIVE_SECONDS:
                    continue  # this camera is following that visitor right now → a different person
                d = distance(sig, v.signature)
                if d < best_d:
                    best, best_d = v, d
        return best

    def add(self, visitor: Visitor) -> None:
        with self._lock:
            self._inside[visitor.visit_id] = visitor

    def seen(self, visitor: Visitor, camera_id: str, now: float | None = None) -> None:
        now = time.time() if now is None else now
        visitor.seen_on[camera_id] = now
        visitor.last_seen = now

    def leave(self, visitor: Visitor) -> None:
        """Counted Out: the visit ends."""
        visitor.left = True
        with self._lock:
            self._inside.pop(visitor.visit_id, None)

    def forget_old(self, now: float | None = None) -> None:
        """Visitors no camera has seen for a long time (left unseen): stop matching them."""
        now = time.time() if now is None else now
        with self._lock:
            for vid in [k for k, v in self._inside.items() if now - v.last_seen > self.forget_seconds]:
                self._inside.pop(vid).left = True

    def count(self) -> int:
        with self._lock:
            return len(self._inside)
