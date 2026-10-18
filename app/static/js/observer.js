/* Facial-movement observer: webcam or uploaded video -> MediaPipe Face Landmarker (in the browser) -> measured series + events.
   Video frames never leave the browser; only numbers are sent to the server when the investigator saves.
   The Face Landmarker does not expose a per-frame tracking confidence, so we report presence, brightness and sharpness instead. */
(function () {
  const { h } = App;
  const VER = '0.10.14';
  const CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VER}`;
  const REMOTE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
  const MAX_SAMPLES = 40000;
  const KEYS = ['t', 'face', 'yaw', 'pitch', 'roll', 'energy', 'brightness', 'sharpness', 'blink', 'gaze_x', 'gaze_y', 'mouth_open'];
  const caches = new Map();   // key: delegate + numFaces

  /* Shared loader. numFaces defaults to 1 (facial-movement observer); the gaze module asks for 2 so that a second
     face in view can be detected and gaze processing suspended. */
  async function loadMediaPipe(delegate, numFaces = 1) {
    const key = delegate + ':' + numFaces;
    if (caches.has(key)) return caches.get(key);
    const p = (async () => {
      let st = {};
      try { st = await App.api('/api/vision/status'); } catch (e) { /* defaults: CDN + remote model */ }
      // Local copies (downloaded by scripts/fetch_models.py) make the module work offline.
      const base = st.mediapipe_local ? new URL('vendor/mediapipe', location.href).href : CDN;
      const mod = await import(`${base}/vision_bundle.mjs`);
      const fileset = await mod.FilesetResolver.forVisionTasks(`${base}/wasm`);
      const modelUrl = st.landmarker_model_local ? new URL('models/face_landmarker.task', location.href).href : REMOTE_MODEL;
      const lm = await mod.FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: modelUrl, delegate },
        runningMode: 'VIDEO', numFaces, outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true,
        minFaceDetectionConfidence: 0.5, minFacePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
      });
      return { mod, lm, modelUrl, local: !!st.mediapipe_local };
    })();
    caches.set(key, p);
    p.catch(() => { caches.delete(key); });
    return p;
  }

  /* Only one module may use the webcam at a time (facial-movement observer OR gaze observation). */
  const camera = {
    owner: null,
    claim(name) {
      if (this.owner && this.owner !== name) throw new Error(`The camera is already in use by ${this.owner}. Stop it first, then start this one.`);
      this.owner = name;
    },
    release(name) { if (this.owner === name) this.owner = null; },
  };

  class Observer {
    constructor({ video, canvas, onUpdate, onEvent, onEnded, fps = 12 }) {
      Object.assign(this, { video, canvas, onUpdate, onEvent, onEnded, fps });
      this.running = false;
      this.overlay = { mesh: true, contours: true, iris: true };
      this.q = document.createElement('canvas');
      this.q.width = 160; this.q.height = 120;
      this.qctx = this.q.getContext('2d', { willReadFrequently: true });
    }
    reset() {
      this.series = Object.fromEntries(KEYS.map((k) => [k, []]));
      this.extractor = new ObserverCore.EventExtractor();
      this.events = [];
      this.prev = null; this.prevT = null; this.lastTs = 0; this.last = 0; this.blinks = 0; this.tracked = 0;
      this.live = { t: 0, face: false, yaw: null, pitch: null, roll: null, blinks: 0, trackedPct: 0, brightness: null, sharpness: null, energy: null };
    }
    async start({ source, file }) {
      if (source === 'webcam' && !(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
        throw new Error('This browser cannot access a camera here. Open the app at http://127.0.0.1:8000 (camera access needs localhost or HTTPS).');
      }
      this.reset();
      this.source = source;
      this.sourceName = file ? file.name : 'webcam';
      let mp;
      try { this.delegate = 'GPU'; mp = await loadMediaPipe('GPU'); } catch (e1) {
        try { this.delegate = 'CPU'; mp = await loadMediaPipe('CPU'); } catch (e2) {
          throw new Error('Could not load the MediaPipe face model. Either connect to the internet or run "python scripts/fetch_models.py" once and restart (see README, Offline use). Details: ' + (e2.message || e2));
        }
      }
      this.mp = mp;
      if (source === 'webcam') {
        camera.claim('the facial-movement observer');
        this.cameraClaimed = true;
        try { this.stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 960 }, height: { ideal: 540 }, facingMode: 'user' }, audio: false }); }
        catch (e) { this._release(); throw e; }
        this.video.srcObject = this.stream;
      } else {
        this.fileUrl = URL.createObjectURL(file);
        this.video.src = this.fileUrl;
        this.video.loop = false;
        this.video.onended = () => { if (this.running) { this.stop(); this.onEnded && this.onEnded(); } };
      }
      this.video.muted = true;
      this.video.playsInline = true;
      try { await this.video.play(); } catch (e) { this._release(); throw new Error('The video could not be played in this browser (unsupported format?). Try MP4 (H.264) or WebM.'); }
      this.canvas.width = this.video.videoWidth || 640;
      this.canvas.height = this.video.videoHeight || 480;
      this.drawer = new mp.mod.DrawingUtils(this.canvas.getContext('2d'));
      this.startedAt = new Date().toISOString();
      this.t0 = performance.now();
      this.running = true;
      const tick = () => {
        if (!this.running) return;
        const now = performance.now();
        if (now - this.last >= 1000 / this.fps && this.video.readyState >= 2) { this.last = now; try { this._process(now); } catch (e) { console.error(e); } }
        this.raf = requestAnimationFrame(tick);
      };
      this.raf = requestAnimationFrame(tick);
    }
    _time(now) { return this.source === 'file' ? this.video.currentTime : (now - this.t0) / 1000; }
    _process(now) {
      const t = +this._time(now).toFixed(3);
      const S = this.series;
      if (S.t.length && t <= S.t[S.t.length - 1]) return;       // paused or seeking backwards
      this.lastTs = Math.max(now, this.lastTs + 1);
      const res = this.mp.lm.detectForVideo(this.video, this.lastTs);
      this.qctx.drawImage(this.video, 0, 0, 160, 120);
      const px = this.qctx.getImageData(0, 0, 160, 120).data;
      const gray = new Uint8Array(160 * 120);
      for (let i = 0, j = 0; i < px.length; i += 4, j++) gray[j] = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) | 0;
      const qs = ObserverCore.grayStats(gray, 160, 120);
      const ctx = this.canvas.getContext('2d');
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      const face = !!(res.faceLandmarks && res.faceLandmarks.length);
      let yaw = null, pitch = null, roll = null, energy = null, ff = null;
      if (face) {
        const lms = res.faceLandmarks[0];
        const bs = {};
        if (res.faceBlendshapes && res.faceBlendshapes[0]) for (const c of res.faceBlendshapes[0].categories) bs[c.categoryName] = c.score;
        ff = ObserverCore.faceFeatures(bs);
        const mtx = res.facialTransformationMatrixes && res.facialTransformationMatrixes[0];
        const pose = ObserverCore.headPose(mtx && mtx.data);
        if (pose) ({ yaw, pitch, roll } = pose);
        if (this.prev && this.prevT != null) energy = ObserverCore.landmarkEnergy(this.prev, lms, t - this.prevT, this.video.videoWidth / this.video.videoHeight);
        this.prev = lms; this.prevT = t;
        this._draw(lms);
        this.tracked++;
      } else { this.prev = null; this.prevT = null; }
      const r = (v, d = 3) => (v == null ? null : +v.toFixed(d));
      S.t.push(t); S.face.push(face ? 1 : 0);
      S.yaw.push(r(yaw, 1)); S.pitch.push(r(pitch, 1)); S.roll.push(r(roll, 1)); S.energy.push(r(energy));
      S.brightness.push(r(qs.brightness, 1)); S.sharpness.push(r(qs.sharpness, 1));
      S.blink.push(ff ? r(ff.blink) : null); S.gaze_x.push(ff ? r(ff.gaze_x) : null); S.gaze_y.push(ff ? r(ff.gaze_y) : null); S.mouth_open.push(ff ? r(ff.mouth_open) : null);
      const evs = this.extractor.update({ t, face, yaw, energy, brightness: qs.brightness, blink: ff ? ff.blink : null });
      evs.forEach((e) => { this.events.push(e); if (e.type === 'blink') this.blinks++; this.onEvent && this.onEvent(e); });
      Object.assign(this.live, { t, face, yaw, pitch, roll, blinks: this.blinks, trackedPct: (this.tracked / S.t.length) * 100, brightness: qs.brightness, sharpness: qs.sharpness, energy });
      this.onUpdate && this.onUpdate(this.live);
      if (S.t.length >= MAX_SAMPLES) { this.stop(); this.onEnded && this.onEnded(); }
    }
    _draw(lms) {
      const L = this.mp.mod.FaceLandmarker, d = this.drawer, o = this.overlay;
      if (o.mesh) d.drawConnectors(lms, L.FACE_LANDMARKS_TESSELATION, { color: 'rgba(76,201,214,0.35)', lineWidth: 0.6 });
      if (o.contours) d.drawConnectors(lms, L.FACE_LANDMARKS_CONTOURS, { color: 'rgba(242,180,65,0.9)', lineWidth: 1.4 });
      if (o.iris) { d.drawConnectors(lms, L.FACE_LANDMARKS_LEFT_IRIS, { color: '#ffffff', lineWidth: 1.2 }); d.drawConnectors(lms, L.FACE_LANDMARKS_RIGHT_IRIS, { color: '#ffffff', lineWidth: 1.2 }); }
    }
    mark(text) {
      if (!this.running) return;
      const e = { t: +this._time(performance.now()).toFixed(2), type: 'marker', detail: text };
      this.events.push(e);
      this.onEvent && this.onEvent(e);
    }
    _release() {
      if (this.stream) this.stream.getTracks().forEach((tr) => tr.stop());
      this.stream = null;
      if (this.cameraClaimed) { camera.release('the facial-movement observer'); this.cameraClaimed = false; }
      try { this.video.pause(); } catch (e) { /* ignore */ }
      this.video.srcObject = null;
      this.video.removeAttribute('src');
      if (this.fileUrl) { URL.revokeObjectURL(this.fileUrl); this.fileUrl = null; }
    }
    stop() {
      if (!this.series) return null;
      if (this.running) {
        this.running = false;
        cancelAnimationFrame(this.raf);
        const tEnd = this.series.t.length ? this.series.t[this.series.t.length - 1] : 0;
        this.extractor.finish(tEnd).forEach((e) => { this.events.push(e); this.onEvent && this.onEvent(e); });
      }
      this._release();
      this.canvas.getContext('2d').clearRect(0, 0, this.canvas.width, this.canvas.height);
      return this.result();
    }
    result() {
      if (!this.series) return null;
      const t = this.series.t;
      return {
        source: this.source, source_name: this.sourceName, started_at: this.startedAt, duration_s: t.length ? t[t.length - 1] : 0,
        series: this.series, events: this.events.slice().sort((a, b) => a.t - b.t),
        software: { library: '@mediapipe/tasks-vision', version: VER, loaded_from: this.mp && this.mp.local ? 'local vendor copy' : 'jsDelivr CDN', model: 'face_landmarker.task (float16 v1)', delegate: this.delegate, sample_fps: this.fps,
          thresholds: ObserverCore.THRESHOLDS, note: 'No per-frame tracking confidence is exposed by the library.', user_agent: navigator.userAgent.slice(0, 120) },
      };
    }
  }

  /* Reusable DOM: video + mesh overlay + toggles + live readouts. */
  function view({ mirror = true, compact = false } = {}) {
    const video = h('video', { playsinline: true, muted: true });
    const canvas = h('canvas');
    const placeholder = h('div', { class: 'placeholder' }, 'Camera / video preview appears here');
    const wrap = h('div', { class: 'video-wrap' + (mirror ? ' mirror' : ''), style: 'min-height:' + (compact ? '140px' : '240px') }, video, canvas, placeholder);
    const m = {};
    const mk = (k, label) => { m[k] = h('div', { class: 'v' }, '-'); return h('div', { class: 'metric' }, h('div', { class: 'k' }, label), m[k]); };
    const metrics = h('div', { class: 'live-metrics' }, mk('state', 'Face'), mk('yaw', 'Yaw (deg)'), mk('pitch', 'Pitch (deg)'), mk('blinks', 'Blink events'), mk('tracked', 'Tracked %'), mk('quality', 'Brightness / sharp.'));
    const toggles = {};
    const tg = (k, label) => h('label', { class: 'chk' }, (toggles[k] = h('input', { type: 'checkbox', checked: true })), label);
    const bar = h('div', { class: 'row', style: 'margin-top:8px' }, tg('mesh', 'Face mesh'), tg('contours', 'Contours'), tg('iris', 'Iris'));
    const update = (L) => {
      placeholder.style.display = 'none';
      const f = (v, d = 0) => (v == null ? '-' : v.toFixed(d));
      m.state.textContent = L.face ? 'tracked' : 'not tracked';
      m.state.style.color = L.face ? 'var(--ok)' : 'var(--bad)';
      m.yaw.textContent = f(L.yaw); m.pitch.textContent = f(L.pitch); m.blinks.textContent = L.blinks;
      m.tracked.textContent = f(L.trackedPct); m.quality.textContent = `${f(L.brightness)} / ${f(L.sharpness)}`;
    };
    const setMirror = (on) => wrap.classList.toggle('mirror', on);
    const bindToggles = (observer) => Object.keys(toggles).forEach((k) => { observer.overlay[k] = toggles[k].checked; toggles[k].onchange = () => { observer.overlay[k] = toggles[k].checked; }; });
    return { el: h('div', null, wrap, bar, metrics), video, canvas, toggles, update, setMirror, bindToggles, showPlaceholder: () => { placeholder.style.display = ''; } };
  }

  window.ObserverUI = { Observer, view, loadMediaPipe, camera, MEDIAPIPE_VERSION: VER };
})();
