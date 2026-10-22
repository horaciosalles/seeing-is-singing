// ── audio.js ──────────────────────────────────────────────────────────────────
// Microphone capture and reference-note playback.
// Signal chain: mic (no browser voice processing) → HPF 60 Hz → frame tap.
// ─────────────────────────────────────────────────────────────────────────────

import { midi2hz } from './theory.js';

let ctx = null;

// onFrame(samples, audioTime, sampleRate) is called every hop (~11 ms).
export async function initAudio(onFrame) {
  ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });

  // Browser noise suppression / AGC reshape the harmonics and break pitch
  // tracking, so all of it is switched off.
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });

  await ctx.audioWorklet.addModule(new URL('./pitch-worklet.js', import.meta.url));

  const frame = ctx.sampleRate > 50000 ? 4096 : 2048;
  const src   = ctx.createMediaStreamSource(stream);
  const hpf   = ctx.createBiquadFilter();
  hpf.type = 'highpass'; hpf.frequency.value = 60; hpf.Q.value = 0.7;

  const tap = new AudioWorkletNode(ctx, 'frame-tap', {
    numberOfOutputs: 1,
    processorOptions: { frame, hop: frame / 4 },
  });
  tap.port.onmessage = (e) => onFrame(e.data.samples, e.data.t, ctx.sampleRate);

  // Keep the tap in the rendered graph without making it audible.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  src.connect(hpf).connect(tap).connect(mute).connect(ctx.destination);
}

export function resumeAudio() {
  return ctx && ctx.state === 'suspended' ? ctx.resume() : Promise.resolve();
}

// Additive piano-like tone, ~2 s.
export function playNote(midi) {
  if (!ctx) return;
  resumeAudio();
  const hz = midi2hz(midi);
  const t  = ctx.currentTime;
  const dur = 2.0;
  [1, 0.4, 0.15, 0.06].forEach((amp, i) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.type = 'sine'; o.frequency.value = hz * (i + 1);
    const v = 0.20 * amp;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(v, t + 0.015);
    g.gain.exponentialRampToValueAtTime(v * 0.3, t + 0.5);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.start(t); o.stop(t + dur + 0.05);
  });
}
