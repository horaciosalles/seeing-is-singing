import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTracker, createLock, octaveOff } from '../js/tracker.js';
import { midi2hz } from '../js/theory.js';

const DT = 512 / 48000; // one hop
const voiced = (midi) => ({ hz: midi2hz(midi), clarity: 0.95, rms: 0.05 });
const unvoiced = { hz: null, clarity: 0, rms: 0.001 };

function rng(seed) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

test('onset debounce: no output for the first frames', () => {
  const tr = createTracker();
  assert.equal(tr.push(voiced(60), 0), null);
  assert.equal(tr.push(voiced(60), DT), null);
  assert.ok(Math.abs(tr.push(voiced(60), 2 * DT) - 60) < 1e-6);
});

test('held note with ±10¢ jitter is smoothed to under 3¢ spread', () => {
  const tr = createTracker(), r = rng(3);
  const outs = [];
  for (let i = 0; i < 200; i++) {
    const o = tr.push(voiced(67 + (r() - 0.5) * 0.2), i * DT);
    if (i > 50) outs.push(o);
  }
  const mean = outs.reduce((a, b) => a + b) / outs.length;
  const sd = Math.sqrt(outs.reduce((a, b) => a + (b - mean) ** 2, 0) / outs.length) * 100;
  assert.ok(sd < 3, `sd ${sd.toFixed(2)}¢`);
});

test('a leap of a fifth settles within 30¢ in under 120 ms', () => {
  const tr = createTracker();
  let t = 0;
  for (let i = 0; i < 60; i++, t += DT) tr.push(voiced(60), t);
  const t0 = t;
  let settled = null;
  for (let i = 0; i < 60; i++, t += DT) {
    if (Math.abs(tr.push(voiced(67), t) - 67) < 0.3) { settled = t - t0; break; }
  }
  assert.ok(settled !== null && settled < 0.12, `settled after ${settled}`);
});

test('a single-frame octave spike barely moves the output', () => {
  const tr = createTracker();
  let t = 0, o;
  for (let i = 0; i < 60; i++, t += DT) tr.push(voiced(57), t);
  tr.push(voiced(69), t); t += DT;
  for (let i = 0; i < 3; i++, t += DT) o = tr.push(voiced(57), t);
  assert.ok(Math.abs(o - 57) < 0.2, `output ${o}`);
});

test('octave interval: singing root then octave is tracked, not "corrected"', () => {
  const tr = createTracker();
  let t = 0, o;
  for (let i = 0; i < 80; i++, t += DT) tr.push(voiced(60), t);
  for (let i = 0; i < 40; i++, t += DT) o = tr.push(voiced(72), t);
  assert.ok(Math.abs(o - 72) < 0.1, `output ${o}`);
});

test('short dropouts hold; sustained silence returns null', () => {
  const tr = createTracker();
  let t = 0;
  for (let i = 0; i < 20; i++, t += DT) tr.push(voiced(64), t);
  assert.ok(tr.push(unvoiced, t) !== null); t += DT;
  for (let i = 0; i < 10; i++, t += DT) tr.push(unvoiced, t);
  assert.equal(tr.push(unvoiced, t), null);
});

test('after silence the pitch restarts at the new note (no glide)', () => {
  const tr = createTracker();
  let t = 0, o;
  for (let i = 0; i < 40; i++, t += DT) tr.push(voiced(60), t);
  for (let i = 0; i < 20; i++, t += DT) tr.push(unvoiced, t);
  for (let i = 0; i < 3; i++, t += DT) o = tr.push(voiced(65), t);
  assert.ok(Math.abs(o - 65) < 1e-6, `output ${o}`);
});

test('lock: hold → locked; hysteresis between 30¢ and 50¢; silence releases', () => {
  const lk = createLock();
  assert.equal(lk.update(67.1, 67, 0).state, 'near');
  assert.equal(lk.update(67.1, 67, 0.1).state, 'near');
  assert.equal(lk.update(67.1, 67, 0.26).state, 'locked');
  assert.equal(lk.update(67.4, 67, 0.3).state, 'locked');
  assert.equal(lk.update(67.6, 67, 0.4).state, 'idle');
  lk.update(67, 67, 0.5); lk.update(67, 67, 0.8);
  assert.equal(lk.update(null, 67, 0.9).state, 'idle');
});

test('lock: leaving the zone during the hold restarts it', () => {
  const lk = createLock();
  lk.update(67, 67, 0);
  lk.update(67.5, 67, 0.2);
  assert.equal(lk.update(67, 67, 0.3).state, 'near');
  assert.equal(lk.update(67, 67, 0.56).state, 'locked');
});

test('octaveOff', () => {
  assert.equal(octaveOff(79, 67), 1);
  assert.equal(octaveOff(54.8, 67), -1);
  assert.equal(octaveOff(67.2, 67), 0);
  assert.equal(octaveOff(74, 67), 0);
});
