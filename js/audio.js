// ── audio.js ──────────────────────────────────────────────────────────────────
// @version 0.2
// Audio engine: mic init, filters, woody metronome click, tonic playback.
// Signal chain: mic → OS noiseSuppression → HPF 80Hz → LPF 2500Hz → analysers
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

let actx         = null;
let analyser1024 = null;
let analyser512  = null;

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
    hpf.type = 'highpass'; hpf.frequency.value = 80; hpf.Q.value = 0.7;

    const lpf = actx.createBiquadFilter();
    lpf.type = 'lowpass'; lpf.frequency.value = 2500; lpf.Q.value = 0.7;

    src.connect(hpf); hpf.connect(lpf);

    analyser1024 = actx.createAnalyser();
    analyser1024.fftSize = 4096; analyser1024.smoothingTimeConstant = 0;
    lpf.connect(analyser1024);

    analyser512 = actx.createAnalyser();
    analyser512.fftSize = 2048; analyser512.smoothingTimeConstant = 0;
    lpf.connect(analyser512);

    return true;
  } catch (e) { return false; }
}

// ── Woody metronome click ─────────────────────────────────────────────────────
// Synthesised wood block sound:
//   - Short burst of white noise shaped by a very fast exponential decay
//   - Bandpass filtered around 700–1000 Hz for that hollow woody "tok"
//   - Beat 0 of each measure: slightly louder and brighter (accent)
// Much more musical than a sine beep and easier to follow while singing.

function metroClick(t, beat) {
  const accent  = (beat === 0);
  const bufSize = Math.floor(actx.sampleRate * 0.045); // 45ms of noise
  const buf     = actx.createBuffer(1, bufSize, actx.sampleRate);
  const data    = buf.getChannelData(0);
  for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;

  const src = actx.createBufferSource();
  src.buffer = buf;

  // Bandpass — woody resonance
  const bp = actx.createBiquadFilter();
  bp.type            = 'bandpass';
  bp.frequency.value = accent ? 950 : 750;
  bp.Q.value         = accent ? 3.5 : 4.5;

  // Fast amplitude envelope — sharp attack, very short decay
  const env = actx.createGain();
  env.gain.setValueAtTime(accent ? 0.9 : 0.55, t);
  env.gain.exponentialRampToValueAtTime(0.0001, t + 0.038);

  src.connect(bp); bp.connect(env); env.connect(actx.destination);
  src.start(t); src.stop(t + 0.05);
}

// ── Tonic playback ────────────────────────────────────────────────────────────
// Called by the Tonic button. Plays the sounding root note for ~2 seconds.
// Additive piano-like synthesis so it blends well with a singing voice.

function playTonic(key, clef) {
  if (!actx) return;
  if (actx.state === 'suspended') actx.resume();
  const def  = CLEF_DEFS[clef];
  const midi = KEY_ROOT[key] + def.octaveOffset;
  const hz   = midi2hz(midi);
  const t    = actx.currentTime;
  const dur  = 2.0;

  [1, 2, 3, 4].forEach((h, i) => {
    const hv = [1, 0.4, 0.15, 0.06][i];
    const o  = actx.createOscillator();
    const g  = actx.createGain();
    o.connect(g); g.connect(actx.destination);
    o.type = 'sine'; o.frequency.value = hz * h;
    const v = 0.20 * hv;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(v, t + 0.015);
    g.gain.exponentialRampToValueAtTime(v * 0.3, t + 0.5);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.start(t); o.stop(t + dur + 0.05);
  });
}

// ── Piano tone (for future use / tuning reference) ────────────────────────────
function pianoTone(hz, t, dur, vol) {
  [1, 2, 3, 4].forEach((h, i) => {
    const hv = [1, 0.38, 0.15, 0.06][i];
    const o  = actx.createOscillator();
    const g  = actx.createGain();
    o.connect(g); g.connect(actx.destination);
    o.type = 'sine'; o.frequency.value = hz * h;
    const v = vol * hv;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(v, t + 0.012);
    g.gain.exponentialRampToValueAtTime(v * 0.28, t + 0.35);
    g.gain.exponentialRampToValueAtTime(v * 0.09, t + dur * 0.65);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.start(t); o.stop(t + dur + 0.04);
  });
}
