// ── notation.js ───────────────────────────────────────────────────────────────
// @version 0.2
// VexFlow staff rendering — single canvas, two whole-note drill measures.
// Depends on: theory.js, state.js (curKey, curClef, curInterval)
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const { Renderer, Stave, StaveNote, Voice, Formatter, Accidental } = Vex.Flow;

const canvas = document.getElementById('mainCanvas');
const ctx2d  = canvas.getContext('2d');

// drillGeo — staff geometry in logical CSS pixels, extracted from VexFlow.
// Always in sync — rebuilt by ResizeObserver on any layout/zoom change.
//
// drillGeo = {
//   sp      : pixels per staff space (between adjacent lines)
//   refMidi : MIDI note of bottom staff line (WRITTEN pitch — from CLEF_DEFS)
//   topY    : Y of top staff line
//   refY    : Y of bottom staff line
//   noteXs  : [x0, x1] — X centre of each whole notehead (measure 2, measure 3)
//   left    : left clip boundary
//   right   : right clip boundary
// }
let drillGeo = null;
let noteBmp  = null;
let _buildPending = false;

const resizeObs = new ResizeObserver(() => {
  if (_buildPending) return;
  _buildPending = true;
  requestAnimationFrame(() => { _buildPending = false; rebuildNotation(); });
});

function initNotation() {
  resizeObs.observe(canvas.parentElement);
}

// ── rebuildNotation ────────────────────────────────────────────────────────────
function rebuildNotation() {
  const clefDef  = CLEF_DEFS[curClef];
  const interval = INTERVALS[curInterval];
  const { written1, written2 } = getDrillNotes(curKey, interval.semitones, curClef);

  const W   = canvas.parentElement.clientWidth - 24;
  const H   = 240;
  const dpr = window.devicePixelRatio || 1;

  canvas.width        = Math.round(W * dpr);
  canvas.height       = Math.round(H * dpr);
  canvas.style.width  = W + 'px';
  canvas.style.height = H + 'px';

  // Render VexFlow into a temp canvas at logical pixel size
  const tmp = document.createElement('canvas');
  tmp.width = W; tmp.height = H;
  const ren = new Renderer(tmp, Renderer.Backends.CANVAS);
  ren.resize(W, H);
  const vf = ren.getContext();

  vf.save(); vf.setFillStyle('#FDFAF4'); vf.fillRect(0, 0, W, H); vf.restore();

  const staveY = 52;
  const mg     = 12;
  const totalW = W - mg * 2;
  // Measure 1 gets 42% (has clef + key sig + time sig), measure 2 gets 58%
  const m1W    = Math.round(totalW * 0.42);
  const m2W    = totalW - m1W;
  const m2X    = mg + m1W;

  // ── Measure 1: tonic whole note ──────────────────────────────────────────
  const stave1 = new Stave(mg, staveY, m1W);
  stave1.addClef(clefDef.vfClef)
        .addKeySignature(VF_KEY[curKey])
        .addTimeSignature('4/4');
  stave1.setContext(vf).draw();

  const note1 = new StaveNote({
    keys:     [midiToVFKey(written1)],
    duration: 'w',
  });
  const acc1 = needsAcc(written1, curKey);
  if (acc1) note1.addModifier(new Accidental(acc1), 0);

  const v1 = new Voice({ num_beats: 4, beat_value: 4 }).setMode(Voice.Mode.SOFT);
  v1.addTickables([note1]);
  new Formatter().joinVoices([v1]).format([v1], m1W - 70);
  v1.draw(vf, stave1);

  // ── Measure 2: interval whole note ──────────────────────────────────────
  const stave2 = new Stave(m2X, staveY, m2W - mg);
  stave2.setContext(vf).draw();

  const note2 = new StaveNote({
    keys:     [midiToVFKey(written2)],
    duration: 'w',
  });
  const acc2 = needsAcc(written2, curKey);
  if (acc2) note2.addModifier(new Accidental(acc2), 0);

  const v2 = new Voice({ num_beats: 4, beat_value: 4 }).setMode(Voice.Mode.SOFT);
  v2.addTickables([note2]);
  new Formatter().joinVoices([v2]).format([v2], m2W - mg - 10);
  v2.draw(vf, stave2);

  // Bar line between measures
  const topY = stave2.getYForLine(0);
  const botY = stave2.getYForLine(4);
  vf.save();
  vf.beginPath(); vf.setStrokeStyle('#111'); vf.setLineWidth(1.5);
  vf.moveTo(m2X, topY); vf.lineTo(m2X, botY);
  vf.stroke(); vf.restore();

  // ── Extract geometry — all logical pixels from VexFlow ───────────────────
  const sp = (botY - topY) / 4;

  const getX = (sn, fallback = 0) => {
    const bb = sn.getBoundingBox();
    return bb && Number.isFinite(bb.getX()) && Number.isFinite(bb.getW())
         ? bb.getX() + bb.getW() / 2
         : fallback;
  };

  const noteX1 = getX(note1, mg + 20);
  const noteX2 = getX(note2, m2X + 30);
  const rightX = Math.max(noteX2 + 12, W - mg);

  drillGeo = {
    sp,
    refMidi: clefDef.refMidi,   // WRITTEN pitch at bottom staff line
    topY,
    refY:    botY,
    noteXs:  [noteX1, noteX2],
    left:    Math.max(0, noteX1 - 12),
    right:   rightX,
  };

  const emitBitmap = bmp => { noteBmp = bmp; drawFrame(); };
  if (window.createImageBitmap) {
    createImageBitmap(tmp).then(emitBitmap).catch(() => emitBitmap(tmp));
  } else {
    emitBitmap(tmp);
  }
}
