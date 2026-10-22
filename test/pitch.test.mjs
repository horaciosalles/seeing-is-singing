import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPitch } from '../js/pitch.js';

const SR = 48000;
const N  = 2048;

// Seeded RNG so failures are reproducible.
function rng(seed) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

// Harmonic tone: amps[k] is the amplitude of harmonic k+1.
function tone(f, amps, { noise = 0, seed = 1 } = {}) {
  const r = rng(seed);
  const phases = amps.map(() => r() * 2 * Math.PI);
  const x = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let s = 0;
    for (let k = 0; k < amps.length; k++) {
      const fk = f * (k + 1);
      if (fk < SR / 2) s += amps[k] * Math.sin(2 * Math.PI * fk * i / SR + phases[k]);
    }
    x[i] = 0.2 * s + noise * (r() * 2 - 1);
  }
  return x;
}

const cents = (hz, ref) => 1200 * Math.log2(hz / ref);
const WIDE = [60, 1400];

function expectPitch(x, f, [lo, hi] = WIDE, tol = 5) {
  const { hz } = detectPitch(x, SR, lo, hi);
  assert.ok(hz !== null, `no pitch for ${f} Hz`);
  const c = cents(hz, f);
  assert.ok(Math.abs(c) < tol, `${f} Hz → ${hz.toFixed(2)} Hz (${c.toFixed(1)}¢)`);
}

test('pure sines are accurate within 3 cents', () => {
  for (const f of [82, 110, 196, 261.6, 440, 659, 880, 1046]) expectPitch(tone(f, [1]), f, WIDE, 3);
});

test('sawtooth (all harmonics) has no octave errors', () => {
  const saw = Array.from({ length: 30 }, (_, k) => 1 / (k + 1));
  for (const f of [87, 123, 174, 247, 349, 494, 698]) expectPitch(tone(f, saw), f);
});

test('dominant 2nd harmonic still resolves to the fundamental', () => {
  for (const f of [110, 165, 220, 330]) expectPitch(tone(f, [0.25, 1, 0.45, 0.2, 0.1]), f);
});

test('missing fundamental resolves to the fundamental', () => {
  for (const f of [130, 150, 196]) expectPitch(tone(f, [0, 1, 0.8, 0.6, 0.4, 0.3]), f);
});

test('"ee"-like formant spectrum (F1 270 Hz, F2 2300 Hz)', () => {
  const formant = (hz) => Math.exp(-(((hz - 270) / 120) ** 2)) + 0.6 * Math.exp(-(((hz - 2300) / 300) ** 2)) + 0.05;
  for (const f of [110, 130, 175, 220]) {
    const amps = Array.from({ length: 25 }, (_, k) => formant(f * (k + 1)));
    expectPitch(tone(f, amps), f);
  }
});

test('moderate noise does not break detection', () => {
  const saw = Array.from({ length: 12 }, (_, k) => 1 / (k + 1));
  for (const f of [147, 294, 587]) expectPitch(tone(f, saw, { noise: 0.04, seed: f }), f, WIDE, 8);
});

test('white noise has low clarity', () => {
  const x = tone(1, [0], { noise: 0.3, seed: 7 });
  const { hz, clarity } = detectPitch(x, SR, ...WIDE);
  assert.ok(hz === null || clarity < 0.75, `noise clarity ${clarity.toFixed(2)}`);
});

test('random harmonic spectra: octave-error rate under 1%', () => {
  const r = rng(42);
  let errors = 0;
  const trials = 400;
  for (let n = 0; n < trials; n++) {
    const f = 80 * Math.pow(2, r() * 3.3);            // 80 – ~790 Hz
    const amps = Array.from({ length: 10 }, () => r());
    amps[0] = 0.15 + 0.85 * amps[0];                  // fundamental present but may be weak
    // Expected-note window, as the app uses: target ± 7 semitones.
    const lo = f * 2 ** (-7 / 12), hi = f * 2 ** (7 / 12);
    const { hz } = detectPitch(tone(f, amps, { seed: n + 1 }), SR, lo, hi);
    if (hz === null || Math.abs(cents(hz, f)) > 50) errors++;
  }
  assert.ok(errors / trials < 0.01, `${errors}/${trials} wrong`);
});
