"""Staff remembered for the whole operating day, also across a RESTART of the edge box.

Before, everything the box knew about today's staff lived in memory only. After a
restart (update, power cut, sudo systemctl restart cctv-edge) the box had forgotten:
  - which visitors are staff (their track_id = staff_no for the day),
  - how each staff looks TODAY on each camera (clothes, body, face),
  - the live body samples learnt while the staff walked around (other angles),
so staff were not recognised again for a long time, and with nobody "taken" a customer
in similar clothes could win the votes for a staff (one staff = one person only works
when the box knows where that staff is).

Now:
  1. save()  every STAFF_SAVE_SECONDS and when the box stops: today's staff visitors
     (visit_id, track_id, staff_id / staff_no, looks per camera, height, where) and the
     live body samples of the recognised staff go to edge/state/staff-YYYY-MM-DD.json
     (numbers only, no picture; PDPA: the file of an older day is deleted).
  2. load()  at start: the same day's file is read back. The staff are remembered as
     "not seen right now" (hidden): a staff seen again is given back the SAME track_id
     (by their look, or by body recognition: biometrics joins the new track_id to it),
     and a customer whose look is clearly different from that staff's look today can
     never become that staff.
  3. sync_db()  at start and every minute: today's visits that are Staff in Supabase
     (recognised before the restart, or marked "Is Staff" by an admin on the Camera
     page) are remembered as staff too, even without a saved look.
"""

from __future__ import annotations

import json
import logging
import os
import time
from datetime import datetime, timedelta, timezone
from typing import Any

import numpy as np

from .reid import Look
from .visitors import Visitor, VisitorRegistry

log = logging.getLogger("staff-memory")

MYT = timezone(timedelta(hours=float(os.getenv("SHOP_UTC_OFFSET", "8"))))
STATE_DIR = os.path.normpath(os.getenv("STATE_DIR") or os.path.join(os.path.dirname(__file__), "..", "state"))
SAVE_SECONDS = float(os.getenv("STAFF_SAVE_SECONDS", "30"))
_VECTORS = ("attire", "face", "body", "colours", "texture")


def today() -> str:
    return datetime.now(MYT).date().isoformat()


def _look_out(look: Look | None) -> dict | None:
    if look is None or look.empty:
        return None
    d: dict[str, Any] = {"height": look.height, "counts": dict(look.counts)}
    for n in _VECTORS:
        v = getattr(look, n)
        d[n] = None if v is None else [round(float(x), 5) for x in np.asarray(v).ravel()]
    return d


def _look_in(d: dict | None) -> Look | None:
    if not isinstance(d, dict):
        return None
    lk = Look(height=d.get("height"), counts={**Look().counts, **(d.get("counts") or {})})
    for n in _VECTORS:
        if d.get(n) is not None:
            setattr(lk, n, np.asarray(d[n], dtype=np.float32))
    return None if lk.empty else lk


class StaffMemory:
    def __init__(self, registry: VisitorRegistry, body_matcher: Any = None, supa: Any = None,
                 branch_id: str | None = None):
        self.registry, self.body_matcher, self.supa, self.branch_id = registry, body_matcher, supa, branch_id
        self._warned = ""
        os.makedirs(STATE_DIR, exist_ok=True)

    def _path(self, day: str) -> str:
        return os.path.join(STATE_DIR, f"staff-{day}.json")

    # ---------- 1. save ----------
    def save(self) -> None:
        day = today()
        reg = self.registry
        with reg._lock:
            staff = [v for v in reg._inside.values() if v.staff and not v.left]
            people = [{
                "visit_id": v.visit_id, "track_id": v.track_id, "staff_id": v.staff_id, "staff_no": v.staff_no,
                "staff_how": v.staff_how, "guest_track_id": v.guest_track_id, "first_camera": v.first_camera,
                "ever_in": v.ever_in, "outside": v.outside, "height": v.height,
                "last_seen": v.last_any, "floor": list(v.floor) if v.floor else None,
                "look": _look_out(v.look), "looks": {c: _look_out(lk) for c, lk in v.looks.items()},
            } for v in staff]
        live = {}
        bm = self.body_matcher
        if bm is not None:
            with bm._lock:
                for (kind, pid), parts in bm._live.items():
                    if kind == "Staff" and parts:
                        live[pid] = {part: [[m, [round(float(x), 5) for x in vec]] for m, vec in samples]
                                     for part, samples in parts.items()}
        tmp = self._path(day) + ".tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump({"day": day, "saved_at": time.time(), "staff": people, "live": live}, f)
            os.replace(tmp, self._path(day))
            os.chmod(self._path(day), 0o600)
        except OSError as exc:
            log.warning("Could not save today's staff: %s", exc)
        for name in os.listdir(STATE_DIR):  # older days: deleted (PDPA)
            if name.startswith("staff-") and name.endswith(".json") and name != f"staff-{day}.json":
                try:
                    os.remove(os.path.join(STATE_DIR, name))
                except OSError:
                    pass

    # ---------- 2. load ----------
    def load(self) -> int:
        path = self._path(today())
        if not os.path.isfile(path):
            return 0
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError) as exc:
            log.warning("Could not read %s: %s", path, exc)
            return 0
        n = 0
        with self.registry._lock:
            for s in data.get("staff") or []:
                if s.get("visit_id") in self.registry._inside:
                    continue
                v = Visitor(visit_id=s["visit_id"], track_id=s.get("track_id") or "", first_camera=s.get("first_camera") or "")
                v.staff, v.staff_id, v.staff_no = True, s.get("staff_id"), s.get("staff_no")
                v.staff_how, v.guest_track_id = s.get("staff_how") or "Saved", s.get("guest_track_id")
                v.ever_in, v.outside, v.height = bool(s.get("ever_in")), bool(s.get("outside")), s.get("height")
                v.last_seen = float(s.get("last_seen") or time.time())
                v.created_at = v.last_seen
                if s.get("floor"):
                    v.floor, v.floor_at = tuple(s["floor"]), v.last_seen
                lk = _look_in(s.get("look"))
                if lk is not None:
                    v.look = lk
                for c, d in (s.get("looks") or {}).items():
                    lk = _look_in(d)
                    if lk is not None:
                        v.looks[c] = lk
                self.registry._inside[v.visit_id] = v
                n += 1
        bm = self.body_matcher
        if bm is not None:
            with bm._lock:
                for pid, parts in (data.get("live") or {}).items():
                    bm._live[("Staff", pid)] = {part: [(m, np.asarray(vec, dtype=np.float32)) for m, vec in samples]
                                               for part, samples in parts.items()}
                for v in self.registry._inside.values():
                    if v.staff:  # recognised already: body recognition keeps learning, no new votes
                        bm._visits[v.visit_id] = {"votes": {}, "best": {}, "done": ("Staff", v.staff_id or "")}
        if n:
            log.info("Remembered %d staff from before the restart (%s): %s", n, os.path.basename(path),
                     ", ".join(v.track_id for v in self.registry._inside.values() if v.staff))
        return n

    # ---------- 3. Supabase: today's Staff visits ----------
    def sync_db(self) -> None:
        if self.supa is None or not self.branch_id:
            return
        midnight = datetime.now(MYT).replace(hour=0, minute=0, second=0, microsecond=0)
        try:
            rows = self.supa.select(
                "visit", "visit_id,track_id,staff_id,cctv_event!inner(event_time)",
                visit_type="eq.Staff", branch_id=f"eq.{self.branch_id}",
                **{"cctv_event.event_time": f"gte.{midnight.isoformat()}", "cctv_event.limit": "1", "limit": "500"})
            self._warned = ""
        except Exception as exc:  # internet down: next minute
            if str(exc) != self._warned:
                log.warning("Today's staff visits not read: %s", exc)
                self._warned = str(exc)
            return
        added = marked = 0
        reg = self.registry
        with reg._lock:
            by_track = {v.track_id: v for v in reg._inside.values() if v.staff and not v.left}
            for r in rows:
                v = reg._inside.get(r["visit_id"])
                if v is not None:
                    if not v.staff:  # an admin pressed "Is Staff" on the Camera page
                        v.guest_track_id, v.staff, v.staff_how = v.track_id, True, "Admin"
                        v.staff_id, v.staff_no = r.get("staff_id"), r.get("track_id")
                        v.track_id = r.get("track_id") or v.track_id
                        marked += 1
                    continue
                if r.get("track_id") in by_track:
                    continue  # this staff is remembered already (one visitor per staff track_id)
                v = Visitor(visit_id=r["visit_id"], track_id=r.get("track_id") or "")
                v.staff, v.staff_id, v.staff_no, v.staff_how = True, r.get("staff_id"), r.get("track_id"), "Saved"
                v.ever_in, v.outside = True, True
                v.last_seen = v.created_at = time.time() - 3600  # not seen right now
                reg._inside[v.visit_id] = v
                by_track[v.track_id] = v
                added += 1
        if added or marked:
            log.info("Staff from Supabase today: %d remembered again, %d marked by an admin", added, marked)
