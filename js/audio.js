// ── audio.js ──────────────────────────────────────────────────────────────────
// Audio engine: AudioContext, mic init, signal filtering, metronome, piano tone.
// Signal chain: mic → OS noiseSuppression → HPF 80Hz → LPF 2500Hz → analysers
//
// LPF raised to 2500Hz (from 1200Hz) to pass the third harmonic of notes up to
// ~833Hz (G#5), allowing HPS pitch detection to work across the full singing range.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

let actx         = null;
let analyser1024 = null;   // main analyser — YIN (time domain) + HPS (freq domain)
let analyser512  = null;   // fast analyser — kept for possible future use

async function initMic() {
  try {
    actx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate:  44100,
      latencyHint: 'interactive',
    });

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,  // OFF — distorts pitch phase
        noiseSuppression: true,   // ON  — OS/hardware broadband noise removal
        autoGainControl:  false,  // OFF — causes amplitude pumping
        sampleRate:       44100,
      },
    });

    const src = actx.createMediaStreamSource(stream);

    // High-pass: removes mic rumble, handling noise, sub-bass
    // 80Hz is just below E2 (82Hz), the lowest practical singing note
    const hpf = actx.createBiquadFilter();
    hpf.type            = 'highpass';
    hpf.frequency.value = 80;
    hpf.Q.value         = 0.7;

    // Low-pass: removes hiss and transients above the singing range
    // 2500Hz allows third harmonics of notes up to ~833Hz to pass through,
    // which is needed for HPS to work correctly across all clef ranges.
    // Previously 1200Hz — too low for reliable harmonic analysis.
    const lpf = actx.createBiquadFilter();
    lpf.type            = 'lowpass';
    lpf.frequency.value = 2500;
    lpf.Q.value         = 0.7;

    src.connect(hpf);
    hpf.connect(lpf);

    analyser1024 = actx.createAnalyser();
    analyser1024.fftSize = 4096;
    analyser1024.smoothingTimeConstant = 0;
    lpf.connect(analyser1024);

    analyser512 = actx.createAnalyser();
    analyser512.fftSize = 2048;
    analyser512.smoothingTimeConstant = 0;
    lpf.connect(analyser512);

    return true;
  } catch (e) {
    return false;
  }
}

// ── Metronome click ───────────────────────────────────────────────────────────
// Scheduled via AudioContext clock — sample-accurate, no setTimeout jitter.
// beat === 0 → accented (higher pitch, louder)
function metroClick(t, beat) {
  const accent = (beat === 0);
  const o = actx.createOscillator();
  const g = actx.createGain();
  o.connect(g); g.connect(actx.destination);
  o.frequency.value = accent ? 1100 : 680;
  g.gain.setValueAtTime(accent ? 0.18 : 0.065, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.055);
  o.start(t); o.stop(t + 0.065);
}

// ── Piano-like tone ───────────────────────────────────────────────────────────
// Additive synthesis: sine + harmonics with fast attack and natural decay.
// Used for the tuning measure chord and interval reference notes.
function pianoTone(hz, t, dur, vol) {
  [1, 2, 3, 4].forEach((h, i) => {
    const hv = [1, 0.38, 0.15, 0.06][i];
    const o  = actx.createOscillator();
    const g  = actx.createGain();
    o.connect(g); g.connect(actx.destination);
    o.type = 'sine';
    o.frequency.value = hz * h;
    const v = vol * hv;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(v, t + 0.012);
    g.gain.exponentialRampToValueAtTime(v * 0.28, t + 0.35);
    g.gain.exponentialRampToValueAtTime(v * 0.09, t + dur * 0.65);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.start(t); o.stop(t + dur + 0.04);
  });
}
