# Edge box program

Runs next to the Tapo cameras (on your Windows PC while developing, then on
the G6-RK3588-F13 box). It reads each camera's RTSP stream, finds people
with YOLO, tracks them, follows which shop area they stand in (Purchasing,
Counter, Traffic walkway), and writes
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
| `edge/camera_worker.py` | One thread per camera: RTSP → YOLO + ByteTrack → shop areas → In / Passed By / Out rows |
| `edge/visitors.py` | People inside the shop, shared by all cameras: one track_id per person |
| `edge/reid.py` | Recognises a person by face, attire and whole body (same person = same track_id) |
| `edge/space3d.py` | 3D floor and the shop areas of each camera (`camera.floor_areas`) |
| `edge/demographics.py` | Estimated gender + age from each person's face |
| `download_models.py` | Downloads the face, gender, age and person recognition models into `models/` |
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
python main.py --offline --source test.mp4 --inside-only --show
```

A window shows each person's dot and the In / Out totals (`--inside-only`:
the whole picture counts as inside the shop). Nothing is sent to Supabase;
the rows it *would* send are printed. Press `q` to close. To test areas, save
a `camera.floor_areas` value as `areas.json` and use `--zones areas.json`.

**2. Test with a real camera and Supabase** (PC on the shop Wi-Fi):

```powershell
python main.py --camera PJ-Entrance --show
```

Then walk in and out. New rows should appear in `visit` and `cctv_event`,
and the dashboard's People Walk-in goes up. After the first snapshot
(about 5 s) the Camera page shows the live picture, where you can draw the
shop areas (**Shop areas**). The program picks up the new areas within 60 s.

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
   **Hardware video decoding.** The RK3588 also has a video decoder chip. With
   `HW_DECODE=auto` (default) the program uses it through the box's `ffmpeg`
   when `ffmpeg -hide_banner -decoders | grep rkmpp` lists `h264_rkmpp`, so the
   CPU no longer unpacks the camera video (needed for stream1 on several
   cameras). When ffmpeg also has the RGA filter `scale_rkrga`, the picture is
   shrunk to `DECODE_MAX_WIDTH` (default 1920) on the chip too and handed over
   as NV12 (about 80% CPU for 4 cameras at 2880x1620, measured on the box).
   The log shows `hardware decoding h264 1920x1080 with h264_rkmpp + RGA`
   per camera. If it keeps failing, that camera goes back to the CPU (OpenCV)
   for 10 minutes and the log says so. `HW_DECODE=off` always uses the CPU.
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

On the camera details page, **Shop areas**: click dots around each area on
the floor of the picture and give it a kind:

- **Purchasing** (any display / Point of Purchase area) and **Counter**:
  inside the shop.
- **Traffic**: the walkway outside the shop.
- Anywhere not inside a drawn area is **Out of Range** (outside the shop).
- **Inside only** (tick box): for a camera that only sees the inside of the
  shop (ABT-03). The whole picture is inside: places without an area count as
  Purchasing, and the camera never records Passed By / Out.

Areas must not overlap. A person counts as standing in an area when their
feet stay in it for `REGION_MIN_SECONDS` (default 1 s):

- **In** (track_region Purchasing / Counter): walking into the shop, and
  moving to the other kind of area (Purchasing ↔ Counter). Once per change,
  whichever camera sees it first. This includes people already inside when
  the box starts.
- **Passed By** (track_region Traffic): a visitor walking from inside onto the
  Traffic walkway. Their stay in the shop ends here. People who were never
  inside are not recorded.
- **Out** (track_region Out of Range): a visitor walking from inside to a spot
  outside every area of that camera (only the camera that saw them inside can
  say so), or not seen by any camera for `TRACK_KEEP_SECONDS`.
- Two cameras whose views overlap: a camera does not move a person in or out
  while another camera has just seen them on the other side
  (`AREA_GUARD_SECONDS`, default 1.5), so events never flip back and forth.
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

**Passers-by and walk-ins.** Someone steadily on the Traffic walkway who is not
known yet gets a track_id and a **Passed By** (Traffic) event; if they then walk
into a Purchasing / Counter area, the same track_id gets **In**. Walking back onto
the walkway is Passed By again (the stay in the shop ends).

**Only moving people.** A new detection must move (`MOVE_MIN_SHARE`, default 15% of
its height) before it is followed; one that has not moved after `STATIC_SECONDS`
(default 8) is an object (mannequin, bag stand) and is ignored on that camera.

**Which person at which place.** With all cameras placed on the shop plan (Camera
page → Adjust 3D floor → Placed on the shop plan, with each camera's real X / Y and
Facing), a person lost at one spot can only be matched to someone standing within
walking distance (`PERSON_SPEED_MPS` x the seconds since) of that spot.

All 4 cameras send their video over the same Wi-Fi router to this one box,
so the box sees every camera at once and keeps ONE list of the people it
remembers (`edge/edge/visitors.py`):

- **Recognise first.** Before a person gets a new track_id, the box compares
  them with everyone it remembers by **face**, **attire** (colours of the
  upper and lower clothes), **whole body** (body re-identification model)
  and **body height** (`edge/edge/reid.py`). A clear difference in any of
  them (another face, other clothes, a 15 cm different height) means another
  person, so a look-alike never takes someone else's track_id.
- The **first camera** that sees a new person go In makes the visit row; its
  track_id (e.g. `ABT-01-3f9a2c-7`) is the person's track_id for the visit.
  A track_id is **never given to a second person**.
- Every other camera that sees the same person — at the same moment (views
  that overlap) or later (another part of the shop) — is **linked** to that
  visitor, always with the **same visit_id / track_id**.
- **10-minute memory.** A person is remembered while any camera sees them,
  and for `TRACK_KEEP_SECONDS` (default **600 = 10 minutes**) after the last camera saw
  them. Hidden for less than that (behind a shelf, out of every camera's picture):
  same track_id when they appear again anywhere in the shop with the same look.
  Top or pants clearly another colour = another person (`REID_ATTIRE_STYLE`). After that the track_id **ends**: if they never went Out,
  their visit is closed with an Out event (at the moment they were last
  seen), so every visit has an In and an Out.
- **Tracker mix-ups.** If a tracker number suddenly looks like another person
  (two people crossing), the link is dropped and the other person is
  recognised again or gets a new visit (`...-7.2`): the first person's
  track_id is not carried over.
- **Passed By / Out** on any camera is recorded once. After it the person is
  still followed outside, but nothing more is recorded, and their track_id is
  kept for `OUTSIDE_KEEP_SECONDS` (default **300 = 5 minutes**) after the
  last camera saw them. Walking back into a shop area within that time = same
  visit, same track_id, a new In event.
- **Walking out behind displays.** The tracker often loses a person behind the
  suitcases / displays at the shop front and gives them a new number outside.
  Someone first seen on the Traffic walkway whose look clearly matches a visitor
  seen inside in the last `EXIT_LINK_SECONDS` (default 8) is that visitor: they
  keep their track_id and their Passed By is recorded.
- **Restart:** visits of today left open when the box stopped are closed with
  an Out event when it starts again.

How the box knows it is the same person:

1. **Face, attire, whole body, height** — a person seen by 2 cameras at once
   (overlapping views), or walking from one camera's view into another's, is
   the visitor whose look matches; the first camera that saw them go In gave
   the track_id, and every other camera uses that same track_id.
   Models: `python download_models.py` (face recognition SFace and
   person re-identification YoutuReID from OpenCV Zoo). Without them, attire
   and height are used. Tune with `REID_MAX_DISTANCE` (lower = stricter) and
   the `REID_*` values in `.env`.
2. **Floor position** (optional) — cameras marked "Placed on the shop plan"
   in Adjust 3D floor share one floor: a person seen by two of them stands on
   the same floor spot (within `SAME_PLACE_METRES`, default 0.9 m). When the
   face is surely the same, up to `FLOOR_FACE_METRES` (default 2.0 m) apart is
   still the same person, so a small calibration error between two cameras
   never gives one person a second track_id.
3. Someone already followed as a different person in the same picture is
   never a match (two people side by side).
4. **Overlap handoff** — one person seen from 2 camera angles often does not
   look alike enough for the strict match in 1, and a missed match used to make
   a duplicate visit with the 2nd camera's track_id. Now, before a new visit
   is made, a visitor that **another camera sees right now** (`OVERLAP_SECONDS`,
   default 2) or that **went In on another camera at the same moment**
   (`OVERLAP_IN_SECONDS`, default 4) is taken, unless the look is clearly
   different (looser limit `OVERLAP_DISTANCE`, default 0.675). The 2nd camera
   then writes its cctv_event rows with the first camera's visit_id / track_id.
5. **Leaving on a camera that has no track_id for the person yet** — e.g. they
   went In on camera 1 and walk onto camera 2's Traffic walkway before camera
   2 linked them. Walking out now recognises them (rules 1–4) and records the
   Passed By for their **existing** track_id; the track_id is then remembered
   outside for `OUTSIDE_KEEP_SECONDS`. Someone who only stepped in and
   straight out (less than `NEW_VISITOR_HOLD_SECONDS`) gets nothing recorded.

**People inside right now** (`edge_device.people_inside`, no longer shown on
the dashboard) is what the cameras see right now: every visitor seen by any camera in the last 10 minutes (TRACK_KEEP_SECONDS), each person once
(someone in the overlap of 2 cameras is one visitor). The box writes it to
`edge_device.people_inside` — run `supabase/people_inside.sql` once. For a
past day (the shop is closed) it is 0.

Only numbers are kept in memory; no picture is saved.

The tracker keeps a hidden person's number for 150 frames (about 10 s)
(`trackers/bytetrack_cctv.yaml`; set `TRACKER=` to use another file).

### Keeping one track_id (what the 4 live videos showed)

| Seen on the videos | Cause | Fix |
|---|---|---|
| Boxes trail behind people; live video freezes for seconds | `MODEL=yolo11n.pt` runs on the box CPU (1–3 pictures/s for 4 cameras), and the live video sent the NEWEST picture with OLDER boxes | NPU model used automatically when `yolo11n_rknn_model` is in `edge/`; live video sends the picture the AI looked at with its own boxes (`LIVE_SYNC`) |
| People bent over the counter / partly behind a table not detected | `CONFIDENCE=0.40` threw their boxes away before the tracker saw them | `CONFIDENCE=0.15` + ByteTrack second round keeps existing people; new people still need 0.45 |
| Same person gets a new ID on the next camera | clothes colours change with the light, and the colour check vetoed the match; a 2–3 s gap between cameras fell between handoff and reclaim | gray-world colour balance (`REID_EVEN_LIGHT`), colours never veto when face/body agree, `OVERLAP_SECONDS=3`, `RECLAIM_AFTER_SECONDS=1` |
| A trolley / bag pushed by someone becomes a "person" | it moves, so the move check passed | `PERSON_CONF_PEAK`, `MAX_BODY_WIDTH` |
| Floor spot jumps when legs disappear behind displays | box bottom is not the feet | floor spot from the head and body height (`est` in the live video: "Feet hidden · spot from head"); saved obstacles (Floor map) |

### Models on the box

Run `python check_models.py` on the box. It lists what is installed and what
is missing (NPU model + runtime, face / body recognition, gender / age,
hardware video decoder) and how to add each. In order of importance:

1. **NPU person model** – `yolo11n_rknn_model` folder in `edge/`,
   `pip install rknn-toolkit-lite2`, `librknnrt.so` (see B.4).
2. **Recognition models** – `python download_models.py` (face finder, SFace face
   recognition, YoutuReID whole body, gender, age). Without them people are
   matched across cameras by clothes colour and height only.
3. **Pose model (recommended)** – knows which body parts are hidden and finds the
   feet from the ankles. On an x86 Linux PC / WSL2:
   `yolo export model=yolo11n-pose.pt format=rknn name=rk3588`, copy
   `yolo11n-pose_rknn_model` to `edge/`, set `MODEL=./yolo11n-pose_rknn_model`.
4. Optional: PA-100K body attributes (gender / age without a face).

## Feet confirmed before an area or In / Out is recorded

A box can end above the feet (legs hidden by a table or the counter) without
touching the picture border; its bottom is then NOT on the floor. So a box only
counts as feet on the floor when the body height it gives looks like a whole
person (`FOOT_MIN_HEIGHT`, and at least `FOOT_HEIGHT_SHARE` of the height this
person had when their feet were seen). Otherwise the person keeps the area they
were in, and no In / Out is counted from that box. Shop areas are flat
outlines drawn on each camera's picture (Camera page → Shop areas): a person is
in an area when their confirmed feet point is inside its outline.

## Shop areas (3D) and track_region

Camera page → camera → **Shop areas (3D)** (saved in `camera.floor_areas`):

1. **3D floor — automatic.** Every camera hangs at the same fixed height,
   `CAMERA_HEIGHT` = **3.25 m**. Until you adjust it, each camera uses an
   automatic floor (usual tilt 25°, Tapo C230 lens: 75° across, 41° up-down,
   88° corner to corner = lens width 63.6° at the centre + lens curve −0.52).
   The Tapo lens is wide and round, so a flat floor looks bent at the sides
   of the picture; the lens curve straightens it before anything is measured.
   To fit it to a camera: open the camera page with the live video playing
   while people walk past, click **Adjust 3D floor** → **Auto-fit tilt from
   people** (the tilt that makes everyone's feet on the floor and head about
   1.65 m up), then fine-tune the sliders until the 1 m grid lies flat on the
   floor and follows the tile lines, also at the sides (Lens curve). Save.
   No measuring in the shop is needed.
2. **+ Add area**: click the corners of the area on the floor (counter, each
   Point of Purchase display, the Traffic walkway outside...), give it any
   name and a kind, and a height range (Z). Areas must not overlap. Edit or
   delete it any time.

The box then knows, for every full-body person, their floor spot X / Y, their
height Z and the area they are in (shown live on the camera details page, with
a top-view floor map). Every `cctv_event` row has a `direction` and a
`track_region` (where the person was):

| Event | direction | track_region |
|---|---|---|
| Walks into the shop (a Purchasing / Counter area, or seen on an Inside-only camera) | In | Purchasing, or Counter |
| Moves to the other kind of area inside (Purchasing ↔ Counter) | In | Counter / Purchasing |
| Walks from inside onto the **Traffic** walkway | Passed By | Traffic |
| Walks from inside to a spot outside every area | Out | Out of Range |
| Not seen by any camera for `TRACK_KEEP_SECONDS` (or box restarted) | Out | Out of Range |

(`Not Detected` and `Out of Range` are the column defaults; the box never
writes `Not Detected`.)

The area's own name (e.g. "POP Display – Shoes") is only shown on the live
video, not saved.

People are counted once per visit (track_id), so the extra In rows for areas
never make "People Walk-in" bigger. Time in the shop (dashboard "Top 5
Longest Stay") = from each In until the next Passed By (or Out), added up
when a visitor comes back.

Run `supabase/cctv_event_traffic.sql` once first (it removes
`camera.count_line`, renames Outside Shop areas to Traffic, and sets the
direction / track_region values).

Test on the PC with a saved area file:
`python main.py --offline --source test.mp4 --zones areas.json --show`

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
(about 190 MB into `edge/models/`, not in GitHub). Then restart `main.py`.

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

## Shop Floor Map (Camera details page)

Below Shop Areas, a top view of the shop (for Bukit Tinggi: the furniture plan
layout, 7.314 m × 5.89 m, glass front on the diagonal, the Traffic walkway in
front). It shows every camera of the edge box, where it hangs and which way it
looks, each camera's areas laid onto the floor, the people on the selected
camera, and obstacles. **Adjust on map**: drag the camera, set Facing / Tilt,
or drag the corners of its areas (the corner moves on the picture too), then
**Save to camera** (this places the camera on the shop plan, so all cameras
share one floor and a person seen by 2 cameras lands on one spot).
**Save found obstacles** stores the tables / counter / mannequins the box found
(`floor_areas.obstacles`); a person whose box ends on one has their floor spot
worked out from their head. The live video shows Store metrics (Passed By,
Walk-in, Inside now) in its corner instead of the small floor map.

## Not in this version yet (phase 2)

- Face recognition → `recognition_event`. The SQL function `match_face`
  (members and staff, from `face_template`) is ready for it;
  `match_member_face` still works for members only.
- Rows waiting while the internet is down are kept in memory, so a power cut
  during an outage loses them.
