"""Download the optional model files and offline copies used by Sightline.

    python scripts/fetch_models.py            # everything
    python scripts/fetch_models.py --opencv   # only YuNet + SFace (face detection with landmarks + reference matching)
    python scripts/fetch_models.py --mediapipe  # only the browser face-landmark library + model (Observation lab offline)

What it fetches (all open source, check the licences before any commercial use):
  * YuNet face detector  (MIT)        - OpenCV Zoo   -> models/face_detection_yunet_2023mar.onnx
  * SFace face recogniser (Apache-2.0) - OpenCV Zoo   -> models/face_recognition_sface_2021dec.onnx
  * @mediapipe/tasks-vision 0.10.14 (Apache-2.0) - npm -> app/static/vendor/mediapipe/
  * Face Landmarker model (Apache-2.0) - Google       -> models/face_landmarker.task

YuNet/SFace are checked against the SHA-256 published in the OpenCV Zoo repository and the npm package against
the integrity hash published by the npm registry. Files that fail a check are deleted, never used.
Only the Python standard library is needed.
"""
import argparse
import base64
import hashlib
import io
import json
import shutil
import sys
import tarfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODELS = ROOT / "models"
VENDOR = ROOT / "app" / "static" / "vendor" / "mediapipe"
MP_VERSION = "0.10.14"

OPENCV_MODELS = [
    ("face_detection_yunet_2023mar.onnx", "face_detection_yunet",
     "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4"),
    ("face_recognition_sface_2021dec.onnx", "face_recognition_sface",
     "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79"),
]
LANDMARKER_URL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"


def fetch(url, timeout=120):
    req = urllib.request.Request(url, headers={"User-Agent": "sightline-fetch/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        total = int(r.headers.get("Content-Length") or 0)
        buf, done = io.BytesIO(), 0
        while True:
            chunk = r.read(1 << 16)
            if not chunk:
                break
            buf.write(chunk)
            done += len(chunk)
            if total:
                print(f"\r    {done / 1e6:6.1f} / {total / 1e6:.1f} MB", end="", flush=True)
        print()
        return buf.getvalue()


def sha256(b):
    return hashlib.sha256(b).hexdigest()


def opencv_models():
    ok = True
    for name, folder, want in OPENCV_MODELS:
        dest = MODELS / name
        if dest.exists() and sha256(dest.read_bytes()) == want:
            print(f"[ok]   {name} already present and verified")
            continue
        urls = [f"https://github.com/opencv/opencv_zoo/raw/main/models/{folder}/{name}",
                f"https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/{folder}/{name}"]
        for url in urls:
            print(f"[get]  {name}\n       {url}")
            try:
                data = fetch(url)
            except Exception as e:  # network / HTTP errors
                print(f"       failed: {e}")
                continue
            if data.startswith(b"version https://git-lfs"):
                print("       got a Git-LFS pointer instead of the file, trying next mirror")
                continue
            if sha256(data) != want:
                print(f"       SHA-256 mismatch ({sha256(data)[:16]}...), discarded")
                continue
            dest.write_bytes(data)
            print(f"[ok]   saved {dest.relative_to(ROOT)} ({len(data) / 1e6:.1f} MB, SHA-256 verified)")
            break
        else:
            ok = False
            print(f"[FAIL] could not download a verified copy of {name}")
    return ok


def mediapipe_vendor():
    marker = VENDOR / "vision_bundle.mjs"
    if marker.exists() and (VENDOR / "wasm" / "vision_wasm_internal.wasm").exists():
        print(f"[ok]   MediaPipe tasks-vision already in {VENDOR.relative_to(ROOT)}")
        return True
    try:
        meta = json.loads(fetch(f"https://registry.npmjs.org/@mediapipe/tasks-vision/{MP_VERSION}", 60))
        tarball_url, integrity = meta["dist"]["tarball"], meta["dist"]["integrity"]
        print(f"[get]  @mediapipe/tasks-vision {MP_VERSION}\n       {tarball_url}")
        data = fetch(tarball_url)
    except Exception as e:
        print(f"[FAIL] npm download failed: {e}")
        return False
    algo, digest = integrity.split("-", 1)
    if algo != "sha512" or base64.b64encode(hashlib.sha512(data).digest()).decode() != digest:
        print("[FAIL] npm integrity check failed, discarded")
        return False
    wanted = {"package/vision_bundle.mjs": VENDOR / "vision_bundle.mjs", "package/LICENSE": VENDOR / "LICENSE"}
    for f in ("vision_wasm_internal.js", "vision_wasm_internal.wasm", "vision_wasm_nosimd_internal.js", "vision_wasm_nosimd_internal.wasm"):
        wanted[f"package/wasm/{f}"] = VENDOR / "wasm" / f
    (VENDOR / "wasm").mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
        for m in tar.getmembers():
            dest = wanted.get(m.name)
            if dest and m.isfile():          # only copy the files we name; never trust archive paths
                with tar.extractfile(m) as src, open(dest, "wb") as out:
                    shutil.copyfileobj(src, out)
    missing = [str(p.name) for k, p in wanted.items() if not p.exists() and not k.endswith("LICENSE")]
    if missing:
        print(f"[FAIL] package is missing {missing}")
        return False
    print(f"[ok]   saved MediaPipe library to {VENDOR.relative_to(ROOT)} (npm integrity verified)")
    return True


def landmarker_model():
    dest = MODELS / "face_landmarker.task"
    if dest.exists() and dest.stat().st_size > 1_000_000:
        print(f"[ok]   face_landmarker.task already present (SHA-256 {sha256(dest.read_bytes())[:16]}...)")
        return True
    print(f"[get]  face_landmarker.task\n       {LANDMARKER_URL}")
    try:
        data = fetch(LANDMARKER_URL)
    except Exception as e:
        print(f"[FAIL] {e}")
        return False
    if len(data) < 1_000_000 or not data[:2] == b"PK":   # .task files are zip archives
        print("[FAIL] download does not look like a .task model, discarded")
        return False
    dest.write_bytes(data)
    print(f"[ok]   saved models/face_landmarker.task ({len(data) / 1e6:.1f} MB). Google publishes no checksum;"
          f" record this SHA-256 in your report: {sha256(data)}")
    return True


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--opencv", action="store_true", help="only YuNet + SFace")
    ap.add_argument("--mediapipe", action="store_true", help="only the MediaPipe library + face landmark model")
    a = ap.parse_args()
    both = not (a.opencv or a.mediapipe)
    MODELS.mkdir(exist_ok=True)
    results = []
    if a.opencv or both:
        results.append(opencv_models())
    if a.mediapipe or both:
        results += [mediapipe_vendor(), landmarker_model()]
    print("\nDone." if all(results) else "\nSome downloads failed (see above). The app still runs; the matching features stay disabled.")
    print("Restart Sightline so it picks up new files.")
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
