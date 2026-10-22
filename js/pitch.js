// ── pitch.js ──────────────────────────────────────────────────────────────────
// Fundamental-frequency detection: McLeod Pitch Method (MPM).
// McLeod & Wyvill, "A smarter way to find pitch" (2005).
//
// Why MPM instead of YIN+HPS: MPM picks the FIRST normalised-autocorrelation
// peak that reaches K × the highest peak. A strong harmonic produces a peak at
// a shorter lag but it is rarely ≥ 0.9 of the true period's peak, so octave-up
// errors are rare. The caller also narrows [minHz, maxHz] around the notes the
// singer is expected to produce, so most harmonics fall outside the window.
//
// Pure function — no audio, no DOM. Tested in test/pitch.test.mjs.
// ─────────────────────────────────────────────────────────────────────────────

const K = 0.9;

let _nsdf = new Float32Array(0);

// x: frame of samples (Float32Array). Returns { hz, clarity, rms }.
// hz is null when no periodic peak exists in the window.
export function detectPitch(x, sr, minHz, maxHz) {
  const N = x.length;

  let energy = 0;
  for (let i = 0; i < N; i++) energy += x[i] * x[i];
  const rms = Math.sqrt(energy / N);
  if (energy === 0) return { hz: null, clarity: 0, rms };

  const minLag = Math.max(2, Math.floor(sr / maxHz));
  const maxLag = Math.min((N >> 1) - 1, Math.ceil(sr / minHz) + 1);
  if (minLag >= maxLag) return { hz: null, clarity: 0, rms };

  if (_nsdf.length < maxLag + 2) _nsdf = new Float32Array(maxLag + 2);
  const nsdf = _nsdf;

  // Normalised square difference function, tau = 0 … maxLag+1.
  // m(tau) = Σ x[j]² + x[j+tau]² is updated incrementally.
  let m = 2 * energy;
  for (let tau = 0; tau <= maxLag + 1; tau++) {
    if (tau > 0) m -= x[tau - 1] * x[tau - 1] + x[N - tau] * x[N - tau];
    let r = 0;
    for (let j = 0, L = N - tau; j < L; j++) r += x[j] * x[j + tau];
    nsdf[tau] = m > 1e-12 ? 2 * r / m : 0;
  }

  // Key maxima: the highest point of each positive lobe after the first
  // negative-going zero crossing. Lobes cut off by maxLag are discarded.
  let tau = 1;
  while (tau <= maxLag && nsdf[tau] > 0) tau++;

  const peaks = [];
  let lobeTau = -1, lobeMax = 0;
  for (; tau <= maxLag; tau++) {
    const v = nsdf[tau];
    if (v > 0) {
      if (lobeTau < 0 || v > lobeMax) { lobeMax = v; lobeTau = tau; }
    } else if (lobeTau >= 0) {
      if (lobeTau >= minLag) peaks.push(lobeTau);
      lobeTau = -1;
    }
  }
  if (lobeTau >= minLag && lobeTau < maxLag && nsdf[lobeTau + 1] < lobeMax) peaks.push(lobeTau);
  if (!peaks.length) return { hz: null, clarity: 0, rms };

  let highest = 0;
  for (const p of peaks) if (nsdf[p] > highest) highest = nsdf[p];
  const threshold = K * highest;
  const t = peaks.find(p => nsdf[p] >= threshold);

  // Parabolic interpolation around the chosen lag.
  const a = nsdf[t - 1], b = nsdf[t], c = nsdf[t + 1];
  const den = a - 2 * b + c;
  const delta = den !== 0 ? 0.5 * (a - c) / den : 0;
  const clarity = Math.min(1, b - 0.25 * (a - c) * delta);

  return { hz: sr / (t + delta), clarity, rms };
}
