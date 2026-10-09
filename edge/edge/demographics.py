"""Estimated gender and age for each tracked person (visit.est_gender,
visit.est_age, visit.demographic_score).

How it works, per person (track):
  1. Look for a face in the top part of the person's box (YuNet face detector).
  2. Run the gender and age models on that face.
  3. Repeat on a few different frames while the person is walking, and average.
     One frame is often blurred or half-turned; the average is steadier.

Only the numbers are kept. No face picture is saved or sent anywhere.
People seen only from behind stay "Unknown".

Models (run on the CPU with OpenCV, nothing extra to install). Get them with:
    python download_models.py
  - face_detection_yunet_2023mar.onnx   (OpenCV Zoo)
  - gender_googlenet.onnx, age_googlenet.onnx   (ONNX Model Zoo, Levi & Hassner)
The age model gives 8 age groups, so est_age is an estimate within a group,
not an exact age.
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


def _path(env: str, default: str) -> str:
    p = os.getenv(env, default)
    return p if os.path.isabs(p) else os.path.normpath(os.path.join(EDGE_DIR, p))


@dataclass
class Estimate:
    """Running average for one person."""

    samples: int = 0
    gender_sum: np.ndarray = field(default_factory=lambda: np.zeros(2))
    age_sum: np.ndarray = field(default_factory=lambda: np.zeros(len(AGE_GROUPS)))

    def add(self, gender_probs: np.ndarray, age_probs: np.ndarray) -> None:
        self.samples += 1
        self.gender_sum += gender_probs
        self.age_sum += age_probs

    def visit_fields(self) -> dict:
        """est_gender / est_age / demographic_score for the visit row."""
        if self.samples == 0:
            return {"est_gender": "Unknown", "est_age": 0, "demographic_score": 0.0}
        g = self.gender_sum / self.samples
        a = self.age_sum / self.samples
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
