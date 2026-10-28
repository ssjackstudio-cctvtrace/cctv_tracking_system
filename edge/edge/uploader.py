"""Background threads that talk to Supabase, so the camera threads never wait
on the internet.

- Writer: inserts visit / cctv_event rows (and updates a visit's gender / age)
  in order, retrying while offline. After each row is saved it calls
  on_saved(camera_id), so the website's live video can reload at once.
- Snapshots: uploads the newest picture of each camera and keeps
  camera.last_snapshot_url pointing at a signed link.
- Person photos: uploads the clearest picture of each track_id (private bucket
  person-photos, one folder per Malaysian day) and saves a signed link in
  visit.photo_url, for the Camera page "Suspicious same person". Folders older
  than PERSON_PHOTO_DAYS are deleted (PDPA: kept only as long as needed).
"""

from __future__ import annotations

import logging
import queue
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from .supa import Supabase, SupabaseError

log = logging.getLogger("uploader")

SIGNED_URL_SECONDS = 365 * 24 * 3600  # 1 year
RESIGN_AFTER_SECONDS = 300 * 24 * 3600  # make a fresh link after ~10 months


class Writer(threading.Thread):
    """Single writer, so a visit is always inserted before its events."""

    def __init__(self, supa: Supabase | None, max_pending: int = 50_000):
        super().__init__(name="writer", daemon=True)
        self.supa = supa
        self.on_saved: Callable[[str | None], None] | None = None  # set by main (live video)
        # (table, row, filters, camera_id): filters None = insert row, otherwise update with these filters
        self.jobs: "queue.Queue[tuple[str, dict[str, Any], dict[str, str] | None, str | None]]" = queue.Queue(
            maxsize=max_pending
        )

    def insert(self, table: str, row: dict[str, Any], camera_id: str | None = None) -> None:
        if self.supa is None:  # --offline
            log.info("offline: would insert into %s %s", table, row)
            return
        try:
            self.jobs.put_nowait((table, row, None, camera_id or row.get("camera_id")))
        except queue.Full:
            log.error("Too many unsent rows; dropping %s row", table)

    # Queued after the insert it belongs to, so the row always exists first
    def update(self, table: str, values: dict[str, Any], camera_id: str | None = None, **filters: str) -> None:
        if self.supa is None:  # --offline
            log.info("offline: would update %s %s where %s", table, values, filters)
            return
        try:
            self.jobs.put_nowait((table, values, filters, camera_id))
        except queue.Full:
            log.error("Too many unsent rows; dropping %s update", table)

    def run(self) -> None:
        while True:
            table, row, filters, camera_id = self.jobs.get()
            delay = 2.0
            while True:
                try:
                    if filters is None:
                        self.supa.insert(table, row)  # type: ignore[union-attr]
                    else:
                        self.supa.update(table, row, **filters)  # type: ignore[union-attr]
                    if self.on_saved:
                        try:
                            self.on_saved(camera_id)
                        except Exception:
                            pass
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


MY_TZ = timezone(timedelta(hours=8))  # Malaysia (no DST): photo folders are Malaysian days


class PhotoUploader(threading.Thread):
    """Person photos for the Suspicious same person list. Only the newest photo
    of each visit waiting to be sent is kept (a better one replaces it)."""

    def __init__(self, supa: Supabase, bucket: str, keep_days: int,
                 update: Callable[..., None], every_seconds: float = 3.0):
        super().__init__(name="photos", daemon=True)
        self.supa, self.bucket, self.keep_days, self.every = supa, bucket, keep_days, every_seconds
        self.update = update  # Writer.update: queued after the visit's insert, so the row exists first
        self._latest: dict[str, tuple[bytes, str]] = {}  # visit_id → (jpeg, Malaysian day it was taken)
        self._path: dict[str, str] = {}  # visit_id → path already linked in visit.photo_url
        self._lock = threading.Lock()
        self._next_cleanup = 0.0
        self._warned = ""

    def offer(self, visit_id: str, jpeg: bytes) -> None:
        day = datetime.now(MY_TZ).strftime("%Y-%m-%d")
        with self._lock:
            self._latest[visit_id] = (jpeg, day)

    def run(self) -> None:
        while True:
            time.sleep(self.every)
            with self._lock:
                batch, self._latest = self._latest, {}
            for visit_id, (jpeg, day) in batch.items():
                path = self._path.get(visit_id) or f"{day}/{visit_id}.jpg"  # same file when replaced
                try:
                    self.supa.upload(self.bucket, path, jpeg)
                    if visit_id not in self._path:
                        url = self.supa.signed_url(self.bucket, path, (self.keep_days + 1) * 24 * 3600)
                        self.update("visit", {"photo_url": url}, visit_id=f"eq.{visit_id}")
                        self._path[visit_id] = path
                except Exception as exc:
                    with self._lock:  # try again with the next round (a newer photo wins)
                        self._latest.setdefault(visit_id, (jpeg, day))
                    if str(exc) != self._warned:
                        log.warning("Person photo upload failed (run supabase/person_photos.sql once?): %s", exc)
                        self._warned = str(exc)
            if len(self._path) > 20_000:
                self._path.clear()
            if time.time() >= self._next_cleanup:
                self._next_cleanup = time.time() + 3600
                try:
                    self.cleanup()
                except Exception as exc:
                    log.warning("Old person photos not deleted yet: %s", exc)

    def cleanup(self) -> None:
        """Delete the day folders older than keep_days."""
        oldest_kept = (datetime.now(MY_TZ) - timedelta(days=self.keep_days)).strftime("%Y-%m-%d")
        folders = [o["name"] for o in self.supa.list_objects(self.bucket, "")
                   if o.get("id") is None and len(o.get("name", "")) == 10 and o["name"] < oldest_kept]
        for folder in folders:
            while True:
                files = [f"{folder}/{o['name']}" for o in self.supa.list_objects(self.bucket, f"{folder}/")
                         if o.get("id") is not None]
                if not files:
                    break
                self.supa.remove(self.bucket, files)
            log.info("Deleted person photos of %s (older than %d days)", folder, self.keep_days)
