"""CCTV Tracking System — edge box program.

Normal run (on the edge box, or your PC on the shop network):
    python main.py

Test on your Windows PC with no camera / no Supabase writes:
    python main.py --offline --source test.mp4 --line 0.1,0.6,0.9,0.6 --show
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
from datetime import datetime, timezone

# Read RTSP over TCP (steadier than UDP over Wi-Fi). Must be set before cv2 opens a stream.
os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS", "rtsp_transport;tcp")

from edge.camera_worker import CameraWorker  # noqa: E402
from edge.config import load_settings, rtsp_url  # noqa: E402
from edge.live_server import LiveServer  # noqa: E402
from edge.supa import Supabase  # noqa: E402
from edge.uploader import SnapshotUploader, Writer  # noqa: E402
from edge.visitors import VisitorRegistry  # noqa: E402

log = logging.getLogger("main")

# camera has no branch_id: the branch comes from the camera's edge box (edge_device.branch_id)
# floor_areas = 3D floor calibration + shop areas (Counter / Point of Purchase ...), see edge/space3d.py
CAMERA_COLUMNS = (
    "camera_id,camera_name,active_status,ip_address,stream_path,count_line,floor_areas,edge_device(branch_id)"
)
REFRESH_SECONDS = 60  # reload camera settings + send heartbeat
STATUS_SECONDS = 5  # check each camera's active_status (sent only when it changes)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="CCTV edge box: count people and send events to Supabase")
    p.add_argument("--offline", action="store_true",
                   help="do not contact Supabase (use with --source and --line to test on your PC)")
    p.add_argument("--source", help="video file or webcam number instead of the camera's RTSP stream")
    p.add_argument("--camera", help="only run this camera_name (default: all active cameras of this edge box)")
    p.add_argument("--line", help="count line for --offline: x1,y1,x2,y2 in 0-1, e.g. 0.1,0.6,0.9,0.6")
    p.add_argument("--zones", help="for --offline: JSON file with a camera.floor_areas value (3D floor + areas)")
    p.add_argument("--show", action="store_true", help="open a window with boxes, line and counts")
    return p.parse_args()


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def main() -> None:
    args = parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(threadName)s: %(message)s")
    settings = load_settings(offline=args.offline)

    supa = None if args.offline else Supabase(settings.supabase_url, settings.supabase_secret_key)
    writer = Writer(supa)
    writer.start()
    snapshots = None
    if supa:
        snapshots = SnapshotUploader(supa, settings.snapshot_bucket, settings.snapshot_seconds)
        snapshots.start()

    workers: dict[str, CameraWorker] = {}
    # People inside the shop, shared by all cameras: one track_id per person
    visitors = VisitorRegistry()

    # Live video for the website (only sends pictures while someone watches)
    live = None
    if supa and settings.live_port:
        live = LiveServer(settings.live_host, settings.live_port, lambda: dict(workers),
                          supa.admin_ok, settings.live_max_fps, settings.live_quality)
        live.start()
        writer.on_saved = live.notify  # a row was saved → the website reloads at once

    def load_cameras() -> list[dict]:
        if supa is None:
            x1, y1, x2, y2 = (float(v) for v in (args.line or "0.1,0.6,0.9,0.6").split(","))
            return [{
                "camera_id": "offline", "camera_name": args.camera or "test", "branch_id": "offline",
                "active_status": "Active", "ip_address": "", "stream_path": "stream2",
                "count_line": {"start": {"x": x1, "y": y1}, "end": {"x": x2, "y": y2}},
                "floor_areas": json.load(open(args.zones, encoding="utf-8")) if args.zones else None,
            }]
        # Every camera of this box, Active or Inactive: the box itself decides
        # active_status from whether the camera picture is live and open.
        rows = supa.select("camera", CAMERA_COLUMNS, edge_device_id=f"eq.{settings.edge_device_id}")
        for c in rows:  # visit.branch_id = branch of this edge box
            c["branch_id"] = (c.pop("edge_device", None) or {}).get("branch_id")
        return [c for c in rows if not args.camera or c["camera_name"] == args.camera]

    def source_for(cam: dict) -> str | int:
        if args.source:
            return int(args.source) if args.source.isdigit() else args.source
        return rtsp_url(settings, cam)

    def sync_workers() -> None:
        cameras = {c["camera_id"]: c for c in load_cameras()}
        for cam_id, cam in cameras.items():
            if cam_id in workers and workers[cam_id].grabber.source != source_for(cam):
                # Wi-Fi camera got a new IP (or stream_path changed) in Supabase:
                # the open RTSP link points at the old address, so start again.
                log.info("%s: IP address / stream changed, reconnecting", workers[cam_id].name)
                workers.pop(cam_id).stop()
            if cam_id in workers:
                workers[cam_id].update_camera(cam)  # e.g. count line redrawn on the dashboard
            else:
                w = CameraWorker(
                    cam, source_for(cam), settings.model, settings.confidence, settings.image_size,
                    settings.anchor, writer.insert, snapshots.offer if snapshots else None,
                    settings.snapshot_seconds, show=args.show, update=writer.update, registry=visitors,
                )
                workers[cam_id] = w
                w.start()
        for cam_id in [k for k in workers if k not in cameras]:  # removed or moved to another box
            log.info("Stopping %s", workers[cam_id].name)
            workers.pop(cam_id).stop()

    def heartbeat() -> None:
        if supa is None:
            return
        supa.update("edge_device", {"status": "Online", "last_heartbeat": utc_now()},
                    edge_device_id=f"eq.{settings.edge_device_id}")
        if settings.live_public_url:  # tell the website where to watch the live video
            try:
                supa.update("edge_device", {"live_url": settings.live_public_url},
                            edge_device_id=f"eq.{settings.edge_device_id}")
            except Exception as exc:
                log.warning("Could not save live_url (run supabase/live_video.sql once): %s", exc)
        for cam_id, w in workers.items():
            if w.active_status() == "Active":
                supa.update("camera", {"last_seen_at": utc_now()}, camera_id=f"eq.{cam_id}")

    # Active = connected + camera picture open; Inactive = closed or not connected
    def report_status() -> None:
        if supa is None:
            return
        for cam_id, w in list(workers.items()):
            status = w.active_status()
            if status == w.reported_status:
                continue
            values = {"active_status": status}
            if status == "Active":
                values["last_seen_at"] = utc_now()
            supa.update("camera", values, camera_id=f"eq.{cam_id}")
            w.reported_status = status
            log.info("%s is now %s", w.camera["camera_name"], status)
        report_inside()

    # Dashboard "People Still Inside": people the 4 cameras see right now, each
    # person once (edge_device.people_inside, supabase/people_inside.sql).
    # Sent when it changes, and at least once a minute so the dashboard knows it is fresh.
    last_inside: dict = {"value": None, "at": 0.0}

    def report_inside() -> None:
        now = visitors.inside_now()
        if now == last_inside["value"] and time.time() - last_inside["at"] < 60:
            return
        try:
            supa.update("edge_device", {"people_inside": {**now, "at": utc_now()}},
                        edge_device_id=f"eq.{settings.edge_device_id}")
        except Exception as exc:
            log.warning("Could not save people_inside (run supabase/people_inside.sql once): %s", exc)
        last_inside.update(value=now, at=time.time())

    sync_workers()
    if not workers:
        sys.exit("No cameras found for this EDGE_DEVICE_ID. Check the camera table (Step 4).")
    log.info("Running %d camera(s). Press Ctrl+C to stop.", len(workers))

    next_refresh = next_status = 0.0
    open_windows: set[str] = set()  # --show: one window per camera that is on
    try:
        while True:
            if time.time() >= next_refresh:
                try:
                    heartbeat()
                    sync_workers()
                except Exception as exc:  # internet down: keep counting, try again later
                    log.warning("Refresh / heartbeat failed: %s", exc)
                next_refresh = time.time() + REFRESH_SECONDS
            if time.time() >= next_status:
                try:
                    report_status()
                except Exception as exc:  # internet down: sent again on the next check
                    log.warning("Camera status update failed: %s", exc)
                next_status = time.time() + STATUS_SECONDS
            if args.show:
                import cv2

                for w in list(workers.values()):
                    name = w.camera["camera_name"]
                    if w.preview is not None:  # camera on: open / refresh its window
                        cv2.imshow(name, w.preview)
                        open_windows.add(name)
                    elif name in open_windows:  # camera off or closed: close its window
                        cv2.destroyWindow(name)
                        open_windows.discard(name)
                if not open_windows:
                    time.sleep(0.03)  # no window open, so waitKey would not wait
                if cv2.waitKey(30) & 0xFF == ord("q"):
                    break
            else:
                time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        for w in workers.values():
            w.stop()
        deadline = time.time() + 10  # give unsent rows a moment to reach Supabase
        while writer.jobs.qsize() and time.time() < deadline:
            time.sleep(0.5)
        if supa:
            try:
                supa.update("edge_device", {"status": "Offline"}, edge_device_id=f"eq.{settings.edge_device_id}")
                # Box stopping: nobody watches its cameras any more
                supa.update("camera", {"active_status": "Inactive"}, edge_device_id=f"eq.{settings.edge_device_id}")
            except Exception:
                pass
        log.info("Stopped. %d row(s) were still waiting to be sent.", writer.jobs.qsize())


if __name__ == "__main__":
    main()
