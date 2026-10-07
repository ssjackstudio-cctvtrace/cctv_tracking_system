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
| `edge/line_counter.py` | Decides In / Out when a person crosses `camera.count_line` |
| `edge/uploader.py` | Sends rows (retries while the internet is down) and snapshots |
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
   `MODEL=./yolo11n_rknn_model` in `.env`. The box needs the Rockchip NPU
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

## How In / Out is decided

The count line has a direction. On the Camera page (and the `--show`
window) a green arrow marks the **In** side: crossing towards the arrow is
**In**, crossing away from it is **Out**. **Flip direction** on the
Camera page swaps them. The point that must cross is the person's feet
(`ANCHOR=bottom`); for a camera looking straight down use `ANCHOR=center`.

## Not in this version yet (phase 2)

- `est_gender`, `est_age`, `demographic_score` stay at their defaults
  (`Unknown` / 0), so the dashboard's Male / Female rows show 0 for now.
- Face recognition → `recognition_event`. The SQL function
  `match_member_face` is ready for it.
- Rows waiting while the internet is down are kept in memory, so a power cut
  during an outage loses them.
