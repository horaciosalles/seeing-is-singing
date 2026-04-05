// ── yin.js ────────────────────────────────────────────────────────────────────
// @version 0.2
// Pitch detection: HPS + YIN hybrid detector, single smooth filter strategy.
// Depends on: audio.js (actx, analyser1024)
//             theory.js (hz2midi, CLEF_DEFS, curClef)
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const NOISE_GATE = 0.012;
const CLARITY_GATE = 0.055;

// Working buffers
const timeBuf = new Float32Array(4096);
const freqBuf = new Float32Array(2048);
const yinWork = new Float32Array(512);

// ── Detection range (clef-aware) ──────────────────────────────────────────────
// Constrains pitch search to the singer's actual sounding voice range.
// curClef is set by state.js.
function getDetectionRange() {
  const def = CLEF_DEFS[curClef];
  return def ? def.detectionRange : { minHz: 80, maxHz: 1100 };
}

// ── YIN — time domain ─────────────────────────────────────────────────────────
// Finds the fundamental period via autocorrelation (de Cheveigné & Kawahara 2002).
// Precise but vulnerable to the missing fundamental problem.
function yinDetect(buf, sr, N, yinBuf, minHz, maxHz) {
  const H = N >> 1;
  let rms = 0;
  for (let i = 0; i < N; i++) rms += buf[i] * buf[i];
  if (Math.sqrt(rms / N) < NOISE_GATE) return null;

  for (let t = 0; t < H; t++) {
    let s = 0;
    for (let i = 0; i < H; i++) { const d = buf[i] - buf[i+t]; s += d*d; }
    yinBuf[t] = s;
  }
  yinBuf[0] = 1; let run = 0;
  for (let t = 1; t < H; t++) { run += yinBuf[t]; yinBuf[t] = yinBuf[t]*t/run; }

  const THR  = 0.09;
  let t      = Math.max(2, Math.floor(sr / maxHz));
  const tMax = Math.min(H - 1, Math.floor(sr / minHz));
  for (; t < tMax; t++) {
    if (yinBuf[t] < THR) { while (t+1 < tMax && yinBuf[t+1] < yinBuf[t]) t++; break; }
  }
  if (t >= tMax || yinBuf[t] >= THR) return null;

  const x0 = t > 0 ? t-1 : t, x2 = t+1 < H ? t+1 : t;
  let best;
  if (x0 === t)      best = yinBuf[t] <= yinBuf[x2] ? t : x2;
  else if (x2 === t) best = yinBuf[t] <= yinBuf[x0] ? t : x0;
  else { const a=yinBuf[x0],b=yinBuf[t],c=yinBuf[x2]; best = t+(c-a)/(2*(2*b-c-a)); }

  const hz = sr / best;
  const clarity = yinBuf[Math.floor(best)]; // CMNDF dip depth (0 = perfect, ~THR = weak)
  return (hz >= minHz && hz <= maxHz) ? { hz, clarity } : null;
}

// ── HPS — frequency domain ────────────────────────────────────────────────────
// Harmonic Product Spectrum: multiplies the spectrum at f, 2f, 3f.
// The fundamental is where all three harmonics coincide — solving the missing
// fundamental problem that causes YIN to return an octave too high.
function hpsDetect(sr, minHz, maxHz) {
  if (!analyser1024) return null;
  analyser1024.getFloatFrequencyData(freqBuf);

  const binCount = freqBuf.length;
  const binWidth = sr / (binCount * 2);

  const linBuf = new Float32Array(binCount);
  for (let i = 0; i < binCount; i++) {
    linBuf[i] = Math.pow(10, freqBuf[i] / 20);
    if (linBuf[i] < 1e-10) linBuf[i] = 1e-10;
  }

  const minBin = Math.max(1, Math.floor(minHz / binWidth));
  const maxBin = Math.min(Math.floor(maxHz / binWidth), Math.floor(binCount / 3) - 1);

  let bestBin = -1, bestVal = 0;
  for (let b = minBin; b <= maxBin; b++) {
    const val = linBuf[b] * linBuf[b*2] * linBuf[b*3];
    if (val > bestVal) { bestVal = val; bestBin = b; }
  }
  if (bestBin < 0) return null;

  const b = bestBin;
  let refined = b;
  if (b > 0 && b < binCount - 1) {
    const a = linBuf[b-1]*linBuf[(b-1)*2]*linBuf[(b-1)*3];
    const c = linBuf[b+1]*linBuf[(b+1)*2]*linBuf[(b+1)*3];
    refined  = b + (c - a) / (2 * (2*bestVal - c - a));
  }

  const hz = refined * binWidth;
  return (hz >= minHz && hz <= maxHz) ? hz : null;
}

// ── Reconciliation ────────────────────────────────────────────────────────────
// Runs both detectors and picks the true fundamental.
function detectFundamental() {
  if (!analyser1024) return null;
  const sr = actx.sampleRate;
  const { minHz, maxHz } = getDetectionRange();

  analyser1024.getFloatTimeDomainData(timeBuf);
  const yinRes = yinDetect(timeBuf, sr, 1024, yinWork, minHz, maxHz);
  const hzHps = hpsDetect(sr, minHz, maxHz);

  // Filter YIN by clarity (CMNDF confidence)
  const hzYin = (yinRes !== null && yinRes.clarity <= CLARITY_GATE) ? yinRes.hz : null;

  if (hzYin === null && hzHps === null) return null;
  if (hzYin === null) return hzHps;
  if (hzHps === null) return hzYin;

  const diff = Math.abs(hz2midi(hzYin) - hz2midi(hzHps));
  if (diff < 1.5) return (hzYin + hzHps) / 2;

  // Octave or fifth relationship — take the lower (true fundamental)
  const ratio = Math.max(hzYin, hzHps) / Math.min(hzYin, hzHps);
  if (Math.abs(ratio - 2) < 0.15 || Math.abs(ratio - 3) < 0.20) {
    return Math.min(hzYin, hzHps);
  }

  return hzHps; // irreconcilable — HPS is more robust
}

// ── Silence sentinel ──────────────────────────────────────────────────────────
const GAP = { gap: true };

// ── Smooth pitch strategy ─────────────────────────────────────────────────────
// Single strategy — EMA α=0.08, ~200ms time constant at 60fps.
// Silky on sustained notes, slightly lagged on fast changes.
// Octave correction as secondary safety net after HPS reconciliation.
// Onset debounce: require pitch to persist for MIN_ONSET_FRAMES before output.
const pitchState = {
  ema:            null,
  recent:         [],
  hold:           0,
  wasNull:        true,
  buf:            [],
  onsetFrames:    0,
  MIN_ONSET_FRAMES: 3,  // ~50ms at 60fps; suppress brief noise spikes

  reset() {
    this.ema = null; this.recent = []; this.hold = 0;
    this.wasNull = true; this.buf = []; this.onsetFrames = 0;
  },

  process(hz) {
    if (hz === null) {
      this.onsetFrames = 0; // reset onset counter on silence
      if (this.hold > 0) { this.hold--; return this.ema; }
      return null;
    }
    this.hold = 5;
    const raw = hz2midi(hz);

    // Octave correction
    let cor = raw;
    if (this.recent.length >= 4) {
      const sorted = [...this.recent].sort((a,b) => a-b);
      const med    = sorted[Math.floor(sorted.length/2)];
      const diff   = raw - med;
      if (Math.abs(diff) > 9) {
        const octD = Math.round(diff/12) * 12;
        cor = Math.abs(diff - octD) < 1.5 ? raw - octD : this.ema; // hold on spike
      }
    }
    if (cor === null || cor === undefined) return this.ema;

    this.recent.push(cor);
    if (this.recent.length > 8) this.recent.shift();

    this.ema = (this.ema === null) ? cor : 0.08 * cor + 0.92 * this.ema;

    // Onset debounce: only output after MIN_ONSET_FRAMES of sustained pitch
    this.onsetFrames++;
    if (this.onsetFrames < this.MIN_ONSET_FRAMES) return null;

    return this.ema;
  },
};

// ── processPitchFrame ─────────────────────────────────────────────────────────
// Called once per RAF frame during SINGING state.
// currentGlobalPi: the beat index for X coordinate mapping in draw.js.
function processPitchFrame(currentGlobalPi) {
  if (!analyser1024) return;

  const hz = detectFundamental();
  const sm = pitchState.process(hz);

  if (sm !== null) {
    pitchState.wasNull = false;
    pitchState.buf.push({ t: actx.currentTime, midi: sm, gpi: currentGlobalPi });
    if (pitchState.buf.length > 1200) pitchState.buf.shift();
  } else {
    if (!pitchState.wasNull) {
      pitchState.buf.push(GAP);
      pitchState.wasNull = true;
    }
  }
}

function resetPitch() {
  pitchState.reset();
}

// ── Readout helper ─────────────────────────────────────────────────────────────
// Returns { noteName, cents } from the latest pitch buffer entry, or null.
function getLatestPitch() {
  for (let j = pitchState.buf.length - 1; j >= 0; j--) {
    const p = pitchState.buf[j];
    if (!p.gap) {
      const nearest = Math.round(p.midi);
      const cents   = (p.midi - nearest) * 100;
      return { noteName: NOTE_NAMES[mpc(nearest)], cents };
    }
  }
  return null;
}
