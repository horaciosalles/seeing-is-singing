// ── draw.js ───────────────────────────────────────────────────────────────────
// Canvas drawing: composites notation bitmaps, renders pitch curve on drill canvas.
// Depends on: notation.js (canvasIntro, canvasDrill, ctxIntro, ctxDrill,
//                          introBmp, drillBmp, introGeo, drillGeo)
//             yin.js      (STRATEGIES, GAP, activeStrategy)
//             scheduler.js (beatAudioTimes, DRILL_START)
//             state.js    (beatSec, noteCount=4, singing, actx)
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

// ── Coordinate mapping ────────────────────────────────────────────────────────

// midi float → canvas Y on the drill canvas.
// Uses drillGeo.refMidi (clef-aware bottom staff line) instead of hardcoded 64.
// 1 semitone = sp * 7/12 (chromatic, continuous — see notation.js comments).
function midiToY(mf) {
  if (!drillGeo) return 0;
  return drillGeo.refY - (mf - drillGeo.refMidi) * drillGeo.sp * (7 / 12);
}

// audio timestamp + globalPhraseIndex → canvas X on the drill canvas.
// Drill beats are global indices 8–15. We offset by DRILL_START (8) to get
// a local index 0–7, then map pairs of beats to the 4 half-note positions:
//   local 0,1 → drillGeo.noteXs[0]  (measure 3, note 1)
//   local 2,3 → drillGeo.noteXs[1]  (measure 3, note 2)
//   local 4,5 → drillGeo.noteXs[2]  (measure 4, note 1)
//   local 6,7 → drillGeo.noteXs[3]  (measure 4, note 2)
function pitchTimeToX(t, gpi) {
  if (!drillGeo || !beatAudioTimes[gpi]) return null;
  const local = gpi - DRILL_START;       // 0–7
  if (local < 0) return null;

  const noteIdx = Math.floor(local / 2); // 0–3 (which half-note slot)
  const t0      = beatAudioTimes[gpi];
  const t1      = beatAudioTimes[gpi + 1] !== undefined
                    ? beatAudioTimes[gpi + 1]
                    : t0 + beatSec;

  const x0 = drillGeo.noteXs[noteIdx];
  const x1 = drillGeo.noteXs[noteIdx + 1] !== undefined
                ? drillGeo.noteXs[noteIdx + 1]
                : drillGeo.right;

  return x0 + (x1 - x0) * Math.min(1, (t - t0) / (t1 - t0));
}

// ── Main draw function ─────────────────────────────────────────────────────────
function drawFrame() {
  const dpr = window.devicePixelRatio || 1;

  // ── Intro canvas (static notation, no curves) ────────────────────────────
  if (introBmp && canvasIntro) {
    const W = canvasIntro.width / dpr, H = canvasIntro.height / dpr;
    ctxIntro.save(); ctxIntro.scale(dpr, dpr);
    ctxIntro.clearRect(0,0,W,H);
    ctxIntro.drawImage(introBmp, 0, 0, W, H);
    ctxIntro.restore();
  }

  // ── Drill canvas (notation + live pitch curve) ────────────────────────────
  if (!drillBmp || !canvasDrill) return;
  const W = canvasDrill.width / dpr, H = canvasDrill.height / dpr;

  ctxDrill.save(); ctxDrill.scale(dpr, dpr);
  ctxDrill.clearRect(0,0,W,H);
  ctxDrill.drawImage(drillBmp, 0, 0, W, H);

  if (drillGeo) {
    // Clip curve to note area
    ctxDrill.save();
    ctxDrill.beginPath();
    ctxDrill.rect(drillGeo.left, 0, drillGeo.right - drillGeo.left, H);
    ctxDrill.clip();

    const s = STRATEGIES[activeStrategy];
    if (s && s.buf.length > 1) {
      drawCatmull(ctxDrill, s.buf, s.color, 0.88, 2.2);

      // Leading dot
      const last = s.buf[s.buf.length - 1];
      if (!last.gap) {
        const lx = pitchTimeToX(last.t, last.gpi);
        const ly = midiToY(last.midi);
        if (lx !== null) {
          ctxDrill.fillStyle   = s.color;
          ctxDrill.shadowColor = s.color;
          ctxDrill.shadowBlur  = 8;
          ctxDrill.beginPath();
          ctxDrill.arc(lx, ly, 3, 0, Math.PI*2);
          ctxDrill.fill();
          ctxDrill.shadowBlur = 0;
        }
      }
    }

    ctxDrill.restore();
  }

  ctxDrill.restore();
}

// ── Catmull-Rom spline ─────────────────────────────────────────────────────────
// GAP sentinels lift the pen — no interpolation across silence.
// Neighbours for control points are found by scanning past sentinels.
function drawCatmull(ctx, pts, color, alpha, lw) {
  if (pts.length < 2) return;
  ctx.strokeStyle = _hexAlpha(color, alpha);
  ctx.lineWidth   = lw;
  ctx.lineJoin    = 'round';
  ctx.lineCap     = 'round';

  let started = false;
  ctx.beginPath();

  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (p.gap) {
      if (started) { ctx.stroke(); ctx.beginPath(); started = false; }
      continue;
    }
    const x = pitchTimeToX(p.t, p.gpi);
    if (x === null) {
      if (started) { ctx.stroke(); ctx.beginPath(); started = false; }
      continue;
    }
    const y = midiToY(p.midi);
    if (!started) { ctx.moveTo(x, y); started = true; continue; }

    const prev  = _nb(pts, i, -1, 1);
    const next  = _nb(pts, i,  1, 1);
    const next2 = _nb(pts, i,  1, 2);
    const p0 = prev  || { x, y };
    const p1 = { x, y };
    const p2 = next  || { x, y };
    const p3 = next2 || p2;

    ctx.bezierCurveTo(
      p1.x + (p2.x-p0.x)/6,  p1.y + (p2.y-p0.y)/6,
      p2.x - (p3.x-p1.x)/6,  p2.y - (p3.y-p1.y)/6,
      p2.x, p2.y
    );
  }
  if (started) ctx.stroke();
}

function _nb(pts, i, dir, n) {
  let found = 0;
  for (let j = i+dir; j >= 0 && j < pts.length; j += dir) {
    if (pts[j].gap) return null;
    const px = pitchTimeToX(pts[j].t, pts[j].gpi);
    if (px === null) return null;
    found++;
    if (found === n) return { x: px, y: midiToY(pts[j].midi) };
  }
  return null;
}

function _hexAlpha(hex, a) {
  const r=parseInt(hex.slice(1,3),16), g=parseInt(hex.slice(3,5),16), b=parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${a})`;
}
