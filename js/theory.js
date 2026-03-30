// ── theory.js ─────────────────────────────────────────────────────────────────
// @version 0.2
// Music theory: MIDI math, clef definitions, interval data, drill note generation.
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

// ── Key data ──────────────────────────────────────────────────────────────────
const KEY_ROOT = { C:60, G:67, D:62, A:69, F:65, Bb:70 };
const VF_KEY   = { C:'C', G:'G', D:'D', A:'A', F:'F', Bb:'Bb' };
const KEY_PCS  = { C:[], G:[6], D:[6,1], A:[6,1,8], F:[10], Bb:[10,3] };

function needsAcc(midi, key) {
  const p = mpc(midi);
  if (![1,3,6,8,10].includes(p)) return null;
  if (KEY_PCS[key].includes(p))  return null;
  return [1,3,8].includes(p) ? '#' : 'b';
}

function midiToVFKey(midi) {
  const n = ['c','c','d','d','e','f','f','g','g','a','a','b'];
  const a = ['','#','','#','','','#','','#','','#',''];
  return `${n[mpc(midi)]}${a[mpc(midi)]}/${moct(midi)}`;
}

// ── Clef definitions ──────────────────────────────────────────────────────────
//
// KEY CONCEPT — written vs sounding pitch:
//
// G clef (treble): written pitch = sounding pitch. E4 (midi 64) on bottom line.
//
// G clef 8vb (tenor): the staff looks identical to treble. The "8" below the
//   clef means it SOUNDS one octave lower than written. So a tenor singing G3
//   (midi 55) reads and writes it as G4 (midi 67). The notehead sits on the G4
//   line. The pitch curve must also sit on the G4 line when the singer sings G3.
//   Therefore: writtenMidi = soundingMidi + 12.
//   refMidi stays 64 (E4 written = bottom line), same as treble.
//   transposeForNotation = +12.
//
// F clef (bass): F3 (midi 41) sits on the fourth line (second from top).
//   The bottom line is G2 (midi 43). refMidi = 43.
//   Written pitch = sounding pitch (no transposition).
//   transposeForNotation = 0.
//
// detectionRange: Hz range for HPS/YIN pitch search, based on the SOUNDING
//   voice range (not written). G8vb searches for tenor sounding pitches ~100-520Hz.

const CLEF_DEFS = {
  G: {
    label:                'Treble (G)',
    vfClef:               'treble',
    refMidi:              64,    // E4 written = bottom staff line
    transposeForNotation: 0,     // written = sounding
    octaveOffset:         0,     // semitones added to KEY_ROOT for sounding pitch
    detectionRange:       { minHz: 150, maxHz: 1100 },
  },
  G8vb: {
    label:                'Tenor (G 8vb)',
    vfClef:               'tenor',  // VexFlow: treble clef with 8 below
    refMidi:              64,    // E4 WRITTEN = bottom staff line (same as treble)
    transposeForNotation: 12,    // sounding + 12 = written (tenor sings an 8ve lower)
    octaveOffset:         -12,   // sounding root = KEY_ROOT - 12
    detectionRange:       { minHz: 100, maxHz: 520 },
  },
  F: {
    label:                'Bass (F)',
    vfClef:               'bass',
    refMidi:              43,    // G2 = bottom staff line of bass clef
    transposeForNotation: 0,     // written = sounding
    octaveOffset:         -24,   // sounding root = KEY_ROOT - 24
    detectionRange:       { minHz: 65, maxHz: 400 },
  },
};

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

// ── Drill note generation ─────────────────────────────────────────────────────
// Returns both sounding and written MIDI values for the two drill notes.
//
// soundingNote1/2 : what the singer actually sings — used for audio playback
//                   and pitch detection range confirmation.
// writtenNote1/2  : what appears on the staff and where the pitch curve sits.
//                   writtenNote = soundingNote + transposeForNotation
//
// Measure 1: tonic (note1). Measure 2: interval note (note2).
// Always ascending: note1 = root, note2 = root + semitones.

function getDrillNotes(key, semitones, clef) {
  const def          = CLEF_DEFS[clef];
  const soundingRoot = KEY_ROOT[key] + def.octaveOffset;
  const sounding1    = soundingRoot;
  const sounding2    = soundingRoot + semitones;
  const written1     = sounding1 + def.transposeForNotation;
  const written2     = sounding2 + def.transposeForNotation;
  return { sounding1, sounding2, written1, written2 };
}
