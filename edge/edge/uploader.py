"""Background threads that talk to Supabase, so the camera threads never wait
on the internet.

- Writer: inserts visit / cctv_event rows in order, retrying while offline.
- Snapshots: uploads the newest picture of each camera and keeps
  camera.last_snapshot_url pointing at a signed link.
"""

from __future__ import annotations

import logging
import queue
import threading
import time
from typing import Any

from .supa import Supabase, SupabaseError

log = logging.getLogger("uploader")

SIGNED_URL_SECONDS = 365 * 24 * 3600  # 1 year
RESIGN_AFTER_SECONDS = 300 * 24 * 3600  # make a fresh link after ~10 months


class Writer(threading.Thread):
    """Single writer, so a visit is always inserted before its events."""

    def __init__(self, supa: Supabase | None, max_pending: int = 50_000):
        super().__init__(name="writer", daemon=True)
        self.supa = supa
        self.jobs: "queue.Queue[tuple[str, dict[str, Any]]]" = queue.Queue(maxsize=max_pending)

    def insert(self, table: str, row: dict[str, Any]) -> None:
        if self.supa is None:  # --offline
            log.info("offline: would insert into %s %s", table, row)
            return
        try:
            self.jobs.put_nowait((table, row))
        except queue.Full:
            log.error("Too many unsent rows; dropping %s row", table)

    def run(self) -> None:
        while True:
            table, row = self.jobs.get()
            delay = 2.0
            while True:
                try:
                    self.supa.insert(table, row)  # type: ignore[union-attr]
                    break
                except SupabaseError as exc:
                    if exc.status == 409:  # already inserted by an earlier try
                        break
                    if 400 <= exc.status < 500 and exc.status not in (408, 429):
                        log.error("Rejected %s row %s: %s", table, row, exc)  # bad data: retrying won't help
                        break
                    log.warning("Insert into %s failed, retry in %.0fs: %s", table, delay, exc)
                    time.sleep(delay)
                    delay = min(delay * 2, 60)
                except Exception as exc:  # network down
                    log.warning("Insert into %s failed, retry in %.0fs: %s", table, delay, exc)
                    time.sleep(delay)
                    delay = min(delay * 2, 60)


class SnapshotUploader(threading.Thread):
    def __init__(self, supa: Supabase, bucket: str, every_seconds: float):
        super().__init__(name="snapshots", daemon=True)
        self.supa, self.bucket, self.every = supa, bucket, every_seconds
        self._latest: dict[str, bytes] = {}
        self._signed_at: dict[str, float] = {}
        self._lock = threading.Lock()

    def offer(self, camera_id: str, jpeg: bytes) -> None:
        with self._lock:
            self._latest[camera_id] = jpeg  # older picture is simply replaced

    def run(self) -> None:
        while True:
            time.sleep(self.every)
            with self._lock:
                batch, self._latest = self._latest, {}
            for camera_id, jpeg in batch.items():
                path = f"{camera_id}.jpg"
                try:
                    self.supa.upload(self.bucket, path, jpeg)
                    if time.time() - self._signed_at.get(camera_id, 0) > RESIGN_AFTER_SECONDS:
                        url = self.supa.signed_url(self.bucket, path, SIGNED_URL_SECONDS)
                        self.supa.update("camera", {"last_snapshot_url": url}, camera_id=f"eq.{camera_id}")
                        self._signed_at[camera_id] = time.time()
                except Exception as exc:
                    log.warning("Snapshot upload for %s failed: %s", camera_id, exc)
