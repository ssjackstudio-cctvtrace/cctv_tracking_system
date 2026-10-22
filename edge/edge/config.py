"""Settings read from edge/.env (see .env.example)."""

from __future__ import annotations

import logging
import os
import platform
import re
from dataclasses import dataclass

from dotenv import load_dotenv


def _env(name: str, default: str | None = None) -> str:
    value = os.getenv(name, default)
    if value is None or value == "":
        raise SystemExit(f"Missing {name} in edge/.env")
    return value


@dataclass(frozen=True)
class Settings:
    supabase_url: str
    supabase_secret_key: str
    edge_device_id: str
    tapo_user: str
    tapo_pass: str
    model: str
    confidence: float
    image_size: int
    anchor: str  # "bottom" (feet) or "center"
    snapshot_seconds: float
    snapshot_bucket: str
    live_port: int  # live video server (0 = off)
    live_host: str
    live_public_url: str  # e.g. wss://js-abt-edge-01.tailxxxx.ts.net (Tailscale Funnel)
    live_max_fps: float
    live_quality: int


EDGE_DIR = os.path.normpath(os.path.join(os.path.dirname(__file__), ".."))


def resolve_model(model: str) -> str:
    """On the RK3588 box (ARM), a PyTorch model (.pt) runs on the CPU: about
    1-3 pictures a second for 4 cameras, so boxes trail behind people, the live
    video stutters and people are missed. When the NPU copy of the same model
    (e.g. yolo11n_rknn_model, made with `yolo export ... format=rknn`) is in the
    edge folder, it is used instead (10x faster). MODEL_AUTO_NPU=off keeps the .pt."""
    auto = os.getenv("MODEL_AUTO_NPU", "on").strip().lower() not in ("off", "0", "false", "no")
    if not auto or not model.endswith(".pt") or platform.machine().lower() not in ("aarch64", "arm64"):
        return model
    name = os.path.splitext(os.path.basename(model))[0]
    rknn = os.path.join(EDGE_DIR, f"{name}_rknn_model")
    if os.path.isdir(rknn):
        logging.getLogger("config").info("MODEL=%s would run on the CPU: using the NPU model %s instead", model, rknn)
        return rknn
    logging.getLogger("config").warning(
        "MODEL=%s runs on the CPU of this ARM box (slow: laggy live video, missed people). "
        "Copy %s_rknn_model into %s and set MODEL=./%s_rknn_model (README → Use the NPU)", model, name, EDGE_DIR, name)
    return model


def load_settings(offline: bool = False) -> Settings:
    load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))
    need = (lambda n, d=None: os.getenv(n, d or "")) if offline else _env
    return Settings(
        supabase_url=need("SUPABASE_URL"),
        supabase_secret_key=need("SUPABASE_SECRET_KEY"),
        edge_device_id=need("EDGE_DEVICE_ID"),
        tapo_user=os.getenv("TAPO_USER", ""),
        tapo_pass=os.getenv("TAPO_PASS", ""),
        model=resolve_model(os.getenv("MODEL", "yolo11n.pt")),
        # Low on purpose: partly hidden people (lower score) keep their tracker number;
        # new people still need a sure detection (new_track_thresh, PERSON_CONF_PEAK)
        confidence=float(os.getenv("CONFIDENCE", "0.15")),
        image_size=int(os.getenv("IMAGE_SIZE", "640")),
        anchor=os.getenv("ANCHOR", "bottom"),
        snapshot_seconds=float(os.getenv("SNAPSHOT_SECONDS", "5")),
        snapshot_bucket=os.getenv("SNAPSHOT_BUCKET", "camera-snapshots"),
        live_port=int(os.getenv("LIVE_PORT", "8090")),
        live_host=os.getenv("LIVE_HOST", "127.0.0.1"),
        live_public_url=os.getenv("LIVE_PUBLIC_URL", "").strip().rstrip("/"),
        live_max_fps=float(os.getenv("LIVE_MAX_FPS", "15")),
        live_quality=int(os.getenv("LIVE_QUALITY", "60")),
    )


def _env_key(camera_name: str) -> str:
    return re.sub(r"[^A-Z0-9]+", "_", camera_name.upper()).strip("_")


def rtsp_url(settings: Settings, camera: dict) -> str:
    """rtsp://USER:PASS@IP:554/stream2 — logins come from .env, never Supabase.

    One camera with a different Camera Account? Add to .env, e.g. for the
    camera named "PJ-Entrance":  TAPO_USER_PJ_ENTRANCE=...  TAPO_PASS_PJ_ENTRANCE=...
    """
    key = _env_key(camera["camera_name"])
    user = os.getenv(f"TAPO_USER_{key}", settings.tapo_user)
    password = os.getenv(f"TAPO_PASS_{key}", settings.tapo_pass)
    if not user or not password:
        raise SystemExit("Missing TAPO_USER / TAPO_PASS in edge/.env")
    ip = str(camera["ip_address"]).split("/")[0]  # inet may come back as "192.168.1.50/32"
    from urllib.parse import quote

    return f"rtsp://{quote(user, safe='')}:{quote(password, safe='')}@{ip}:554/{camera.get('stream_path') or 'stream2'}"
