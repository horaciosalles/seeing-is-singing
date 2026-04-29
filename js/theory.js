// ── theory.js ─────────────────────────────────────────────────────────────────
// @version 0.4
// Music theory: MIDI math, interval data.
// Pure functions only — no audio, no DOM, no drawing.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const NOTE_NAMES = ['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];

const hz2midi = hz => 69 + 12 * Math.log2(hz / 440);
const midi2hz = m  => 440 * Math.pow(2, (m - 69) / 12);
const mpc     = m  => ((m % 12) + 12) % 12;
const moct    = m  => Math.floor(m / 12) - 1;

// ── Shared timing state ───────────────────────────────────────────────────────
// Declared here (loaded first) so scheduler.js can safely read it.
// Updated by state.js whenever BPM changes.
let beatSec = 60 / 66;

// ── Intervals ─────────────────────────────────────────────────────────────────
const INTERVALS = [
  { name: 'Minor 2nd',   semitones: 1  },
  { name: 'Major 2nd',   semitones: 2  },
  { name: 'Minor 3rd',   semitones: 3  },
  { name: 'Major 3rd',   semitones: 4  },
  { name: 'Perfect 4th', semitones: 5  },
  { name: 'Dim. 5th',    semitones: 6  },
  { name: 'Perfect 5th', semitones: 7  },
  { name: 'Minor 6th',   semitones: 8  },
  { name: 'Major 6th',   semitones: 9  },
  { name: 'Minor 7th',   semitones: 10 },
  { name: 'Major 7th',   semitones: 11 },
  { name: 'Octave',      semitones: 12 },
];
