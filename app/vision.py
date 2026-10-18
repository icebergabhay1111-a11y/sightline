"""Face DETECTION, image-quality metrics and optional reference MATCHING (OpenCV).

Detection finds where faces are. It does not say who they are.
Matching produces a similarity number between two face crops. It is not proof of identity.

Detector : YuNet (OpenCV Zoo, MIT) if models/face_detection_yunet_2023mar.onnx is present and its SHA-256 matches
           the official one; otherwise the OpenCV Haar cascade (bundled with opencv-python 4.x) as a fallback.
Matcher  : SFace (OpenCV Zoo, Apache-2.0), 128-d embeddings; needs YuNet landmarks for alignment.
"""
import hashlib
import math
import platform
import threading

import cv2
import numpy as np

from . import config, storage

YUNET = "face_detection_yunet_2023mar.onnx"
SFACE = "face_recognition_sface_2021dec.onnx"
# Official hashes = the Git-LFS object ids published in github.com/opencv/opencv_zoo
OFFICIAL_SHA256 = {
    YUNET: "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
    SFACE: "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79",
}
MAX_SIDE = 1280        # detection runs on images downscaled to this long side
MIN_FACE_PX = 64       # below this, matching is unreliable (SFace aligns to 112x112)
MAX_VIDEO_FRAMES = 240


def sha256_file(p) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


class Engine:
    def __init__(self):
        self.lock = threading.Lock()
        self.haar = None
        if hasattr(cv2, "CascadeClassifier") and hasattr(cv2, "data"):
            self.haar = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
        self.yunet = None
        self.sface = None
        self.model_state = {}   # filename -> 'missing' | 'verified' | 'hash_mismatch' | 'load_error: ...'
        self._load()

    # ------------------------------------------------------------------ models
    def _load(self):
        for name in (YUNET, SFACE):
            p = config.MODELS_DIR / name
            if not p.exists():
                self.model_state[name] = "missing"
                continue
            if sha256_file(p) != OFFICIAL_SHA256[name]:
                self.model_state[name] = "hash_mismatch"   # refuse to load unknown ONNX files
                continue
            try:
                if name == YUNET:
                    self.yunet = cv2.FaceDetectorYN.create(str(p), "", (320, 320), 0.7, 0.3, 5000)
                else:
                    self.sface = cv2.FaceRecognizerSF.create(str(p), "")
                self.model_state[name] = "verified"
            except Exception as e:  # cv2.error or missing API in old OpenCV
                self.model_state[name] = f"load_error: {e}"

    @property
    def detector_name(self) -> str:
        if self.yunet:
            return "YuNet 2023mar (OpenCV Zoo)"
        return "OpenCV Haar cascade (fallback, no landmarks)" if self.haar is not None else "none available"

    @property
    def matching_available(self) -> bool:
        return self.yunet is not None and self.sface is not None

    def status(self) -> dict:
        return {
            "detector": self.detector_name,
            "detector_has_landmarks": self.yunet is not None,
            "matching_available": self.matching_available,
            "models": self.model_state,
            "match_threshold": config.MATCH_COSINE_THRESHOLD,
            "landmarker_model_local": (config.MODELS_DIR / "face_landmarker.task").exists(),
            "mediapipe_local": (config.ROOT / "app" / "static" / "vendor" / "mediapipe" / "vision_bundle.mjs").exists(),
            "hint": None if self.matching_available else
            "Run `python scripts/fetch_models.py` to download YuNet + SFace (hash-verified), then restart.",
        }

    def software(self) -> dict:
        return {
            "opencv": cv2.__version__, "python": platform.python_version(),
            "detector": self.detector_name,
            "recognizer": "SFace 2021dec (OpenCV Zoo)" if self.sface else "not loaded",
            "model_sha256": {k: OFFICIAL_SHA256[k] for k, v in self.model_state.items() if v == "verified"},
            "match_cosine_threshold": config.MATCH_COSINE_THRESHOLD,
        }

    # ---------------------------------------------------------------- detection
    def detect(self, bgr: np.ndarray, score_threshold: float = 0.7) -> list:
        h, w = bgr.shape[:2]
        scale = min(1.0, MAX_SIDE / max(h, w))
        img = cv2.resize(bgr, (max(1, int(w * scale)), max(1, int(h * scale)))) if scale < 1 else bgr
        faces = []
        if self.yunet is not None:
            with self.lock:
                self.yunet.setInputSize((img.shape[1], img.shape[0]))
                self.yunet.setScoreThreshold(float(score_threshold))
                _, det = self.yunet.detect(img)
            for r in (det if det is not None else []):
                r = np.asarray(r, dtype=np.float32).copy()
                r[:14] /= scale
                x, y, bw, bh = (int(round(v)) for v in r[:4])
                faces.append(self._face(bgr, (x, y, bw, bh), float(r[14]), r[4:14].reshape(5, 2), r.tolist()))
        elif self.haar is not None:
            gray = cv2.equalizeHist(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY))
            for (x, y, bw, bh) in self.haar.detectMultiScale(gray, 1.1, 5, minSize=(40, 40)):
                faces.append(self._face(bgr, (int(x / scale), int(y / scale), int(bw / scale), int(bh / scale)),
                                        None, None, None))
        else:
            raise ValueError("No face detector available. Install opencv-python 4.x or run scripts/fetch_models.py.")
        faces.sort(key=lambda f: (f["box"][1], f["box"][0]))
        for i, f in enumerate(faces):
            f["index"] = i
        return faces

    def _face(self, bgr, box, score, lm, det_row):
        H, W = bgr.shape[:2]
        x, y, w, h = box
        x, y = max(0, x), max(0, y)
        w, h = max(1, min(w, W - x)), max(1, min(h, H - y))
        return {"box": [x, y, w, h], "score": None if score is None else round(score, 3),
                "landmarks": None if lm is None else [[round(float(a), 1), round(float(b), 1)] for a, b in lm],
                "det_row": det_row, "quality": face_quality(bgr, (x, y, w, h), lm)}

    # ------------------------------------------------------------------ matching
    def embed(self, bgr: np.ndarray, face: dict) -> np.ndarray:
        """128-d SFace embedding of a detected face (needs the YuNet detection row for alignment)."""
        if not self.matching_available:
            raise RuntimeError("Matching models not available")
        if not face.get("det_row"):
            raise RuntimeError("Face has no landmarks (detected with fallback detector); re-run detection")
        row = np.asarray(face["det_row"], dtype=np.float32).reshape(1, 15)
        with self.lock:
            aligned = self.sface.alignCrop(bgr, row)
            feat = self.sface.feature(aligned)
        return np.asarray(feat, dtype=np.float32).reshape(-1)


engine = Engine()


def cosine(a, b) -> float:
    a, b = np.asarray(a, np.float32).reshape(-1), np.asarray(b, np.float32).reshape(-1)
    d = float(np.linalg.norm(a) * np.linalg.norm(b))
    return float(np.dot(a, b) / d) if d else 0.0


def pack_embedding(v) -> bytes:
    return storage.encrypt_bytes(np.asarray(v, np.float32).tobytes())


def unpack_embedding(b: bytes) -> np.ndarray:
    return np.frombuffer(storage.decrypt_bytes(bytes(b)), dtype=np.float32)


# ------------------------------------------------------------------ quality
def face_quality(bgr, box, lm) -> dict:
    x, y, w, h = box
    crop = bgr[y:y + h, x:x + w]
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) if crop.size else np.zeros((8, 8), np.uint8)
    g = cv2.resize(gray, (128, 128))
    q = {"width": int(w), "height": int(h), "brightness": round(float(gray.mean()), 1),
         "contrast": round(float(gray.std()), 1),
         "sharpness": round(float(cv2.Laplacian(g, cv2.CV_64F).var()), 1),
         "yaw_ratio": None, "roll_deg": None}
    flags = []
    if min(w, h) < MIN_FACE_PX:
        flags.append("small_face")
    if q["brightness"] < 60:
        flags.append("dark")
    if q["brightness"] > 200:
        flags.append("overexposed")
    if q["contrast"] < 25:
        flags.append("low_contrast")
    if q["sharpness"] < 40:
        flags.append("blurry")
    if lm is not None:
        re_, le, nose = lm[0], lm[1], lm[2]
        eye = math.hypot(le[0] - re_[0], le[1] - re_[1]) or 1.0
        q["yaw_ratio"] = round(float((nose[0] - (re_[0] + le[0]) / 2) / eye), 2)
        q["roll_deg"] = round(math.degrees(math.atan2(le[1] - re_[1], le[0] - re_[0])), 1)
        if abs(q["yaw_ratio"]) > 0.35 or abs(q["roll_deg"]) > 25:
            flags.append("non_frontal")
    q["flags"] = flags
    q["suitable_for_matching"] = not flags
    return q


def image_quality(bgr) -> dict:
    h, w = bgr.shape[:2]
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    s = min(1.0, 640 / max(h, w))
    g = cv2.resize(gray, (max(1, int(w * s)), max(1, int(h * s)))) if s < 1 else gray
    q = {"width": w, "height": h, "megapixels": round(w * h / 1e6, 2), "brightness": round(float(gray.mean()), 1),
         "contrast": round(float(gray.std()), 1), "sharpness": round(float(cv2.Laplacian(g, cv2.CV_64F).var()), 1)}
    flags = []
    if max(h, w) < 640:
        flags.append("low_resolution")
    if q["brightness"] < 60:
        flags.append("dark")
    if q["brightness"] > 200:
        flags.append("overexposed")
    if q["sharpness"] < 30:
        flags.append("blurry")
    q["flags"] = flags
    return q


# ----------------------------------------------------------------- analysis
def decode_image(data: bytes):
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Not a readable image")
    return img


def _summary(counts, n):
    with_faces = sum(1 for c in counts if c)
    return {"frames_analyzed": n, "frames_with_faces": with_faces, "max_faces": max(counts) if counts else 0,
            "mean_faces": round(sum(counts) / n, 2) if n else 0}


def analyze_image(data: bytes, score_threshold=0.7) -> dict:
    img = decode_image(data)
    faces = engine.detect(img, score_threshold)
    return {"kind": "image", "image_quality": image_quality(img),
            "frames": [{"index": 0, "t": 0.0, "face_count": len(faces), "faces": faces}],
            "summary": _summary([len(faces)], 1)}


def analyze_video(path: str, sample_every_s=1.0, score_threshold=0.7) -> dict:
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise ValueError("Video could not be opened (unsupported codec?). Try converting it to MP4 (H.264).")
    try:
        fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        width, height = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        step = max(1, int(round(fps * max(0.1, sample_every_s))))
        if total and total / step > MAX_VIDEO_FRAMES:
            step = int(math.ceil(total / MAX_VIDEO_FRAMES))
        frames, idx = [], 0
        while True:
            if not cap.grab():
                break
            if idx % step == 0:
                ok, img = cap.retrieve()
                if ok:
                    faces = engine.detect(img, score_threshold)
                    frames.append({"index": idx, "t": round(idx / fps, 2), "face_count": len(faces),
                                   "brightness": round(float(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).mean()), 1),
                                   "faces": faces})
                if len(frames) >= MAX_VIDEO_FRAMES:
                    break
            idx += 1
        if not frames:
            raise ValueError("No frames could be read from the video")
        counts = [f["face_count"] for f in frames]
        return {"kind": "video",
                "video": {"fps": round(fps, 2), "frame_count": total or idx, "width": width, "height": height,
                          "duration_s": round((total or idx) / fps, 2), "sample_step_frames": step,
                          "sample_every_s": round(step / fps, 2)},
                "frames": frames, "summary": _summary(counts, len(frames))}
    finally:
        cap.release()


# ------------------------------------------------------------ frame retrieval
def read_frame(kind: str, stored_name: str, index: int):
    if kind == "image":
        return decode_image(storage.get(stored_name))
    with storage.tempfile_of(stored_name, ".vid") as p:
        cap = cv2.VideoCapture(p)
        try:
            i = 0
            while cap.grab():          # sequential read = same frames as during analysis
                if i == index:
                    ok, img = cap.retrieve()
                    if ok:
                        return img
                    break
                i += 1
        finally:
            cap.release()
    raise ValueError("Frame not available")


def annotate(bgr, faces, selected=None) -> bytes:
    img = bgr.copy()
    H, W = img.shape[:2]
    t = max(2, round(max(H, W) / 500))
    for f in faces:
        x, y, w, h = f["box"]
        sel = selected is not None and f["index"] == selected
        col = (0, 180, 255) if sel else (240, 200, 60)    # BGR
        cv2.rectangle(img, (x, y), (x + w, y + h), col, t)
        label = f"#{f['index'] + 1}" + (f"  {f['score']:.2f}" if f.get("score") is not None else "")
        fs = max(0.5, max(H, W) / 1400)
        (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, fs, 2)
        cv2.rectangle(img, (x, max(0, y - th - 8)), (x + tw + 8, max(th + 8, y)), col, -1)
        cv2.putText(img, label, (x + 4, max(th + 2, y - 5)), cv2.FONT_HERSHEY_SIMPLEX, fs, (20, 20, 20), 2, cv2.LINE_AA)
        for lx, ly in (f.get("landmarks") or []):
            cv2.circle(img, (int(lx), int(ly)), max(2, t), (0, 0, 255), -1)
    return _jpeg(img)


def crop_face(bgr, face, pad=0.25, max_side=256) -> bytes:
    x, y, w, h = face["box"]
    H, W = bgr.shape[:2]
    px, py = int(w * pad), int(h * pad)
    c = bgr[max(0, y - py):min(H, y + h + py), max(0, x - px):min(W, x + w + px)]
    s = min(1.0, max_side / max(c.shape[:2]))
    if s < 1:
        c = cv2.resize(c, (int(c.shape[1] * s), int(c.shape[0] * s)))
    return _jpeg(c)


def thumbnail(bgr, max_side=320) -> bytes:
    s = min(1.0, max_side / max(bgr.shape[:2]))
    return _jpeg(cv2.resize(bgr, (int(bgr.shape[1] * s), int(bgr.shape[0] * s))) if s < 1 else bgr)


def _jpeg(img, q=88) -> bytes:
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, q])
    if not ok:
        raise ValueError("JPEG encoding failed")
    return buf.tobytes()
