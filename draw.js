// ── draw.js ───────────────────────────────────────────────────────────────────
// Canvas drawing: frame compositing, pitch curve rendering, coordinate mapping.
// Depends on: notation.js (canvas, ctx2d, geo, noteBmp)
//             yin.js      (STRATEGIES, GAP)
//             scheduler.js (beatAudioTimes, schedulerGetLoopCount)
//             state.js     (beatSec, noteCount, singing, actx)
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

// ── Coordinate mapping ────────────────────────────────────────────────────────

// midi float → canvas Y (chromatic, continuous)
// E4 = midi 64 = geo.refY (bottom staff line)
// 1 semitone = geo.sp * 7/12
// The 7/12 factor comes from: 7 diatonic steps per octave / 12 chromatic steps.
// This maps chromatic semitones to the same physical distance as diatonic staff
// steps, so the curve floats between staff lines correctly for sharps/flats.
function midiToY(mf) {
  if (!geo) return 0;
  return geo.refY - (mf - 64) * geo.sp * (7 / 12);
}

// audio timestamp + globalPhraseIndex → canvas X
// Uses beatAudioTimes[globalPi] to find the beat interval, then interpolates
// linearly between the X positions of the two surrounding noteheads.
// Storing gpi with each pitch point means the mapping is always correct even
// across loop boundaries (where the same local beat index recurs).
function pitchTimeToX(t, gpi) {
  if (!geo || beatAudioTimes[gpi] === undefined) return null;
  const t0  = beatAudioTimes[gpi];
  const t1  = beatAudioTimes[gpi + 1] !== undefined ? beatAudioTimes[gpi + 1] : t0 + beatSec;
  const li  = gpi % noteCount;
  const x0  = geo.noteXs[li];
  const x1  = li + 1 < geo.noteXs.length ? geo.noteXs[li + 1] : geo.right;
  return x0 + (x1 - x0) * Math.min(1, (t - t0) / (t1 - t0));
}

// Loop progress 0..1 — used by the progress bar
function getLoopProgress() {
  if (!actx || !singing || !beatAudioTimes.length) return 0;
  const now  = actx.currentTime;
  const base = schedulerGetLoopCount() * noteCount;
  const t0   = beatAudioTimes[base];
  if (t0 === undefined) return 0;
  const tLast = beatAudioTimes[base + noteCount - 1];
  if (tLast === undefined) return 0;
  return Math.min(1, Math.max(0, (now - t0) / ((tLast + beatSec) - t0)));
}

// ── Main draw function ────────────────────────────────────────────────────────
function drawFrame() {
  if (!noteBmp) return;
  const dpr = window.devicePixelRatio || 1;
  const W   = canvas.width  / dpr;
  const H   = canvas.height / dpr;

  ctx2d.save();
  ctx2d.scale(dpr, dpr);
  ctx2d.clearRect(0, 0, W, H);

  // 1. Notation bitmap (cached from VexFlow render — zero VexFlow cost per frame)
  ctx2d.drawImage(noteBmp, 0, 0, W, H);

  if (geo) {
    // Clip curves to the stave note area only — no bleed into margins
    ctx2d.save();
    ctx2d.beginPath();
    ctx2d.rect(geo.left - 8, 0, geo.right - geo.left + 16, H);
    ctx2d.clip();

    // 2. Draw each enabled strategy's curve
    STRATEGIES.forEach(s => {
      if (!s.enabled) return;
      if (s.drawFn === 'bezier') drawBezier(s.buf, s.color, 0.86, 2.0);
      else                       drawCatmull(s.buf, s.color, 0.86, 2.0);

      // Leading dot at the tip of the live curve
      if (s.buf.length < 1) return;
      const last = s.buf[s.buf.length - 1];
      if (last.gap) return;
      const lx = pitchTimeToX(last.t, last.gpi);
      const ly = midiToY(last.midi);
      if (lx === null) return;
      ctx2d.fillStyle = hexAlpha(s.color, 0.92);
      ctx2d.beginPath();
      ctx2d.arc(lx, ly, 2.8, 0, Math.PI * 2);
      ctx2d.fill();
    });

    ctx2d.restore();
  }

  ctx2d.restore();

  // 3. Update progress bar (outside canvas — DOM element)
  document.getElementById('loopBar').style.width = (getLoopProgress() * 100) + '%';
}

// ── Catmull-Rom spline ────────────────────────────────────────────────────────
// Used by strategies A B C D F G.
// Renders a smooth cubic spline through pitch buffer points.
// GAP sentinels lift the pen (ctx.stroke() + beginPath()) — no interpolation
// across silence. Neighbours for the Catmull-Rom control points are found by
// scanning past any gap sentinels, so the curve doesn't kink at segment edges.
//
// Why Catmull-Rom and not simple lineTo?
//   lineTo creates a jagged polyline. Catmull-Rom passes through each point
//   while computing smooth tangents from neighbours — the resulting curve has
//   C1 continuity (matching tangents at every data point), which produces the
//   "sexy continuous line" quality we're after.
//
// Why not cubic Bézier with manual control points?
//   Control point placement is non-trivial to automate. Catmull-Rom gives us
//   automatic smooth control points for free.

function drawCatmull(pts, color, alpha, lw) {
  if (pts.length < 2) return;
  ctx2d.strokeStyle = hexAlpha(color, alpha);
  ctx2d.lineWidth   = lw;
  ctx2d.lineJoin    = 'round';
  ctx2d.lineCap     = 'round';

  let started = false;
  ctx2d.beginPath();

  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];

    // Gap sentinel — lift pen
    if (p.gap) {
      if (started) { ctx2d.stroke(); ctx2d.beginPath(); started = false; }
      continue;
    }

    const x = pitchTimeToX(p.t, p.gpi);
    if (x === null) {
      if (started) { ctx2d.stroke(); ctx2d.beginPath(); started = false; }
      continue;
    }
    const y = midiToY(p.midi);

    if (!started) { ctx2d.moveTo(x, y); started = true; continue; }

    // Find valid neighbours, skipping gaps
    const prev  = _neighbour(pts, i, -1, 1);
    const next  = _neighbour(pts, i,  1, 1);
    const next2 = _neighbour(pts, i,  1, 2);

    const p0 = prev  || { x, y };
    const p1 = { x, y };
    const p2 = next  || { x, y };
    const p3 = next2 || p2;

    ctx2d.bezierCurveTo(
      p1.x + (p2.x - p0.x) / 6,  p1.y + (p2.y - p0.y) / 6,
      p2.x - (p3.x - p1.x) / 6,  p2.y - (p3.y - p1.y) / 6,
      p2.x, p2.y
    );
  }
  if (started) ctx2d.stroke();
}

// Helper: find the Nth valid (non-gap, non-null-x) neighbour in direction dir
function _neighbour(pts, i, dir, n) {
  let found = 0;
  for (let j = i + dir; j >= 0 && j < pts.length; j += dir) {
    if (pts[j].gap) return null;
    const px = pitchTimeToX(pts[j].t, pts[j].gpi);
    if (px === null) return null;
    found++;
    if (found === n) return { x: px, y: midiToY(pts[j].midi) };
  }
  return null;
}

// ── Quadratic Bézier midpoint ─────────────────────────────────────────────────
// Used by strategy E (AI friend's method).
// Splits at GAP sentinels then draws each continuous segment as a series of
// quadratic Bézier curves through midpoints of adjacent data points.
// This is a simpler smoothing than Catmull-Rom: control points are the raw
// data points, anchor points are midpoints. The result tends to round corners
// more aggressively — good for a "calligraphic" look.

function drawBezier(pts, color, alpha, lw) {
  // Collect continuous segments (split at gaps)
  const segs = [];
  let seg = [];
  for (const p of pts) {
    if (p.gap) {
      if (seg.length > 1) segs.push(seg);
      seg = [];
      continue;
    }
    const x = pitchTimeToX(p.t, p.gpi);
    if (x === null) {
      if (seg.length > 1) segs.push(seg);
      seg = [];
      continue;
    }
    seg.push({ x, y: midiToY(p.midi) });
  }
  if (seg.length > 1) segs.push(seg);

  ctx2d.strokeStyle = hexAlpha(color, alpha);
  ctx2d.lineWidth   = lw;
  ctx2d.lineJoin    = 'round';
  ctx2d.lineCap     = 'round';

  for (const s of segs) {
    if (s.length < 2) continue;
    ctx2d.beginPath();
    ctx2d.moveTo(s[0].x, s[0].y);
    for (let i = 1; i < s.length - 1; i++) {
      const mx = (s[i].x + s[i + 1].x) / 2;
      const my = (s[i].y + s[i + 1].y) / 2;
      ctx2d.quadraticCurveTo(s[i].x, s[i].y, mx, my);
    }
    ctx2d.lineTo(s[s.length - 1].x, s[s.length - 1].y);
    ctx2d.stroke();
  }
}

// ── Utility ───────────────────────────────────────────────────────────────────
function hexAlpha(hex, a) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}
