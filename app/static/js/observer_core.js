/* Pure measurement helpers for the facial-movement module (no DOM, no MediaPipe) so they can be unit-tested in Node.
   Everything here is a MEASUREMENT of visible movement. Nothing here infers emotion, stress or deception. */
(function (root) {
  const THRESHOLDS = {
    BLINK_ON: 0.5, BLINK_OFF: 0.35, BLINK_MIN_S: 0.04, BLINK_MAX_S: 1.0,   // eyeBlink blendshape score (0-1)
    TURN_DEG: 20, TURN_MIN_S: 0.5,                                          // |yaw| in degrees
    BURST: 0.8, BURST_MIN_S: 0.3,                                           // landmark motion, eye-distances per second
    LOST_MIN_S: 0.5,                                                        // no face tracked
    DARK: 50, DARK_MIN_S: 1.0,                                              // mean frame brightness 0-255
  };

  const wrap90 = (a) => (a > 90 ? a - 180 : a < -90 ? a + 180 : a);        // avoids +/-180 flips from axis conventions

  /* m: column-major 4x4 facial transformation matrix (16 numbers). Returns degrees. */
  function headPose(m) {
    if (!m || m.length < 11) return null;
    const R2D = 180 / Math.PI;
    return {
      yaw: Math.asin(Math.max(-1, Math.min(1, -m[2]))) * R2D,
      pitch: wrap90(Math.atan2(m[6], m[10]) * R2D),
      roll: wrap90(Math.atan2(m[1], m[0]) * R2D),
    };
  }

  /* bs: map blendshape name -> score. */
  function faceFeatures(bs) {
    const g = (k) => (bs[k] == null ? 0 : bs[k]);
    const avg = (a, b) => (g(a) + g(b)) / 2;
    return {
      blink: avg('eyeBlinkLeft', 'eyeBlinkRight'),
      // iris direction relative to the eye (approximate; mixes with head pose and camera position)
      gaze_x: (g('eyeLookOutLeft') + g('eyeLookInRight') - g('eyeLookInLeft') - g('eyeLookOutRight')) / 2,
      gaze_y: (g('eyeLookUpLeft') + g('eyeLookUpRight') - g('eyeLookDownLeft') - g('eyeLookDownRight')) / 2,
      mouth_open: g('jawOpen'),
    };
  }

  /* Mean landmark displacement per second, in inter-ocular distances. Includes head AND facial movement. */
  function landmarkEnergy(prev, cur, dt, aspect) {
    if (!prev || !cur || dt <= 0 || cur.length < 264) return null;
    const a = aspect || 1;
    const iod = Math.hypot((cur[33].x - cur[263].x) * a, cur[33].y - cur[263].y);
    if (iod < 1e-4) return null;
    let sum = 0;
    const n = Math.min(prev.length, cur.length);
    for (let i = 0; i < n; i++) sum += Math.hypot((cur[i].x - prev[i].x) * a, cur[i].y - prev[i].y);
    return sum / n / iod / dt;
  }

  /* gray: Uint8 array w*h. Brightness = mean; sharpness = variance of a 4-neighbour Laplacian. */
  function grayStats(gray, w, h) {
    let sum = 0;
    for (let i = 0; i < gray.length; i++) sum += gray[i];
    const mean = sum / gray.length;
    let n = 0, s1 = 0, s2 = 0;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const l = gray[i - 1] + gray[i + 1] + gray[i - w] + gray[i + w] - 4 * gray[i];
      n++; s1 += l; s2 += l * l;
    }
    return { brightness: mean, sharpness: n ? s2 / n - (s1 / n) ** 2 : 0 };
  }

  class EventExtractor {
    constructor(th) {
      this.th = Object.assign({}, THRESHOLDS, th || {});
      this.events = [];
      this.spans = {};
      this.closed = false;
      this.closedAt = 0;
    }
    _span(type, active, t, minDur, detail) {
      const s = this.spans[type];
      const out = [];
      if (active && !s) this.spans[type] = { start: t };
      else if (!active && s) {
        const dur = t - s.start;
        if (dur >= minDur) out.push({ t: +s.start.toFixed(2), type, duration: +dur.toFixed(2), detail });
        delete this.spans[type];
      }
      return out;
    }
    /* s: {t, face:boolean, yaw, energy, brightness, blink} */
    update(s) {
      const th = this.th, out = [];
      if (!s.face) this.closed = false;
      else if (s.blink != null) {
        if (!this.closed && s.blink >= th.BLINK_ON) { this.closed = true; this.closedAt = s.t; }
        else if (this.closed && s.blink <= th.BLINK_OFF) {
          this.closed = false;
          const dur = s.t - this.closedAt;
          if (dur >= th.BLINK_MIN_S && dur <= th.BLINK_MAX_S) out.push({ t: +this.closedAt.toFixed(2), type: 'blink', duration: +dur.toFixed(2), detail: `eye closure ${dur.toFixed(2)} s` });
          else if (dur > th.BLINK_MAX_S) out.push({ t: +this.closedAt.toFixed(2), type: 'eyes_closed_long', duration: +dur.toFixed(2), detail: `eyes closed ${dur.toFixed(1)} s` });
        }
      }
      out.push(...this._span('tracking_lost', !s.face, s.t, th.LOST_MIN_S, 'no face tracked'));
      out.push(...this._span('head_turn', s.face && s.yaw != null && Math.abs(s.yaw) > th.TURN_DEG, s.t, th.TURN_MIN_S, `|yaw| above ${th.TURN_DEG} deg`));
      out.push(...this._span('movement_burst', s.face && s.energy != null && s.energy > th.BURST, s.t, th.BURST_MIN_S, `landmark motion above ${th.BURST}/s`));
      out.push(...this._span('low_light', s.brightness != null && s.brightness < th.DARK, s.t, th.DARK_MIN_S, `brightness below ${th.DARK}`));
      this.events.push(...out);
      return out;
    }
    finish(tEnd) {
      const out = [];
      const min = { tracking_lost: this.th.LOST_MIN_S, head_turn: this.th.TURN_MIN_S, movement_burst: this.th.BURST_MIN_S, low_light: this.th.DARK_MIN_S };
      for (const [type, sp] of Object.entries(this.spans)) {
        const dur = tEnd - sp.start;
        if (dur >= min[type]) out.push({ t: +sp.start.toFixed(2), type, duration: +dur.toFixed(2), detail: 'still ongoing when recording ended' });
      }
      this.spans = {};
      this.events.push(...out);
      return out;
    }
  }

  const api = { THRESHOLDS, wrap90, headPose, faceFeatures, landmarkEnergy, grayStats, EventExtractor };
  root.ObserverCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
