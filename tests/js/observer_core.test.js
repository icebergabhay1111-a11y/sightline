// Run with:  node --test tests/js/observer_core.test.js
const test = require('node:test');
const assert = require('node:assert');
const C = require('../../app/static/js/observer_core.js');

const rotY = (d) => { const a = d * Math.PI / 180, c = Math.cos(a), s = Math.sin(a); return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]; };
const rotX = (d) => { const a = d * Math.PI / 180, c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]; };
const rotZ = (d) => { const a = d * Math.PI / 180, c = Math.cos(a), s = Math.sin(a); return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; };

test('headPose recovers yaw/pitch/roll', () => {
  assert.ok(Math.abs(C.headPose(rotY(30)).yaw - 30) < 1e-6);
  assert.ok(Math.abs(C.headPose(rotX(20)).pitch - 20) < 1e-6);
  assert.ok(Math.abs(C.headPose(rotZ(10)).roll - 10) < 1e-6);
  assert.strictEqual(C.headPose(null), null);
});
test('wrap90 removes 180-degree flips', () => {
  assert.strictEqual(C.wrap90(179), -1);
  assert.strictEqual(C.wrap90(-178), 2);
  assert.strictEqual(C.wrap90(15), 15);
});

function run(ex, hz, dur, f) {
  for (let i = 0; i <= dur * hz; i++) { const t = i / hz; ex.update(Object.assign({ t, face: true, yaw: 0, energy: 0.1, brightness: 120, blink: 0.05 }, f(t))); }
  ex.finish(dur);
  return ex.events;
}
test('detects three blinks and ignores sub-threshold flicker', () => {
  const closures = [[1.0, 1.2], [3.0, 3.2], [5.0, 5.2]];
  const ev = run(new C.EventExtractor(), 10, 8, (t) => ({ blink: closures.some(([a, b]) => t >= a && t < b) ? 0.8 : (Math.abs(t - 6.5) < 0.01 ? 0.45 : 0.05) }));
  const blinks = ev.filter((e) => e.type === 'blink');
  assert.strictEqual(blinks.length, 3);
  assert.ok(Math.abs(blinks[0].t - 1.0) < 1e-9 && Math.abs(blinks[0].duration - 0.2) < 1e-9);
});
test('long eye closure is not counted as a blink', () => {
  const ev = run(new C.EventExtractor(), 10, 6, (t) => ({ blink: t >= 1 && t < 3 ? 0.9 : 0.05 }));
  assert.strictEqual(ev.filter((e) => e.type === 'blink').length, 0);
  assert.strictEqual(ev.filter((e) => e.type === 'eyes_closed_long').length, 1);
});
test('head turn needs >20 deg for >=0.5 s', () => {
  const ev = run(new C.EventExtractor(), 10, 8, (t) => ({ yaw: t >= 2 && t < 4 ? 30 : (t >= 6 && t < 6.3 ? 40 : 0) }));
  const turns = ev.filter((e) => e.type === 'head_turn');
  assert.strictEqual(turns.length, 1);
  assert.ok(Math.abs(turns[0].t - 2) < 1e-9 && Math.abs(turns[0].duration - 2) < 1e-9);
});
test('tracking loss, low light, movement burst and ongoing spans', () => {
  const ev = run(new C.EventExtractor(), 10, 10, (t) => ({ face: !(t >= 2 && t < 3), brightness: t >= 5 && t < 7 ? 20 : 120, energy: t >= 8 ? 1.5 : 0.1 }));
  const types = ev.map((e) => e.type);
  assert.ok(types.includes('tracking_lost') && types.includes('low_light') && types.includes('movement_burst'));
  assert.ok(ev.find((e) => e.type === 'movement_burst').detail.includes('ongoing'));
  const lost = run(new C.EventExtractor(), 10, 4, (t) => ({ face: !(t >= 1 && t < 1.2) }));
  assert.strictEqual(lost.filter((e) => e.type === 'tracking_lost').length, 0);
});
test('no blink is counted while the face is not tracked', () => {
  const ev = run(new C.EventExtractor(), 10, 4, (t) => ({ face: t < 1 || t >= 2, blink: t >= 1 && t < 2 ? 0.9 : 0.05 }));
  assert.strictEqual(ev.filter((e) => e.type === 'blink' || e.type === 'eyes_closed_long').length, 0);
});

const lm = (dx = 0) => Array.from({ length: 478 }, (_, i) => ({ x: (i % 20) / 20 + dx, y: Math.floor(i / 20) / 30, z: 0 }))
  .map((p, i) => (i === 33 ? { x: 0.4 + dx, y: 0.5, z: 0 } : i === 263 ? { x: 0.6 + dx, y: 0.5, z: 0 } : p));
test('landmarkEnergy is zero when still and scales with motion', () => {
  assert.strictEqual(C.landmarkEnergy(lm(), lm(), 0.1, 1), 0);
  assert.ok(Math.abs(C.landmarkEnergy(lm(), lm(0.02), 0.1, 1) - 1.0) < 1e-6);
  assert.strictEqual(C.landmarkEnergy(lm(), lm(0.02), 0, 1), null);
});
test('grayStats separates flat from detailed images', () => {
  const w = 16, h = 16;
  const flat = new Uint8Array(w * h).fill(100);
  const checker = Uint8Array.from({ length: w * h }, (_, i) => ((i % w + Math.floor(i / w)) % 2 ? 220 : 20));
  assert.strictEqual(C.grayStats(flat, w, h).sharpness, 0);
  assert.ok(C.grayStats(checker, w, h).sharpness > 1000);
  assert.ok(Math.abs(C.grayStats(flat, w, h).brightness - 100) < 1e-9);
});
test('faceFeatures maps blendshapes', () => {
  const f = C.faceFeatures({ eyeBlinkLeft: 0.8, eyeBlinkRight: 0.6, jawOpen: 0.3, eyeLookOutLeft: 0.4, eyeLookInRight: 0.4 });
  assert.ok(Math.abs(f.blink - 0.7) < 1e-9 && f.mouth_open === 0.3 && Math.abs(f.gaze_x - 0.4) < 1e-9);
});
