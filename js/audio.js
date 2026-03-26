// ── audio.js ─────────────────────────────────────────────────────────────────
// Audio engine: AudioContext, mic init, signal filtering, metronome clicks.
// Owns actx, analyser nodes, and the biquad filter chain.
// No pitch detection, no drawing, no DOM (except reading actx state).
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

let actx         = null;
let analyser1024 = null;   // feeds strategies A C D E F G  (1024-sample YIN)
let analyser512  = null;   // feeds strategy B               (512-sample YIN)

// ── Signal chain ──────────────────────────────────────────────────────────────
// mic → OS noiseSuppression → highpass 80 Hz → lowpass 1200 Hz → analysers
//
// Why echoCancellation OFF: introduces phase artifacts that corrupt YIN.
// Why autoGainControl OFF:  causes amplitude pumping → false RMS gate triggers.
// Why noiseSuppression ON:  OS/hardware DSP targets broadband noise without
//                           distorting the fundamental frequency.
// Why highpass 80 Hz:       removes mic rumble, handling noise, sub-bass.
// Why lowpass 1200 Hz:      removes sibilants, consonant transients, hiss
//                           above the soprano top note (C6 ≈ 1047 Hz).

async function initMic() {
  try {
    actx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate:  44100,
      latencyHint: 'interactive',
    });

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: true,
        autoGainControl:  false,
        sampleRate:       44100,
      },
    });

    const src = actx.createMediaStreamSource(stream);

    const hpf = actx.createBiquadFilter();
    hpf.type            = 'highpass';
    hpf.frequency.value = 80;
    hpf.Q.value         = 0.7;

    const lpf = actx.createBiquadFilter();
    lpf.type            = 'lowpass';
    lpf.frequency.value = 1200;
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

// ── Metronome ─────────────────────────────────────────────────────────────────
// Scheduled via Web Audio clock — sample-accurate, no setTimeout drift.
// beat 0 of each loop is accented (higher frequency, louder).

function metroClick(t, beat) {
  const accent = (beat === 0);
  const o = actx.createOscillator();
  const g = actx.createGain();
  o.connect(g);
  g.connect(actx.destination);
  o.frequency.value = accent ? 1100 : 680;
  g.gain.setValueAtTime(accent ? 0.16 : 0.055, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.055);
  o.start(t);
  o.stop(t + 0.065);
}
