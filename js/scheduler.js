// ── scheduler.js ─────────────────────────────────────────────────────────────
// Web Audio lookahead scheduler — sample-accurate beat timing.
// Pattern from Chris Wilson's "A Tale of Two Clocks" (2013).
// Depends on: audio.js (actx, metroClick)
//             yin.js   (onLoopBoundary)
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

// ── How this works ────────────────────────────────────────────────────────────
// setTimeout/setInterval have ~4–16 ms jitter in browsers. For a metronome
// that is audible and must feel tight this is too much.
//
// Instead, we run a fast interval (every SCHED_MS ms) that looks ahead
// LOOKAHEAD seconds on the AudioContext clock and pre-schedules any beats
// that fall within that window. The AudioContext clock is driven by the
// audio hardware and has sub-millisecond precision.
//
// The visual RAF loop reads vBeatQueue (audio-time-stamped events) and
// processes them when their scheduled time has passed.
//
// Each loop = noteCount beats. On loop completion the scheduler automatically
// starts the next loop — no external trigger needed.

const LOOKAHEAD = 0.12;  // seconds to look ahead
const SCHED_MS  = 25;    // scheduler interval in ms

let schedTimer   = null;
let nextBeat     = 0;
let schedIdx     = 0;

// beatAudioTimes[globalPhraseIndex] = AudioContext time of that beat.
// Indexed globally (across all loops) so pitchTimeToX can always resolve.
let beatAudioTimes = [];

// vBeatQueue: events consumed by the RAF loop in state.js
// Each entry: { t, kind:'newloop'|'phrase', localIdx?, globalPi? }
let vBeatQueue = [];

// Mutable refs set by state.js before starting
let _noteCount = 4;
let _loopCount = 0;    // incremented here; read by state.js and draw.js
let _running   = false;

function schedulerSetNoteCount(n) { _noteCount = n; }
function schedulerGetLoopCount()  { return _loopCount; }

function startScheduler(noteCount) {
  _noteCount       = noteCount;
  _loopCount       = 0;
  schedIdx         = 0;
  beatAudioTimes   = [];
  vBeatQueue       = [];
  nextBeat         = actx.currentTime + 0.15;
  _running         = true;
  schedTimer       = setInterval(_schedTick, SCHED_MS);
  _schedTick();
}

function stopScheduler() {
  _running = false;
  if (schedTimer) { clearInterval(schedTimer); schedTimer = null; }
}

function _schedTick() {
  if (!actx || !_running) return;
  while (nextBeat < actx.currentTime + LOOKAHEAD) {
    const localIdx  = schedIdx % _noteCount;
    const isNewLoop = (localIdx === 0 && schedIdx > 0);

    if (isNewLoop) {
      _loopCount++;
      vBeatQueue.push({ t: nextBeat, kind: 'newloop' });
    }

    _fireBeat(localIdx, nextBeat);
    nextBeat += beatSec;   // beatSec lives in state.js — read as global
    schedIdx++;
  }
}

function _fireBeat(localIdx, t) {
  metroClick(t, localIdx);   // from audio.js
  const globalPi = _loopCount * _noteCount + localIdx;
  beatAudioTimes[globalPi] = t;
  vBeatQueue.push({ t, kind: 'phrase', localIdx, globalPi });
}
