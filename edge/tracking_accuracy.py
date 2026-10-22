"""How accurate is the tracking? Run on the edge box, in the edge folder:

    .venv/bin/python tracking_accuracy.py                       # last 30 minutes
    .venv/bin/python tracking_accuracy.py --minutes 60
    .venv/bin/python tracking_accuracy.py --from "2026-10-22 14:00" --to "2026-10-22 14:30" \
        --walkins 12 --passers 80                               # with your own hand count

Without a hand count it gives ESTIMATES (from the box log and cctv_event):
  - handoff rate: how often a camera re-used an existing track_id instead of making a new one
  - suspected duplicates: two track_ids that started on two different cameras within a few
    seconds of each other (the same person counted twice; also catches 2 real people walking
    in together, so it is an upper estimate)
With --walkins / --passers (real people you counted on the Tapo playback for the SAME time
window) it gives the TRUE accuracy: 100% - |track_ids - real people| / real people.
"""

from __future__ import annotations

import argparse
import re
import subprocess
from collections import Counter, defaultdict
from datetime import datetime, timedelta

from edge.config import load_settings
from edge.supa import Supabase

WINDOWS = {"In": 5.0, "Passed By": 10.0}  # seconds: same person reaching another camera's view


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Tracking accuracy of the edge box")
    p.add_argument("--minutes", type=float, default=30, help="look at the last N minutes (default 30)")
    p.add_argument("--from", dest="start", help='start, local time "YYYY-MM-DD HH:MM" (instead of --minutes)')
    p.add_argument("--to", dest="end", help='end, local time "YYYY-MM-DD HH:MM" (default now)')
    p.add_argument("--walkins", type=int, help="real people who walked in (your hand count)")
    p.add_argument("--passers", type=int, help="real people who passed by on the walkway (your hand count)")
    return p.parse_args()


def when(text: str | None, default: datetime) -> datetime:
    return datetime.strptime(text, "%Y-%m-%d %H:%M").astimezone() if text else default


def log_counts(start: datetime, end: datetime) -> tuple[Counter, Counter, Counter]:
    """How each tracker number got its track_id, from the box log (journalctl)."""
    cmd = ["journalctl", "-u", "cctv-edge", "--no-pager", "-o", "cat",
           "--since", start.strftime("%Y-%m-%d %H:%M:%S"), "--until", end.strftime("%Y-%m-%d %H:%M:%S")]
    try:
        text = subprocess.run(cmd, capture_output=True, text=True, timeout=60).stdout
    except (OSError, subprocess.SubprocessError):
        text = ""
    how, new_by_cam, passer_by_cam = Counter(), Counter(), Counter()
    for line in text.splitlines():
        m = re.search(r"\((new visitor|new passer-by|recognised[^)]*)\)", line)
        if not m:
            continue
        how[m.group(1)] += 1
        cam = re.search(r"cam-(\S+?):", line)
        if cam and m.group(1) == "new visitor":
            new_by_cam[cam.group(1)] += 1
        if cam and m.group(1) == "new passer-by":
            passer_by_cam[cam.group(1)] += 1
    return how, new_by_cam, passer_by_cam


def stamp(text: str) -> float:
    text = re.sub(r"\.(\d+)", lambda m: "." + m.group(1)[:6].ljust(6, "0"), text.replace("Z", "+00:00"))
    return datetime.fromisoformat(text).timestamp()


def main() -> None:
    args = parse_args()
    now = datetime.now().astimezone()
    end = when(args.end, now)
    start = when(args.start, end - timedelta(minutes=args.minutes))
    print(f"Window: {start:%Y-%m-%d %H:%M} – {end:%H:%M}  ({(end - start).total_seconds() / 60:.0f} min)\n")

    # ---------- 1. box log ----------
    how, new_by_cam, passer_by_cam = log_counts(start, end)
    made = how["new visitor"] + how["new passer-by"]
    reused = sum(n for k, n in how.items() if k.startswith("recognised"))
    print("Box log (how people got their track_id)")
    for k, n in how.most_common():
        print(f"  {n:6}  {k}")
    if made + reused:
        print(f"  Handoff rate: {100 * reused / (made + reused):.1f}% of links re-used an existing track_id")
    if new_by_cam:
        print("  New visitors by camera: " + ", ".join(f"{c} {n}" for c, n in sorted(new_by_cam.items())))
    if passer_by_cam:
        print("  New passers-by by camera: " + ", ".join(f"{c} {n}" for c, n in sorted(passer_by_cam.items())))
    if not how:
        print("  (nothing found — run on the edge box with sudo, or widen the window)")

    # ---------- 2. cctv_event ----------
    s = load_settings()
    supa = Supabase(s.supabase_url, s.supabase_secret_key)
    cams = {c["camera_id"]: c["camera_name"] for c in
            supa.select("camera", "camera_id,camera_name", edge_device_id=f"eq.{s.edge_device_id}")}
    rows: list[dict] = []
    for offset in range(0, 100000, 1000):  # Supabase sends at most 1,000 rows per request
        page = supa.select(
            "cctv_event", "visit_id,camera_id,direction,track_region,event_time",
            **{"event_time": f"gte.{start.isoformat()}", "order": "event_time.asc",
               "limit": "1000", "offset": str(offset)},
        )
        rows += page
        if len(page) < 1000:
            break
    rows = [r for r in rows if r["camera_id"] in cams and stamp(r["event_time"]) < end.timestamp()]
    regions = {"In": ("Counter", "Purchasing"), "Passed By": ("Traffic",)}
    first: dict[str, dict[str, tuple[float, str]]] = defaultdict(dict)  # direction → visit → (time, camera)
    for r in rows:
        d = r["direction"]
        if d in regions and r["track_region"] in regions[d] and r["visit_id"] not in first[d]:
            first[d][r["visit_id"]] = (stamp(r["event_time"]), r["camera_id"])

    print("\nDatabase (cctv_event)")
    truth = {"In": args.walkins, "Passed By": args.passers}
    for d, label in (("In", "Walk-in"), ("Passed By", "Passed By")):
        visits = sorted(first[d].items(), key=lambda kv: kv[1][0])
        dup = set()
        for i, (va, (ta, ca)) in enumerate(visits):
            for vb, (tb, cb) in visits[i + 1:]:
                if tb - ta > WINDOWS[d]:
                    break
                if cb != ca:
                    dup.add(vb)
        n = len(visits)
        by_cam = Counter(cams[c] for _, (_, c) in visits)
        print(f"  {label}: {n} track_ids  (" + ", ".join(f"{k} {v}" for k, v in sorted(by_cam.items())) + ")")
        if n:
            print(f"    suspected duplicates (another camera within {WINDOWS[d]:.0f} s): {len(dup)}"
                  f"  → estimated duplicate rate ≤ {100 * len(dup) / n:.1f}%")
        real = truth[d]
        if real:
            acc = max(0.0, 100 * (1 - abs(n - real) / real))
            kind = "duplicates" if n > real else ("missed / merged" if n < real else "exact")
            print(f"    hand count {real} → accuracy {acc:.1f}%  ({abs(n - real)} {kind})")
    if not (args.walkins or args.passers):
        print("\nFor the TRUE accuracy, count real people on the Tapo playback for the same window and add "
              "--walkins N --passers N.")


if __name__ == "__main__":
    main()