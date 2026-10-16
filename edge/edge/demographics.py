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
Repeated on several frames and cameras while the person walks, and averaged.

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
class Estimate:
    """Running (weighted) average for one person."""

    samples: int = 0
    weight: float = 0.0
    gender_sum: np.ndarray = field(default_factory=lambda: np.zeros(2))
    age_sum: np.ndarray = field(default_factory=lambda: np.zeros(len(AGE_GROUPS)))
    height: float | None = None  # body height in metres (None = not measured)

    def add(self, gender_probs: np.ndarray, age_probs: np.ndarray, weight: float = 1.0) -> None:
        self.samples += 1
        self.weight += weight
        self.gender_sum += np.asarray(gender_probs, dtype=float) * weight
        self.age_sum += np.asarray(age_probs, dtype=float) * weight

    def merge(self, other: "Estimate") -> None:
        """Add another camera's / tracker's looks at the same person."""
        self.samples += other.samples
        self.weight += other.weight
        self.gender_sum += other.gender_sum
        self.age_sum += other.age_sum
        if self.height is None:
            self.height = other.height

    def visit_fields(self) -> dict:
        """est_gender / est_age / demographic_score for the visit row."""
        if self.samples == 0 or self.weight <= 0:
            return {"est_gender": "Unknown", "est_age": 0, "demographic_score": 0.0}
        g = self.gender_sum / self.weight
        a = self.age_sum / self.weight
        if self.height is not None:
            prior = next(p for limit, p in HEIGHT_PRIORS if self.height < limit)
            a = a * prior
            a = a / max(float(a.sum()), 1e-9)
        g_conf, a_conf = float(g.max()), float(a.max())
        gender = GENDERS[int(g.argmax())] if g_conf >= GENDER_MIN_CONFIDENCE else "Unknown"
        age = int(round(float((a / a.sum()) @ AGE_MIDDLE)))  # weighted over the age groups
        # How sure the models are, 0–100: average of the gender and age-group confidence
        score = round((g_conf + a_conf) / 2 * 100, 1)
        return {"est_gender": gender, "est_age": age, "demographic_score": score}

    def label(self) -> str:
        """Short text for the --show window, e.g. "F 29"."""
        if self.samples == 0:
            return ""
        f = self.visit_fields()
        return f"{f['est_gender'][0] if f['est_gender'] != 'Unknown' else '?'} {f['est_age']}"


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

    def from_whole_person(self, frame: np.ndarray, box: tuple[float, float, float, float]):
        """All looks at one full-body person: [(gender_probs, age_probs, weight), ...]."""
        found = []
        face = self.from_person(frame, box)
        if face is not None:
            found.append((face[0], face[1], 1.0))
        body = self.from_body(frame, box)
        if body is not None:
            found.append((body[0], body[1], BODY_WEIGHT))
        return found

    def from_person(self, frame: np.ndarray, box: tuple[float, float, float, float]):
        """Gender and age-group probabilities from the face inside a person box
        (pixels x1, y1, x2, y2), or None when no clear face is visible."""
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
        fx, fy, fw, fh = faces[int(np.argmax(faces[:, 2] * faces[:, 3]))][:4]  # largest face
        if min(fw, fh) < FACE_MIN_PIXELS:
            return None
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
        return gender_probs, age_probs
