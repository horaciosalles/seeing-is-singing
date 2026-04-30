// ── draw.js ───────────────────────────────────────────────────────────────────
// @version 0.6
// Clock renderer. 12-semitone circular interface.
// Root at 12:00. Ascending intervals clockwise, 30° per semitone.
//
// New in 0.6:
//   • Clicking an arc segment sets the target interval (plays note for preview).
//   • Date-roller complication at 3 o'clock toggles ascending / descending.
//   • On-target feedback: radial center glow + rim pulse + green pitch readout.
//   • Pitch note + cents drawn on canvas (no separate DOM readout).
//
// Depends on: yin.js (pitchState, getLatestPitch), theory.js (INTERVALS, NOTE_NAMES, mpc, moct)
//             state globals: rootMidi, curDirection, appState, _effectiveSemitones()
//             state callbacks: setTargetFromClock(clockPos), toggleDirection()
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

// ── Chromatic color palette (one hue per semitone, 30° steps) ────────────────
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

const CLOCK_LABELS = ['Root','m2','M2','m3','M3','P4','TT','P5','m6','M6','m7','M7'];

// ── Canvas state ──────────────────────────────────────────────────────────────
let _canvas = null;
let _ctx    = null;

// ── Animation state ───────────────────────────────────────────────────────────
let _displayAngle = 0;
let _hasPitch     = false;
let _litSemiClass = -1;

// ── Date-roller hit rect (CSS pixels, set during _render) ─────────────────────
let _rollerRect = null;

// ── Public API ────────────────────────────────────────────────────────────────

function initClock() {
  _canvas = document.getElementById('clockCanvas');
  if (!_canvas) return;
  _ctx = _canvas.getContext('2d');
  _resize();
  new ResizeObserver(_resize).observe(_canvas.parentElement);
  window.addEventListener('resize', _resize);
  _canvas.addEventListener('click', _onCanvasClick);
  _canvas.addEventListener('touchstart', (e) => { e.preventDefault(); _onCanvasClick(e); }, { passive: false });
}

function resetClockAngle() { _displayAngle = 0; }

function _isDesc()     { return curDirection === 'desc'; }
function _nameIdx(pos) { return _isDesc() ? (12 - pos) % 12 : pos; }

function drawClockFrame({ state, targetSemitones }) {
  if (!_canvas || !_ctx) return;
  _updateAngle(state);
  _render(state, targetSemitones);
}

// ── Click / tap handler ───────────────────────────────────────────────────────

function _onCanvasClick(e) {
  const rect  = _canvas.getBoundingClientRect();
  const touch = e.changedTouches ? e.changedTouches[0] : e;
  const x     = touch.clientX - rect.left;
  const y     = touch.clientY - rect.top;
  const dpr   = window.devicePixelRatio || 1;
  const W     = _canvas.width  / dpr;
  const H     = _canvas.height / dpr;
  const cx    = W / 2;
  const cy    = H / 2;
  const R     = Math.min(W, H) / 2 * 0.91;

  // ── Date-roller hit test (inside the face, 3 o'clock) ────────────────────
  if (_rollerRect) {
    const { x: rx, y: ry, w: rw, h: rh } = _rollerRect;
    if (x >= rx && x <= rx + rw && y >= ry && y <= ry + rh) {
      if (typeof appState !== 'undefined' && appState === 'SINGING') return;
      if (typeof toggleDirection === 'function') toggleDirection();
      return;
    }
  }

  // ── Arc ring hit test ────────────────────────────────────────────────────
  if (typeof appState !== 'undefined' && appState === 'SINGING') return;
  const dx   = x - cx;
  const dy   = y - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < R * 0.760 || dist > R * 0.985) return;

  let angle = Math.atan2(dy, dx) + Math.PI / 2;
  if (angle < 0) angle += Math.PI * 2;
  const clockPos = Math.round(angle / (Math.PI * 2 / 12)) % 12;
  if (typeof setTargetFromClock === 'function') setTargetFromClock(clockPos);
}

// ── Private helpers ───────────────────────────────────────────────────────────

function _resize() {
  const dpr  = window.devicePixelRatio || 1;
  const wrap = _canvas.parentElement;
  const vw   = window.innerWidth;
  const vh   = window.innerHeight;
  // Reserve ~150px for sliders + button + padding/gaps.
  const maxH = vh - 150;
  const size = Math.min(wrap.clientWidth, maxH, 480);
  _canvas.style.width  = size + 'px';
  _canvas.style.height = size + 'px';
  _canvas.width  = Math.round(size * dpr);
  _canvas.height = Math.round(size * dpr);
  if (typeof appState !== 'undefined' && appState !== 'SINGING') {
    drawClockFrame({ state: appState, targetSemitones: _effectiveSemitones() });
  }
}

function _latestMidi() {
  const buf = pitchState.buf;
  for (let i = buf.length - 1; i >= 0; i--) {
    if (!buf[i].gap) return buf[i].midi;
  }
  return null;
}

// EMA-smooth the clock hand toward pitch.
function _updateAngle(state) {
  if (state === 'SINGING') {
    const midi = _latestMidi();
    if (midi !== null) {
      _hasPitch = true;
      const raw = (midi - rootMidi) * 30;
      _displayAngle += (raw - _displayAngle) * 0.10;
    } else {
      _hasPitch = false;
      _displayAngle += (0 - _displayAngle) * 0.04;
    }
    return;
  }
  _hasPitch = false;
}

// ── Rounded rect helper ────────────────────────────────────────────────────────
function _rrect(ctx, x, y, w, h, r) {
  if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ── Draw date-roller complication ──────────────────────────────────────────────
// Draws at 3 o'clock inside the face. Stores hit rect for click testing.
function _drawDateRoller(ctx, cx, cy, R) {
  const isDesc = _isDesc();
  const rW = Math.max(R * 0.28, 36);
  const rH = Math.max(R * 0.13, 18);
  const rX = cx + R * 0.44 - rW / 2;
  const rY = cy - rH / 2;
  const rRad = 4;

  _rollerRect = { x: rX, y: rY, w: rW, h: rH };

  ctx.save();

  // Window frame
  ctx.beginPath();
  _rrect(ctx, rX, rY, rW, rH, rRad);
  ctx.fillStyle = 'rgba(20, 18, 52, 0.88)';
  ctx.fill();
  ctx.strokeStyle = isDesc ? 'rgba(244,114,182,0.55)' : 'rgba(94,232,122,0.55)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Mode text
  const arrow = isDesc ? '▼' : '▲';
  const label = isDesc ? 'DESC' : 'ASC';
  const tColor = isDesc ? '#f472b6' : '#5ee87a';
  const fSize  = Math.max(R * 0.043, 8);
  ctx.font = `700 ${fSize.toFixed(1)}px 'IBM Plex Mono',monospace`;
  ctx.fillStyle = tColor;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(arrow + ' ' + label, rX + rW / 2, rY + rH / 2);

  ctx.restore();
}

// ── Draw pitch readout in clock center ────────────────────────────────────────
function _drawPitchReadout(ctx, cx, cy, R, state, tColor, onTarget) {
  if (state !== 'SINGING') return;

  const rawMidi = _latestMidi();
  ctx.save();
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';

  if (rawMidi === null) {
    ctx.font      = `400 ${(R * 0.062).toFixed(1)}px 'IBM Plex Mono',monospace`;
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.fillText('—', cx, cy + R * 0.24);
    ctx.restore();
    return;
  }

  const nearest = Math.round(rawMidi);
  const noteName = NOTE_NAMES[mpc(nearest)] + moct(nearest);
  const cents    = (rawMidi - nearest) * 100;

  // Color by accuracy — green when on target, warm gradient otherwise
  const absC = Math.abs(cents);
  let color;
  if (onTarget)     color = '#4ade80';
  else if (absC < 20) color = '#86efac';
  else if (absC < 40) color = '#fde047';
  else                color = '#f87171';

  // Note name
  const nSize = R * 0.095;
  ctx.font      = `700 ${nSize.toFixed(1)}px 'IBM Plex Mono',monospace`;
  ctx.fillStyle = color;
  if (onTarget) { ctx.shadowColor = color; ctx.shadowBlur = 18; }
  ctx.fillText(noteName, cx, cy + R * 0.22);
  ctx.shadowBlur = 0;

  // Cents offset
  ctx.font      = `400 ${(R * 0.052).toFixed(1)}px 'IBM Plex Mono',monospace`;
  ctx.fillStyle = onTarget ? 'rgba(74,222,128,0.75)' : 'rgba(255,255,255,0.42)';
  ctx.fillText((cents >= 0 ? '+' : '') + cents.toFixed(0) + '¢', cx, cy + R * 0.355);

  ctx.restore();
}

// ── Main rendering ────────────────────────────────────────────────────────────
function _render(state, targetSemitones) {
  const dpr = window.devicePixelRatio || 1;
  const W   = _canvas.width  / dpr;
  const H   = _canvas.height / dpr;
  const cx  = W / 2;
  const cy  = H / 2;
  const R   = Math.min(W, H) / 2 * 0.91;

  _litSemiClass = -1;
  const ctx = _ctx;
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  // Target index (clock position 0–11)
  const tIdx   = ((Math.round(targetSemitones) % 12) + 12) % 12;
  const tColor = SEMITONE_COLORS[_nameIdx(tIdx)];

  // ── Is singer on target? ──────────────────────────────────────────────────
  // Computed here so we can use it throughout the render.
  let onTarget = false;
  {
    const midi = _latestMidi();
    if (state === 'SINGING' && midi !== null) {
      const semOffset = midi - rootMidi;
      const rounded   = Math.round(semOffset);
      const centsOff  = Math.abs(semOffset - rounded) * 100;
      const semiClass = ((rounded % 12) + 12) % 12;
      const intensity = Math.max(0, 1 - (centsOff / 35) ** 2);
      if (intensity > 0.04) {
        _litSemiClass = semiClass;
        onTarget = (semiClass === tIdx);
      }
    }
  }

  // 1. Clock face ──────────────────────────────────────────────────────────────
  const faceGrad = ctx.createRadialGradient(cx, cy - R * 0.12, R * 0.08, cx, cy, R);
  faceGrad.addColorStop(0, '#302d5c');
  faceGrad.addColorStop(1, '#1a1840');
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.fillStyle = faceGrad;
  ctx.fill();

  // Outer rim — glows in target color when locked in
  if (onTarget) {
    const t = performance.now() / 1000;
    const pulse = 0.55 + 0.45 * Math.sin(t * Math.PI * 5);
    ctx.save();
    ctx.shadowColor = tColor;
    ctx.shadowBlur  = 22 * pulse;
    ctx.strokeStyle = tColor + Math.round(0xaa * pulse).toString(16).padStart(2, '0');
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  } else {
    ctx.strokeStyle = 'rgba(167,139,250,0.18)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // 2. Colored arc segments ────────────────────────────────────────────────────
  const segOuter = R * 0.975;
  const segInner = R * 0.770;
  const arcGap   = 0.022;

  for (let i = 0; i < 12; i++) {
    const a0 = ((i - 0.5) / 12) * Math.PI * 2 - Math.PI / 2 + arcGap;
    const a1 = ((i + 0.5) / 12) * Math.PI * 2 - Math.PI / 2 - arcGap;
    ctx.beginPath();
    ctx.arc(cx, cy, segOuter, a0, a1);
    ctx.arc(cx, cy, segInner, a1, a0, true);
    ctx.closePath();
    ctx.fillStyle = SEMITONE_COLORS[_nameIdx(i)] + '28';
    ctx.fill();
  }

  // 3. Target segment (glowing) ────────────────────────────────────────────────
  {
    const a0 = ((tIdx - 0.5) / 12) * Math.PI * 2 - Math.PI / 2 + arcGap;
    const a1 = ((tIdx + 0.5) / 12) * Math.PI * 2 - Math.PI / 2 - arcGap;
    ctx.save();
    ctx.shadowColor = tColor;
    ctx.shadowBlur  = onTarget ? 40 : 24;
    ctx.beginPath();
    ctx.arc(cx, cy, segOuter, a0, a1);
    ctx.arc(cx, cy, segInner, a1, a0, true);
    ctx.closePath();
    ctx.fillStyle = tColor + (onTarget ? 'ee' : 'cc');
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.restore();
  }

  // 4. Neon arc — singer's current note ─────────────────────────────────────────
  {
    const midi = _latestMidi();
    if (state === 'SINGING' && midi !== null) {
      const semOffset = midi - rootMidi;
      const rounded   = Math.round(semOffset);
      const centsOff  = Math.abs(semOffset - rounded) * 100;
      const semiClass = ((rounded % 12) + 12) % 12;
      const intensity = Math.max(0, 1 - (centsOff / 35) ** 2);

      if (intensity > 0.04) {
        const color = SEMITONE_COLORS[_nameIdx(semiClass)];
        const a0    = ((semiClass - 0.5) / 12) * Math.PI * 2 - Math.PI / 2 + arcGap;
        const a1    = ((semiClass + 0.5) / 12) * Math.PI * 2 - Math.PI / 2 - arcGap;

        ctx.save();
        ctx.shadowColor = color;
        ctx.shadowBlur  = 32 * intensity;
        ctx.beginPath();
        ctx.arc(cx, cy, segOuter, a0, a1);
        ctx.arc(cx, cy, segInner, a1, a0, true);
        ctx.closePath();
        const alpha = Math.round(0xee * intensity).toString(16).padStart(2, '0');
        ctx.fillStyle = color + alpha;
        ctx.fill();

        ctx.shadowBlur  = 18 * intensity;
        ctx.strokeStyle = `rgba(255,255,255,${0.95 * intensity})`;
        ctx.lineWidth   = 2.5;
        ctx.beginPath(); ctx.arc(cx, cy, segOuter - 2, a0, a1); ctx.stroke();
        ctx.beginPath(); ctx.arc(cx, cy, segInner + 2, a1, a0, true); ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.restore();
      }
    }
  }

  // 5. Tick marks and interval labels ──────────────────────────────────────────
  for (let i = 0; i < 12; i++) {
    const angle    = (i / 12) * Math.PI * 2 - Math.PI / 2;
    const nameI    = _nameIdx(i);
    const segColor = SEMITONE_COLORS[nameI];
    const isRoot   = nameI === 0;
    const isTgt    = i === tIdx;
    const isLit    = i === _litSemiClass;

    const tOuter = R * 0.750;
    const tInner = isRoot ? R * 0.625 : R * 0.690;
    ctx.beginPath();
    ctx.moveTo(cx + tInner * Math.cos(angle), cy + tInner * Math.sin(angle));
    ctx.lineTo(cx + tOuter * Math.cos(angle), cy + tOuter * Math.sin(angle));
    ctx.strokeStyle = (isRoot || isLit) ? 'rgba(255,255,255,0.90)'
                    : isTgt             ? segColor
                    :                     'rgba(255,255,255,0.20)';
    ctx.lineWidth   = isRoot ? 2.5 : (isTgt || isLit) ? 2.0 : 1.0;
    ctx.stroke();

    const lR = R * 0.868;
    const lx = cx + lR * Math.cos(angle);
    const ly = cy + lR * Math.sin(angle);
    ctx.font = isRoot
      ? `700 ${(R * 0.074).toFixed(1)}px 'IBM Plex Mono',monospace`
      : `500 ${(R * 0.068).toFixed(1)}px 'IBM Plex Mono',monospace`;
    ctx.fillStyle = isLit  ? '#ffffff'
                 : isRoot  ? 'rgba(255,255,255,0.95)'
                 : isTgt   ? segColor
                 :            segColor + 'bb';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(CLOCK_LABELS[nameI], lx, ly);
  }

  // 6. Inner vignette ──────────────────────────────────────────────────────────
  const vigGrad = ctx.createRadialGradient(cx, cy, R * 0.36, cx, cy, R * 0.58);
  vigGrad.addColorStop(0, 'rgba(26,24,64,0)');
  vigGrad.addColorStop(1, 'rgba(26,24,64,0.70)');
  ctx.beginPath();
  ctx.arc(cx, cy, R * 0.58, 0, Math.PI * 2);
  ctx.fillStyle = vigGrad;
  ctx.fill();

  // 7. On-target center glow ────────────────────────────────────────────────────
  if (onTarget) {
    const t = performance.now() / 1000;
    const pulse = 0.55 + 0.45 * Math.sin(t * Math.PI * 5);
    const gR    = R * 0.46 * (0.85 + 0.15 * pulse);
    const glow  = ctx.createRadialGradient(cx, cy, 0, cx, cy, gR);
    const a1    = Math.round(0x50 * pulse).toString(16).padStart(2, '0');
    glow.addColorStop(0,    tColor + a1);
    glow.addColorStop(0.45, tColor + '18');
    glow.addColorStop(1,    tColor + '00');
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, gR, 0, Math.PI * 2);
    ctx.fillStyle = glow;
    ctx.fill();
    ctx.restore();
  }

  // 8. Date-roller complication (3 o'clock) ─────────────────────────────────────
  _drawDateRoller(ctx, cx, cy, R);

  // 9. Clock hand ──────────────────────────────────────────────────────────────
  const handAngle = _displayAngle * Math.PI / 180 - Math.PI / 2;
  const handLen   = R * 0.670;
  const hTipX    = cx + handLen * Math.cos(handAngle);
  const hTipY    = cy + handLen * Math.sin(handAngle);
  const hColor    = _hasPitch ? '#ff4d4d' : 'rgba(60,50,110,0.50)';

  ctx.save();
  ctx.shadowColor = hColor;
  ctx.shadowBlur  = (state === 'SINGING' && _hasPitch) ? 26 : 6;

  const perp = handAngle + Math.PI / 2;
  const bw   = R * 0.016;
  ctx.beginPath();
  ctx.moveTo(cx + bw * Math.cos(perp), cy + bw * Math.sin(perp));
  ctx.lineTo(hTipX, hTipY);
  ctx.lineTo(cx - bw * Math.cos(perp), cy - bw * Math.sin(perp));
  ctx.closePath();
  ctx.fillStyle = 'rgba(255,255,255,0.96)';
  ctx.fill();

  ctx.beginPath();
  ctx.arc(hTipX, hTipY, R * 0.030, 0, Math.PI * 2);
  ctx.fillStyle  = hColor;
  ctx.shadowBlur = _hasPitch ? 30 : 0;
  ctx.fill();
  ctx.restore();

  // Counter-weight
  const cwLen = R * 0.110;
  ctx.beginPath();
  ctx.arc(
    cx + cwLen * Math.cos(handAngle + Math.PI),
    cy + cwLen * Math.sin(handAngle + Math.PI),
    R * 0.021, 0, Math.PI * 2
  );
  ctx.fillStyle = 'rgba(255,255,255,0.40)';
  ctx.fill();

  // 10. Centre hub ────────────────────────────────────────────────────────────
  const hubR    = R * 0.088;
  const hubGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, hubR);
  if (onTarget) {
    const t = performance.now() / 1000;
    const p = 0.6 + 0.4 * Math.sin(t * Math.PI * 5);
    hubGrad.addColorStop(0, tColor);
    hubGrad.addColorStop(1, tColor + Math.round(0x80 * p).toString(16).padStart(2, '0'));
    ctx.save();
    ctx.shadowColor = tColor;
    ctx.shadowBlur  = 20;
    ctx.beginPath();
    ctx.arc(cx, cy, hubR, 0, Math.PI * 2);
    ctx.fillStyle = hubGrad;
    ctx.fill();
    ctx.restore();
  } else {
    hubGrad.addColorStop(0, '#8875d8');
    hubGrad.addColorStop(1, '#2e2860');
    ctx.beginPath();
    ctx.arc(cx, cy, hubR, 0, Math.PI * 2);
    ctx.fillStyle = hubGrad;
    ctx.fill();
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.28)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // 11. Pitch readout (note name + cents, drawn in center area below hub) ──────
  _drawPitchReadout(ctx, cx, cy, R, state, tColor, onTarget);

  // 12. Target diamond marker ─────────────────────────────────────────────────
  if (targetSemitones !== 0) {
    const tAngle = (targetSemitones / 12) * Math.PI * 2 - Math.PI / 2;
    const tDotR  = R * 0.938;
    const tdx    = cx + tDotR * Math.cos(tAngle);
    const tdy    = cy + tDotR * Math.sin(tAngle);
    const ds = R * 0.040;

    ctx.save();
    ctx.shadowColor = tColor;
    ctx.shadowBlur  = onTarget ? 32 : 20;
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
