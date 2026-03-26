// ── yin.js ────────────────────────────────────────────────────────────────────
// Pitch detection (YIN algorithm) + octave correction + all filter strategies.
// Depends on: audio.js (for analyser nodes, actx)
//             theory.js (for hz2midi)
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

// ── Noise gate ────────────────────────────────────────────────────────────────
// Set low (0.004) because the bandpass filter in audio.js has already removed
// most non-vocal energy. A higher gate here (e.g. 0.016) would be too
// aggressive and cut off soft singing.
//
// Alternative values tried:
//   0.016 — original value, too aggressive, cuts soft passages
//   0.008 — Gemini's value, still somewhat aggressive
//   0.004 — current: light gate, bandpass does the heavy lifting
const NOISE_GATE = 0.004;

// ── Working buffers ───────────────────────────────────────────────────────────
const buf1024 = new Float32Array(4096);
const buf512  = new Float32Array(4096);
const yin1024 = new Float32Array(512);
const yin512  = new Float32Array(256);

// ── YIN core ──────────────────────────────────────────────────────────────────
// Implements the YIN algorithm (de Cheveigné & Kawahara 2002).
// Returns fundamental frequency in Hz, or null if no confident pitch found.
//
// Parameters:
//   buf    — Float32Array of time-domain audio samples (from analyser node)
//   sr     — sample rate (Hz)
//   N      — number of samples to analyse (1024 or 512)
//   yinBuf — pre-allocated working buffer of length N/2
//
// Why YIN and not FFT peak-picking?
//   FFT gives frequency bins of width sr/fftSize. At sr=44100, fftSize=4096
//   gives ~10 Hz resolution — too coarse for pitch in the lower octaves where
//   semitones are ~12 Hz apart. YIN operates in the time domain and achieves
//   sub-Hz precision via parabolic interpolation.
//
// Why not use the pitchy library?
//   pitchy is a good choice for a build-step project. Here we stay dependency-
//   free so the file can be dropped into any static server.

function yinCore(buf, sr, N, yinBuf) {
  const H = N >> 1;   // half-length

  // 1. RMS gate — reject silence before running the expensive inner loop
  let rms = 0;
  for (let i = 0; i < N; i++) rms += buf[i] * buf[i];
  if (Math.sqrt(rms / N) < NOISE_GATE) return null;

  // 2. Difference function  d(τ) = Σ (x_t - x_{t+τ})²
  for (let t = 0; t < H; t++) {
    let s = 0;
    for (let i = 0; i < H; i++) { const d = buf[i] - buf[i + t]; s += d * d; }
    yinBuf[t] = s;
  }

  // 3. Cumulative mean normalised difference function
  yinBuf[0] = 1;
  let run = 0;
  for (let t = 1; t < H; t++) {
    run += yinBuf[t];
    yinBuf[t] = yinBuf[t] * t / run;
  }

  // 4. Find first dip below threshold
  const THR = 0.09;
  let t = 2;
  for (; t < H; t++) {
    if (yinBuf[t] < THR) {
      while (t + 1 < H && yinBuf[t + 1] < yinBuf[t]) t++;
      break;
    }
  }
  if (t >= H || yinBuf[t] >= THR) return null;

  // 5. Parabolic interpolation for sub-sample precision
  const x0 = t > 0 ? t - 1 : t;
  const x2 = t + 1 < H ? t + 1 : t;
  let best;
  if (x0 === t)       best = yinBuf[t] <= yinBuf[x2] ? t : x2;
  else if (x2 === t)  best = yinBuf[t] <= yinBuf[x0] ? t : x0;
  else {
    const a = yinBuf[x0], b = yinBuf[t], c = yinBuf[x2];
    best = t + (c - a) / (2 * (2 * b - c - a));
  }

  const hz = sr / best;
  // Constrain to human singing range: E2 (≈82 Hz) to D6 (≈1175 Hz)
  return (hz > 80 && hz < 1200) ? hz : null;
}

// ── Octave correction ─────────────────────────────────────────────────────────
// YIN occasionally produces readings one octave too high or too low,
// especially near register breaks and on vowel onset transients.
// We compare the new reading against a recent median and, if the deviation
// is larger than 9 semitones but close to an integer number of octaves (12
// semitones), we shift the reading by that number of octaves.
// If the deviation is large but NOT an octave relationship, it is a spike
// and we return null (discard).

function octaveCorrect(rawMidi, recentArr) {
  if (recentArr.length < 4) return rawMidi;   // not enough history yet
  const sorted = [...recentArr].sort((a, b) => a - b);
  const med    = sorted[Math.floor(sorted.length / 2)];
  const diff   = rawMidi - med;
  if (Math.abs(diff) > 9) {
    const octD = Math.round(diff / 12) * 12;
    if (Math.abs(diff - octD) < 1.5) return rawMidi - octD;  // octave flip
    return null;  // spike — discard
  }
  return rawMidi;
}

// ── Silence sentinel ──────────────────────────────────────────────────────────
// Pushed into pitch buffers when voice goes silent.
// The draw routines in draw.js detect { gap:true } and lift the pen,
// preventing interpolation across silence gaps.
const GAP = { gap: true };

// ── STRATEGIES ────────────────────────────────────────────────────────────────
// Each strategy object:
//   id       — single letter label
//   name     — display name
//   color    — hex colour for curve and legend
//   enabled  — toggled by checkbox in UI
//   drawFn   — 'catmull' | 'bezier' (rendering method in draw.js)
//   buf      — pitch ring buffer [{t, midi, gpi}] + GAP sentinels
//   wasNull  — true when last frame was silence (for sentinel injection logic)
//   reset()  — clears filter state and buffer; preserves enabled flag
//   process(hz) → float midi | null
//
// ── Currently active strategy ─────────────────────────────────────────────────
// Strategy A is the primary curve used in the main app.
// All others remain here for comparison in the pitch lab.

const STRATEGIES = [

  // ── A: OctCorr + EMA α=0.55 + Catmull-Rom ──────────────────────────────────
  // Our workhorse. Octave correction for register breaks, single EMA pass
  // at α=0.55 — responsive enough to follow vibrato (~5 Hz) while suppressing
  // frame-to-frame YIN jitter. Catmull-Rom spline for smooth rendering.
  //
  // α=0.55 means each new reading contributes 55%, prior EMA 45%.
  // At 60 fps the effective time constant ≈ 1/(α×60) ≈ 30 ms.
  {
    id:'A', name:'A — OctCorr+EMA 0.55', color:'#0891b2', enabled:true,
    ema:null, recent:[], hold:0, wasNull:true, buf:[],
    reset() { this.ema=null; this.recent=[]; this.hold=0; this.wasNull=true; this.buf=[]; },
    process(hz) {
      if (hz===null) { if(this.hold>0){this.hold--;return this.ema;} return null; }
      this.hold = 5;
      const raw = hz2midi(hz);
      const cor = octaveCorrect(raw, this.recent);
      if (cor===null) return this.ema;
      this.recent.push(cor); if(this.recent.length>8) this.recent.shift();
      this.ema = this.ema===null ? cor : 0.55*cor + 0.45*this.ema;
      return this.ema;
    },
    drawFn: 'catmull',
  },

  // ── B: Fast buf 512 + OctCorr + EMA α=0.55 + Catmull-Rom ───────────────────
  // Same filter as A but fed from the 512-sample analyser node.
  // 512 samples at 44100 Hz ≈ 11.6 ms per detection cycle vs 23 ms for 1024.
  // Hypothesis: faster input → more responsive to note onsets.
  // Trade-off: 512-sample YIN has coarser frequency resolution at the low end.
  {
    id:'B', name:'B — Fast 512+EMA 0.55', color:'#16a34a', enabled:true,
    ema:null, recent:[], hold:0, wasNull:true, buf:[],
    reset() { this.ema=null; this.recent=[]; this.hold=0; this.wasNull=true; this.buf=[]; },
    process(hz) {
      if (hz===null) { if(this.hold>0){this.hold--;return this.ema;} return null; }
      this.hold = 5;
      const raw = hz2midi(hz);
      const cor = octaveCorrect(raw, this.recent);
      if (cor===null) return this.ema;
      this.recent.push(cor); if(this.recent.length>8) this.recent.shift();
      this.ema = this.ema===null ? cor : 0.55*cor + 0.45*this.ema;
      return this.ema;
    },
    drawFn: 'catmull',
  },

  // ── C: Median-9 window (no EMA) ─────────────────────────────────────────────
  // Sliding median over last 9 raw YIN readings. Excellent spike rejection —
  // a single bad frame cannot move the output. No EMA on top.
  // May appear slightly stepped on fast pitch changes (needs window to shift).
  // Good for: noise-heavy environments, users with strong consonant transients.
  {
    id:'C', name:'C — Median-9 (no EMA)', color:'#ea580c', enabled:true,
    window:[], hold:0, last:null, wasNull:true, buf:[],
    reset() { this.window=[]; this.hold=0; this.last=null; this.wasNull=true; this.buf=[]; },
    process(hz) {
      if (hz===null) { if(this.hold>0){this.hold--;return this.last;} return null; }
      this.hold = 5;
      const raw = hz2midi(hz);
      if (this.last!==null && Math.abs(raw-this.last)>9) {
        const octD = Math.round((raw-this.last)/12)*12;
        if (Math.abs((raw-this.last)-octD)<1.5) this.window.push(raw-octD);
        // else discard spike entirely
      } else {
        this.window.push(raw);
      }
      if (this.window.length>9) this.window.shift();
      const s = [...this.window].sort((a,b)=>a-b);
      this.last = s[Math.floor(s.length/2)];
      return this.last;
    },
    drawFn: 'catmull',
  },

  // ── D: Double EMA (α=0.75 → α=0.85) ────────────────────────────────────────
  // Two-pole IIR low-pass filter implemented as cascaded EMAs.
  // Pass 1 (α=0.75): nearly raw, removes single-frame spikes.
  // Pass 2 (α=0.85): smooths residual jitter from pass 1.
  // Combined roll-off is steeper than a single EMA, which helps with
  // high-frequency noise while keeping transient response fast.
  //
  // Alternative cascade values tried (commented for reference):
  //   Pass 1 α=0.85 → Pass 2 α=0.90  — very smooth but noticeably lagged
  //   Pass 1 α=0.65 → Pass 2 α=0.80  — similar to A but slightly cleaner
  {
    id:'D', name:'D — Double EMA (0.75→0.85)', color:'#7c3aed', enabled:true,
    ema1:null, ema2:null, recent:[], hold:0, wasNull:true, buf:[],
    reset() { this.ema1=null; this.ema2=null; this.recent=[]; this.hold=0; this.wasNull=true; this.buf=[]; },
    process(hz) {
      if (hz===null) { if(this.hold>0){this.hold--;return this.ema2;} return null; }
      this.hold = 5;
      const raw = hz2midi(hz);
      const cor = octaveCorrect(raw, this.recent);
      if (cor===null) return this.ema2;
      this.recent.push(cor); if(this.recent.length>8) this.recent.shift();
      this.ema1 = this.ema1===null ? cor : 0.75*cor + 0.25*this.ema1;
      this.ema2 = this.ema2===null ? this.ema1 : 0.85*this.ema1 + 0.15*this.ema2;
      return this.ema2;
    },
    drawFn: 'catmull',
  },

  // ── E: AI friend — EMA α=0.2 + Bézier midpoint rendering ───────────────────
  // Heavy smoothing (α=0.2 means 80% weight on prior value).
  // At 60 fps, effective time constant ≈ 83 ms — noticeably lagged on fast
  // pitch changes but very smooth on sustained notes.
  // Uses quadratic Bézier through midpoints instead of Catmull-Rom.
  // The Bézier rendering method tends to soften sharp corners more aggressively.
  //
  // Alternative α values (no octave correction in this strategy by design):
  //   α=0.15 — extremely smooth, lags ~110 ms on step changes
  //   α=0.30 — similar to A but slightly heavier
  //   α=0.50 — converges toward strategy A
  {
    id:'E', name:'E — AI: EMA 0.2+Bézier', color:'#ca8a04', enabled:true,
    ema:null, hold:0, wasNull:true, buf:[],
    reset() { this.ema=null; this.hold=0; this.wasNull=true; this.buf=[]; },
    process(hz) {
      if (hz===null) { if(this.hold>0){this.hold--;return this.ema;} return null; }
      this.hold = 5;
      const raw = hz2midi(hz);
      this.ema = this.ema===null ? raw : 0.2*raw + 0.8*this.ema;
      return this.ema;
    },
    drawFn: 'bezier',
  },

  // ── F: Schmitt Trigger (dead-band filter) ────────────────────────────────────
  // Only updates the output when the new reading deviates by more than a
  // threshold (0.4 semitones ≈ 40 cents). Within the dead band the output
  // is held. Outside the dead band it tracks at 20% per frame.
  // Good for: eliminating micro-jitter on sustained notes, creating a
  // "snap-to-pitch" feel. Downside: feels sticky on intentional pitch bends.
  //
  // Threshold alternatives tried:
  //   0.2 semitones — very stable, loses some detail on vibrato
  //   0.6 semitones — close to a quarter tone, too coarse for fine display
  //   0.4 semitones — current balance (chosen value)
  //
  // Tracking rate alternatives tried:
  //   0.10 — very slow, lags on intentional pitch changes
  //   0.35 — faster, closer to a regular EMA
  //   0.20 — current (chosen value)
  {
    id:'F', name:'F — Schmitt Trigger', color:'#be185d', enabled:true,
    ema:null, hold:0, wasNull:true, buf:[],
    reset() { this.ema=null; this.hold=0; this.wasNull=true; this.buf=[]; },
    process(hz) {
      if (hz===null) { if(this.hold>0){this.hold--;return this.ema;} return null; }
      this.hold = 5;
      const raw = hz2midi(hz);
      if (this.ema===null) {
        this.ema = raw;
      } else {
        const d = raw - this.ema;
        if (Math.abs(d) > 0.4) this.ema += d * 0.20;
        // else: within dead band — output held, no update
      }
      return this.ema;
    },
    drawFn: 'catmull',
  },

  // ── G: Golden Smooth (α=0.08) ───────────────────────────────────────────────
  // Ultra-heavy EMA. α=0.08 means only 8% of each new reading enters the
  // output. Time constant ≈ 200 ms — very laggy on step changes, extremely
  // smooth on sustained notes. Named "golden" because 1-0.08 ≈ 0.92 ≈ 1/φ².
  // Primarily useful as a reference for how much lag a pure smoothing approach
  // introduces at the extreme end.
  //
  // Alternative values tried:
  //   α=0.05 — barely moves, more useful as a pitch floor estimator
  //   α=0.12 — slightly more responsive, still very smooth
  //   α=0.08 — chosen for maximum contrast with strategy A
  {
    id:'G', name:'G — Golden Smooth (α=0.08)', color:'#0369a1', enabled:true,
    ema:null, hold:0, wasNull:true, buf:[],
    reset() { this.ema=null; this.hold=0; this.wasNull=true; this.buf=[]; },
    process(hz) {
      if (hz===null) { if(this.hold>0){this.hold--;return this.ema;} return null; }
      this.hold = 5;
      const raw = hz2midi(hz);
      this.ema = this.ema===null ? raw : 0.08*raw + 0.92*this.ema;
      return this.ema;
    },
    drawFn: 'catmull',
  },

];

// ── Pitch buffer size ──────────────────────────────────────────────────────────
// 1200 points at 60 fps ≈ 20 seconds of history.
// Enough for several loops without excessive memory use.
const PBUF = 1200;

// ── processPitchFrame ─────────────────────────────────────────────────────────
// Called once per RAF frame. Reads from both analyser nodes, runs YIN,
// feeds all enabled strategies, pushes results to their pitch buffers.
// currentGlobalPi: the global phrase-beat index for the current beat.

function processPitchFrame(currentGlobalPi) {
  if (!analyser1024 || !analyser512) return;
  const sr = actx.sampleRate;

  analyser1024.getFloatTimeDomainData(buf1024);
  analyser512.getFloatTimeDomainData(buf512);

  const hzShared = yinCore(buf1024, sr, 1024, yin1024);
  const hzFast   = yinCore(buf512,  sr,  512, yin512);

  // Strategy B uses the fast 512-sample analyser; all others use 1024.
  const inputs = [hzShared, hzFast, hzShared, hzShared, hzShared, hzShared, hzShared];
  const now    = actx.currentTime;

  STRATEGIES.forEach((s, i) => {
    const sm = s.process(inputs[i]);
    if (sm !== null) {
      if (s.wasNull) s.wasNull = false;
      s.buf.push({ t: now, midi: sm, gpi: currentGlobalPi });
      if (s.buf.length > PBUF) s.buf.shift();
    } else {
      // True silence (hold expired) — inject gap sentinel once
      if (!s.wasNull) {
        s.buf.push(GAP);
        s.wasNull = true;
      }
    }
  });
}

// ── resetStrategies ───────────────────────────────────────────────────────────
// Called at session start and loop boundaries.
// Preserves each strategy's enabled flag.
function resetStrategies() {
  STRATEGIES.forEach(s => {
    const en = s.enabled;
    s.reset();
    s.enabled = en;
  });
}

// ── onLoopBoundary ────────────────────────────────────────────────────────────
// Called when a new loop starts. Injects gap sentinels to visually separate
// loops, trims old data, resets filter state for clean re-acquisition.
function onLoopBoundary() {
  STRATEGIES.forEach(s => {
    if (s.buf.length > 0 && !s.buf[s.buf.length - 1].gap) {
      s.buf.push(GAP);
    }
    if (s.buf.length > PBUF) s.buf = s.buf.slice(s.buf.length - PBUF);
    const en = s.enabled;
    s.reset();
    s.enabled = en;
  });
}
