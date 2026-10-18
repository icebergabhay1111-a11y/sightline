# Sightline - AI-assisted investigation workbench (academic prototype)

Sightline is a locally run web app for a multidisciplinary college project. It demonstrates how computer vision can
support investigative *workflows*: face detection in images and video, optional comparison against consented
reference images, a structured ten-question interview, measurement of visible facial movement, and case and evidence
management with PDF reports.

> **Not validated for real criminal-investigation decisions.** A detected face is not an identified person. A
> similarity score is not proof of identity. Facial-movement measurements cannot show whether someone is lying,
> nervous or guilty, and the app never outputs such a label. Use fictional or consented demonstration data only.

Research summary, technology comparison and licences: [`docs/RESEARCH_AND_STACK.md`](docs/RESEARCH_AND_STACK.md).

---

## 1. Quick start on Windows

You need **Python 3.10 or newer** (from python.org; tick *"Add python.exe to PATH"* during install) and **Chrome or
Edge**. Internet is needed for the first install.

**Easiest:** double-click **`START_SIGHTLINE.py`**. The first time it creates a private environment, installs the
libraries (2-5 minutes, needs internet) and asks whether to download the face models. After that it starts in a few
seconds. The browser opens at http://127.0.0.1:8000. Keep the black window open; closing it stops the app.

If double-clicking opens the file in a text editor instead of running it, right-click it > *Open with* > *Python*,
or open a terminal in the folder and type `py START_SIGHTLINE.py`.

> **Browser says the download "can be dangerous"?** Browsers warn about any new, unsigned archive that contains
> program code. This project is plain source code you can read in VS Code. In Chrome: open Downloads (Ctrl+J), click
> *Keep* (or *Keep dangerous file*). In Edge: Downloads (Ctrl+J) > *...* > *Keep* > *Show more* > *Keep anyway*.

**Manual (PowerShell or Command Prompt, inside the project folder):**

```bat
py -3 -m venv .venv
.venv\Scripts\activate
python -m pip install --upgrade pip
pip install -r requirements-dev.txt
copy .env.example .env
python scripts\fetch_models.py      REM optional, ~60 MB: better detector, matching, offline observation
python run.py
```

Sign in with one of the demo accounts created on first start (password printed in the terminal, default `Demo@1234`,
set `DEMO_PASSWORD` in `.env` *before* the first run to change it):

| User | Role | Can do |
|---|---|---|
| `admin` | admin | everything, plus delete cases/evidence, manage users, reset demo data |
| `investigator` | investigator | create/edit cases, upload, analyse, interview, record review decisions |
| `viewer` | viewer | read only |

Stop the server with **Ctrl+C** in the terminal.

## 2. Running from VS Code

1. *File > Open Folder* and choose the project folder. Install the recommended **Python** extension when asked.
2. Run `START_SIGHTLINE.py` once (or the manual commands) so `.venv` exists. VS Code picks it up from `.vscode/settings.json`;
   if not, *Ctrl+Shift+P > Python: Select Interpreter > .venv*.
3. Open *Run and Debug* (Ctrl+Shift+D) and start **"Sightline: run server"** (auto-reloads when you edit Python files),
   then open http://127.0.0.1:8000. **"Sightline: run tests"** runs the test suite.
4. Or in the VS Code terminal: `.venv\Scripts\activate` then `python run.py`.

## 3. Optional model files

The app runs without any downloads (Haar cascade detector, Observation lab loads MediaPipe from the internet).
`python scripts\fetch_models.py` adds:

| File | Licence | Enables |
|---|---|---|
| `models/face_detection_yunet_2023mar.onnx` | MIT | better detection with 5 landmarks and a confidence score |
| `models/face_recognition_sface_2021dec.onnx` | Apache-2.0 | optional reference matching |
| `app/static/vendor/mediapipe/` (tasks-vision 0.10.14) | Apache-2.0 | Observation lab without the CDN |
| `models/face_landmarker.task` | Apache-2.0 | Observation lab fully offline |

YuNet and SFace are verified against the SHA-256 published by OpenCV Zoo; the app refuses to load a file whose hash
does not match. Restart the server after downloading. Options: `--opencv` or `--mediapipe` to fetch only one group.

## 4. Demo walkthrough (about 10 minutes)

1. **Dashboard** - counts, activity chart, items needing attention, vision-engine status.
2. **Cases** - open `DEMO-2026-001` (fictional). Try search, filters, *Edit* (status/priority), *Timeline* tab.
3. **Evidence** - upload an image of a consenting team member (tick *demonstration data*). Open it: SHA-256, *Verify
   integrity now*, add a reviewer note.
4. **Face analysis** - choose the case and the image, *Run face detection*. See boxes, face count, per-face quality
   flags (small, blurry, dark, non-frontal). For a short video (MP4/AVI) choose a sampling interval and use the slider
   or the chart to move through sampled frames.
5. **References** (needs SFace) - enrol a consenting person's photo with a consent reference and retention period.
   Back in Face analysis select a face and *Compare*. Record a decision for each candidate: *Rejected*,
   *Inconclusive* or *Lead - needs independent verification*. There is deliberately no "confirmed match".
6. **Interviews** - *New interview*, confirm consent, answer questions one at a time (auto-saves), add notes, mark
   follow-ups, optionally record audio. *Complete interview* shows the summary with **possible differences for
   human review** (keyword comparison; explicitly not a sign of deception). Questions are edited in **Settings**.
7. **Observation lab** - tick consent, *Start* with the webcam (or choose a video file). Watch the face mesh, head
   yaw/pitch, blink events and the live chart; add markers. *Stop*, review the measured timeline, add an
   interpretation note (human-entered), *Save to case*. The same panel is available inside the interview screen and
   adds a marker each time a question is shown.
8. **Reports** - pick the case and sections, *Generate PDF report*. Each block is tagged **MEASURED / RECORDED**,
   **MODEL OUTPUT** or **HUMAN-ENTERED**. *Export case summary (JSON)* gives the same data as JSON.
9. **Activity log** - every sign-in, upload, analysis, decision, export and deletion with user and time.
10. Sign in as `viewer` to show read-only access; as `admin` to manage users or *Reset demonstration data*.

## 5. What each module does (brief A-F)

| Module | Where | Main files |
|---|---|---|
| A. Investigation dashboard | Dashboard, Cases, Activity log | `routers/cases.py`, `routers/misc.py`, `pages/dashboard.js`, `pages/cases.js` |
| B. Detection and reference matching | Face analysis, References | `vision.py`, `routers/faces.py`, `pages/analysis.js`, `pages/references.js` |
| C. Ten-question interview | Interviews, Settings | `routers/interviews.py`, `consistency.py`, `pages/interviews.js` |
| D. Facial movement observation | Observation lab, interview side panel | `static/js/observer_core.js`, `observer.js`, `routers/observations.py`, `pages/observe.js` |
| E. Evidence and case management | Evidence, case tabs | `routers/evidence.py`, `storage.py`, `pages/evidence.js` |
| F. Reports and analytics | Reports & analytics | `reports.py`, `pages/reports.js` |

What the observation module measures: head yaw/pitch/roll from MediaPipe's facial transformation matrix; blink events
(eye-blink blendshape above 0.5, back below 0.35, 0.04-1 s); eye closures longer than 1 s; head turns (|yaw| > 20 deg
for at least 0.5 s); landmark motion (mean landmark displacement per second divided by eye distance, includes head
movement); tracking-lost periods; low-light periods; frame brightness and sharpness. MediaPipe exposes no per-frame
tracking confidence, so presence/brightness/sharpness are shown instead. Thresholds are saved with every record.

## 6. Project structure

```
sightline/
  run.py                    launcher (opens the browser)
  START_SIGHTLINE.py        one-click setup + start (standard library only)
  requirements.txt          runtime deps      requirements-dev.txt  + test deps
  .env.example              settings template
  app/
    main.py                 FastAPI app, middleware, static files
    config.py db.py         settings, SQLite schema and helpers
    security.py             PBKDF2 passwords, roles, CSRF header check, login throttling, security headers
    storage.py              Fernet-encrypted file vault, SHA-256
    vision.py               YuNet/Haar detection, quality metrics, SFace embeddings, annotation
    consistency.py          interview summary + difference heuristic
    reports.py              PDF and JSON export
    seed.py                 fictional demo data
    routers/                auth, cases, evidence, faces, interviews, observations, misc
    static/                 index.html, css/app.css, js/ (core, charts, observer, pages/*)
  scripts/fetch_models.py   optional, verified model downloads
  models/                   ONNX / .task files (not committed)
  data/                     created at runtime: sightline.db, vault/, vault.key, session.key
  tests/                    pytest suites + tests/js (Node unit tests)
  docs/RESEARCH_AND_STACK.md
```

## 7. Configuration (`.env`)

`DATA_DIR`, `MAX_UPLOAD_MB` (default 50), `SESSION_HOURS` (8), `DEMO_PASSWORD`, `COOKIE_SECURE` (1 only behind
HTTPS), `MATCH_COSINE_THRESHOLD` (0.363), `REFERENCE_RETENTION_DAYS` (30), optional fixed `DATA_KEY` /
`SESSION_SECRET`. **Back up `data/vault.key`** - without it encrypted files cannot be read. To start completely fresh,
stop the server and delete the `data` folder.

## 8. Tests

```bat
.venv\Scripts\python -m pip install -r requirements-dev.txt
.venv\Scripts\python -m pytest -q tests
REM      node --test tests\js\observer_core.test.js      (needs Node.js)
```

* `tests/test_core.py` - auth, throttling, CSRF header, roles, user rules, case CRUD/search/filters, evidence upload
  rules (type, signature, size, empty), SHA-256, encryption at rest, tamper detection, notes, safe downloads, file
  deletion with the case.
* `tests/test_modules.py` - image and video detection, quality flags, frame/face images, matching plumbing (stub),
  consent rules, retention purge, review decisions, interview flow (autosave fields, follow-up, completion, read-only
  lock, reopen, differences), audio recordings, editable questions, observations (validation, consent, summary),
  PDF sections and text, JSON export, analytics, demo reset. Three tests use the real YuNet + SFace and are skipped
  until `fetch_models.py` has been run.
* `tests/js/observer_core.test.js` - head-pose maths, blink/long-closure/head-turn/tracking/low-light events,
  landmark motion, brightness/sharpness.

Manual test cases for the demo (expected result in brackets):

| # | Action | Expected |
|---|---|---|
| 1 | Wrong password 6 times | 6th attempt refused for 10 minutes |
| 2 | Viewer opens Cases | no *New case* button; server returns 403 if forced |
| 3 | Upload `photo.exe` | rejected (file type) |
| 4 | Upload image, *Verify integrity* | "Match" with caveat about chain of custody |
| 5 | Detect on a group photo | one box per visible face; small/blurred faces flagged |
| 6 | Detect on a photo with no people | 0 faces and a note that faces can be missed |
| 7 | Enrol reference without consent tick | refused |
| 8 | Compare a face, choose a decision | decision, note, user and time stored and shown in the PDF |
| 9 | Interview: contradictory answers in Q2 and Q6 | listed under *differences for human review*, never as deception |
| 10 | Complete interview, try to edit | locked until *Reopen* |
| 11 | Observation lab without consent tick | webcam does not start |
| 12 | Leave the observation page while recording | camera light goes off |
| 13 | PDF report | sections tagged measured / model / human; disclaimer on every page |

## 9. Feature checklist

| Requirement | Status |
|---|---|
| Dashboard, case CRUD, status, timestamps, search/filter, activity log, summaries | Done |
| Image and video upload, face detection with boxes, count, quality indicators, video timeline | Done |
| Optional reference matching with candidates, scores, limits and recorded human decision | Done (needs `fetch_models.py`) |
| Ten editable questions, one at a time, text response, optional audio, notes, follow-up, save/resume, summary, difference highlighting | Done |
| Face mesh, head orientation over time, gaze proxies, blink events and rate, landmark motion, tracking/quality, event timeline | Done (needs webcam or video; MediaPipe from CDN or `fetch_models.py`) |
| Evidence uploads, metadata, SHA-256, integrity checks, notes, demo labels, access control, encryption at rest | Done |
| PDF report separating measured / model / human content; JSON export; analytics | Done |
| Consent notices, retention for references, no deception/guilt labels, disclaimers | Done |
| Video recording of interviews | Not done (audio only, by design: avoids storing biometric video) |
| Trained low-resolution recogniser (deck's EfficientNet) | Not done - needs training data and GPU |
| Demographic-bias evaluation of the models | Not done - needs a consented, balanced test set; see docs |
| Production security (HTTPS, key management, security audit) | Out of scope for a local prototype |

## 10. Troubleshooting (Windows)

| Problem | Fix |
|---|---|
| `'python' is not recognized` | Use `py -3 ...`, or reinstall Python with *Add python.exe to PATH* |
| `running scripts is disabled on this system` when activating | Use Command Prompt (`.venv\Scripts\activate.bat`), or in PowerShell run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` |
| `pip install` fails building numpy/opencv/cryptography | Your Python is too new or 32-bit. Install 64-bit Python 3.12 and recreate `.venv` |
| `ModuleNotFoundError: fastapi` | The venv is not active: `.venv\Scripts\activate`, then `pip install -r requirements.txt` |
| Port 8000 busy | If Sightline is already running it just opens it; if another program uses the port, Sightline picks the next free one and prints the address |
| Download blocked as "dangerous" | See the note in section 1: Downloads (Ctrl+J) > *Keep* |
| Double-click opens Notepad instead of running | Right-click `START_SIGHTLINE.py` > *Open with* > *Python*, or run `py START_SIGHTLINE.py` in a terminal |
| `FileNotFoundError` at step [2/3], or *.venv is broken* | Antivirus or Microsoft-Store Python blocked the private environment. The starter now switches to a `.packages` folder automatically; you can force it with `py START_SIGHTLINE.py --no-venv` |
| Window opens and closes instantly | Run `py START_SIGHTLINE.py` from a terminal to see the message |
| Login works but pages say *Please sign in* | Use http://127.0.0.1:8000 consistently (not a mix of `localhost` and `127.0.0.1`), clear cookies |
| Webcam does not start | Allow camera access in the browser and in *Windows Settings > Privacy > Camera*; close Teams/Zoom; the page must be on `127.0.0.1` or `localhost` |
| *Could not load the MediaPipe face model* | No internet: run `python scripts\fetch_models.py --mediapipe` once, restart |
| Video won't play in the Observation lab | Use MP4 (H.264) or WebM. Face analysis (server side) also reads AVI/MKV |
| *Video could not be opened* in Face analysis | Re-encode to MP4 (H.264) |
| *Stored file failed decryption* | `data/vault.key` was changed or deleted; restore it from backup |
| `AttributeError: CascadeClassifier` | OpenCV 5 got installed: `pip install "opencv-python<5"` |
| Antivirus quarantines `models\*.onnx` | Restore the file and re-run `fetch_models.py` (it re-checks the hash) |
| Reset everything | Stop the server, delete the `data` folder, start again |

## 11. Data handling and limitations

* Evidence files, audio, reference images and embeddings are encrypted at rest (Fernet) under random file names.
  The database keeps file names, SHA-256 hashes, analysis numbers and the audit log.
* Video frames for the observation module are processed **in the browser**; only the numeric series and events are
  saved. Interviews store text and, optionally, audio.
* A matching hash shows a stored file has not changed since upload. It is not proof of authenticity and not a legal
  chain of custody.
* The interview "differences" are a keyword heuristic (negation, clock times, figures on overlapping words). Expect
  false alarms and misses; answers differ for many innocent reasons.
* Benchmark figures (YuNet WIDER FACE AP 0.884/0.866/0.750, SFace 99.40% LFW) do not transfer to your images.
  A quick check in this project showed a blurred copy of the same person scoring 0.25, below the 0.363 threshold.
* Face recognition error rates differ between demographic groups. Any candidate is an unverified lead.

## 12. What was verified, and how

Verified by running it (Linux, Python 3.13, OpenCV 4.14, headless Chromium):

* All backend tests pass, including real YuNet detection and SFace matching after `fetch_models.py`.
* The JavaScript measurement unit tests pass.
* A browser test clicked through every page and the main workflows: login, case create/edit/search, upload and
  hashing, integrity check, notes, detection and annotated images, interview autosave/complete/summary, PDF
  generation, question editing, sign-out, viewer and admin roles.
* The observation module was run in Chromium with a fake camera and a generated WebM file. **The real MediaPipe
  face-landmark model could not be downloaded in the build environment**, so a stand-in returning synthetic landmarks
  was used; the real MediaPipe library and WebAssembly files did load. Please check the Observation lab with a real
  webcam on your own machine before the demo.

Not verified: running on Windows itself (START_SIGHTLINE.py, paths and Windows fonts are written for it but were not
executed there), Firefox/Safari, and audio recording with a real microphone.
