// ── state.js ──────────────────────────────────────────────────────────────────
// @version 0.2
// App state machine, RAF loop, session control, all UI wiring.
// States: READY → METRO → SINGING → REVIEW
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const VERSION = 'v0.2';

// ── Shared mutable state ──────────────────────────────────────────────────────
let curKey      = 'C';
let curClef     = 'G8vb';   // default: tenor
let curInterval = 6;        // index into INTERVALS (Perfect 5th)
let bpm         = 66;
// beatSec is declared in theory.js and updated here on BPM change

// ── App state ─────────────────────────────────────────────────────────────────
// READY   : staff visible, Tonic + Sing! buttons shown
// METRO   : 4 metronome clicks, no mic, no UI change on staff
// SINGING : mic live, pitch curve drawing, red Stop button shown
// REVIEW  : curve frozen, Tonic + Sing! buttons return

let appState = 'READY';

function setState(s) {
  appState = s;
  const readyBtns   = document.getElementById('readyBtns');
  const stopBtn     = document.getElementById('stopBtn');
  const statusEl    = document.getElementById('statusMsg');

  readyBtns.classList.toggle('hidden', s !== 'READY' && s !== 'REVIEW');
  stopBtn.classList.toggle('hidden',   s !== 'METRO' && s !== 'SINGING');

  const msgs = {
    READY:   '',
    METRO:   'Listen…',
    SINGING: 'Sing',
    REVIEW:  '',
  };
  if (statusEl) statusEl.textContent = msgs[s] || '';
}

// ── RAF loop ──────────────────────────────────────────────────────────────────
let rafId          = null;
let singing        = false;
let currentGlobalPi = -1;

function rafLoop() {
  if (appState === 'READY' || appState === 'REVIEW') return;
  rafId = requestAnimationFrame(rafLoop);

  const now = actx ? actx.currentTime : 0;

  // Drain visual beat queue
  while (vBeatQueue.length && vBeatQueue[0].t <= now) {
    const b = vBeatQueue.shift();

    if (b.kind === 'metro') {
      singing = false;
      if (appState !== 'METRO') setState('METRO');

    } else if (b.kind === 'note-onset') {
      // ── BOUNCE BUG FIX ──
      // Only 'note-onset' events update currentGlobalPi.
      // 'drill-tick' events (beats 5,6,7,9,10,11) are consumed below
      // but do NOT change the note position, preventing the curve from
      // snapping back to the start of the measure on every internal beat.
      singing = true;
      currentGlobalPi = b.globalPi;
      if (appState !== 'SINGING') setState('SINGING');

    } else if (b.kind === 'drill-tick') {
      // Internal beat — keep singing flag alive, do nothing else
      singing = true;
    }
  }

  // Pitch detection
  if (singing && appState === 'SINGING') {
    processPitchFrame(currentGlobalPi);   // yin.js
    updateReadout();
  }

  drawFrame();   // draw.js
}

// ── Session ────────────────────────────────────────────────────────────────────
function enterSession() {
  resetPitch();           // yin.js
  singing         = false;
  currentGlobalPi = -1;
  beatSec         = 60 / bpm;

  startScheduler();       // scheduler.js
  setState('METRO');
  rafId = requestAnimationFrame(rafLoop);
}

// Called by scheduler.js when all 12 beats complete
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
  setState('REVIEW');
  drawFrame();
}

// ── Readout ────────────────────────────────────────────────────────────────────
function updateReadout() {
  const p  = getLatestPitch();   // yin.js
  const ne = document.getElementById('readoutNote');
  const ce = document.getElementById('readoutCents');
  if (!ne || !ce) return;
  if (!p) { ne.textContent = '—'; ne.style.color = ''; ce.textContent = ''; return; }
  ne.textContent = p.noteName;
  ne.style.color = Math.abs(p.cents) < 25 ? '#1A6638'
                 : Math.abs(p.cents) < 50 ? '#9B6800'
                 :                           '#8B2020';
  ce.textContent = (p.cents >= 0 ? '+' : '') + p.cents.toFixed(0) + '¢';
}

// ── Interval selector ──────────────────────────────────────────────────────────
function buildIntervalSelect() {
  const sel = document.getElementById('intervalS');
  if (!sel) return;
  INTERVALS.forEach((iv, i) => {
    const opt = document.createElement('option');
    opt.value = i; opt.textContent = iv.name;
    if (i === curInterval) opt.selected = true;
    sel.appendChild(opt);
  });
}

// ── UI wiring ─────────────────────────────────────────────────────────────────
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

document.getElementById('btnSing').onclick = () => {
  if (!actx) return;
  if (actx.state === 'suspended') actx.resume().then(enterSession);
  else enterSession();
};

document.getElementById('btnTonic').onclick = () => {
  playTonic(curKey, curClef);   // audio.js
};

document.getElementById('stopBtn').onclick = stopSession;

document.getElementById('keyS').onchange = function () {
  curKey = this.value;
  if (appState === 'METRO' || appState === 'SINGING') stopSession();
  else { resetPitch(); rebuildNotation(); }
};

document.getElementById('clefS').onchange = function () {
  curClef = this.value;
  if (appState === 'METRO' || appState === 'SINGING') stopSession();
  else { resetPitch(); rebuildNotation(); }
};

document.getElementById('intervalS').onchange = function () {
  curInterval = +this.value;
  if (appState === 'METRO' || appState === 'SINGING') stopSession();
  else { resetPitch(); rebuildNotation(); }
};

document.getElementById('bpmR').oninput = function () {
  bpm     = +this.value;
  beatSec = 60 / bpm;   // updates shared var in theory.js
  document.getElementById('bpmV').textContent = bpm;
};

// ── Version badge ──────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const badge = document.getElementById('versionBadge');
  if (badge) badge.textContent = VERSION;
});

// ── Init ──────────────────────────────────────────────────────────────────────
buildIntervalSelect();
document.getElementById('clefS').value = curClef;
initNotation();   // notation.js — registers ResizeObserver
requestAnimationFrame(() => requestAnimationFrame(() => rebuildNotation()));
