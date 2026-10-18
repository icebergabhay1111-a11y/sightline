/* Gaze Observation - pure measurement helpers (no DOM, no MediaPipe) so they can be unit-tested in Node.

   SCOPE: these functions estimate where the irises sit inside the eye openings, from face-mesh landmarks, and turn
   that into neutral direction labels (left/center/right, up/center/down) with a tracking-quality estimate.
   They describe camera-observed movement only. Nothing here infers thoughts, memory, intent, emotion or truthfulness,
   and nothing here produces a score about a person.

   Conventions
   * left / right are from the SUBJECT's own point of view (their left), not the viewer's.
   * horizontal_offset: -1 = far toward subject's left, +1 = far toward subject's right, 0 = centred.
   * vertical_offset:   -1 = far down, +1 = far up.
   * tracking_confidence is a heuristic 0..1 quality estimate built from face size, head angle, light, blur, eye
     agreement and calibration. MediaPipe exposes no per-frame confidence, so this is NOT a model probability.
*/
(function (root) {
  const SETTINGS = Object.freeze({
    version: 'gaze-1.0',
    sample_hz: 10,                 // samples recorded per second
    ema_alpha: 0.35,               // exponential smoothing of offsets (0..1, higher = less smoothing)
    h_enter: 0.35, h_exit: 0.20,   // hysteresis for horizontal labels (on smoothed, normalised offset)
    v_enter: 0.40, v_exit: 0.25,   // hysteresis for vertical labels
    min_dwell_ms: 200,             // a new label must persist this long before it is accepted
    reset_gap_ms: 500,             // after an unavailable gap this long, smoothing restarts
    h_scale: 0.5,                  // iris position along the eye axis that maps to |offset| = 1
    v_scale: 0.12,                 // iris distance from the eye axis (in eye widths) that maps to |offset| = 1
    min_confidence: 0.5,           // below this the direction is "Not reliably measurable"
    max_yaw_deg: 25, max_pitch_deg: 20,
    min_iod_px: 40,                // eye-to-eye distance below this = face_too_small
    blink_on: 0.5, blink_off: 0.35, blink_min_ms: 40, blink_max_ms: 1000,
    low_light: 50, blur_sharpness: 30, motion_energy: 1.2, glare_fraction: 0.04, glare_level: 245,
    eye_disagreement: 0.5,
    calibration: Object.freeze({ min_s: 20, max_s: 30, min_usable: 0.6, max_spread: 0.15 }),
    dominant_min_usable: 0.6,      // per-question dominant direction is shown only above this usable share
  });

  const H_LABELS = ['left', 'center', 'right', 'unavailable'];
  const V_LABELS = ['up', 'center', 'down', 'unavailable'];
  const QUALITY_FLAGS = ['low_light', 'glare', 'glasses_or_occlusion', 'extreme_head_turn', 'face_too_small',
    'motion_blur', 'multiple_faces', 'iris_not_visible', 'camera_angle_issue'];

  // MediaPipe Face Landmarker indices (478-point model with irises).
  const EYES = {
    right: { a: 33, b: 133, iris: 468 },   // subject's right eye (appears on the image's left)
    left: { a: 362, b: 263, iris: 473 },   // subject's left eye
  };

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const round = (v, d = 3) => (v == null || !isFinite(v) ? null : +v.toFixed(d));

  /* Position of one iris inside its eye, in image pixels. Returns h_img (-1..1 along the corner axis, + = image right),
     v_img (distance from the axis in eye widths, + = image down), eye width in px and whether the iris is inside. */
  function eyePosition(lms, eye, w, h) {
    const P = (i) => ({ x: lms[i].x * w, y: lms[i].y * h });
    let A = P(eye.a), B = P(eye.b);
    if (A.x > B.x) [A, B] = [B, A];
    const I = P(eye.iris);
    const ax = B.x - A.x, ay = B.y - A.y;
    const len2 = ax * ax + ay * ay;
    const len = Math.sqrt(len2);
    if (len < 1e-6) return null;
    const t = ((I.x - A.x) * ax + (I.y - A.y) * ay) / len2;
    const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
    const v = ((I.x - mx) * -ay + (I.y - my) * ax) / len2;   // perpendicular distance / eye width (+ = image down)
    return { h_img: 2 * t - 1, v_img: v, width_px: len, inside: t > -0.05 && t < 1.05 && Math.abs(v) < 0.4 };
  }

  /* Raw (uncalibrated) normalised offsets from both eyes. */
  function rawOffsets(lms, w, h, s = SETTINGS) {
    if (!lms || lms.length < 478) return null;
    const r = eyePosition(lms, EYES.right, w, h), l = eyePosition(lms, EYES.left, w, h);
    if (!r || !l) return null;
    const hImg = (r.h_img + l.h_img) / 2;
    const vImg = (r.v_img + l.v_img) / 2;
    const cx = (k) => (lms[EYES[k].a].x + lms[EYES[k].b].x) / 2 * w, cy = (k) => (lms[EYES[k].a].y + lms[EYES[k].b].y) / 2 * h;
    return {
      // image right = subject's left, so the sign flips for the subject-perspective convention
      h: clamp(-hImg / s.h_scale, -1, 1),
      v: clamp(-vImg / s.v_scale, -1, 1),
      disagreement: Math.abs(r.h_img - l.h_img) / s.h_scale,
      inside: r.inside && l.inside,
      iod_px: Math.hypot(cx('right') - cx('left'), cy('right') - cy('left')),
    };
  }

  /* Fraction of very bright pixels in a grey image (e.g. a crop around the eyes): specular glare from glasses or lights. */
  function glareFraction(gray, level = SETTINGS.glare_level) {
    if (!gray || !gray.length) return 0;
    let n = 0;
    for (let i = 0; i < gray.length; i++) if (gray[i] >= level) n++;
    return n / gray.length;
  }

  /* Quality flags for one frame. q: {faces, iod_px, yaw, pitch, brightness, sharpness, energy, glare, disagreement,
     inside, eyes_closed, glasses_declared, calibrated} */
  function qualityFlags(q, s = SETTINGS) {
    const f = [];
    if (q.brightness != null && q.brightness < s.low_light) f.push('low_light');
    if (q.glare != null && q.glare > s.glare_fraction) f.push('glare');
    if (q.glasses_declared || (q.disagreement != null && q.disagreement > s.eye_disagreement)) f.push('glasses_or_occlusion');
    if ((q.yaw != null && Math.abs(q.yaw) > s.max_yaw_deg) || (q.pitch != null && Math.abs(q.pitch) > s.max_pitch_deg)) f.push('extreme_head_turn');
    if (q.iod_px != null && q.iod_px < s.min_iod_px) f.push('face_too_small');
    if ((q.sharpness != null && q.sharpness < s.blur_sharpness) || (q.energy != null && q.energy > s.motion_energy)) f.push('motion_blur');
    if (q.faces > 1) f.push('multiple_faces');
    if (q.faces === 1 && (q.inside === false || q.eyes_closed)) f.push('iris_not_visible');
    if (q.faces >= 1 && q.calibrated === false) f.push('camera_angle_issue');
    return f;
  }

  /* Heuristic 0..1 tracking-quality estimate. Documented, deterministic, not a model probability. */
  function trackingConfidence(q, s = SETTINGS) {
    if (!q.faces || q.faces !== 1 || q.inside === false || q.eyes_closed) return 0;
    let c = 1;
    if (q.iod_px != null) c *= clamp((q.iod_px - 30) / 30, 0, 1);
    const ang = Math.max(Math.abs(q.yaw || 0) / s.max_yaw_deg, Math.abs(q.pitch || 0) / s.max_pitch_deg);
    c *= ang >= 1 ? 0 : 1 - 0.6 * ang * ang;
    if (q.brightness != null) c *= q.brightness < s.low_light ? 0.4 : q.brightness < 70 ? 0.75 : q.brightness > 230 ? 0.6 : 1;
    if (q.sharpness != null) c *= q.sharpness < s.blur_sharpness ? 0.5 : q.sharpness < 60 ? 0.8 : 1;
    if (q.disagreement != null) c *= q.disagreement > s.eye_disagreement ? 0.5 : 1 - 0.5 * q.disagreement;
    if (q.glare != null && q.glare > s.glare_fraction) c *= 0.7;
    if (q.calibrated === false) c *= 0.85;
    return round(clamp(c, 0, 1), 2);
  }

  /* Why the direction is not reported for this frame (null = it can be reported). Order matters: first reason wins. */
  function unavailableReason(q, conf, s = SETTINGS) {
    if (!q.faces) return 'face_not_visible';
    if (q.faces > 1) return 'multiple_faces';
    if (q.eyes_closed) return 'eyes_closed';
    if (q.inside === false || q.raw == null) return 'iris_not_visible';
    if ((q.yaw != null && Math.abs(q.yaw) > s.max_yaw_deg) || (q.pitch != null && Math.abs(q.pitch) > s.max_pitch_deg)) return 'extreme_head_turn';
    if (conf < s.min_confidence) return 'low_confidence';
    return null;
  }

  /* One axis of the labeler: exponential smoothing + hysteresis + minimum dwell time. */
  class AxisLabeler {
    constructor(neg, pos, enter, exit, alpha, dwell) {
      Object.assign(this, { neg, pos, enter, exit, alpha, dwell });
      this.reset();
    }
    reset() { this.s = null; this.label = null; this.cand = null; this.candAt = 0; }
    target(s) {
      const L = this.label;
      if (L === this.neg) return s >= this.enter ? this.pos : s > -this.exit ? 'center' : this.neg;
      if (L === this.pos) return s <= -this.enter ? this.neg : s < this.exit ? 'center' : this.pos;
      return s <= -this.enter ? this.neg : s >= this.enter ? this.pos : 'center';   // from center (or start)
    }
    update(t, x) {
      this.s = this.s == null ? x : this.alpha * x + (1 - this.alpha) * this.s;
      if (this.label == null) { this.label = this.target(this.s); return { label: this.label, s: this.s, changed: false }; }
      const want = this.target(this.s);
      if (want === this.label) { this.cand = null; return { label: this.label, s: this.s, changed: false }; }
      if (this.cand !== want) { this.cand = want; this.candAt = t; }
      if (t - this.candAt >= this.dwell) { this.label = want; this.cand = null; return { label: this.label, s: this.s, changed: true }; }
      return { label: this.label, s: this.s, changed: false };
    }
  }

  /* Turns per-frame offsets into stable neutral labels. update(t_ms, offsets|null) where null = unavailable. */
  class GazeLabeler {
    constructor(s = SETTINGS) {
      this.s = s;
      this.hx = new AxisLabeler('left', 'right', s.h_enter, s.h_exit, s.ema_alpha, s.min_dwell_ms);
      this.vx = new AxisLabeler('down', 'up', s.v_enter, s.v_exit, s.ema_alpha, s.min_dwell_ms);
      this.lastAvail = null; this.since = null; this.combined = null;
    }
    update(t, off) {
      if (!off) {
        if (this.lastAvail != null && t - this.lastAvail > this.s.reset_gap_ms) { this.hx.reset(); this.vx.reset(); this.combined = null; }
        return { horizontal_label: 'unavailable', vertical_label: 'unavailable', horizontal_offset: null, vertical_offset: null, stability_ms: 0, shift_event: false };
      }
      const resumed = this.lastAvail == null || t - this.lastAvail > this.s.reset_gap_ms;
      if (resumed) { this.hx.reset(); this.vx.reset(); this.combined = null; }
      this.lastAvail = t;
      const a = this.hx.update(t, off.h), b = this.vx.update(t, off.v);
      const comb = a.label + '/' + b.label;
      let shift = false;
      if (this.combined == null) { this.combined = comb; this.since = t; }
      else if (comb !== this.combined) { shift = true; this.combined = comb; this.since = t; }
      return { horizontal_label: a.label, vertical_label: b.label, horizontal_offset: round(clamp(a.s, -1, 1)), vertical_offset: round(clamp(b.s, -1, 1)),
        stability_ms: Math.round(t - this.since), shift_event: shift };
    }
  }

  /* Blink and eye-closure events from the eye-blink blendshape score (0..1). */
  class BlinkTracker {
    constructor(s = SETTINGS) { this.s = s; this.closed = false; this.at = 0; }
    update(t, score, faceVisible) {
      const out = { blink_event: false, eyes_closed: false, eyes_closed_event: false, closed_duration_ms: null };
      if (!faceVisible || score == null) { this.closed = false; return out; }
      if (!this.closed && score >= this.s.blink_on) { this.closed = true; this.at = t; }
      else if (this.closed && score <= this.s.blink_off) {
        this.closed = false;
        const d = t - this.at;
        if (d >= this.s.blink_min_ms) {
          out.closed_duration_ms = Math.round(d);
          if (d <= this.s.blink_max_ms) out.blink_event = true; else out.eyes_closed_event = true;
        }
      }
      out.eyes_closed = this.closed;
      return out;
    }
  }

  const median = (a) => { const b = a.slice().sort((x, y) => x - y); const m = b.length >> 1; return b.length ? (b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2) : null; };
  const mad = (a, m) => median(a.map((x) => Math.abs(x - m)));

  /* Optional camera-position calibration: the subject looks at the camera lens for 20-30 s. The median offset is
     subtracted for the rest of THIS session only, to reduce bias from where the camera sits. It is not a profile of
     the person, not a behavioural baseline, and it is never reused for another session. */
  class Calibrator {
    constructor(s = SETTINGS) { this.s = s; this.h = []; this.v = []; this.total = 0; }
    add(off) { this.total++; if (off) { this.h.push(off.h); this.v.push(off.v); } }
    result() {
      const n = this.h.length, usable = this.total ? n / this.total : 0;
      if (!n) return { status: 'poor', offset_h: 0, offset_v: 0, usable_fraction: 0, spread_h: null, spread_v: null, samples: this.total };
      const mh = median(this.h), mv = median(this.v), sh = mad(this.h, mh), sv = mad(this.v, mv);
      const good = usable >= this.s.calibration.min_usable && sh <= this.s.calibration.max_spread && sv <= this.s.calibration.max_spread;
      return { status: good ? 'completed' : 'poor', offset_h: round(mh), offset_v: round(mv), usable_fraction: round(usable, 2),
        spread_h: round(sh), spread_v: round(sv), samples: this.total };
    }
  }

  function applyCalibration(off, cal) {
    if (!off || !cal || cal.status !== 'completed') return off;
    return Object.assign({}, off, { h: clamp(off.h - cal.offset_h, -1, 1), v: clamp(off.v - cal.offset_v, -1, 1) });
  }

  /* Bluetooth Heart Rate Measurement characteristic (0x2A37), Bluetooth SIG Heart Rate Service spec. */
  function parseHeartRate(dv) {
    const flags = dv.getUint8(0);
    let i = 1;
    const wide = flags & 0x01;
    const bpm = wide ? dv.getUint16(i, true) : dv.getUint8(i);
    i += wide ? 2 : 1;
    const contactSupported = !!(flags & 0x04);
    const contact = contactSupported ? !!(flags & 0x02) : null;
    let energy = null;
    if (flags & 0x08) { energy = dv.getUint16(i, true); i += 2; }
    const rr = [];
    if (flags & 0x10) for (; i + 1 < dv.byteLength; i += 2) rr.push(Math.round((dv.getUint16(i, true) / 1024) * 1000));
    return { bpm, contact, energy_kj: energy, rr_ms: rr };
  }

  const api = { SETTINGS, H_LABELS, V_LABELS, QUALITY_FLAGS, EYES, eyePosition, rawOffsets, glareFraction, qualityFlags,
    trackingConfidence, unavailableReason, AxisLabeler, GazeLabeler, BlinkTracker, Calibrator, applyCalibration, parseHeartRate, median };
  root.GazeCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
