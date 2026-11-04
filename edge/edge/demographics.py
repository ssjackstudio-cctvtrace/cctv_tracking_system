"""Estimated gender and age for each visitor (visit.est_gender,
visit.est_age, visit.demographic_score), from the WHOLE body.

Only people whose full body is in the picture (head to feet) are looked at.
Per look, up to three kinds of evidence are added to the visitor's running
average (shared by all cameras, so every camera that sees the person helps):
  1. Face (when visible): YuNet face detector + gender / age face models.
  2. Whole body (face, hands, upper body, lower body, feet): a pedestrian
     attribute model (PA-100K attributes: Female, AgeLess18, Age18-60,
     AgeOver60), so people seen from the side or from behind get an estimate
     too. Optional: BODY_MODEL in .env (see README → Gender / age).
  3. Body height in metres (cameras calibrated in "Areas (3D)"): a short body
     makes a child more likely, a tall body an adult.
  4. Face and hair (when the face is visible), measured around the face, so a
     male is not taken for a female (or the other way round) and a young person
     not taken for an old one (or the other way round):
       - beard / moustache: male, and not a child
       - long hair beside the face and below the chin: female (short hair: a
         little more likely male)
       - bald / shaved top of the head: male, and an adult
       - grey / white hair: older; dark full hair: unlikely over 60
     Each is averaged over the looks (HEAD_CUES=off in .env turns them off).
     Colour cues (grey / dark hair, bald) are skipped on black-and-white
     (night / IR) pictures.
Repeated on several frames and cameras while the person walks, and averaged.
A side-on face counts less than a face looking at the camera.

Only the numbers are kept. No face or body picture is saved or sent anywhere.

Models (run on the CPU with OpenCV, nothing extra to install). Get them with:
    python download_models.py
  - face_detection_yunet_2023mar.onnx   (OpenCV Zoo)
  - gender_googlenet.onnx, age_googlenet.onnx   (ONNX Model Zoo, Levi & Hassner)
The age model gives 8 age groups, so est_age is an estimate within a group,
not an exact age.

Whole-body model (optional): a PA-100K person attribute model exported to ONNX
(e.g. PaddleClas PULC "person_attribute", 26 outputs, input 3x256x192 RGB).
Put it at models/person_attribute_pa100k.onnx or set BODY_MODEL.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field

import cv2
import numpy as np

log = logging.getLogger("demographics")

EDGE_DIR = os.path.join(os.path.dirname(__file__), "..")

# Age groups of the age model, and the age used for each group
AGE_GROUPS = ["0-2", "4-6", "8-12", "15-20", "25-32", "38-43", "48-53", "60-100"]
AGE_MIDDLE = np.array([1, 5, 10, 17.5, 28.5, 40.5, 50.5, 70.0])
GENDERS = ["Male", "Female"]  # output order of the gender model
MODEL_MEAN = (78.4263377603, 87.7689143744, 114.895847746)  # BGR mean the models were trained with

FACE_MIN_SCORE = 0.80  # face detector confidence
FACE_MIN_PIXELS = 36  # smaller faces are too blurry to judge
FACE_MARGIN = 0.20  # extra border around the face, as a share of its size
GENDER_MIN_CONFIDENCE = 0.60  # below this (after averaging) → "Unknown"
SETTLED_GENDER = 0.75  # gender at least this sure and ...
SETTLED_AGE = 0.45  # ... age group at least this sure: enough looks (else up to 2x DEMOGRAPHIC_SAMPLES)

# Face and hair cues (HeadCues), measured around the face
HEAD_CUES = os.getenv("HEAD_CUES", "on").lower() not in ("off", "0", "false", "no")
CUE_MIN_PIXELS = 44  # face at least this big for hair cues
BEARD_MIN_PIXELS = 56  # ... and this big for a beard / moustache
CUE_MIN_WEIGHT = 1.5  # a cue counts once seen on about 2 clear looks
GRAY_SATURATION = 20  # picture around the face this grey (0-255) → black-and-white (night / IR)
SKIN_DISTANCE = 18  # Lab colour distance: this close to the cheeks → skin
HAIR_DISTANCE = 16  # Lab colour distance: this close to the hair on top → hair
CUE_KEYS = ("beard", "long_hair", "bald", "grey", "dark")
# Age groups:            0-2   4-6   8-12  15-20 25-32 38-43 48-53 60-100
GREY_PRIOR = np.array([0.02, 0.02, 0.03, 0.05, 0.15, 0.50, 1.00, 1.00])  # grey / white hair
DARK_PRIOR = np.array([1.00, 1.00, 1.00, 1.00, 1.00, 0.85, 0.55, 0.30])  # dark full hair
BALD_PRIOR = np.array([0.10, 0.10, 0.10, 0.25, 0.60, 1.00, 1.00, 1.00])  # bald / shaved top
BEARD_PRIOR = np.array([0.02, 0.02, 0.05, 0.60, 1.00, 1.00, 1.00, 1.00])  # beard: not a child

# Whole-body attribute model (PA-100K order): index of Female and the 3 age groups
PAR_FEMALE, PAR_AGE_OVER60, PAR_AGE_18_60, PAR_AGE_LESS18 = 22, 19, 20, 21
PAR_SIZE = (192, 256)  # width, height
PAR_MEAN, PAR_STD = np.array([0.485, 0.456, 0.406]), np.array([0.229, 0.224, 0.225])
BODY_WEIGHT = float(os.getenv("BODY_WEIGHT", "0.6"))  # a body look counts this much against a face look (1.0)
# The body model's 3 age groups spread over the face model's 8 groups
BODY_AGE_SPREAD = np.array([
    [0.05, 0.15, 0.35, 0.45, 0.00, 0.00, 0.00, 0.00],  # under 18
    [0.00, 0.00, 0.00, 0.10, 0.35, 0.30, 0.25, 0.00],  # 18-60
    [0.00, 0.00, 0.00, 0.00, 0.00, 0.00, 0.15, 0.85],  # over 60
])
# Body height (metres) → how likely each age group is
HEIGHT_PRIORS = [
    (1.30, np.array([1.0, 1.0, 1.0, 0.5, 0.15, 0.1, 0.1, 0.1])),  # shorter than 1.30 m: child
    (1.50, np.array([0.3, 0.6, 1.0, 1.0, 0.7, 0.6, 0.6, 0.6])),  # 1.30–1.50 m
    (9.99, np.array([0.05, 0.05, 0.2, 0.8, 1.0, 1.0, 1.0, 1.0])),  # taller: teenager / adult
]


def _path(env: str, default: str) -> str:
    p = os.getenv(env, default)
    return p if os.path.isabs(p) else os.path.normpath(os.path.join(EDGE_DIR, p))


@dataclass
class HeadCues:
    """Face and hair seen on one look at a face, each 0-1 (None = could not tell)."""

    beard: float | None = None  # beard / moustache (chin and upper lip darker and rougher than the cheeks)
    long_hair: float | None = None  # hair beside the face and below the chin
    bald: float | None = None  # top of the head skin-coloured (bald / shaved)
    grey: float | None = None  # share of grey / white hair on top
    dark: float | None = None  # share of dark hair on top
    weight: float = 1.0  # how much this look counts (bigger, more frontal face: more)


@dataclass
class Estimate:
    """Running (weighted) average for one person."""

    samples: int = 0
    weight: float = 0.0
    gender_sum: np.ndarray = field(default_factory=lambda: np.zeros(2))
    age_sum: np.ndarray = field(default_factory=lambda: np.zeros(len(AGE_GROUPS)))
    height: float | None = None  # body height in metres (None = not measured)
    cue_sum: dict = field(default_factory=lambda: dict.fromkeys(CUE_KEYS, 0.0))  # HeadCues, weighted sums
    cue_weight: dict = field(default_factory=lambda: dict.fromkeys(CUE_KEYS, 0.0))

    def add(self, gender_probs: np.ndarray, age_probs: np.ndarray, weight: float = 1.0) -> None:
        self.samples += 1
        self.weight += weight
        self.gender_sum += np.asarray(gender_probs, dtype=float) * weight
        self.age_sum += np.asarray(age_probs, dtype=float) * weight

    def add_cues(self, cues: "HeadCues") -> None:
        """Add the face and hair seen on one look (does not count as a look)."""
        for k in CUE_KEYS:
            v = getattr(cues, k)
            if v is not None:
                self.cue_sum[k] += float(v) * cues.weight
                self.cue_weight[k] += cues.weight

    def cue(self, key: str) -> float | None:
        """Average of one face / hair cue (0-1), or None until seen on enough clear looks."""
        w = self.cue_weight.get(key, 0.0)
        return self.cue_sum[key] / w if w >= CUE_MIN_WEIGHT else None

    def merge(self, other: "Estimate") -> None:
        """Add another camera's / tracker's looks at the same person."""
        self.samples += other.samples
        self.weight += other.weight
        self.gender_sum += other.gender_sum
        self.age_sum += other.age_sum
        for k in CUE_KEYS:
            self.cue_sum[k] += other.cue_sum.get(k, 0.0)
            self.cue_weight[k] += other.cue_weight.get(k, 0.0)
        if self.height is None:
            self.height = other.height

    def _probs(self) -> tuple[np.ndarray, np.ndarray]:
        """Gender (Male, Female) and age-group probabilities: the models' average,
        then the face / hair cues and the body height."""
        g = self.gender_sum / self.weight
        a = self.age_sum / self.weight
        beard, bald, long_hair = self.cue("beard"), self.cue("bald"), self.cue("long_hair")
        grey, dark = self.cue("grey"), self.cue("dark")
        # Gender: how many times more likely Male / Female the face and hair make it
        male, female = 1.0, 1.0
        if beard is not None and beard > 0.25:
            male *= 1 + 8 * min(1.0, (beard - 0.25) / 0.75)  # beard / moustache: up to 9x male
        if bald is not None and bald > 0.5:
            male *= 1 + 3 * min(1.0, (bald - 0.5) / 0.5)  # bald / shaved: up to 4x male
        if long_hair is not None:
            if long_hair > 0.3:
                female *= 1 + 3 * min(1.0, (long_hair - 0.3) / 0.7)  # long hair: up to 4x female
            elif long_hair < 0.08 and (bald is None or bald < 0.5):
                male *= 1.4  # short hair: a little more likely male (women wear short hair too)
        g = g * np.array([male, female])
        g = g / max(float(g.sum()), 1e-9)
        # Age: grey / white hair → older; dark full hair → unlikely over 60; bald → adult; beard → not a child
        prior = np.ones(len(AGE_GROUPS))
        if grey is not None:
            t = float(np.clip((grey - 0.15) / 0.45, 0.0, 1.0))
            prior *= (1 - t) + t * GREY_PRIOR
            if grey < 0.08 and dark is not None:
                t = float(np.clip((dark - 0.4) / 0.4, 0.0, 1.0))
                prior *= (1 - t) + t * DARK_PRIOR
        if bald is not None and bald > 0.5:
            t = min(1.0, (bald - 0.5) / 0.4)
            prior *= (1 - t) + t * BALD_PRIOR
        if beard is not None and beard > 0.35:
            prior *= BEARD_PRIOR
        if self.height is not None:
            prior *= next(p for limit, p in HEIGHT_PRIORS if self.height < limit)
        if float((a * prior).sum()) > 1e-9:
            a = a * prior
        a = a / max(float(a.sum()), 1e-9)
        return g, a

    def wants_looks(self, limit: int) -> bool:
        """More looks wanted: fewer than `limit`, or still unsure (gender or age
        group) and fewer than 2x `limit`."""
        if self.samples < limit:
            return True
        if self.samples >= 2 * limit or self.weight <= 0:
            return False
        g, a = self._probs()
        return float(g.max()) < SETTLED_GENDER or float(a.max()) < SETTLED_AGE

    def visit_fields(self) -> dict:
        """est_gender / est_age / demographic_score for the visit row."""
        if self.samples == 0 or self.weight <= 0:
            return {"est_gender": "Unknown", "est_age": 0, "demographic_score": 0.0}
        g, a = self._probs()
        g_conf, a_conf = float(g.max()), float(a.max())
        gender = GENDERS[int(g.argmax())] if g_conf >= GENDER_MIN_CONFIDENCE else "Unknown"
        # Age: within the most likely age group and its two neighbours only. Averaging over
        # ALL groups pulls everybody towards the middle (a child up, an old person down).
        k = int(a.argmax())
        near = slice(max(0, k - 1), min(len(AGE_GROUPS), k + 2))
        age = int(round(float(a[near] @ AGE_MIDDLE[near] / max(float(a[near].sum()), 1e-9))))
        # How sure the models are, 0–100: average of the gender and age-group confidence
        score = round((g_conf + a_conf) / 2 * 100, 1)
        return {"est_gender": gender, "est_age": age, "demographic_score": score}

    def label(self) -> str:
        """Short text for the --show window, e.g. "F 29"."""
        if self.samples == 0:
            return ""
        f = self.visit_fields()
        return f"{f['est_gender'][0] if f['est_gender'] != 'Unknown' else '?'} {f['est_age']}"


class Looks(list):
    """[(gender_probs, age_probs, weight), ...] of one look at a person, with the
    face and hair seen (.cues, HeadCues or None)."""

    cues: "HeadCues | None" = None


def _frontal(marks: np.ndarray) -> float:
    """1.0 for a face looking at the camera, down to 0.3 for a side-on face (the
    nose far from the middle of the eyes): a side-on face is easily misjudged."""
    (rex, _), (lex, _), (nx, _) = marks[0], marks[1], marks[2]
    eyes = abs(lex - rex)
    if eyes < 1:
        return 0.3
    yaw = abs(nx - (rex + lex) / 2) / eyes
    return float(np.clip(1 - (yaw - 0.12) / 0.3, 0.3, 1.0))


def head_cues(frame: np.ndarray, face: tuple[float, float, float, float], marks: np.ndarray,
              frontal: float = 1.0) -> HeadCues | None:
    """Face and hair around one face (whole camera picture, face box x, y, w, h in
    pixels, the 5 face points): beard / moustache, long hair, bald, grey / dark hair.
    Compares colours with the cheeks (skin) and with the hair on top of the head.
    None when the face is too small."""
    fx, fy, fw, fh = (float(v) for v in face)
    size = min(fw, fh)
    if size < CUE_MIN_PIXELS:
        return None
    H, W = frame.shape[:2]
    # Work on the area around the face only
    rx1, ry1 = int(max(0, fx - 0.9 * fw)), int(max(0, fy - 0.6 * fh))
    rx2, ry2 = int(min(W, fx + fw + 0.9 * fw)), int(min(H, fy + fh + 0.9 * fh))
    region = frame[ry1:ry2, rx1:rx2]
    if region.size == 0:
        return None
    hsv = cv2.cvtColor(region, cv2.COLOR_BGR2HSV)
    gray_picture = float(hsv[..., 1].mean()) < GRAY_SATURATION  # night / IR: no colours
    lab = cv2.cvtColor(region, cv2.COLOR_BGR2LAB).astype(np.float32)
    lum = lab[..., 0]
    lap = np.abs(cv2.Laplacian(lum, cv2.CV_32F))  # roughness (beard texture)

    def patch(x1, y1, x2, y2):
        """Pixels of a box (whole-picture pixels) inside the region, or None when too few,
        or when much of the box is outside the picture."""
        want = max(1.0, (x2 - x1) * (y2 - y1))
        a1, b1 = int(max(rx1, x1)) - rx1, int(max(ry1, y1)) - ry1
        a2, b2 = int(min(rx2, x2)) - rx1, int(min(ry2, y2)) - ry1
        if a2 - a1 < 2 or b2 - b1 < 2 or (a2 - a1) * (b2 - b1) < 0.6 * want:
            return None
        return (slice(b1, b2), slice(a1, a2))

    def dist(px: np.ndarray, ref: np.ndarray) -> np.ndarray:
        d = px - ref
        if gray_picture:
            return np.abs(d[..., 0])
        return np.sqrt(0.5 * d[..., 0] ** 2 + d[..., 1] ** 2 + d[..., 2] ** 2)  # lighting matters less

    re, le, nose, rm, lm = marks
    # Skin: the two cheeks (below the eyes, above the mouth)
    half = 0.07 * fw
    cheeks = [patch(e[0] - half, (e[1] + m[1]) / 2 - half, e[0] + half, (e[1] + m[1]) / 2 + half)
              for e, m in ((re, rm), (le, lm))]
    cheeks = [c for c in cheeks if c is not None]
    if not cheeks:
        return None
    skin_px = np.concatenate([lab[c].reshape(-1, 3) for c in cheeks])
    skin = np.median(skin_px, axis=0)
    skin_rough = float(np.mean([lap[c].mean() for c in cheeks])) + 1.0
    cues = HeadCues(weight=float(np.clip(size / 64.0, 0.5, 1.5)) * frontal * (0.5 if gray_picture else 1.0))

    # Top of the head: above the face box
    top = patch(fx + 0.2 * fw, fy - 0.30 * fh, fx + 0.8 * fw, fy + 0.02 * fh)
    hair = None
    if top is not None:
        top_px = lab[top].reshape(-1, 3)
        skin_like = dist(top_px, skin) < SKIN_DISTANCE
        skin_share = float(skin_like.mean())
        if not gray_picture:  # under IR, hair can look as light as skin
            cues.bald = float(np.clip((skin_share - 0.45) / 0.4, 0.0, 1.0))
        if skin_share < 0.7 and int((~skin_like).sum()) >= 12:
            hair = np.median(top_px[~skin_like], axis=0)
            if not gray_picture:
                hair_hsv = hsv[top].reshape(-1, 3)[~skin_like]
                s, v = hair_hsv[:, 1].astype(float), hair_hsv[:, 2].astype(float)
                cues.grey = float(((s < 40) & (v > 110)).mean())  # grey / white: no colour, light
                cues.dark = float((v < 80).mean())  # dark (black / dark brown)
        elif cues.bald is not None and cues.bald > 0.7:
            cues.long_hair = 0.0  # no hair on top: no long hair either

    # Long hair: hair colour beside the jaw and below the chin, on both sides of the face,
    # but not further out (there it is the background, e.g. a dark wall)
    if hair is not None:
        chin = fy + fh
        sides = [patch(fx - 0.35 * fw, chin - 0.25 * fh, fx + 0.02 * fw, chin + 0.45 * fh),
                 patch(fx + 0.98 * fw, chin - 0.25 * fh, fx + 1.35 * fw, chin + 0.45 * fh)]
        outer = [patch(fx - 0.85 * fw, chin - 0.25 * fh, fx - 0.5 * fw, chin + 0.1 * fh),
                 patch(fx + 1.5 * fw, chin - 0.25 * fh, fx + 1.85 * fw, chin + 0.1 * fh)]

        def hair_share(boxes):
            shares = []
            for b in boxes:
                if b is None:
                    continue
                px = lab[b].reshape(-1, 3)
                shares.append(float(((dist(px, hair) < HAIR_DISTANCE) & (dist(px, skin) >= SKIN_DISTANCE)).mean()))
            return float(np.mean(shares)) if shares else None

        side, out = hair_share(sides), hair_share(outer)
        if side is not None and (out is None or out < 0.5):  # background the colour of the hair: cannot tell
            cues.long_hair = float(np.clip((side - (out or 0.0) - 0.15) / 0.45, 0.0, 1.0))

    # Beard / moustache: chin (below the lower lip) and upper lip darker and rougher than the cheeks
    if size >= BEARD_MIN_PIXELS:
        mouth_y = (rm[1] + lm[1]) / 2
        mx, mw = (rm[0] + lm[0]) / 2, max(abs(lm[0] - rm[0]) / 2, 0.1 * fw)
        gap = max(1.0, mouth_y - nose[1])
        spots = [patch(mx - 0.9 * mw, mouth_y + 0.10 * fh, mx + 0.9 * mw, min(fy + fh, mouth_y + 0.30 * fh)),  # chin
                 patch(mx - 0.8 * mw, nose[1] + 0.35 * gap, mx + 0.8 * mw, mouth_y - 0.35 * gap)]  # upper lip
        scores = []
        for b in spots:
            if b is None:
                continue
            darker = (float(skin[0]) - float(lum[b].mean())) / max(float(skin[0]), 1.0)
            rough = float(lap[b].mean()) / skin_rough
            scores.append(float(np.clip((darker - 0.12) / 0.25, 0.0, 1.0)) * (0.5 + 0.5 * float(np.clip((rough - 1.3) / 1.5, 0.0, 1.0))))
        if scores:
            cues.beard = float(np.mean(scores))
    return cues


class Demographics:
    """One per camera thread (OpenCV networks must not be shared between threads)."""

    def __init__(self) -> None:
        self.enabled = os.getenv("DEMOGRAPHICS", "on").lower() not in ("off", "0", "false", "no")
        if not self.enabled:
            return
        face = _path("FACE_MODEL", "models/face_detection_yunet_2023mar.onnx")
        gender = _path("GENDER_MODEL", "models/gender_googlenet.onnx")
        age = _path("AGE_MODEL", "models/age_googlenet.onnx")
        missing = [p for p in (face, gender, age) if not os.path.isfile(p)]
        if missing:
            log.warning("Gender / age estimation is off: model file(s) missing %s. "
                        "Run: python download_models.py", missing)
            self.enabled = False
            return
        self.face = cv2.FaceDetectorYN.create(face, "", (320, 320), FACE_MIN_SCORE)
        self._last_frontal = 1.0  # of the last face found (from_person)
        self._last_cues: HeadCues | None = None
        self.gender = cv2.dnn.readNetFromONNX(gender)
        self.age = cv2.dnn.readNetFromONNX(age)
        # Whole-body attribute model (optional)
        self.body = None
        body = _path("BODY_MODEL", "models/person_attribute_pa100k.onnx")
        if os.path.isfile(body):
            try:
                self.body = cv2.dnn.readNetFromONNX(body)
            except cv2.error as exc:
                log.warning("Whole-body gender / age model %s could not be loaded: %s", body, exc)
        else:
            log.info("Whole-body gender / age model not found (%s): using the face only. "
                     "See README → Gender / age.", body)

    def from_body(self, frame: np.ndarray, box: tuple[float, float, float, float]):
        """Gender and age-group probabilities from the whole body (face, hands,
        upper body, lower body, feet), or None (no body model / box too small)."""
        if not self.enabled or self.body is None:
            return None
        h, w = frame.shape[:2]
        x1, y1, x2, y2 = (int(v) for v in box)
        crop = frame[max(0, y1):min(h, y2), max(0, x1):min(w, x2)]
        if crop.shape[0] < 64 or crop.shape[1] < 24:
            return None
        rgb = cv2.cvtColor(cv2.resize(crop, PAR_SIZE), cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
        blob = ((rgb - PAR_MEAN) / PAR_STD).transpose(2, 0, 1)[None].astype(np.float32)
        self.body.setInput(blob)
        out = self.body.forward().flatten()
        if out.size < 26:
            return None
        if out.min() < 0 or out.max() > 1:  # raw scores → probabilities
            out = 1 / (1 + np.exp(-out))
        female = float(out[PAR_FEMALE])
        ages = np.array([out[PAR_AGE_LESS18], out[PAR_AGE_18_60], out[PAR_AGE_OVER60]], dtype=float)
        ages = ages / max(float(ages.sum()), 1e-9)
        return np.array([1 - female, female]), ages @ BODY_AGE_SPREAD

    def from_whole_person(self, frame: np.ndarray, box: tuple[float, float, float, float], body: bool = True):
        """All looks at one person: [(gender_probs, age_probs, weight), ...], with
        .cues = the face and hair seen (HeadCues, or None).
        body=False (legs hidden): the face only.
        A face counts more the bigger (sharper) it is in the picture: a 36-pixel face
        counts 0.5, a 72-pixel face or bigger 1.5, so a few clear faces outweigh
        many tiny, blurry ones. A side-on face counts less (down to 0.3x)."""
        found = Looks()
        face = self.from_person(frame, box)
        if face is not None:
            g, a, size = face
            frontal = self._last_frontal
            found.append((g, a, float(np.clip(size / 48.0, 0.5, 1.5)) * frontal))
            found.cues = self._last_cues
        whole = self.from_body(frame, box) if body else None
        if whole is not None:
            found.append((whole[0], whole[1], BODY_WEIGHT))
        return found

    def from_person(self, frame: np.ndarray, box: tuple[float, float, float, float]):
        """(gender probabilities, age-group probabilities, face size in pixels) from
        the face inside a person box (pixels x1, y1, x2, y2), or None when no clear
        face is visible."""
        if not self.enabled:
            return None
        h, w = frame.shape[:2]
        x1, y1, x2, y2 = (int(v) for v in box)
        # The face is in the top part of the person box
        top = frame[max(0, y1):min(h, y1 + int((y2 - y1) * 0.45) + 1), max(0, x1):min(w, x2)]
        if top.shape[0] < FACE_MIN_PIXELS or top.shape[1] < FACE_MIN_PIXELS:
            return None
        self.face.setInputSize((top.shape[1], top.shape[0]))
        _, faces = self.face.detect(top)
        if faces is None or len(faces) == 0:
            return None
        best = faces[int(np.argmax(faces[:, 2] * faces[:, 3]))]  # largest face
        fx, fy, fw, fh = best[:4]
        if min(fw, fh) < FACE_MIN_PIXELS:
            return None
        # Face and hair around this face (whole picture: hair may reach above / below the person box)
        ox, oy = max(0, x1), max(0, y1)
        marks = best[4:14].reshape(5, 2) + (ox, oy)  # right eye, left eye, nose, right / left mouth corner
        self._last_frontal = _frontal(marks)
        self._last_cues = (head_cues(frame, (fx + ox, fy + oy, fw, fh), marks, self._last_frontal)
                           if HEAD_CUES else None)
        m = FACE_MARGIN * max(fw, fh)
        cx1, cy1 = int(max(0, fx - m)), int(max(0, fy - m))
        cx2, cy2 = int(min(top.shape[1], fx + fw + m)), int(min(top.shape[0], fy + fh + m))
        crop = top[cy1:cy2, cx1:cx2]
        if crop.size == 0:
            return None
        blob = cv2.dnn.blobFromImage(crop, 1.0, (224, 224), MODEL_MEAN, swapRB=False)
        self.gender.setInput(blob)
        gender_probs = self.gender.forward().flatten()
        self.age.setInput(blob)
        age_probs = self.age.forward().flatten()
        return gender_probs, age_probs, float(min(fw, fh))
