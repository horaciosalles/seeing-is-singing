// ── state.js ──────────────────────────────────────────────────────────────────
// @version 0.4
// App state machine, RAF loop, session control, all UI wiring.
// States: READY → METRO → SINGING → REVIEW
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const VERSION = 'v0.4';

// Abbreviated interval labels parallel to INTERVALS in theory.js
const INTERVAL_ABBRS  = ['m2','M2','m3','M3','P4','°5','P5','m6','M6','m7','M7','P8'];
const INTERVAL_SHORTS = ['min 2nd','maj 2nd','min 3rd','maj 3rd','perf 4th',
                         'dim 5th','perf 5th','min 6th','maj 6th','min 7th','maj 7th','octave'];

// ── Shared mutable state ──────────────────────────────────────────────────────
let curKey      = 'C';
let curInterval = 6;   // index into INTERVALS
let bpm         = 66;
// beatSec declared in theory.js; updated here on BPM change

// ── localStorage persistence ──────────────────────────────────────────────────
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('sightsing-v1') || '{}');
    if (s.key)                        { curKey      = s.key; }
    if (typeof s.bpm      === 'number') { bpm        = s.bpm; beatSec = 60 / bpm; }
    if (typeof s.interval === 'number') { curInterval = s.interval; }
  } catch (_) { /* ignore */ }
}

function saveSettings() {
  try {
    localStorage.setItem('sightsing-v1', JSON.stringify({
      key: curKey, bpm, interval: curInterval,
    }));
  } catch (_) { /* ignore */ }
}

// ── App state ─────────────────────────────────────────────────────────────────
let appState = 'READY';

function setState(s) {
  appState = s;
  document.body.dataset.state = s;

  const actionsWrap = document.getElementById('actionsWrap');
  const stopBtn     = document.getElementById('stopBtn');
  const statusEl    = document.getElementById('statusMsg');
  const beatRow     = document.getElementById('beatRow');
  const ivGrid      = document.getElementById('intervalGrid');

  const locked = s === 'METRO' || s === 'SINGING';

  ['keyS','bpmR','btnTonic','btnSing'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = locked;
  });
  if (ivGrid) ivGrid.classList.toggle('locked', locked);

  actionsWrap.classList.toggle('hidden', s !== 'READY' && s !== 'REVIEW');
  stopBtn.classList.toggle('hidden',     s !== 'METRO' && s !== 'SINGING');

  beatRow.classList.toggle('visible', s === 'METRO');
  if (s !== 'METRO') {
    for (let i = 0; i < 4; i++) {
      const d = document.getElementById('bd' + i);
      if (d) d.classList.remove('pop');
    }
  }

  const msgs = {
    READY:   '',
    METRO:   'Listen to the clicks — get ready.',
    SINGING: 'Sing the root, then aim for the glow.',
    REVIEW:  'Drill complete.',
  };
  if (statusEl) statusEl.textContent = msgs[s] || '';
}

// ── RAF loop ──────────────────────────────────────────────────────────────────
let rafId           = null;
let singing         = false;
let currentGlobalPi = -1;

function rafLoop() {
  if (appState === 'READY' || appState === 'REVIEW') return;
  rafId = requestAnimationFrame(rafLoop);

  const now = actx ? actx.currentTime : 0;

  while (vBeatQueue.length && vBeatQueue[0].t <= now) {
    const b = vBeatQueue.shift();

    if (b.kind === 'metro') {
      singing = false;
      _flashBeatDot(b.beat);
      if (appState !== 'METRO') setState('METRO');

    } else if (b.kind === 'note-onset') {
      singing         = true;
      currentGlobalPi = b.globalPi;
      if (appState !== 'SINGING') setState('SINGING');
      // Update status hint based on which note we're singing
      const statusEl = document.getElementById('statusMsg');
      if (statusEl) {
        statusEl.textContent = currentGlobalPi === 4
          ? 'Sing the root — hold steady at 12:00.'
          : 'Now sing the interval — aim for the glow.';
      }

    } else if (b.kind === 'drill-tick') {
      singing = true;
    }
  }

  if (singing && appState === 'SINGING') {
    processPitchFrame(currentGlobalPi);
    updateReadout();
  }

  // Target: always show the selected interval (hand sweeps toward it on
  // interval phase; sits at root during tonic phase as a natural baseline)
  drawClockFrame({
    state:           appState,
    targetSemitones: INTERVALS[curInterval].semitones,
  });
}

function _flashBeatDot(i) {
  const dot = document.getElementById('bd' + i);
  if (!dot) return;
  dot.classList.remove('pop');
  void dot.offsetWidth;
  dot.classList.add('pop');
}

// ── Session ────────────────────────────────────────────────────────────────────
function enterSession() {
  resetPitch();
  resetClockAngle();
  singing         = false;
  currentGlobalPi = -1;
  beatSec         = 60 / bpm;

  startScheduler();
  setState('METRO');
  rafId = requestAnimationFrame(rafLoop);
}

function onDrillComplete() {
  singing = false;
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  setState('REVIEW');
  // Draw one final frame with the frozen hand position
  drawClockFrame({
    state:           'REVIEW',
    targetSemitones: INTERVALS[curInterval].semitones,
  });
}

function stopSession() {
  singing = false;
  stopScheduler();
  if (actx && actx.state === 'suspended') actx.resume();
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  setState('REVIEW');
  drawClockFrame({
    state:           'REVIEW',
    targetSemitones: INTERVALS[curInterval].semitones,
  });
}

// ── Readout ────────────────────────────────────────────────────────────────────
function updateReadout() {
  const p  = getLatestPitch();
  const ne = document.getElementById('readoutNote');
  const ce = document.getElementById('readoutCents');
  if (!ne || !ce) return;
  if (!p) { ne.textContent = '—'; ne.style.color = ''; ce.textContent = ''; return; }
  ne.textContent = p.noteName;
  ne.style.color = Math.abs(p.cents) < 25 ? '#5ee87a'   // mint — in tune
                 : Math.abs(p.cents) < 50 ? '#ffd166'   // yellow — close
                 :                           '#f472b6';  // pink — off
  ce.textContent = (p.cents >= 0 ? '+' : '') + p.cents.toFixed(0) + '¢';
}

// ── Interval grid ──────────────────────────────────────────────────────────────
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
      if (appState === 'METRO' || appState === 'SINGING') return;
      curInterval = i;
      saveSettings();
      grid.querySelectorAll('.iv-tile').forEach(t => t.classList.remove('selected'));
      tile.classList.add('selected');
      resetPitch();
      // Redraw clock with new target (hand stays at current position)
      drawClockFrame({
        state:           appState,
        targetSemitones: INTERVALS[curInterval].semitones,
      });
    });
    grid.appendChild(tile);
  });
}

// ── Settings drawer ────────────────────────────────────────────────────────────
document.getElementById('gearBtn').addEventListener('click', () => {
  const drawer = document.getElementById('settingsDrawer');
  const btn    = document.getElementById('gearBtn');
  const isOpen = drawer.classList.toggle('open');
  btn.setAttribute('aria-pressed', String(isOpen));
  drawer.setAttribute('aria-hidden', String(!isOpen));
});

// ── How it works toggle ────────────────────────────────────────────────────────
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
    // Draw initial clock after overlay is hidden
    drawClockFrame({
      state:           'READY',
      targetSemitones: INTERVALS[curInterval].semitones,
    });
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
  playTonic(curKey);
});

document.getElementById('stopBtn').addEventListener('click', stopSession);

document.getElementById('keyS').addEventListener('change', function () {
  curKey = this.value;
  saveSettings();
  if (appState === 'METRO' || appState === 'SINGING') {
    stopSession();
  } else {
    resetPitch();
    drawClockFrame({
      state:           appState,
      targetSemitones: INTERVALS[curInterval].semitones,
    });
  }
});

document.getElementById('bpmR').addEventListener('input', function () {
  bpm     = +this.value;
  beatSec = 60 / bpm;
  document.getElementById('bpmV').textContent = bpm;
  saveSettings();
});

// ── Version badge ──────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const badge = document.getElementById('versionBadge');
  if (badge) badge.textContent = VERSION;
});

// ── Init ──────────────────────────────────────────────────────────────────────
loadSettings();
buildIntervalGrid();

document.getElementById('keyS').value  = curKey;
document.getElementById('bpmR').value  = bpm;
document.getElementById('bpmV').textContent = bpm;

// Boot the clock — double-RAF ensures ResizeObserver has fired first
initClock();
requestAnimationFrame(() => requestAnimationFrame(() => {
  drawClockFrame({
    state:           'READY',
    targetSemitones: INTERVALS[curInterval].semitones,
  });
}));
