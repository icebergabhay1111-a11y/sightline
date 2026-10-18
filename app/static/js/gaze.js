/* Gaze Observation - live capture card and Bluetooth heart-rate link.

   What it does: estimates where the irises sit inside the eye openings (MediaPipe Face Landmarker, in this browser),
   turns that into neutral labels (left/center/right, up/center/down) with a tracking-quality estimate, and saves
   time-stamped numbers only. Video frames, screenshots, eye crops and face templates never leave this browser and are
   never stored. Pupil size is not used.

   What it does not do: it never produces any statement about honesty, credibility, emotion, stress, intent, risk or
   identity, and it never auto-tags anything. Reviewers add their own notes afterwards on the session page.
*/
(function () {
  const { h, api, toast, fail, confirmDialog, badge } = App;
  const G = window.GazeCore;
  const S = G.SETTINGS;
  const EYE_BOX = [33, 133, 159, 145, 362, 263, 386, 374];
  const MAX_SAMPLES = 72000;                 // 2 hours at 10 Hz (server limit)
  const REASON_TEXT = {
    face_not_visible: 'face not visible', multiple_faces: 'more than one face in view (gaze processing suspended)',
    eyes_closed: 'eyes closed', iris_not_visible: 'iris not visible', extreme_head_turn: 'head turned too far',
    low_confidence: 'tracking confidence below ' + S.min_confidence,
  };
  let configPromise = null;
  const config = () => (configPromise = configPromise || api('/api/gaze/config').catch((e) => { configPromise = null; throw e; }));

  /* ------------------------------------------------------------------------------------ heart-rate link (BLE) */
  const BT_HELP = 'Web Bluetooth works in Chrome or Edge (Windows 10/11, Android, macOS) on http://127.0.0.1 or HTTPS. Firefox and Safari do not support it.';

  class HeartRateLink {
    constructor({ onReading, onState }) { Object.assign(this, { onReading, onState }); this.device = null; this.char = null; this.last = null; }
    static supported() { return !!(navigator.bluetooth && navigator.bluetooth.requestDevice); }
    get connected() { return !!(this.device && this.device.gatt && this.device.gatt.connected && this.char); }
    async connect() {
      if (!HeartRateLink.supported()) throw new Error('Bluetooth is not available in this browser. ' + BT_HELP);
      const device = await navigator.bluetooth.requestDevice({ filters: [{ services: ['heart_rate'] }] });
      this.device = device;
      device.addEventListener('gattserverdisconnected', this._onDisc = () => { this.char = null; this.onState && this.onState('disconnected'); });
      const server = await device.gatt.connect();
      const svc = await server.getPrimaryService('heart_rate');
      this.char = await svc.getCharacteristic('heart_rate_measurement');
      this.char.addEventListener('characteristicvaluechanged', this._onVal = (e) => {
        try { const r = G.parseHeartRate(e.target.value); this.last = { ...r, at: performance.now() }; this.onReading && this.onReading(r); } catch (err) { console.error(err); }
      });
      await this.char.startNotifications();
      this.onState && this.onState('connected', device.name || 'heart-rate sensor');
      return device.name || 'heart-rate sensor';
    }
    async disconnect() {
      try { if (this.char) { this.char.removeEventListener('characteristicvaluechanged', this._onVal); await this.char.stopNotifications(); } } catch (e) { /* already gone */ }
      try { if (this.device && this.device.gatt.connected) this.device.gatt.disconnect(); } catch (e) { /* ignore */ }
      if (this.device && this._onDisc) this.device.removeEventListener('gattserverdisconnected', this._onDisc);
      this.char = null; this.device = null; this.last = null;
      this.onState && this.onState('disconnected');
    }
    /* "Check a device": lets the user pick ANY nearby Bluetooth device and reports whether it exposes the standard
       Heart Rate service. Reads no heart-rate values. */
    static async check() {
      if (!HeartRateLink.supported()) return { ok: false, message: 'Bluetooth is not available in this browser. ' + BT_HELP };
      const device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: ['heart_rate', 'battery_service', 'device_information'] });
      const name = device.name || 'Unnamed device';
      let server;
      try { server = await device.gatt.connect(); } catch (e) {
        return { ok: false, name, message: `${name} was found but would not accept a connection from the browser (${e.message}). It is probably paired to a phone app only.` };
      }
      let ok = false;
      try { await server.getPrimaryService('heart_rate'); ok = true; } catch (e) { ok = false; }
      try { device.gatt.disconnect(); } catch (e) { /* ignore */ }
      return ok
        ? { ok, name, message: `${name} broadcasts the standard Bluetooth heart-rate service. Record the heart-rate consent, then use "Connect sensor".` }
        : { ok, name, message: `${name} connected but does not share heart rate over the standard Bluetooth profile. Many smartwatches only sync to their own phone app; look for a "heart rate broadcast" or "HR sharing" setting on the watch, or use a chest strap (e.g. Polar H10, Wahoo TICKR, Coospo).` };
    }
  }

  /* ----------------------------------------------------------------------------------------- capture card */
  /* opts: { caseId, interviewId, subjectRef, isDemo, allowFile, questionButton, getQuestion: () => ({id, text}) | null, onSaved } */
  function capture(opts) {
    const st = { phase: 'idle', consent: null, hrConsent: null, samples: [], markers: [], hr: [], calib: null, qid: null, paused: false, lastQ: null };
    let mp = null, video, canvas, stream = null, fileUrl = null, raf = null, t0 = 0, lastT = -1, lastTick = 0, lastTs = 0;
    let labeler, blink, calibrator, calibUntil = 0, calibStart = 0, prevLms = null, prevT = null, live = {}, uiTimer = null, activeMs = 0, activeFrom = 0;
    let disposed = false;
    const small = document.createElement('canvas'); small.width = 160; small.height = 120;
    const sctx = small.getContext('2d', { willReadFrequently: true });
    const eyeC = document.createElement('canvas'); eyeC.width = 64; eyeC.height = 24;
    const ectx = eyeC.getContext('2d', { willReadFrequently: true });

    const root = h('div', { class: 'card gaze-card' });
    const consentBox = h('div'), hrBox = h('div'), controls = h('div'), liveBox = h('div'), qualityBox = h('div', { class: 'hidden' }), resultBox = h('div');
    const statusLine = h('div', { class: 'gaze-status' });
    const subj = h('input', { type: 'text', maxLength: 80, value: opts.subjectRef || '', placeholder: 'Subject reference code (not a real name)' });
    const formRef = h('input', { type: 'text', maxLength: 120, placeholder: 'Consent form number, e.g. CF-012' });
    const glasses = h('input', { type: 'checkbox' });
    const srcWeb = h('input', { type: 'radio', name: 'gaze-src', checked: true }), srcFile = h('input', { type: 'radio', name: 'gaze-src' });
    const fileIn = h('input', { type: 'file', accept: 'video/*' });
    const markIn = h('input', { type: 'text', maxLength: 120, placeholder: 'Marker text (optional)' });
    const placeholder = h('div', { class: 'placeholder' }, 'Camera preview appears here');
    video = h('video', { playsinline: true, muted: true });
    canvas = h('canvas');
    const wrap = h('div', { class: 'video-wrap mirror', style: 'min-height:150px' }, video, canvas, placeholder);
    const hrLink = new HeartRateLink({ onReading: onHr, onState: () => paintHr() });
    let hrState = '';

    const elapsed = () => (opts.source === 'file' ? video.currentTime * 1000 : performance.now() - t0);
    const sessionTime = () => Math.max(0, Math.round(elapsed()));
    const recording = () => st.phase === 'recording' && !st.paused;
    const set = (el, ...kids) => el.replaceChildren(...kids);

    /* ------------------------------------------------------------------ consent */
    async function recordConsent(scope, checkbox) {
      if (!checkbox.checked) { toast('Tick the consent statement first (read it to the subject)', 'err'); return null; }
      if (!subj.value.trim()) { toast('Enter the subject reference code', 'err'); return null; }
      const r = await api('/api/consents', { method: 'POST', json: { case_id: +opts.caseId(), interview_id: opts.interviewId || null, subject_ref: subj.value.trim(), scope, form_ref: formRef.value.trim(), confirmed: true, is_demo: !!opts.isDemo() } });
      return { id: r.id, statement: r.statement, at: new Date().toISOString() };
    }
    async function paintConsent() {
      const cfg = await config();
      if (st.consent) {
        set(consentBox, h('div', { class: 'row sp gaze-consent-ok' }, h('span', null, badge('consent #' + st.consent.id, 'b-ok'), ' Gaze observation consent recorded for ', h('b', null, subj.value.trim()), formRef.value ? ` (form ${formRef.value})` : ''),
          h('button', { class: 'btn small danger', onclick: withdraw }, 'Withdraw consent')));
        return;
      }
      const chk = h('input', { type: 'checkbox', name: 'gaze-consent' });
      const btn = h('button', { class: 'btn small primary', onclick: async () => {
        if (!opts.caseId()) return toast('Choose a case first', 'err');
        btn.disabled = true;
        try { const c = await recordConsent('gaze_observation', chk); if (c) { st.consent = c; toast('Gaze observation consent recorded', 'ok'); paintAll(); } } catch (e) { fail(e); }
        btn.disabled = false;
      } }, 'Record consent');
      set(consentBox, h('div', { class: 'gaze-consent' },
        h('div', { class: 'grid g2', style: 'gap:8px' }, App.field('Subject reference', subj), App.field('Consent form (optional)', formRef)),
        h('label', { class: 'chk', style: 'margin-top:8px;align-items:flex-start' }, chk, h('span', null, h('b', null, 'Read to the subject and confirm: '), cfg.consent_text.gaze_observation)),
        h('div', { class: 'row', style: 'margin-top:8px' }, btn, h('span', { class: 'dim', style: 'font-size:12px' }, 'Separate from the interview consent. Version ' + cfg.consent_version + '.'))));
    }

    async function withdraw() {
      if (!(await confirmDialog('Withdraw gaze observation consent? Capture stops now, unsaved measurements are discarded, and any measurements already saved under this consent are deleted.', 'Withdraw consent'))) return;
      const cid = st.consent.id, hid = st.hrConsent && st.hrConsent.id;
      halt();
      discard(true);
      try {
        await api(`/api/consents/${cid}/withdraw?delete_data=true`, { method: 'POST' });
        if (hid) await api(`/api/consents/${hid}/withdraw?delete_data=true`, { method: 'POST' });
        toast('Consent withdrawn - capture stopped and data deleted', 'ok');
      } catch (e) { fail(e); }
      if (hrLink.connected) await hrLink.disconnect();
      st.consent = null; st.hrConsent = null;
      paintAll();
    }

    /* ------------------------------------------------------------------ heart rate */
    function onHr(r) {
      paintHrValue(r);
      if (!recording() || !st.hrConsent) return;
      if (!(r.bpm >= 20 && r.bpm <= 250)) return;            // 0 = no skin contact on many straps
      const t = sessionTime();
      const lastHr = st.hr[st.hr.length - 1];
      if (lastHr && t <= lastHr.timestamp_ms) return;
      st.hr.push({ timestamp_ms: t, bpm: r.bpm, contact: r.contact, rr_ms: r.rr_ms.slice(0, 12) });
    }
    const hrValue = h('span', { class: 'gaze-bpm' }, '-');
    function paintHrValue(r) { hrValue.textContent = r && r.bpm ? `${r.bpm} bpm${r.contact === false ? ' (no skin contact)' : ''}` : '-'; }
    function paintHr() {
      if (!st.consent) { set(hrBox); return; }
      const supported = HeartRateLink.supported();
      const checkBtn = h('button', { class: 'btn small', onclick: async () => {
        checkBtn.disabled = true;
        try { const r = await HeartRateLink.check(); hrState = r.message; toast(r.message, r.ok ? 'ok' : 'err'); } catch (e) { if (e.name !== 'NotFoundError') fail(e); }
        checkBtn.disabled = false; paintHr();
      } }, 'Check a device');
      let body;
      if (!st.hrConsent) {
        const chk = h('input', { type: 'checkbox', name: 'hr-consent' });
        const btn = h('button', { class: 'btn small', onclick: async () => {
          btn.disabled = true;
          try { const c = await recordConsent('heart_rate', chk); if (c) { st.hrConsent = c; toast('Heart-rate consent recorded', 'ok'); paintHr(); } } catch (e) { fail(e); }
          btn.disabled = false;
        } }, 'Record heart-rate consent');
        body = [h('label', { class: 'chk', style: 'align-items:flex-start' }, chk, h('span', null, h('b', null, 'Separate consent: '), HR_CONSENT_TEXT())), h('div', { class: 'row', style: 'margin-top:6px' }, btn, checkBtn)];
      } else {
        const connectBtn = h('button', { class: 'btn small primary', disabled: !supported, onclick: async () => {
          connectBtn.disabled = true;
          try { const n = await hrLink.connect(); hrState = 'Connected to ' + n; } catch (e) { if (e.name !== 'NotFoundError') fail(e); hrState = ''; }
          paintHr();
        } }, 'Connect sensor');
        body = [h('div', { class: 'row' }, badge('consent #' + st.hrConsent.id, 'b-ok'),
          hrLink.connected ? h('span', null, 'Sensor: ', h('b', null, hrLink.device.name || 'heart-rate sensor'), ' - ', hrValue) : null,
          hrLink.connected ? h('button', { class: 'btn small', onclick: () => hrLink.disconnect() }, 'Disconnect') : connectBtn, checkBtn),
          st.hr.length ? h('div', { class: 'dim', style: 'font-size:12px;margin-top:4px' }, `${st.hr.length} reading(s) recorded in this capture`) : null];
      }
      const det = h('details', { class: 'gaze-hr', open: !!(st.hrOpen || st.hrConsent) },
        h('summary', null, 'Heart rate from a Bluetooth sensor (optional)'),
        h('p', { class: 'dim', style: 'font-size:12px;margin:6px 0' }, 'Readings are recorded only while capture is running, as time-stamped numbers. ', h('b', null, 'Heart rate rises and falls with movement, speaking, posture, caffeine and nerves; it is not a lie detector.')),
        !supported ? h('div', { class: 'notice info', style: 'margin-bottom:6px' }, 'Bluetooth is not available in this browser. ' + BT_HELP) : null,
        body, hrState ? h('div', { class: 'muted', style: 'font-size:12px;margin-top:6px' }, hrState) : null);
      det.addEventListener('toggle', () => { st.hrOpen = det.open; });
      set(hrBox, det);
    }
    let hrConsentText = '';
    const HR_CONSENT_TEXT = () => hrConsentText;

    /* ------------------------------------------------------------------ capture */
    async function openSource() {
      try { mp = await ObserverUI.loadMediaPipe('GPU', 2); st.delegate = 'GPU'; } catch (e1) {
        try { mp = await ObserverUI.loadMediaPipe('CPU', 2); st.delegate = 'CPU'; } catch (e2) {
          throw new Error('Could not load the MediaPipe face model. Connect to the internet once or run "python scripts/fetch_models.py". Details: ' + (e2.message || e2));
        }
      }
      if (opts.source === 'file') {
        if (!fileIn.files[0]) throw new Error('Choose a video file first');
        fileUrl = URL.createObjectURL(fileIn.files[0]);
        video.src = fileUrl; video.loop = false;
        video.onended = () => { if (st.phase === 'recording' || st.phase === 'calibrating') stopAndSave(); };
        wrap.classList.remove('mirror');
      } else {
        if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) throw new Error('This browser cannot access a camera here. Open Sightline at http://127.0.0.1:8000.');
        ObserverUI.camera.claim('gaze observation');
        st.claimed = true;
        stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 960 }, height: { ideal: 540 }, facingMode: 'user' }, audio: false });
        video.srcObject = stream;
        wrap.classList.add('mirror');
        stream.getVideoTracks().forEach((tr) => { tr.onended = onCameraLost; });
      }
      video.muted = true; video.playsInline = true;
      try { await video.play(); } catch (e) { throw new Error('The video could not be played (unsupported format?). Try MP4 (H.264) or WebM.'); }
      canvas.width = video.videoWidth || 640; canvas.height = video.videoHeight || 480;
      placeholder.style.display = 'none';
      st.sourceName = opts.source === 'file' ? fileIn.files[0].name : 'webcam';
    }

    function release() {
      cancelAnimationFrame(raf); raf = null;
      clearInterval(uiTimer); uiTimer = null;
      if (stream) { stream.getTracks().forEach((tr) => { tr.onended = null; tr.stop(); }); stream = null; }
      if (st.claimed) { ObserverUI.camera.release('gaze observation'); st.claimed = false; }
      try { video.pause(); } catch (e) { /* ignore */ }
      video.srcObject = null; video.removeAttribute('src'); video.onended = null;
      if (fileUrl) { URL.revokeObjectURL(fileUrl); fileUrl = null; }
      const c = canvas.getContext('2d'); c.clearRect(0, 0, canvas.width, canvas.height);
      placeholder.style.display = '';
    }

    async function begin(withCalibration) {
      if (!st.consent) return toast('Record the gaze observation consent first', 'err');
      if (!opts.caseId()) return toast('Choose a case first', 'err');
      opts.source = opts.allowFile && srcFile.checked ? 'file' : 'webcam';
      Object.assign(st, { phase: 'loading', samples: [], markers: [], hr: [], calib: null, paused: false, savedId: null, cameraLost: false });
      paintAll();
      statusLine.textContent = 'Loading face model and ' + (opts.source === 'file' ? 'video...' : 'camera...');
      try { await openSource(); } catch (e) { release(); st.phase = 'idle'; paintAll(); fail(e); return; }
      if (disposed) { release(); return; }
      labeler = new G.GazeLabeler(); blink = new G.BlinkTracker(); prevLms = null; prevT = null; lastT = -1; live = {};
      t0 = performance.now(); lastTs = 0;
      st.startedAt = new Date().toISOString();
      if (withCalibration) {
        calibrator = new G.Calibrator(); st.phase = 'calibrating';
        calibStart = elapsed(); calibUntil = calibStart + 25000;
      } else { st.calib = { status: 'skipped', offset_h: 0, offset_v: 0, usable_fraction: null, spread_h: null, spread_v: null, samples: 0, duration_ms: 0 }; startRecording(); }
      raf = requestAnimationFrame(tick);
      uiTimer = setInterval(paintLive, 250);
      paintAll();
    }

    function finishCalibration(skipped) {
      const dur = Math.round(elapsed() - calibStart);
      if (skipped && dur < S.calibration.min_s * 1000) st.calib = { status: 'skipped', offset_h: 0, offset_v: 0, usable_fraction: null, spread_h: null, spread_v: null, samples: 0, duration_ms: dur };
      else st.calib = { ...calibrator.result(), duration_ms: dur };
      calibrator = null;
      startRecording();
      toast(st.calib.status === 'completed' ? 'Calibration completed - recording started' : st.calib.status === 'poor' ? 'Calibration was poor (not applied) - recording started' : 'Calibration skipped - recording started', st.calib.status === 'completed' ? 'ok' : '');
      paintAll();
    }

    function startRecording() {
      // Session time starts at zero when recording starts (calibration time is not part of the record).
      if (opts.source !== 'file') t0 = performance.now();
      st.recordBase = opts.source === 'file' ? video.currentTime * 1000 : 0;
      st.phase = 'recording'; activeMs = 0; activeFrom = performance.now();
      labeler = new G.GazeLabeler(); blink = new G.BlinkTracker();
      const c = st.calib;
      addMarker('calibration', c.status === 'completed' ? `Camera-position calibration completed (usable ${Math.round(c.usable_fraction * 100)}%, offset h ${c.offset_h}, v ${c.offset_v})` : c.status === 'poor' ? 'Camera-position calibration poor - not applied' : 'Camera-position calibration skipped');
      const q = opts.getQuestion && opts.getQuestion();
      if (q) setQuestion(q.id, q.text);
    }

    const recTime = () => Math.max(0, Math.round(elapsed() - (opts.source === 'file' ? st.recordBase : 0)));
    function addMarker(type, text, qid) {
      const t = recTime();
      st.markers.push({ timestamp_ms: t, marker_type: type, text: (text || '').slice(0, 300), question_marker_id: qid === undefined ? st.qid : qid });
    }
    function setQuestion(id, text) {
      st.qid = id;
      if (st.phase === 'recording') addMarker('question', text, id);
    }

    function tick() {
      raf = requestAnimationFrame(tick);
      const now = performance.now();
      if (now - lastTick < 1000 / S.sample_hz - 4 || video.readyState < 2) return;
      lastTick = now;
      if (st.phase === 'recording' && st.paused) return;
      try { processFrame(now); } catch (e) { console.error(e); }
    }

    function eyeGlare(lms, w, hh) {
      let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
      EYE_BOX.forEach((i) => { x0 = Math.min(x0, lms[i].x); x1 = Math.max(x1, lms[i].x); y0 = Math.min(y0, lms[i].y); y1 = Math.max(y1, lms[i].y); });
      const pw = (x1 - x0) * 0.15, ph = (y1 - y0) * 0.6 + 0.01;
      const sx = Math.max(0, (x0 - pw) * w), sy = Math.max(0, (y0 - ph) * hh), sw = Math.min(w - sx, (x1 - x0 + 2 * pw) * w), sh = Math.min(hh - sy, (y1 - y0 + 2 * ph) * hh);
      if (sw < 4 || sh < 4) return null;
      ectx.drawImage(video, sx, sy, sw, sh, 0, 0, 64, 24);
      const px = ectx.getImageData(0, 0, 64, 24).data;           // used for this one number, then dropped
      const g = new Uint8Array(64 * 24);
      for (let i = 0, j = 0; i < px.length; i += 4, j++) g[j] = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) | 0;
      return G.glareFraction(g);
    }

    function processFrame(now) {
      const t = st.phase === 'recording' ? recTime() : Math.round(elapsed());
      if (st.phase === 'recording' && t <= lastT) return;
      lastTs = Math.max(now, lastTs + 1);
      const res = mp.lm.detectForVideo(video, lastTs);
      const vw = video.videoWidth || 640, vh = video.videoHeight || 480;
      sctx.drawImage(video, 0, 0, 160, 120);
      const px = sctx.getImageData(0, 0, 160, 120).data;
      const gray = new Uint8Array(160 * 120);
      for (let i = 0, j = 0; i < px.length; i += 4, j++) gray[j] = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) | 0;
      const qs = ObserverCore.grayStats(gray, 160, 120);
      const faces = (res.faceLandmarks || []).length;
      let raw = null, pose = null, score = null, energy = null, glare = null, lms = null;
      if (faces === 1) {                                         // gaze is processed only with exactly one face in view
        lms = res.faceLandmarks[0];
        raw = G.rawOffsets(lms, vw, vh);
        const mtx = res.facialTransformationMatrixes && res.facialTransformationMatrixes[0];
        pose = ObserverCore.headPose(mtx && mtx.data);
        const bs = {};
        if (res.faceBlendshapes && res.faceBlendshapes[0]) for (const c of res.faceBlendshapes[0].categories) bs[c.categoryName] = c.score;
        if (bs.eyeBlinkLeft != null && bs.eyeBlinkRight != null) score = (bs.eyeBlinkLeft + bs.eyeBlinkRight) / 2;
        if (prevLms && prevT != null && t > prevT) energy = ObserverCore.landmarkEnergy(prevLms, lms, (t - prevT) / 1000, vw / vh);
        prevLms = lms; prevT = t;
        glare = eyeGlare(lms, vw, vh);
      } else { prevLms = null; prevT = null; }
      const b = blink.update(t, score, faces === 1);
      const calibrated = st.phase === 'calibrating' ? null : st.calib && st.calib.status === 'completed';
      const q = { faces, iod_px: raw && raw.iod_px, yaw: pose && pose.yaw, pitch: pose && pose.pitch, brightness: qs.brightness, sharpness: qs.sharpness,
        energy, glare, disagreement: raw && raw.disagreement, inside: raw ? raw.inside : faces === 1 ? false : undefined, eyes_closed: b.eyes_closed,
        glasses_declared: glasses.checked, calibrated: calibrated === null ? undefined : calibrated, raw };
      const conf = G.trackingConfidence(q);
      const reason = G.unavailableReason(q, conf);
      const flags = G.qualityFlags(q);
      draw(res, reason);
      live = { t, faces, q, conf, reason, flags };
      if (st.phase === 'calibrating') {
        calibrator.add(reason ? null : raw);
        if (elapsed() >= calibUntil) finishCalibration(false);
        return;
      }
      if (st.phase !== 'recording') return;
      const off = reason ? null : G.applyCalibration(raw, st.calib);
      const lab = labeler.update(t, off);
      live.lab = lab;
      const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
      st.samples.push({ timestamp_ms: t, ...lab, blink_event: b.blink_event, eyes_closed: b.eyes_closed, eyes_closed_event: b.eyes_closed_event,
        closed_duration_ms: b.closed_duration_ms, head_yaw: r1(pose && pose.yaw), head_pitch: r1(pose && pose.pitch), head_roll: r1(pose && pose.roll),
        face_visible: faces >= 1, tracking_confidence: conf, quality_flags: flags, question_marker_id: st.qid });
      lastT = t;
      if (st.samples.length >= MAX_SAMPLES) { toast('Maximum session length reached - saving', ''); stopAndSave(); }
    }

    function draw(res, reason) {
      const c = canvas.getContext('2d');
      c.clearRect(0, 0, canvas.width, canvas.height);
      const all = res.faceLandmarks || [];
      all.forEach((lms) => {
        const col = all.length > 1 ? '#ef6a6a' : reason ? '#f2b441' : '#4cc9d6';
        [33, 133, 362, 263].forEach((i) => { c.fillStyle = col; c.fillRect(lms[i].x * canvas.width - 2, lms[i].y * canvas.height - 2, 4, 4); });
        [468, 473].forEach((i) => { if (!lms[i]) return; c.beginPath(); c.strokeStyle = '#ffffff'; c.lineWidth = 2; c.arc(lms[i].x * canvas.width, lms[i].y * canvas.height, 5, 0, Math.PI * 2); c.stroke(); });
      });
    }

    function pause() {
      if (st.phase !== 'recording' || st.paused) return;
      addMarker('pause', 'Capture paused');
      st.paused = true; activeMs += performance.now() - activeFrom;
      if (opts.source === 'file') video.pause();
      paintAll();
    }
    async function resume() {
      if (!st.paused) return;
      if (opts.source === 'file') { try { await video.play(); } catch (e) { /* ignore */ } }
      st.paused = false; activeFrom = performance.now();
      addMarker('resume', 'Capture resumed');
      paintAll();
    }
    function onCameraLost() {
      if (st.phase !== 'recording' && st.phase !== 'calibrating') return;
      st.cameraLost = true;
      if (st.phase === 'recording') addMarker('camera_lost', 'Camera access ended (permission revoked or device disconnected)');
      halt();
      toast('Camera access ended - capture stopped. Save or discard what was captured.', 'err');
      paintAll();
    }

    /* Stop sampling and release the camera; keeps captured data in memory. */
    function halt() {
      if (st.phase === 'recording' && !st.paused) activeMs += performance.now() - activeFrom;
      if (st.phase === 'calibrating') { st.calib = null; }
      st.endedAt = new Date().toISOString();
      release();
      st.phase = st.samples.length ? 'stopped' : 'idle';
      st.paused = false;
    }
    function discard(silent) {
      st.samples = []; st.markers = []; st.hr = []; st.calib = null; st.phase = 'idle';
      if (!silent) toast('Discarded - nothing was saved');
      paintAll();
    }

    async function stopAndSave() {
      if (st.phase === 'recording' || st.phase === 'calibrating') halt();
      if (!st.samples.length) { st.phase = 'idle'; paintAll(); return toast('Nothing was captured', 'err'); }
      st.phase = 'saving'; paintAll();
      const fps = activeMs > 0 ? +(st.samples.length / (activeMs / 1000)).toFixed(1) : null;
      const body = {
        case_id: +opts.caseId(), interview_id: opts.interviewId || null, consent_id: st.consent.id, hr_consent_id: st.hr.length && st.hrConsent ? st.hrConsent.id : null,
        started_at: st.startedAt, ended_at: st.endedAt || new Date().toISOString(), source_type: opts.source, source_name: st.sourceName || '',
        calibration: st.calib || { status: 'skipped', offset_h: 0, offset_v: 0, samples: 0, duration_ms: 0 },
        settings_version: S.version, settings: S, glasses_declared: glasses.checked, is_demo: !!opts.isDemo(),
        software: { library: '@mediapipe/tasks-vision', version: ObserverUI.MEDIAPIPE_VERSION, model: 'face_landmarker.task (float16 v1, 478 landmarks with irises)',
          loaded_from: mp && mp.local ? 'local vendor copy' : 'jsDelivr CDN', delegate: st.delegate, num_faces: 2, sample_hz: S.sample_hz, achieved_fps: fps,
          processing: 'in-browser; no frames stored', user_agent: navigator.userAgent.slice(0, 120) },
        samples: st.samples, markers: st.markers, heart_rate: st.hr,
      };
      try {
        const r = await api('/api/gaze/sessions', { method: 'POST', json: body });
        st.savedId = r.id; st.samples = []; st.markers = []; st.hr = [];
        st.phase = 'idle';
        toast(`Gaze session #${r.id} saved`, 'ok');
        opts.onSaved && opts.onSaved(r.id);
      } catch (e) { st.phase = 'stopped'; fail(e); }
      paintAll();
    }

    /* ------------------------------------------------------------------ painting */
    const m = {};
    const metric = (k, label) => { m[k] = h('div', { class: 'v' }, '-'); return h('div', { class: 'metric' }, h('div', { class: 'k' }, label), m[k]); };
    const metrics = h('div', { class: 'live-metrics' }, metric('hl', 'Horizontal'), metric('vl', 'Vertical'), metric('conf', 'Tracking conf.'), metric('usable', 'Usable %'), metric('blinks', 'Blinks'), metric('hr', 'Heart rate'));
    const reasonLine = h('div', { class: 'gaze-reason' });

    function paintLive() {
      if (st.phase === 'calibrating') {
        const left = Math.max(0, Math.ceil((calibUntil - elapsed()) / 1000));
        statusLine.textContent = `Calibrating camera position: ask the subject to look at the camera lens. ${left} s left.`;
      }
      if (!live.q) return;
      const n = st.samples.length;
      const lab = live.lab;
      m.hl.textContent = st.phase === 'calibrating' ? '-' : lab ? lab.horizontal_label : '-';
      m.vl.textContent = st.phase === 'calibrating' ? '-' : lab ? lab.vertical_label : '-';
      m.conf.textContent = live.conf.toFixed(2);
      m.usable.textContent = n ? Math.round((100 * st.samples.filter((s) => s.horizontal_label !== 'unavailable').length) / n) : '-';
      m.blinks.textContent = st.samples.filter((s) => s.blink_event).length;
      m.hr.textContent = hrLink.last && hrLink.connected ? hrLink.last.bpm : '-';
      [m.hl, m.vl].forEach((el) => { el.style.color = el.textContent === 'unavailable' ? 'var(--dim)' : ''; });
      reasonLine.textContent = live.reason ? 'Not reliably measurable: ' + REASON_TEXT[live.reason] : '';
      if (!qualityBox.classList.contains('hidden')) paintQuality();
    }

    function paintQuality() {
      const q = live.q || {};
      const f = (v, d = 1) => (v == null || !isFinite(v) ? '-' : (+v).toFixed(d));
      const fps = st.phase === 'recording' && !st.paused && st.samples.length ? (st.samples.length / ((activeMs + performance.now() - activeFrom) / 1000)).toFixed(1) : '-';
      const rows = [
        ['Faces in view', q.faces == null ? '-' : q.faces], ['Eye-to-eye distance (px)', f(q.iod_px, 0) + ` (min ${S.min_iod_px})`],
        ['Head yaw / pitch (deg)', `${f(q.yaw)} / ${f(q.pitch)} (limits ${S.max_yaw_deg} / ${S.max_pitch_deg})`],
        ['Brightness (0-255)', f(q.brightness, 0) + ` (low below ${S.low_light})`], ['Sharpness', f(q.sharpness, 0) + ` (blur below ${S.blur_sharpness})`],
        ['Glare near eyes', q.glare == null ? '-' : (q.glare * 100).toFixed(1) + '%'], ['Eye disagreement', f(q.disagreement, 2)],
        ['Landmark motion', f(q.energy, 2)], ['Tracking confidence', live.conf == null ? '-' : live.conf.toFixed(2) + ` (needs ${S.min_confidence})`],
        ['Quality flags', (live.flags || []).join(', ') || 'none'], ['Calibration', st.calib ? `${st.calib.status}${st.calib.status !== 'skipped' ? `, usable ${Math.round((st.calib.usable_fraction || 0) * 100)}%, spread ${st.calib.spread_h} / ${st.calib.spread_v}` : ''}` : st.phase === 'calibrating' ? 'in progress' : '-'],
        ['Samples per second', fps + ` (target ${S.sample_hz})`],
      ];
      set(qualityBox, h('table', { class: 'gaze-quality' }, h('tbody', null, rows.map(([k, v]) => h('tr', null, h('td', { class: 'muted' }, k), h('td', null, String(v)))))),
        h('p', { class: 'dim', style: 'font-size:11.5px;margin:6px 0 0' }, 'Confidence is a heuristic quality estimate, not a probability. Direction is reported only with one face, eyes open, iris visible, head within limits and confidence at least ' + S.min_confidence + '.'));
    }

    function paintControls() {
      const p = st.phase;
      const busy = p === 'loading' || p === 'saving';
      const can = !!st.consent && App.can('investigator');
      const btn = (label, fn, cls = '', dis = false) => h('button', { class: 'btn small ' + cls, disabled: dis || busy, onclick: fn }, label);
      const rows = [];
      if (p === 'idle' || p === 'loading') {
        rows.push(h('div', { class: 'row' }, btn('Calibrate, then start', () => begin(true), 'primary', !can), btn('Start without calibration', () => begin(false), '', !can),
          h('label', { class: 'chk' }, glasses, 'Subject wears glasses')));
        if (opts.allowFile) rows.push(h('div', { class: 'row', style: 'margin-top:6px' }, h('label', { class: 'chk' }, srcWeb, 'Webcam'), h('label', { class: 'chk' }, srcFile, 'Video file'), fileIn));
        rows.push(h('p', { class: 'dim', style: 'font-size:11.5px;margin:6px 0 0' }, 'Calibration (optional, 25 s): the subject looks at the camera lens so the camera position can be corrected for this session only. It is not a personal baseline.'));
      } else if (p === 'calibrating') {
        rows.push(h('div', { class: 'row' }, btn('Finish calibration now', () => finishCalibration(true)), btn('Stop', () => { halt(); discard(true); })));
      } else if (p === 'recording') {
        rows.push(h('div', { class: 'row' }, st.paused ? btn('Resume', resume, 'primary') : btn('Pause', pause), btn('Stop and save', stopAndSave, 'primary'),
          btn('Quality details', () => { qualityBox.classList.toggle('hidden'); paintQuality(); })));
        rows.push(h('div', { class: 'row', style: 'margin-top:6px;flex-wrap:nowrap' }, markIn, btn('Add manual marker', () => { addMarker('manual', markIn.value.trim() || 'Manual marker'); markIn.value = ''; toast('Marker added'); }),
          opts.questionButton ? btn('Next question marker', () => { const n = (st.qid || 0) + 1; setQuestion(n, markIn.value.trim() || `Question ${n}`); markIn.value = ''; toast(`Question ${n} marker added`); }) : null));
      } else if (p === 'stopped') {
        rows.push(h('div', { class: 'notice ' + (st.cameraLost ? 'bad' : 'info') }, `${st.cameraLost ? 'Camera access ended. ' : ''}${st.samples.length} samples captured (${(st.samples[st.samples.length - 1].timestamp_ms / 1000).toFixed(0)} s). Nothing is saved until you choose Save.`),
          h('div', { class: 'row', style: 'margin-top:6px' }, btn('Save', stopAndSave, 'primary'), btn('Discard', () => discard(false))));
      }
      set(controls, rows);
    }

    function paintStatus() {
      const p = st.phase;
      statusLine.className = 'gaze-status' + (p === 'recording' && !st.paused ? ' on' : '');
      if (p === 'recording') statusLine.textContent = st.paused ? 'Paused - nothing is being measured.' : STATUS();
      else if (p === 'idle') statusLine.textContent = st.consent ? 'Ready. Nothing is being measured.' : 'Record consent to enable capture.';
      else if (p === 'saving') statusLine.textContent = 'Saving measurements...';
      else if (p === 'stopped') statusLine.textContent = 'Stopped.';
    }
    let statusText = 'Measuring visible gaze direction and tracking quality only.';
    const STATUS = () => statusText;

    function paintResult() {
      set(resultBox, st.savedId ? h('div', { class: 'notice info', style: 'margin-top:8px' }, `Saved as gaze session #${st.savedId}. `, h('a', { href: '#/gaze/' + st.savedId }, 'Open the timeline and per-question summary')) : null);
    }

    function paintAll() {
      if (disposed) return;
      paintConsent().catch(fail); paintHr(); paintControls(); paintStatus(); paintResult();
      const active = ['calibrating', 'recording'].includes(st.phase);
      liveBox.style.display = active || st.phase === 'loading' ? '' : 'none';
      if (!active) qualityBox.classList.add('hidden');
    }

    root.append(h('div', { class: 'row sp' }, h('h3', { style: 'margin:0' }, 'Gaze observation (optional)'), badge('measurement only', 'b-info')),
      h('div', { class: 'notice warn', style: 'margin:8px 0' }, h('b', null, 'Academic prototype. '), 'Eye movement does not establish truthfulness or deception. ', 'Direction estimates can be affected by camera placement, lighting, glasses, head position, distance, and tracking quality.'),
      consentBox, hrBox, h('div', { style: 'margin-top:10px' }, controls), statusLine,
      h('div', null, liveBox), resultBox);
    liveBox.append(wrap, metrics, reasonLine, qualityBox);

    config().then((cfg) => { statusText = cfg.disclaimers.status; hrConsentText = cfg.consent_text.heart_rate; paintAll(); }).catch(fail);
    paintAll();

    return {
      el: root,
      onQuestion: (id, text) => setQuestion(id, text),
      running: () => ['loading', 'calibrating', 'recording'].includes(st.phase),
      hasUnsaved: () => st.samples.length > 0,
      stopAndSave,
      destroy: () => { disposed = true; release(); hrLink.disconnect().catch(() => {}); },
    };
  }

  window.GazeUI = { capture, HeartRateLink, REASON_TEXT };
})();
