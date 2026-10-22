// ── theory.js ─────────────────────────────────────────────────────────────────
// MIDI math and interval data. Pure functions only — no audio, no DOM.
// ─────────────────────────────────────────────────────────────────────────────

export const NOTE_NAMES = ['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];

// Index = semitones (1–12). Short labels are drawn on the clock.
export const INTERVALS = [
  { short: 'Root', name: 'Unison',      semitones: 0  },
  { short: 'm2',   name: 'Minor 2nd',   semitones: 1  },
  { short: 'M2',   name: 'Major 2nd',   semitones: 2  },
  { short: 'm3',   name: 'Minor 3rd',   semitones: 3  },
  { short: 'M3',   name: 'Major 3rd',   semitones: 4  },
  { short: 'P4',   name: 'Perfect 4th', semitones: 5  },
  { short: 'TT',   name: 'Tritone',     semitones: 6  },
  { short: 'P5',   name: 'Perfect 5th', semitones: 7  },
  { short: 'm6',   name: 'Minor 6th',   semitones: 8  },
  { short: 'M6',   name: 'Major 6th',   semitones: 9  },
  { short: 'm7',   name: 'Minor 7th',   semitones: 10 },
  { short: 'M7',   name: 'Major 7th',   semitones: 11 },
  { short: '8va',  name: 'Octave',      semitones: 12 },
];

export const hz2midi = hz => 69 + 12 * Math.log2(hz / 440);
export const midi2hz = m  => 440 * Math.pow(2, (m - 69) / 12);
export const mpc     = m  => ((m % 12) + 12) % 12;
export const moct    = m  => Math.floor(m / 12) - 1;

export const noteName = m => NOTE_NAMES[mpc(m)] + moct(m);
