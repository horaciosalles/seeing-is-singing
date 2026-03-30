// ── scheduler.js ──────────────────────────────────────────────────────────────
// Web Audio lookahead scheduler — sample-accurate beat timing.
// 16-beat one-shot sequence:
//   Beats  0– 3: Measure 1 — metronome only
//   Beats  4– 7: Measure 2 — metronome + tuning (chord + interval notes)
//   Beats  8–11: Measure 3 — metronome + drill (half notes, mic active)
//   Beats 12–15: Measure 4 — metronome + drill (half notes, mic active)
//
// Depends on: audio.js (actx, metroClick, pianoTone)
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const LOOKAHEAD  = 0.12;   // seconds to look ahead
const SCHED_MS   = 25;     // scheduler poll interval (ms)
const TOTAL_BEATS = 16;    // 4 measures × 4 beats

// Beat index boundaries
const METRO_START  = 0;
const TUNING_START = 4;
const DRILL_START  = 8;    // mic goes live here — exported for state.js + draw.js
const DRILL_END    = 16;

// beatAudioTimes[i] = AudioContext time when beat i fires.
// Indexed 0–15. Consumed by draw.js for pitch curve X mapping.
let beatAudioTimes = new Array(TOTAL_BEATS).fill(undefined);

// vBeatQueue: visual beat events consumed by rafLoop() in state.js.
// Each entry: { t, kind, beat, ... }
let vBeatQueue = [];

let schedTimer  = null;
let nextBeat    = 0;
let schedIdx    = 0;
let _running    = false;

// Set by startScheduler() — drill note data for audio scheduling
let _note1 = 60, _note2 = 67, _chordNotes = [60,64,67];

function startScheduler(note1, note2, chordNotes) {
  _note1       = note1;
  _note2       = note2;
  _chordNotes  = chordNotes;
  schedIdx     = 0;
  nextBeat     = actx.currentTime + 0.15;
  beatAudioTimes = new Array(TOTAL_BEATS).fill(undefined);
  vBeatQueue   = [];
  _running     = true;
  schedTimer   = setInterval(_schedTick, SCHED_MS);
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
    nextBeat  += beatSec;   // beatSec from state.js
    schedIdx++;
  }
  if (schedIdx >= TOTAL_BEATS) {
    stopScheduler();
    // Notify state.js when the last beat's duration has elapsed
    const delay = Math.max(0, (nextBeat - actx.currentTime) * 1000);
    setTimeout(() => { if (typeof onDrillComplete === 'function') onDrillComplete(); }, delay);
  }
}

function _fireBeat(idx, t) {
  const localBeat = idx % 4;   // beat within its measure (0–3)
  metroClick(t, localBeat);    // audio.js — accented on beat 0 of each measure

  // ── Measure 1 (beats 0-3): metronome only ──
  if (idx < TUNING_START) {
    vBeatQueue.push({ t, kind: 'metro', beat: idx });
    return;
  }

  // ── Measure 2 (beats 4-7): tuning ──
  if (idx < DRILL_START) {
    const tuningBeat = idx - TUNING_START;  // 0,1,2,3

    if (tuningBeat === 0) {
      // Beat 4: tonic chord (quarter note)
      _chordNotes.forEach(m => pianoTone(midi2hz(m), t, beatSec * 0.9, 0.14));
    } else if (tuningBeat === 1) {
      // Beat 5: note1
      pianoTone(midi2hz(_note1), t, beatSec * 0.9, 0.18);
    } else if (tuningBeat === 2) {
      // Beat 6: note2
      pianoTone(midi2hz(_note2), t, beatSec * 0.9, 0.18);
    } else if (tuningBeat === 3) {
      // Beat 7: note1 again
      pianoTone(midi2hz(_note1), t, beatSec * 0.9, 0.18);
    }

    vBeatQueue.push({ t, kind: 'tuning', beat: idx, tuningBeat });
    return;
  }

  // ── Measures 3–4 (beats 8-15): drill — mic active ──
  // Half notes: each note spans 2 beats.
  // beat 8  → note1 onset  (measure 3, half note 1)
  // beat 10 → note2 onset  (measure 3, half note 2)
  // beat 12 → note1 onset  (measure 4, half note 1)
  // beat 14 → note2 onset  (measure 4, half note 2)
  // Beats 9,11,13,15 are the second beats of each half note — metronome only.
  const drillBeat = idx - DRILL_START;  // 0–7
  if (drillBeat % 2 === 0) {
    // Half-note onset beat
    const noteToPlay = (Math.floor(drillBeat / 2) % 2 === 0) ? _note1 : _note2;
    pianoTone(midi2hz(noteToPlay), t, beatSec * 1.85, 0.10);
  }

  vBeatQueue.push({ t, kind: 'drill', beat: idx, drillBeat });
}
