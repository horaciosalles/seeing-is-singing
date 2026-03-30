// ── state.js ──────────────────────────────────────────────────────────────────
// App state machine, RAF loop, session control, all UI wiring.
// States: READY → METRO → TUNING → SINGING → REVIEW
// Depends on: all other modules.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

// ── Shared mutable state (read by other modules) ──────────────────────────────
let curKey       = 'C';
let curClef      = 'G8vb';      // Default to tenor — most common use case
let curInterval  = 6;           // Index into INTERVALS array (Perfect 5th)
let curDirection = 'asc';
let bpm          = 66;
// beatSec is declared in theory.js (loaded first) so scheduler.js can read it.
// Updated here whenever BPM changes.
let activeStrategy = 'responsive';

// ── App states ────────────────────────────────────────────────────────────────
// READY   : showing staff, waiting for Start
// METRO   : measure 1 — metronome only, no mic
// TUNING  : measure 2 — chord + interval notes playing, no mic
// SINGING : measures 3–4 — mic active, pitch curve drawing
// REVIEW  : curve frozen, waiting for Try Again or New Drill

let appState = 'READY';

function setState(s) {
  appState = s;
  const btnStart  = document.getElementById('btnStart');
  const btnStop   = document.getElementById('btnStop');
  const reviewDiv = document.getElementById('reviewBtns');

  btnStart.classList.toggle('hidden',  s !== 'READY');
  btnStop.classList.toggle('hidden',   s !== 'METRO' && s !== 'TUNING' && s !== 'SINGING');
  reviewDiv.classList.toggle('hidden', s !== 'REVIEW');

  const msgs = {
    READY:   'Press Start to begin',
    METRO:   'Measure 1 — listen and prepare',
    TUNING:  'Measure 2 — hear the interval',
    SINGING: 'Sing — match each note',
    REVIEW:  'Review — Try Again or New Drill',
  };
  setStatus(msgs[s] || '');
}

// ── RAF loop ──────────────────────────────────────────────────────────────────
let rafId   = null;
let singing = false;   // true only during SINGING state
let currentGlobalPi = -1;

function rafLoop() {
  if (appState === 'READY' || appState === 'REVIEW') return;
  rafId = requestAnimationFrame(rafLoop);

  const now = actx ? actx.currentTime : 0;

  // Drain visual beat queue from scheduler.js
  while (vBeatQueue.length && vBeatQueue[0].t <= now) {
    const b = vBeatQueue.shift();

    if (b.kind === 'metro') {
      if (appState !== 'METRO') setState('METRO');
      singing = false;

    } else if (b.kind === 'tuning') {
      if (appState !== 'TUNING') setState('TUNING');
      singing = false;

    } else if (b.kind === 'drill') {
      if (appState !== 'SINGING') setState('SINGING');
      singing       = true;
      currentGlobalPi = b.beat;
    }
  }

  // Pitch detection — only while in SINGING state
  if (singing && appState === 'SINGING') {
    processPitchFrame(currentGlobalPi);   // yin.js
    updateReadout();
  }

  drawFrame();   // draw.js
}

// ── Session control ────────────────────────────────────────────────────────────
function enterSession() {
  onSessionStart();    // yin.js — resets both strategies
  singing          = false;
  currentGlobalPi  = -1;
  beatSec          = 60 / bpm;

  const { note1, note2 } = getDrillNotes(curKey, INTERVALS[curInterval].semitones, curDirection, curClef);
  const chordNotes       = getChordNotes(curKey, curClef);

  startScheduler(note1, note2, chordNotes);   // scheduler.js
  setState('METRO');
  rafId = requestAnimationFrame(rafLoop);
}

// Called by scheduler.js via setTimeout after beat 15 completes
function onDrillComplete() {
  singing = false;
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  setState('REVIEW');
  drawFrame();
}

function stopSession() {
  singing = false;
  stopScheduler();
  if (actx && actx.state === 'suspended') actx.resume();
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  setState('READY');
  drawFrame();
}

// ── Readout ───────────────────────────────────────────────────────────────────
function updateReadout() {
  const s = STRATEGIES[activeStrategy];
  if (!s) return;
  let sm = null;
  for (let j = s.buf.length-1; j >= 0; j--) {
    if (!s.buf[j].gap) { sm = s.buf[j].midi; break; }
  }
  const ne = document.getElementById('readoutNote');
  const ce = document.getElementById('readoutCents');
  if (!ne || !ce) return;   // guard against missing DOM elements
  if (sm === null) {
    ne.textContent = '—'; ne.style.color = ''; ce.textContent = '';
    return;
  }
  const nearest = Math.round(sm);
  const cents   = (sm - nearest) * 100;
  ne.textContent = NOTE_NAMES[mpc(nearest)];
  ne.style.color = Math.abs(cents) < 25 ? '#1A6638'
                 : Math.abs(cents) < 50 ? '#9B6800'
                 :                        '#8B2020';
  ce.textContent = (cents >= 0 ? '+' : '') + cents.toFixed(0) + '¢';
}

// ── UI helpers ────────────────────────────────────────────────────────────────
function setStatus(msg) {
  const el = document.getElementById('statusMsg');
  if (el) el.textContent = msg;
}

// ── Boot & wiring ─────────────────────────────────────────────────────────────
document.getElementById('grantBtn').onclick = async () => {
  const ok = await initMic();
  if (ok) {
    document.getElementById('ov').classList.add('gone');
    setState('READY');
  } else {
    const e = document.getElementById('ovErr');
    e.style.display = 'block';
    e.textContent   = 'Microphone access denied — check permissions and reload.';
  }
};

document.getElementById('btnStart').onclick = () => {
  if (!actx) return;
  if (actx.state === 'suspended') actx.resume().then(enterSession);
  else enterSession();
};

document.getElementById('btnStop').onclick = () => {
  stopSession();
};

document.getElementById('btnRetry').onclick = () => {
  // Clear only the active strategy buffer, re-enter session
  STRATEGIES[activeStrategy].reset();
  enterSession();
};

document.getElementById('btnNewDrill').onclick = () => {
  // Advance interval index and restart
  curInterval = (curInterval + 1) % INTERVALS.length;
  document.getElementById('intervalS').value = curInterval;
  onSessionStart();
  rebuildNotation();
  setState('READY');
};

document.getElementById('keyS').onchange = function () {
  curKey = this.value;
  if (appState !== 'READY' && appState !== 'REVIEW') stopSession();
  rebuildNotation();
};

document.getElementById('clefS').onchange = function () {
  curClef = this.value;
  if (appState !== 'READY' && appState !== 'REVIEW') stopSession();
  rebuildNotation();
};

document.getElementById('intervalS').onchange = function () {
  curInterval = +this.value;
  if (appState !== 'READY' && appState !== 'REVIEW') stopSession();
  rebuildNotation();
};

document.getElementById('directionS').onchange = function () {
  curDirection = this.value;
  if (appState !== 'READY' && appState !== 'REVIEW') stopSession();
  rebuildNotation();
};

document.getElementById('bpmR').oninput = function () {
  bpm     = +this.value;
  beatSec = 60 / bpm;   // updates shared var in theory.js
  document.getElementById('bpmV').textContent = bpm;
};

// ── Pitch tracking toggle ─────────────────────────────────────────────────────
document.getElementById('toggleResponsive').onclick = () => {
  activeStrategy = 'responsive';
  _updateToggleUI();
  STRATEGIES[activeStrategy].reset();
};
document.getElementById('toggleSmooth').onclick = () => {
  activeStrategy = 'smooth';
  _updateToggleUI();
  STRATEGIES[activeStrategy].reset();
};
function _updateToggleUI() {
  document.getElementById('toggleResponsive').classList.toggle('active', activeStrategy === 'responsive');
  document.getElementById('toggleSmooth').classList.toggle('active', activeStrategy === 'smooth');
}

// ── Populate interval selector ────────────────────────────────────────────────
function buildIntervalSelect() {
  const sel = document.getElementById('intervalS');
  INTERVALS.forEach((iv, i) => {
    const opt = document.createElement('option');
    opt.value = i; opt.textContent = iv.name;
    if (i === curInterval) opt.selected = true;
    sel.appendChild(opt);
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────
buildIntervalSelect();
_updateToggleUI();

// Set clef selector to default
document.getElementById('clefS').value = curClef;

initNotation();   // notation.js — registers ResizeObserver
requestAnimationFrame(() => requestAnimationFrame(() => rebuildNotation()));
