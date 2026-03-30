// ── theory.js ─────────────────────────────────────────────────────────────────
// Music theory: MIDI math, clef definitions, interval data, drill note generation.
// Pure functions only — no audio, no DOM, no drawing.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

// ── MIDI helpers ──────────────────────────────────────────────────────────────
const NOTE_NAMES = ['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];

const hz2midi = hz => 69 + 12 * Math.log2(hz / 440);
const midi2hz = m  => 440 * Math.pow(2, (m - 69) / 12);
const mpc     = m  => ((m % 12) + 12) % 12;
const moct    = m  => Math.floor(m / 12) - 1;

// ── Key data ──────────────────────────────────────────────────────────────────
// Root MIDI notes in the G-clef (treble) octave.
// Octave offsets for other clefs are applied at drill generation time.
const KEY_ROOT = { C:60, G:67, D:62, A:69, F:65, Bb:70 };

const VF_KEY  = { C:'C', G:'G', D:'D', A:'A', F:'F', Bb:'Bb' };

const KEY_PCS = {
  C:[], G:[6], D:[6,1], A:[6,1,8], F:[10], Bb:[10,3],
};

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
// refMidi: the MIDI note that sits on the bottom staff line for this clef.
//   G clef  : E4 = 64
//   G8vb    : E3 = 52  (sounds an octave lower than written)
//   F clef  : G2 = 43
// octaveOffset: semitone shift applied to KEY_ROOT when generating drill notes,
//   so the sung notes land in the natural range for that voice type.
// vfClef: VexFlow clef string passed to stave.addClef()
// detectionRange: {minHz, maxHz} for HPS pitch detection (voice range per clef)

const CLEF_DEFS = {
  G: {
    label:          'Treble (G)',
    vfClef:         'treble',
    refMidi:        64,   // E4
    octaveOffset:   0,
    detectionRange: { minHz: 150, maxHz: 1100 },
  },
  G8vb: {
    label:          'Tenor (G 8vb)',
    vfClef:         'tenor',   // VexFlow 'tenor' = G clef with 8 below
    refMidi:        52,   // E3
    octaveOffset:   -12,
    detectionRange: { minHz: 100, maxHz: 520 },
  },
  F: {
    label:          'Bass (F)',
    vfClef:         'bass',
    refMidi:        43,   // G2
    octaveOffset:   -24,
    detectionRange: { minHz: 65, maxHz: 400 },
  },
};

// ── Interval definitions ──────────────────────────────────────────────────────
// Note: "Perfect 6th" is non-standard — the correct term is "Major 6th" (9 st).
// Using "Major 6th" here per music theory convention.
const INTERVALS = [
  { name: 'Minor 2nd',    semitones: 1  },
  { name: 'Major 2nd',    semitones: 2  },
  { name: 'Minor 3rd',    semitones: 3  },
  { name: 'Major 3rd',    semitones: 4  },
  { name: 'Perfect 4th',  semitones: 5  },
  { name: 'Dim. 5th',     semitones: 6  },
  { name: 'Perfect 5th',  semitones: 7  },
  { name: 'Minor 6th',    semitones: 8  },
  { name: 'Major 6th',    semitones: 9  },
  { name: 'Minor 7th',    semitones: 10 },
  { name: 'Major 7th',    semitones: 11 },
  { name: 'Octave',       semitones: 12 },
];

// ── Drill note generation ─────────────────────────────────────────────────────
// Returns { note1, note2 } as MIDI values for the drill measures.
// direction: 'asc' → note1=root, note2=root+semitones
//            'desc' → note1=root+semitones, note2=root
//
// Root is KEY_ROOT[key] shifted by the clef's octaveOffset, then nudged
// into the comfortable mid-range of that clef's voice part.

function getDrillNotes(key, semitones, direction, clef) {
  const clefDef = CLEF_DEFS[clef];
  const root    = KEY_ROOT[key] + clefDef.octaveOffset;
  const upper   = root + semitones;
  if (direction === 'asc') return { note1: root, note2: upper };
  return { note1: upper, note2: root };
}

// Measure 2 tuning phrase: chord (beat 1) shown separately; notes for beats 2-4.
// Returns [note1, note2, note1] — 3 quarter notes following the chord beat.
function getTuningNotes(note1, note2) {
  return [note1, note2, note1];
}

// Tonic chord notes for measure 2 beat 1 (root + major 3rd + perfect 5th).
// Uses the clef-adjusted root so chord sounds in the singer's range.
function getChordNotes(key, clef) {
  const root = KEY_ROOT[key] + CLEF_DEFS[clef].octaveOffset;
  return [root, root + 4, root + 7];
}

// Drill measures 3–4: [note1, note2, note1, note2] as half notes.
function getDrillSequence(note1, note2) {
  return [note1, note2, note1, note2];
}

// ── Shared timing state ───────────────────────────────────────────────────────
// Declared here (loaded first) so scheduler.js can read it safely.
// Updated by state.js when BPM changes.
let beatSec = 60 / 66;  // default 66 BPM
