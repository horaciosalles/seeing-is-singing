// ── state.js ──────────────────────────────────────────────────────────────────
// @version 0.5
// Free-practice mode. No metronome, no drill phases.
// Sing! starts continuous pitch tracking; Stop ends it.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const VERSION = 'v0.5';

const INTERVAL_ABBRS  = ['m2','M2','m3','M3','P4','°5','P5','m6','M6','m7','M7','P8'];
const INTERVAL_SHORTS = ['min 2nd','maj 2nd','min 3rd','maj 3rd','perf 4th',
                         'dim 5th','perf 5th','min 6th','maj 6th','min 7th','maj 7th','octave'];

// ── Root note state ───────────────────────────────────────────────────────────
// rootMidi is accessed directly by draw.js (shared global scope).
let rootNote   = 0;   // pitch class 0–11 (C=0)
let rootOctave = 4;   // octave 1–6
let rootMidi   = 60;  // = (rootOctave + 1) * 12 + rootNote

function _updateRootMidi() {
  rootMidi = (rootOctave + 1) * 12 + rootNote;
}

// ── Interval state ────────────────────────────────────────────────────────────
let curInterval = 6; // index into INTERVALS

// ── localStorage ─────────────────────────────────────────────────────────────
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('sightsing-v2') || '{}');
    if (typeof s.rootNote   === 'number') rootNote   = s.rootNote;
    if (typeof s.rootOctave === 'number') rootOctave = s.rootOctave;
    if (typeof s.interval   === 'number') curInterval = s.interval;
    _updateRootMidi();
  } catch (_) {}
}

function saveSettings() {
  try {
    localStorage.setItem('sightsing-v2', JSON.stringify({
      rootNote, rootOctave, interval: curInterval,
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
  const ivGrid      = document.getElementById('intervalGrid');
  const locked      = s === 'SINGING';

  ['rootNoteS','rootOctS','btnTonic','btnTarget','btnSing'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = locked;
  });
  if (ivGrid) ivGrid.classList.toggle('locked', locked);

  actionsWrap.classList.toggle('hidden', s !== 'READY');
  stopBtn.classList.toggle('hidden',     s !== 'SINGING');
}

// ── RAF loop ──────────────────────────────────────────────────────────────────
let rafId = null;

function rafLoop() {
  if (appState !== 'SINGING') return;
  rafId = requestAnimationFrame(rafLoop);

  processPitchFrame(0); // gpi unused in clock renderer
  updateReadout();
  drawClockFrame({
    state:           'SINGING',
    targetSemitones: INTERVALS[curInterval].semitones,
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
  if (actx && actx.state === 'suspended') actx.resume();
  setState('READY');
  drawClockFrame({
    state:           'READY',
    targetSemitones: INTERVALS[curInterval].semitones,
  });
}

// ── Readout ───────────────────────────────────────────────────────────────────
function updateReadout() {
  const p  = getLatestPitch();
  const ne = document.getElementById('readoutNote');
  const ce = document.getElementById('readoutCents');
  if (!ne || !ce) return;
  if (!p) {
    ne.textContent = '—'; ne.style.color = ''; ce.textContent = '';
    return;
  }
  ne.textContent = p.noteName;
  ne.style.color = Math.abs(p.cents) < 25 ? '#1f9960'   // green  — in tune
                 : Math.abs(p.cents) < 50 ? '#b07800'   // amber  — close
                 :                           '#c0306a';  // red    — off
  ce.textContent = (p.cents >= 0 ? '+' : '') + p.cents.toFixed(0) + '¢';
}

// ── Interval grid ─────────────────────────────────────────────────────────────
function buildIntervalGrid() {
  const grid = document.getElementById('intervalGrid');
  if (!grid) return;
  grid.innerHTML = '';
  INTERVALS.forEach((iv, i) => {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'iv-tile' + (i === curInterval ? ' selected' : '');
    tile.innerHTML =
      `<span class="iv-abbr">${INTERVAL_ABBRS[i]}</span>` +
      `<span class="iv-name">${INTERVAL_SHORTS[i]}</span>`;
    tile.addEventListener('click', () => {
      if (appState === 'SINGING') return;
      curInterval = i;
      saveSettings();
      grid.querySelectorAll('.iv-tile').forEach(t => t.classList.remove('selected'));
      tile.classList.add('selected');
      resetPitch();
      drawClockFrame({
        state:           appState,
        targetSemitones: INTERVALS[curInterval].semitones,
      });
    });
    grid.appendChild(tile);
  });
}

// ── Root note selectors ───────────────────────────────────────────────────────
document.getElementById('rootNoteS').addEventListener('change', function () {
  rootNote = +this.value;
  _updateRootMidi();
  saveSettings();
  resetPitch();
  drawClockFrame({ state: appState, targetSemitones: INTERVALS[curInterval].semitones });
});

document.getElementById('rootOctS').addEventListener('change', function () {
  rootOctave = +this.value;
  _updateRootMidi();
  saveSettings();
  resetPitch();
  drawClockFrame({ state: appState, targetSemitones: INTERVALS[curInterval].semitones });
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
    drawClockFrame({ state: 'READY', targetSemitones: INTERVALS[curInterval].semitones });
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

document.getElementById('btnTonic').addEventListener('click', () => {
  playNote(rootMidi);
});

document.getElementById('btnTarget').addEventListener('click', () => {
  playNote(rootMidi + INTERVALS[curInterval].semitones);
});

document.getElementById('stopBtn').addEventListener('click', stopSession);

// ── Version badge ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const badge = document.getElementById('versionBadge');
  if (badge) badge.textContent = VERSION;
});

// ── Init ──────────────────────────────────────────────────────────────────────
loadSettings();
buildIntervalGrid();

// Sync root selectors to loaded values
document.getElementById('rootNoteS').value = rootNote;
document.getElementById('rootOctS').value  = rootOctave;

// Boot clock
initClock();
requestAnimationFrame(() => requestAnimationFrame(() => {
  drawClockFrame({ state: 'READY', targetSemitones: INTERVALS[curInterval].semitones });
}));
