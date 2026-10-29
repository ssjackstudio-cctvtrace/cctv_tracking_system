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
    that visitor: its cctv_event rows always use the same visit_id / track_id.
  - cctv_event rows come from the shop areas each camera has drawn (see
    space3d.py), once per visitor whichever camera sees it first:
      In          (track_region Purchasing / Counter): walked into the shop, or
                  into the other kind of area inside the shop
      Passed By   (track_region Traffic): a new person first seen on the
                  walkway outside the shop (a passer-by gets a track_id too),
                  or someone who walked from inside onto the walkway: the
                  stay in the shop ends here. A passer-by who then walks into
                  the shop gets In with the SAME track_id.
      Out         (track_region Out of Range): walked from inside to a spot
                  outside every drawn area, or no camera saw them for
                  KEEP_SECONDS (main.py closes the visit)
    Two cameras whose views overlap may see one person in different areas at
    the same moment (the areas were drawn a little differently): a camera only
    moves the person in or out when no OTHER camera has just seen them on the
    other side (GUARD_SECONDS), so the events never flip back and forth.
  - A person is remembered while ANY camera sees them, and for KEEP_SECONDS
    (TRACK_KEEP_SECONDS in .env, default 600 = 10 minutes) after the last camera saw them.
    While they are still inside, a person the tracker lost (hidden behind a
    display, crouching, out of every camera's picture) who shows up again
    within those 10 minutes with the same look gets their SAME track_id back
    (reclaim), wherever in the shop they reappear.
    Then the track_id is ended for good: it is never given to anyone again.
    If the person was still inside (no Out seen), the visit is closed with an
    Out event at the moment they were last seen (main.py), so every visit has
    an In and an Out.
  - Passed By / Out is recorded once. After it the person is still followed
    outside the shop, but nothing more is recorded, and their track_id is
    kept for OUTSIDE_KEEP_SECONDS (default 300 = 5 minutes) after the last
    camera saw them. If they walk back into the shop in that time, it is the
    same visit and the same track_id (a new In event). After that the
    track_id ends for good.

Is this the same person? The registry compares, for every remembered visitor:
  1. Floor position (cameras placed on the shop plan in "3D shop floor map"):
     all cameras use the same shop floor coordinates in metres, so one person
     seen by two cameras at once (overlapping views) is at the same floor
     spot. A visitor seen somewhere else on the floor right now cannot be
     this person.
  2. Face, attire, whole body and height (reid.compare). On the SAME camera a
     clear difference in any of them = another person. Each visitor keeps a
     look per camera: a camera compares with what it saw itself (strict), or,
     for a visitor only other cameras saw, with their looks under the
     cross-camera rules (only the face or a very sure whole-body model can
     say "another person"; clothes colours count less, height not at all).
     Also for a person lost for a while: with the cameras on the shop plan,
     someone can only be a remembered visitor if they stand within walking
     distance (PERSON_SPEED_MPS x the time since that visitor was last seen)
     of where that visitor was last seen. Which person, at which place.
  3. A visitor already followed on this camera as a different person, in the
     same picture, is never a match (two people side by side).
  4. Overlap handoff (cameras whose views overlap): if the strict look match
     fails, a visitor ANOTHER camera sees right now, or who went In on another
     camera at the same moment, is still this person unless the look is
     clearly different. Two camera angles of one person rarely look alike
     enough for the strict match, and a missed match = a duplicate visit.
Two cameras that see a new person at the same moment ask the registry one at
a time (find_or_create), so only one visit row can be made.
An unlinked tracker number that walks out of the shop is recognised the same
way (recognise), so its Passed By / Out goes to the EXISTING track_id.

Only numbers are kept in memory; no picture is saved or sent.
"""

from __future__ import annotations

import math
import os
import threading
import time
from dataclasses import dataclass, field
from typing import Callable

import numpy as np

from .demographics import Estimate
from .reid import (BODY_DIFFERENT, BODY_DIFFERENT_CROSS, BODY_SAME, FACE_DIFFERENT, FACE_SAME, MAX_DISTANCE,
                   N_COLOURS, Look, appearance, attire_clash, attire_distance, comparable, compare,
                   describe_colours, same_face, texture_distances)
from datetime import datetime, timezone

# Older names, kept for other modules
distance = attire_distance
__all__ = ["MAX_DISTANCE", "KEEP_SECONDS", "OUTSIDE_KEEP_SECONDS", "Visitor", "VisitorRegistry", "appearance", "distance"]

# Not seen by any camera for this long → the track_id ends (person gone)
# 10 minutes: a person still inside the shop whom no camera sees for a while (hidden behind a
# display, out of every picture) keeps their track_id this long, and gets it back when seen again
KEEP_SECONDS = float(os.getenv("TRACK_KEEP_SECONDS", "600"))  # 10 minutes
# After Out: the track_id is kept this long after the last camera saw the person (outside the shop)
OUTSIDE_KEEP_SECONDS = float(os.getenv("OUTSIDE_KEEP_SECONDS", "300"))
HIDDEN_SECONDS = min(3.0, KEEP_SECONDS)  # a visitor no camera has seen for this long is "hidden" (may come back)
# A visitor no camera has seen for this long may be given back to someone who appears INSIDE
# with a matching look (reclaim). Was HIDDEN_SECONDS (3 s): a person who walked out of one
# camera's picture and into the next camera's picture 2-3 s later fell in the gap between the
# overlap handoff (OVERLAP_SECONDS) and reclaim, and got a NEW track_id.
RECLAIM_AFTER_SECONDS = min(float(os.getenv("RECLAIM_AFTER_SECONDS", "1.0")), KEEP_SECONDS)
LOOSE_DISTANCE = min(0.9, MAX_DISTANCE * 1.5)  # look match for a hidden visitor coming back (within KEEP_SECONDS)
HIDDEN_MOVE_METRES = 4.0  # how far a hidden person may have moved right away (cameras on the shop plan) ...
# ... plus this much per second hidden: after a long time (up to KEEP_SECONDS) they may be anywhere in the shop
HIDDEN_MOVE_MPS = float(os.getenv("HIDDEN_MOVE_MPS", "0.5"))
SAME_PLACE_METRES = float(os.getenv("SAME_PLACE_METRES", "0.9"))  # two cameras' floor spots this close = same person
POSITION_FRESH_SECONDS = 1.5  # a visitor's floor spot is "now" for this long after it was seen
# Cameras on the shop plan are calibrated by hand, so two cameras can put the SAME person
# a little apart (more for people far from a camera). A floor difference above
# SAME_PLACE_METRES normally means "someone else", but when the face is surely the same,
# up to this far apart is still the same person (no second track_id for them).
FLOOR_FACE_METRES = float(os.getenv("FLOOR_FACE_METRES", "2.0"))
# Someone first seen OUTSIDE may be a visitor who was inside this recently: they just walked out
# (the tracker often gives a new number while people pass behind the displays at the shop front)
EXIT_LINK_SECONDS = float(os.getenv("EXIT_LINK_SECONDS", "8"))
EXIT_LINK_SCORE = 1.8  # ... but only with a clearly matching look (score below this; lower = more alike)
# Overlapping cameras (4 cameras in one shop): one person seen by 2 cameras at the
# same moment looks different from each side (other angle, other light), so the
# strict look match can miss and the 2nd camera would make a DUPLICATE visit with
# a new track_id. Handoff: a visitor ANOTHER camera sees right now (or who went In
# on another camera a moment ago), and whom this camera is not following yet, is
# the same person unless the look is clearly different (looser match).
# 8 s: a shopper walking out of one camera's picture can take several seconds to appear
# in the next camera's picture (e.g. ABT-02 → ABT-01 took about 9 s); with 3 s they got a new track_id
OVERLAP_SECONDS = float(os.getenv("OVERLAP_SECONDS", "8.0"))  # "seen by another camera a moment ago"
OVERLAP_IN_SECONDS = float(os.getenv("OVERLAP_IN_SECONDS", "4.0"))  # In on 2 cameras this close = same entry
OVERLAP_DISTANCE = float(os.getenv("OVERLAP_DISTANCE", str(LOOSE_DISTANCE)))  # look match allowed for a handoff
# Areas: another camera that saw the person on the other side (inside / on the walkway) this
# recently stops this camera from moving them in or out (areas drawn a little differently)
GUARD_SECONDS = float(os.getenv("AREA_GUARD_SECONDS", "1.5"))
# Fastest a shopper walks (metres per second): a visitor last seen at one spot of the shop plan
# cannot be someone standing further away than this x the seconds since (plus SAME_PLACE_METRES)
PERSON_SPEED_MPS = float(os.getenv("PERSON_SPEED_MPS", "1.5"))
# Suspicious same person (listed on the Camera page, merged there by an admin): two
# remembered track_ids whose LOOKS match (attire colour, face, whole body, head / chest /
# legs texture: see SUSPECT_MIN_SCORE below) although the live matching kept them apart.
# 10 minutes (as TRACK_KEEP_SECONDS): one person walking around the shop can be seen by the 4
# cameras one after the other, minutes apart, and get another track_id on each camera
SUSPECT_GAP_SECONDS = float(os.getenv("SUSPECT_GAP_SECONDS", "600"))  # 2nd track_id started this soon after the 1st was last seen
RETRACK_SECONDS = float(os.getenv("RETRACK_SECONDS", "600"))  # same camera: new number this soon after the old one was lost
# One person with several track_ids (e.g. one per camera): each later track_id is listed under
# the EARLIEST track_id it matches within this many score points of its best match, so all of
# them land on ONE card (the first track_id), not in a chain A <- B <- C <- D
SUSPECT_GROUP_MARGIN = float(os.getenv("SUSPECT_GROUP_MARGIN", "10"))
# Guest: a first track_id collects suspicious same-person track_ids for 10 minutes only.
# A later track_id first seen more than this after the first track_id was first seen is
# never listed under it: it becomes a new first track_id of its own.
SUSPECT_WINDOW_SECONDS = float(os.getenv("SUSPECT_WINDOW_SECONDS", "600"))
# What makes two track_ids a suspicious same person: their LOOKS only (never the place alone):
#   attire colour   named colour of the top and the pants (reid.attire_colours)    needed
#   chest, legs     texture of the shirt and of the pants (reid.body_texture)       needed
#   head            texture of the head / hair                                      when seen
#   face            face recognition (SFace)                                        when seen
#   body            whole-body recognition model (YoutuReID)                        when seen
# Any of them CLEARLY different = two people (a surely-same face overrules the
# whole-body and texture checks, never the attire colour). Then the weighted
# similarity of all of them must reach SUSPECT_MIN_SCORE %.
SUSPECT_MIN_SCORE = float(os.getenv("SUSPECT_MIN_SCORE", "60"))
# ... and the attire colour on its own must be at least this % alike (the top and the pants
# are judged separately, the less alike of the two counts)
SUSPECT_MIN_ATTIRE = float(os.getenv("SUSPECT_MIN_ATTIRE", "55"))
# Chest / legs texture distance (0 = same, 1 = nothing alike) above this = another
# shirt / pants pattern: same camera (same light, same angle) / two cameras
TEXTURE_DIFFERENT = float(os.getenv("TEXTURE_DIFFERENT", "0.30"))
TEXTURE_DIFFERENT_CROSS = float(os.getenv("TEXTURE_DIFFERENT_CROSS", "0.40"))
# How much each kind of evidence counts in the score: same camera / two cameras
SUSPECT_WEIGHTS = {"face": 3.0, "body": 2.0, "clothes": 2.0, "head": 0.5, "chest": 1.0, "legs": 1.0}
SUSPECT_WEIGHTS_CROSS = {"face": 3.0, "body": 2.0, "clothes": 1.5, "head": 0.3, "chest": 0.7, "legs": 0.7}


def look_distance(look: Look | None, v: "Visitor", camera_id: str | None) -> tuple[bool, float | None]:
    """(comparable, distance) between a new look and a remembered visitor, as
    reid.compare (0 = same, None = clearly someone else).
    - camera_id unknown, or the visitor has no per-camera looks: the overall look, strict.
    - The visitor was seen on THIS camera: compared with this camera's look, strict
      (same angle, same light: a clothes / height difference is real).
    - Only seen on OTHER cameras: compared with each of those cameras' looks with the
      cross-camera rules, the best one counts (another angle / light / white balance)."""
    if camera_id is None or not v.looks:
        ok = comparable(look, v.look)
        return ok, compare(look, v.look) if ok else None
    own = v.looks.get(camera_id)
    if own is not None and comparable(look, own):
        return True, compare(look, own)
    others = [lk for c, lk in v.looks.items() if c != camera_id and comparable(look, lk, cross=True)]
    if not others:
        return False, None
    found = [d for d in (compare(look, lk, cross=True) for lk in others) if d is not None]
    return True, (min(found) if found else None)


@dataclass(eq=False)
class Visitor:
    visit_id: str
    track_id: str  # given by the first camera that saw the person go In; never changes, never reused
    first_camera: str = ""
    look: Look = field(default_factory=Look)  # face + attire + whole body, from all cameras
    # the same, per camera: a camera compares a person with what IT saw before (same angle,
    # same light: strict rules), and with what OTHER cameras saw (cross-camera rules, reid.compare)
    looks: dict[str, Look] = field(default_factory=dict)
    cameras_in: set[str] = field(default_factory=set)  # cameras that already recorded In for this visit
    in_at: dict[str, float] = field(default_factory=dict)  # camera_id → time that camera recorded In (handoff)
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
    inside_at: dict[str, float] = field(default_factory=dict)  # camera_id → last time seen in a Purchasing / Counter area
    traffic_at: dict[str, float] = field(default_factory=dict)  # camera_id → last time seen on the Traffic walkway
    estimate: Estimate = field(default_factory=Estimate)  # gender / age from all cameras
    sent_faces: int = 0  # samples already written to the visit row
    outside: bool = False  # counted Out (still remembered while seen, and OUTSIDE_KEEP_SECONDS after)
    left: bool = False  # ended: the track_id is finished for good
    created_at: float = field(default_factory=time.time)  # when this track_id was made (suspicious pairs: the first is kept)
    first_on: dict[str, float] = field(default_factory=dict)  # camera_id → first time seen there
    # Photo of this track_id for the Camera page "Suspicious same person" (camera_worker._take_photos)
    photo_q: float = 0.0  # how good the uploaded photo is (bigger, sharper, face visible = better)
    photo_at: float = 0.0  # when it was last taken

    def add_look(self, look: Look | None, camera_id: str | None = None) -> None:
        """Keep a running average of how the visitor looks (several frames, several
        cameras), and per camera when the camera is known."""
        self.look.add(look)
        if camera_id is not None and look is not None and not look.empty:
            own = self.looks.get(camera_id)
            if own is None:
                self.looks[camera_id] = look.copy()
            else:
                own.add(look)

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
        # pairs of visit_ids one camera saw in the SAME picture: surely two people (never a suspicious pair)
        self._together: set[frozenset[str]] = set()
        # pairs of visit_ids an admin marked "Not same" on the Camera page: never suggested again
        self._apart: set[frozenset[str]] = set()
        self._lock = threading.RLock()
        self._day = time.localtime().tm_yday  # the list starts again every day

    # ---------- who is this person? ----------
    def _score(self, v: Visitor, look: Look | None, floor: tuple[float, float] | None,
               now: float, camera_id: str | None = None) -> float | None:
        """Lower = more alike. None = cannot be this visitor."""
        if v.left or now - v.last_any > self._keep(v):
            return None  # ended (or about to be): its track_id is never given again
        app = None
        ok, d = look_distance(look, v, camera_id)
        if ok:
            app = d
            if app is None:
                return None  # another face / body (or, on the same camera, attire / height)
        fresh = floor is not None and v.floor is not None and now - v.floor_at <= POSITION_FRESH_SECONDS
        if fresh:
            d = math.dist(floor, v.floor)  # type: ignore[arg-type]
            if d > self.same_place:
                if d > FLOOR_FACE_METRES or not same_face(look, v.look):
                    return None  # that visitor is somewhere else on the floor right now
                # the cameras' floor spots differ a little, but it is surely the same face
                return 1.0 + (app / self.max_distance if app is not None else 0.0)
            if app is not None and app > min(0.95, self.max_distance * 1.6):
                return None  # same spot but clearly a different look
            # same floor spot: strong evidence (ranks before look-only matches)
            return d / self.same_place * 0.6 + (app / self.max_distance if app is not None else 0.5) * 0.4
        moved = None
        if floor is not None and v.floor is not None:  # last seen a while ago: could they have walked here?
            moved = math.dist(floor, v.floor)
            walk = PERSON_SPEED_MPS * max(0.0, now - v.floor_at)
            if moved > self.same_place + walk and \
                    not (moved <= FLOOR_FACE_METRES + walk and same_face(look, v.look)):
                return None  # too far from where that visitor was last seen
        if app is None or app >= self.max_distance:
            return None
        return 1.0 + app / self.max_distance + (min(moved, 10.0) / 50 if moved is not None else 0.0)

    def _match_locked(self, look, floor, exclude: set[str], now: float, visible_only: bool = False,
                      outside_only: bool = False, inside_only: bool = False,
                      just_out: bool = False, camera_id: str | None = None) -> Visitor | None:
        best, best_s = None, None
        for v in self._inside.values():
            if v.visit_id in exclude:
                continue
            leaving = False
            if outside_only and not v.outside:
                # someone standing outside: a visitor who went Out, or (just_out) one who
                # was inside a few seconds ago and has just walked out without being counted Out
                if not (just_out and now - v.last_any <= EXIT_LINK_SECONDS):
                    continue
                leaving = True
            if inside_only and v.outside:
                continue  # someone who appeared inside cannot be a visitor who went Out
            if visible_only and not v.outside and (not v.seen_on or now - max(v.seen_on.values()) >= HIDDEN_SECONDS):
                continue  # hidden inside: cannot be someone walking in from outside right now
            s = self._score(v, look, floor, now, camera_id)
            if s is not None and leaving and s >= EXIT_LINK_SCORE:
                continue  # just walked out: only with a clearly matching look
            if s is not None and (best_s is None or s < best_s):
                best, best_s = v, s
        return best

    def match(self, look: Look | None, floor: tuple[float, float] | None = None,
              exclude: set[str] | None = None, now: float | None = None,
              visible_only: bool = False, outside_only: bool = False, inside_only: bool = False,
              just_out: bool = False, camera_id: str | None = None) -> Visitor | None:
        """The remembered visitor who is most likely this person, or None.
        exclude = visit_ids already followed as other people in this camera's picture.
        visible_only: only visitors a camera sees right now (for someone who
        just walked in from outside: they cannot be a visitor hidden inside;
        a visitor who went Out may come back in).
        outside_only: only visitors who went Out (for someone standing outside).
        just_out: with outside_only, also visitors inside seen in the last
        EXIT_LINK_SECONDS whose look clearly matches (they just walked out).
        inside_only: only visitors who have not gone Out.
        camera_id: the asking camera (same-camera vs cross-camera look rules)."""
        if (look is None or look.empty) and floor is None:
            return None
        with self._lock:
            return self._match_locked(look, floor, exclude or set(), time.time() if now is None else now,
                                      visible_only, outside_only, inside_only, just_out, camera_id)

    def _handoff_locked(self, look: Look | None, floor: tuple[float, float] | None, exclude: set[str],
                        camera_id: str, now: float, when: float | None, outside: bool = False) -> Visitor | None:
        """Overlapping cameras: the visitor ANOTHER camera is following right now
        (seen there in the last OVERLAP_SECONDS), or who went In on another
        camera within OVERLAP_IN_SECONDS of `when` (this camera's In), and whom
        this camera is not following as someone else. Same person unless the
        look is clearly different (compare → None) or too far apart
        (> OVERLAP_DISTANCE), or they stand somewhere else on the shop plan.
        Without a look, only a visitor who went In on another camera at the
        same moment, and only when exactly one does (no guessing).
        outside=True (someone on the Traffic walkway): visitors outside the
        shop, or ones another camera sees on the walkway right now."""
        best, best_s, blind = None, None, []
        for v in self._inside.values():
            if v.left or v.visit_id in exclude or now - v.last_any > self._keep(v):
                continue
            if outside:
                if not v.outside and not any(c != camera_id and now - t <= OVERLAP_SECONDS
                                             for c, t in v.traffic_at.items()):
                    continue
            elif v.outside:
                continue
            others = [t for c, t in v.seen_on.items() if c != camera_id]
            if not others:
                continue  # only this camera knows them: the normal rules decide
            mine = v.seen_on.get(camera_id)
            if mine is not None and now - mine <= OVERLAP_SECONDS:
                continue  # this camera is following them right now as another tracker number
            seen_now = now - max(others) <= OVERLAP_SECONDS
            went_in = when is not None and any(
                c != camera_id and abs(t - when) <= OVERLAP_IN_SECONDS for c, t in v.in_at.items())
            if not (seen_now or went_in):
                continue
            if floor is not None and v.floor is not None and now - v.floor_at <= POSITION_FRESH_SECONDS:
                apart = math.dist(floor, v.floor)
                if apart > self.same_place and not (apart <= FLOOR_FACE_METRES and same_face(look, v.look)):
                    continue  # standing somewhere else on the shop plan (same face: calibration gap, allowed)
            ok, app = look_distance(look, v, camera_id)
            if not ok:
                if went_in:
                    blind.append(v)
                continue
            if app is None or app > OVERLAP_DISTANCE:
                continue  # clearly another person
            s = app - (0.05 if went_in else 0.0)  # went In at the same moment: a little more likely
            if best_s is None or s < best_s:
                best, best_s = v, s
        if best is None and len(blind) == 1:
            best = blind[0]
        return best

    def recognise(self, look: Look | None, floor: tuple[float, float] | None, exclude: set[str],
                  camera_id: str, now: float | None = None, when: float | None = None) -> Visitor | None:
        """Which visitor INSIDE is this person, without making a new visit:
        the strict match first, then the overlapping-camera handoff. Used when
        an unlinked tracker number crosses the count line to Out, so the Out
        is recorded for the person's EXISTING track_id."""
        now = time.time() if now is None else now
        with self._lock:
            known = (look is not None and not look.empty) or floor is not None
            v = self._match_locked(look, floor, exclude, now, inside_only=True, camera_id=camera_id) if known else None
            return v or self._handoff_locked(look, floor, exclude, camera_id, now, when)

    def find_or_create(self, look, floor, exclude: set[str], create: Callable[[], Visitor],
                       now: float | None = None, visible_only: bool = False,
                       camera_id: str | None = None, when: float | None = None) -> tuple[Visitor, bool]:
        """Same as match, and if nobody matches, create the visitor — in one step,
        so two cameras seeing the same new person at once make only ONE visit.
        camera_id given: before creating, also try the overlapping-camera handoff
        (when = time this camera saw the person go In)."""
        now = time.time() if now is None else now
        with self._lock:
            known = (look is not None and not look.empty) or floor is not None
            v = self._match_locked(look, floor, exclude, now, visible_only, camera_id=camera_id) if known else None
            if v is None and camera_id is not None:
                v = self._handoff_locked(look, floor, exclude, camera_id, now, when)
            if v is not None:
                return v, False
            v = create()
            self._inside[v.visit_id] = v
            return v, True

    def find_or_create_outside(self, look, floor, exclude: set[str], create: Callable[[], Visitor],
                               camera_id: str, now: float | None = None) -> tuple[Visitor, bool]:
        """Someone steadily on the Traffic walkway, not known on this camera:
        a visitor outside the shop (a passer-by seen before, also by another
        camera right now), or one who just walked out; else a new visitor
        made by create() — in one step, so two cameras make only ONE visit."""
        now = time.time() if now is None else now
        with self._lock:
            known = (look is not None and not look.empty) or floor is not None
            v = self._match_locked(look, floor, exclude, now, outside_only=True, just_out=True,
                                   camera_id=camera_id) if known else None
            if v is None:
                v = self._handoff_locked(look, floor, exclude, camera_id, now, None, outside=True)
            if v is not None:
                return v, False
            v = create()
            self._inside[v.visit_id] = v
            return v, True

    def _keep(self, v: Visitor) -> float:
        """How long a visitor is remembered after the last camera saw them:
        5 minutes after going Out (may come back in), TRACK_KEEP_SECONDS (10 minutes) while inside."""
        return self.outside_keep_seconds if v.outside else self.keep_seconds

    # ---------- updates ----------
    def seen(self, visitor: Visitor, camera_id: str, now: float | None = None,
             floor: tuple[float, float] | None = None, height: float | None = None, conf: float | None = None) -> None:
        now = time.time() if now is None else now
        with self._lock:
            visitor.seen_on[camera_id] = now
            visitor.first_on.setdefault(camera_id, now)
            # everyone this camera already saw in this same frame (same frame time) is someone else
            for o in self._inside.values():
                if o is not visitor and o.seen_on.get(camera_id) == now:
                    self._together.add(frozenset((o.visit_id, visitor.visit_id)))
            visitor.last_seen = now
            if conf is not None:
                visitor.last_conf = conf
            if floor is not None:
                visitor.floor, visitor.floor_at = floor, now
            if height is not None:
                visitor.height = height if visitor.height is None else visitor.height * 0.8 + height * 0.2

    def first_in(self, visitor: Visitor, camera_id: str, when: float | None = None) -> bool:
        """True once per camera per visit: this camera records its In event now."""
        with self._lock:
            if visitor.left or camera_id in visitor.cameras_in:
                return False
            visitor.cameras_in.add(camera_id)
            visitor.in_at[camera_id] = time.time() if when is None else when
            return True

    def where(self, visitor: Visitor, camera_id: str, inside: bool | None, now: float) -> None:
        """This camera sees the person steadily inside the shop (True), on the
        Traffic walkway (False), or elsewhere (None)."""
        with self._lock:
            if inside is True:
                visitor.inside_at[camera_id] = now
            elif inside is False:
                visitor.traffic_at[camera_id] = now

    def enter(self, visitor: Visitor, kind: str, name: str | None, camera_id: str,
              now: float | None = None) -> tuple[bool, bool]:
        """The person is steadily in a Purchasing / Counter area on this camera.
        Returns (record an In event, came back into the shop). An In is
        recorded when the person comes into the shop, and when they move to
        the OTHER kind of area (Purchasing ↔ Counter), once whichever camera
        sees it first."""
        now = time.time() if now is None else now
        with self._lock:
            if visitor.left:
                return False, False
            if visitor.outside:
                if any(c != camera_id and now - t <= GUARD_SECONDS for c, t in visitor.traffic_at.items()):
                    return False, False  # another camera still sees them on the walkway
                visitor.outside = False
                came_back = True
            else:
                came_back = False
                other = visitor.region_camera
                busy = other not in (None, camera_id) and now - visitor.inside_at.get(other, 0.0) <= GUARD_SECONDS
                if visitor.region_kind == kind:
                    if not busy:  # this camera follows them in the shop now
                        visitor.region_camera, visitor.region_name = camera_id, name
                    return False, False
                if busy:
                    return False, False  # the camera that placed them sees them in its own area right now
            visitor.region = kind
            visitor.region_kind, visitor.region_name, visitor.region_camera = kind, name, camera_id
            return True, came_back

    def may_leave(self, visitor: Visitor, camera_id: str, out_of_range: bool, now: float | None = None) -> bool:
        """May this camera record the person leaving the shop (Passed By on the
        walkway, or Out of Range)? Not while ANOTHER camera has just seen them
        inside a shop area. Out of Range (no area drawn there) also needs THIS
        camera to have seen them inside the shop: a spot outside every area of
        this camera may simply be a part of the shop it has no area for."""
        now = time.time() if now is None else now
        with self._lock:
            if visitor.left or visitor.outside:
                return False
            if any(c != camera_id and now - t <= GUARD_SECONDS for c, t in visitor.inside_at.items()):
                return False
            return not out_of_range or camera_id in visitor.inside_at

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
            visitor.inside_at.clear()
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
            if self._together:  # forget pairs whose people are gone
                self._together = {pair for pair in self._together if pair <= self._inside.keys()}
        return closed

    # ---------- hidden people coming back ----------
    def reclaim(self, look: Look | None, floor: tuple[float, float] | None, exclude: set[str],
                now: float | None = None, camera_id: str | None = None) -> Visitor | None:
        """Someone appeared INSIDE the shop (not walking in from outside) and no
        visitor matched closely: they may be a visitor who was hidden behind an
        obstacle, or out of every camera's picture, for less than KEEP_SECONDS
        (10 minutes). Give them back the
        hidden visitor who looks most alike (looser match), so their track_id
        stays the same. None when nobody is hidden or nobody looks alike."""
        now = time.time() if now is None else now
        best, best_s = None, None
        with self._lock:
            for v in self._inside.values():
                if v.left or v.outside or v.visit_id in exclude:
                    continue  # people who went Out come back through the entrance, not from hiding
                last = v.last_any
                if now - last < RECLAIM_AFTER_SECONDS or now - last > self.keep_seconds:
                    continue  # seen right now (not hidden), or already ended
                ok, app = look_distance(look, v, camera_id)
                if not ok:
                    continue  # nothing to recognise them by: a new person
                if app is None or app > LOOSE_DISTANCE:
                    continue  # another face / body / attire / height
                moved = math.dist(floor, v.floor) if floor is not None and v.floor is not None else None
                if moved is not None and moved > HIDDEN_MOVE_METRES + HIDDEN_MOVE_MPS * (now - last):
                    continue  # too far from where they were hidden, for the time they were hidden
                s = app + (moved or 0.0) / 20 + (now - last) / 60
                if best_s is None or s < best_s:
                    best, best_s = v, s
        return best

    # ---------- suspicious same person (Camera page) ----------
    def suspects(self, now: float | None = None) -> list[dict]:
        """Pairs of remembered track_ids that are probably ONE person: alike in
        face / whole body / clothes, seen by two cameras around the same time,
        or re-tracked with a new number on the same camera soon after the old
        one was lost. Never two people one camera followed at the same time.
        The earlier track_id (first camera) is the one to keep. Nothing is
        merged here: an admin checks the list on the Camera page."""
        now = time.time() if now is None else now
        with self._lock:  # copy, then compare without blocking the cameras
            snap = [(v, dict(v.seen_on), dict(v.first_on), {c: lk.copy() for c, lk in v.looks.items()}, v.look.copy(),
                     v.floor, v.floor_at, v.estimate.visit_fields()["est_gender"] if v.estimate.samples else "Unknown",
                     v.region_kind)
                    for v in self._inside.values() if not v.left]
            together = set(self._together) | self._apart
        snap.sort(key=lambda s: s[0].created_at)
        found: dict[str, list[dict]] = {}  # visit_dup → every first track_id it may be
        for i, a in enumerate(snap):
            for b in snap[i + 1:]:
                pair = _suspect_pair(a, b, together)
                if pair is not None:
                    found.setdefault(pair["visit_dup"], []).append(pair)
        out = []  # one row per duplicate: the earliest first track_id among its good matches
        for pairs in found.values():
            top = max(p["score"] for p in pairs)
            good = [p for p in pairs if p["score"] >= top - SUSPECT_GROUP_MARGIN]
            out.append(min(good, key=lambda p: (p["seen_keep"], [-x for x in _rank(p)])))
        return out

    def set_apart(self, pairs: set[frozenset[str]]) -> None:
        """Pairs of visit_ids marked "Not same" on the Camera page (read from
        suspect_match by main.py): they are two people, so suspects() never
        lists them together again."""
        with self._lock:
            self._apart = set(pairs)

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


def _first_on(v: Visitor, firsts: dict[str, float], camera_id: str) -> float | None:
    times = [t for t in (firsts.get(camera_id), v.created_at if camera_id == v.first_camera else None) if t is not None]
    return min(times) if times else None


def _iso(t: float) -> str:
    return datetime.fromtimestamp(t, timezone.utc).isoformat()


def _rank(pair: dict) -> tuple:
    """Which first track_id is the most likely one: a look that matches beats only the same
    place; among look matches the higher score, among place-only matches the closer floor spot."""
    apart = pair["floor_apart"] if pair["floor_apart"] != "" else 99.0
    return (1, pair["score"], -apart) if pair["look_ok"] else (0, -apart, pair["score"])


def _evidence(x: Look, y: Look, cross: bool) -> dict | None:
    """How alike two looks of a person are, cue by cue (see SUSPECT_MIN_SCORE):
    {"score": 0-100, "cues": {cue: % alike}, "face_sure": bool}.
    None = clearly two people (another face / attire colour / body / chest or legs
    pattern), or not enough to judge (attire colour, chest and legs are needed).
    cross=True: the looks come from two different cameras (more tolerant)."""
    weights = SUSPECT_WEIGHTS_CROSS if cross else SUSPECT_WEIGHTS
    dist: dict[str, float] = {}  # cue -> 0 (same) .. 1 (nothing alike)
    face_sure = False
    if x.face is not None and y.face is not None:
        s = float(x.face @ y.face)
        if s < FACE_DIFFERENT:
            return None  # another face
        face_sure = s >= FACE_SAME + 0.1
        dist["face"] = min(1.0, max(0.0, MAX_DISTANCE * (1 - s) / max(1 - FACE_SAME, 1e-6)))
    if x.body is not None and y.body is not None:
        s = float(x.body @ y.body)
        if s < (BODY_DIFFERENT_CROSS if cross else BODY_DIFFERENT) and not face_sure:
            return None  # another body
        dist["body"] = min(1.0, max(0.0, MAX_DISTANCE * (1 - s) / max(1 - BODY_SAME, 1e-6)))
    if x.colours is None or y.colours is None:
        return None  # attire colour not seen well: cannot judge
    if attire_clash(x.colours, y.colours, cross):
        return None  # top or pants clearly another colour
    # top and pants separately: the less alike of the two counts
    shared = [float(np.minimum(x.colours[i:i + N_COLOURS], y.colours[i:i + N_COLOURS]).sum())
              for i in (0, N_COLOURS)]
    dist["clothes"] = 1.0 - min(shared)
    if x.attire is not None and y.attire is not None:  # finer colour shades too
        dist["clothes"] = (2 * dist["clothes"] + min(1.0, attire_distance(x.attire, y.attire))) / 3
    if (1.0 - dist["clothes"]) * 100 < SUSPECT_MIN_ATTIRE:
        return None  # attire colour not alike enough
    tex = texture_distances(x.texture, y.texture)
    if "chest" not in tex or "legs" not in tex:
        return None  # chest / legs not seen well: cannot judge
    if not face_sure:
        if cross:
            # two cameras: one may see the front of the shirt (a print) and the other its back
            # (plain), so only the legs (pants pattern, alike from every side) can say "two people"
            if tex["legs"] > TEXTURE_DIFFERENT_CROSS:
                return None  # another pants pattern
        elif tex["chest"] > TEXTURE_DIFFERENT or tex["legs"] > TEXTURE_DIFFERENT:
            return None  # another shirt / pants pattern
    dist.update(tex)
    total = sum(weights[c] for c in dist)
    score = (1.0 - sum(d * weights[c] for c, d in dist.items()) / total) * 100
    if face_sure:
        score = max(score, 90.0)
    return {"score": round(score, 1), "cues": {c: round((1.0 - d) * 100) for c, d in dist.items()},
            "face_sure": face_sure}


def _other_attire(a_looks: dict, a_look: Look, b_looks: dict, b_look: Look) -> bool:
    """Another attire style (reid.attire_clash: the top OR the pants clearly another
    colour), so two people. On a camera that saw both (same light) one clash is enough.
    Seen only on different cameras: a clash on every pair of cameras (other light)."""
    la = [(c, lk) for c, lk in a_looks.items() if lk.colours is not None] or \
        ([(None, a_look)] if a_look.colours is not None else [])
    lb = [(c, lk) for c, lk in b_looks.items() if lk.colours is not None] or \
        ([(None, b_look)] if b_look.colours is not None else [])
    if not la or not lb:
        return False  # clothes not seen well on one of them: cannot tell
    same_cam = [(x, y) for ca, x in la for cb, y in lb if ca is not None and ca == cb]
    if same_cam:
        return any(attire_clash(x.colours, y.colours) for x, y in same_cam)
    return all(attire_clash(x.colours, y.colours, cross=True) for _, x in la for _, y in lb)


def _suspect_pair(a: tuple, b: tuple, together: set) -> dict | None:
    """One suspicious pair for VisitorRegistry.suspects (a made before b), or None."""
    va, a_seen, a_first, a_looks, a_look, a_floor, a_floor_at, a_gender, a_region = a
    vb, b_seen, b_first, b_looks, b_look, b_floor, b_floor_at, b_gender, b_region = b
    if va.visit_id == vb.visit_id or va.track_id == vb.track_id:
        return None
    if frozenset((va.visit_id, vb.visit_id)) in together:
        return None  # one camera saw both in the same picture: two people
    if {a_gender, b_gender} == {"Male", "Female"}:
        return None  # both clearly seen, and not the same gender
    if vb.created_at - va.created_at > SUSPECT_WINDOW_SECONDS:
        return None  # more than 10 minutes after the first track_id started: b is a new first track_id
    if _other_attire(a_looks, a_look, b_looks, b_look):
        return None  # top or pants clearly another colour: another person, never the same
    a_last = max([va.created_at, *a_seen.values()])
    gap = vb.created_at - a_last  # < 0: both tracked at the same time
    # lost on a camera, then a new number on that camera soon after
    retrack = next((c for c in a_seen.keys() & b_seen.keys()
                    if (fb := _first_on(vb, b_first, c)) is not None and 0 <= fb - a_seen[c] <= RETRACK_SECONDS), None)
    cross = gap <= SUSPECT_GAP_SECONDS and bool(set(b_seen) - set(a_seen) or set(a_seen) - set(b_seen)
                                                or va.first_camera != vb.first_camera)
    if retrack is None and not cross:
        return None
    # How alike, by the looks only: every camera's look of one against every camera's look
    # of the other. A camera that saw both (same light, same angle) saying "two people" is
    # final; seen only on different cameras, the best camera pair counts.
    la = list(a_looks.items()) or [(None, a_look)]
    lb = list(b_looks.items()) or [(None, b_look)]
    best_ev, same_cam_veto = None, False
    for ca, x in la:
        for cb, y in lb:
            other = ca is None or cb is None or ca != cb
            ev = _evidence(x, y, other)
            if ev is None:
                if not other and x.colours is not None and y.colours is not None and \
                        x.texture is not None and y.texture is not None:
                    same_cam_veto = True  # both seen well on this camera, and they differ
                continue
            if best_ev is None or ev["score"] > best_ev["score"]:
                best_ev = ev
    if same_cam_veto or best_ev is None or best_ev["score"] < SUSPECT_MIN_SCORE:
        return None
    face = best_ev["face_sure"]
    apart = None
    if a_floor is not None and b_floor is not None and abs(a_floor_at - b_floor_at) <= 3.0:
        apart = round(math.dist(a_floor, b_floor), 2)
    look_ok = True
    if retrack is not None and look_ok:
        kind, cam_keep, cam_dup = "Same camera", retrack, retrack
    elif cross:
        kind, cam_keep, cam_dup = "Another camera", va.first_camera, vb.first_camera
    else:
        return None
    score = best_ev["score"]
    cues = best_ev["cues"]
    names = {"face": "face", "body": "whole body", "clothes": "attire colour",
             "head": "head", "chest": "chest", "legs": "legs"}
    reasons = [("same face; " if face else "") + " · ".join(
        f"{names[c]} {cues[c]}%" if c in cues else f"{names[c]} not seen" for c in names)]
    reasons.append(f"clothes: {describe_colours(a_look.colours)} / {describe_colours(b_look.colours)}")
    if apart is not None:
        reasons.append(f"floor spots {apart:.1f} m apart")
    if kind == "Same camera":
        lost_gap = (_first_on(vb, b_first, retrack) or vb.created_at) - a_seen[retrack]
        reasons.append(f"new number {max(0.0, lost_gap):.0f} s after the first was lost")
    elif gap < 0:
        reasons.append("both tracked at the same time on different cameras")
    else:
        reasons.append(f"second track_id started {gap:.0f} s after the first was last seen")
    return {
        "visit_keep": va.visit_id, "visit_dup": vb.visit_id,
        "track_keep": va.track_id, "track_dup": vb.track_id,
        "camera_keep": cam_keep or "", "camera_dup": cam_dup or "",
        "kind": kind, "score": score, "floor_apart": "" if apart is None else apart,
        "reason": "; ".join(reasons),
        "seen_keep": _iso(va.created_at), "seen_dup": _iso(vb.created_at),
        "look_ok": look_ok,
    }
