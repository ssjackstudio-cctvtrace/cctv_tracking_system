"""Who is this person? Recognise people by their FACE, their ATTIRE (colour of
the upper and lower clothes) and their WHOLE BODY (body re-identification
model + body height), so the same person keeps ONE track_id on all cameras,
and a different person never takes someone else's track_id.

A Look is a few numbers about one person (nothing else is kept: no picture
is saved or sent):
  - face:   128 numbers from the face recognition model (OpenCV SFace), when
            the face is visible. The strongest evidence.
  - body:   768 numbers from the person re-identification model (OpenCV Zoo
            YoutuReID), whole body from head to feet, also from the side / back.
  - attire: colour histogram of the upper and lower body clothes.
  - height: body height in metres (cameras with a 3D floor).

compare(a, b) says how alike two looks are: 0 = surely the same person,
1 = nothing alike, None = CLEARLY a different person (other face, other body,
other clothes or other height). One clear "different" is enough to refuse a
match, so look-alike clothes alone never join two different people.

Models (optional, each one adds evidence; run `python download_models.py`):
  models/face_detection_yunet_2023mar.onnx     face finder (also used for gender / age)
  models/face_recognition_sface_2021dec.onnx   face recognition
  models/person_reid_youtu_2021nov.onnx        whole-body re-identification
Without them, attire + height are used (as before).
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field

import cv2
import numpy as np

log = logging.getLogger("reid")

EDGE_DIR = os.path.join(os.path.dirname(__file__), "..")

# 0 = identical look, 1 = nothing alike. Below this = the same person.
MAX_DISTANCE = float(os.getenv("REID_MAX_DISTANCE", "0.45"))
# Face (cosine similarity of SFace features; OpenCV's recommended "same person" value is 0.363)
FACE_SAME = float(os.getenv("REID_FACE_SAME", "0.363"))
FACE_DIFFERENT = float(os.getenv("REID_FACE_DIFFERENT", "0.20"))  # below this: another person
# Whole body (cosine similarity of the re-identification features)
BODY_SAME = float(os.getenv("REID_BODY_SAME", "0.60"))
BODY_DIFFERENT = float(os.getenv("REID_BODY_DIFFERENT", "0.35"))
# Attire (Bhattacharyya distance of the clothes colours, 0-1): above this the clothes are clearly different
ATTIRE_DIFFERENT = float(os.getenv("REID_ATTIRE_DIFFERENT", "0.70"))
# Body height (metres): more apart than this = another person
HEIGHT_DIFFERENT = float(os.getenv("REID_HEIGHT_DIFFERENT", "0.15"))
# How much each kind of evidence counts
WEIGHTS = {"face": 3.0, "body": 2.0, "attire": 1.0, "height": 0.5}
# ACROSS two different cameras (other angle, other light, other white balance, legs
# hidden by a different table) the same person's clothes colours and measured height
# differ a lot: in a real case the same man scored attire 0.69-0.70 (veto at 0.70) and
# 1.38 m vs 1.60 m tall on two cameras, and got a NEW track_id on the second camera.
# So across cameras: clothes colours and height never veto ("clearly someone else"),
# clothes count less, height (each camera's own 3D calibration) is not compared, and
# the whole-body model only vetoes when it is very sure (side vs back view lowers it).
# Face stays as strong as on one camera. On ONE camera the strict rules above stay.
CROSS_WEIGHTS = {"face": 3.0, "body": 2.0, "attire": 0.6, "height": 0.0}
BODY_DIFFERENT_CROSS = float(os.getenv("REID_BODY_DIFFERENT_CROSS", "0.25"))

H_BINS, S_BINS = 16, 8
FACE_MIN_PIXELS = 36  # smaller faces are too blurry to recognise
BODY_SIZE = (128, 256)  # width, height of the re-identification model input
BODY_MEAN, BODY_STD = np.array([0.485, 0.456, 0.406]), np.array([0.229, 0.224, 0.225])
KEEP = 9  # running averages weigh the newest look like 1 / (KEEP + 1)


def _path(env: str, default: str) -> str:
    p = os.getenv(env, default)
    return p if os.path.isabs(p) else os.path.normpath(os.path.join(EDGE_DIR, p))


def _unit(v: np.ndarray) -> np.ndarray:
    v = np.asarray(v, dtype=np.float32).flatten()
    n = float(np.linalg.norm(v))
    return v / n if n > 1e-9 else v


# ---------- attire (clothes colours) ----------
# The same shirt looks a different colour on each camera: warm shop spotlights on
# one side, cold mall light or the glass front on the other, and every camera
# sets its own white balance. Without a correction the clothes "look different"
# and the person gets a NEW track_id on the next camera. Gray-world colour
# balance: each person crop is scaled so its average colour is grey, which
# removes most of the light / camera colour cast before the colours are compared.
EVEN_LIGHT = os.getenv("REID_EVEN_LIGHT", "on").strip().lower() not in ("off", "0", "false", "no")
# How strongly the colour cast is removed (0 = not at all, 1 = full gray-world). Full
# gray-world also greys out a strongly coloured shirt (it takes the shirt's own colour
# for a colour cast): a yellow shirt matched WORSE with it (0.75) than without (0.62).
# Half strength removes most of the light's cast and keeps the clothes' colour.
EVEN_LIGHT_STRENGTH = min(1.0, max(0.0, float(os.getenv("REID_EVEN_LIGHT_STRENGTH", "0.5"))))


def _even_light(crop: np.ndarray) -> np.ndarray:
    """Gray-world white balance of one person crop (BGR)."""
    if not EVEN_LIGHT or crop.size == 0:
        return crop
    px = crop.reshape(-1, 3).astype(np.float32)
    lum = px.mean(axis=1)
    keep = px[(lum > 25) & (lum < 235)]  # very dark / blown-out pixels carry no colour
    if len(keep) < 50:
        return crop
    means = keep.mean(axis=0)
    gain = np.clip(means.mean() / np.maximum(means, 1.0), 0.6, 1.6) ** EVEN_LIGHT_STRENGTH
    return np.clip(crop.astype(np.float32) * gain, 0, 255).astype(np.uint8)


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
    x1, x2 = x1 + bw // 8, x2 - bw // 8  # trim the sides (background) a little
    person = _even_light(frame[y1:y2, x1:x2])
    parts = []
    for top, bottom in ((0.18, 0.55), (0.55, 0.92)):  # upper body, lower body
        crop = person[int(bh * top): int(bh * bottom)]
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


def attire_distance(a: np.ndarray, b: np.ndarray) -> float:
    """0 = same clothes colours, 1 = nothing alike (average of upper / lower body)."""
    n = H_BINS * S_BINS
    d = [cv2.compareHist(a[i:i + n], b[i:i + n], cv2.HISTCMP_BHATTACHARYYA) for i in (0, n)]
    return float(sum(d) / 2)


# ---------- attire style (named colour of the top and of the pants) ----------
# The colour histogram above is averaged over top + pants, so an orange top with black
# pants and a black-and-white outfit could still come out "45% alike". Here each part
# (top, pants) gets the share of its pixels in a few NAMED colours. Two looks whose top
# OR pants are clearly another colour (e.g. orange top vs black top) are another
# person: never the same track_id, never a "Suspicious same person" pair.
COLOUR_NAMES = ("black", "grey", "white", "red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink")
N_COLOURS = len(COLOUR_NAMES)
_HUES = ("red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink")  # around the colour wheel
# Neighbour colours look alike under other light / white balance: not "clearly different"
_NEAR = {frozenset(p) for p in (("black", "grey"), ("grey", "white"))} | \
    {frozenset((_HUES[i], _HUES[(i + 1) % len(_HUES)])) for i in range(len(_HUES))}
# A part's main colour must cover at least this share of it to count
COLOUR_MAIN_SHARE = float(os.getenv("REID_COLOUR_MAIN_SHARE", "0.40"))
# ... and the two parts may share at most this much colour (0-1) to be "clearly different":
# same camera (same light) / two cameras (other light: a little more tolerant)
COLOUR_OVERLAP_SAME = float(os.getenv("REID_COLOUR_OVERLAP", "0.30"))
COLOUR_OVERLAP_CROSS = float(os.getenv("REID_COLOUR_OVERLAP_CROSS", "0.20"))
ATTIRE_STYLE_CHECK = os.getenv("REID_ATTIRE_STYLE", "on").strip().lower() not in ("off", "0", "false", "no")


def _colour_shares(crop: np.ndarray) -> np.ndarray | None:
    """Share of the crop's pixels in each of COLOUR_NAMES."""
    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV).reshape(-1, 3).astype(np.int16)
    if len(hsv) < 50:
        return None
    h, s, v = hsv[:, 0], hsv[:, 1], hsv[:, 2]
    dark = v < 50
    pale = (~dark) & (s < 45)
    hue = (~dark) & (~pale)
    out = np.zeros(N_COLOURS, dtype=np.float32)
    out[0] = dark.sum()
    out[1] = (pale & (v <= 175)).sum()
    out[2] = (pale & (v > 175)).sum()
    hh = h[hue]
    for name, lo, hi in (("red", 0, 8), ("orange", 8, 20), ("yellow", 20, 35), ("green", 35, 85),
                         ("cyan", 85, 100), ("blue", 100, 130), ("purple", 130, 150), ("pink", 150, 165),
                         ("red", 165, 181)):
        out[COLOUR_NAMES.index(name)] += ((hh >= lo) & (hh < hi)).sum()
    total = out.sum()
    return out / total if total > 0 else None


def attire_colours(frame: np.ndarray, box: tuple[float, float, float, float]) -> np.ndarray | None:
    """Named colour shares of the top (upper body) and the pants (lower body), one after the other."""
    h, w = frame.shape[:2]
    x1, y1, x2, y2 = (int(v) for v in box)
    x1, x2 = max(0, x1), min(w, x2)
    y1, y2 = max(0, y1), min(h, y2)
    bh, bw = y2 - y1, x2 - x1
    if bh < 40 or bw < 16:
        return None
    x1, x2 = x1 + bw // 6, x2 - bw // 6  # the middle of the body: less background
    person = _even_light(frame[y1:y2, x1:x2])
    parts = []
    for top, bottom in ((0.20, 0.50), (0.60, 0.90)):  # top, pants (a gap at the belt)
        crop = person[int(bh * top): int(bh * bottom)]
        if crop.size == 0:
            return None
        shares = _colour_shares(crop)
        if shares is None:
            return None
        parts.append(shares)
    return np.concatenate(parts).astype(np.float32)


def _part_clash(a: np.ndarray, b: np.ndarray, overlap_max: float) -> bool:
    ia, ib = int(np.argmax(a)), int(np.argmax(b))
    if a[ia] < COLOUR_MAIN_SHARE or b[ib] < COLOUR_MAIN_SHARE:
        return False  # mixed / patterned colours: not sure enough to say "other clothes"
    if ia == ib or frozenset((COLOUR_NAMES[ia], COLOUR_NAMES[ib])) in _NEAR:
        return False
    return float(np.minimum(a, b).sum()) <= overlap_max  # little colour in common


def attire_clash(a: np.ndarray | None, b: np.ndarray | None, cross: bool = False) -> bool:
    """True when the top OR the pants are clearly another colour: another attire
    style, so another person. cross=True: the two looks come from different cameras."""
    if not ATTIRE_STYLE_CHECK or a is None or b is None:
        return False
    overlap = COLOUR_OVERLAP_CROSS if cross else COLOUR_OVERLAP_SAME
    return any(_part_clash(a[i:i + N_COLOURS], b[i:i + N_COLOURS], overlap) for i in (0, N_COLOURS))


def describe_colours(c: np.ndarray | None) -> str:
    """e.g. 'orange top, black pants' (for the log / reasons)."""
    if c is None:
        return "unknown clothes"
    top, pants = c[:N_COLOURS], c[N_COLOURS:]
    return f"{COLOUR_NAMES[int(np.argmax(top))]} top, {COLOUR_NAMES[int(np.argmax(pants))]} pants"


# ---------- one person's look ----------
@dataclass
class Look:
    attire: np.ndarray | None = None
    face: np.ndarray | None = None  # unit vector
    body: np.ndarray | None = None  # unit vector
    height: float | None = None
    colours: np.ndarray | None = None  # named colours of the top and the pants (attire_colours)
    counts: dict = field(default_factory=lambda: {"attire": 0, "face": 0, "body": 0, "height": 0, "colours": 0})

    @property
    def empty(self) -> bool:
        return self.attire is None and self.face is None and self.body is None and self.height is None

    def add(self, other: "Look | None") -> None:
        """Running average with another look at the same person (other frames, other cameras)."""
        if other is None:
            return
        for name in ("attire", "face", "body", "colours"):
            new = getattr(other, name)
            if new is None:
                continue
            cur, n = getattr(self, name), self.counts.get(name, 0)
            if cur is None:
                val = new.copy()
            else:
                k = min(n, KEEP)
                val = (cur * k + new) / (k + 1)
            setattr(self, name, _unit(val) if name in ("face", "body") else val.astype(np.float32))
            self.counts[name] = n + max(1, other.counts.get(name, 1))
        if other.height is not None:
            n = self.counts["height"]
            self.height = other.height if self.height is None else (self.height * min(n, KEEP) + other.height) / (min(n, KEEP) + 1)
            self.counts["height"] = n + 1

    def copy(self) -> "Look":
        c = Look(counts=dict(self.counts), height=self.height)
        for name in ("attire", "face", "body", "colours"):
            v = getattr(self, name)
            setattr(c, name, None if v is None else v.copy())
        return c


def comparable(a: Look | None, b: Look | None, cross: bool = False) -> bool:
    """Both looks have at least one kind of evidence in common (across cameras
    the height does not count: each camera measures it with its own calibration)."""
    if a is None or b is None:
        return False
    kinds = ("attire", "face", "body") if cross else ("attire", "face", "body", "height")
    return any(getattr(a, n) is not None and getattr(b, n) is not None for n in kinds)


def same_face(a: Look | None, b: Look | None) -> bool:
    """True when both looks have a face and it is SURELY the same face (the
    strongest evidence: it may overrule small differences elsewhere)."""
    if a is None or b is None or a.face is None or b.face is None:
        return False
    return float(a.face @ b.face) >= FACE_SAME + 0.1


def compare(a: Look | None, b: Look | None, cross: bool = False) -> float | None:
    """0 = surely the same person, 1 = nothing alike, None = clearly a
    different person (or nothing to compare).
    cross=True: the two looks come from DIFFERENT cameras (see CROSS_WEIGHTS):
    only the face, or a very sure whole-body model, can say "someone else"."""
    if not comparable(a, b, cross):
        return None
    weights = CROSS_WEIGHTS if cross else WEIGHTS
    body_different = BODY_DIFFERENT_CROSS if cross else BODY_DIFFERENT
    parts: list[tuple[float, float]] = []  # (distance 0-1, weight)
    face_sure = False
    if a.face is not None and b.face is not None:
        s = float(a.face @ b.face)
        if s < FACE_DIFFERENT:
            return None  # another face
        face_sure = s >= FACE_SAME + 0.1
        # FACE_SAME lands on MAX_DISTANCE, identical faces on 0
        parts.append((min(1.0, MAX_DISTANCE * (1 - s) / max(1 - FACE_SAME, 1e-6)), weights["face"]))
    body_sure = False
    if a.body is not None and b.body is not None:
        s = float(a.body @ b.body)
        if s < body_different and not face_sure:
            return None  # another body
        body_sure = s >= BODY_SAME
        parts.append((min(1.0, MAX_DISTANCE * (1 - s) / max(1 - BODY_SAME, 1e-6)), weights["body"]))
    # Another attire style (top or pants clearly another colour): another person, unless
    # the face is surely the same (e.g. put a jacket on)
    if not face_sure and attire_clash(a.colours, b.colours, cross):
        return None
    if a.attire is not None and b.attire is not None:
        d = attire_distance(a.attire, b.attire)
        # Clothes colours alone never veto when the face or the whole-body model says
        # "same person": colours change with the light and the camera angle
        if d > ATTIRE_DIFFERENT and not face_sure and not body_sure and not cross:
            return None  # other clothes (same camera, same light: a real difference)
        parts.append((d, weights["attire"]))
    if a.height is not None and b.height is not None and not cross:
        dh = abs(a.height - b.height)
        if dh > HEIGHT_DIFFERENT and not face_sure:
            return None  # other height
        parts.append((MAX_DISTANCE * dh / max(HEIGHT_DIFFERENT, 1e-6), weights["height"]))
    if face_sure:  # the same face for sure: the rest only fine-tunes
        return min(d for d, _ in parts) * 0.5
    total = sum(w for _, w in parts)
    return sum(d * w for d, w in parts) / total if total else None


# ---------- models ----------
class Recognizer:
    """Makes a Look from a person box. One per camera thread (OpenCV networks
    must not be shared between threads)."""

    def __init__(self) -> None:
        self.enabled = os.getenv("REID", "on").lower() not in ("off", "0", "false", "no")
        self.detector = self.face_net = self.body_net = None
        if not self.enabled:
            return
        det = _path("FACE_MODEL", "models/face_detection_yunet_2023mar.onnx")
        rec = _path("FACE_REID_MODEL", "models/face_recognition_sface_2021dec.onnx")
        body = _path("BODY_REID_MODEL", "models/person_reid_youtu_2021nov.onnx")
        try:
            if os.path.isfile(det) and os.path.isfile(rec):
                self.detector = cv2.FaceDetectorYN.create(det, "", (320, 320), 0.8)
                self.face_net = cv2.FaceRecognizerSF.create(rec, "")
            else:
                log.info("Face recognition off (model missing: %s). Run: python download_models.py", rec)
        except (cv2.error, AttributeError) as exc:
            log.warning("Face recognition could not start: %s", exc)
            self.detector = self.face_net = None
        try:
            if os.path.isfile(body):
                self.body_net = cv2.dnn.readNetFromONNX(body)
            else:
                log.info("Whole-body recognition off (model missing: %s). Run: python download_models.py", body)
        except cv2.error as exc:
            log.warning("Whole-body recognition could not start: %s", exc)

    def look(self, frame: np.ndarray, box: tuple[float, float, float, float], height: float | None = None,
             heavy: bool = True) -> Look:
        """Attire always (cheap); face and whole body only when heavy=True (a
        few people per frame, so counting stays smooth on the edge box)."""
        look = Look(attire=appearance(frame, box), height=height, colours=attire_colours(frame, box))
        for name in ("attire", "height", "colours"):
            look.counts[name] = 1 if getattr(look, name) is not None else 0
        if not heavy or not self.enabled:
            return look
        face = self._face(frame, box)
        if face is not None:
            look.face, look.counts["face"] = face, 1
        body = self._body(frame, box)
        if body is not None:
            look.body, look.counts["body"] = body, 1
        return look

    def _face(self, frame: np.ndarray, box) -> np.ndarray | None:
        if self.face_net is None:
            return None
        h, w = frame.shape[:2]
        x1, y1, x2, y2 = (int(v) for v in box)
        top = frame[max(0, y1):min(h, y1 + int((y2 - y1) * 0.45) + 1), max(0, x1):min(w, x2)]
        if top.shape[0] < FACE_MIN_PIXELS or top.shape[1] < FACE_MIN_PIXELS:
            return None
        try:
            self.detector.setInputSize((top.shape[1], top.shape[0]))
            _, faces = self.detector.detect(top)
            if faces is None or len(faces) == 0:
                return None
            f = faces[int(np.argmax(faces[:, 2] * faces[:, 3]))]
            if min(f[2], f[3]) < FACE_MIN_PIXELS:
                return None
            aligned = self.face_net.alignCrop(top, f)
            return _unit(self.face_net.feature(aligned))
        except cv2.error:
            return None

    def _body(self, frame: np.ndarray, box) -> np.ndarray | None:
        if self.body_net is None:
            return None
        h, w = frame.shape[:2]
        x1, y1, x2, y2 = (int(v) for v in box)
        crop = frame[max(0, y1):min(h, y2), max(0, x1):min(w, x2)]
        if crop.shape[0] < 64 or crop.shape[1] < 24:
            return None
        try:
            rgb = cv2.cvtColor(cv2.resize(crop, BODY_SIZE), cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
            blob = ((rgb - BODY_MEAN) / BODY_STD).transpose(2, 0, 1)[None].astype(np.float32)
            self.body_net.setInput(blob)
            return _unit(self.body_net.forward())
        except cv2.error:
            return None
