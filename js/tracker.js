// ── tracker.js ────────────────────────────────────────────────────────────────
// Turns raw per-frame detections into one stable pitch stream, and decides
// when the singer is locked onto the target.
//
//   detection → voicing gate → median(5) → One-Euro filter → midi | null
//
// All timing is in seconds of audio time, so behaviour does not depend on the
// display refresh rate. This is the ONLY smoothing stage — the clock hand
// draws the output directly.
//
// Pure — no audio, no DOM. Tested in test/tracker.test.mjs.
// ─────────────────────────────────────────────────────────────────────────────

import { hz2midi } from './theory.js';

const MEDIAN_N = 5;

// One-Euro filter (Casiez et al. 2012): light smoothing while the pitch moves
// fast (leaps stay responsive), heavy smoothing while it holds still.
function oneEuro({ minCutoff, beta, dCutoff }) {
  const alpha = (cutoff, dt) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
  let x = null, dx = 0, tPrev = 0;
  return {
    reset() { x = null; dx = 0; },
    step(v, t) {
      if (x === null) { x = v; dx = 0; tPrev = t; return x; }
      const dt = Math.max(t - tPrev, 1e-4);
      tPrev = t;
      dx += alpha(dCutoff, dt) * ((v - x) / dt - dx);
      x  += alpha(minCutoff + beta * Math.abs(dx), dt) * (v - x);
      return x;
    },
  };
}

export function createTracker({
  minClarity  = 0.75,  // NSDF peak height required to count as voiced
  minRms      = 0.003, // absolute floor; clarity does most of the gating
  onsetFrames = 3,     // consecutive voiced frames before the first output
  releaseSec  = 0.09,  // unvoiced time before declaring silence
  minCutoff   = 1.5,   // Hz — smoothing on a held note
  beta        = 0.07,  // cutoff gain per semitone/second of movement
  dCutoff     = 1.0,
} = {}) {
  const filt = oneEuro({ minCutoff, beta, dCutoff });
  let recent = [], run = 0, lastVoicedT = -Infinity, out = null;

  function silence() {
    filt.reset(); recent = []; run = 0; out = null;
  }

  return {
    reset() { silence(); lastVoicedT = -Infinity; },

    // det: { hz, clarity, rms }, t: seconds. Returns smoothed midi or null.
    push(det, t) {
      const voiced = det.hz !== null && det.clarity >= minClarity && det.rms >= minRms;
      if (!voiced) {
        if (t - lastVoicedT > releaseSec) silence();
        return out;
      }
      lastVoicedT = t;
      run++;
      recent.push(hz2midi(det.hz));
      if (recent.length > MEDIAN_N) recent.shift();
      if (run < onsetFrames && out === null) return out;

      const sorted = [...recent].sort((a, b) => a - b);
      out = filt.step(sorted[sorted.length >> 1], t);
      return out;
    },
  };
}

// Lock state machine with hysteresis.
//   idle   — not close to the target
//   near   — within enterCents, waiting holdSec (progress 0 → 1)
//   locked — held long enough; released only beyond exitCents or on silence
export function createLock({ enterCents = 30, exitCents = 50, holdSec = 0.25 } = {}) {
  let state = 'idle', since = 0;
  return {
    reset() { state = 'idle'; },
    update(midi, target, t) {
      if (midi === null) { state = 'idle'; return { state, progress: 0 }; }
      const dev = Math.abs(midi - target) * 100;
      if (state === 'locked') {
        if (dev > exitCents) state = 'idle';
        else return { state, progress: 1 };
      }
      if (dev > enterCents) { state = 'idle'; return { state, progress: 0 }; }
      if (state === 'idle') { state = 'near'; since = t; }
      const progress = Math.min(1, (t - since) / holdSec);
      if (progress >= 1) state = 'locked';
      return { state, progress };
    },
  };
}

// Same pitch class as the target but in another octave → ±1, ±2 …; else 0.
export function octaveOff(midi, target) {
  const d = midi - target;
  const oct = Math.round(d / 12);
  return oct !== 0 && Math.abs(d - oct * 12) <= 0.5 ? oct : 0;
}
