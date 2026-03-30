// ── notation.js ───────────────────────────────────────────────────────────────
// VexFlow staff rendering — two separate canvases:
//   canvasIntro : measures 1–2  (metronome + tuning reference, static)
//   canvasDrill : measures 3–4  (drill half notes, pitch curve drawn here)
//
// Geometry (staffGeo) extracted from VexFlow after each render.
// ResizeObserver rebuilds both canvases on any layout/zoom change.
// Depends on: theory.js (CLEF_DEFS, VF_KEY, needsAcc, midiToVFKey,
//                        getChordNotes, getTuningNotes, getDrillSequence)
//             state.js  (curKey, curClef, curInterval, curDirection, beatSec)
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const { Renderer, Stave, StaveNote, Voice, Formatter, Accidental, StaveConnector } = Vex.Flow;

const canvasIntro = document.getElementById('canvasIntro');
const canvasDrill = document.getElementById('canvasDrill');
const ctxIntro    = canvasIntro.getContext('2d');
const ctxDrill    = canvasDrill.getContext('2d');

// introGeo — geometry of intro canvas (measures 1–2)
// drillGeo — geometry of drill canvas (measures 3–4) — used by draw.js
// Both are always in logical CSS pixels.
//
// drillGeo = {
//   sp       : pixels per staff space
//   refMidi  : MIDI note at bottom staff line (from CLEF_DEFS)
//   topY     : Y of top staff line
//   refY     : Y of bottom staff line
//   noteXs   : [4 values] X centre of each half-note head across both measures
//              [0] = m3 note1, [1] = m3 note2, [2] = m4 note1, [3] = m4 note2
//   left     : left clip boundary (first notehead X - margin)
//   right    : right clip boundary (last stave right edge)
// }
let introGeo = null;
let drillGeo = null;

// Cached ImageBitmaps — composited each frame by drawFrame()
let introBmp = null;
let drillBmp = null;

let _buildPending = false;

// ── ResizeObserver ─────────────────────────────────────────────────────────────
const resizeObs = new ResizeObserver(() => {
  if (_buildPending) return;
  _buildPending = true;
  requestAnimationFrame(() => { _buildPending = false; rebuildNotation(); });
});

function initNotation() {
  resizeObs.observe(document.getElementById('staffCard'));
}

// ── rebuildNotation ────────────────────────────────────────────────────────────
// Renders both canvases, extracts geometry, caches bitmaps.
// Called on resize, zoom, or whenever key/clef/interval/direction changes.
function rebuildNotation() {
  const clefDef  = CLEF_DEFS[curClef];
  const { note1, note2 } = getDrillNotes(curKey, INTERVALS[curInterval].semitones, curDirection, curClef);
  const chordNotes  = getChordNotes(curKey, curClef);
  const tuningNotes = getTuningNotes(note1, note2);   // [note1, note2, note1]
  const drillSeq    = getDrillSequence(note1, note2); // [note1, note2, note1, note2]

  const cardW  = document.getElementById('staffCard').clientWidth - 28;
  const introH = 170;
  const drillH = 190;
  const dpr    = window.devicePixelRatio || 1;
  const mg     = 12;

  // ── Intro canvas (measures 1–2) ──────────────────────────────────────────
  _sizeCanvas(canvasIntro, cardW, introH, dpr);
  const tmpI  = _makeTmp(cardW, introH);
  const vfI   = _vfCtx(tmpI);
  _fillBg(vfI, cardW, introH);

  const introW     = cardW - mg * 2;
  const m1W        = Math.round(introW * 0.38);
  const m2W        = introW - m1W;
  const m2X        = mg + m1W;
  const introStaveY = 44;

  // Measure 1 — metronome only: treble clef + key sig + time sig, all rests
  const staveM1 = new Stave(mg, introStaveY, m1W);
  staveM1.addClef(clefDef.vfClef)
         .addKeySignature(VF_KEY[curKey])
         .addTimeSignature('4/4');
  staveM1.setContext(vfI).draw();

  // 4 quarter rests
  const rests = [0,1,2,3].map(() => new StaveNote({ keys:['b/4'], duration:'qr' }));
  const vRests = new Voice({ num_beats:4, beat_value:4 }).setMode(Voice.Mode.SOFT);
  vRests.addTickables(rests);
  new Formatter().joinVoices([vRests]).format([vRests], m1W - 60);
  vRests.draw(vfI, staveM1);

  // Measure 2 — chord (beat 1) + tuning notes (beats 2,3,4)
  const staveM2 = new Stave(m2X, introStaveY, m2W - 4);
  staveM2.setContext(vfI).draw();

  const chordNote = new StaveNote({
    keys: chordNotes.map(midiToVFKey),
    duration: 'q', auto_stem: true,
  });
  chordNotes.forEach((m, i) => {
    const a = needsAcc(m, curKey); if (a) chordNote.addModifier(new Accidental(a), i);
  });

  const tuningStaveNotes = tuningNotes.map(midi => {
    const sn = new StaveNote({ keys:[midiToVFKey(midi)], duration:'q', auto_stem:true });
    const a  = needsAcc(midi, curKey); if (a) sn.addModifier(new Accidental(a), 0);
    return sn;
  });

  const vTuning = new Voice({ num_beats:4, beat_value:4 }).setMode(Voice.Mode.SOFT);
  vTuning.addTickables([chordNote, ...tuningStaveNotes]);
  new Formatter().joinVoices([vTuning]).format([vTuning], m2W - 20);
  vTuning.draw(vfI, staveM2);

  // Bar line between m1 and m2
  const iTopY = staveM2.getYForLine(0), iBotY = staveM2.getYForLine(4);
  _barLine(vfI, m2X, iTopY, iBotY);

  introGeo = {
    sp:      (iBotY - iTopY) / 4,
    refMidi: clefDef.refMidi,
    topY:    iTopY,
    refY:    iBotY,
  };

  createImageBitmap(tmpI).then(bmp => { introBmp = bmp; drawFrame(); });

  // ── Drill canvas (measures 3–4) ──────────────────────────────────────────
  _sizeCanvas(canvasDrill, cardW, drillH, dpr);
  const tmpD  = _makeTmp(cardW, drillH);
  const vfD   = _vfCtx(tmpD);
  _fillBg(vfD, cardW, drillH);

  const drillStaveY = 44;
  const halfW       = Math.floor((cardW - mg * 3) / 2);
  const m3X         = mg;
  const m4X         = mg * 2 + halfW;

  // Measure 3
  const staveM3 = new Stave(m3X, drillStaveY, halfW);
  staveM3.addClef(clefDef.vfClef).addKeySignature(VF_KEY[curKey]);
  staveM3.setContext(vfD).draw();

  const m3Notes = [drillSeq[0], drillSeq[1]].map(midi => {
    const sn = new StaveNote({ keys:[midiToVFKey(midi)], duration:'h', auto_stem:true });
    const a = needsAcc(midi, curKey); if (a) sn.addModifier(new Accidental(a), 0);
    return sn;
  });
  const vM3 = new Voice({ num_beats:4, beat_value:4 }).setMode(Voice.Mode.SOFT);
  vM3.addTickables(m3Notes);
  new Formatter().joinVoices([vM3]).format([vM3], halfW - 55);
  vM3.draw(vfD, staveM3);

  // Measure 4
  const staveM4 = new Stave(m4X, drillStaveY, halfW);
  staveM4.setContext(vfD).draw();

  const m4Notes = [drillSeq[2], drillSeq[3]].map(midi => {
    const sn = new StaveNote({ keys:[midiToVFKey(midi)], duration:'h', auto_stem:true });
    const a = needsAcc(midi, curKey); if (a) sn.addModifier(new Accidental(a), 0);
    return sn;
  });
  const vM4 = new Voice({ num_beats:4, beat_value:4 }).setMode(Voice.Mode.SOFT);
  vM4.addTickables(m4Notes);
  new Formatter().joinVoices([vM4]).format([vM4], halfW - 20);
  vM4.draw(vfD, staveM4);

  // Bar line between m3 and m4
  const dTopY = staveM3.getYForLine(0), dBotY = staveM3.getYForLine(4);
  _barLine(vfD, m4X, dTopY, dBotY);

  // Extract drill geometry — 4 notehead X positions across both measures
  const xs = [
    ...m3Notes.map(sn => { const bb=sn.getBoundingBox(); return bb?bb.getX()+bb.getW()/2:0; }),
    ...m4Notes.map(sn => { const bb=sn.getBoundingBox(); return bb?bb.getX()+bb.getW()/2:0; }),
  ];

  drillGeo = {
    sp:      (dBotY - dTopY) / 4,
    refMidi: clefDef.refMidi,
    topY:    dTopY,
    refY:    dBotY,
    noteXs:  xs,
    left:    xs[0] - 8,
    right:   m4X + halfW - 4,
  };

  createImageBitmap(tmpD).then(bmp => { drillBmp = bmp; drawFrame(); });
}

// ── Canvas helpers ────────────────────────────────────────────────────────────
function _sizeCanvas(cv, W, H, dpr) {
  cv.width        = Math.round(W * dpr);
  cv.height       = Math.round(H * dpr);
  cv.style.width  = W + 'px';
  cv.style.height = H + 'px';
}
function _makeTmp(W, H) {
  const t = document.createElement('canvas');
  t.width=W; t.height=H; return t;
}
function _vfCtx(tmp) {
  const r = new Renderer(tmp, Renderer.Backends.CANVAS);
  r.resize(tmp.width, tmp.height);
  return r.getContext();
}
function _fillBg(ctx, W, H) {
  ctx.save(); ctx.setFillStyle('#FDFAF4'); ctx.fillRect(0,0,W,H); ctx.restore();
}
function _barLine(ctx, x, topY, botY) {
  ctx.save(); ctx.beginPath();
  ctx.setStrokeStyle('#111'); ctx.setLineWidth(1.5);
  ctx.moveTo(x, topY); ctx.lineTo(x, botY); ctx.stroke(); ctx.restore();
}
