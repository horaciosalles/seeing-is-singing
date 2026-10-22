// ── clock.js ──────────────────────────────────────────────────────────────────
// Pitch-clock renderer. 12 semitones around the dial, root at 12:00,
// 30° per semitone. Ascending intervals run clockwise; in descending mode the
// labels are mirrored so a descending m3 sits at 9:00.
//
// The hand angle is (midi − root) × 30°, drawn straight from the tracker
// output — no extra smoothing here. When the singer stops, the hand stays
// where it was and dims instead of drifting back to the root.
//
// Stateless apart from canvas geometry: everything to draw arrives in render().
// ─────────────────────────────────────────────────────────────────────────────

import { INTERVALS, noteName } from './theory.js';

// One hue per semitone (index = semitones above the root).
export const SEMITONE_COLORS = [
  '#ff6b6b', '#ff8e42', '#ffd166', '#b5e655', '#5ee87a', '#2dd4bf',
  '#22d3ee', '#4ea8ff', '#818cf8', '#a78bfa', '#d16ef8', '#f472b6',
];

const FONT   = "'IBM Plex Mono',monospace";
const TAU    = Math.PI * 2;
const ARC_GAP = 0.022;

// Ring geometry, as fractions of R.
const SEG_OUTER = 0.975;
const SEG_INNER = 0.770;

// Semitones (0–11) shown at clock position pos for the given direction.
export const semisAt = (pos, dir) => (pos === 0 ? 0 : dir === 'asc' ? pos : 12 - pos);
// Clock position of an interval of `semis` semitones.
export const posOf = (semis, dir) => (dir === 'asc' ? semis % 12 : (12 - semis % 12) % 12);

const hexA = (a) => Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, '0');
const segA0 = (pos) => ((pos - 0.5) / 12) * TAU - Math.PI / 2 + ARC_GAP;
const segA1 = (pos) => ((pos + 0.5) / 12) * TAU - Math.PI / 2 - ARC_GAP;

export function createClock(canvas, onLayout) {
  const ctx = canvas.getContext('2d');
  let size = 0, R = 0, cx = 0, cy = 0;
  let rollerRect = null;

  function resize() {
    const wrap = canvas.parentElement;
    const dpr  = window.devicePixelRatio || 1;
    size = Math.max(160, Math.min(wrap.clientWidth, wrap.clientHeight));
    canvas.style.width  = canvas.style.height = size + 'px';
    canvas.width  = canvas.height = Math.round(size * dpr);
    R  = size / 2 * 0.91;
    cx = cy = size / 2;
    const rect = canvas.getBoundingClientRect();
    const wrapRect = wrap.getBoundingClientRect();
    onLayout({
      R,
      cx: rect.left - wrapRect.left + cx,
      cy: rect.top  - wrapRect.top  + cy,
    });
  }

  // Returns { kind: 'roller' } | { kind: 'segment', pos } | null.
  function hitTest(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left, y = clientY - rect.top;
    if (rollerRect) {
      const { x: rx, y: ry, w, h } = rollerRect;
      if (x >= rx && x <= rx + w && y >= ry && y <= ry + h) return { kind: 'roller' };
    }
    const dx = x - cx, dy = y - cy;
    const dist = Math.hypot(dx, dy);
    if (dist < R * 0.70 || dist > R * 1.0) return null;
    let a = Math.atan2(dy, dx) + Math.PI / 2;
    if (a < 0) a += TAU;
    return { kind: 'segment', pos: Math.round(a / (TAU / 12)) % 12 };
  }

  function ringPath(pos, outer = SEG_OUTER, inner = SEG_INNER) {
    ctx.beginPath();
    ctx.arc(cx, cy, R * outer, segA0(pos), segA1(pos));
    ctx.arc(cx, cy, R * inner, segA1(pos), segA0(pos), true);
    ctx.closePath();
  }

  // view: {
  //   singing, dir, rootMidi, targetSemis,
  //   midi        — current smoothed pitch or null
  //   handMidi    — last known pitch (for the dimmed resting hand) or null
  //   lock        — { state: 'idle'|'near'|'locked', progress }
  //   octaveOff   — 0, or ±n when the right note is sung in the wrong octave
  // }
  function render(view) {
    const dpr = window.devicePixelRatio || 1;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    const { singing, dir, rootMidi, targetSemis, midi, handMidi, lock } = view;
    const tPos    = posOf(targetSemis, dir);
    const tColor  = SEMITONE_COLORS[targetSemis % 12];
    const locked  = singing && lock.state === 'locked';
    const pulse   = 0.55 + 0.45 * Math.sin(performance.now() / 1000 * Math.PI * 5);

    // Segment the singer is on, with brightness falling off with detuning.
    let litPos = -1, litIntensity = 0;
    if (singing && midi !== null) {
      const off = midi - rootMidi;
      const near = Math.round(off);
      litIntensity = Math.max(0, 1 - (Math.abs(off - near) * 100 / 35) ** 2);
      if (litIntensity > 0.04) litPos = ((near % 12) + 12) % 12;
    }

    // 1. Face
    const face = ctx.createRadialGradient(cx, cy - R * 0.12, R * 0.08, cx, cy, R);
    face.addColorStop(0, '#302d5c');
    face.addColorStop(1, '#1a1840');
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, TAU);
    ctx.fillStyle = face;
    ctx.fill();
    ctx.save();
    if (locked) {
      ctx.shadowColor = tColor;
      ctx.shadowBlur  = 22 * pulse;
      ctx.strokeStyle = tColor + hexA(0.67 * pulse);
      ctx.lineWidth   = 2;
    } else {
      ctx.strokeStyle = 'rgba(167,139,250,0.18)';
      ctx.lineWidth   = 1.5;
    }
    ctx.stroke();
    ctx.restore();

    // 2. Ring segments
    for (let pos = 0; pos < 12; pos++) {
      ringPath(pos);
      ctx.fillStyle = SEMITONE_COLORS[semisAt(pos, dir)] + '28';
      ctx.fill();
    }

    // 3. Target segment
    ctx.save();
    ctx.shadowColor = tColor;
    ctx.shadowBlur  = locked ? 40 : 24;
    ringPath(tPos);
    ctx.fillStyle = tColor + (locked ? 'ee' : 'cc');
    ctx.fill();
    ctx.restore();

    // 3b. Hold progress — a bright band filling along the target's outer edge
    if (singing && lock.state === 'near') {
      const a0 = segA0(tPos), a1 = segA1(tPos);
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, R * (SEG_OUTER + 0.012), a0, a0 + (a1 - a0) * lock.progress);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth   = R * 0.022;
      ctx.lineCap     = 'round';
      ctx.shadowColor = tColor;
      ctx.shadowBlur  = 12;
      ctx.stroke();
      ctx.restore();
    }

    // 4. Neon segment — where the singer is
    if (litPos >= 0) {
      const color = SEMITONE_COLORS[semisAt(litPos, dir)];
      ctx.save();
      ctx.shadowColor = color;
      ctx.shadowBlur  = 32 * litIntensity;
      ringPath(litPos);
      ctx.fillStyle = color + hexA(0.93 * litIntensity);
      ctx.fill();
      ctx.shadowBlur  = 18 * litIntensity;
      ctx.strokeStyle = `rgba(255,255,255,${0.95 * litIntensity})`;
      ctx.lineWidth   = 2.5;
      ctx.beginPath(); ctx.arc(cx, cy, R * SEG_OUTER - 2, segA0(litPos), segA1(litPos)); ctx.stroke();
      ctx.beginPath(); ctx.arc(cx, cy, R * SEG_INNER + 2, segA1(litPos), segA0(litPos), true); ctx.stroke();
      ctx.restore();
    }

    // 5. Ticks and labels (the root label sits under the root picker overlay)
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let pos = 0; pos < 12; pos++) {
      const angle = (pos / 12) * TAU - Math.PI / 2;
      const semis = semisAt(pos, dir);
      const color = SEMITONE_COLORS[semis];
      const isRoot = pos === 0, isTgt = pos === tPos, isLit = pos === litPos;

      if (isRoot) continue; // the root picker overlay marks 12 o'clock

      const tIn = R * 0.690, tOut = R * 0.750;
      ctx.beginPath();
      ctx.moveTo(cx + tIn * Math.cos(angle), cy + tIn * Math.sin(angle));
      ctx.lineTo(cx + tOut * Math.cos(angle), cy + tOut * Math.sin(angle));
      ctx.strokeStyle = isLit ? 'rgba(255,255,255,0.90)' : isTgt ? color : 'rgba(255,255,255,0.20)';
      ctx.lineWidth   = (isTgt || isLit) ? 2.0 : 1.0;
      ctx.stroke();

      const lR = R * 0.868;
      ctx.font = `500 ${(R * 0.068).toFixed(1)}px ${FONT}`;
      ctx.fillStyle = isLit ? '#ffffff' : isTgt ? '#14122e' : color + 'bb';
      ctx.fillText(INTERVALS[semis].short, cx + lR * Math.cos(angle), cy + lR * Math.sin(angle));
    }

    // 6. Inner vignette
    const vig = ctx.createRadialGradient(cx, cy, R * 0.36, cx, cy, R * 0.58);
    vig.addColorStop(0, 'rgba(26,24,64,0)');
    vig.addColorStop(1, 'rgba(26,24,64,0.70)');
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.58, 0, TAU);
    ctx.fillStyle = vig;
    ctx.fill();

    // 7. Centre glow when locked
    if (locked) {
      const gR = R * 0.46 * (0.85 + 0.15 * pulse);
      const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, gR);
      glow.addColorStop(0, tColor + hexA(0.31 * pulse));
      glow.addColorStop(0.45, tColor + '18');
      glow.addColorStop(1, tColor + '00');
      ctx.beginPath();
      ctx.arc(cx, cy, gR, 0, TAU);
      ctx.fillStyle = glow;
      ctx.fill();
    }

    // 8. Direction roller (3 o'clock)
    drawRoller(dir);

    // 9. Hand
    const live = singing && midi !== null;
    const handDeg = handMidi === null ? 0 : (handMidi - rootMidi) * 30;
    drawHand(handDeg * Math.PI / 180 - Math.PI / 2, live);

    // 10. Hub ring (the Sing/Stop button is an HTML element on top)
    const hubR = R * 0.088;
    ctx.beginPath();
    ctx.arc(cx, cy, hubR, 0, TAU);
    ctx.fillStyle = locked ? tColor : '#2e2860';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // 11. Readout
    if (singing) drawReadout(view, locked);

    ctx.restore();
  }

  function drawRoller(dir) {
    const desc = dir === 'desc';
    const w = Math.max(R * 0.28, 40), h = Math.max(R * 0.13, 20);
    const x = cx + R * 0.44 - w / 2, y = cy - h / 2;
    rollerRect = { x, y, w, h };
    ctx.save();
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, 4); else ctx.rect(x, y, w, h);
    ctx.fillStyle = 'rgba(20,18,52,0.88)';
    ctx.fill();
    ctx.strokeStyle = desc ? 'rgba(244,114,182,0.55)' : 'rgba(94,232,122,0.55)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.font = `700 ${Math.max(R * 0.043, 9).toFixed(1)}px ${FONT}`;
    ctx.fillStyle = desc ? '#f472b6' : '#5ee87a';
    ctx.fillText(desc ? '▼ DESC' : '▲ ASC', x + w / 2, y + h / 2);
    ctx.restore();
  }

  function drawHand(angle, live) {
    const len = R * 0.670, bw = R * 0.016;
    const tipX = cx + len * Math.cos(angle), tipY = cy + len * Math.sin(angle);
    const perp = angle + Math.PI / 2;
    const gem  = live ? '#ff4d4d' : 'rgba(90,80,150,0.55)';

    ctx.save();
    ctx.shadowColor = gem;
    ctx.shadowBlur  = live ? 26 : 4;
    ctx.beginPath();
    ctx.moveTo(cx + bw * Math.cos(perp), cy + bw * Math.sin(perp));
    ctx.lineTo(tipX, tipY);
    ctx.lineTo(cx - bw * Math.cos(perp), cy - bw * Math.sin(perp));
    ctx.closePath();
    ctx.fillStyle = live ? 'rgba(255,255,255,0.96)' : 'rgba(255,255,255,0.35)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(tipX, tipY, R * 0.030, 0, TAU);
    ctx.fillStyle = gem;
    ctx.fill();
    ctx.restore();

    const cw = R * 0.110;
    ctx.beginPath();
    ctx.arc(cx + cw * Math.cos(angle + Math.PI), cy + cw * Math.sin(angle + Math.PI), R * 0.021, 0, TAU);
    ctx.fillStyle = 'rgba(255,255,255,0.40)';
    ctx.fill();
  }

  function drawReadout({ midi, octaveOff }, locked) {
    if (midi === null) {
      ctx.font = `400 ${(R * 0.062).toFixed(1)}px ${FONT}`;
      ctx.fillStyle = 'rgba(255,255,255,0.22)';
      ctx.fillText('—', cx, cy + R * 0.24);
      return;
    }
    const near  = Math.round(midi);
    const cents = (midi - near) * 100;
    const absC  = Math.abs(cents);
    const color = locked ? '#4ade80' : absC < 20 ? '#86efac' : absC < 40 ? '#fde047' : '#f87171';

    ctx.save();
    ctx.font = `700 ${(R * 0.095).toFixed(1)}px ${FONT}`;
    ctx.fillStyle = color;
    if (locked) { ctx.shadowColor = color; ctx.shadowBlur = 18; }
    ctx.fillText(noteName(near), cx, cy + R * 0.22);
    ctx.restore();

    ctx.font = `400 ${(R * 0.052).toFixed(1)}px ${FONT}`;
    ctx.fillStyle = locked ? 'rgba(74,222,128,0.75)' : 'rgba(255,255,255,0.42)';
    ctx.fillText((cents >= 0 ? '+' : '') + cents.toFixed(0) + '¢', cx, cy + R * 0.34);

    // Right note, wrong octave
    if (octaveOff) {
      ctx.font = `700 ${(R * 0.046).toFixed(1)}px ${FONT}`;
      ctx.fillStyle = '#fbbf24';
      ctx.fillText(octaveOff > 0 ? '8va too high ↓' : '8va too low ↑', cx, cy + R * 0.44);
    }
  }

  return { resize, render, hitTest };
}
