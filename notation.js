// ── notation.js ───────────────────────────────────────────────────────────────
// VexFlow staff rendering + geometry extraction.
// Owns the canvas element, the ResizeObserver, and the notation bitmap cache.
// Depends on: theory.js (needsAcc, midiToVFKey, VF_KEY, getPhrase)
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

// VexFlow globals (loaded via CDN before this script)
const { Renderer, Stave, StaveNote, Voice, Formatter, Accidental } = Vex.Flow;

const canvas  = document.getElementById('mainCanvas');
const ctx2d   = canvas.getContext('2d');

// geo — staff geometry in logical CSS pixels, extracted from VexFlow after render.
// Always in sync with the canvas because rebuildNotation() is called by
// ResizeObserver on any layout change (zoom, resize, orientation).
//
// geo = {
//   sp       — pixels per staff space (distance between adjacent lines)
//   refY     — Y of bottom staff line = E4 = midi 64
//   topY     — Y of top staff line
//   noteXs[] — X centre of each phrase notehead
//   left     — X of first notehead (curve clip boundary)
//   right    — X of right staff edge (curve clip boundary)
//   phrase   — midi note array for current phrase
// }
let geo    = null;
let noteBmp = null;   // ImageBitmap cache — repainted each frame via drawImage()

let _buildPending = false;

// ── ResizeObserver ────────────────────────────────────────────────────────────
// Fires on ANY layout change: browser zoom, window resize, orientation flip,
// sidebar collapse, font scaling. This is the correct hook — window 'resize'
// misses zoom events in many browsers.
const resizeObs = new ResizeObserver(() => {
  if (_buildPending) return;
  _buildPending = true;
  requestAnimationFrame(() => { _buildPending = false; rebuildNotation(); });
});

function initNotation() {
  resizeObs.observe(canvas.parentElement);
}

// ── rebuildNotation ───────────────────────────────────────────────────────────
// Renders the staff into an OffscreenCanvas at logical pixel size, extracts
// geometry, caches an ImageBitmap. Called on resize and when key/noteCount
// changes. Safe to call repeatedly (idempotent).
//
// curKey and noteCount are read as globals from state.js.
function rebuildNotation() {
  const W   = canvas.parentElement.clientWidth - 24;
  const H   = 280;
  const dpr = window.devicePixelRatio || 1;

  canvas.width        = Math.round(W * dpr);
  canvas.height       = Math.round(H * dpr);
  canvas.style.width  = W + 'px';
  canvas.style.height = H + 'px';

  // Render VexFlow into a temporary DOM canvas at LOGICAL pixel size.
  // We do NOT apply DPR scaling to the VexFlow canvas — we scale it when
  // compositing via drawImage(). This keeps staffGeo in logical pixels,
  // matching the coordinate system used by all drawing in draw.js.
  const tmp    = document.createElement('canvas');
  tmp.width    = W;
  tmp.height   = H;
  const ren    = new Renderer(tmp, Renderer.Backends.CANVAS);
  ren.resize(W, H);
  const vf = ren.getContext();

  vf.save();
  vf.setFillStyle('#FDFAF4');
  vf.fillRect(0, 0, W, H);
  vf.restore();

  const sy    = 56;        // stave top Y
  const mg    = 14;        // left/right margin
  const staveW = W - mg * 2;

  // Single wide stave — full width, no intro measure in the pitch lab
  const stave = new Stave(mg, sy, staveW);
  stave.addClef('treble')
       .addKeySignature(VF_KEY[curKey])
       .addTimeSignature(`${noteCount}/4`);
  stave.setContext(vf).draw();

  // Build phrase notes
  const phrase = getPhrase(curKey, noteCount);
  const sNotes = phrase.map(midi => {
    const sn = new StaveNote({ keys: [midiToVFKey(midi)], duration: 'q', auto_stem: true });
    const a = needsAcc(midi, curKey);
    if (a) sn.addModifier(new Accidental(a), 0);
    return sn;
  });

  const v = new Voice({ num_beats: noteCount, beat_value: 4 }).setMode(Voice.Mode.SOFT);
  v.addTickables(sNotes);
  new Formatter().joinVoices([v]).format([v], staveW - 80);
  v.draw(vf, stave);

  // ── Extract geometry from VexFlow's rendered positions ──────────────────────
  // These are the ACTUAL pixel coordinates — not our calculations.
  // This is why zoom-proofing works: we read from VexFlow after every render.
  const topY  = stave.getYForLine(0);
  const botY  = stave.getYForLine(4);   // bottom staff line = E4 = midi 64
  const sp    = (botY - topY) / 4;      // pixels per staff space

  const noteXs = sNotes.map(sn => {
    const bb = sn.getBoundingBox();
    return bb ? bb.getX() + bb.getW() / 2 : 0;
  });

  geo = {
    sp,
    refY:   botY,
    topY,
    noteXs,
    left:   noteXs[0],
    right:  W - mg,
    phrase,
  };

  // Cache as ImageBitmap — cheap to composite each frame via drawImage()
  createImageBitmap(tmp).then(bmp => {
    noteBmp = bmp;
    drawFrame();   // from draw.js — triggers first paint after build
  });
}
