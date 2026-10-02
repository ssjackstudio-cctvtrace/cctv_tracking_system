"""Settings read from edge/.env (see .env.example)."""

from __future__ import annotations

import os
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


def load_settings(offline: bool = False) -> Settings:
    load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))
    need = (lambda n, d=None: os.getenv(n, d or "")) if offline else _env
    return Settings(
        supabase_url=need("SUPABASE_URL"),
        supabase_secret_key=need("SUPABASE_SECRET_KEY"),
        edge_device_id=need("EDGE_DEVICE_ID"),
        tapo_user=os.getenv("TAPO_USER", ""),
        tapo_pass=os.getenv("TAPO_PASS", ""),
        model=os.getenv("MODEL", "yolo11n.pt"),
        confidence=float(os.getenv("CONFIDENCE", "0.40")),
        image_size=int(os.getenv("IMAGE_SIZE", "640")),
        anchor=os.getenv("ANCHOR", "bottom"),
        snapshot_seconds=float(os.getenv("SNAPSHOT_SECONDS", "5")),
        snapshot_bucket=os.getenv("SNAPSHOT_BUCKET", "camera-snapshots"),
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
