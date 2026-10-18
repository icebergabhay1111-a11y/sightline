# Research analysis and technology choice

This document covers Phase 1 of the project brief: what the research deck *"Criminal Investigation Using Face
Recognition - Research Study"* and the team's stack report say, which tools are practical for a student project on a
Windows laptop, and why Sightline uses the stack it does. Facts about models and licences were checked against the
official repositories in October 2026 (links at the end).

## 1. What the presentation contributes

| Topic in the deck | What it says | What it means for the app |
|---|---|---|
| Pipeline | detection, alignment, feature extraction (embedding), matching, human review | Sightline keeps these as separate visible steps; human review is a required, recorded step |
| Classical vs deep learning | Eigenfaces/PCA vs CNNs (ResNet-34, ArcFace, EfficientNet with attention) | We use a small CNN detector (YuNet) and a MobileFaceNet embedder (SFace); no training needed |
| Reported accuracy | 99.38% with a ResNet-34 (dlib / face_recognition) on a 200-image criminal database | See caution below: this number is dlib's published LFW benchmark, not a result on that database |
| Low-resolution / CCTV | attention-guided EfficientNet for surveillance images | Not implemented (no trained weights, needs GPU). Instead every face gets quality flags (small, blurry, dark, non-frontal) and matching warns on them |
| FRT vs forensics | very low error rates for high-quality images vs fingerprints/toolmarks, with a caveat about low-quality police images | Benchmark figures are shown as benchmark figures only; the app never states an accuracy for your images |
| Demographic bias (NIST FRVT) | best algorithms small differentials; many algorithms worse for women and darker skin, and on poor images | Report and UI state that error rates differ between groups; matching results are leads only |
| Wrongful arrests (Williams v. Detroit) | an FRT lead treated as identification led to a wrongful arrest | No automatic identification; a candidate needs a recorded human decision, and the strongest decision available is "needs independent verification" |
| Clearview AI | scraped photos, fines, bans | No scraping; reference images need a consent reference, are encrypted, and expire |
| India: DPDP Act 2023, NAFRIS/AFRS, FRT Bill 2023, Puttaswamy test | legality, legitimate aim, proportionality | Consent / legal-authority note is required for interviews, webcam capture and references; demo data is labelled; retention and deletion are built in |
| Ethics | consent, function creep, accountability, chilling effect | Audit log of every action, role-based access, explicit disclaimers on every page and report |

**Caution about the 99.38% figure.** dlib's model README states the ResNet model reaches 0.993833 on the LFW benchmark.
The deck's cited paper reports the same 99.38%, so it is very likely quoting the library's LFW result rather than
measuring accuracy on its own 200-image set. LFW is a set of mostly frontal, well-lit celebrity photos. Do not
assume that number transfers to CCTV frames or to our demo. The dlib README also says part of its training data was
scraped from the internet, which conflicts with the deck's own ethics section.

Our own quick check with SFace on altered copies of one public-domain photo shows how fast scores drop with image
quality: identical 1.00, darker/scaled/cropped 0.975, mirrored 0.944, downscaled to a ~30 px face 0.741, **blurred
0.246** - below the 0.363 reference threshold, i.e. a false non-match for the same person. This is a plumbing check,
not an accuracy study.

## 2. Technology comparison

Licences: "code" and "weights" can differ, and for face recognition the weights matter most.

| Option | Task | Licence (code / weights) | Windows install | CPU-only | Notes | Verdict |
|---|---|---|---|---|---|---|
| **OpenCV Haar cascade** | detection | BSD / bundled | `pip install opencv-python` | yes, fast | no landmarks, many false positives; **removed in OpenCV 5.0** | fallback only (we pin OpenCV < 5) |
| **YuNet 2023mar (OpenCV Zoo)** | detection + 5 landmarks | MIT / MIT | built into OpenCV 4.8+, 0.2 MB ONNX | yes, real time | WIDER FACE val AP 0.884 / 0.866 / 0.750 (easy/medium/hard) | **chosen detector** |
| **SFace 2021dec (OpenCV Zoo)** | 128-d embedding | Apache-2.0 / Apache-2.0 | built into OpenCV, 38.7 MB ONNX | yes | 99.40% on the zoo's LFW evaluation; reference cosine threshold 0.363 from the OpenCV sample | **chosen matcher (optional module)** |
| InsightFace (SCRFD + ArcFace) | detection + embedding | MIT / **non-commercial research only** | `insightface` needs onnxruntime; C++ build tools sometimes | yes (slow for large models) | state of the art accuracy | good for research comparison, not chosen (weights licence, heavier) |
| dlib / face_recognition (ResNet) | detection + embedding | Boost / public domain | needs CMake + Visual Studio C++ build tools on Windows | yes | LFW 99.38%; training data partly scraped | not chosen (painful Windows install, data provenance) |
| DeepFace | wrapper over many models | MIT / depends on backend | pulls TensorFlow (large) | slow | good for experiments | not chosen (heavy, many weight licences) |
| MediaPipe Face Detector | detection | Apache-2.0 | `pip install mediapipe` | yes | short-range selfie model | not needed (YuNet covers it) |
| **MediaPipe Face Landmarker (tasks-vision 0.10.14)** | 478 landmarks, 52 blendshapes, head pose | Apache-2.0 | runs in the browser, nothing to install | yes (GPU if available) | no per-frame tracking-confidence output | **chosen for the observation module** |
| Ultralytics YOLO-face | detection | **AGPL-3.0** | `pip install ultralytics` + PyTorch | slow without GPU | AGPL obligations | not chosen |
| Exadel CompreFace | ready-made REST service | Apache-2.0 | Docker | yes | heavy for a laptop demo | not chosen |
| EfficientNet + attention (deck) | low-res recognition | research code | needs training data + GPU | no | no consented training data available | documented as future work |
| FAISS | vector search | MIT | `faiss-cpu` wheels | yes | useful for >10k references | not needed: a demo has a handful of references, NumPy cosine is exact and simpler |
| AWS Rekognition / Azure Face | cloud APIs | paid, terms of use | n/a | n/a | Azure restricts face identification access | excluded by brief (no paid APIs) |

Web and storage:

| Option | Why / why not |
|---|---|
| **FastAPI + Uvicorn** | typed request validation, automatic docs at `/docs`, async-friendly; easy for a Python student |
| Flask | equally fine; FastAPI chosen for built-in validation |
| **SQLite** | zero setup on Windows, single file, enough for a demo |
| PostgreSQL + MinIO (stack report) | production-grade but needs servers/Docker; unnecessary for a local prototype |
| **Plain HTML/CSS/JS (no build step)** | no Node toolchain to install; every file readable in VS Code |
| React/Tailwind (stack report) | nicer for a large team app, but adds npm builds; not needed |
| **ReportLab** | pure Python PDF generation, BSD licence, works on Windows |
| **cryptography (Fernet)** | encrypts stored evidence, audio, reference images and embeddings |

## 3. Final stack

* Python 3.10-3.12, FastAPI, Uvicorn, SQLite, NumPy, `opencv-python` 4.x (pinned below 5), ReportLab, cryptography.
* Optional model files fetched by `scripts/fetch_models.py` and hash-checked: YuNet (MIT), SFace (Apache-2.0),
  MediaPipe tasks-vision + Face Landmarker (Apache-2.0).
* Browser front end with no build step; MediaPipe runs inside the browser so video frames never reach the server.

Hardware: any laptop that runs Chrome or Edge; 8 GB RAM is enough. No GPU needed. A webcam is only needed for the
live observation demo.

## 4. Architecture

```
Browser (Chrome/Edge)                                     FastAPI server (python run.py)
-------------------------------------------               ------------------------------------------------
Dashboard / cases / evidence / reports UI  --- JSON --->  routers: auth, cases, evidence, faces,
Face analysis viewer (annotated frames)    <--- JPEG ---           interviews, observations, misc
Interview screen (+ optional audio)        --- audio -->  vision.py   YuNet / Haar detection, quality, SFace
Observation lab:                                          consistency.py  interview difference heuristic
  webcam/video -> MediaPipe (in browser)                  reports.py  PDF + JSON export
  -> numbers only (series + events) ------- JSON --->     storage.py  Fernet-encrypted vault, SHA-256
                                                          db.py       SQLite + audit/event log
```

Folder layout and file responsibilities are listed in the README.

## 5. Maintenance notes

* **OpenCV 5.0 (released 2026)** removed the Haar cascade API. `requirements.txt` pins `opencv-python<5`. To move
  to 5.x, install the YuNet model (then Haar is not needed) and lift the pin.
* MediaPipe is pinned to tasks-vision 0.10.14 so the browser code and the offline copy stay in step.
* Model files are checked by SHA-256 at start-up; an unknown or modified ONNX file is refused.

## 6. Sources

* OpenCV Zoo YuNet README and licence: https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet
* OpenCV Zoo SFace README and licence: https://github.com/opencv/opencv_zoo/tree/main/models/face_recognition_sface
* OpenCV face_detect sample (cosine 0.363 / L2 1.128 thresholds): https://github.com/opencv/opencv/blob/4.x/samples/dnn/face_detect.py
* InsightFace licence section: https://github.com/deepinsight/insightface#license
* dlib models README (LFW 0.993833, training data, public domain): https://github.com/davisking/dlib-models
* DeepFace licence: https://github.com/serengil/deepface
* MediaPipe tasks-vision (npm, Apache-2.0): https://www.npmjs.com/package/@mediapipe/tasks-vision
* MediaPipe Face Landmarker guide: https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker
* NIST FRVT demographic effects (NISTIR 8280): https://nvlpubs.nist.gov/nistpubs/ir/2019/NIST.IR.8280.pdf
* Research deck references (Simmler & Canova 2025; arXiv 2505.14320; ACLU Williams v. Detroit; DPDP Act 2023 analyses)
