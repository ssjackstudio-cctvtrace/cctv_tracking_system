"""Make the NPU (RK3588) copy of a stronger person detector: yolo11s instead of yolo11n.

Why: yolo11n is the smallest YOLO. In the shop it misses people who are small in the
picture (far end of the shop, the walkway), partly hidden behind displays or the counter,
or sitting; then they get no track_id, or a new one when they are found again.
yolo11s finds clearly more of them, and on the RK3588's NPU it still runs about
25-30 pictures a second per NPU core (the box has 3), enough for 4 cameras at
DECODE_MAX_FPS=10-15.

The RKNN converter (rknn-toolkit2) only runs on an x86-64 Linux PC (or WSL on Windows)
with Python 3.10-3.12, NOT on the box itself. On that PC:

    python3 -m venv rk && . rk/bin/activate
    pip install "ultralytics>=8.3" rknn-toolkit2 onnx onnxslim
    python export_rknn.py                 # yolo11s → yolo11s_rknn_model/
    python export_rknn.py yolo11m.pt      # any other size

Then copy the folder to the box (edge folder) and set in edge/.env:

    MODEL=./yolo11s_rknn_model

and restart:  sudo systemctl restart cctv-edge
Check the speed in the log ("started (model ...)") and with  python check_models.py.
If the live video lags, set DECODE_MAX_FPS=10 in edge/.env (10 pictures a second is plenty
for people walking in a shop). To go back: MODEL=./yolo11n_rknn_model.
"""

from __future__ import annotations

import os
import shutil
import sys


def main() -> None:
    weights = sys.argv[1] if len(sys.argv) > 1 else "yolo11s.pt"
    try:
        from ultralytics import YOLO
    except ImportError:
        sys.exit("pip install ultralytics rknn-toolkit2 onnx onnxslim  (x86-64 Linux / WSL, Python 3.10-3.12)")
    model = YOLO(weights)  # downloads yolo11s.pt the first time
    # 640x640, the same picture size as IMAGE_SIZE=640 in edge/.env; name = the chip
    out = model.export(format="rknn", name="rk3588", imgsz=640)
    folder = os.path.splitext(os.path.basename(weights))[0] + "_rknn_model"
    if out and os.path.isdir(out) and os.path.abspath(out) != os.path.abspath(folder):
        shutil.move(out, folder)
    print(f"\nDone: {folder}/ → copy it into the edge folder on the box and set MODEL=./{folder} in edge/.env")


if __name__ == "__main__":
    main()
