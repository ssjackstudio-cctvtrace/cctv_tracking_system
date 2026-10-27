"""CCTV Tracking System — edge box program.

Normal run (on the edge box, or your PC on the shop network):
    python main.py

Test on your Windows PC with no camera / no Supabase writes:
    python main.py --offline --source test.mp4 --zones areas.json --show
    (areas.json = a camera.floor_areas value; --inside-only without it: the whole picture is inside)
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
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
from edge.visitors import KEEP_SECONDS, VisitorRegistry  # noqa: E402

log = logging.getLogger("main")

# camera has no branch_id: the branch comes from the camera's edge box (edge_device.branch_id)
# floor_areas = 3D floor + shop areas (Purchasing / Counter / Traffic) + inside_only, see edge/space3d.py
CAMERA_COLUMNS = (
    "camera_id,camera_name,active_status,ip_address,stream_path,floor_areas,edge_device(branch_id)"
)
OUT_OF_RANGE = "Out of Range"  # cctv_event.track_region of a visit closed by the box (person not seen any more)
REFRESH_SECONDS = 60  # reload camera settings + send heartbeat
SUSPECT_SECONDS = 30  # look for suspicious same person pairs (Camera page)
STATUS_SECONDS = 5  # check each camera's active_status (sent only when it changes)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="CCTV edge box: count people and send events to Supabase")
    p.add_argument("--offline", action="store_true",
                   help="do not contact Supabase (use with --source and --zones to test on your PC)")
    p.add_argument("--source", help="video file or webcam number instead of the camera's RTSP stream")
    p.add_argument("--camera", help="only run this camera_name (default: all active cameras of this edge box)")
    p.add_argument("--inside-only", action="store_true",
                   help="for --offline without --zones: the whole picture is inside the shop")
    p.add_argument("--zones", help="for --offline: JSON file with a camera.floor_areas value (3D floor + areas)")
    p.add_argument("--show", action="store_true", help="open a window with boxes, areas and counts")
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
    # People the cameras see, shared by all cameras: one track_id per person
    visitors = VisitorRegistry()

    def stamp(epoch: float) -> str:
        return datetime.fromtimestamp(epoch, timezone.utc).isoformat()

    def close_stale_visits() -> None:
        """After a restart: today's visits on this box's cameras that never got
        a Passed By / Out (the box stopped while they were inside) are closed
        with an Out event (Out of Range) KEEP_SECONDS after they were last
        recorded, like a person no camera sees any more. Their track_ids are
        not used again, so every visit has an In and an end."""
        if supa is None:
            return
        midnight = datetime.now().astimezone().replace(hour=0, minute=0, second=0, microsecond=0)
        try:
            rows = supa.select(
                "cctv_event", "visit_id,direction,event_time,confidence,camera_id,camera!inner(edge_device_id)",
                **{"camera.edge_device_id": f"eq.{settings.edge_device_id}",
                   "event_time": f"gte.{midnight.isoformat()}", "order": "event_time.asc", "limit": "20000"},
            )
        except Exception as exc:
            log.warning("Could not check today's open visits: %s", exc)
            return
        last: dict[str, dict] = {}
        for r in rows:  # oldest first: the newest event of each visit wins
            last[r["visit_id"]] = r
        closed = 0
        for vid, r in last.items():
            if r["direction"] != "In":
                continue
            try:  # fraction padded to 6 digits for Python 3.10
                text = re.sub(r"\.(\d+)", lambda m: "." + m.group(1)[:6].ljust(6, "0"),
                              str(r["event_time"]).replace("Z", "+00:00"))
                at = datetime.fromisoformat(text).timestamp()
            except ValueError:
                continue
            writer.insert("cctv_event", {
                "camera_id": r["camera_id"], "visit_id": vid, "direction": "Out",
                "track_region": OUT_OF_RANGE, "confidence": r.get("confidence") or 0,
                "event_time": stamp(min(at + KEEP_SECONDS, time.time())),
            })
            closed += 1
        if closed:
            log.info("Closed %d visit(s) left open before the restart (Out added)", closed)

    close_stale_visits()

    def close_lost() -> None:
        """A person no camera has seen for KEEP_SECONDS: their track_id ends.
        If they never left on a camera (Passed By / Out), their visit is closed with
        an Out event (Out of Range) at the moment they were last seen (on the camera
        that saw them last)."""
        for v in visitors.expire():
            cam_id = max(v.seen_on, key=v.seen_on.get) if v.seen_on else v.first_camera
            last = max(v.seen_on.values()) if v.seen_on else v.last_seen
            writer.insert("cctv_event", {
                "camera_id": cam_id, "visit_id": v.visit_id, "direction": "Out",
                "track_region": OUT_OF_RANGE, "confidence": round(v.last_conf * 100, 2),
                "event_time": stamp(last),
            })
            if v.estimate.samples > v.sent_faces:  # newest gender / age
                writer.update("visit", v.estimate.visit_fields(), camera_id=cam_id, visit_id=f"eq.{v.visit_id}")
            log.info("%s not seen by any camera for %.0f s: track_id ended, visit closed (Out)",
                     v.track_id, KEEP_SECONDS)

    # Live video for the website (only sends pictures while someone watches)
    live = None
    if supa and settings.live_port:
        live = LiveServer(settings.live_host, settings.live_port, lambda: dict(workers),
                          supa.admin_ok, settings.live_max_fps, settings.live_quality)
        live.start()
        writer.on_saved = live.notify  # a row was saved → the website reloads at once

    def load_cameras() -> list[dict]:
        if supa is None:
            areas = json.load(open(args.zones, encoding="utf-8")) if args.zones else \
                {"version": 3, "calibration": None, "regions": [], "inside_only": bool(args.inside_only)}
            return [{
                "camera_id": "offline", "camera_name": args.camera or "test", "branch_id": "offline",
                "active_status": "Active", "ip_address": "", "stream_path": "stream2",
                "floor_areas": areas,
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
                workers[cam_id].update_camera(cam)  # e.g. shop areas redrawn on the Camera page
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
                # Write active_status too, not only last_seen_at: while the internet was
                # down, Supabase's mark_offline_devices() job set the camera 'Inactive',
                # but report_status() only writes on a change it saw itself, so a camera
                # that never stopped on the box stayed 'Inactive' on the website for good.
                supa.update("camera", {"active_status": "Active", "last_seen_at": utc_now()},
                            camera_id=f"eq.{cam_id}")
                w.reported_status = "Active"

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

    # Suspicious same person (Camera page): pairs of track_ids that look like one
    # person, sent every SUSPECT_SECONDS; a pair is sent again only when its score rises
    reported_suspects: dict[tuple[str, str], float] = {}
    suspect_error = {"last": ""}  # shown once per different error (e.g. suspect_match.sql not run yet)

    def report_suspects() -> None:
        if supa is None:
            return
        if len(reported_suspects) > 5000:
            reported_suspects.clear()
        for s in visitors.suspects():
            key = (s["visit_keep"], s["visit_dup"])
            if key in reported_suspects and s["score"] < reported_suspects[key] + 5:
                continue
            try:
                supa.rpc("report_suspect_match", {"p": {k: v for k, v in s.items() if k != "look_ok"}})
            except Exception as exc:  # visit row not written yet, SQL not run, or internet down: next round
                if str(exc) != suspect_error["last"]:
                    log.warning("Suspicious pair %s / %s not sent yet: %s", s["track_keep"], s["track_dup"], exc)
                    suspect_error["last"] = str(exc)
                continue
            if key not in reported_suspects:
                log.info("Suspicious same person: %s and %s (%s, %s%%)", s["track_keep"], s["track_dup"],
                         s["kind"], s["score"])
            reported_suspects[key] = s["score"]

    next_refresh = next_status = next_close = next_suspect = 0.0
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
            if time.time() >= next_close:
                close_lost()  # people unseen for KEEP_SECONDS: track_id ended
                next_close = time.time() + 1
            if time.time() >= next_suspect:
                try:
                    report_suspects()
                except Exception as exc:
                    log.warning("Suspicious same person check failed: %s", exc)
                next_suspect = time.time() + SUSPECT_SECONDS
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
