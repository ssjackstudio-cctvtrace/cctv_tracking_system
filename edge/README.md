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
- **Full body**: people whose feet are cut off by the bottom of the picture,
  or whose box is not tall enough (`FULL_BODY_RATIO`, default 1.2), are
  followed but not counted until their full body is seen.
- For a camera looking straight down use `ANCHOR=center` (the box middle is
  used instead of the feet).

Older two-point lines still work (In = the side the green arrow pointed to).

## One track ID per person (all cameras)

All cameras of the box share one list of the people inside. When a camera
sees someone go In, the box compares the colours of their clothes (upper and
lower body) with everyone already inside:

- **Looks the same** → it is that person: the camera records its own In
  event, but with the **same visit / track_id** they got on the first camera.
  Each camera records In at most once per visit.
- **No match** → a new person: new visit, new track_id.
- **Out** on any camera ends the visit (the person leaves the list). If they
  come back later, that is a new visit.

Only colour numbers are kept in memory; no picture is saved. Clothes colour
is not perfect: two people in the same plain black shirt can be mixed up, and
very different camera colours can split one person into two. Tune with
`REID_MAX_DISTANCE` in `.env` (lower = stricter). People who leave without
any camera seeing them go Out are forgotten after `VISITOR_FORGET_MINUTES`.

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

## Gender and age (estimated)

Once per machine, with the `.venv` active: `python download_models.py`
(about 48 MB into `edge/models/`, not in GitHub). Then restart `main.py`.

While a person is tracked, the box looks at their face up to 5 times
(every 0.5 s), averages the results and writes `est_gender`
(Male / Female / Unknown), `est_age` and `demographic_score` (how sure the
models are, 0-100) to their `visit` row. No face picture is saved or sent.
People seen only from behind stay `Unknown`. The age model works in age
groups (25-32, 38-43, ...), so `est_age` is a rough estimate. With `--show`
the window prints it next to each person, e.g. `7 F 29`.
Turn it off with `DEMOGRAPHICS=off` in `.env`.

## Not in this version yet (phase 2)

- Face recognition → `recognition_event`. The SQL function
  `match_member_face` is ready for it.
- Rows waiting while the internet is down are kept in memory, so a power cut
  during an outage loses them.
