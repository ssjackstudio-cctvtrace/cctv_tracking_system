"""Recognise STAFF (and members) by their BODY, from any angle: 360°.

The cameras hang high up and mostly see the top of people's heads, so the face
is rarely clear enough to recognise. Instead each person is learnt from the
photos uploaded on the website (Staff Details → PDPA consent → biometric
photos, table biometric_photo): the website keeps only the person (background
blacked out) and works out the direction they face, body_view_angle in degrees,
turning from the front to their left side:

      0° (= 360°) Front    90° Left side    180° Back    270° Right side

and which body PARTS are in the photo: Head, Upper body, Lower body, Feet.

1. Enroller (thread): photos with enrol_status = Pending are downloaded from
   the private bucket biometric-photos. Each part in the photo becomes one
   body_template row (914 numbers, no picture) with the photo's angle. The
   person is the photo's (body_template → biometric_photo → staff / member).
2. BodyMatcher (thread): keeps the body_template numbers of every Active staff
   / member with PDPA consent in memory (reloaded every BODY_RELOAD_SECONDS).
3. Camera threads: for a person with a track_id who is not recognised yet, a
   few times a second (BODY_EVERY_SECONDS), each visible part of their box is
   turned into the same 914 numbers and compared with that part from ALL angles
   of every person. Which parts are used depends on the POSTURE (box shape):
     standing / walking          head, upper body, lower body, feet
     sitting, crouching, carrying luggage / things (wider box)
                                 head, upper body (the rest is hidden or mixed
                                 with the chair, the desk, the luggage)
     lying down (desk-napping, sleeping: box wider than tall)
                                 not compared (kept by tracking only)
   When the same person wins BODY_VOTES times (clearly ahead of anyone else),
   the visit becomes a Staff (or Member) visit, a STAFF's visit gets the staff's
   staff_no as its track_id (supabase/body_view_angle_staff_track.sql), and a
   recognition_event row is written: body_template_id = the best matching
   template, body_view_angle = its angle, matched_parts = parts that matched.
4. Movement (360° while tracked): once recognised, the person keeps being
   sampled (BODY_LEARN_SECONDS) while ANY camera follows them, until they leave
   every camera's picture. These live samples (turning 0° → 90° → 180° → 270°,
   sitting, crouching, carrying things) are added to that person's numbers for
   the day (BODY_LIVE_SAMPLES per part), so the other cameras recognise them
   again from sides and poses the photos never showed. A sample is only kept
   when it still looks like that person (no drift onto someone else).

The 914 numbers of one part = body re-identification model on the part (768,
OpenCV Zoo YoutuReID; zeros when the model is missing) + clothes / skin / hair
colours (hue-saturation histogram, 128; black / very dark pixels ignored, so the
blacked-out background of the photos does not count) + texture (18).

The thresholds below are starting values: check the log ("Body match ...",
BODY_LOG=on) with your own staff and cameras, and tune them in edge/.env.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from datetime import date, datetime, timezone
from typing import Any, Callable

import cv2
import numpy as np

from .reid import BODY_MEAN, BODY_SIZE, BODY_STD, Recognizer, _even_light, _texture, _unit
from .supa import Supabase, SupabaseError

log = logging.getLogger("biometrics")

PARTS = ("Head", "Upper body", "Lower body", "Feet")

# Live: share of the person box height that each part takes
UPRIGHT_BANDS = {"Head": (0.00, 0.17), "Upper body": (0.15, 0.53), "Lower body": (0.50, 0.90), "Feet": (0.86, 1.00)}
BENT_BANDS = {"Head": (0.00, 0.24), "Upper body": (0.20, 0.62)}  # sitting / crouching / carrying
LIVE_TRIM = {"Head": 0.22, "Upper body": 0.08, "Lower body": 0.12, "Feet": 0.05}  # sides trimmed (background)
TEXTURE_SIZE = {"Head": (24, 24), "Upper body": (32, 40), "Lower body": (32, 48), "Feet": (32, 16)}
MIN_PART_PIXELS = 12
UPRIGHT_RATIO = float(os.getenv("BODY_UPRIGHT_RATIO", "1.7"))  # box height / width: standing or walking
LYING_RATIO = float(os.getenv("BODY_LYING_RATIO", "1.0"))  # below: lying down (not compared)

H_BINS, S_BINS = 16, 8
REID_DIM, COLOUR_DIM, TEXTURE_DIM = 768, H_BINS * S_BINS, 18
EMBED_DIM = REID_DIM + COLOUR_DIM + TEXTURE_DIM  # 914, body_template.embedding vector(914)
W_REID, W_COLOUR, W_TEXTURE = 0.75, 0.55, 0.35
PART_WEIGHTS = {"Head": 0.8, "Upper body": 1.5, "Lower body": 1.2, "Feet": 0.5}
MODEL_VERSION = "v1"


def _flag(name: str, default: str = "on") -> bool:
    return os.getenv(name, default).strip().lower() not in ("off", "0", "false", "no")


ENABLED = _flag("BODY_RECOGNITION")
BUCKET = os.getenv("BIOMETRIC_BUCKET", "biometric-photos")
PART_SAME = float(os.getenv("BODY_PART_SAME", "0.72"))  # one part counts as matching from this cosine
MATCH = float(os.getenv("BODY_MATCH", "0.75"))  # weighted average of the parts needed for a vote
MARGIN = float(os.getenv("BODY_MARGIN", "0.04"))  # the best person must beat the 2nd best by this much
MIN_PARTS = int(os.getenv("BODY_MIN_PARTS", "2"))  # parts that must match for a vote
VOTES = int(os.getenv("BODY_VOTES", "3"))  # votes for the same person before the visit is recognised
VOTE_SHARE = float(os.getenv("BODY_VOTE_SHARE", "0.6"))  # ... and at least this share of all votes
EVERY_SECONDS = float(os.getenv("BODY_EVERY_SECONDS", "1.0"))  # per tracked person, not recognised yet
LEARN_SECONDS = float(os.getenv("BODY_LEARN_SECONDS", "2.0"))  # per tracked person, recognised: live samples
PER_FRAME = int(os.getenv("BODY_PER_FRAME", "1"))  # people checked per frame and camera
LIVE_SAMPLES = int(os.getenv("BODY_LIVE_SAMPLES", "40"))  # live samples kept per person and part (0 = off)
LEARN_SAME = float(os.getenv("BODY_LEARN_SAME", "0.62"))  # a live sample must still look this alike to be kept
RELOAD_SECONDS = float(os.getenv("BODY_RELOAD_SECONDS", "120"))
ENROL_SECONDS = float(os.getenv("BODY_ENROL_SECONDS", "30"))
LOG_MATCHES = _flag("BODY_LOG", "off")


def posture(box: tuple[float, float, float, float]) -> str:
    """'upright' (standing, walking), 'bent' (sitting, crouching, carrying luggage
    or things: a wider box) or 'lying' (desk-napping, sleeping), from the box shape."""
    x1, y1, x2, y2 = box
    ratio = (y2 - y1) / max(x2 - x1, 1.0)
    if ratio >= UPRIGHT_RATIO:
        return "upright"
    return "bent" if ratio >= LYING_RATIO else "lying"


# ---------------------------------------------------------------- numbers of one part
class PartEncoder:
    """Turns a crop of one body part into EMBED_DIM numbers. One per thread
    (the OpenCV network must not be shared between threads)."""

    def __init__(self, body_net: Any | None) -> None:
        self.body_net = body_net

    @property
    def model_name(self) -> str:
        # Templates are only compared with live numbers made the same way
        reid = "youtu_reid_2021nov+" if self.body_net is not None else ""
        return f"{reid}hsv{COLOUR_DIM}+tex{TEXTURE_DIM}/{MODEL_VERSION}"

    def encode(self, crop: np.ndarray, part: str) -> np.ndarray | None:
        if crop is None or crop.shape[0] < MIN_PART_PIXELS or crop.shape[1] < MIN_PART_PIXELS:
            return None
        even = _even_light(crop)
        colour = self._colour(even)
        if colour is None:
            return None
        texture = np.sqrt(np.maximum(_texture(even, TEXTURE_SIZE[part]), 0))
        reid = self._reid(crop)
        vec = np.concatenate([W_REID * reid, W_COLOUR * _unit(colour), W_TEXTURE * _unit(texture)])
        return _unit(vec)

    def _reid(self, crop: np.ndarray) -> np.ndarray:
        if self.body_net is None:
            return np.zeros(REID_DIM, np.float32)
        # Letterbox to the model's 1:2 shape, so a short part (head, feet) is not stretched
        h, w = crop.shape[:2]
        tw, th = BODY_SIZE
        if h / w > th / tw:
            pad = int(round(h * tw / th)) - w
            crop = cv2.copyMakeBorder(crop, 0, 0, pad // 2, pad - pad // 2, cv2.BORDER_CONSTANT, value=(0, 0, 0))
        else:
            pad = int(round(w * th / tw)) - h
            crop = cv2.copyMakeBorder(crop, pad // 2, pad - pad // 2, 0, 0, cv2.BORDER_CONSTANT, value=(0, 0, 0))
        try:
            rgb = cv2.cvtColor(cv2.resize(crop, BODY_SIZE), cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
            blob = ((rgb - BODY_MEAN) / BODY_STD).transpose(2, 0, 1)[None].astype(np.float32)
            self.body_net.setInput(blob)
            out = _unit(self.body_net.forward())
            return out if out.size == REID_DIM else np.zeros(REID_DIM, np.float32)
        except cv2.error:
            return np.zeros(REID_DIM, np.float32)

    @staticmethod
    def _colour(crop: np.ndarray) -> np.ndarray | None:
        hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
        mask = cv2.inRange(hsv, (0, 0, 30), (180, 255, 245))  # black background / shadows / glare: no colour
        hist = cv2.calcHist([hsv], [0, 1], mask, [H_BINS, S_BINS], [0, 180, 0, 256]).flatten()
        total = float(hist.sum())
        if total <= 0:
            return None
        return np.sqrt(hist / total).astype(np.float32)  # Hellinger: cosine ~ Bhattacharyya similarity

    # ---- live camera: parts of a person box, by posture
    def live_features(self, frame: np.ndarray, box: tuple[float, float, float, float], full: bool,
                      head_cut: bool) -> dict[str, np.ndarray]:
        """Numbers of each part visible in a person box. Standing with the whole
        body seen: all 4 parts; sitting / crouching / carrying things, or legs
        hidden (full=False): head and upper body; lying down: nothing."""
        h, w = frame.shape[:2]
        x1, y1, x2, y2 = (int(v) for v in box)
        x1, x2, y1, y2 = max(0, x1), min(w, x2), max(0, y1), min(h, y2)
        bh, bw = y2 - y1, x2 - x1
        if bh < 48 or bw < 20:
            return {}
        pose = posture(box)
        if pose == "lying":
            return {}
        if pose == "upright" and full:
            bands = UPRIGHT_BANDS
        elif pose == "upright":
            bands = {k: UPRIGHT_BANDS[k] for k in ("Head", "Upper body")}
        else:
            bands = BENT_BANDS
        out = {}
        for part, (top, bottom) in bands.items():
            if part == "Head" and head_cut:
                continue
            t = int(bw * LIVE_TRIM[part])
            crop = frame[y1 + int(bh * top): y1 + int(bh * bottom), x1 + t: x2 - t]
            vec = self.encode(crop, part)
            if vec is not None:
                out[part] = vec
        return out

    # ---- enrolment photo: parts found by the website (part_boxes, 0-1)
    def photo_features(self, img: np.ndarray, parts: list[str], part_boxes: dict | None) -> dict[str, np.ndarray]:
        h, w = img.shape[:2]
        out = {}
        for part in parts:
            if part not in PARTS:
                continue
            b = (part_boxes or {}).get(part)
            if b and len(b) == 4:
                x1, y1, x2, y2 = int(b[0] * w), int(b[1] * h), int(b[2] * w), int(b[3] * h)
            else:  # no box: the part's band of the whole photo
                top, bottom = UPRIGHT_BANDS[part]
                x1, y1, x2, y2 = 0, int(top * h), w, int(bottom * h)
            crop = _trim_black(img[max(0, y1):min(h, y2), max(0, x1):min(w, x2)])
            vec = self.encode(crop, part)
            if vec is not None:
                out[part] = vec
        return out


def _trim_black(crop: np.ndarray) -> np.ndarray:
    """Cut away the blacked-out background around the person (website photos)."""
    if crop.size == 0:
        return crop
    lit = crop.max(axis=2) > 20
    rows, cols = np.where(lit.any(axis=1))[0], np.where(lit.any(axis=0))[0]
    if len(rows) < MIN_PART_PIXELS or len(cols) < MIN_PART_PIXELS:
        return crop
    return crop[rows[0]:rows[-1] + 1, cols[0]:cols[-1] + 1]


def _vector_text(v: np.ndarray) -> str:
    return "[" + ",".join(f"{x:.6f}" for x in v.tolist()) + "]"


def _parse_vector(text: Any) -> np.ndarray | None:
    try:
        if isinstance(text, str):
            v = np.array([float(x) for x in text.strip("[]").split(",")], dtype=np.float32)
        else:
            v = np.asarray(text, dtype=np.float32)
        return _unit(v) if v.size == EMBED_DIM else None
    except (ValueError, TypeError):
        return None


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------- 1. enrolment
class Enroller(threading.Thread):
    """Makes body_template rows from the Pending biometric photos."""

    def __init__(self, supa: Supabase, on_enrolled: Callable[[], None] | None = None) -> None:
        super().__init__(name="enroller", daemon=True)
        self.supa = supa
        self.on_enrolled = on_enrolled
        self.stop_event = threading.Event()
        self._warned = ""

    def run(self) -> None:
        encoder = PartEncoder(Recognizer().body_net)  # own model copy for this thread
        if encoder.body_net is None:
            log.warning("Body re-identification model missing: staff are learnt from colours and texture only "
                        "(less accurate). Run: python download_models.py")
        while not self.stop_event.is_set():
            try:
                if self.enrol_pending(encoder) and self.on_enrolled:
                    self.on_enrolled()
                self._warned = ""
            except Exception as exc:  # internet down, or the SQL not run yet
                if str(exc) != self._warned:
                    log.warning("Biometric photos not enrolled yet: %s", exc)
                    self._warned = str(exc)
            self.stop_event.wait(ENROL_SECONDS)

    def enrol_pending(self, encoder: PartEncoder) -> int:
        rows = self.supa.select(
            "biometric_photo", "biometric_photo_id,storage_path,body_view_angle,body_parts,part_boxes",
            enrol_status="eq.Pending", order="created_at.asc", limit="20",
        )
        done = 0
        for r in rows:
            pid = r["biometric_photo_id"]
            try:
                data = self.supa.download(BUCKET, r["storage_path"])
            except SupabaseError as exc:
                if exc.status in (400, 404):  # file deleted
                    self._fail(pid, "photo file not found in storage")
                    continue
                raise
            img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
            if img is None:
                self._fail(pid, "photo cannot be opened")
                continue
            feats = encoder.photo_features(img, r.get("body_parts") or [], r.get("part_boxes"))
            if not feats:
                self._fail(pid, "no usable body part in the photo")
                continue
            # Made again from scratch (e.g. a photo enrolled before with an older model)
            self.supa.delete("body_template", biometric_photo_id=f"eq.{pid}")
            self.supa.insert("body_template", [{
                "biometric_photo_id": pid,
                "body_view_angle": r["body_view_angle"],
                "body_part": part,
                "embedding": _vector_text(vec),
                "model_name": encoder.model_name,
            } for part, vec in feats.items()])
            self.supa.update("biometric_photo", {"enrol_status": "Enrolled", "enrol_note": None,
                                                 "enrolled_at": _now()},
                             biometric_photo_id=f"eq.{pid}")
            log.info("Biometric photo enrolled: %s° %s (%s)", r["body_view_angle"], ", ".join(feats),
                     r["storage_path"])
            done += 1
        return done

    def _fail(self, pid: str, note: str) -> None:
        log.warning("Biometric photo %s not usable: %s", pid, note)
        self.supa.update("biometric_photo", {"enrol_status": "Failed", "enrol_note": note},
                         biometric_photo_id=f"eq.{pid}")


# ---------------------------------------------------------------- 2. - 4. matching
class _Person:
    __slots__ = ("kind", "person_id", "number", "label", "parts", "live")

    def __init__(self, kind: str, person_id: str, number: str, label: str) -> None:
        self.kind, self.person_id, self.number, self.label = kind, person_id, number, label  # kind: Staff / Member
        # photo templates, per part → (template ids, angles, model names, matrix of unit vectors)
        self.parts: dict[str, tuple[list[str], list[int], list[str], np.ndarray]] = {}
        # live samples while tracked (movement, other angles / poses), per part → [(model name, vector)]
        self.live: dict[str, list[tuple[str, np.ndarray]]] = {}


class BodyMatcher(threading.Thread):
    """Body templates of the people who may be recognised, the votes per visit,
    and the live samples of recognised people."""

    def __init__(self, supa: Supabase, insert: Callable[..., None], update: Callable[..., None]) -> None:
        super().__init__(name="body-matcher", daemon=True)
        self.supa, self.insert, self.update = supa, insert, update
        self.stop_event = threading.Event()
        self.reload_now = threading.Event()
        self._lock = threading.Lock()
        self._people: list[_Person] = []
        self._vectors: dict[str, np.ndarray] = {}  # body_template_id → numbers (kept between reloads)
        self._live: dict[tuple[str, str], dict[str, list[tuple[str, np.ndarray]]]] = {}  # (kind, id) → live samples
        self._live_day = date.today()
        self._visits: dict[str, dict] = {}  # visit_id → {"votes": {key: [n, score sum]}, "best": {...}, "done": key|None}
        self._warned = ""

    @property
    def ready(self) -> bool:
        return bool(self._people)

    # ---- templates
    def run(self) -> None:
        while not self.stop_event.is_set():
            try:
                self.refresh()
                self._warned = ""
            except Exception as exc:
                if str(exc) != self._warned:
                    log.warning("Body templates not loaded: %s", exc)
                    self._warned = str(exc)
            self.reload_now.wait(RELOAD_SECONDS)
            self.reload_now.clear()

    def _select_all(self, table: str, columns: str, **filters: str) -> list[dict]:
        rows, offset = [], 0
        while True:
            page = self.supa.select(table, columns, limit="1000", offset=str(offset), **filters)
            rows += page
            if len(page) < 1000:
                return rows
            offset += 1000

    def refresh(self) -> None:
        # Only Active staff / members with PDPA consent (resigned staff never match)
        staff = {s["staff_id"]: s for s in self._select_all(
            "staff", "staff_id,staff_no,full_name,resigned_at", status="eq.Active", consent_pdpa="is.true")
            if not s.get("resigned_at")}
        members = {m["member_id"]: m for m in self._select_all(
            "member", "member_id,member_no,full_name", status="eq.Active", consent_pdpa="is.true")}
        # the person of a template comes from its photo
        rows = self._select_all(
            "body_template",
            "body_template_id,body_view_angle,body_part,model_name,biometric_photo!inner(staff_id,member_id)",
            order="body_template_id.asc")
        for r in rows:
            photo = r.pop("biometric_photo", None) or {}
            r["staff_id"], r["member_id"] = photo.get("staff_id"), photo.get("member_id")
        rows = [r for r in rows if (r.get("staff_id") in staff) or (r.get("member_id") in members)]
        wanted = {r["body_template_id"] for r in rows}
        missing = [i for i in wanted if i not in self._vectors]
        for i in range(0, len(missing), 100):  # numbers only for templates not loaded before
            chunk = missing[i:i + 100]
            for r in self.supa.select("body_template", "body_template_id,embedding",
                                      body_template_id=f"in.({','.join(chunk)})"):
                v = _parse_vector(r.get("embedding"))
                if v is not None:
                    self._vectors[r["body_template_id"]] = v
        for k in [k for k in self._vectors if k not in wanted]:  # deleted photos / no consent any more
            del self._vectors[k]

        people: dict[tuple[str, str], _Person] = {}
        grouped: dict[tuple[tuple[str, str], str], list[dict]] = {}
        for r in rows:
            if r["body_template_id"] not in self._vectors:
                continue
            if r.get("staff_id"):
                s = staff[r["staff_id"]]
                key = ("Staff", r["staff_id"])
                people.setdefault(key, _Person("Staff", r["staff_id"], s["staff_no"], f"{s['staff_no']} {s['full_name']}"))
            else:
                m = members[r["member_id"]]
                key = ("Member", r["member_id"])
                people.setdefault(key, _Person("Member", r["member_id"], m["member_no"], f"{m['member_no']} {m['full_name']}"))
            grouped.setdefault((key, r["body_part"]), []).append(r)
        for (key, part), rs in grouped.items():
            people[key].parts[part] = (
                [r["body_template_id"] for r in rs], [int(r["body_view_angle"]) for r in rs],
                [r["model_name"] for r in rs], np.stack([self._vectors[r["body_template_id"]] for r in rs]),
            )
        with self._lock:
            if date.today() != self._live_day:  # live samples are for one day (clothes change)
                self._live, self._live_day = {}, date.today()
            for key, p in people.items():
                p.live = self._live.setdefault(key, {})
            before = len(self._people)
            self._people = list(people.values())
        if len(self._people) != before:
            log.info("Body recognition: %d person(s), %d template(s) loaded", len(self._people), len(rows))

    # ---- one look at one person
    def _score(self, person: _Person, feats: dict[str, np.ndarray], model_name: str) -> dict | None:
        """How alike these part numbers are to a person: per part the best of their
        photo templates (any angle) and live samples (movement)."""
        total = weight = 0.0
        matched, best_sim, best_tpl, best_angle = [], -1.0, None, None
        for part, vec in feats.items():
            s_part = -1.0
            entry = person.parts.get(part)
            if entry is not None:
                ids, angles, models, mat = entry
                sims = mat @ vec
                for j, m in enumerate(models):  # numbers made another way are not comparable
                    if m != model_name:
                        sims[j] = -1.0
                j = int(np.argmax(sims))
                s_part = float(sims[j])
                if s_part > best_sim and s_part > -0.5:
                    best_sim, best_tpl, best_angle = s_part, ids[j], angles[j]
            for m, lv in person.live.get(part, ()):
                if m == model_name:
                    s_part = max(s_part, float(lv @ vec))
            if s_part < -0.5:
                continue
            total += PART_WEIGHTS[part] * s_part
            weight += PART_WEIGHTS[part]
            if s_part >= PART_SAME:
                matched.append(part)
        if weight <= 0:
            return None
        return {"person": person, "score": total / weight, "parts": matched, "template": best_tpl, "angle": best_angle}

    def best_match(self, feats: dict[str, np.ndarray], model_name: str) -> tuple[dict | None, float]:
        """Best person for these part numbers (any angle: 360°), and the 2nd best score."""
        with self._lock:
            people = self._people
        results = [r for r in (self._score(p, feats, model_name) for p in people) if r is not None]
        if not results:
            return None, 0.0
        results.sort(key=lambda r: r["score"], reverse=True)
        second = results[1]["score"] if len(results) > 1 else 0.0
        return results[0], second

    def known(self, visit_id: str) -> bool:
        st = self._visits.get(visit_id)
        return bool(st and st["done"])

    def observe(self, visitor: Any, camera_id: str, feats: dict[str, np.ndarray], model_name: str) -> None:
        """A look at a visitor not recognised yet: vote, and recognise when sure."""
        if not feats:
            return
        best, second = self.best_match(feats, model_name)
        if best is None:
            return
        p = best["person"]
        ok = best["score"] >= MATCH and best["score"] - second >= MARGIN and len(best["parts"]) >= MIN_PARTS
        if LOG_MATCHES:
            log.info("Body match %s → %s: %.2f (2nd %.2f), parts %s, angle %s%s", visitor.track_id, p.label,
                     best["score"], second, ",".join(best["parts"]) or "-", best["angle"], "" if ok else " (no vote)")
        if not ok:
            return
        key = (p.kind, p.person_id)
        with self._lock:
            st = self._visits.setdefault(visitor.visit_id, {"votes": {}, "best": {}, "done": None})
            if st["done"]:
                return
            n_sum = st["votes"].setdefault(key, [0, 0.0])
            n_sum[0] += 1
            n_sum[1] += best["score"]
            prev = st["best"].get(key)
            if prev is None or best["score"] > prev["score"]:
                st["best"][key] = {**best, "camera_id": camera_id}
            total = sum(n for n, _ in st["votes"].values())
            if n_sum[0] < VOTES or n_sum[0] < VOTE_SHARE * total:
                return
            st["done"] = key
            top = st["best"][key]
            score = n_sum[1] / n_sum[0]
        self._recognised(visitor, p, top, score)

    def learn(self, visitor: Any, feats: dict[str, np.ndarray], model_name: str) -> None:
        """A recognised visitor seen again (turning, sitting, crouching, carrying
        things, on another camera): keep these numbers as live samples of that
        person, when they still look like them."""
        if LIVE_SAMPLES <= 0 or not feats:
            return
        st = self._visits.get(visitor.visit_id)
        key = st["done"] if st else None
        if not key:
            return
        with self._lock:
            person = next((p for p in self._people if (p.kind, p.person_id) == key), None)
        if person is None:
            return
        mine = self._score(person, feats, model_name)
        best, _ = self.best_match(feats, model_name)
        # still this person (the tracker did not switch to someone else), and nobody fits better
        if mine is None or mine["score"] < LEARN_SAME or (best is not None and best["person"] is not person):
            return
        with self._lock:
            for part, vec in feats.items():
                samples = person.live.setdefault(part, [])
                samples.append((model_name, vec))
                del samples[:-LIVE_SAMPLES]

    def _recognised(self, visitor: Any, person: _Person, top: dict, score: float) -> None:
        if person.kind == "Staff":
            # the staff's staff_no is the track_id of every visit of this staff
            values = {"visit_type": "Staff", "staff_id": person.person_id, "member_id": None,
                      "track_id": person.number}
            visitor.track_id = person.number  # live video label and suspicious pairs use it from now on
        else:
            values = {"visit_type": "Member", "member_id": person.person_id, "staff_id": None}
        self.update("visit", values, camera_id=top["camera_id"], visit_id=f"eq.{visitor.visit_id}")
        self.insert("recognition_event", {
            "camera_id": top["camera_id"],
            "visit_id": visitor.visit_id,
            "match_score": round(min(1.0, max(0.0, score)) * 100, 2),
            "result": "Matched",
            "body_template_id": top["template"],
            "body_view_angle": top["angle"],
            "matched_parts": top["parts"],
            "event_time": _now(),
        })
        log.info("%s recognised as %s %s by body (%s°, %s, score %.0f%%)", visitor.track_id, person.kind,
                 person.label, top["angle"], ", ".join(top["parts"]), score * 100)

    def forget(self, visit_id: str) -> None:
        with self._lock:
            self._visits.pop(visit_id, None)
