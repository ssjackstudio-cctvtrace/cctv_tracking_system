"""What AI models and accelerators does this edge box have, and what is missing?

Run on the edge box (or your PC), in the edge folder, with the .venv active:
    python check_models.py

It only looks; it installs nothing. Each line says OK, MISSING or OPTIONAL,
what the item does for tracking, and how to add it.
"""

from __future__ import annotations

import ctypes.util
import glob
import importlib.util
import os
import platform
import shutil
import subprocess
import sys

from dotenv import load_dotenv

EDGE = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(EDGE, ".env"))
ARM = platform.machine().lower() in ("aarch64", "arm64")

rows: list[tuple[str, str, str, str]] = []  # status, item, why, how to add


def add(ok: bool | None, item: str, why: str, how: str = "") -> None:
    rows.append(("OK" if ok else ("OPTIONAL" if ok is None else "MISSING"), item, why, "" if ok else how))


def path(p: str) -> str:
    return p if os.path.isabs(p) else os.path.normpath(os.path.join(EDGE, p))


def model_file(env: str, default: str) -> str:
    return path(os.getenv(env, default))


# ---------- 1. Person detector (the most important) ----------
model = os.getenv("MODEL", "yolo11n.pt")
is_rknn = "rknn" in model.lower()
auto_rknn = os.path.join(EDGE, os.path.splitext(os.path.basename(model))[0] + "_rknn_model")
if ARM:
    if is_rknn:
        add(os.path.isdir(path(model)), f"Person detector on the NPU ({model})",
            "10x faster than the CPU: smooth live video, boxes on the people, fewer missed people",
            "copy the yolo11n_rknn_model folder into the edge folder")
    else:
        add(os.path.isdir(auto_rknn), f"NPU copy of {model} ({os.path.basename(auto_rknn)})",
            f"MODEL={model} runs on the CPU (1-3 pictures a second for 4 cameras). The program switches to "
            "the NPU copy by itself when the folder is there",
            "copy yolo11n_rknn_model into the edge folder, set MODEL=./yolo11n_rknn_model in .env")
    has_lite = importlib.util.find_spec("rknnlite") is not None
    add(has_lite, "rknn-toolkit-lite2 (Python)", "runs RKNN models on the NPU",
        "pip install rknn-toolkit-lite2   (or the .whl for your Python from github.com/airockchip/rknn-toolkit2)")
    librt = ctypes.util.find_library("rknnrt") or next(iter(glob.glob("/usr/lib*/librknnrt.so")), None)
    add(bool(librt), "Rockchip NPU runtime (librknnrt.so)", "the NPU driver library the RKNN model needs",
        "copy librknnrt.so (rknpu2 runtime for RK3588) to /usr/lib/, or use the seller's Ubuntu image with RKNPU2")
else:
    add(os.path.exists(path(model)) or model.endswith(".pt"), f"Person detector ({model})",
        "PC: the .pt model downloads by itself the first time", "")

pose = [p for p in glob.glob(os.path.join(EDGE, "*pose*")) if "rknn" in p or p.endswith(".pt")]
add(bool(pose) or None, "Pose model (yolo11n-pose)",
    "checks head / body / hips / ankles one by one: knows when legs are hidden behind a table or the counter, "
    "and finds the feet from the ankles (better floor spot and areas)",
    "x86 Linux PC / WSL2: yolo export model=yolo11n-pose.pt format=rknn name=rk3588 → copy "
    "yolo11n-pose_rknn_model to the edge folder, set MODEL=./yolo11n-pose_rknn_model")

# ---------- 2. Recognition (same person on every camera) ----------
add(os.path.isfile(model_file("FACE_MODEL", "models/face_detection_yunet_2023mar.onnx")),
    "Face finder (YuNet)", "finds faces for face recognition and gender / age", "python download_models.py")
add(os.path.isfile(model_file("FACE_REID_MODEL", "models/face_recognition_sface_2021dec.onnx")),
    "Face recognition (SFace)", "strongest proof that two cameras see the same person", "python download_models.py")
add(os.path.isfile(model_file("BODY_REID_MODEL", "models/person_reid_youtu_2021nov.onnx")),
    "Whole-body re-identification (YoutuReID)",
    "recognises a person from the side / back on another camera; without it only clothes colour + height are "
    "compared (colours change with the light → new track_id)", "python download_models.py")

# ---------- 3. Gender / age ----------
add(os.path.isfile(model_file("GENDER_MODEL", "models/gender_googlenet.onnx")) and
    os.path.isfile(model_file("AGE_MODEL", "models/age_googlenet.onnx")),
    "Gender + age (GoogLeNet)", "est_gender / est_age on the visit", "python download_models.py")
add(os.path.isfile(model_file("BODY_MODEL", "models/person_attribute_pa100k.onnx")) or None,
    "Whole-body gender / age (PA-100K attributes)",
    "gender / age when the face is not seen (corner cameras see faces poorly)",
    "see README → Gender / age (optional model)")

# ---------- 4. Video decoding ----------
ff = shutil.which(os.getenv("FFMPEG", "ffmpeg"))
if ARM:
    dec = ""
    if ff:
        try:
            dec = subprocess.run([ff, "-hide_banner", "-decoders"], capture_output=True, text=True, timeout=10).stdout
        except (OSError, subprocess.SubprocessError):
            pass
    add("h264_rkmpp" in dec, "Hardware video decoder (ffmpeg with rkmpp)",
        "the chip unpacks the 4 camera streams instead of the CPU (less lag)",
        "install an ffmpeg built with rkmpp + RGA (e.g. the jellyfin-ffmpeg / nyanmisaka ffmpeg-rockchip build)")
else:
    add(bool(ff) or None, "ffmpeg", "PC: not needed (OpenCV decodes)", "")

# ---------- report ----------
width = max(len(r[1]) for r in rows)
print(f"Edge box models — {platform.machine()} / Python {sys.version.split()[0]} — MODEL={model}\n")
for status, item, why, how in rows:
    print(f"[{status:8}] {item.ljust(width)}  {why}")
    if how:
        print(f"{'':11}{''.ljust(width)}  → {how}")
missing = [r for r in rows if r[0] == "MISSING"]
print(f"\n{len(missing)} missing, {sum(r[0] == 'OPTIONAL' for r in rows)} optional.")
