// ── state.js ──────────────────────────────────────────────────────────────────
// @version 0.6
// Free-practice mode. Minimalist clock-only UI.
//   • Root note + octave controlled by range sliders.
//   • Interval target set by clicking arc segments on the clock canvas.
//   • Ascending / descending toggled by the date-roller complication on the clock.
//   • Pitch readout drawn on the canvas (no separate DOM elements).
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const VERSION = 'v0.6';

// ── Root note state ───────────────────────────────────────────────────────────
let rootNote   = 0;   // pitch class 0–11 (C=0)
let rootOctave = 4;
let rootMidi   = 60;  // (rootOctave + 1) * 12 + rootNote

function _updateRootMidi() {
  rootMidi = (rootOctave + 1) * 12 + rootNote;
}

// ── Interval / direction state ────────────────────────────────────────────────
let curInterval  = 6;    // index into INTERVALS (default: P5)
let curDirection = 'asc';

function _effectiveSemitones() {
  const s = INTERVALS[curInterval].semitones;
  return curDirection === 'desc' ? -s : s;
}

// ── localStorage ─────────────────────────────────────────────────────────────
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('sightsing-v2') || '{}');
    if (typeof s.rootNote   === 'number') rootNote   = s.rootNote;
    if (typeof s.rootOctave === 'number') rootOctave = s.rootOctave;
    if (typeof s.interval   === 'number') curInterval  = s.interval;
    if (typeof s.direction  === 'string') curDirection = s.direction;
    _updateRootMidi();
  } catch (_) {}
}

function saveSettings() {
  try {
    localStorage.setItem('sightsing-v2', JSON.stringify({
      rootNote, rootOctave, interval: curInterval, direction: curDirection,
    }));
  } catch (_) {}
}

// ── App state ─────────────────────────────────────────────────────────────────
let appState = 'READY';

function setState(s) {
  appState = s;
  document.body.dataset.state = s;

  const actionsWrap = document.getElementById('actionsWrap');
  const stopBtn     = document.getElementById('stopBtn');
  const locked      = s === 'SINGING';

  ['rootNoteR', 'rootOctR', 'btnSing'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = locked;
  });

  actionsWrap.classList.toggle('hidden', s !== 'READY');
  stopBtn.classList.toggle('hidden',     s !== 'SINGING');
}

// ── RAF loop ──────────────────────────────────────────────────────────────────
let rafId = null;

function rafLoop() {
  if (appState !== 'SINGING') return;
  rafId = requestAnimationFrame(rafLoop);
  processPitchFrame(0);
  drawClockFrame({
    state:           'SINGING',
    targetSemitones: _effectiveSemitones(),
  });
}

// ── Session ───────────────────────────────────────────────────────────────────
function enterSession() {
  resetPitch();
  setState('SINGING');
  rafId = requestAnimationFrame(rafLoop);
}

function stopSession() {
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  setState('READY');
  drawClockFrame({
    state:           'READY',
    targetSemitones: _effectiveSemitones(),
  });
}

// ── Canvas-driven controls (called from draw.js click handler) ────────────────

// Called when the user clicks clock position clockPos (0–11).
// Maps clock position to the matching interval and sets it as the target.
// Also plays the target note for audio preview.
function setTargetFromClock(clockPos) {
  const isDesc = curDirection === 'desc';
  // _nameIdx equivalent: in desc mode the face is mirrored
  const nameI  = isDesc ? (12 - clockPos) % 12 : clockPos;
  // nameI 0 ↔ Root/Octave → maps to INTERVALS[11] (Octave, 12 semitones)
  // nameI 1 ↔ m2          → maps to INTERVALS[0]
  curInterval = (nameI - 1 + 12) % 12;
  saveSettings();
  const targetMidi = isDesc
    ? rootMidi - INTERVALS[curInterval].semitones
    : rootMidi + INTERVALS[curInterval].semitones;
  playNote(targetMidi);
  drawClockFrame({ state: appState, targetSemitones: _effectiveSemitones() });
}

// Called when the user taps the date-roller complication.
function toggleDirection() {
  curDirection = curDirection === 'asc' ? 'desc' : 'asc';
  saveSettings();
  drawClockFrame({ state: appState, targetSemitones: _effectiveSemitones() });
}

// ── Root slider listeners ─────────────────────────────────────────────────────
document.getElementById('rootNoteR').addEventListener('input', function () {
  rootNote = +this.value;
  _updateRootMidi();
  document.getElementById('rootNoteLabel').textContent = NOTE_NAMES[rootNote];
  saveSettings();
  resetPitch();
  drawClockFrame({ state: appState, targetSemitones: _effectiveSemitones() });
});

document.getElementById('rootOctR').addEventListener('input', function () {
  rootOctave = +this.value;
  _updateRootMidi();
  document.getElementById('rootOctLabel').textContent = rootOctave;
  saveSettings();
  resetPitch();
  drawClockFrame({ state: appState, targetSemitones: _effectiveSemitones() });
});

// ── How it works toggle ───────────────────────────────────────────────────────
document.getElementById('howBtn').addEventListener('click', () => {
  const el      = document.getElementById('ovSteps');
  const btn     = document.getElementById('howBtn');
  const showing = el.style.display !== 'none';
  el.style.display = showing ? 'none' : 'flex';
  btn.textContent  = showing ? 'How does it work ↓' : 'How does it work ↑';
});

// ── UI wiring ─────────────────────────────────────────────────────────────────
document.getElementById('grantBtn').addEventListener('click', async () => {
  const ok = await initMic();
  if (ok) {
    document.getElementById('ov').classList.add('gone');
    setState('READY');
    drawClockFrame({ state: 'READY', targetSemitones: _effectiveSemitones() });
  } else {
    const e = document.getElementById('ovErr');
    e.style.display = 'block';
    e.textContent   = 'Microphone access denied — check permissions and reload.';
  }
});

document.getElementById('btnSing').addEventListener('click', () => {
  if (!actx) return;
  if (actx.state === 'suspended') actx.resume().then(enterSession);
  else enterSession();
});

document.getElementById('stopBtn').addEventListener('click', stopSession);

// ── Version badge ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const badge = document.getElementById('versionBadge');
  if (badge) badge.textContent = VERSION;
});

// ── Init ──────────────────────────────────────────────────────────────────────
loadSettings();

// Sync sliders and labels to loaded values
const _noteR = document.getElementById('rootNoteR');
const _octR  = document.getElementById('rootOctR');
if (_noteR) _noteR.value = rootNote;
if (_octR)  _octR.value  = rootOctave;
document.getElementById('rootNoteLabel').textContent = NOTE_NAMES[rootNote];
document.getElementById('rootOctLabel').textContent  = rootOctave;

// Boot clock
initClock();
requestAnimationFrame(() => requestAnimationFrame(() => {
  drawClockFrame({ state: 'READY', targetSemitones: _effectiveSemitones() });
}));
