// ── theory.js ────────────────────────────────────────────────────────────────
// Music theory helpers: MIDI math, key data, phrase generation.
// No audio, no DOM, no drawing. Pure functions only.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const NOTE_NAMES = ['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];

const hz2midi = hz => 69 + 12 * Math.log2(hz / 440);
const midi2hz = m  => 440 * Math.pow(2, (m - 69) / 12);
const mpc     = m  => ((m % 12) + 12) % 12;   // pitch class 0-11
const moct    = m  => Math.floor(m / 12) - 1;  // scientific octave

// Key root MIDI notes (middle octave, comfortable singing range)
const KEY_ROOT = { C:60, G:67, D:62, A:69, F:65, Bb:70 };

// VexFlow key signature strings
const VF_KEY = { C:'C', G:'G', D:'D', A:'A', F:'F', Bb:'Bb' };

// Pitch classes altered by each key signature
const KEY_PCS = {
  C:  [],
  G:  [6],
  D:  [6, 1],
  A:  [6, 1, 8],
  F:  [10],
  Bb: [10, 3],
};

// Returns '#' or 'b' if this midi note needs an explicit accidental
// in the given key, or null if the key sig covers it.
function needsAcc(midi, key) {
  const p = mpc(midi);
  if (![1, 3, 6, 8, 10].includes(p)) return null;
  if (KEY_PCS[key].includes(p))       return null;
  return [1, 3, 8].includes(p) ? '#' : 'b';
}

// VexFlow pitch key string e.g. "g#/4"
function midiToVFKey(midi) {
  const n = ['c','c','d','d','e','f','f','g','g','a','a','b'];
  const a = ['', '#', '', '#', '', '', '#', '', '#', '', '#', ''];
  return `${n[mpc(midi)]}${a[mpc(midi)]}/${moct(midi)}`;
}

// Phrase offset pools by note count
const PHRASE_POOLS = {
  2: [0, 7],
  4: [0, 4, 7, 12],
  8: [0, 2, 4, 5, 7, 5, 4, 2],
};

function getPhrase(key, noteCount) {
  const r = KEY_ROOT[key];
  const offsets = PHRASE_POOLS[noteCount] || PHRASE_POOLS[4];
  return offsets.map(o => r + o);
}
