// ── main.js ───────────────────────────────────────────────────────────────────
// App wiring: settings, controls, audio frames → pitch → tracker → clock.
//
// Data flow (one direction only):
//   worklet frame ─► detectPitch ─► tracker ─► lock ─► `live` ─► rAF render
// ─────────────────────────────────────────────────────────────────────────────

import { NOTE_NAMES, INTERVALS, midi2hz, noteName } from './theory.js';
import { detectPitch } from './pitch.js';
import { createTracker, createLock, octaveOff } from './tracker.js';
import { initAudio, resumeAudio, playNote } from './audio.js';
import { createClock, semisAt } from './clock.js';

const VERSION  = 'v0.8';
const STORE    = 'sightsing-v3';
const OCTAVES  = [2, 3, 4, 5];
const WINDOW_MARGIN = 7; // semitones searched beyond the root/target span

const $ = (id) => document.getElementById(id);

// ── Settings ──────────────────────────────────────────────────────────────────
const settings = { rootPc: 0, rootOct: 4, semis: 7, dir: 'asc' };

try {
  const s = JSON.parse(localStorage.getItem(STORE) || '{}');
  if (Number.isInteger(s.rootPc) && s.rootPc >= 0 && s.rootPc < 12) settings.rootPc = s.rootPc;
  if (OCTAVES.includes(s.rootOct)) settings.rootOct = s.rootOct;
  if (Number.isInteger(s.semis) && s.semis >= 1 && s.semis <= 12) settings.semis = s.semis;
  if (s.dir === 'asc' || s.dir === 'desc') settings.dir = s.dir;
} catch (_) {}

function save() {
  try { localStorage.setItem(STORE, JSON.stringify(settings)); } catch (_) {}
}

const rootMidi   = () => (settings.rootOct + 1) * 12 + settings.rootPc;
const targetMidi = () => rootMidi() + (settings.dir === 'asc' ? settings.semis : -settings.semis);

// Detection window around the notes the singer is expected to produce.
function detectionWindow() {
  const lo = Math.min(rootMidi(), targetMidi()) - WINDOW_MARGIN;
  const hi = Math.max(rootMidi(), targetMidi()) + WINDOW_MARGIN;
  return [Math.max(55, midi2hz(lo)), Math.min(1500, midi2hz(hi))];
}

// ── Live pitch state ──────────────────────────────────────────────────────────
const tracker = createTracker();
const lock    = createLock();
let singing = false;
let win = detectionWindow();
const live = { det: null, midi: null, handMidi: null, lock: { state: 'idle', progress: 0 } };

function onFrame(samples, t, sr) {
  if (!singing) return;
  const det  = detectPitch(samples, sr, win[0], win[1]);
  const midi = tracker.push(det, t);
  live.det  = det;
  live.midi = midi;
  if (midi !== null) live.handMidi = midi;
  live.lock = lock.update(midi, targetMidi(), t);
}

// ── Clock ─────────────────────────────────────────────────────────────────────
const clock = createClock($('clockCanvas'), layoutOverlays);

function view() {
  return {
    singing,
    dir: settings.dir,
    rootMidi: rootMidi(),
    targetSemis: settings.semis,
    midi: live.midi,
    handMidi: live.handMidi,
    lock: live.lock,
    octaveOff: live.midi === null ? 0 : octaveOff(live.midi, targetMidi()),
  };
}

function draw() { clock.render(view()); }

function frame() {
  draw();
  if (debugOn) drawDebug();
  if (singing) requestAnimationFrame(frame);
}

// Position the HTML controls that sit on top of the canvas.
function layoutOverlays({ R, cx, cy }) {
  const root = $('rootOverlay');
  const w = Math.max(R * 0.50, 132);
  root.style.width = `${w}px`;
  root.style.left  = `${cx - w / 2}px`;
  root.style.top   = `${cy - R * 0.975}px`;
  root.style.setProperty('--u', `${Math.max(R * 0.055, 11)}px`);

  const d = Math.max(R * 0.34, 56);
  for (const el of [$('singBtn'), $('stopBtn')]) {
    el.style.width = el.style.height = `${d}px`;
    el.style.left = `${cx - d / 2}px`;
    el.style.top  = `${cy - d / 2}px`;
  }
}

// ── Controls ──────────────────────────────────────────────────────────────────
function settingsChanged() {
  save();
  win = detectionWindow();
  $('octTargetBtn').classList.toggle('on', settings.semis === 12);
  $('targetName').textContent =
    `${INTERVALS[settings.semis].name} ${settings.dir === 'asc' ? '↑' : '↓'} · ${noteName(targetMidi())}`;
  draw();
}

function buildRootPicker() {
  const noteSel = $('noteSelect'), octSel = $('octSelect');
  NOTE_NAMES.forEach((n, i) => noteSel.add(new Option(n, i)));
  OCTAVES.forEach((o) => octSel.add(new Option(o, o)));
  noteSel.value = settings.rootPc;
  octSel.value  = settings.rootOct;
  noteSel.addEventListener('change', () => { settings.rootPc = +noteSel.value; settingsChanged(); playNote(rootMidi()); });
  octSel.addEventListener('change',  () => { settings.rootOct = +octSel.value; settingsChanged(); playNote(rootMidi()); });
  $('playRootBtn').addEventListener('click', () => playNote(rootMidi()));
  $('octTargetBtn').addEventListener('click', () => {
    settings.semis = 12;
    settingsChanged();
    playNote(targetMidi());
  });
}

function onCanvasPointer(e) {
  if (singing) return;
  const hit = clock.hitTest(e.clientX, e.clientY);
  if (!hit) return;
  if (hit.kind === 'roller') {
    settings.dir = settings.dir === 'asc' ? 'desc' : 'asc';
    settingsChanged();
    return;
  }
  if (hit.pos === 0) return; // root segment: handled by the overlay
  settings.semis = semisAt(hit.pos, settings.dir);
  settingsChanged();
  playNote(targetMidi());
}

function setSinging(on) {
  singing = on;
  document.body.dataset.state = on ? 'SINGING' : 'READY';
  if (on) {
    tracker.reset(); lock.reset();
    live.midi = live.handMidi = null;
    live.lock = { state: 'idle', progress: 0 };
    requestAnimationFrame(frame);
  } else {
    draw();
  }
}

// ── Debug overlay (?debug or the D key) ───────────────────────────────────────
let debugOn = new URLSearchParams(location.search).has('debug');

function drawDebug() {
  const d = live.det;
  $('debug').textContent = d ? [
    `raw   ${d.hz ? d.hz.toFixed(1) + ' Hz' : '—'}`,
    `clar  ${d.clarity.toFixed(3)}`,
    `rms   ${d.rms.toFixed(4)}`,
    `midi  ${live.midi === null ? '—' : live.midi.toFixed(2)}`,
    `lock  ${live.lock.state} ${(live.lock.progress * 100).toFixed(0)}%`,
    `win   ${win[0].toFixed(0)}–${win[1].toFixed(0)} Hz`,
  ].join('\n') : 'no frames yet';
}

function setDebug(on) {
  debugOn = on;
  $('debug').hidden = !on;
  if (on) drawDebug();
}

// ── Boot ──────────────────────────────────────────────────────────────────────
$('versionBadge').textContent = VERSION;
buildRootPicker();
setDebug(debugOn);

$('grantBtn').addEventListener('click', async () => {
  try {
    await initAudio(onFrame);
    $('ov').classList.add('gone');
    clock.resize();
    draw();
  } catch (err) {
    const e = $('ovErr');
    e.hidden = false;
    e.textContent = err && err.name === 'NotAllowedError'
      ? 'Microphone access denied — check permissions and reload.'
      : `Could not start audio: ${err && err.message ? err.message : err}`;
  }
});

$('howBtn').addEventListener('click', () => {
  const steps = $('ovSteps');
  steps.hidden = !steps.hidden;
  $('howBtn').textContent = steps.hidden ? 'How does it work ↓' : 'How does it work ↑';
});

$('singBtn').addEventListener('click', () => resumeAudio().then(() => setSinging(true)));
$('stopBtn').addEventListener('click', () => setSinging(false));
$('clockCanvas').addEventListener('pointerdown', onCanvasPointer);

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'SELECT') return;
  if (e.code === 'Space' && $('ov').classList.contains('gone')) {
    e.preventDefault();
    if (singing) setSinging(false); else resumeAudio().then(() => setSinging(true));
  } else if (e.key === 'd' || e.key === 'D') {
    setDebug(!debugOn);
    if (debugOn && !singing) drawDebug();
  }
});

new ResizeObserver(() => { clock.resize(); draw(); }).observe($('clockWrap'));
settingsChanged();
