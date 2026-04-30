// ── state.js ──────────────────────────────────────────────────────────────────
// @version 0.7
// Free-practice mode. Full-screen clock UI.
//   • Root note + octave controlled by drum-wheel (mobile) or select (PC) inside
//     the root segment overlay at 12 o'clock on the canvas.
//   • ↓/↑ 8va buttons in the lower sub-segment shift the root octave.
//   • Sing button is a round hub button centred on the clock face.
//   • Interval target set by clicking arc segments on the clock canvas.
//   • Ascending / descending toggled by the date-roller complication on the clock.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const VERSION = 'v0.7';

// ── Root note state ───────────────────────────────────────────────────────────
let rootNote   = 0;   // pitch class 0–11 (C=0)
let rootOctave = 4;
let rootMidi   = 60;

function _updateRootMidi() {
  rootMidi = (rootOctave + 1) * 12 + rootNote;
}

// ── Interval / direction state ────────────────────────────────────────────────
let curInterval  = 6;
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
  const locked = s === 'SINGING';

  document.getElementById('btnSing').classList.toggle('hidden', locked);
  document.getElementById('stopBtn').classList.toggle('hidden', !locked);

  // Dim root overlay and block interaction while singing
  const rootOverlay = document.getElementById('rootOverlay');
  if (rootOverlay) {
    rootOverlay.style.pointerEvents = locked ? 'none' : '';
    rootOverlay.style.opacity = locked ? '0.38' : '';
  }
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

// ── Canvas-driven controls ────────────────────────────────────────────────────

function setTargetFromClock(clockPos) {
  const isDesc = curDirection === 'desc';
  const nameI  = isDesc ? (12 - clockPos) % 12 : clockPos;
  curInterval = (nameI - 1 + 12) % 12;
  saveSettings();
  const targetMidi = isDesc
    ? rootMidi - INTERVALS[curInterval].semitones
    : rootMidi + INTERVALS[curInterval].semitones;
  playNote(targetMidi);
  drawClockFrame({ state: appState, targetSemitones: _effectiveSemitones() });
}

function toggleDirection() {
  curDirection = curDirection === 'asc' ? 'desc' : 'asc';
  saveSettings();
  drawClockFrame({ state: appState, targetSemitones: _effectiveSemitones() });
}

// ── Drum wheel state ──────────────────────────────────────────────────────────
let _drumItemH   = 28; // CSS px, updated on every resize
let _drumsBuilt  = false;
const _isPC = window.matchMedia('(pointer: fine)').matches;

if (_isPC) document.body.classList.add('pc-mode');

const _NOTE_LABELS = ['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];
const _OCT_LABELS  = ['1','2','3','4','5','6'];

// Build drum scroll content (called once)
function _buildDrum(scrollEl, labels) {
  scrollEl.innerHTML = '';
  const mk = (cls) => {
    const d = document.createElement('div');
    d.className = cls;
    return d;
  };
  // 1 padding item at top (for 3-item display: pad, selected, pad)
  scrollEl.appendChild(mk('drum-item drum-pad'));
  labels.forEach((txt, i) => {
    const d = mk('drum-item');
    d.textContent = txt;
    d.dataset.i = i;
    scrollEl.appendChild(d);
  });
  scrollEl.appendChild(mk('drum-item drum-pad'));
}

// Highlight the centered item
function _highlightDrum(scrollEl, idx) {
  const items = scrollEl.querySelectorAll('.drum-item:not(.drum-pad)');
  items.forEach((el, i) => el.classList.toggle('drum-selected', i === idx));
}

// Sync scroll position to match current state value (no state update triggered)
function _syncDrums() {
  const noteEl = document.getElementById('noteDrumScroll');
  const octEl  = document.getElementById('octDrumScroll');
  const h = _drumItemH;
  if (noteEl) {
    noteEl.scrollTop = rootNote * h;
    _highlightDrum(noteEl, rootNote);
  }
  if (octEl) {
    octEl.scrollTop = (rootOctave - 1) * h;
    _highlightDrum(octEl, rootOctave - 1);
  }
}

// Scroll event handlers (debounced state update)
let _noteScrollTimer = null;
function _onNoteScroll() {
  const el = document.getElementById('noteDrumScroll');
  if (!el) return;
  const idx = Math.min(Math.max(Math.round(el.scrollTop / _drumItemH), 0), 11);
  _highlightDrum(el, idx);
  clearTimeout(_noteScrollTimer);
  _noteScrollTimer = setTimeout(() => {
    if (idx !== rootNote) {
      rootNote = idx;
      _updateRootMidi();
      saveSettings();
      drawClockFrame({ state: appState, targetSemitones: _effectiveSemitones() });
    }
  }, 120);
}

let _octScrollTimer = null;
function _onOctScroll() {
  const el = document.getElementById('octDrumScroll');
  if (!el) return;
  const idx = Math.min(Math.max(Math.round(el.scrollTop / _drumItemH), 0), 5);
  _highlightDrum(el, idx);
  clearTimeout(_octScrollTimer);
  _octScrollTimer = setTimeout(() => {
    const oct = idx + 1;
    if (oct !== rootOctave) {
      rootOctave = oct;
      _updateRootMidi();
      saveSettings();
      drawClockFrame({ state: appState, targetSemitones: _effectiveSemitones() });
    }
  }, 120);
}

// Build PC selects (called once)
function _buildSelects() {
  const noteEl = document.getElementById('noteSelect');
  const octEl  = document.getElementById('octSelect');

  _NOTE_LABELS.forEach((n, i) => {
    const o = document.createElement('option');
    o.value = i; o.textContent = n;
    if (i === rootNote) o.selected = true;
    noteEl.appendChild(o);
  });

  _OCT_LABELS.forEach((n, i) => {
    const o = document.createElement('option');
    o.value = i + 1; o.textContent = n;
    if (i + 1 === rootOctave) o.selected = true;
    octEl.appendChild(o);
  });

  noteEl.addEventListener('change', function () {
    rootNote = +this.value;
    _updateRootMidi();
    saveSettings();
    drawClockFrame({ state: appState, targetSemitones: _effectiveSemitones() });
  });

  octEl.addEventListener('change', function () {
    rootOctave = +this.value;
    _updateRootMidi();
    saveSettings();
    drawClockFrame({ state: appState, targetSemitones: _effectiveSemitones() });
  });
}

// Sync PC selects to current state
function _syncSelects() {
  const noteEl = document.getElementById('noteSelect');
  const octEl  = document.getElementById('octSelect');
  if (noteEl) noteEl.value = rootNote;
  if (octEl)  octEl.value  = rootOctave;
}

// One-time init for root controls
function _initRoot() {
  if (_isPC) {
    _buildSelects();
  } else {
    const noteEl = document.getElementById('noteDrumScroll');
    const octEl  = document.getElementById('octDrumScroll');
    _buildDrum(noteEl, _NOTE_LABELS);
    _buildDrum(octEl,  _OCT_LABELS);
    noteEl.addEventListener('scroll', _onNoteScroll, { passive: true });
    octEl.addEventListener('scroll',  _onOctScroll,  { passive: true });
  }

  // Clicking the root main area plays the current root note
  document.getElementById('rootMain').addEventListener('click', () => {
    if (appState === 'SINGING') return;
    playNote(rootMidi);
  });

  // Octave-shift buttons
  document.getElementById('octDownBtn').addEventListener('click', () => {
    if (appState === 'SINGING') return;
    rootOctave = Math.max(1, rootOctave - 1);
    _updateRootMidi();
    saveSettings();
    playNote(rootMidi);
    if (_isPC) _syncSelects();
    else       _syncDrums();
    drawClockFrame({ state: appState, targetSemitones: _effectiveSemitones() });
  });

  document.getElementById('octUpBtn').addEventListener('click', () => {
    if (appState === 'SINGING') return;
    rootOctave = Math.min(6, rootOctave + 1);
    _updateRootMidi();
    saveSettings();
    playNote(rootMidi);
    if (_isPC) _syncSelects();
    else       _syncDrums();
    drawClockFrame({ state: appState, targetSemitones: _effectiveSemitones() });
  });
}

// ── Geometry callback from draw.js ────────────────────────────────────────────
window._onClockResize = function ({ R, size, wrapW, wrapH }) {
  const segOuter = R * 0.975;
  const mainH    = R * 0.28;  // drum wheel area height
  const octH     = R * 0.19;  // octave-button area height
  const ovW      = Math.max(R * 0.52, 100);

  // Update CSS variable for drum item sizing
  _drumItemH = mainH / 3;
  document.documentElement.style.setProperty('--drum-item-h', `${_drumItemH}px`);

  // Position root overlay
  const overlay = document.getElementById('rootOverlay');
  if (overlay) {
    overlay.style.top    = `${wrapH / 2 - segOuter}px`;
    overlay.style.left   = `${(wrapW - ovW) / 2}px`;
    overlay.style.width  = `${ovW}px`;
  }
  const rootMain = document.getElementById('rootMain');
  if (rootMain) rootMain.style.height = `${mainH}px`;
  const rootOctRow = document.getElementById('rootOctRow');
  if (rootOctRow) rootOctRow.style.height = `${octH}px`;

  // Hub buttons (Sing / Stop)
  const hubD = Math.max(R * 0.36, 44);
  ['btnSing', 'stopBtn'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.style.width  = `${hubD}px`;
      el.style.height = `${hubD}px`;
      el.style.left   = `${(wrapW - hubD) / 2}px`;
      el.style.top    = `${(wrapH - hubD) / 2}px`;
    }
  });

  // Build drums/selects on first call, then just sync
  if (!_drumsBuilt) {
    _initRoot();
    _drumsBuilt = true;
  }

  // Sync scroll / select to current state
  if (_isPC) _syncSelects();
  else       requestAnimationFrame(_syncDrums);
};

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

document.getElementById('howBtn').addEventListener('click', () => {
  const el      = document.getElementById('ovSteps');
  const btn     = document.getElementById('howBtn');
  const showing = el.style.display !== 'none';
  el.style.display = showing ? 'none' : 'flex';
  btn.textContent  = showing ? 'How does it work ↓' : 'How does it work ↑';
});

// ── Version badge ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const badge = document.getElementById('versionBadge');
  if (badge) badge.textContent = VERSION;
});

// ── Init ──────────────────────────────────────────────────────────────────────
loadSettings();
initClock();  // triggers _resize → _onClockResize (builds drums, positions overlays)
requestAnimationFrame(() => requestAnimationFrame(() => {
  drawClockFrame({ state: 'READY', targetSemitones: _effectiveSemitones() });
}));
