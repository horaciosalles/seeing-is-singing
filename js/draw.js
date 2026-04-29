// ── draw.js ───────────────────────────────────────────────────────────────────
// @version 0.4
// Clock renderer. 12-semitone circular interface.
// Root at 12:00. Ascending intervals clockwise, 30° per semitone.
// Smooth hand via EMA on top of yin.js's already-smoothed pitch.
//
// Depends on: yin.js (pitchState), theory.js (KEY_ROOT, INTERVALS)
//             state.js globals: curKey, curInterval (read at call time)
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

// ── Chromatic color palette (one hue per semitone, 30° steps) ────────────────
// Arranged so colors travel the full visible spectrum around the clock face.
const SEMITONE_COLORS = [
  '#ff6b6b', // 0  Root  — coral red
  '#ff8e42', // 1  m2    — orange
  '#ffd166', // 2  M2    — golden yellow
  '#b5e655', // 3  m3    — lime
  '#5ee87a', // 4  M3    — mint green
  '#2dd4bf', // 5  P4    — teal
  '#22d3ee', // 6  TT    — cyan
  '#4ea8ff', // 7  P5    — sky blue
  '#818cf8', // 8  m6    — indigo
  '#a78bfa', // 9  M6    — violet
  '#d16ef8', // 10 m7    — purple
  '#f472b6', // 11 M7    — pink-magenta
];

// Clock face labels (position 0 = Root at 12:00, then clockwise)
const CLOCK_LABELS = ['Root','m2','M2','m3','M3','P4','TT','P5','m6','M6','m7','M7'];

// ── Canvas state ──────────────────────────────────────────────────────────────
let _canvas = null;
let _ctx    = null;

// ── Animation state ───────────────────────────────────────────────────────────
// _displayAngle: smoothed clock-hand angle in degrees (0 = 12:00, + = clockwise).
// Separate EMA on top of yin.js's own pitch smoothing → silky motion.
let _displayAngle = 0;

// ── Public API ────────────────────────────────────────────────────────────────

function initClock() {
  _canvas = document.getElementById('clockCanvas');
  if (!_canvas) return;
  _ctx = _canvas.getContext('2d');
  _resize();
  new ResizeObserver(_resize).observe(_canvas.parentElement);
}

// Call at the start of each new drill to snap hand back to 12:00.
function resetClockAngle() {
  _displayAngle = 0;
}

// Main draw entry point — called from state.js RAF loop and on static redraws.
// targetSemitones: the interval (in semitones) currently being targeted.
// state: 'READY' | 'METRO' | 'SINGING' | 'REVIEW'
function drawClockFrame({ state, targetSemitones }) {
  if (!_canvas || !_ctx) return;
  _updateAngle(state);
  _render(state, targetSemitones);
}

// ── Private helpers ───────────────────────────────────────────────────────────

function _resize() {
  const dpr  = window.devicePixelRatio || 1;
  const wrap = _canvas.parentElement;
  const size = Math.min(wrap.clientWidth, 460);
  _canvas.style.width  = size + 'px';
  _canvas.style.height = size + 'px';
  _canvas.width  = Math.round(size * dpr);
  _canvas.height = Math.round(size * dpr);
}

// Returns the latest smoothed MIDI from the pitch buffer, or null if silent.
function _latestMidi() {
  const buf = pitchState.buf;
  for (let i = buf.length - 1; i >= 0; i--) {
    if (!buf[i].gap) return buf[i].midi;
  }
  return null;
}

// EMA-smooth _displayAngle toward the pitch-derived target angle.
// α = 0.15 → ~100 ms additional lag on top of yin.js's ~200 ms = ~300 ms total.
// This makes the hand feel physically weighted without being sluggish.
function _updateAngle(state) {
  if (state === 'SINGING') {
    const midi = _latestMidi();
    if (midi !== null) {
      const raw = (midi - KEY_ROOT[curKey]) * 30; // degrees, + = clockwise
      _displayAngle += (raw - _displayAngle) * 0.15;
      return;
    }
    // Silence during SINGING — hold position (hand stays, no drift)
    return;
  }
  if (state === 'METRO') {
    // Gently drift to 12:00 during count-in
    _displayAngle += (0 - _displayAngle) * 0.06;
  }
  // READY / REVIEW: no update (static display)
}

// ── Main rendering ────────────────────────────────────────────────────────────
function _render(state, targetSemitones) {
  const dpr = window.devicePixelRatio || 1;
  const W   = _canvas.width  / dpr;
  const H   = _canvas.height / dpr;
  const cx  = W / 2;
  const cy  = H / 2;
  const R   = Math.min(W, H) / 2 * 0.91;

  const ctx = _ctx;
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  // 1. Clock face ──────────────────────────────────────────────────────────────
  const faceGrad = ctx.createRadialGradient(cx, cy - R * 0.12, R * 0.08, cx, cy, R);
  faceGrad.addColorStop(0, '#22203e');
  faceGrad.addColorStop(1, '#0d0c1e');
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.fillStyle = faceGrad;
  ctx.fill();

  // Outer rim line
  ctx.strokeStyle = 'rgba(167,139,250,0.18)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // 2. Colored arc segments (outer ring) ───────────────────────────────────────
  const segOuter = R * 0.975;
  const segInner = R * 0.770;
  const arcGap   = 0.022; // radians gap between segments

  for (let i = 0; i < 12; i++) {
    const a0 = (i / 12) * Math.PI * 2 - Math.PI / 2 + arcGap;
    const a1 = ((i + 1) / 12) * Math.PI * 2 - Math.PI / 2 - arcGap;
    ctx.beginPath();
    ctx.arc(cx, cy, segOuter, a0, a1);
    ctx.arc(cx, cy, segInner, a1, a0, true);
    ctx.closePath();
    ctx.fillStyle = SEMITONE_COLORS[i] + '28'; // ~16 % opacity base
    ctx.fill();
  }

  // 3. Target segment (glowing) ────────────────────────────────────────────────
  const tIdx = ((Math.round(targetSemitones) % 12) + 12) % 12;
  {
    const a0 = (tIdx / 12) * Math.PI * 2 - Math.PI / 2 + arcGap;
    const a1 = ((tIdx + 1) / 12) * Math.PI * 2 - Math.PI / 2 - arcGap;
    ctx.save();
    ctx.shadowColor = SEMITONE_COLORS[tIdx];
    ctx.shadowBlur  = 24;
    ctx.beginPath();
    ctx.arc(cx, cy, segOuter, a0, a1);
    ctx.arc(cx, cy, segInner, a1, a0, true);
    ctx.closePath();
    ctx.fillStyle = SEMITONE_COLORS[tIdx] + 'cc'; // ~80 % opacity
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.restore();
  }

  // 4. Tick marks and interval labels ──────────────────────────────────────────
  for (let i = 0; i < 12; i++) {
    const angle  = (i / 12) * Math.PI * 2 - Math.PI / 2;
    const isRoot = i === 0;
    const isTgt  = i === tIdx;

    // Tick line
    const tOuter = R * 0.750;
    const tInner = isRoot ? R * 0.625 : R * 0.690;
    ctx.beginPath();
    ctx.moveTo(cx + tInner * Math.cos(angle), cy + tInner * Math.sin(angle));
    ctx.lineTo(cx + tOuter * Math.cos(angle), cy + tOuter * Math.sin(angle));
    ctx.strokeStyle = isRoot ? 'rgba(255,255,255,0.90)'
                   : isTgt  ? SEMITONE_COLORS[tIdx]
                   :           'rgba(255,255,255,0.20)';
    ctx.lineWidth = isRoot ? 2.5 : isTgt ? 2.0 : 1.0;
    ctx.stroke();

    // Label
    const lR = R * 0.600;
    const lx = cx + lR * Math.cos(angle);
    const ly = cy + lR * Math.sin(angle);

    ctx.font = isRoot
      ? `700 ${(R * 0.078).toFixed(1)}px 'IBM Plex Mono',monospace`
      :        `${(R * 0.065).toFixed(1)}px 'IBM Plex Mono',monospace`;
    ctx.fillStyle   = isRoot ? 'rgba(255,255,255,0.95)'
                   : isTgt  ? SEMITONE_COLORS[tIdx]
                   :           'rgba(180,170,215,0.48)';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(CLOCK_LABELS[i], lx, ly);
  }

  // 5. Inner vignette (blends label ring into dark face) ──────────────────────
  const vigGrad = ctx.createRadialGradient(cx, cy, R * 0.36, cx, cy, R * 0.58);
  vigGrad.addColorStop(0, 'rgba(13,12,30,0)');
  vigGrad.addColorStop(1, 'rgba(13,12,30,0.70)');
  ctx.beginPath();
  ctx.arc(cx, cy, R * 0.58, 0, Math.PI * 2);
  ctx.fillStyle = vigGrad;
  ctx.fill();

  // 6. Clock hand ──────────────────────────────────────────────────────────────
  const handAngle = _displayAngle * Math.PI / 180 - Math.PI / 2;
  const handLen   = R * 0.670;
  const hTipX    = cx + handLen * Math.cos(handAngle);
  const hTipY    = cy + handLen * Math.sin(handAngle);

  // Color the tip gem by the semitone position the hand is pointing at
  let hSemi = Math.round(_displayAngle / 30) % 12;
  if (hSemi < 0) hSemi += 12;
  const hColor = SEMITONE_COLORS[hSemi];

  ctx.save();
  ctx.shadowColor = hColor;
  ctx.shadowBlur  = state === 'SINGING' ? 26 : 12;

  // Tapered hand body (wider at pivot, narrows to tip)
  const perp = handAngle + Math.PI / 2;
  const bw   = R * 0.016;
  ctx.beginPath();
  ctx.moveTo(cx + bw * Math.cos(perp), cy + bw * Math.sin(perp));
  ctx.lineTo(hTipX, hTipY);
  ctx.lineTo(cx - bw * Math.cos(perp), cy - bw * Math.sin(perp));
  ctx.closePath();
  ctx.fillStyle = 'rgba(255,255,255,0.96)';
  ctx.fill();

  // Tip gem (colored circle)
  ctx.beginPath();
  ctx.arc(hTipX, hTipY, R * 0.030, 0, Math.PI * 2);
  ctx.fillStyle  = hColor;
  ctx.shadowBlur = 30;
  ctx.fill();
  ctx.restore();

  // Counter-weight nub at opposite end of hand
  const cwLen = R * 0.110;
  ctx.beginPath();
  ctx.arc(
    cx + cwLen * Math.cos(handAngle + Math.PI),
    cy + cwLen * Math.sin(handAngle + Math.PI),
    R * 0.021, 0, Math.PI * 2
  );
  ctx.fillStyle = 'rgba(255,255,255,0.40)';
  ctx.fill();

  // 7. Centre hub ───────────────────────────────────────────────────────────────
  const hubR    = R * 0.088;
  const hubGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, hubR);
  hubGrad.addColorStop(0, '#8875d8');
  hubGrad.addColorStop(1, '#2e2860');
  ctx.beginPath();
  ctx.arc(cx, cy, hubR, 0, Math.PI * 2);
  ctx.fillStyle = hubGrad;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.28)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // 8. Target diamond marker (on the outer ring midpoint) ─────────────────────
  if (targetSemitones > 0) {
    // Use raw targetSemitones (not tIdx) so octave (12) correctly places at 12:00
    const tAngle = (targetSemitones / 12) * Math.PI * 2 - Math.PI / 2;
    const tDotR  = R * 0.872;
    const tdx    = cx + tDotR * Math.cos(tAngle);
    const tdy    = cy + tDotR * Math.sin(tAngle);
    const tColor = SEMITONE_COLORS[tIdx];
    const ds     = R * 0.040; // diamond half-size

    ctx.save();
    ctx.shadowColor = tColor;
    ctx.shadowBlur  = 20;
    ctx.beginPath();
    ctx.moveTo(tdx,      tdy - ds);
    ctx.lineTo(tdx + ds, tdy);
    ctx.lineTo(tdx,      tdy + ds);
    ctx.lineTo(tdx - ds, tdy);
    ctx.closePath();
    ctx.fillStyle = tColor;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(255,255,255,0.88)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  }

  ctx.restore();
}
