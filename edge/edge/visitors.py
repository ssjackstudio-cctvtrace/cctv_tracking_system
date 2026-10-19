"""One visitor = one person = one visit row = one track_id, shared by ALL
cameras of this edge box (all 4 cameras send their video over the same Wi-Fi
router to this one box, so the box sees every camera at once).

Rules
  - Before a person gets a NEW track_id, they are first recognised (face,
    attire, whole body, floor spot; see reid.py) against the people the box
    remembers. Only someone nobody matches gets a new visit / track_id.
  - The FIRST camera that sees a new person go In creates the visit row, and
    its track_id (e.g. ABT-01-3f9a2c-7) is the person's track_id for the whole
    visit.
  - Every other camera that sees the same person (at the same time, because
    the views overlap, or later, in another part of the shop) is LINKED to
    that visitor: it may record its own cctv_event rows (In once per camera,
    areas entered), but always with the same visit_id / track_id.
  - A person is remembered while ANY camera sees them, and for KEEP_SECONDS
    (TRACK_KEEP_SECONDS in .env, default 300 = 5 minutes) after the last camera saw them.
    Then the track_id is ended for good: it is never given to anyone again.
    If the person was still inside (no Out seen), the visit is closed with an
    Out event at the moment they were last seen (main.py), so every visit has
    an In and an Out and the dashboard's "People Still Inside" goes back to 0.
  - Out (on any camera, crossing the count line) is recorded once. After Out
    the person is still followed outside the shop, but nothing more is
    recorded, and their track_id is kept for OUTSIDE_KEEP_SECONDS
    (default 300 = 5 minutes) after the last camera saw them. If they walk
    back in through the entrance in that time, it is the same visit and the
    same track_id (a new In event). After that the track_id ends for good.

Is this the same person? The registry compares, for every remembered visitor:
  1. Floor position (cameras placed on the shop plan in "3D shop floor map"):
     all cameras use the same shop floor coordinates in metres, so one person
     seen by two cameras at once (overlapping views) is at the same floor
     spot. A visitor seen somewhere else on the floor right now cannot be
     this person.
  2. Face, attire, whole body and height (reid.compare). A clear difference
     in any of them = another person.
  3. A visitor already followed on this camera as a different person, in the
     same picture, is never a match (two people side by side).
Two cameras that see a new person at the same moment ask the registry one at
a time (find_or_create), so only one visit row can be made.

Only numbers are kept in memory; no picture is saved or sent.
"""

from __future__ import annotations

import math
import os
import threading
import time
from dataclasses import dataclass, field
from typing import Callable

from .demographics import Estimate
from .reid import MAX_DISTANCE, Look, appearance, attire_distance, comparable, compare

# Older names, kept for other modules
distance = attire_distance
__all__ = ["MAX_DISTANCE", "KEEP_SECONDS", "OUTSIDE_KEEP_SECONDS", "Visitor", "VisitorRegistry", "appearance", "distance"]

# Not seen by any camera for this long → the track_id ends (person gone)
KEEP_SECONDS = float(os.getenv("TRACK_KEEP_SECONDS", "300"))  # 5 minutes
# After Out: the track_id is kept this long after the last camera saw the person (outside the shop)
OUTSIDE_KEEP_SECONDS = float(os.getenv("OUTSIDE_KEEP_SECONDS", "300"))
HIDDEN_SECONDS = min(3.0, KEEP_SECONDS)  # a visitor no camera has seen for this long is "hidden" (may come back)
LOOSE_DISTANCE = min(0.9, MAX_DISTANCE * 1.5)  # look match for a hidden visitor coming back (within KEEP_SECONDS)
HIDDEN_MOVE_METRES = 4.0  # how far a hidden person may have walked in KEEP_SECONDS (cameras on the shop plan)
SAME_PLACE_METRES = float(os.getenv("SAME_PLACE_METRES", "0.9"))  # two cameras' floor spots this close = same person
POSITION_FRESH_SECONDS = 1.5  # a visitor's floor spot is "now" for this long after it was seen


@dataclass(eq=False)
class Visitor:
    visit_id: str
    track_id: str  # given by the first camera that saw the person go In; never changes, never reused
    first_camera: str = ""
    look: Look = field(default_factory=Look)  # face + attire + whole body, from all cameras
    cameras_in: set[str] = field(default_factory=set)  # cameras that already recorded In for this visit
    seen_on: dict[str, float] = field(default_factory=dict)  # camera_id → last time seen there
    last_seen: float = field(default_factory=time.time)
    last_conf: float = 0.0  # detection confidence when last seen (for the closing Out event)
    floor: tuple[float, float] | None = None  # newest floor spot (metres), from any calibrated camera
    floor_at: float = 0.0
    height: float | None = None  # body height (metres), running average
    region: str | None = None  # id of the area the person is in now ("" = none)
    region_name: str | None = None
    region_kind: str | None = None
    region_camera: str | None = None  # camera that set the area
    estimate: Estimate = field(default_factory=Estimate)  # gender / age from all cameras
    sent_faces: int = 0  # samples already written to the visit row
    outside: bool = False  # counted Out (still remembered while seen, and OUTSIDE_KEEP_SECONDS after)
    left: bool = False  # ended: the track_id is finished for good

    def add_look(self, look: Look | None) -> None:
        """Keep a running average of how the visitor looks (several frames, several cameras)."""
        self.look.add(look)

    @property
    def last_any(self) -> float:
        """Last time any camera saw this person."""
        return max([self.last_seen, *self.seen_on.values()])


class VisitorRegistry:
    """People the box remembers right now, shared by all camera threads."""

    def __init__(self, max_distance: float = MAX_DISTANCE, keep_seconds: float = KEEP_SECONDS,
                 same_place: float = SAME_PLACE_METRES, outside_keep_seconds: float = OUTSIDE_KEEP_SECONDS):
        self.max_distance = max_distance
        self.keep_seconds = keep_seconds
        self.outside_keep_seconds = outside_keep_seconds
        self.same_place = same_place
        self._inside: dict[str, Visitor] = {}  # visit_id → visitor (inside, or just went Out)
        self._lock = threading.RLock()
        self._day = time.localtime().tm_yday  # the list starts again every day

    # ---------- who is this person? ----------
    def _score(self, v: Visitor, look: Look | None, floor: tuple[float, float] | None,
               now: float) -> float | None:
        """Lower = more alike. None = cannot be this visitor."""
        if v.left or now - v.last_any > self._keep(v):
            return None  # ended (or about to be): its track_id is never given again
        app = None
        if comparable(look, v.look):
            app = compare(look, v.look)
            if app is None:
                return None  # another face / body / attire / height
        fresh = floor is not None and v.floor is not None and now - v.floor_at <= POSITION_FRESH_SECONDS
        if fresh:
            d = math.dist(floor, v.floor)  # type: ignore[arg-type]
            if d > self.same_place:
                return None  # that visitor is somewhere else on the floor right now
            if app is not None and app > min(0.95, self.max_distance * 1.6):
                return None  # same spot but clearly a different look
            # same floor spot: strong evidence (ranks before look-only matches)
            return d / self.same_place * 0.6 + (app / self.max_distance if app is not None else 0.5) * 0.4
        if app is None or app >= self.max_distance:
            return None
        return 1.0 + app / self.max_distance

    def _match_locked(self, look, floor, exclude: set[str], now: float, visible_only: bool = False,
                      outside_only: bool = False, inside_only: bool = False) -> Visitor | None:
        best, best_s = None, None
        for v in self._inside.values():
            if v.visit_id in exclude:
                continue
            if outside_only and not v.outside:
                continue  # someone standing outside can only be a visitor who went Out
            if inside_only and v.outside:
                continue  # someone who appeared inside cannot be a visitor who went Out
            if visible_only and not v.outside and (not v.seen_on or now - max(v.seen_on.values()) >= HIDDEN_SECONDS):
                continue  # hidden inside: cannot be someone walking in from outside right now
            s = self._score(v, look, floor, now)
            if s is not None and (best_s is None or s < best_s):
                best, best_s = v, s
        return best

    def match(self, look: Look | None, floor: tuple[float, float] | None = None,
              exclude: set[str] | None = None, now: float | None = None,
              visible_only: bool = False, outside_only: bool = False, inside_only: bool = False) -> Visitor | None:
        """The remembered visitor who is most likely this person, or None.
        exclude = visit_ids already followed as other people in this camera's picture.
        visible_only: only visitors a camera sees right now (for someone who
        just walked in from outside: they cannot be a visitor hidden inside;
        a visitor who went Out may come back in).
        outside_only: only visitors who went Out (for someone standing outside).
        inside_only: only visitors who have not gone Out."""
        if (look is None or look.empty) and floor is None:
            return None
        with self._lock:
            return self._match_locked(look, floor, exclude or set(), time.time() if now is None else now,
                                      visible_only, outside_only, inside_only)

    def find_or_create(self, look, floor, exclude: set[str], create: Callable[[], Visitor],
                       now: float | None = None, visible_only: bool = False) -> tuple[Visitor, bool]:
        """Same as match, and if nobody matches, create the visitor — in one step,
        so two cameras seeing the same new person at once make only ONE visit."""
        now = time.time() if now is None else now
        with self._lock:
            known = (look is not None and not look.empty) or floor is not None
            v = self._match_locked(look, floor, exclude, now, visible_only) if known else None
            if v is not None:
                return v, False
            v = create()
            self._inside[v.visit_id] = v
            return v, True

    def _keep(self, v: Visitor) -> float:
        """How long a visitor is remembered after the last camera saw them:
        5 minutes after going Out (may come back in), TRACK_KEEP_SECONDS (5 minutes) while inside."""
        return self.outside_keep_seconds if v.outside else self.keep_seconds

    # ---------- updates ----------
    def seen(self, visitor: Visitor, camera_id: str, now: float | None = None,
             floor: tuple[float, float] | None = None, height: float | None = None, conf: float | None = None) -> None:
        now = time.time() if now is None else now
        with self._lock:
            visitor.seen_on[camera_id] = now
            visitor.last_seen = now
            if conf is not None:
                visitor.last_conf = conf
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
            if visitor.left or visitor.outside:
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

    def leave(self, visitor: Visitor, now: float | None = None) -> bool:
        """Counted Out: the person left the shop. They are still followed
        outside (nothing more is recorded) and keep their track_id while a
        camera sees them, and OUTSIDE_KEEP_SECONDS after. False if they
        are already outside (Out already recorded, by this or another camera):
        no second Out until they come back in."""
        with self._lock:
            if visitor.left or visitor.outside:
                return False
            visitor.outside = True
            visitor.last_seen = time.time() if now is None else now
            visitor.cameras_in.clear()  # each camera records In again if they come back
            visitor.region = visitor.region_name = visitor.region_kind = visitor.region_camera = None
            return True

    def come_back(self, visitor: Visitor) -> bool:
        """A visitor who went Out walks back in through the entrance (within OUTSIDE_KEEP_SECONDS): same visit."""
        with self._lock:
            if visitor.left or not visitor.outside:
                return False
            visitor.outside = False
            return True

    def expire(self, now: float | None = None) -> list[Visitor]:
        """End every visitor no camera has seen for KEEP_SECONDS (inside) or
        OUTSIDE_KEEP_SECONDS (went Out), and everyone at midnight. Their
        track_id is finished: never matched again.
        Returns those who were still INSIDE (no Out seen): the caller closes
        their visit with an Out event."""
        now = time.time() if now is None else now
        closed: list[Visitor] = []
        with self._lock:
            day = time.localtime(now).tm_yday
            new_day = day != self._day
            self._day = day
            for vid in [k for k, v in self._inside.items() if new_day or now - v.last_any > self._keep(v)]:
                v = self._inside.pop(vid)
                v.left = True
                if not v.outside:
                    closed.append(v)
        return closed

    # ---------- hidden people coming back ----------
    def reclaim(self, look: Look | None, floor: tuple[float, float] | None, exclude: set[str],
                now: float | None = None) -> Visitor | None:
        """Someone appeared INSIDE the shop (not walking in from outside) and no
        visitor matched closely: they may be a visitor who was hidden behind an
        obstacle for a few seconds (less than KEEP_SECONDS). Give them back the
        hidden visitor who looks most alike (looser match), so their track_id
        stays the same. None when nobody is hidden or nobody looks alike."""
        now = time.time() if now is None else now
        best, best_s = None, None
        with self._lock:
            for v in self._inside.values():
                if v.left or v.outside or v.visit_id in exclude:
                    continue  # people who went Out come back through the entrance, not from hiding
                last = v.last_any
                if now - last < HIDDEN_SECONDS or now - last > self.keep_seconds:
                    continue  # seen right now (not hidden), or already ended
                if not comparable(look, v.look):
                    continue  # nothing to recognise them by: a new person
                app = compare(look, v.look)
                if app is None or app > LOOSE_DISTANCE:
                    continue  # another face / body / attire / height
                moved = math.dist(floor, v.floor) if floor is not None and v.floor is not None else None
                if moved is not None and moved > HIDDEN_MOVE_METRES:
                    continue
                s = app + (moved or 0.0) / 20 + (now - last) / 60
                if best_s is None or s < best_s:
                    best, best_s = v, s
        return best

    def count(self) -> int:
        """People inside the shop (not those who went Out and are only remembered)."""
        with self._lock:
            return sum(1 for v in self._inside.values() if not v.outside and not v.left)

    def inside_now(self, seen_seconds: float = KEEP_SECONDS, now: float | None = None) -> dict:
        """People inside the shop right now, as the 4 cameras see them: visitors
        seen by ANY camera in the last few seconds. One visitor = one person, so
        someone seen by 2 cameras at once (overlapping views) is counted once."""
        now = time.time() if now is None else now
        out = {"all": 0, "male": 0, "female": 0, "unknown": 0}
        with self._lock:
            for v in self._inside.values():
                if v.left or v.outside or not v.seen_on or now - max(v.seen_on.values()) > seen_seconds:
                    continue  # went Out, ended, or not seen right now
                gender = v.estimate.visit_fields()["est_gender"] if v.estimate.samples else "Unknown"
                out["all"] += 1
                out[{"Male": "male", "Female": "female"}.get(gender, "unknown")] += 1
        return out
