// ── state.js ──────────────────────────────────────────────────────────────────
// App state machine, RAF loop, session control, UI wiring.
// Depends on: all other modules.
// This is the only file that touches the DOM for buttons/controls.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

// ── Shared mutable state ──────────────────────────────────────────────────────
// Read by scheduler.js, draw.js, yin.js — exposed as globals.
let curKey    = 'C';
let noteCount = 4;
let bpm       = 52;
let beatSec   = 60 / 52;

let running          = false;
let paused           = false;
let singing          = false;
let currentGlobalPi  = -1;   // current global phrase beat index

// ── RAF loop ──────────────────────────────────────────────────────────────────
let rafId = null;

function rafLoop() {
  if (!running) return;
  rafId = requestAnimationFrame(rafLoop);
  if (paused) return;   // canvas frozen — no new data, no redraw

  const now = actx ? actx.currentTime : 0;

  // Drain visual beat queue (populated by scheduler.js)
  while (vBeatQueue.length && vBeatQueue[0].t <= now) {
    const b = vBeatQueue.shift();

    if (b.kind === 'newloop') {
      onLoopBoundary();   // yin.js — injects gaps, resets filters
      singing = false;
      document.getElementById('loopCount').textContent =
        `Loop ${schedulerGetLoopCount() + 1}`;

    } else {
      // phrase beat
      singing        = true;
      currentGlobalPi = b.globalPi;
      if (b.localIdx === 0) {
        setStatus(`Singing — loop ${schedulerGetLoopCount() + 1}`);
      }
    }
  }

  // Pitch detection — only while actively singing
  if (singing) {
    processPitchFrame(currentGlobalPi);   // yin.js
    updateReadout();
  }

  drawFrame();   // draw.js
}

// ── Session control ────────────────────────────────────────────────────────────
function enterSession() {
  resetStrategies();          // yin.js
  beatAudioTimes  = [];       // scheduler.js
  currentGlobalPi = -1;
  singing  = false;
  running  = true;
  paused   = false;
  beatSec  = 60 / bpm;

  document.getElementById('btnStart').classList.add('hidden');
  document.getElementById('btnPause').classList.remove('hidden');
  document.getElementById('btnStop').classList.remove('hidden');
  document.getElementById('loopCount').textContent = 'Loop 1';
  setStatus('Sing into the mic');

  startScheduler(noteCount);  // scheduler.js
  rafId = requestAnimationFrame(rafLoop);
}

function togglePause() {
  if (!running) return;
  paused = !paused;
  const btn = document.getElementById('btnPause');

  if (paused) {
    btn.textContent = 'Resume';
    btn.classList.add('paused');
    setStatus('Paused — canvas frozen');
    stopScheduler();
    if (actx.state === 'running') actx.suspend();
  } else {
    btn.textContent = 'Pause';
    btn.classList.remove('paused');
    setStatus('Singing');
    actx.resume().then(() => {
      nextBeat   = actx.currentTime + 0.1;
      schedTimer = setInterval(_schedTick, SCHED_MS);
      _schedTick();
    });
  }
}

function stopAll() {
  running = false;
  paused  = false;
  singing = false;
  stopScheduler();
  if (actx && actx.state === 'suspended') actx.resume();
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }

  document.getElementById('btnStart').classList.remove('hidden');
  document.getElementById('btnPause').classList.add('hidden');
  document.getElementById('btnStop').classList.add('hidden');
  document.getElementById('btnPause').textContent = 'Pause';
  document.getElementById('btnPause').classList.remove('paused');
  document.getElementById('loopBar').style.width = '0%';
  document.getElementById('loopCount').textContent = '';
  setStatus('Stopped — press Start to go again');
  drawFrame();
}

// ── Readout ───────────────────────────────────────────────────────────────────
function updateReadout() {
  STRATEGIES.forEach((s, i) => {
    const ne = document.getElementById(`rg-note-${i}`);
    const ce = document.getElementById(`rg-cents-${i}`);
    if (!ne) return;
    // Find most recent non-gap value
    let sm = null;
    for (let j = s.buf.length - 1; j >= 0; j--) {
      if (!s.buf[j].gap) { sm = s.buf[j].midi; break; }
    }
    if (!s.enabled || sm === null) {
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
  });
}

// ── Strategy panel (checkboxes) ───────────────────────────────────────────────
function buildStrategyPanel() {
  const panel = document.getElementById('strategyPanel');
  const grid  = document.getElementById('readoutGrid');
  panel.innerHTML = '';
  Array.from(grid.children).forEach(el => {
    if (!el.classList.contains('rg-hdr')) el.remove();
  });

  STRATEGIES.forEach((s, i) => {
    // Checkbox row
    const row = document.createElement('label');
    row.className = 'strat-row' + (s.enabled ? '' : ' off');

    const cb = document.createElement('input');
    cb.type    = 'checkbox';
    cb.checked = s.enabled;
    cb.onchange = () => {
      s.enabled = cb.checked;
      row.classList.toggle('off', !s.enabled);
      document.querySelectorAll(`[data-si="${i}"]`)
        .forEach(el => el.classList.toggle('rg-off', !s.enabled));
    };

    const sw = document.createElement('div');
    sw.className = 'strat-swatch';
    sw.style.background = s.color;

    const lb = document.createElement('span');
    lb.className  = 'strat-label';
    lb.textContent = s.name;

    row.appendChild(cb); row.appendChild(sw); row.appendChild(lb);
    panel.appendChild(row);

    // Readout row (four grid cells)
    const dot  = document.createElement('div');
    dot.className = 'rg-dot'; dot.style.background = s.color; dot.dataset.si = i;

    const name = document.createElement('div');
    name.className = 'rg-name'; name.textContent = s.name; name.dataset.si = i;

    const note = document.createElement('div');
    note.className = 'rg-val'; note.id = `rg-note-${i}`; note.dataset.si = i;

    const cent = document.createElement('div');
    cent.className = 'rg-val'; cent.id = `rg-cents-${i}`; cent.dataset.si = i;

    if (!s.enabled) [dot, name, note, cent].forEach(el => el.classList.add('rg-off'));
    grid.appendChild(dot); grid.appendChild(name);
    grid.appendChild(note); grid.appendChild(cent);
  });
}

// ── Utility ───────────────────────────────────────────────────────────────────
function setStatus(msg) {
  document.getElementById('statusMsg').textContent = msg;
}

// ── Boot ──────────────────────────────────────────────────────────────────────
document.getElementById('grantBtn').onclick = async () => {
  const ok = await initMic();   // audio.js
  if (ok) {
    document.getElementById('ov').classList.add('gone');
    setStatus('Press Start');
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

document.getElementById('btnPause').onclick = togglePause;
document.getElementById('btnStop').onclick  = stopAll;

document.getElementById('bpmR').oninput = function () {
  bpm     = +this.value;
  beatSec = 60 / bpm;
  document.getElementById('bpmV').textContent = bpm;
};

document.getElementById('keyS').onchange = function () {
  curKey = this.value;
  if (running) stopAll();
  resetStrategies();
  rebuildNotation();   // notation.js
};

document.getElementById('notesS').onchange = function () {
  noteCount = +this.value;
  if (running) stopAll();
  rebuildNotation();
};

// ── Init ──────────────────────────────────────────────────────────────────────
buildStrategyPanel();
initNotation();   // notation.js — registers ResizeObserver
requestAnimationFrame(() => requestAnimationFrame(() => rebuildNotation()));
