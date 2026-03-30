// ── draw.js ───────────────────────────────────────────────────────────────────
// @version 0.2
// Canvas drawing: composites notation bitmap, renders pitch curve.
// Depends on: notation.js (canvas, ctx2d, drillGeo, noteBmp)
//             yin.js      (pitchState, GAP)
//             scheduler.js (beatAudioTimes, DRILL_START)
//             theory.js   (beatSec, CLEF_DEFS, curClef)
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

// ── Coordinate mapping ────────────────────────────────────────────────────────

// midi float (WRITTEN pitch) → canvas Y
// For G8vb: the caller passes the WRITTEN midi (sounding + 12), so the curve
// sits exactly where the notehead is, regardless of clef transposition.
// refMidi is the WRITTEN pitch at the bottom staff line (from CLEF_DEFS).
// 1 semitone = sp * 7/12 (chromatic continuous mapping).
function midiToY(writtenMidi) {
  if (!drillGeo) return 0;
  return drillGeo.refY - (writtenMidi - drillGeo.refMidi) * drillGeo.sp * (7 / 12);
}

// audio timestamp + globalPi → canvas X
// Two whole notes: beats 4–7 map to noteXs[0], beats 8–11 map to noteXs[1].
// X interpolates smoothly from the notehead centre toward the next position.
function pitchTimeToX(t, gpi) {
  if (!drillGeo || beatAudioTimes[gpi] === undefined) return null;
  const local = gpi - DRILL_START;   // 0–7
  if (local < 0) return null;

  // Which whole-note slot (0 or 1)?
  const slot = local < 4 ? 0 : 1;

  // Time boundaries of this whole note (4 beats wide)
  const beatOfSlotStart = DRILL_START + slot * 4;
  const t0 = beatAudioTimes[beatOfSlotStart];
  const t1 = beatAudioTimes[beatOfSlotStart + 4] !== undefined
               ? beatAudioTimes[beatOfSlotStart + 4]
               : t0 + beatSec * 4;
  if (t0 === undefined) return null;

  const x0 = drillGeo.noteXs[slot];
  const x1 = drillGeo.noteXs[slot + 1] !== undefined
               ? drillGeo.noteXs[slot + 1]
               : drillGeo.right;

  return x0 + (x1 - x0) * Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));
}

// ── Main draw ──────────────────────────────────────────────────────────────────
function drawFrame() {
  if (!noteBmp) return;
  const dpr = window.devicePixelRatio || 1;
  const W   = canvas.width  / dpr;
  const H   = canvas.height / dpr;

  ctx2d.save();
  ctx2d.scale(dpr, dpr);
  ctx2d.clearRect(0, 0, W, H);
  ctx2d.drawImage(noteBmp, 0, 0, W, H);

  if (drillGeo && pitchState.buf.length > 1) {
    ctx2d.save();
    ctx2d.beginPath();
    ctx2d.rect(drillGeo.left, 0, drillGeo.right - drillGeo.left, H);
    ctx2d.clip();

    _drawCatmull(pitchState.buf);

    // Leading dot
    const last = pitchState.buf[pitchState.buf.length - 1];
    if (!last.gap) {
      const clefDef    = CLEF_DEFS[curClef];
      const writtenMidi = last.midi + clefDef.transposeForNotation;
      const lx = pitchTimeToX(last.t, last.gpi);
      const ly = midiToY(writtenMidi);
      if (lx !== null) {
        ctx2d.fillStyle   = '#1d6fa4';
        ctx2d.shadowColor = '#1d6fa4';
        ctx2d.shadowBlur  = 8;
        ctx2d.beginPath();
        ctx2d.arc(lx, ly, 3, 0, Math.PI * 2);
        ctx2d.fill();
        ctx2d.shadowBlur = 0;
      }
    }

    ctx2d.restore();
  }

  ctx2d.restore();
}

// ── Catmull-Rom spline ─────────────────────────────────────────────────────────
// GAP sentinels lift the pen — no interpolation across silence.
// Pitch buffer entries store SOUNDING midi — we add transposeForNotation
// when computing Y so the curve aligns with the written noteheads.
function _drawCatmull(pts) {
  if (pts.length < 2) return;
  const clefDef = CLEF_DEFS[curClef];

  ctx2d.strokeStyle = 'rgba(29,111,164,0.88)';
  ctx2d.lineWidth   = 2.2;
  ctx2d.lineJoin    = 'round';
  ctx2d.lineCap     = 'round';

  let started = false;
  ctx2d.beginPath();

  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (p.gap) {
      if (started) { ctx2d.stroke(); ctx2d.beginPath(); started = false; }
      continue;
    }
    const x = pitchTimeToX(p.t, p.gpi);
    if (x === null) {
      if (started) { ctx2d.stroke(); ctx2d.beginPath(); started = false; }
      continue;
    }
    // Convert sounding → written for Y alignment
    const y = midiToY(p.midi + clefDef.transposeForNotation);

    if (!started) { ctx2d.moveTo(x, y); started = true; continue; }

    const p0 = _nb(pts, i, -1, 1, clefDef);
    const p1 = { x, y };
    const p2 = _nb(pts, i,  1, 1, clefDef) || { x, y };
    const p3 = _nb(pts, i,  1, 2, clefDef) || p2;
    const pp0 = p0 || { x, y };

    ctx2d.bezierCurveTo(
      p1.x + (p2.x - pp0.x) / 6,  p1.y + (p2.y - pp0.y) / 6,
      p2.x - (p3.x - p1.x)  / 6,  p2.y - (p3.y - p1.y)  / 6,
      p2.x, p2.y
    );
  }
  if (started) ctx2d.stroke();
}

function _nb(pts, i, dir, n, clefDef) {
  let found = 0;
  for (let j = i + dir; j >= 0 && j < pts.length; j += dir) {
    if (pts[j].gap) return null;
    const px = pitchTimeToX(pts[j].t, pts[j].gpi);
    if (px === null) return null;
    found++;
    if (found === n) {
      return {
        x: px,
        y: midiToY(pts[j].midi + clefDef.transposeForNotation),
      };
    }
  }
  return null;
}
