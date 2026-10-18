// Run with:  node --test tests/js/gaze_core.test.js
const test = require('node:test');
const assert = require('node:assert');
const G = require('../../app/static/js/gaze_core.js');

const W = 640, H = 480;
/* Synthetic 478-point face: eyes 0.08 wide; iris placed at fraction t along the eye and dy (image units) off the axis. */
function face({ t = 0.5, dy = 0, tl = t, dyl = dy, scale = 1 } = {}) {
  const p = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  const eye = (a, b, iris, x0, tt, d) => {
    p[a] = { x: x0, y: 0.45, z: 0 }; p[b] = { x: x0 + 0.08 * scale, y: 0.45, z: 0 };
    p[iris] = { x: x0 + 0.08 * scale * tt, y: 0.45 + d, z: 0 };
  };
  eye(33, 133, 468, 0.5 - 0.12 * scale, t, dy);        // subject's right eye (image left)
  eye(362, 263, 473, 0.5 + 0.04 * scale, tl, dyl);    // subject's left eye
  return p;
}

test('offsets: centred, subject-right, subject-left, up, down', () => {
  const c = G.rawOffsets(face(), W, H);
  assert.ok(Math.abs(c.h) < 1e-9 && Math.abs(c.v) < 1e-9 && c.inside);
  assert.ok(G.rawOffsets(face({ t: 0.3 }), W, H).h > 0.5, 'iris toward image-left = subject right = positive');
  assert.ok(G.rawOffsets(face({ t: 0.7 }), W, H).h < -0.5, 'iris toward image-right = subject left = negative');
  assert.ok(G.rawOffsets(face({ dy: -0.008 }), W, H).v > 0.5, 'iris higher in the image = up = positive');
  assert.ok(G.rawOffsets(face({ dy: 0.008 }), W, H).v < -0.5);
  assert.ok(G.rawOffsets(face({ t: 1.3 }), W, H).inside === false, 'iris outside the eye opening');
  assert.ok(G.rawOffsets(face({ t: 0.2, tl: 0.8 }), W, H).disagreement > 1, 'eyes pointing different ways');
  assert.strictEqual(G.rawOffsets(null, W, H), null);
});

test('labeler: hysteresis prevents flicker between thresholds', () => {
  const L = new G.GazeLabeler();
  let shifts = 0, labels = new Set();
  for (let i = 0; i < 60; i++) {           // 6 s at 10 Hz hovering between exit (0.20) and enter (0.35)
    const r = L.update(i * 100, { h: i % 2 ? 0.3 : 0.25, v: 0 });
    shifts += r.shift_event; labels.add(r.horizontal_label);
  }
  assert.deepStrictEqual([...labels], ['center']);
  assert.strictEqual(shifts, 0);
});

test('labeler: sustained change is accepted once, then held until below the exit threshold', () => {
  const L = new G.GazeLabeler();
  let t = 0, out = [];
  const feed = (h, n) => { for (let i = 0; i < n; i++, t += 100) out.push(L.update(t, { h, v: 0 })); };
  feed(0, 10); feed(0.8, 12);
  assert.strictEqual(out[out.length - 1].horizontal_label, 'right');
  assert.strictEqual(out.filter((o) => o.shift_event).length, 1);
  feed(0.27, 15);                           // between exit and enter: stays right
  assert.strictEqual(out[out.length - 1].horizontal_label, 'right');
  feed(0.0, 15);
  assert.strictEqual(out[out.length - 1].horizontal_label, 'center');
  assert.strictEqual(out.filter((o) => o.shift_event).length, 2);
  assert.ok(out[out.length - 1].stability_ms > 0);
});

test('labeler: short spikes shorter than the dwell time are ignored', () => {
  const L = new G.GazeLabeler({ ...G.SETTINGS, ema_alpha: 1 });   // no smoothing, isolate the dwell rule
  const seq = [0, 0, 0, 0.9, 0, 0, 0];
  const out = seq.map((h, i) => L.update(i * 100, { h, v: 0 }));
  assert.ok(out.every((o) => o.horizontal_label === 'center') && !out.some((o) => o.shift_event));
});

test('labeler: unavailable frames give "unavailable" and no shift is counted on resume', () => {
  const L = new G.GazeLabeler();
  for (let i = 0; i < 20; i++) L.update(i * 100, { h: 0.9, v: 0 });
  const gap = L.update(2100, null);
  assert.strictEqual(gap.horizontal_label, 'unavailable');
  assert.strictEqual(gap.horizontal_offset, null);
  const back = [];
  for (let i = 0; i < 10; i++) back.push(L.update(3000 + i * 100, { h: -0.9, v: 0 }));
  assert.ok(!back.some((o) => o.shift_event), 'returning from unavailable is not a gaze shift');
  assert.strictEqual(back[back.length - 1].horizontal_label, 'left');
});

const goodQ = { faces: 1, iod_px: 90, yaw: 0, pitch: 0, brightness: 120, sharpness: 200, disagreement: 0, inside: true, eyes_closed: false, calibrated: true, raw: {} };

test('unavailable rules: each blocking condition returns "not reliably measurable"', () => {
  const c = (q) => G.trackingConfidence(q);
  const reason = (q) => G.unavailableReason(q, c(q));
  assert.strictEqual(reason(goodQ), null);
  assert.ok(c(goodQ) > 0.9);
  assert.strictEqual(reason({ ...goodQ, faces: 0 }), 'face_not_visible');
  assert.strictEqual(reason({ ...goodQ, faces: 2 }), 'multiple_faces');
  assert.strictEqual(c({ ...goodQ, faces: 2 }), 0);
  assert.strictEqual(reason({ ...goodQ, eyes_closed: true }), 'eyes_closed');
  assert.strictEqual(reason({ ...goodQ, inside: false }), 'iris_not_visible');
  assert.strictEqual(reason({ ...goodQ, yaw: 30 }), 'extreme_head_turn');
  assert.strictEqual(reason({ ...goodQ, pitch: -25 }), 'extreme_head_turn');
  assert.strictEqual(reason({ ...goodQ, brightness: 30, sharpness: 20 }), 'low_confidence');
  assert.strictEqual(reason({ ...goodQ, iod_px: 32 }), 'low_confidence');
});

test('quality flags', () => {
  const f = (q) => G.qualityFlags({ ...goodQ, ...q });
  assert.deepStrictEqual(f({}), []);
  assert.ok(f({ brightness: 20 }).includes('low_light'));
  assert.ok(f({ glare: 0.1 }).includes('glare'));
  assert.ok(f({ glasses_declared: true }).includes('glasses_or_occlusion'));
  assert.ok(f({ disagreement: 0.9 }).includes('glasses_or_occlusion'));
  assert.ok(f({ yaw: 40 }).includes('extreme_head_turn'));
  assert.ok(f({ iod_px: 20 }).includes('face_too_small'));
  assert.ok(f({ sharpness: 5 }).includes('motion_blur'));
  assert.ok(f({ energy: 3 }).includes('motion_blur'));
  assert.ok(f({ faces: 3 }).includes('multiple_faces'));
  assert.ok(f({ inside: false }).includes('iris_not_visible'));
  assert.ok(f({ calibrated: false }).includes('camera_angle_issue'));
  assert.ok(f({ faces: 3 }).every((x) => G.QUALITY_FLAGS.includes(x)));
});

test('blink tracker: blink vs prolonged closure vs no face', () => {
  const B = new G.BlinkTracker();
  const run = (pairs) => pairs.map(([t, s, vis = true]) => B.update(t, s, vis));
  let o = run([[0, 0.1], [100, 0.8], [250, 0.1]]);
  assert.ok(o[1].eyes_closed && o[2].blink_event && o[2].closed_duration_ms === 150 && !o[2].eyes_closed_event);
  o = run([[1000, 0.9], [2600, 0.1]]);
  assert.ok(o[1].eyes_closed_event && !o[1].blink_event && o[1].closed_duration_ms === 1600);
  o = run([[3000, 0.9], [3100, 0.9, false], [3200, 0.1]]);
  assert.ok(!o[2].blink_event && !o[2].eyes_closed_event, 'losing the face cancels the closure');
});

test('calibration: steady offsets complete, noisy or empty ones are poor; correction only when completed', () => {
  const C = new G.Calibrator();
  for (let i = 0; i < 250; i++) C.add({ h: 0.2 + (i % 3) * 0.01, v: -0.1 });
  const r = C.result();
  assert.strictEqual(r.status, 'completed');
  assert.ok(Math.abs(r.offset_h - 0.21) < 0.011 && Math.abs(r.offset_v + 0.1) < 1e-9);
  assert.ok(Math.abs(G.applyCalibration({ h: 0.21, v: -0.1 }, r).h) < 1e-9);
  const N = new G.Calibrator();
  for (let i = 0; i < 250; i++) N.add(i % 2 ? { h: (i % 7) / 3 - 1, v: 0 } : null);
  assert.strictEqual(N.result().status, 'poor');
  assert.deepStrictEqual(G.applyCalibration({ h: 0.5, v: 0 }, N.result()), { h: 0.5, v: 0 });
  assert.strictEqual(new G.Calibrator().result().status, 'poor');
});

test('heart-rate measurement parsing (Bluetooth 0x2A37)', () => {
  const dv = (bytes) => new DataView(Uint8Array.from(bytes).buffer);
  assert.deepStrictEqual(G.parseHeartRate(dv([0x00, 72])), { bpm: 72, contact: null, energy_kj: null, rr_ms: [] });
  // uint16 bpm 300 (0x012C), contact supported + detected, RR 1024 -> 1000 ms and 512 -> 500 ms
  assert.deepStrictEqual(G.parseHeartRate(dv([0x17, 0x2c, 0x01, 0x00, 0x04, 0x00, 0x02])), { bpm: 300, contact: true, energy_kj: null, rr_ms: [1000, 500] });
  // contact supported but not detected, energy expended present
  assert.deepStrictEqual(G.parseHeartRate(dv([0x0c, 65, 0x10, 0x00])), { bpm: 65, contact: false, energy_kj: 16, rr_ms: [] });
});

test('every label and flag is from the neutral allow-lists', () => {
  const banned = /lie|liar|truth|decept|suspic|guilt|innocen|stress|emotion|cognitive|recall|construct/i;
  for (const x of [...G.H_LABELS, ...G.V_LABELS, ...G.QUALITY_FLAGS]) assert.ok(!banned.test(x), x);
});
