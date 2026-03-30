// ── yin.js ────────────────────────────────────────────────────────────────────
// Pitch detection: HPS + YIN hybrid, octave correction, two filter strategies.
// Depends on: audio.js (actx, analyser1024, analyser512)
//             theory.js (hz2midi, CLEF_DEFS)
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

// ── Noise gate ────────────────────────────────────────────────────────────────
// Low threshold (0.004) because the bandpass filter in audio.js has already
// removed most non-vocal energy before this point.
const NOISE_GATE = 0.004;

// ── Working buffers ───────────────────────────────────────────────────────────
const timeBuf1024 = new Float32Array(4096);  // time domain — YIN
const freqBuf     = new Float32Array(2048);  // frequency domain — HPS (magnitude)
const yinWork     = new Float32Array(512);   // YIN scratch buffer

// ── DETECTION RANGE ───────────────────────────────────────────────────────────
// Per clef, constrain pitch search to the expected voice range.
// This prevents YIN and HPS from locking onto harmonics outside the
// singer's register. curClef is set by state.js.
function getDetectionRange() {
  const def = CLEF_DEFS[curClef];
  return def ? def.detectionRange : { minHz: 80, maxHz: 1100 };
}

// ── YIN ALGORITHM ─────────────────────────────────────────────────────────────
// Time-domain autocorrelation method (de Cheveigné & Kawahara 2002).
// Returns fundamental frequency in Hz, or null if no confident pitch found.
//
// Strength: sub-Hz precision via parabolic interpolation.
// Weakness: can lock onto 2f₀ or 3f₀ when the fundamental is weak
//           (missing fundamental problem — common in certain vowels/registers).

function yinDetect(buf, sr, N, yinBuf, minHz, maxHz) {
  const H = N >> 1;

  // RMS gate
  let rms = 0;
  for (let i = 0; i < N; i++) rms += buf[i] * buf[i];
  if (Math.sqrt(rms / N) < NOISE_GATE) return null;

  // Difference function
  for (let t = 0; t < H; t++) {
    let s = 0;
    for (let i = 0; i < H; i++) { const d = buf[i] - buf[i+t]; s += d*d; }
    yinBuf[t] = s;
  }

  // Cumulative mean normalised difference
  yinBuf[0] = 1;
  let run = 0;
  for (let t = 1; t < H; t++) { run += yinBuf[t]; yinBuf[t] = yinBuf[t]*t/run; }

  // Find first dip below threshold
  const THR = 0.09;
  let t = Math.max(2, Math.floor(sr / maxHz));
  const tMax = Math.min(H - 1, Math.floor(sr / minHz));
  for (; t < tMax; t++) {
    if (yinBuf[t] < THR) {
      while (t+1 < tMax && yinBuf[t+1] < yinBuf[t]) t++;
      break;
    }
  }
  if (t >= tMax || yinBuf[t] >= THR) return null;

  // Parabolic interpolation for sub-sample precision
  const x0 = t > 0 ? t-1 : t, x2 = t+1 < H ? t+1 : t;
  let best;
  if (x0 === t)      best = yinBuf[t] <= yinBuf[x2] ? t : x2;
  else if (x2 === t) best = yinBuf[t] <= yinBuf[x0] ? t : x0;
  else {
    const a=yinBuf[x0], b=yinBuf[t], c=yinBuf[x2];
    best = t + (c-a)/(2*(2*b-c-a));
  }

  const hz = sr / best;
  return (hz >= minHz && hz <= maxHz) ? hz : null;
}

// ── HARMONIC PRODUCT SPECTRUM (HPS) ──────────────────────────────────────────
// Frequency-domain method for fundamental detection.
//
// Why HPS solves the missing fundamental problem:
//   For a voice singing f₀, the spectrum contains peaks at f₀, 2f₀, 3f₀...
//   HPS downsamples the spectrum by factors of 1, 2, 3 and multiplies them.
//   At frequency f₀ all three downsampled spectra are large simultaneously
//   (f₀ maps to f₀, 2f₀ maps to f₀, 3f₀ maps to f₀).
//   At 2f₀ only one of the three is large — the product is small.
//   The peak of HPS(f) is therefore the true fundamental, even when 2f₀
//   has higher amplitude than f₀ in the raw spectrum.
//
// The three lowest harmonics (f₀, 2f₀, 3f₀) are what the user described:
// "fundamental, octave, octave's perfect fifth" — these are harmonics 1,2,3.

function hpsDetect(sr, minHz, maxHz) {
  if (!analyser1024) return null;
  analyser1024.getFloatFrequencyData(freqBuf);

  const binCount  = freqBuf.length;         // fftSize/2
  const binWidth  = sr / (binCount * 2);    // Hz per bin

  // Convert dB magnitudes to linear (clamp negatives to tiny positive)
  // We work in linear magnitude for the product spectrum.
  const linBuf = new Float32Array(binCount);
  for (let i = 0; i < binCount; i++) {
    linBuf[i] = Math.pow(10, freqBuf[i] / 20);
    if (linBuf[i] < 1e-10) linBuf[i] = 1e-10;
  }

  // Search range in bins
  const minBin = Math.max(1, Math.floor(minHz / binWidth));
  const maxBin = Math.min(Math.floor(maxHz / binWidth), Math.floor(binCount / 3) - 1);
  // We need maxBin * 3 < binCount for the third harmonic to exist

  let bestBin = -1, bestVal = 0;

  for (let b = minBin; b <= maxBin; b++) {
    // HPS: product of spectrum at b, 2b, 3b
    const val = linBuf[b] * linBuf[b*2] * linBuf[b*3];
    if (val > bestVal) { bestVal = val; bestBin = b; }
  }

  if (bestBin < 0) return null;

  // Sub-bin interpolation (parabolic) for accuracy
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

// ── FUNDAMENTAL RECONCILIATION ────────────────────────────────────────────────
// Runs both YIN and HPS, reconciles their outputs.
// Agreement: take average (both confident).
// Disagreement by octave/fifth ratio: take the lower (true fundamental).
// Irreconcilable disagreement: trust HPS (it's more robust to missing f₀).
// Both null: return null.

function detectFundamental() {
  if (!analyser1024) return null;
  const sr = actx.sampleRate;
  const { minHz, maxHz } = getDetectionRange();

  analyser1024.getFloatTimeDomainData(timeBuf1024);
  const hzYin = yinDetect(timeBuf1024, sr, 1024, yinWork, minHz, maxHz);
  const hzHps = hpsDetect(sr, minHz, maxHz);

  if (hzYin === null && hzHps === null) return null;
  if (hzYin === null) return hzHps;
  if (hzHps === null) return hzYin;

  // Both found — compare
  const midiYin = hz2midi(hzYin);
  const midiHps = hz2midi(hzHps);
  const diff    = Math.abs(midiYin - midiHps);

  if (diff < 1.5) {
    // Agreement within 1.5 semitones — average them
    return (hzYin + hzHps) / 2;
  }

  // Check for octave/fifth relationship
  // If one is approximately double or triple the other, the lower is f₀
  const ratio = Math.max(hzYin, hzHps) / Math.min(hzYin, hzHps);
  if (Math.abs(ratio - 2) < 0.15 || Math.abs(ratio - 3) < 0.2) {
    return Math.min(hzYin, hzHps);  // lower = true fundamental
  }

  // Irreconcilable — trust HPS (better fundamental recovery)
  return hzHps;
}

// ── SILENCE SENTINEL ──────────────────────────────────────────────────────────
const GAP = { gap: true };

// ── STRATEGIES ────────────────────────────────────────────────────────────────
// Only two strategies remain. Both are blue — the user picks one via the toggle.
// The ACTIVE strategy is determined by activeStrategy ('responsive'|'smooth').
//
// RESPONSIVE (was A): OctCorr + EMA α=0.72
//   α raised from 0.55 → 0.72 for smoother output while staying responsive.
//   At 60fps: α=0.72 gives time constant ≈ 60ms vs 30ms at α=0.55.
//   Still fast enough to track vibrato (5Hz cycle = 200ms period).
//   OctCorr remains as a second safety net after HPS reconciliation.
//
// SMOOTH (was G): EMA α=0.08
//   Ultra-heavy smoothing. Time constant ≈ 200ms.
//   Best for sustained notes. Lags on fast pitch changes.
//   No OctCorr needed — HPS already handles octave disambiguation.
//
// All previous strategies (B,C,D,E,F) are kept below as comments for reference.

const STRATEGIES = {

  responsive: {
    id: 'responsive', name: 'Responsive', color: '#1d6fa4',
    ema: null, recent: [], hold: 0, wasNull: true, buf: [],
    reset() { this.ema=null; this.recent=[]; this.hold=0; this.wasNull=true; this.buf=[]; },
    process(hz) {
      if (hz === null) {
        if (this.hold > 0) { this.hold--; return this.ema; }
        return null;
      }
      this.hold = 5;
      const raw = hz2midi(hz);
      // Secondary octave correction — safety net after HPS reconciliation
      const cor = _octaveCorrect(raw, this.recent);
      if (cor === null) return this.ema;
      this.recent.push(cor);
      if (this.recent.length > 8) this.recent.shift();
      // α=0.72: smoother than original 0.55, still responsive to pitch changes
      this.ema = (this.ema === null) ? cor : 0.72*cor + 0.28*this.ema;
      return this.ema;
    },
  },

  smooth: {
    id: 'smooth', name: 'Smooth', color: '#1d6fa4',
    ema: null, hold: 0, wasNull: true, buf: [],
    reset() { this.ema=null; this.hold=0; this.wasNull=true; this.buf=[]; },
    process(hz) {
      if (hz === null) {
        if (this.hold > 0) { this.hold--; return this.ema; }
        return null;
      }
      this.hold = 5;
      const raw = hz2midi(hz);
      // α=0.08: ultra-smooth, ~200ms time constant at 60fps
      this.ema = (this.ema === null) ? raw : 0.08*raw + 0.92*this.ema;
      return this.ema;
    },
  },

};

// ── Octave correction (internal helper) ───────────────────────────────────────
// Secondary safety net — compares against recent median and corrects octave
// flips that slip through HPS reconciliation.
function _octaveCorrect(rawMidi, recentArr) {
  if (recentArr.length < 4) return rawMidi;
  const sorted = [...recentArr].sort((a,b) => a-b);
  const med    = sorted[Math.floor(sorted.length/2)];
  const diff   = rawMidi - med;
  if (Math.abs(diff) > 9) {
    const octD = Math.round(diff/12) * 12;
    if (Math.abs(diff - octD) < 1.5) return rawMidi - octD;
    return null;
  }
  return rawMidi;
}

// ── processPitchFrame ─────────────────────────────────────────────────────────
// Called once per RAF frame during SINGING state.
// Uses the hybrid detector and feeds the active strategy.
// currentGlobalPi: beat index for X coordinate mapping.

function processPitchFrame(currentGlobalPi) {
  if (!analyser1024) return;

  const hz = detectFundamental();
  const s  = STRATEGIES[activeStrategy];  // activeStrategy from state.js
  const sm = s.process(hz);

  if (sm !== null) {
    if (s.wasNull) s.wasNull = false;
    s.buf.push({ t: actx.currentTime, midi: sm, gpi: currentGlobalPi });
    if (s.buf.length > 1200) s.buf.shift();
  } else {
    if (!s.wasNull) {
      s.buf.push(GAP);
      s.wasNull = true;
    }
  }
}

// ── resetActiveStrategy ───────────────────────────────────────────────────────
function resetActiveStrategy() {
  const s = STRATEGIES[activeStrategy];
  s.reset();
}

// ── onLoopBoundary / onSessionStart ──────────────────────────────────────────
// Called by state.js at session start and (if ever looping) at loop boundaries.
function onSessionStart() {
  STRATEGIES.responsive.reset();
  STRATEGIES.smooth.reset();
}

// ────────────────────────────────────────────────────────────────────────────
// ARCHIVED STRATEGIES — kept for reference, not used in the main app.
// Re-enable by adding to STRATEGIES object and wiring up in state.js.
// ────────────────────────────────────────────────────────────────────────────

/*
// B: Fast 512-sample buffer + EMA 0.55
const SB_archived = {
  id:'B', name:'B — Fast 512+EMA 0.55', color:'#16a34a',
  ema:null, recent:[], hold:0, wasNull:true, buf:[],
  reset() { this.ema=null; this.recent=[]; this.hold=0; this.wasNull=true; this.buf=[]; },
  process(hz) {
    if (hz===null) { if(this.hold>0){this.hold--;return this.ema;} return null; }
    this.hold=5; const raw=hz2midi(hz); const cor=_octaveCorrect(raw,this.recent);
    if (cor===null) return this.ema;
    this.recent.push(cor); if(this.recent.length>8) this.recent.shift();
    this.ema = this.ema===null ? cor : 0.55*cor + 0.45*this.ema; return this.ema;
  },
};

// C: Median-9 window, no EMA
const SC_archived = {
  id:'C', name:'C — Median-9', color:'#ea580c',
  window:[], hold:0, last:null, wasNull:true, buf:[],
  reset() { this.window=[]; this.hold=0; this.last=null; this.wasNull=true; this.buf=[]; },
  process(hz) {
    if (hz===null) { if(this.hold>0){this.hold--;return this.last;} return null; }
    this.hold=5; const raw=hz2midi(hz);
    if (this.last!==null && Math.abs(raw-this.last)>9) {
      const octD=Math.round((raw-this.last)/12)*12;
      if (Math.abs((raw-this.last)-octD)<1.5) this.window.push(raw-octD);
    } else this.window.push(raw);
    if(this.window.length>9) this.window.shift();
    const s=[...this.window].sort((a,b)=>a-b);
    this.last=s[Math.floor(s.length/2)]; return this.last;
  },
};

// D: Double EMA (0.75 → 0.85)
const SD_archived = {
  id:'D', name:'D — Double EMA', color:'#7c3aed',
  ema1:null, ema2:null, recent:[], hold:0, wasNull:true, buf:[],
  reset() { this.ema1=null; this.ema2=null; this.recent=[]; this.hold=0; this.wasNull=true; this.buf=[]; },
  process(hz) {
    if (hz===null) { if(this.hold>0){this.hold--;return this.ema2;} return null; }
    this.hold=5; const raw=hz2midi(hz); const cor=_octaveCorrect(raw,this.recent);
    if (cor===null) return this.ema2;
    this.recent.push(cor); if(this.recent.length>8) this.recent.shift();
    this.ema1 = this.ema1===null ? cor : 0.75*cor + 0.25*this.ema1;
    this.ema2 = this.ema2===null ? this.ema1 : 0.85*this.ema1 + 0.15*this.ema2; return this.ema2;
  },
};

// E: AI friend — EMA 0.2 + Bézier midpoint rendering
const SE_archived = {
  id:'E', name:'E — AI: EMA 0.2+Bézier', color:'#ca8a04',
  ema:null, hold:0, wasNull:true, buf:[],
  reset() { this.ema=null; this.hold=0; this.wasNull=true; this.buf=[]; },
  process(hz) {
    if (hz===null) { if(this.hold>0){this.hold--;return this.ema;} return null; }
    this.hold=5; const raw=hz2midi(hz);
    this.ema = this.ema===null ? raw : 0.2*raw + 0.8*this.ema; return this.ema;
  },
};

// F: Schmitt Trigger (dead-band filter)
const SF_archived = {
  id:'F', name:'F — Schmitt Trigger', color:'#be185d',
  ema:null, hold:0, wasNull:true, buf:[],
  reset() { this.ema=null; this.hold=0; this.wasNull=true; this.buf=[]; },
  process(hz) {
    if (hz===null) { if(this.hold>0){this.hold--;return this.ema;} return null; }
    this.hold=5; const raw=hz2midi(hz);
    if (this.ema===null) this.ema=raw;
    else { const d=raw-this.ema; if(Math.abs(d)>0.4) this.ema += d*0.20; }
    return this.ema;
  },
};

// Original YIN-only detector (before HPS hybrid)
function yinCore_archived(buf, sr, N, yinBuf) {
  const H = N >> 1;
  let rms = 0;
  for (let i = 0; i < N; i++) rms += buf[i]*buf[i];
  if (Math.sqrt(rms/N) < NOISE_GATE) return null;
  for (let t = 0; t < H; t++) {
    let s = 0; for (let i = 0; i < H; i++) { const d=buf[i]-buf[i+t]; s+=d*d; } yinBuf[t]=s;
  }
  yinBuf[0]=1; let run=0;
  for (let t=1;t<H;t++){run+=yinBuf[t];yinBuf[t]=yinBuf[t]*t/run;}
  const THR=0.09; let t=2;
  for(;t<H;t++){if(yinBuf[t]<THR){while(t+1<H&&yinBuf[t+1]<yinBuf[t])t++;break;}}
  if(t>=H||yinBuf[t]>=THR) return null;
  const x0=t>0?t-1:t,x2=t+1<H?t+1:t; let best;
  if(x0===t) best=yinBuf[t]<=yinBuf[x2]?t:x2;
  else if(x2===t) best=yinBuf[t]<=yinBuf[x0]?t:x0;
  else{const a=yinBuf[x0],b=yinBuf[t],c=yinBuf[x2];best=t+(c-a)/(2*(2*b-c-a));}
  const hz=sr/best; return(hz>80&&hz<1200)?hz:null;
}
*/
