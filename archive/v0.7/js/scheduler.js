// ── scheduler.js ──────────────────────────────────────────────────────────────
// @version 0.2
// Web Audio lookahead scheduler — 12-beat one-shot sequence:
//   Beats  0– 3 : Measure 1 — metronome only (singer prepares)
//   Beats  4– 7 : Measure 2 — singer sings note 1 (tonic, whole note)
//   Beats  8–11 : Measure 3 — singer sings note 2 (interval, whole note)
//
// BOUNCE BUG FIX (v0.1 → v0.2):
//   currentGlobalPi only advances on the ONSET beat of each whole note
//   (beats 4 and 8). Beats 5,6,7 and 9,10,11 do NOT change it.
//   This prevents the curve from snapping back to the start of the measure
//   on every internal beat tick.
//
// Depends on: audio.js (actx, metroClick)
//             theory.js (beatSec — declared there, updated by state.js)
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const LOOKAHEAD   = 0.12;
const SCHED_MS    = 25;
const TOTAL_BEATS = 12;

const METRO_START = 0;
const DRILL_START = 4;   // exported — used by draw.js for X mapping offset
const DRILL_END   = 12;

// beatAudioTimes[i] = AudioContext time when beat i was scheduled.
// Used by draw.js to map pitch timestamps to canvas X positions.
let beatAudioTimes = new Array(TOTAL_BEATS).fill(undefined);

// vBeatQueue: visual events consumed by rafLoop() in state.js.
let vBeatQueue = [];

let schedTimer = null;
let nextBeat   = 0;
let schedIdx   = 0;
let _running   = false;

function startScheduler() {
  schedIdx       = 0;
  nextBeat       = actx.currentTime + 0.15;
  beatAudioTimes = new Array(TOTAL_BEATS).fill(undefined);
  vBeatQueue     = [];
  _running       = true;
  schedTimer     = setInterval(_schedTick, SCHED_MS);
  _schedTick();
}

function stopScheduler() {
  _running = false;
  if (schedTimer) { clearInterval(schedTimer); schedTimer = null; }
}

function _schedTick() {
  if (!actx || !_running) return;
  while (nextBeat < actx.currentTime + LOOKAHEAD && schedIdx < TOTAL_BEATS) {
    _fireBeat(schedIdx, nextBeat);
    beatAudioTimes[schedIdx] = nextBeat;
    nextBeat += beatSec;   // beatSec declared in theory.js
    schedIdx++;
  }
  if (schedIdx >= TOTAL_BEATS) {
    stopScheduler();
    const delay = Math.max(0, (nextBeat - actx.currentTime) * 1000);
    setTimeout(() => {
      if (typeof onDrillComplete === 'function') onDrillComplete();
    }, delay);
  }
}

function _fireBeat(idx, t) {
  const localBeat = idx % 4;
  metroClick(t, localBeat);   // woody click on every beat, accented on beat 0

  if (idx < DRILL_START) {
    // Measure 1 — metronome only
    vBeatQueue.push({ t, kind: 'metro', beat: idx });
    return;
  }

  // Measures 2–3 — drill
  // Only push a 'note-onset' event on beats 4 and 8 (start of each whole note).
  // All other drill beats push a 'drill-tick' which the RAF loop uses only
  // to keep the beat dots alive — it does NOT update currentGlobalPi.
  const drillBeat = idx - DRILL_START;  // 0–7

  if (drillBeat === 0 || drillBeat === 4) {
    // Whole-note onset — advance the singing position
    vBeatQueue.push({ t, kind: 'note-onset', beat: idx, globalPi: idx });
  } else {
    // Internal beat of the current whole note — do not change note position
    vBeatQueue.push({ t, kind: 'drill-tick', beat: idx });
  }
}
