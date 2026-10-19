"""Download the gender / age and person recognition models into edge/models (about 190 MB).

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
    # Recognise the same person on every camera (edge/edge/reid.py): face + whole body
    "face_recognition_sface_2021dec.onnx":
        "https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx",
    "person_reid_youtu_2021nov.onnx":
        "https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/person_reid_youtureid/person_reid_youtu_2021nov.onnx",
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

print("Done. Gender / age estimation and face / body recognition turn on the next time main.py starts.")
