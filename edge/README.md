# Edge box program

Runs next to the Tapo cameras (on your Windows PC while developing, then on
the G6-RK3588-F13 box). It reads each camera's RTSP stream, finds people
with YOLO, tracks them, counts who crosses the count line, and writes
`visit` + `cctv_event` rows to Supabase. It also uploads a live picture
every few seconds for the Camera page and reports that the box and cameras
are online.

```
Tapo camera ──RTSP (shop network)──► main.py ──► Supabase (visit, cctv_event,
                                                 camera.last_seen_at, edge_device heartbeat,
                                                 camera-snapshots bucket)
```

| File | What it does |
|---|---|
| `main.py` | Starts everything; reloads camera settings + heartbeat every 60 s |
| `edge/camera_worker.py` | One thread per camera: RTSP → YOLO + ByteTrack → line counter → rows |
| `edge/visitors.py` | People inside the shop, shared by all cameras: one track_id per person |
| `edge/line_counter.py` | Decides In / Out from the count line's In / Out areas (`camera.count_line`) |
| `edge/demographics.py` | Estimated gender + age from each person's face |
| `download_models.py` | Downloads the face, gender and age models into `models/` |
| `edge/uploader.py` | Sends rows (retries while the internet is down) and snapshots |
| `edge/live_server.py` | Live video + people boxes for the website (WebSocket, no extra install) |
| `edge/supa.py` | Small Supabase client using the secret key |
| `edge/config.py` | Reads `.env`, builds the RTSP link |
| `cctv-edge.service` | Auto-start on the edge box |

## Before you start (once)

**In the Tapo app on your Android phone**, for each camera:

1. Tap the camera → ⚙️ (top right) → **Device Info**. Note the device name,
   model, MAC address and IP address. (No IP shown? Find the camera in your
   router's list of connected devices.)
2. ⚙️ → **Advanced Settings → Camera Account** → create a username and
   password. This is the stream login, not your Tapo/TP-Link login.
3. In your router, reserve (fix) the camera's IP address.
4. Optional check from your Windows PC on the same Wi-Fi: VLC → Media →
   Open Network Stream → `rtsp://USER:PASS@CAMERA_IP:554/stream2`.

**In Supabase:**

1. Make sure the branch exists (website → Branch page).
2. Run `supabase/edge_setup.sql` **PART 1** in the Supabase SQL Editor.
3. Fill in and run **PART 2** for the box and each camera, using the
   details from the Tapo app. Keep the `edge_device_id` it returns.
4. Copy `.env.example` to `.env` and fill it in. Use the **secret key**
   (`sb_secret_…`, Project Settings → API Keys), not the publishable/anon
   key. `TAPO_USER` / `TAPO_PASS` are the Camera Account from step 2.

## A. Develop on your Windows 10 PC

Install **Python 3.11** from python.org (tick "Add python.exe to PATH").
Then in PowerShell:

```powershell
cd D:\jackstudiocctv\cctv_tracking_system\edge
python -m venv .venv
.\.venv\Scripts\Activate.ps1          # if blocked: Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
pip install -r requirements.txt       # first time takes a few minutes (downloads PyTorch)
```

**1. Test without a camera and without Supabase.** Record a short phone video of
someone walking through a doorway, copy it here as `test.mp4`, then:

```powershell
python main.py --offline --source test.mp4 --line 0.1,0.6,0.9,0.6 --show
```

A window shows each person's dot, the yellow count line, a green **IN**
arrow, and the In / Out totals. Nothing is sent to Supabase; the rows it
*would* send are printed. Press `q` to close. Change `--line` until the line
sits across the doorway (0,0 = top-left, 1,1 = bottom-right).

**2. Test with a real camera and Supabase** (PC on the shop Wi-Fi):

```powershell
python main.py --camera PJ-Entrance --show
```

Then walk in and out. New rows should appear in `visit` and `cctv_event`,
and the dashboard's People In / Out go up. After the first snapshot
(about 5 s) the Camera page shows the live picture, where you can draw the
real count line (**Edit count line**). The program picks up the new line
within 60 s.

## B. Run on the G6-RK3588-F13 edge box

1. Connect the box to the shop router (OLAX_LTE_8951 at Aeon Bukit Tinggi)
   and reserve its IP in the router:
   - **Wired (recommended):** LAN cable from the box to a router LAN port.
   - **Wireless:** join the same Wi-Fi as the cameras (2.4 GHz, not guest Wi-Fi):
     ```bash
     sudo nmcli dev wifi connect "OLAX_LTE_8951" password "WIFI_PASSWORD"
     sudo nmcli con mod "OLAX_LTE_8951" connection.autoconnect yes 802-11-wireless.powersave 2
     ```
   Either way, `ip a` must show a `192.168.8.x` address and `ping 192.168.8.129`
   must reach camera ABT-01. The program itself is the same for both.
2. From Windows: `ssh ubuntu@BOX_IP` (or VS Code → Remote-SSH).
3. On the box:
   ```bash
   sudo apt update && sudo apt install -y python3-venv git
   git clone https://github.com/ssjackstudio-cctvtrace/cctv_tracking_system.git
   cd cctv_tracking_system/edge
   python3 -m venv .venv && . .venv/bin/activate
   pip install -r requirements.txt
   nano .env        # same content as on your PC
   ```
4. **Use the NPU.** The model must be exported to RKNN on an x86 **Linux**
   PC. On Windows 10 use WSL2 (`wsl --install -d Ubuntu`):
   ```bash
   pip install ultralytics
   yolo export model=yolo11n.pt format=rknn name=rk3588
   ```
   Copy the `yolo11n_rknn_model` folder to the box's `edge` folder and set
   `MODEL=./yolo11n_rknn_model` in `.env`. On the box, with the `.venv`
   active, also run `pip install rknn-toolkit-lite2` (runs the RKNN model). The box needs the Rockchip NPU
   runtime (`librknnrt.so`); ask the seller for the Ubuntu 22.04 image that
   includes RKNPU2. Without it, `MODEL=yolo11n.pt` still runs on the CPU,
   only slower.
5. Try it: `python main.py`, walk past a camera, check Supabase.
6. Make it start by itself. If the box's login is not `ubuntu` (check with
   `whoami`), first change `User=` and both `/home/ubuntu/...` paths in
   `cctv-edge.service`.
   ```bash
   sudo cp cctv-edge.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now cctv-edge
   journalctl -u cctv-edge -f      # live log
   ```
   After `git pull` with new code: `sudo systemctl restart cctv-edge`.

   The program then stays running and follows each camera by itself: when a
   Tapo camera is switched off it stops tracking it (log: `camera is OFF`,
   Camera page: Inactive), and when the camera powers on again it starts
   tracking within about 5 seconds (log: `camera is ON — starting live tracking`).

## How In / Out is decided

On the camera details page, **Edit count line**: click as many dots as you
need across the shop entrance, **Save line**, then click the area that is
inside the shop. That area is **In** (green), the other is **Out** (orange);
the line is stretched to the picture border at both ends to split the
picture. **Save**.

- **In**: a person whose feet (both bottom corners of their box) are
  **completely** inside the In area for a few frames. This includes people
  already inside when the box starts.
- **Out**: only for a person already In, whose feet are then completely back
  in the Out area. People never In are not counted Out.
- **Whole screen is In** (button in the editor): for a camera inside the shop
  that does not see the entrance. Everyone it sees is In; it never counts Out.
- **Full body**: only people whose whole body is in the picture (head,
  upper body, lower body and feet) are counted, placed in 3D and looked at
  for gender / age. With a pose model (`MODEL=yolo11n-pose.pt` on the PC) the
  body parts are checked one by one; with the plain person model (the RKNN
  model on the box) the box must not touch the top or bottom of the picture
  and must be tall like a standing person (`FULL_BODY_RATIO`, default 1.2).
  People partly hidden are still followed, and keep their track_id label,
  but are not counted until their full body is seen.
- For a camera looking straight down use `ANCHOR=center` (the box middle is
  used instead of the feet).

Older two-point lines still work (In = the side the green arrow pointed to).

## One track ID per person (all cameras)

All 4 cameras send their video over the same Wi-Fi router to this one box,
so the box sees every camera at once and keeps ONE list of the people inside
(`edge/edge/visitors.py`):

- The **first camera** that sees a new person go In makes the visit row; its
  track_id (e.g. `ABT-01-3f9a2c-7`) is the person's track_id until they go Out.
- Every other camera that sees the same person — at the same moment (views
  that overlap) or later (another part of the shop) — is **linked** to that
  visitor. It may record its own `cctv_event` rows (In once per camera per
  visit, areas walked into), always with the **same visit_id / track_id**.
  It never makes a second visit for someone already inside.
- The label never changes while the person is inside: if a camera's tracker
  loses them for a moment (behind a shelf, another shopper) and gives them a
  new number, the new number is linked back to the same visitor.
- A new person only gets a visit after `NEW_VISITOR_HOLD_SECONDS` (default
  1 s), so a camera whose view overlaps another camera's has time to see that
  it is someone already inside. Two cameras asking at the same moment are
  answered one at a time, so only one visit can be made.
- **Out** on any camera (or walking into an "Outside Shop" area) ends the
  visit on all cameras. If they come back later, that is a new visit.

How the box knows it is the same person:

1. **Floor position (best)** — set the **3D floor** of every camera (Camera
   page → camera → *Shop areas (3D)*), all measured from the **same corner
   of the shop**. Then one person seen by two cameras stands on the same floor
   spot (within `SAME_PLACE_METRES`, default 0.9 m), and two people in the
   same clothes standing apart are never mixed up.
2. **Clothes colour** (upper and lower body), for cameras without a 3D floor
   and for people walking from one camera's view into another's. Tune with
   `REID_MAX_DISTANCE` (lower = stricter).
3. Someone already followed as a different person in the same picture is
   never a match (two people side by side).

Only numbers are kept in memory; no picture is saved. Only people inside the
shop (In area) are compared, so a passer-by outside never takes a visitor's
track_id. People who leave without any camera seeing them go Out are
forgotten after `VISITOR_FORGET_MINUTES`.

The tracker keeps a hidden person's number for 60 frames
(`trackers/bytetrack_cctv.yaml`; set `TRACKER=` to use another file).

## Shop areas (3D) and track_region

Camera page → camera → **Shop areas (3D)** (saved in `camera.floor_areas`):

1. **Set 3D floor** (once per camera; the camera is fixed). Put 4 tape marks
   on the floor that this camera sees, spread out (e.g. the corners of a
   2 m × 3 m rectangle). Measure each one from the shop's reference corner:
   X along one wall, Y along the other, in metres. Click the 4 marks on the
   picture and type their X / Y. The page works out the camera's lens and
   height and shows a 1 m grid on the floor: check that the grid lies flat
   on the floor and the camera height it shows is right.
2. **+ Add area**: click the corners of the area on the floor (counter, each
   Point of Purchase display, the corridor outside...), give it any name and a
   kind, and a height range (Z). With a 3D floor it is a 3D box.

The box then knows, for every full-body person, their floor spot X / Y, their
height Z and the area they are in (shown live on the camera details page, with
a top-view floor map). `cctv_event.direction` is only **In** or **Out**; every
row also gets `track_region` (where the person was):

| Event | direction | track_region |
|---|---|---|
| Walks In past the count line (or first seen on a "whole screen is In" camera) | In | Purchasing, or Counter when standing in a Counter area |
| Walks into a **Counter** area | In | Counter |
| Walks into a **Purchasing** area (POP display...) | In | Purchasing |
| Walks Out (count line, or into an **Outside Shop** area) | Out | Outside Shop |

The area's own name (e.g. "POP Display – Shoes") is only shown on the live
video, not saved.

People are counted once per visit, so the extra In rows for areas never make
"People In" bigger.

A visitor walking into an area gets ONE event, whichever camera sees it
first. `REGION_MIN_SECONDS` (default 1 s) is how long they must stand in the
area before it counts. Run `supabase/cctv_event_track_region.sql` once first
(it also makes sure `camera.floor_areas` exists, removes `cctv_event.zone_name`
and limits `direction` to In / Out).

Test on the PC with a saved area file:
`python main.py --offline --source test.mp4 --line 0.1,0.6,0.9,0.6 --zones zone.json --show`

The dashboard counts **people** (visits), not events: People In = visits with
an In, People Out = visits with an Out, People Still Inside = visits whose
newest event is In.

To delete all tracking records and start again, see
`supabase/reset_tracking.sql` (stop the box first).

## Live video (Camera page and camera details page)

The box streams live video (8 pictures/s per camera on the Camera page, 12
on the details page) with a box around each counted person. It only sends
pictures while someone has the page open in a visible browser tab, so it
uses no mobile data when nobody watches.

**Mobile data (SIM router):** live video is heavy. Roughly 45 MB per minute
with the Camera page open (4 cameras), 30 MB per minute on one camera's
details page, i.e. about 2.5 GB per hour of watching the Camera page. Close
the tab when done. To use less, lower `LIVE_QUALITY` (e.g. 45) or
`LIVE_MAX_FPS` (e.g. 6) in `.env`. Counting itself does not use the video and
is not affected.

Once per box:

1. Supabase → SQL Editor → run `supabase/live_video.sql`.
2. On the box, give the live video a public https address with Tailscale Funnel:
   ```bash
   sudo tailscale funnel --bg 8090
   tailscale funnel status          # shows https://js-abt-edge-01.<your-tailnet>.ts.net
   ```
   The first time, it prints a link to turn on HTTPS / Funnel for your
   tailnet: open it, allow it, then run the command again.
3. `nano .env` → `LIVE_PUBLIC_URL=https://js-abt-edge-01.<your-tailnet>.ts.net`
4. `sudo systemctl restart cctv-edge`. Within a minute the Camera page plays
   live video. Check from any browser: `https://…ts.net/health` shows
   `live video ok, 4 camera(s)`.

Only signed-in website admins can watch (the box checks the website's sign-in
with Supabase). Without `LIVE_PUBLIC_URL` the pages keep showing the snapshot
every few seconds, as before.

When a person is counted, the box tells the open camera details page at
once, so the counts and records update without refreshing.

## Gender and age (estimated, whole body)

Once per machine, with the `.venv` active: `python download_models.py`
(about 48 MB into `edge/models/`, not in GitHub). Then restart `main.py`.

Only full-body people are looked at. Each visitor's estimate is shared by all
cameras: up to `DEMOGRAPHIC_SAMPLES` (default 8) looks, every 0.5 s, from any
camera, averaged and written to their `visit` row (`est_gender`
Male / Female / Unknown, `est_age`, `demographic_score` 0-100). Each look uses:

- **Face** (when visible): face detector + gender / age face models.
- **Whole body** (face, hands, upper body, lower body, feet), optional: a
  PA-100K pedestrian attribute model (Female, AgeLess18, Age18-60,
  AgeOver60), so people seen from the side or from behind get an estimate
  too. Export PaddleClas PULC `person_attribute` to ONNX
  (`paddle2onnx --model_dir ... --save_file person_attribute_pa100k.onnx`),
  copy it to `edge/models/person_attribute_pa100k.onnx` (or set
  `BODY_MODEL=`). Without it, only the face is used. `BODY_WEIGHT`
  (default 0.6) is how much a body look counts against a face look.
- **Body height** in metres (cameras with a 3D floor): a short body makes a
  child more likely.

No face or body picture is saved or sent. The age model works in age
groups (25-32, 38-43, ...), so `est_age` is a rough estimate. With `--show`
the window prints it next to each person, e.g. `7 F 29`.
Turn it off with `DEMOGRAPHICS=off` in `.env`.

## Not in this version yet (phase 2)

- Face recognition → `recognition_event`. The SQL function
  `match_member_face` is ready for it.
- Rows waiting while the internet is down are kept in memory, so a power cut
  during an outage loses them.
