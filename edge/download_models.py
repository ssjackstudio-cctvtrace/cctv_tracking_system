"""Download the gender / age models into edge/models (about 48 MB).

Run once on each machine (your PC and the edge box), with the .venv active:
    python download_models.py
"""

import os
import sys

import requests

MODELS = {
    "face_detection_yunet_2023mar.onnx":
        "https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx",
    "gender_googlenet.onnx":
        "https://media.githubusercontent.com/media/onnx/models/main/validated/vision/body_analysis/age_gender/models/gender_googlenet.onnx",
    "age_googlenet.onnx":
        "https://media.githubusercontent.com/media/onnx/models/main/validated/vision/body_analysis/age_gender/models/age_googlenet.onnx",
}

folder = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")
os.makedirs(folder, exist_ok=True)

for name, url in MODELS.items():
    path = os.path.join(folder, name)
    if os.path.isfile(path) and os.path.getsize(path) > 100_000:
        print(f"already there: {name}")
        continue
    print(f"downloading {name} ...", flush=True)
    r = requests.get(url, timeout=120)
    if r.status_code != 200 or len(r.content) < 100_000:
        sys.exit(f"Failed to download {name} (HTTP {r.status_code}). Check the internet and try again.")
    with open(path + ".part", "wb") as f:
        f.write(r.content)
    os.replace(path + ".part", path)
    print(f"  saved {len(r.content) / 1e6:.1f} MB")

print("Done. Gender / age estimation turns on the next time main.py starts.")
