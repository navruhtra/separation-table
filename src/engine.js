// @ts-check
// ADN Separation Table — separation engine. Pure functions, no DOM. Runs in the worker and in tests.
import { quickhull } from "./vendor/quickhull.js";

/* ───────────── Color science ───────────── */
export const S2L = new Float32Array(256);
for (let i = 0; i < 256; i++) { const c = i / 255; S2L[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
export const lin2s = v => { v = v <= 0 ? 0 : v >= 1 ? 1 : v; return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055; };
const XN = 0.95047, ZN = 1.08883;
export function lin2lab(r, g, b) {
  const X = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / XN, Y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b, Z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / ZN;
  const f = t => t > 0.008856 ? Math.cbrt(t) : (7.787 * t + 16 / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
export function lab2lin(L, a, b) {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const fi = t => t > 0.206893 ? t * t * t : (t - 16 / 116) / 7.787;
  const X = fi(fx) * XN, Y = fi(fy), Z = fi(fz) * ZN;
  return [3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z, -0.9692660 * X + 1.8760108 * Y + 0.0415560 * Z, 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z];
}
export const rgb2lab = (r, g, b) => lin2lab(S2L[r | 0], S2L[g | 0], S2L[b | 0]);
export const lab2rgb = lab => lab2lin(...lab).map(v => Math.round(255 * lin2s(v)));
export const hex2rgb = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
export const rgb2hex = c => "#" + c.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");

// CIEDE2000 (Sharma, Wu, Dalal 2005). Fast scalar version for per-pixel metrics; tests check it against color.js.
// The hot scorer: hue helper inlined, squares as products, and hypot2 in place of Math.hypot. Same result to the last
// bit as the plain formula with Math.hypot in Node and Chromium (V8), about 1.25x faster.
export function de2000(L1, a1, b1, L2, a2, b2) {
  const C1 = hypot2(a1, b1), C2 = hypot2(a2, b2), Cb = (C1 + C2) / 2, Cb7 = Math.pow(Cb, 7), G = 0.5 * (1 - Math.sqrt(Cb7 / (Cb7 + 6103515625)));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2, C1p = hypot2(a1p, b1), C2p = hypot2(a2p, b2);
  let h1p = 0; if (a1p !== 0 || b1 !== 0) { h1p = Math.atan2(b1, a1p) * 180 / Math.PI; if (h1p < 0) h1p += 360; }
  let h2p = 0; if (a2p !== 0 || b2 !== 0) { h2p = Math.atan2(b2, a2p) * 180 / Math.PI; if (h2p < 0) h2p += 360; }
  const dL = L2 - L1, dC = C2p - C1p, CC = C1p * C2p;
  let dh = 0; if (CC !== 0) { dh = h2p - h1p; if (dh > 180) dh -= 360; else if (dh < -180) dh += 360; }
  const dH = 2 * Math.sqrt(CC) * Math.sin(dh * Math.PI / 360), Lb = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2;
  let hb = h1p + h2p; if (CC !== 0) { if (Math.abs(h1p - h2p) > 180) hb += hb < 360 ? 360 : -360; hb /= 2; }
  const T = 1 - 0.17 * Math.cos((hb - 30) * Math.PI / 180) + 0.24 * Math.cos(2 * hb * Math.PI / 180) + 0.32 * Math.cos((3 * hb + 6) * Math.PI / 180) - 0.2 * Math.cos((4 * hb - 63) * Math.PI / 180);
  const q = (hb - 275) / 25, dth = 30 * Math.exp(-(q * q)), Cb7p = Math.pow(Cbp, 7), RC = 2 * Math.sqrt(Cb7p / (Cb7p + 6103515625));
  const l50 = Lb - 50, l2 = l50 * l50, SL = 1 + 0.015 * l2 / Math.sqrt(20 + l2), SC = 1 + 0.045 * Cbp, SH = 1 + 0.015 * Cbp * T, RT = -Math.sin(2 * dth * Math.PI / 180) * RC;
  const x = dL / SL, y = dC / SC, z = dH / SH;
  return Math.sqrt(x * x + y * y + z * z + RT * y * z);
}
/** √(x² + y²) as V8's Math.hypot computes it for two finite numbers (scaled by the larger, so no overflow), without the
    variadic call: the same bits in Node and Chromium. */
export function hypot2(x, y) {
  x = Math.abs(x); y = Math.abs(y); if (x < y) { const t = x; x = y; y = t; }
  if (x === 0) return 0; const r = y / x; return Math.sqrt(1 + r * r) * x;
}
// ΔE CMC(l:c), reference first. Textile default 2:1 (ISO 105-J03).
export function deCMC(L1, a1, b1, L2, a2, b2, l = 2, c = 1) {
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), dL = L1 - L2, dC = C1 - C2, da = a1 - a2, db = b1 - b2;
  const dH2 = Math.max(0, da * da + db * db - dC * dC);
  let H1 = Math.atan2(b1, a1) * 180 / Math.PI; if (H1 < 0) H1 += 360;
  const SL = L1 < 16 ? 0.511 : 0.040975 * L1 / (1 + 0.01765 * L1), SC = 0.0638 * C1 / (1 + 0.0131 * C1) + 0.638;
  const F = Math.sqrt(C1 ** 4 / (C1 ** 4 + 1900));
  const T = (H1 >= 164 && H1 <= 345) ? 0.56 + Math.abs(0.2 * Math.cos((H1 + 168) * Math.PI / 180)) : 0.36 + Math.abs(0.4 * Math.cos((H1 + 35) * Math.PI / 180));
  const SH = SC * (F * T + 1 - F);
  return Math.sqrt((dL / (l * SL)) ** 2 + (dC / (c * SC)) ** 2 + dH2 / (SH * SH));
}

/* ───────────── Print model ─────────────
   Halftone area coverage mixes linearly in reflectance^(1/n) (Yule–Nielsen). n is fitted by calibration; 1.7 until then. */
export function mixFromLab(lab, n) { return lab2lin(...lab).map(v => Math.pow(Math.max(0, v), 1 / n)); }
export function mixFromRGB(r, g, b, n) { return [Math.pow(S2L[r], 1 / n), Math.pow(S2L[g], 1 / n), Math.pow(S2L[b], 1 / n)]; }
export function mixToLab(m, n) { return lin2lab(Math.pow(Math.max(0, m[0]), n), Math.pow(Math.max(0, m[1]), n), Math.pow(Math.max(0, m[2]), n)); }
export function mixToRGB(m, n) { return [0, 1, 2].map(i => Math.round(255 * lin2s(Math.pow(Math.max(0, m[i]), n)))); }

/* ───────────── Constrained unmixing ─────────────
   Coverage b ≥ 0 over inks + garment, Σb = 1, minimizing ‖Σ b_j C_j − t‖² + λ Σ b_j ‖C_j − t‖² (FISTA + simplex projection).
   The second term builds each color from nearby inks, which keeps channels smooth and printable. */
/* Two solvers for the same problem. "fista": the first one, 160 (or 60) fixed gradient steps from the nearest ink; it
   stops where it is, short of the optimum for many colors. "exact": an active-set method (Lawson–Hanson style) that
   ends at the optimum in a few steps; a tiny ridge keeps each sub-problem strictly convex. Checked against 40,000-step
   fista on 168,000 problems (2 to 14 inks, random and near-duplicate inks, with and without penalties): optimal on all,
   5 to 69 times faster. */
let SOLVER = globalThis.process?.env?.SOLVER || "fista";
const ITERS = +(globalThis.process?.env?.ITERS || 160);
export function setSolver(name) { SOLVER = name; }
export function makeSolver(C0, M) { return SOLVER === "exact" ? makeExact(C0, M) : makeFista(C0, M); }
function makeExact(C0, M) {
  let C = C0; const n1 = M + 1, RIDGE = 1e-9;
  const b = new Float64Array(M), g = new Float64Array(M), z = new Float64Array(n1), idx = new Int32Array(M), act = new Uint8Array(M), A = new Float64Array(n1 * n1), rhs = new Float64Array(n1), c = new Float64Array(M);
  // optimum on the support idx[0..k): solve [2CCᵀ + ridge, −1; 1ᵀ, 0][z; μ] = [2Ct − c; 1] (Gaussian elimination, partial pivoting)
  function kkt(k, t0, t1, t2) {
    const n = k + 1;
    for (let i = 0; i < k; i++) { const a = idx[i], a0 = C[a * 3], a1 = C[a * 3 + 1], a2 = C[a * 3 + 2];
      for (let j = 0; j < k; j++) { const q = idx[j]; A[i * n + j] = 2 * (a0 * C[q * 3] + a1 * C[q * 3 + 1] + a2 * C[q * 3 + 2]); }
      A[i * n + i] += RIDGE; A[i * n + k] = -1; A[k * n + i] = 1; rhs[i] = 2 * (a0 * t0 + a1 * t1 + a2 * t2) - c[a]; }
    A[k * n + k] = 0; rhs[k] = 1;
    for (let p = 0; p < n; p++) { let bp = p, bv = Math.abs(A[p * n + p]); for (let r = p + 1; r < n; r++) { const v = Math.abs(A[r * n + p]); if (v > bv) { bv = v; bp = r; } }
      if (bv < 1e-14) return false;
      if (bp !== p) { for (let q = p; q < n; q++) { const tmp = A[p * n + q]; A[p * n + q] = A[bp * n + q]; A[bp * n + q] = tmp; } const tr = rhs[p]; rhs[p] = rhs[bp]; rhs[bp] = tr; }
      const piv = A[p * n + p]; for (let r = p + 1; r < n; r++) { const f = A[r * n + p] / piv; if (f === 0) continue; for (let q = p + 1; q < n; q++) A[r * n + q] -= f * A[p * n + q]; rhs[r] -= f * rhs[p]; } }
    for (let p = n - 1; p >= 0; p--) { let v = rhs[p]; for (let q = p + 1; q < n; q++) v -= A[p * n + q] * z[q]; z[p] = v / A[p * n + p]; }
    return true;
  }
  solve.setC = x => { C = x; };
  return solve;
  function solve(t0, t1, t2, lam, _iters, out, extra) {
    let bi = 0, bv = Infinity;
    for (let j = 0; j < M; j++) { const d = (C[j * 3] - t0) ** 2 + (C[j * 3 + 1] - t1) ** 2 + (C[j * 3 + 2] - t2) ** 2; c[j] = lam * d + (extra ? extra[j] : 0); const v = d + c[j]; if (v < bv) { bv = v; bi = j; } b[j] = 0; act[j] = 0; }
    b[bi] = 1; act[bi] = 1; idx[0] = bi; let k = 1;
    for (let outer = 0; outer < 4 * M + 8; outer++) {
      // inner loop: move to the optimum of the current support, stopping at the first weight that reaches zero
      for (let inner = 0; inner < 2 * M + 4 && k > 0; inner++) {
        if (!kkt(k, t0, t1, t2)) break;
        let step = 1, drop = -1; for (let i = 0; i < k; i++) if (z[i] <= 0) { const a = idx[i], den = b[a] - z[i], s = den > 0 ? b[a] / den : 0; if (s < step) { step = s; drop = i; } }
        for (let i = 0; i < k; i++) { const a = idx[i]; b[a] += step * (z[i] - b[a]); }
        if (drop < 0) break;
        for (let i = k - 1; i >= 0; i--) { const a = idx[i]; if (i === drop || b[a] <= 1e-15) { b[a] = 0; act[a] = 0; idx[i] = idx[k - 1]; k--; } } // every weight at zero leaves the support
      }
      // reduced cost: the ink whose cost falls fastest enters; none below the multiplier means this is the optimum
      let r0 = -t0, r1 = -t1, r2 = -t2; for (let i = 0; i < k; i++) { const a = idx[i]; r0 += b[a] * C[a * 3]; r1 += b[a] * C[a * 3 + 1]; r2 += b[a] * C[a * 3 + 2]; }
      let mu = 0; for (let j = 0; j < M; j++) { g[j] = 2 * (C[j * 3] * r0 + C[j * 3 + 1] * r1 + C[j * 3 + 2] * r2) + c[j]; if (act[j]) mu += b[j] * g[j]; }
      let add = -1, worst = -1e-12; for (let j = 0; j < M; j++) if (!act[j] && g[j] - mu < worst) { worst = g[j] - mu; add = j; }
      if (add < 0) break; act[add] = 1; idx[k++] = add;
    }
    let e0 = -t0, e1 = -t1, e2 = -t2; for (let j = 0; j < M; j++) { out[j] = b[j]; e0 += b[j] * C[j * 3]; e1 += b[j] * C[j * 3 + 1]; e2 += b[j] * C[j * 3 + 2]; }
    return e0 * e0 + e1 * e1 + e2 * e2;
  }
}
function makeFista(C0, M) {
  // C: Float64Array M*3 in mix space (inks…, garment last). setC swaps the stack without reallocating buffers.
  let C, L, pmu = 0, pref = /** @type {Float64Array | null} */ (null);
  const setC = c => { C = c; L = 0; for (let j = 0; j < M; j++) L += C[j * 3] ** 2 + C[j * 3 + 1] ** 2 + C[j * 3 + 2] ** 2; L = 2 * L + 1e-6 + 2 * pmu; };
  setC(C0);
  const d = new Float64Array(M), x = new Float64Array(M), y = new Float64Array(M), xp = new Float64Array(M), tmp = new Float64Array(M), ld = new Float64Array(M), ex = new Float64Array(M);
  // extra (optional, length M): per-ink penalty added to the locality term, e.g. to keep highlight white out of midtones
  solve.setC = setC;
  // proximity: pmu·|x − ref|² pulls this colour's mix toward a reference mix (its neighbours' average), so among mixes
  // that print alike the one close to its neighbours wins; colour accuracy still comes first. null turns it off.
  solve.setProx = (ref, m) => { pref = ref; pmu = ref ? m : 0; setC(C); };
  return solve;
  function solve(t0, t1, t2, lam, iters, out, extra) {
    let bi = 0;
    for (let j = 0; j < M; j++) { d[j] = (C[j * 3] - t0) ** 2 + (C[j * 3 + 1] - t1) ** 2 + (C[j * 3 + 2] - t2) ** 2; if (d[j] + (extra ? extra[j] : 0) < d[bi] + (extra ? extra[bi] : 0)) bi = j; }
    // The loop below is the plain FISTA step written tight (three passes over the inks, the simplex projection inlined):
    // every sum and product is in the same order as the long form, so the result is the same to the last bit.
    for (let j = 0; j < M; j++) { x[j] = 0; y[j] = 0; ld[j] = lam * d[j]; ex[j] = extra ? extra[j] : 0; }
    x[bi] = 1; y[bi] = 1; let tk = 1;
    for (let it = 0; it < iters; it++) {
      let r0 = -t0, r1 = -t1, r2 = -t2;
      for (let j = 0; j < M; j++) { const yj = y[j], o = j * 3; r0 += yj * C[o]; r1 += yj * C[o + 1]; r2 += yj * C[o + 2]; }
      // gradient step, and the stepped values sorted into tmp (descending) for the projection
      for (let j = 0; j < M; j++) { const o = j * 3, v = y[j] - (2 * (C[o] * r0 + C[o + 1] * r1 + C[o + 2] * r2) + ld[j] + ex[j] + (pref ? 2 * pmu * (y[j] - pref[j]) : 0)) / L; xp[j] = x[j]; x[j] = v;
        let q = j - 1; while (q >= 0 && tmp[q] < v) { tmp[q + 1] = tmp[q]; q--; } tmp[q + 1] = v; }
      let css = 0, th = 0; for (let i = 0; i < M; i++) { css += tmp[i]; const t = (css - 1) / (i + 1); if (i === M - 1 || tmp[i + 1] <= t) { th = t; break; } }
      const tn = (1 + Math.sqrt(1 + 4 * tk * tk)) / 2, mom = (tk - 1) / tn; tk = tn;
      for (let j = 0; j < M; j++) { const xj = Math.max(0, x[j] - th); x[j] = xj; y[j] = xj + mom * (xj - xp[j]); }
    }
    let e0 = -t0, e1 = -t1, e2 = -t2; for (let j = 0; j < M; j++) { out[j] = x[j]; e0 += x[j] * C[j * 3]; e1 += x[j] * C[j * 3 + 1]; e2 += x[j] * C[j * 3 + 2]; }
    return e0 * e0 + e1 * e1 + e2 * e2;
  }
}
function stackColors(inkLabs, garmentLab, n) {
  const M = inkLabs.length + 1, C = new Float64Array(M * 3);
  inkLabs.forEach((lab, i) => C.set(mixFromLab(lab, n), i * 3)); C.set(mixFromLab(garmentLab, n), (M - 1) * 3);
  return { C, M };
}
/* Base-aware ink appearance. With the underbase rule below, the share of an ink's area sitting on white depends only on
   the target color: f = baseFraction(target). Ink off the base prints straight on the shirt at opacity op. Solver, palette
   choice and proof all use the same appearance, so what we optimize is what we print. Highlight white is always full. */
const BASE_KC = +(globalThis.process?.env?.KC || 0.9); // 0.6 → 0.9: 2.892 → 2.828, neutral best at 0.9 (1.2 better on our model, worse on neutral) // chroma boost in the base rule (Trimingham: deep reds and blues need full base)
export function baseFraction(tlab, strength = 0.92, opt = {}) {
  const C = Math.hypot(tlab[1], tlab[2]);
  return smoothstep(opt.lo ?? 20, opt.hi ?? 75, tlab[0] + (opt.kC ?? BASE_KC) * C) * strength;
}
export function makeAppearance(inkLabs, garmentLab, n, op = 0.55) {
  const N = inkLabs.length, full = inkLabs.map(l => mixFromLab(l, n)), gm = mixFromLab(garmentLab, n);
  const dark = full.map((c, i) => inkLabs[i][0] > 92 ? c : c.map((v, k) => op * v + (1 - op) * gm[k]));
  const C = new Float64Array((N + 1) * 3); C.set(gm, N * 3);
  return f => { for (let i = 0; i < N; i++) for (let k = 0; k < 3; k++) C[i * 3 + k] = f * full[i][k] + (1 - f) * dark[i][k]; return C; };
}

/* ───────────── Image samples ─────────────
   5-bit-per-channel histogram of opaque pixels; colors that read as the garment need no ink. */
/** Grading: the ROYGBIV families by CIELAB hue angle (sRGB red ≈ 40°, yellow ≈ 100°, green ≈ 136°, cyan ≈ 196°,
    blue ≈ 306°, magenta ≈ 328°). A color belongs to a family when its chroma is at least 20. */
export const GRADE_HUES = { red: [345, 50], orange: [50, 80], yellow: [80, 110], green: [110, 180], blue: [180, 280], indigo: [280, 310], violet: [310, 345] };
export function gradeFamily(lab) {
  if (Math.hypot(lab[1], lab[2]) < 20) return null; const h = (Math.atan2(lab[2], lab[1]) * 180 / Math.PI + 360) % 360;
  for (const [k, [a, b]] of Object.entries(GRADE_HUES)) if (a < b ? h >= a && h < b : h >= a || h < b) return k; return null;
}
export function imageSamples(px, alpha, P, garmentLab, n, opts = {}) {
  const bins = new Map();
  for (let j = 0; j < P; j++) {
    if (alpha[j] < 128) continue;
    const r = px[j * 3], g = px[j * 3 + 1], b = px[j * 3 + 2], key = (r >> 3) << 10 | (g >> 3) << 5 | (b >> 3);
    let e = bins.get(key); if (!e) { e = [0, 0, 0, 0]; bins.set(key, e); } e[0]++; e[1] += r; e[2] += g; e[3] += b;
  }
  let total = 0; const out = [];
  for (const e of bins.values()) {
    const r = Math.round(e[1] / e[0]), g = Math.round(e[2] / e[0]), b = Math.round(e[3] / e[0]), lab = rgb2lab(r, g, b);
    if (de2000(...lab, ...garmentLab) < (opts.garmentTol ?? 7)) continue;
    out.push({ rgb: [r, g, b], lab, mix: mixFromRGB(r, g, b, n), w: e[0], wt: e[0] * toneWeight(lab, opts.toneBoost ?? 1), graded: false }); total += e[0];
  }
  const minW = total * (opts.rareFrac ?? 0.0005), sal = opts.salience ?? +(globalThis.process?.env?.SAL || 1), grp = opts.groupRare ?? !!(globalThis.process?.env?.GROUP);
  // salience < 1 lifts small, distinct colors in palette choice (weight = pixels^salience)
  if (sal !== 1) for (const s of out) s.wt = Math.pow(s.w, sal) * (s.wt / s.w);
  // grading: colors in the chosen families weigh more in ink choice, and are never dropped as rare
  const grade = new Set(opts.grade || []), gw = opts.gradeBoost ?? 25;
  if (grade.size) for (const s of out) if (grade.has(gradeFamily(s.lab))) { s.wt *= gw; s.graded = true; }
  // rare colors are judged as groups of similar colors, not single shades, so a small but real color is kept
  let kept;
  if (grp) { const key = s => `${Math.floor(s.lab[0] / 10)},${Math.floor(s.lab[1] / 12)},${Math.floor(s.lab[2] / 12)}`, sum = new Map();
    for (const s of out) sum.set(key(s), (sum.get(key(s)) || 0) + s.w);
    kept = out.filter(s => sum.get(key(s)) >= minW); }
  else kept = out.filter(s => s.w >= minW || s.graded);
  return { samples: kept.length >= 4 ? kept : out, total };
}
/* Skin, brown and earth tones are where auto seps fail most (printer reports). Weighting them up in palette choice was
   tested on the 15-image set (boost 3 and 6): it did not help even the skin and earth images, so it is off by default (1). */
export function isEarthTone(lab) {
  const C = Math.hypot(lab[1], lab[2]); let h = Math.atan2(lab[2], lab[1]) * 180 / Math.PI; if (h < 0) h += 360;
  return lab[0] >= 20 && lab[0] <= 90 && C >= 6 && C <= 60 && h >= 25 && h <= 80;
}
function toneWeight(lab, boost) { return isEarthTone(lab) ? boost : 1; }
function topSamples(samples, k) { return samples.length <= k ? samples : samples.slice().sort((a, b) => (b.wt ?? b.w) - (a.wt ?? a.w)).slice(0, k); }

// Weighted reconstruction error (mix space) of a sample set using a given ink set.
// Weighted mean CIEDE2000 between each sample and its best rebuild from the ink set (perceptual, so dark and
// earth-tone errors count as people see them). Uses tone weights when present.
/** @typedef {{ strength: number, op: number } | null} BaseOpt Base-aware appearance options (null: inks always show full color) */
export const PEN = { on: true }; // palette choice uses the same white/shirt penalties as the final solve
/** @param {any[]} inkLabs @param {number[]} garmentLab @param {any[]} samples @param {number} n @param {number} [lam] @param {number} [iters] @param {BaseOpt} [base] */
export function reconError(inkLabs, garmentLab, samples, n, lam = 0.02, iters = 60, base = null) {
  const M = inkLabs.length + 1, app = base ? makeAppearance(inkLabs, garmentLab, n, base.op) : null;
  let { C } = stackColors(inkLabs, garmentLab, n); const solve = makeSolver(C, M), out = new Float64Array(M);
  let e = 0, w = 0;
  for (const s of samples) {
    if (app) { C = app(baseFraction(s.lab, base.strength)); solve.setC(C); }
    solve(s.mix[0], s.mix[1], s.mix[2], lam, iters, out, PEN.on && base ? inkPenalties(inkLabs, garmentLab, s.lab, {}, lam, n) : undefined);
    let m0 = 0, m1 = 0, m2 = 0; for (let j = 0; j < M; j++) { m0 += out[j] * C[j * 3]; m1 += out[j] * C[j * 3 + 1]; m2 += out[j] * C[j * 3 + 2]; }
    const l = mixToLab([m0, m1, m2], n), wt = s.wt ?? s.w;
    e += wt * de2000(...s.lab, ...l); w += wt;
  }
  return e / Math.max(1, w);
}

/* ───────────── Palette: convex-hull vertices of the artwork ─────────────
   Inks are chosen from the corners of the region the art's colors fill in mix space (Tan, Echevarria & Gingold 2018 idea,
   implemented here from the paper). Every candidate is a color that actually occurs in the art. No clustering or centroids. */
/** @param {BaseOpt} [base] */
export function hullPalette(samples, k, fixedLabs, garmentLab, n, lamSel = 0.4, base = null, opts = {}) {
  const need = Math.max(0, k - fixedLabs.length);
  if (!need) return [];
  // never offer a color the fixed inks already cover (e.g. a second white beside the forced highlight white)
  samples = samples.filter(s => !fixedLabs.some(f => de2000(...f, ...s.lab) < 5));
  // few distinct colors (flat spot art): every color is an ink; a hull needs at least 4 non-coplanar points
  if (samples.length <= need) return samples.slice().sort((a, b) => b.w - a.w).map(s => s.lab);
  const pts = samples.map(s => s.mix.slice());
  let verts;
  try { const faces = quickhull(pts); verts = [...new Set(faces.flat())]; } catch { verts = []; }
  if (verts.length < need) verts = samples.map((_, i) => i); // degenerate (flat) color sets: consider every color
  // weight each vertex by local support so single noisy pixels do not become inks
  const cand = verts.map(i => samples[i]).filter(s => s.w > 0);
  // farthest-point thinning to at most 3×need candidates, seeded by the most-used vertex
  const pool = [];
  if (cand.length) {
    const used = fixedLabs.map(l => mixFromLab(l, n)).concat([mixFromLab(garmentLab, n)]);
    const dist = s => Math.min(...used.concat(pool.map(p => p.mix)).map(u => (u[0] - s.mix[0]) ** 2 + (u[1] - s.mix[1]) ** 2 + (u[2] - s.mix[2]) ** 2));
    const limit = Math.min(cand.length, Math.max(need * +(globalThis.process?.env?.POOL || 3), need + 2));
    while (pool.length < limit) {
      let best = null, bd = -1;
      for (const s of cand) { if (pool.includes(s)) continue; const d = dist(s) * Math.log(2 + s.w); if (d > bd) { bd = d; best = s; } }
      if (!best) break; pool.push(best);
    }
  }
  // backward elimination: drop the candidate whose removal costs the least reconstruction error
  const evalSet = topSamples(samples, 500);
  let cur = pool.slice();
  while (cur.length > need) {
    let bi = 0, be = Infinity;
    for (let i = 0; i < cur.length; i++) {
      const trial = cur.filter((_, j) => j !== i).map(s => s.lab);
      const e = reconError(fixedLabs.concat(trial), garmentLab, evalSet, n, lamSel, 60, base);
      if (e < be) { be = e; bi = i; }
    }
    cur.splice(bi, 1);
  }
  // one swap pass: try each discarded candidate in each slot (elimination alone can get stuck)
  if (opts.swap) { // off: tested 2026-11-04, worse on the 15-image set (selection objective differs from the final solve)
    const cost = set => reconError(fixedLabs.concat(set.map(s => s.lab)), garmentLab, evalSet, n, lamSel, 60, base);
    let best = cost(cur);
    for (let i = 0; i < cur.length; i++) for (const c of pool) {
      if (cur.includes(c)) continue; const trial = cur.slice(); trial[i] = c; const e = cost(trial);
      if (e < best - 1e-9) { best = e; cur = trial; }
    }
  }
  return cur.map(s => s.lab);
}

/* ───────────── Palette: subset of the producer's measured ink library ─────────────
   Forward greedy selection, then one pass of swaps. Picks k shelf inks that best rebuild the art. */
const subsetMemo = { sig: "", cost: /** @type {Map<string, number>} */ (new Map()) };
/** @param {BaseOpt} [base] */
/** opts.spotMetric ("oklab" | "lab"): solid spot screens, where each colour prints as its nearest ink or the shirt, not a
    mix. The ink set is then judged by spotError, the rule the spot separation prints by; the mixing objective picked
    inks a spot job cannot blend (vintage heather: White + Golden Yellow for a cream, no navy). */
export function librarySubset(samples, library, k, fixedLabs, garmentLab, n, lamSel = 0.4, base = null, opts = {}) {
  const need = Math.max(0, k - fixedLabs.length);
  const evalSet = topSamples(samples, 400);
  const chosen = [];
  const avail = library.map((ink, i) => i);
  // lamSel: how strongly a color must be built from inks near it. Experts choose inks close to the art's colors; a weak
  // penalty lets the optimizer mix skin from orange + royal + lime, which is accurate on paper and fragile on press.
  // Auto asks for 3, 4, … 10 inks of the same art one after another, and the first picks are the same each time: the cost
  // of an ink set is remembered while the question stays the same (same colors, shelf, garment and settings).
  const sig = [opts.spotMetric || "mix", SOLVER, PEN.on, n, lamSel, base ? base.strength + "/" + base.op : "", garmentLab.join(","), fixedLabs.map(l => l.join(",")).join(";"), library.map(i => i.lab.join(",")).join(";"), evalSet.map(q => q.lab[0] + "," + q.lab[1] + "," + q.lab[2] + "," + q.mix[0] + "," + q.mix[1] + "," + q.mix[2] + "," + q.w + "," + q.wt).join(";")].join("|");
  if (subsetMemo.sig !== sig) { subsetMemo.sig = sig; subsetMemo.cost = new Map(); }
  const memo = subsetMemo.cost;
  const err = labs => opts.spotMetric ? spotError(evalSet, labs, garmentLab, opts.spotMetric) : reconError(labs, garmentLab, evalSet, n, lamSel, 45, base);
  const cost = idx => { const key = idx.join(","); let e = memo.get(key); if (e === undefined) { e = err(fixedLabs.concat(idx.map(i => library[i].lab))); memo.set(key, e); } return e; };
  for (let s = 0; s < need && avail.length; s++) {
    let bi = -1, be = Infinity;
    for (const i of avail) { if (chosen.includes(i)) continue; const e = cost(chosen.concat([i])); if (e < be) { be = e; bi = i; } }
    if (bi < 0) break; chosen.push(bi);
  }
  let best = cost(chosen);
  for (let pass = 0, passes = +(globalThis.process?.env?.SWAPS || 1); pass < passes; pass++) for (let p = 0; p < chosen.length; p++) {
    for (const i of avail) {
      if (chosen.includes(i)) continue;
      const trial = chosen.slice(); trial[p] = i; const e = cost(trial);
      if (e < best - 1e-9) { best = e; chosen[p] = i; }
    }
  }
  return chosen;
}

/* ───────────── Separation ───────────── */
const smoothstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
/* Penalty vector per target color: highlight white only in true highlights (light, low chroma), and the shirt preferred
   for colors close to it so dark shirts carry the blacks for free. */
export function inkPenalties(inkLabs, garmentLab, tlab, opt = {}, lam = 0, n = 1.7) {
  const M = inkLabs.length + 1, pen = new Float64Array(M), hwL = opt.hwL ?? 74, hwC = opt.hwC ?? 30, C = Math.hypot(tlab[1], tlab[2]);
  // White makes grays on a dark shirt (white dots on black), so neutrals may use it at any lightness. What experts keep
  // white out of is COLORED midtones (chalky skin, washed reds): penalize by chroma, and by darkness only once colored.
  for (let j = 0; j < inkLabs.length; j++) if (inkLabs[j][0] > 92) pen[j] = 0.6 * smoothstep(hwC, hwC + 20, C) * (1 - smoothstep(68, 80, tlab[0])) + 0.6 * (1 - smoothstep(hwL - 10, hwL + 6, tlab[0])) * smoothstep(15, 30, C);
  pen[M - 1] = -0.5 * (1 - smoothstep(0, 18, de2000(...tlab, ...garmentLab))) * (opt.shirtPref ?? 1) * 0.05;
  // Grays on a dark shirt are white dots on the shirt (how printers make them). For neutral targets, cancel the locality
  // penalty on white and the shirt so the solver is not pushed to a nearby brown or teal of the wrong hue.
  const neutral = lam > 0 ? 1 - smoothstep(4, 14, C) : 0;
  if (neutral > 0) {
    const t = mixFromLab(tlab, n), dist = l => { const m = mixFromLab(l, n); return (m[0] - t[0]) ** 2 + (m[1] - t[1]) ** 2 + (m[2] - t[2]) ** 2; };
    for (let j = 0; j < inkLabs.length; j++) if (inkLabs[j][0] > 92) pen[j] -= lam * dist(inkLabs[j]) * neutral;
    pen[M - 1] -= lam * dist(garmentLab) * neutral;
  }
  return pen;
}
/** How one colour's coverage prints once the press's stack limit trims the hidden ink: ΔE00 to the target, averaged
    over the dot-overlap cases (concentric to random), with the base showing where it is wider than the inks on it.
    The same forward model as robustScore, for one spot. */
const _sv = new Float64Array(32), _sp = new Float64Array(32);
function stackedDE(x, N, u, tl, stk, inkLabs, garmentLab, n, op) {
  const v = _sv.subarray(0, N), pr = _sp.subarray(0, N); for (let j = 0; j < N; j++) v[j] = x[j];
  visibleToPrinted(v, N, pr, stk.overprint, stk.rho);
  let st = 0, vis = 0; for (let j = 0; j < N; j++) { st += pr[j]; vis += v[j]; } // colour screens only, base not counted
  if (st > stk.limit) { const k = vis >= stk.limit ? 0 : (stk.limit - vis) / Math.max(1e-6, st - vis); for (let j = 0; j < N; j++) pr[j] = v[j] + k * (pr[j] - v[j]); }
  const gm = mixFromLab(garmentLab, n), wm = mixFromLab([96, 0, 1.5], n), rhos = stk.rhos || [0, 0.5, 1]; let e = 0;
  for (const rho of rhos) {
    let maxLater = 0, freeLater = 1, m0 = 0, m1 = 0, m2 = 0, sv = 0; const vis2 = new Float64Array(N);
    for (let k = N - 1; k >= 0; k--) { const a = pr[k], conc = Math.max(0, a - maxLater), rnd = a * freeLater; vis2[k] = (1 - rho) * conc + rho * rnd; sv += vis2[k]; if (a > maxLater) maxLater = a; freeLater *= 1 - a; }
    const cover = Math.min(1, sv), baseShow = Math.min(1 - cover, (1 - rho) * Math.max(0, u - maxLater) + rho * u * freeLater), f = cover > 1e-4 ? Math.min(1, u / cover) : 1, g = Math.max(0, 1 - cover - baseShow);
    m0 = g * gm[0] + baseShow * wm[0]; m1 = g * gm[1] + baseShow * wm[1]; m2 = g * gm[2] + baseShow * wm[2];
    for (let k = 0; k < N; k++) { const full = mixFromLab(inkLabs[k], n), hl = inkLabs[k][0] > 92 ? 1 : f, w = vis2[k];
      for (let c = 0; c < 3; c++) { const d = hl * full[c] + (1 - hl) * (op * full[c] + (1 - op) * gm[c]); if (c === 0) m0 += w * d; else if (c === 1) m1 += w * d; else m2 += w * d; } }
    const l = mixToLab([m0, m1, m2], n); e += de2000(tl[0], tl[1], tl[2], l[0], l[1], l[2]);
  }
  return e / rhos.length;
}
/** @param {any} a */
/** The film's rounding of a coverage vector (inks under the smallest dot drop out or round up; the garment takes the rest). */
function filmRound(x, N, minDot, out) {
  let s = 0; for (let j = 0; j < N; j++) { let a = x[j]; if (a < minDot) a = a < minDot / 2 ? 0 : minDot; out[j] = a; s += a; }
  out[N] = Math.max(0, 1 - s); return out;
}
/** Squared error in mix space of a coverage vector against a target, the solver's own objective without locality. */
function mixErr(x, C, M, t) { let e0 = -t[0], e1 = -t[1], e2 = -t[2]; for (let j = 0; j < M; j++) { e0 += x[j] * C[j * 3]; e1 += x[j] * C[j * 3 + 1]; e2 += x[j] * C[j * 3 + 2]; } return e0 * e0 + e1 * e1 + e2 * e2; }
/** The smooth ink map: all table colours the art touches are solved together instead of one by one. Per colour the
    objective is the plain solve's (mix-space error, locality, white/shirt penalties) plus a soft stack-limit penalty on
    the films' colour stack (hidden dots included, same ramp as the films); between neighbouring table colours a
    Laplacian term μ‖x_a − x_b‖² ties the recipes, so no colour can switch recipe alone: where one recipe hands over to
    another it does so across the table, not at a contour in the art. Out-of-gamut colours land on the nearest printable
    mix the same way, so their compression is smooth too. Projected gradient (FISTA) on the simplex of every colour,
    warm-started from the plain table; the result replaces the table that pixels then interpolate. */
export function smoothMapSolve({ lut, need, G, M, N, n, lam, inkLabs, garmentLab, hw, base, app, C0, stk, gates, mu = 0.01, kappa = 0.05, hid = 0, iters = 300 }) {
  const ids = []; for (let i = 0; i < G * G * G; i++) if (need[i]) ids.push(i);
  const K = ids.length; if (!K) return;
  const slot = new Int32Array(G * G * G).fill(-1); ids.forEach((id, k) => { slot[id] = k; });
  const C = new Float64Array(K * M * 3), T = new Float64Array(K * 3), lin = new Float64Array(K * M), L = new Float64Array(K), nb = new Int32Array(K * 6).fill(-1), deg = new Uint8Array(K);
  for (let k = 0; k < K; k++) {
    const id = ids[k], r = (id / (G * G)) | 0, g = ((id / G) | 0) % G, b = id % G;
    const R = Math.round(r * 255 / (G - 1)), Gg = Math.round(g * 255 / (G - 1)), B = Math.round(b * 255 / (G - 1));
    const tl = rgb2lab(R, Gg, B), t = mixFromRGB(R, Gg, B, n), pen = accentGatePen(gates, tl, inkPenalties(inkLabs, garmentLab, tl, hw, lam, n));
    const Cn = app ? app(baseFraction(tl, base.strength)) : C0; C.set(Cn.subarray(0, M * 3), k * M * 3); T.set(t, k * 3);
    let fro = 0; for (let j = 0; j < M; j++) { const d = (Cn[j * 3] - t[0]) ** 2 + (Cn[j * 3 + 1] - t[1]) ** 2 + (Cn[j * 3 + 2] - t[2]) ** 2; lin[k * M + j] = lam * d + pen[j]; fro += Cn[j * 3] ** 2 + Cn[j * 3 + 1] ** 2 + Cn[j * 3 + 2] ** 2; }
    let e = 0; for (const [dr, dg, db] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) { const rr = r + dr, gg = g + dg, bb = b + db;
      if (rr < 0 || gg < 0 || bb < 0 || rr >= G || gg >= G || bb >= G) continue; const q = slot[(rr * G + gg) * G + bb]; if (q >= 0) nb[k * 6 + e++] = q; }
    deg[k] = e; L[k] = 2 * fro + 4 * mu * 6 + (stk && stk.limit > 0 ? 2 * kappa * N * N * 4 : 0) + 1e-6;
  }
  // warm start: the plain table
  const x = new Float64Array(K * M), y = new Float64Array(K * M), xp = new Float64Array(K * M), grad = new Float64Array(K * M), tmp = new Float64Array(M), v = new Float64Array(N), pr = new Float64Array(N);
  for (let k = 0; k < K; k++) for (let j = 0; j < M; j++) x[k * M + j] = y[k * M + j] = lut[ids[k] * M + j];
  // colour stack the films print (hidden dots included) and its excess over the limit
  const stackOf = (src, o) => { for (let j = 0; j < N; j++) v[j] = Math.max(0, src[o + j]); visibleToPrinted(v, N, pr, stk.overprint, stk.rho); let s = 0; for (let j = 0; j < N; j++) s += pr[j]; return s; };
  let tk = 1;
  for (let it = 0; it < iters; it++) {
    for (let k = 0; k < K; k++) {
      const o = k * M, co = k * M * 3; let r0 = -T[k * 3], r1 = -T[k * 3 + 1], r2 = -T[k * 3 + 2];
      for (let j = 0; j < M; j++) { const yj = y[o + j]; r0 += yj * C[co + j * 3]; r1 += yj * C[co + j * 3 + 1]; r2 += yj * C[co + j * 3 + 2]; }
      for (let j = 0; j < M; j++) { let gr = 2 * (C[co + j * 3] * r0 + C[co + j * 3 + 1] * r1 + C[co + j * 3 + 2] * r2) + lin[o + j];
        for (let e = 0; e < deg[k]; e++) gr += 2 * mu * (y[o + j] - y[nb[k * 6 + e] * M + j]); grad[o + j] = gr; }
      if (stk && stk.limit > 0 && (kappa > 0 || hid > 0)) { const s0 = stackOf(y, o), ex = s0 - stk.limit;
        // hidden ink (film area under later dots) costs a little too, so a trace ink under large later dots goes to zero
        // smoothly instead of growing a large film for a thin ring
        if (ex > 0 || hid > 0) { const h = 1e-4, gw = 2 * kappa * Math.max(0, ex) + hid; for (let j = 0; j < N; j++) { const keep = y[o + j]; y[o + j] = keep + h; const ds = (stackOf(y, o) - s0) / h; y[o + j] = keep; grad[o + j] += gw * ds - hid; } } }
    }
    const tn = (1 + Math.sqrt(1 + 4 * tk * tk)) / 2, mom = (tk - 1) / tn; tk = tn;
    for (let k = 0; k < K; k++) { const o = k * M, st = 1 / L[k];
      for (let j = 0; j < M; j++) tmp[j] = y[o + j] - st * grad[o + j];
      projSimplexInto(tmp, M);
      for (let j = 0; j < M; j++) { xp[o + j] = x[o + j]; x[o + j] = tmp[j]; } }
    for (let i = 0; i < K * M; i++) y[i] = x[i] + mom * (x[i] - xp[i]);
  }
  for (let k = 0; k < K; k++) for (let j = 0; j < M; j++) lut[ids[k] * M + j] = x[k * M + j];
}
/** Euclidean projection onto the simplex {x ≥ 0, Σx = 1}, in place (sort-based, Duchi et al. 2008). */
// The values sorted descending by insertion into a reused buffer (M is a handful of inks): the same values in the same
// order as the array sort, so the result is the same to the last bit, without an array and a comparator call per step
// (the sort was half the time of a full-size separation on the hue wheel).
let _ps = new Float64Array(16);
function projSimplexInto(x, M) {
  if (_ps.length < M) _ps = new Float64Array(M);
  const s = _ps; for (let j = 0; j < M; j++) { const v = x[j]; let q = j - 1; while (q >= 0 && s[q] < v) { s[q + 1] = s[q]; q--; } s[q + 1] = v; }
  let css = 0, th = 0;
  for (let i = 0; i < M; i++) { css += s[i]; const t = (css - 1) / (i + 1); if (i === M - 1 || s[i + 1] <= t) { th = t; break; } }
  for (let j = 0; j < M; j++) x[j] = Math.max(0, x[j] - th);
}
/** A fixed pseudo-random number in [0, 1) for integer n (integer hash), so a dither is the same on every run. */
export function hashUnit(n) { let h = Math.imul((n | 0) ^ 0x5bd1e995, 0x27d4eb2d); h ^= h >>> 15; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; return (h >>> 0) / 4294967296; }
export function separateSim({ px, alpha, W, H, inkLabs, garmentLab, n, smooth, hw, base, opts = {} }) {
  const maxInks = /** @type {any} */ (opts).maxInks ?? +(globalThis.process?.env?.MAXINKS || 0);
  const lam = 0.02 + 2.5 * smooth * smooth, G = /** @type {any} */ (opts).lutG || +(globalThis.process?.env?.LUTG || 25); // 25: tested 17/21/25 on the 15-image set, 25 best (3.088 -> 3.072)
  const st = stackColors(inkLabs, garmentLab, n), M = st.M, N = M - 1, app = base ? makeAppearance(inkLabs, garmentLab, n, base.op) : null;
  const solve = makeSolver(st.C, M);
  const lut = new Float32Array(G * G * G * M), tmp = new Float64Array(M), alt = new Float64Array(M), rnd = new Float64Array(M), rnd2 = new Float64Array(M);
  const minDot = /** @type {any} */ (opts).minDot || 0, sm = /** @type {any} */ (opts).smoothMap;
  // Only the table nodes the art's colors touch are solved (each pixel reads the 8 nodes around its color): a design
  // uses a small part of the color cube, and the result is the same as solving every node. With the faster sort in
  // projSimplex: Auto on two test images 27.2 -> 12.9 s and 22.1 -> 11.2 s, same picks.
  const P0 = W * H, f0 = (G - 1) / 255, need = new Uint8Array(G * G * G);
  for (let p = 0; p < P0; p++) { if (alpha[p] < 8) continue;
    const r0 = Math.min(G - 2, (px[p * 3] * f0) | 0), g0 = Math.min(G - 2, (px[p * 3 + 1] * f0) | 0), b0 = Math.min(G - 2, (px[p * 3 + 2] * f0) | 0), o = (r0 * G + g0) * G + b0;
    need[o] = need[o + 1] = need[o + G] = need[o + G + 1] = need[o + G * G] = need[o + G * G + 1] = need[o + G * G + G] = need[o + G * G + G + 1] = 1; }
  const solveNode = (r, g, b) => {
    const R = Math.round(r * 255 / (G - 1)), Gg = Math.round(g * 255 / (G - 1)), B = Math.round(b * 255 / (G - 1));
    const tl = rgb2lab(R, Gg, B), t = mixFromRGB(R, Gg, B, n), pen = accentGatePen(/** @type {any} */ (opts).accentGates, tl, inkPenalties(inkLabs, garmentLab, tl, hw, lam, n));
    const Cn = app ? app(baseFraction(tl, base.strength)) : st.C; if (app) solve.setC(Cn);
    solve(t[0], t[1], t[2], lam, ITERS, tmp, pen);
    // Film-aware: an ink under the smallest dot cannot print as solved (the film drops it or rounds it up). Compare the
    // two printable answers, the film's rounding of this solution, and a re-solve with those inks left out so other
    // screens carry the tone, and keep the closer one.
    if (minDot > 0 && !sm) {
      const small = []; for (let j = 0; j < N; j++) if (tmp[j] > 1e-4 && tmp[j] < minDot) small.push(j);
      if (small.length) {
        const rA = filmRound(tmp, N, minDot, rnd), eA = mixErr(rnd, Cn, M, t);
        const pen2 = Float64Array.from(pen); for (const j of small) pen2[j] += 50; solve(t[0], t[1], t[2], lam, 160, alt, pen2);
        filmRound(alt, N, minDot, rnd2); const eB = mixErr(rnd2, Cn, M, t);
        tmp.set(eB < eA ? alt : tmp); void rA;
      }
    }
    // Stack-aware: one angle means each ink is printed under the later ones (hidden ink), so a three-ink mix can need
    // 300-450% of ink with the base. The press's stack limit then trims the hidden ink after the fact, the dots shrink and
    // the white base shows between them (the pale band in the sample's sunset). Where this mix would pass the limit, the
    // colour is solved again with only its two strongest inks, so the films can print what the solve planned.
    const stk = /** @type {any} */ (opts).stack;
    if (stk && stk.limit > 0 && N > 2 && !sm) {
      const v = tmp.subarray(0, N), pr = new Float64Array(N); visibleToPrinted(v, N, pr, stk.overprint, stk.rho);
      let s = app ? baseFraction(tl, base.strength) : 0; for (let j = 0; j < N; j++) s += pr[j];
      if (s > stk.limit) {
        // compare the two printable answers by how each prints after the press trims it (base showing included)
        const order = [...Array(N).keys()].sort((i, j) => tmp[j] - tmp[i]), keep = new Set(order.slice(0, 2));
        if (order.slice(2).some(i => tmp[i] > 0.005)) { const pen2 = Float64Array.from(pen); for (let j = 0; j < N; j++) if (!keep.has(j)) pen2[j] += 50; solve(t[0], t[1], t[2], lam, 160, alt, pen2);
          const u = app ? baseFraction(tl, base.strength) : 0, eA = stackedDE(tmp, N, u, tl, stk, inkLabs, garmentLab, n, base ? base.op : 0.55), eB = stackedDE(alt, N, u, tl, stk, inkLabs, garmentLab, n, base ? base.op : 0.55);
          if (eB < eA) tmp.set(alt); }
      }
    }
    // Interlocked screens: two inks per spot, chosen softly. A third ink is held back by a penalty that grows from zero
    // as it falls below the second-strongest by up to softPair, so where two inks trade places the pair hands over
    // through a short three-ink blend instead of switching at once (a hard "two strongest" made steps in gradients).
    const softPair = /** @type {any} */ (opts).softPair;
    if (softPair && N > 2) {
      const order = [...Array(N).keys()].sort((i, j) => tmp[j] - tmp[i]), v2 = tmp[order[1]];
      if (order.slice(2).some(i => tmp[i] > 0.005)) { const pen2 = Float64Array.from(pen); for (const j of order.slice(2)) pen2[j] += 50 * smoothstep(0, softPair, v2 - tmp[j]); solve(t[0], t[1], t[2], lam, 160, tmp, pen2); }
    }
    // At most maxInks inks per spot (standard in multi-ink separation): keeps the ink stack under the shop's limit,
    // since every extra same-angle ink adds hidden ink under the ones printed after it. Re-solve with only the top inks.
    if (maxInks && maxInks < N) {
      const order = [...Array(N).keys()].sort((i, j) => tmp[j] - tmp[i]), keep = new Set(order.slice(0, maxInks));
      if (order.slice(maxInks).some(i => tmp[i] > 0.005)) { for (let j = 0; j < N; j++) if (!keep.has(j)) pen[j] += 50; solve(t[0], t[1], t[2], lam, ITERS, tmp, pen); }
    }
    const o = ((r * G + g) * G + b) * M; for (let j = 0; j < M; j++) lut[o + j] = tmp[j];
  };
  for (let r = 0; r < G; r++) for (let g = 0; g < G; g++) for (let b = 0; b < G; b++) if (need[(r * G + g) * G + b]) solveNode(r, g, b);
  // Smooth recipes: many colours (grays, skin, colours with many inks) can be mixed several ways that print alike, and
  // each table colour solved on its own picks any of them, so the recipe zigzags from colour to colour: ink amounts swing
  // while the colour barely moves, which prints as banding once the press drifts or dots spread. Each pass solves every
  // table colour again, pulled toward its neighbours' mixes (colour accuracy still first).
  if (sm) smoothMapSolve({ lut, need, G, M, N, n, lam, inkLabs, garmentLab, hw, base, app, C0: st.C, stk: /** @type {any} */ (opts).stack, gates: /** @type {any} */ (opts).accentGates, mu: sm.mu, kappa: sm.kappa, hid: sm.hid, iters: sm.iters });
  const passes = sm ? 0 : /** @type {any} */ (opts).smoothPasses ?? 0, pm = /** @type {any} */ (opts).smoothMu ?? 0.05;
  if (passes > 0 && /** @type {any} */ (solve).setProx) {
    const ref = new Float64Array(M), plain = Float32Array.from(lut), tol = /** @type {any} */ (opts).smoothTol ?? +(globalThis.process?.env?.SMOOTHTOL || 0.004);
    for (let pass = 0; pass < passes; pass++) {
      const prev = Float32Array.from(lut);
      for (let r = 0; r < G; r++) for (let g = 0; g < G; g++) for (let b = 0; b < G; b++) {
        if (!need[(r * G + g) * G + b]) continue; ref.fill(0); let k = 0;
        for (const [dr, dg, db] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) { const rr = r + dr, gg = g + dg, bb = b + db;
          if (rr < 0 || gg < 0 || bb < 0 || rr >= G || gg >= G || bb >= G || !need[(rr * G + gg) * G + bb]) continue; const q = ((rr * G + gg) * G + bb) * M; for (let j = 0; j < M; j++) ref[j] += prev[q + j]; k++; }
        if (!k) continue; for (let j = 0; j < M; j++) ref[j] /= k;
        /** @type {any} */ (solve).setProx(ref, pm); solveNode(r, g, b);
        // only among mixes that print alike: the smoothed mix is kept when its colour is as close as the plain one's
        // (within smoothTol in mix space); otherwise the plain mix stays (the extremes keep their accuracy)
        const o = ((r * G + g) * G + b) * M, R = Math.round(r * 255 / (G - 1)), Gg = Math.round(g * 255 / (G - 1)), B = Math.round(b * 255 / (G - 1));
        const tl = rgb2lab(R, Gg, B), t = mixFromRGB(R, Gg, B, n), Cn = app ? app(baseFraction(tl, base.strength)) : st.C;
        const xs = Float64Array.from(lut.subarray(o, o + M)), xp = Float64Array.from(plain.subarray(o, o + M));
        if (Math.sqrt(mixErr(xs, Cn, M, t)) > Math.sqrt(mixErr(xp, Cn, M, t)) + tol) for (let j = 0; j < M; j++) lut[o + j] = plain[o + j]; }
      /** @type {any} */ (solve).setProx(null, 0);
    }
  }
  const P = W * H, f = (G - 1) / 255, acc = new Float32Array(M);
  const look = dz => { const cov = new Float32Array(P * N);
  for (let p = 0; p < P; p++) {
    if (alpha[p] < 8) continue;
    // DITHER: triangular noise of ±1 level, the same on all three channels (lightness grain only), fixed per pixel
    const z = dz && hashUnit(p) + hashUnit(p + 0x9e3779b9) - 1, cl = c => Math.max(0, Math.min(255, px[p * 3 + c] + z)) * f;
    const r = cl(0), g = cl(1), b = cl(2);
    const r0 = Math.min(G - 2, r | 0), g0 = Math.min(G - 2, g | 0), b0 = Math.min(G - 2, b | 0), fr = r - r0, fg = g - g0, fb = b - b0; acc.fill(0);
    for (let c = 0; c < 8; c++) {
      const dr = c & 1, dg = (c >> 1) & 1, db = (c >> 2) & 1, w = (dr ? fr : 1 - fr) * (dg ? fg : 1 - fg) * (db ? fb : 1 - fb); if (w === 0) continue;
      const o = (((r0 + dr) * G + (g0 + dg)) * G + (b0 + db)) * M; for (let j = 0; j < M; j++) acc[j] += w * lut[o + j];
    }
    const a = alpha[p] / 255; for (let i = 0; i < N; i++) cov[p * N + i] = acc[i] * a;
  }
  return cov; };
  // the same table read again with the dither (DITHER), once the screens are decided: cov.dithered()
  const d0 = /** @type {any} */ (opts).dither ? 1 : 0, cov = look(d0); Object.defineProperty(cov, "dithered", { value: () => d0 ? cov : look(1) });
  return cov;
}
/* OKLab (Björn Ottosson, 2020) from CIELAB via linear sRGB. Distances in OKLab track perceived difference far better
   than plain CIELAB distance for clustering; on the real-art test, k-means in OKLab (color.separator v12) was the best
   hard-plate separator. Out-of-gamut values stay signed (cbrt of a negative). */
export function lab2oklab(L, a, b) {
  const [r, g, bl] = lab2lin(L, a, b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * bl), m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * bl), s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * bl);
  return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s, 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
}
/* Spot palette: weighted k-means in OKLab over the art's colors (shirt-colored samples are already left out by
   imageSamples, so no ink is spent on the background). Seeded deterministically (k-means++ with the farthest weighted
   sample instead of a random one), so the same art always gives the same inks. Each ink is the weighted mean CIELAB of
   its cluster: a color the art actually shows. Fixed inks (locked by the user) are fixed centers. Returns CIELAB inks. */
export function kmeansPalette(samples, k, fixedLabs = [], opts = {}) {
  const need = Math.max(0, k - fixedLabs.length); if (!need || !samples.length) return [];
  const X = samples.map(s => lab2oklab(...s.lab)), w = samples.map(s => s.wt ?? s.w ?? 1), n = X.length;
  const d2 = (p, q) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
  const fixed = fixedLabs.map(l => lab2oklab(...l));
  const C = []; let best = 0; for (let i = 1; i < n; i++) if (w[i] > w[best]) best = i;
  if (!fixed.length) C.push(X[best].slice());
  const dmin = new Float64Array(n).fill(Infinity), upd = c => { for (let i = 0; i < n; i++) dmin[i] = Math.min(dmin[i], d2(X[i], c)); };
  for (const f of fixed) upd(f); for (const c of C) upd(c);
  while (C.length < need) { let bi = -1, bv = 0; for (let i = 0; i < n; i++) { const v = w[i] * dmin[i]; if (v > bv) { bv = v; bi = i; } } if (bi < 0) break; C.push(X[bi].slice()); upd(X[bi]); }
  const all = () => fixed.concat(C), lab = C.map(() => [0, 0, 0]), asg = new Int32Array(n);
  for (let it = 0; it < (opts.iters ?? 30); it++) {
    const cs = all(), sum = C.map(() => [0, 0, 0, 0]); let moved = 0;
    for (let i = 0; i < n; i++) { let bj = 0, bd = Infinity; for (let j = 0; j < cs.length; j++) { const d = d2(X[i], cs[j]); if (d < bd) { bd = d; bj = j; } } if (asg[i] !== bj) moved++; asg[i] = bj;
      const j = bj - fixed.length; if (j >= 0) { const s = sum[j]; s[0] += w[i] * X[i][0]; s[1] += w[i] * X[i][1]; s[2] += w[i] * X[i][2]; s[3] += w[i]; } }
    sum.forEach((s, j) => { if (s[3] > 0) C[j] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]]; });
    if (!moved && it) break;
  }
  const acc = C.map(() => [0, 0, 0, 0]);
  for (let i = 0; i < n; i++) { const j = asg[i] - fixed.length; if (j < 0) continue; const L = samples[i].lab, a = acc[j]; a[0] += w[i] * L[0]; a[1] += w[i] * L[1]; a[2] += w[i] * L[2]; a[3] += w[i]; }
  return acc.filter(a => a[3] > 0).map(a => [a[0] / a[3], a[1] / a[3], a[2] / a[3]]);
}
/** Spot palette quality: weighted mean ΔE00 from each art color to the ink (or the shirt) it would print as, with the
    same nearest rule (OKLab or CIELAB) the spot separation uses. */
export function spotError(samples, inkLabs, garmentLab, metric = "oklab") {
  const ok = metric === "oklab", cands = inkLabs.concat([garmentLab]), cv = ok ? cands.map(c => lab2oklab(...c)) : cands; let e = 0, w = 0;
  for (const s of samples) { const o = ok ? lab2oklab(...s.lab) : s.lab; let bi = 0, bd = Infinity;
    for (let i = 0; i < cv.length; i++) { const d = (o[0] - cv[i][0]) ** 2 + (o[1] - cv[i][1]) ** 2 + (o[2] - cv[i][2]) ** 2; if (d < bd) { bd = d; bi = i; } }
    const wt = s.wt ?? s.w ?? 1; e += wt * de2000(...s.lab, ...cands[bi]); w += wt; }
  return e / Math.max(1e-9, w);
}
/** Solid spot screens: each pixel takes the nearest ink, or the shirt (no ink). metric "oklab" (spot v2) or "lab" (old). */
export function separateSpot({ lab, alpha, W, H, inkLabs, garmentLab, metric = "lab" }) {
  const N = inkLabs.length, P = W * H, cands = inkLabs.concat([garmentLab]), ok = metric === "oklab", cv = ok ? cands.map(c => lab2oklab(...c)) : cands;
  const idx = new Uint8Array(P), cache = ok ? new Map() : null;
  for (let p = 0; p < P; p++) {
    if (alpha[p] < 128) { idx[p] = N; continue; }
    let bi = 0, bd = Infinity, L = lab[p * 3], A = lab[p * 3 + 1], B = lab[p * 3 + 2];
    if (ok) { const key = Math.round(L * 4) * 1e8 + Math.round(A * 4 + 2000) * 1e4 + Math.round(B * 4 + 2000); let o = cache.get(key); if (!o) { o = lab2oklab(L, A, B); cache.set(key, o); } [L, A, B] = o; }
    for (let i = 0; i <= N; i++) { const c = cv[i], d = (L - c[0]) ** 2 + (A - c[1]) ** 2 + (B - c[2]) ** 2; if (d < bd) { bd = d; bi = i; } }
    idx[p] = bi;
  }
  return { idx, cov: indexToCov(idx, N, P) };
}
export function indexToCov(idx, N, P) { const cov = new Float32Array(P * N); for (let p = 0; p < P; p++) if (idx[p] < N) cov[p * N + idx[p]] = 1; return cov; }
/* Index shades (Dream Shirt Studios, "index separation", 02:20 and 03:08): on a dark shirt each ink that gets base has
   two colors, the ink over base and the same ink straight on the shirt (darker), at no extra screen. With noBase (a
   Uint8Array of P, filled here) the diffusion picks between both per pixel and marks the bare ones; the underbase
   (buildUnderbase opt.noBase) then leaves them out. The bare color is the proof's: op·ink + (1 − op)·shirt in mix space. */
export function separateIndex({ px, alpha, W, H, inkLabs, garmentLab, n, noBase = /** @type {Uint8Array | null} */ (null), op = 0.55, solidCut = /** @type {number | undefined} */ (undefined) }) {
  const N = inkLabs.length, P = W * H, cm = inkLabs.concat([garmentLab]).map(l => mixFromLab(l, n));
  // candidate colors: 0..N-1 inks (as drawn down), N garment, N+1.. bare shades of the based inks (owner in ink[])
  const ink = Array.from({ length: N + 1 }, (_, i) => i);
  if (noBase) { const w = solidBaseInks(inkLabs, garmentLab, solidCut), gm = cm[N];
    for (let i = 0; i < N; i++) if (w[i] && inkLabs[i][0] <= 92) { cm.push(cm[i].map((v, k) => op * v + (1 - op) * gm[k])); ink.push(i); } }
  const M = cm.length;
  const buf = new Float32Array(P * 3); for (let p = 0; p < P; p++) buf.set(mixFromRGB(px[p * 3], px[p * 3 + 1], px[p * 3 + 2], n), p * 3);
  const cov = new Float32Array(P * N);
  // serpentine scan: alternate direction each row so diffusion does not streak one way
  for (let y = 0; y < H; y++) for (let xi = 0; xi < W; xi++) {
    const dir = (y & 1) ? -1 : 1, x = dir > 0 ? xi : W - 1 - xi;
    const p = y * W + x; if (alpha[p] < 128) continue;
    const v0 = buf[p * 3], v1 = buf[p * 3 + 1], v2 = buf[p * 3 + 2]; let bi = 0, bd = Infinity;
    for (let i = 0; i < M; i++) { const c = cm[i], d = (v0 - c[0]) ** 2 + (v1 - c[1]) ** 2 + (v2 - c[2]) ** 2; if (d < bd) { bd = d; bi = i; } }
    if (ink[bi] < N) cov[p * N + ink[bi]] = 1; if (noBase && bi > N) noBase[p] = 1;
    const e0 = v0 - cm[bi][0], e1 = v1 - cm[bi][1], e2 = v2 - cm[bi][2];
    const sp = (xx, yy, w) => { if (xx < 0 || xx >= W || yy >= H) return; const q = (yy * W + xx) * 3; buf[q] += e0 * w; buf[q + 1] += e1 * w; buf[q + 2] += e2 * w; };
    sp(x + dir, y, 7 / 16); sp(x - dir, y + 1, 3 / 16); sp(x, y + 1, 5 / 16); sp(x + dir, y + 1, 1 / 16);
  }
  return cov;
}

/* ───────────── Underbase ───────────── */
/* Expert-style underbase (Trimingham, Fresener): driven by how light AND how saturated the target color is, so
   reds and royals get more white, not less; given contrast with an S-curve; never larger than the color dots above it,
   so with one screen angle the base hides under the colors instead of peeking out as white halos. */
/** Solid plates (spot, index): 1 for each ink that prints on base, 0 for an ink as dark as the shirt. The cut uses the
    Sim base rule (lightness + chroma); skipped only when the shirt is no more than 10 L lighter than the ink: a navy on
    a heather shirt still needs base. */
export function solidBaseInks(inkLabs, garmentLab, cut = 0.15, opt = {}) {
  const gL = garmentLab ? garmentLab[0] : 0;
  return inkLabs.map(l => !cut || baseFraction(l, 1, opt) >= cut || gL > l[0] + 10 ? 1 : 0);
}
export function buildUnderbase(cov, N, P, lab, strength = 0.92, opt = {}) {
  if (opt.solid) { // spot and index: solid plates get full base (choked at film resolution) under every ink that needs it
    // An ink as dark as the shirt prints without base (navy, dark brown on black): white under it would only lighten it.
    // The cut uses the Sim base rule (lightness + chroma). 0.15 on the 17-image set, black shirts, 27 spot jobs: mean ΔE00
    // 8.42 → 8.34, none worse; held-out set (21 jobs): 8.99 → 8.93, better on 6, none worse. 0.5 was worse on 5.
    const w = opt.inkLabs ? solidBaseInks(opt.inkLabs, opt.garmentLab, opt.solidCut, opt) : new Array(N).fill(1), nb = opt.noBase;
    // index shades: pixels the diffusion printed as the bare shade of their ink get no base
    const ub = new Float32Array(P); for (let p = 0; p < P; p++) { if (nb && nb[p]) continue; let s = 0; for (let i = 0; i < N; i++) s += cov[p * N + i] * w[i]; ub[p] = Math.min(1, s) * strength; } return ub;
  }
  // Base follows lightness plus a chroma boost (L + kC·C): full under reds, royals, skin and pastels; almost none under
  // navies, dark browns and anything the shirt nearly carries, so misregistration cannot flash white under darks.
  const ub = new Float32Array(P), lo = opt.lo ?? 20, hi = opt.hi ?? 75, kC = opt.kC ?? BASE_KC;
  for (let p = 0; p < P; p++) {
    let s = 0; for (let i = 0; i < N; i++) s += cov[p * N + i];
    if (s <= 0.002) continue;
    // Near-solid areas get full base whatever their color: a solid navy needs white under it to match its drawdown.
    const bf = baseFraction([lab[p * 3], lab[p * 3 + 1], lab[p * 3 + 2]], strength, { lo, hi, kC }), f = opt.fade ? bf + (strength - bf) * smoothstep(0.4, 1, s) : Math.max(bf, smoothstep(0.8, 1, s) * strength);
    ub[p] = Math.min(1, s) * f;
  }
  return ub;
}
export function minFilter(src, W, H, r) {
  if (r <= 0) return src; let a = src;
  for (let pass = 0; pass < 2; pass++) {
    const o = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let m = 1;
      if (pass === 0) for (let d = -r; d <= r; d++) { const xx = Math.min(W - 1, Math.max(0, x + d)); const v = a[y * W + xx]; if (v < m) m = v; }
      else for (let d = -r; d <= r; d++) { const yy = Math.min(H - 1, Math.max(0, y + d)); const v = a[yy * W + x]; if (v < m) m = v; }
      o[y * W + x] = m;
    }
    a = o;
  }
  return a;
}

/* ───────────── Overprint: visible area → dot area to image ─────────────
   same-angle (default): plates share one screen, so dots are concentric. A later dot of area A covers the centre of every
   earlier dot, so to leave v_k visible, ink k needs a_k = v_k + max(later areas).
   rotated: plates at different angles overlap at random (Demichel): a_k = v_k / (1 − Σ later v). */
/** Smooth ink map (on by default; SMOOTHMAP=0 gives the old per-colour solve): every ink's coverage is one smooth function of the
    art colour over the whole colour table (separateSim's joint solve), and the films keep it smooth (the hidden dot
    under later inks grows with the ink up to HIDDEN_RAMP instead of jumping in at 1e-4). */
export const SMOOTHMAP = (globalThis.process?.env?.SMOOTHMAP ?? "1") !== "0";
export const HIDDEN_RAMP = SMOOTHMAP ? +(globalThis.process?.env?.HIDDENRAMP ?? 0.03) : 0;
/* Gradient round (2026-11-13). Each fix has its own flag (env; "0" = off, as before) so it can be measured alone. On:
   SCATTERFLOOR, FADEDETAIL, DITHER. Off (measured, not kept; "1" to try): RINGCAP, UBFADE.
   SCATTERFLOOR: under the smallest dot the films scatter whole smallest dots (hybrid AM/FM, below); a tone under 1.5 dots
     per 64 cells prints nothing: the solve leaves about 0.1% of an ink on the bare shirt, which printed one lone dot in
     every 8 × 8 block of cells (white specks over a black shirt).
   FADEDETAIL: the line-work pass also snapped the light or dark end of a fade to solid ink (a ramp's last 40 px, next
     to the shirt, stood out from its window): a snapped component whose colours spread is a fade, as for shapes.
   RINGCAP: one angle prints concentric dots, so what shows of an early ink is the ring its dot leaves around the
     largest later dot. The overlap blend (rho) sized that ring for random overlap, v / (1 − later), which grows without
     bound as the later inks near 100%: Brown fading under Orange in the sky showed at about twice its tone, then
     collapsed where its hidden ink ramped out (a soft edge where Brown ends). The ring is held to the ink's own tone.
     Off: the stack trim and the footprint hold run after it and grow the ring again (sky: 0.19 for a 0.11 tone either
     way); without the trim it holds (2.8 limit: ring 0.11 → 0 smoothly). It cost 0.9% robust and left the hue wheel's
     largest dot at 0.88 for a solid colour (the shirt shows).
   UBFADE: solids still get full base, but the boost toward it rises over 40-100% coverage, not 80-100% (with the solver
     unaware of it, the steep boost brightened the last 20% of every fade into a dark solid: the base went 0.5 to 1.0
     over 47 px of a red ramp while the ink went 0.90 to 1.00); and the base is choked only at its edges (soft choke: a
     smooth fade keeps its base to the end, a hard edge is choked in full). Not in Auto's trials, so Auto's inks stay.
     Off: the solver models the base as baseFraction alone, so any boost it does not see costs accuracy (robust +6.8%,
     03 library +1.46); dropping the boost instead loses full base under solid navy. Needs the solve to model it.
   DITHER: before the table lookup each pixel moves by triangular noise of ±1 level (8-bit), the same on R, G and B, so
     8-bit steps in a fade break into dots instead of bands. */
/* STACKFADE: the stack limit is reached on a soft knee instead of a corner.
   Below limit − w the films are as before; above, the stack the films may use is limit − w·e^(−(st − (limit − w))/w),
   continuous with slope 1 at the knee and never over the limit, so the trim starts earlier and grows with the excess.
   Off (STACKFADE=0.2/0.4/0.8 to try): in the Print view the sky got worse at every width (largest step 1.42 → 1.77 /
   2.30 / 2.84) and Brown's band reached further down. The rings of one-angle dots add up to the colour's coverage and
   the stack counts each ring once per film it sits in, so a trim that keeps the coverage can only move tone outward,
   to the earliest ink (Brown), and trimming earlier moves more. Only ink-to-ink 17 improved (2.87 → 1.99 at 0.4). */
export const STACK_FADE = +(globalThis.process?.env?.STACKFADE ?? 0);
export function stackKnee(st, limit, w) { const a = limit - w; return st <= a ? st : limit - w * Math.exp(-(st - a) / w); }
/** STACKFADE trim: the excess comes first from the hidden ink of inks with little tone of their own (weight c/(c + v)),
    so an ink running out under a full stack gives up its dot as it fades (its ring thins with its tone) instead of
    keeping a full dot that the later inks shrink around. FADETONE = c (0, default = the scaled trim; 0.1 tested: sky
    1.94, sunset islands 1.93 → 2.79). Returns the excess left (the caller scales the rest). */
export const FADE_TONE = +(globalThis.process?.env?.FADETONE ?? 0);
export function fadeTrim(o, v, N, ex, c) {
  const base = i => o[i] - v[i], q = i => c / (c + v[i]);
  for (let pass = 0; pass < 3 && ex > 1e-9; pass++) { let z = 0; for (let i = 0; i < N; i++) z += base(i) * q(i); if (z <= 1e-12) break;
    const f = Math.min(1, ex / z); let cut = 0; for (let i = 0; i < N; i++) { const d = base(i) * q(i) * f; o[i] -= d; cut += d; } ex -= cut; }
  return ex;
}
const gradFlag = (k, d) => (globalThis.process?.env?.[k] ?? d) !== "0";
export const SCATTER_FLOOR = gradFlag("SCATTERFLOOR", "1") ? 1.5 / 64 : 0, FADE_DETAIL = gradFlag("FADEDETAIL", "1"), RING_CAP = gradFlag("RINGCAP", "0"),
  UB_FADE = gradFlag("UBFADE", "0"), DITHER = gradFlag("DITHER", "1");
/** Smooth map, after the press's stack limit trims the hidden ink: one angle prints the dots concentric, so the colour
    covers only the largest dot, and a trim that shrank every dot below the colour's planned coverage let the shirt show
    in specks along the contour where a new early ink's film grew past the limit (hue wheel, yellow into orange).
    Raise the largest film to `target` (the colour's coverage) when every film is below it. The rise goes to the films by
    a soft maximum (weights exp(β(a − max))), so where two films trade the lead it moves over continuously instead of
    jumping from one ink to the other (a hard "largest dot" made a band in the sky gradient). */
export function footprintFloor(out, N, target, beta = 40) {
  let mx = 0; for (let k = 0; k < N; k++) if (out[k] > mx) mx = out[k];
  const d = target - mx; if (d <= 0 || mx <= 0) return;
  let z = 0; for (let k = 0; k < N; k++) z += Math.exp(beta * (out[k] - mx));
  for (let k = 0; k < N; k++) out[k] = Math.min(1, out[k] + d * Math.exp(beta * (out[k] - mx)) / z);
}
export const FOOTPRINT = SMOOTHMAP && globalThis.process?.env?.FOOTPRINT !== "0";
/** Footprint hold (env FOOTHOLD; default "3"; "0" = the floor only after a stack trim, as before). With one angle the
    films print concentric dots, so the shirt is covered only by the largest dot. Two things left that dot below the
    colour's coverage, and the Print view showed the shirt in specks along a line: (1) the hidden-ink ramp and the
    overlap blend (rho) shrink an early ink's dot, so where an early ink fades out no dot covers the whole colour (sky
    gradient, bottom band: Brown fading under Orange, largest dot 0.96 for a 100% colour; no stack trim there, so the
    floor never ran); (2) after a stack trim the soft maximum split the rise between two near-equal films, so the
    largest got only part of it (hue wheel, yellow into orange: 0.97 for 100%). A film between the largest dot (92%)
    and 100% prints scattered holes, and the base, trimmed to the same dot at the same angle, has its holes in the same
    cells: the shirt shows. The old floor also picked one film and raised it all or nothing, so neighbouring pixels with
    near-equal colours printed different films: the bench seams on skin (11, 03 library).
    "3": where the colour is near solid (coverage HOLD_LO..HOLD_HI, rising smoothly) the largest film reaches the
    colour's coverage, and films near it rise with it by weight exp(β(a − max)); only there can a film print scattered
    holes (under 92% every cell has the same hole: a steady tone, not specks). "1": the same for every colour. */
export const FOOTHOLD = FOOTPRINT ? (globalThis.process?.env?.FOOTHOLD ?? "3") : "0";
// β 4: 8 and 15 left more bench seams (11 library disc 0.49 / 0.53 vs 0.15), 40 (a hard pick) 0.85
const HOLD_BETA = +(globalThis.process?.env?.FHBETA || 4), HOLD_LO = +(globalThis.process?.env?.FHLO || 0.85), HOLD_HI = +(globalThis.process?.env?.FHHI || 0.95);
export function holdShare(vis) { const t = Math.max(0, Math.min(1, (vis - HOLD_LO) / Math.max(1e-6, HOLD_HI - HOLD_LO))); return t * t * (3 - 2 * t); }
/** Raise the largest film to `target` (see FOOTHOLD). o: printed dots (changed in place), v: visible tones, limit: the
    colour stack limit (0 = none). Over the limit the excess comes from the other films' hidden ink (never below their
    visible tone), then from the rise itself: what does not fit is not raised. Returns the rise kept. */
export function footprintHold(o, v, N, target, limit, share = 1, beta = HOLD_BETA) {
  let mx = 0; for (let k = 0; k < N; k++) if (o[k] > mx) mx = o[k];
  const d = share * (Math.min(1, target) - mx); if (d <= 1e-6 || mx <= 0) return 0;
  // weight per film: 1 for the largest, near 1 for a film close to it, so the rise and the ink taken back for it change
  // smoothly where two films trade the lead (a hard "largest" made the colour jump between neighbouring pixels)
  let sum = 0, R = 0, room = 0; const w = new Float64Array(N), r = new Float64Array(N);
  for (let k = 0; k < N; k++) { w[k] = Math.exp(beta * (o[k] - mx)); r[k] = Math.min(1, o[k] + d * w[k]) - o[k]; sum += o[k]; R += r[k]; room += (o[k] - v[k]) * (1 - w[k]); }
  // within the stack limit: the rise is paid from the other films' hidden ink (never below their visible tone); what the
  // hidden ink cannot pay is not raised (all rises scale down together)
  let phi = 1, take = 0;
  if (limit > 0) { const ex = sum + R - limit; if (ex > 0) { if (ex <= room) take = ex; else { take = room; phi = Math.max(0, (limit - sum + room) / Math.max(1e-9, R)); } } }
  const f = room > 1e-9 ? take / room : 0;
  for (let k = 0; k < N; k++) o[k] = Math.max(v[k], o[k] + phi * r[k] - (o[k] - v[k]) * (1 - w[k]) * f);
  return phi * d;
}
export function visibleToPrinted(v, N, out, model, rho = 0, ramp = HIDDEN_RAMP) {
  // "none": print each channel at its visible tone, as practitioners do (no hidden ink under later dots)
  if (model === "none" || model === "lock") { for (let k = 0; k < N; k++) out[k] = v[k]; return; }
  // "partial": scale the compensation back (rho is ignored); share = how much of the hidden-ring ink to add
  if (model && model.startsWith("partial")) { const share = +model.slice(7) || 0.5; let M = 0; for (let k = N - 1; k >= 0; k--) { const full = v[k] > 1e-4 ? Math.min(1, v[k] + M) : 0; out[k] = v[k] + share * (full - v[k]); if (full > M) M = full; } return; }
  if (model === "rotated") { let after = 0; for (let k = N - 1; k >= 0; k--) { const den = 1 - after; out[k] = den > 1e-4 ? Math.min(1, v[k] / den) : 0; after += v[k]; } return; }
  if (model === "same" && rho > 0) {
    // measured overlap rho between concentric (0) and random (1). The print model (robustScore) shows of ink k, under the
    // later inks' largest dot M and their free share F, (1 - rho) max(0, a - M) + rho a F: piecewise linear in its own dot a,
    // so the dot that shows v is exact, last ink first (2026-11-15; before, a blend of the two compensations, which printed
    // a different mix than planned: 17 photos, plan 2.49 -> films in register 3.22)
    let M = 0, F = 1;
    for (let k = N - 1; k >= 0; k--) { const vk = v[k]; let a = 0;
      if (vk > 0) { const a1 = rho * F > 1e-9 ? vk / (rho * F) : Infinity; a = a1 <= M ? a1 : (vk + (1 - rho) * M) / ((1 - rho) + rho * F);
        if (ramp > 0 && vk < ramp && a > vk) a = vk + (a - vk) * vk / ramp; a = Math.min(1, a); }
      out[k] = a; if (a > M) M = a; F *= 1 - a; }
  } else { let M = 0; for (let k = N - 1; k >= 0; k--) { out[k] = ramp > 0 ? (v[k] > 0 ? Math.min(1, v[k] + (v[k] < ramp ? M * v[k] / ramp : M)) : 0) : v[k] > 1e-4 ? Math.min(1, v[k] + M) : 0; if (out[k] > M) M = out[k]; } }
  // RINGCAP: the ring an early dot leaves around the largest later dot is at most the ink's own tone
  if (model === "same" && RING_CAP) { let L = 0; for (let k = N - 1; k >= 0; k--) { if (out[k] > L + v[k]) out[k] = Math.min(1, Math.max(v[k], L + v[k])); if (out[k] > L) L = out[k]; } }
}

/* ───────────── Proof + fidelity ───────────── */
/* lite (Auto's trials): only the pixels the statistics read (every `stride`-th) are computed, and no picture is drawn.
   The statistics are the same numbers; img and de are then empty of the skipped pixels and must not be used. */
/** ΔE00 of a printed colour against an art colour, remembering the last pair. The scorers meet the same pair many
    times in a row (flat art, the bare shirt, overlap models that agree where one ink prints), and a repeat skips the
    colour conversion and the ΔE00: same result to the last bit. toLab(c0, c1, c2) gives the printed colour's Lab;
    .lab() is the last one, .cmc() its ΔE CMC (computed once per pair, on demand). */
export function pairScorer(toLab) {
  let q0 = NaN, q1 = NaN, q2 = NaN, qL = NaN, qA = NaN, qB = NaN, e = 0, c = NaN, l = [0, 0, 0];
  return {
    de(L, A, B, c0, c1, c2) {
      if (c0 !== q0 || c1 !== q1 || c2 !== q2 || L !== qL || A !== qA || B !== qB) {
        l = toLab(c0, c1, c2); e = de2000(L, A, B, l[0], l[1], l[2]); c = NaN; q0 = c0; q1 = c1; q2 = c2; qL = L; qA = A; qB = B; }
      return e; },
    cmc() { if (c !== c) c = deCMC(qL, qA, qB, l[0], l[1], l[2]); return c; },
    lab() { return l; },
  };
}
/** mixToRGB remembering the last mix (proof images repeat it across flat art and bare shirt). */
function rgbOfMix(n) { let q0 = NaN, q1 = NaN, q2 = NaN, r = [0, 0, 0]; return (m0, m1, m2) => { if (m0 !== q0 || m1 !== q1 || m2 !== q2) { r = mixToRGB([m0, m1, m2], n); q0 = m0; q1 = m1; q2 = m2; } return r; }; }
export function proof({ cov, N, W, H, lab, alpha, inkLabs, garmentLab, n, stride = 3, lite = false }) {
  const P = W * H, cm = inkLabs.map(l => mixFromLab(l, n)), gm = mixFromLab(garmentLab, n);
  const img = new Uint8ClampedArray(P * 4), de = new Float32Array(P), s00 = [], scmc = [], pair = pairScorer((c0, c1, c2) => mixToLab([c0, c1, c2], n)), toRGB = rgbOfMix(n);
  for (let p = 0; p < P; p++) {
    if (lite && (p % stride !== 0 || alpha[p] < 128)) continue;
    let s = 0, m0 = 0, m1 = 0, m2 = 0;
    for (let i = 0; i < N; i++) { const v = cov[p * N + i]; s += v; m0 += v * cm[i][0]; m1 += v * cm[i][1]; m2 += v * cm[i][2]; }
    const g = Math.max(0, 1 - s); m0 += g * gm[0]; m1 += g * gm[1]; m2 += g * gm[2];
    if (!lite) { const rgb = toRGB(m0, m1, m2); img[p * 4] = rgb[0]; img[p * 4 + 1] = rgb[1]; img[p * 4 + 2] = rgb[2]; img[p * 4 + 3] = 255; }
    if (alpha[p] >= 128) {
      const e = pair.de(lab[p * 3], lab[p * 3 + 1], lab[p * 3 + 2], m0, m1, m2); de[p] = e;
      if (p % stride === 0) { s00.push(e); scmc.push(pair.cmc()); }
    }
  }
  return summarize(img, de, s00, scmc);
}

/* Ink over partial underbase: where the base covers u of the s ink area, the rest prints straight on the shirt and
   reads darker. Plastisol on a dark shirt without base is modeled as opacity op (calibratable; 0.55 by default). */
export function proofWithBase({ cov, ub, N, W, H, lab, alpha, inkLabs, garmentLab, n, op = 0.55, stride = 3, lite = false }) {
  if (!ub) return proof({ cov, N, W, H, lab, alpha, inkLabs, garmentLab, n, stride, lite });
  const P = W * H, full = inkLabs.map(l => mixFromLab(l, n)), gm = mixFromLab(garmentLab, n);
  const dark = full.map(c => c.map((v, k) => op * v + (1 - op) * gm[k]));
  // fold the base fraction into an effective per-pixel ink color by scaling coverage between "on base" and "on shirt"
  const img = new Uint8ClampedArray(P * 4), de = new Float32Array(P), s00 = [], scmc = [], pair = pairScorer((c0, c1, c2) => mixToLab([c0, c1, c2], n)), toRGB = rgbOfMix(n);
  for (let p = 0; p < P; p++) {
    if (lite && (p % stride !== 0 || alpha[p] < 128)) continue;
    let s = 0; for (let i = 0; i < N; i++) s += cov[p * N + i];
    const f = s > 1e-4 ? Math.min(1, ub[p] / s) : 1, g = Math.max(0, 1 - s);
    let m0 = g * gm[0], m1 = g * gm[1], m2 = g * gm[2];
    for (let i = 0; i < N; i++) { const v = cov[p * N + i], hl = inkLabs[i][0] > 92 ? 1 : f; m0 += v * (hl * full[i][0] + (1 - hl) * dark[i][0]); m1 += v * (hl * full[i][1] + (1 - hl) * dark[i][1]); m2 += v * (hl * full[i][2] + (1 - hl) * dark[i][2]); }
    if (!lite) { const rgb = toRGB(m0, m1, m2); img[p * 4] = rgb[0]; img[p * 4 + 1] = rgb[1]; img[p * 4 + 2] = rgb[2]; img[p * 4 + 3] = 255; }
    if (alpha[p] >= 128) {
      const e = pair.de(lab[p * 3], lab[p * 3 + 1], lab[p * 3 + 2], m0, m1, m2); de[p] = e;
      if (p % stride === 0) { s00.push(e); scmc.push(pair.cmc()); }
    }
  }
  return summarize(img, de, s00, scmc);
}
function summarize(img, de, s00, scmc) {
  const stat = arr => { const a = Float64Array.from(arr).sort(); let sum = 0; for (const v of a) sum += v; return { mean: sum / Math.max(1, a.length), p95: a[Math.floor(a.length * 0.95)] || 0, median: a[Math.floor(a.length * 0.5)] || 0, a }; };
  const S = stat(s00), Cm = stat(scmc), frac = (a, t) => { let c = 0; for (const v of a) if (v <= t) c++; return c / Math.max(1, a.length); };
  return { img, de, mean: S.mean, median: S.median, p95: S.p95, within3: frac(S.a, 3), cmcMean: Cm.mean, cmcP95: Cm.p95, cmcWithin1: frac(Cm.a, 1), cmcWithin2: frac(Cm.a, 2) };
}
/* Spatially filtered ΔE00 (a simple S-CIELAB-style stand-in): blur art and proof in linear light with a Gaussian of
   sigma px (about what the eye blends at viewing distance), then compare. Per-pixel ΔE punishes dithered index output
   for pattern the eye never sees; this does not. */
function blurLinear(img4, W, H, sigma) {
  const r = Math.max(1, Math.ceil(sigma * 2.5)), k = []; let ks = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k.push(v); ks += v; }
  for (let i = 0; i < k.length; i++) k[i] /= ks;
  const P = W * H, a = new Float32Array(P * 3), b = new Float32Array(P * 3);
  for (let p = 0; p < P; p++) for (let c = 0; c < 3; c++) a[p * 3 + c] = S2L[img4[p * 4 + c]];
  // the same sums in the same order as clamping every tap; only the taps near an edge need the clamp
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const edge = x < r || x + r >= W, row = y * W;
    for (let c = 0; c < 3; c++) { let s = 0;
      if (edge) for (let i = -r; i <= r; i++) { const xx = Math.min(W - 1, Math.max(0, x + i)); s += k[i + r] * a[(row + xx) * 3 + c]; }
      else for (let i = -r, q = (row + x - r) * 3 + c; i <= r; i++, q += 3) s += k[i + r] * a[q];
      b[(row + x) * 3 + c] = s; } }
  for (let y = 0; y < H; y++) { const edge = y < r || y + r >= H;
    for (let x = 0; x < W; x++) for (let c = 0; c < 3; c++) { let s = 0;
      if (edge) for (let i = -r; i <= r; i++) { const yy = Math.min(H - 1, Math.max(0, y + i)); s += k[i + r] * b[(yy * W + x) * 3 + c]; }
      else for (let i = -r, q = ((y - r) * W + x) * 3 + c, st = W * 3; i <= r; i++, q += st) s += k[i + r] * b[q];
      a[(y * W + x) * 3 + c] = s; } }
  return a;
}
/** The art's blurred copy, kept per pixel array: every separation of the same art blurs the same art. The key holds a
    checksum of the pixels and alpha, so an array edited in place is blurred again. */
const _artBlur = new WeakMap();
function blurredArt(px, alpha, W, H, garmentRGB, sigma) {
  let h = 0; for (let i = 0; i < px.length; i++) h = (Math.imul(h, 31) + px[i]) | 0;
  for (let i = 0; i < alpha.length; i++) h = (Math.imul(h, 31) + alpha[i]) | 0;
  const key = `${W} ${H} ${garmentRGB.join(",")} ${sigma} ${h}`, hit = _artBlur.get(px);
  if (hit && hit.alpha === alpha && hit.key === key) return hit.A;
  const P = W * H, art4 = new Uint8ClampedArray(P * 4);
  for (let p = 0; p < P; p++) { const al = alpha[p] / 255; for (let c = 0; c < 3; c++) art4[p * 4 + c] = px[p * 3 + c] * al + garmentRGB[c] * (1 - al); art4[p * 4 + 3] = 255; }
  const A = blurLinear(art4, W, H, sigma); _artBlur.set(px, { alpha, key, A }); return A;
}
export function filteredDE({ img, W, H, px, alpha, garmentRGB, sigma = 1.5, stride = 2 }) {
  const P = W * H, A = blurredArt(px, alpha, W, H, garmentRGB, sigma), B = blurLinear(img, W, H, sigma); let sum = 0, cnt = 0;
  for (let p = 0; p < P; p += stride) { if (alpha[p] < 128) continue; sum += de2000(...lin2lab(A[p * 3], A[p * 3 + 1], A[p * 3 + 2]), ...lin2lab(B[p * 3], B[p * 3 + 1], B[p * 3 + 2])); cnt++; }
  return sum / Math.max(1, cnt);
}

/* Misregistration-robust score. The films we print (printed areas, base) are pushed through our base-aware print model
   under several overlap behaviors, from perfectly stacked same-angle dots (rho 0) to random overlap (rho 1, what a
   loose press tends toward), and the CIEDE2000 errors are averaged. Underbase not covered by color shows as white.
   This is the yardstick upgrades are judged by: it cannot be gamed by assuming a perfect press. */
export function robustScore({ printed, ub, N, W, H, lab, alpha, inkLabs, garmentLab, n, op = 0.55, whiteLab = [96, 0, 1.5], rhos = [0, 0.5, 1], stride = 3, lock = /** @type {number | null} */ (null), labOut = /** @type {Float32Array | null} */ (null) }) {
  const full = inkLabs.map(l => mixFromLab(l, n)), gm = mixFromLab(garmentLab, n), wm = mixFromLab(whiteLab, n);
  const dark = full.map((c, i) => inkLabs[i][0] > 92 ? c : c.map((v, k) => op * v + (1 - op) * gm[k]));
  const vis = new Float64Array(N), lightNoBase = !ub && garmentLab[0] >= 55, pair = pairScorer((c0, c1, c2) => mixToLab([c0, c1, c2], n)); let sum = 0, cnt = 0; const all = [];
  for (let p = 0; p < W * H; p += stride) {
    if (alpha[p] < 128) continue;
    let pe = 0;
    // Interlocked screens: in register each ink prints only where it shows (no ink under another), so what shows is
    // what is printed, and the base shows only where it is wider than all the inks. Off register the shapes stop
    // fitting: overlaps and gaps like randomly placed dots. lock = the share of the cell the press's drift misplaces.
    if (lock != null) {
      let sa = 0; for (let k = 0; k < N; k++) sa += printed[p * N + k];
      const u = ub ? ub[p] : 0, sc = sa > 1 ? 1 / sa : 1, e = [0, 0];
      for (let c = 0; c < 2; c++) {
        let cover, baseShow, free = 1;
        if (c === 0) { for (let k = 0; k < N; k++) vis[k] = printed[p * N + k] * sc; cover = Math.min(1, sa); baseShow = Math.max(0, Math.min(1 - cover, u - cover)); }
        else { for (let k = N - 1; k >= 0; k--) { const a = printed[p * N + k] * sc; vis[k] = a * free; free *= 1 - a; } cover = 1 - free; baseShow = Math.min(1 - cover, u * free); }
        const f = lightNoBase ? 1 : cover > 1e-4 ? Math.min(1, u / Math.max(cover, 1e-4)) : 1, g = Math.max(0, 1 - cover - baseShow);
        let m0 = g * gm[0] + baseShow * wm[0], m1 = g * gm[1] + baseShow * wm[1], m2 = g * gm[2] + baseShow * wm[2];
        for (let k = 0; k < N; k++) { const hl = inkLabs[k][0] > 92 ? 1 : f, v = vis[k]; m0 += v * (hl * full[k][0] + (1 - hl) * dark[k][0]); m1 += v * (hl * full[k][1] + (1 - hl) * dark[k][1]); m2 += v * (hl * full[k][2] + (1 - hl) * dark[k][2]); }
        e[c] = pair.de(lab[p * 3], lab[p * 3 + 1], lab[p * 3 + 2], m0, m1, m2);
      }
      pe = (1 - lock) * e[0] + lock * e[1]; sum += pe; cnt++; all.push(pe); continue;
    }
    for (const rho of rhos) {
      // forward model: concentric (later dot covers earlier dot's centre) blended with random overlap
      let maxLater = 0, freeLater = 1;
      for (let k = N - 1; k >= 0; k--) {
        const a = printed[p * N + k], conc = Math.max(0, a - maxLater), rnd = a * freeLater;
        vis[k] = (1 - rho) * conc + rho * rnd; if (a > maxLater) maxLater = a; freeLater *= 1 - a;
      }
      let sv = 0; for (let k = 0; k < N; k++) sv += vis[k];
      const u = ub ? ub[p] : 0, cover = Math.min(1, sv), baseShow = Math.min(1 - cover, (1 - rho) * Math.max(0, u - maxLater) + rho * u * freeLater);
      // no base on a light shirt: inks are characterized on white, so they show at full color (fixed 2026-11-04: the
      // score used the on-dark-shirt appearance here and reported ~30 ΔE on spot art that matched within 0.5)
      const f = lightNoBase ? 1 : cover > 1e-4 ? Math.min(1, u / Math.max(cover, 1e-4)) : 1, g = Math.max(0, 1 - cover - baseShow);
      let m0 = g * gm[0] + baseShow * wm[0], m1 = g * gm[1] + baseShow * wm[1], m2 = g * gm[2] + baseShow * wm[2];
      for (let k = 0; k < N; k++) { const hl = inkLabs[k][0] > 92 ? 1 : f, v = vis[k]; m0 += v * (hl * full[k][0] + (1 - hl) * dark[k][0]); m1 += v * (hl * full[k][1] + (1 - hl) * dark[k][1]); m2 += v * (hl * full[k][2] + (1 - hl) * dark[k][2]); }
      pe += pair.de(lab[p * 3], lab[p * 3 + 1], lab[p * 3 + 2], m0, m1, m2);
      if (labOut && rho === rhos[0]) labOut.set(pair.lab(), p * 3); // the printed colour per pixel (bench discontinuity metric)
    }
    pe /= rhos.length; sum += pe; cnt++; all.push(pe);
  }
  const a = Float64Array.from(all).sort();
  return { mean: sum / Math.max(1, cnt), p95: a[Math.floor(a.length * 0.95)] || 0 };
}

/* Trapping for solid (spot) screens: each ink spreads r pixels into the area of inks printed after it, so the later
   (opaque) ink still covers it when a screen moves on the press and no gap of garment or base opens between them.
   It never spreads into open garment. Screens are in print order (channel order). r is in working pixels and may be a
   fraction: the films are rendered at film resolution from these coverages with bilinear sampling, so the last ring gets
   partial coverage (r minus the whole pixels) and the film still carries a trap thinner than one working pixel. Before
   this, r rounded to 0 on art under 699 px wide on an 11 in film and the default trap silently did nothing. */
export function trapSpot(cov, N, W, H, r) {
  if (!(r > 0.05) || N < 2) return cov;
  const R = Math.ceil(r), whole = Math.floor(r + 1e-6), frac = r - whole;
  const out = Float32Array.from(cov), later = new Float32Array(W * H);
  for (let i = N - 2; i >= 0; i--) {
    for (let p = 0; p < W * H; p++) { let s = 0; for (let j = i + 1; j < N; j++) s += cov[p * N + j]; later[p] = Math.min(1, s); }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const p = y * W + x; if (later[p] < 0.5 || cov[p * N + i] >= 0.5) continue;
      // nearest pixel of ink i, in whole-pixel rings (Chebyshev-on-disc: d = ceil of the Euclidean distance)
      let best = Infinity;
      for (let dy = -R; dy <= R; dy++) { const yy = y + dy; if (yy < 0 || yy >= H) continue; for (let dx = -R; dx <= R; dx++) { const xx = x + dx; if (xx < 0 || xx >= W) continue; const d2 = dx * dx + dy * dy; if (d2 > R * R || d2 >= best) continue; if (cov[(yy * W + xx) * N + i] >= 0.5) best = d2; } }
      if (best === Infinity) continue;
      const ring = Math.ceil(Math.sqrt(best) - 1e-6), v = ring <= whole ? 1 : frac;
      if (v > out[p * N + i]) out[p * N + i] = v; }
  }
  return out;
}
/** Each screen moved by its own (dx, dy) in pixels, sampled bilinearly so sub-pixel moves give partial coverage at edges. */
export function shiftCov(cov, N, W, H, offs) {
  const out = new Float32Array(cov.length);
  for (let i = 0; i < N; i++) { const smp = sampler(cov, W, H, N, i), [dx, dy] = offs[i];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) out[(y * W + x) * N + i] = smp((x - dx + 0.5) / W, (y - dy + 0.5) / H); }
  return out;
}
/* Neutral yardstick, the same one used to score competitors: start from the shirt, lay the underbase as white, then each
   screen in print order covers what is under it at its film coverage (no dot gain, no Yule–Nielsen, linear light).
   It is deliberately not our model, so our tiles cannot grade our own homework. */
export function neutralScore({ printed, ub, N, W, H, lab, alpha, inkLabs, garmentLab, whiteLab = [96, 0, 1.5], stride = 2 }) {
  const lin = l => lab2lin(...l).map(v => Math.max(0, Math.min(1, v))), ink = inkLabs.map(lin), g = lin(garmentLab), wb = lin(whiteLab);
  const out = [], pair = pairScorer(lin2lab); let sum = 0;
  for (let p = 0; p < W * H; p += stride) {
    if (alpha[p] < 128) continue;
    let c0 = g[0], c1 = g[1], c2 = g[2];
    if (ub) { const u = ub[p]; c0 = c0 * (1 - u) + wb[0] * u; c1 = c1 * (1 - u) + wb[1] * u; c2 = c2 * (1 - u) + wb[2] * u; }
    for (let i = 0; i < N; i++) { const a = printed[p * N + i]; c0 = c0 * (1 - a) + ink[i][0] * a; c1 = c1 * (1 - a) + ink[i][1] * a; c2 = c2 * (1 - a) + ink[i][2] * a; }
    const e = pair.de(lab[p * 3], lab[p * 3 + 1], lab[p * 3 + 2], c0, c1, c2); out.push(e); sum += e;
  }
  const a = Float64Array.from(out).sort();
  return { mean: sum / Math.max(1, a.length), median: a[Math.floor(a.length / 2)] || 0, p95: a[Math.floor(a.length * 0.95)] || 0 };
}
/* Cost of dropping each ink: weighted mean ΔE00 of the art's colors rebuilt without it, minus with it. */
/** @param {BaseOpt} [base] */
/* Accent inks print only on their own colour: a red added for red stripes must not be used to build yellow lemons or a
   blue sky. gates[i] is the accent's hue in degrees (null for ordinary inks). An accent ink is barred (large solver
   penalty) wherever the target's hue is more than ACCENT_GATE° (25°) away from it or the target is near-neutral. */
export const ACCENT_GATE = 25;
export function accentGatePen(gates, tlab, pen) {
  if (!gates) return pen;
  const C = Math.hypot(tlab[1], tlab[2]), h = (Math.atan2(tlab[2], tlab[1]) * 180 / Math.PI + 360) % 360;
  for (let i = 0; i < gates.length; i++) { if (gates[i] == null) continue; const d = Math.abs(((h - gates[i] + 540) % 360) - 180); if (C < 10 || d > ACCENT_GATE) pen[i] += 50; }
  return pen;
}
/** ΔE00 of each sample when rebuilt from these inks (the solver's own reconstruction, as reconError, per sample). */
export function sampleErrors(inkLabs, garmentLab, samples, n, lam = 0.02, iters = 60, base = null, gates = null) {
  const M = inkLabs.length + 1, app = base ? makeAppearance(inkLabs, garmentLab, n, base.op) : null;
  let { C } = stackColors(inkLabs, garmentLab, n); const solve = makeSolver(C, M), out = new Float64Array(M), err = new Float64Array(samples.length);
  samples.forEach((s, k) => {
    if (app) { C = app(baseFraction(s.lab, base.strength)); solve.setC(C); }
    let pen = PEN.on && base ? inkPenalties(inkLabs, garmentLab, s.lab, {}, lam, n) : undefined;
    if (gates) { pen = pen ? Float64Array.from(pen) : new Float64Array(M); accentGatePen(gates, s.lab, pen); }
    solve(s.mix[0], s.mix[1], s.mix[2], lam, iters, out, pen);
    let m0 = 0, m1 = 0, m2 = 0; for (let j = 0; j < M; j++) { m0 += out[j] * C[j * 3]; m1 += out[j] * C[j * 3 + 1]; m2 += out[j] * C[j * 3 + 2]; }
    err[k] = de2000(...s.lab, ...mixToLab([m0, m1, m2], n));
  });
  return err;
}
/* Accent colours: small, saturated areas (a red stripe, a green stem, a gauge light) carry far more visual weight than
   their pixel count, so a palette chosen by area-weighted error can leave them with no ink and print them grey. Groups
   the colours the inks cannot reach (chroma ≥ minC, error ≥ minErr) by hue; returns those covering ≥ minArea of the art,
   worst first, each with a candidate ink (the group's most saturated quarter, weighted by area). */
export function findAccents(samples, err, opts = {}) {
  const minC = opts.minC ?? 25, minErr = opts.minErr ?? 12, minArea = opts.minArea ?? 0.0015;
  let total = 0; for (const s of samples) total += s.w;
  // an accent is a hue that is rare in the art as a whole (red on a blue kite, green in a yellow painting): a hue family
  // (any chroma ≥ 12) covering maxFamily or more of the art is a main colour, not an accent
  const maxFamily = opts.maxFamily ?? 0.08, famArea = new Float64Array(12);
  for (const s of samples) if (Math.hypot(s.lab[1], s.lab[2]) >= 12) famArea[Math.floor(((Math.atan2(s.lab[2], s.lab[1]) * 180 / Math.PI + 360) % 360) / 30)] += s.w;
  const groups = new Map();
  samples.forEach((s, k) => {
    const C = Math.hypot(s.lab[1], s.lab[2]); if (C < minC || err[k] < minErr || s.lab[0] < 12 || s.lab[0] > 96) return;
    const h = Math.floor(((Math.atan2(s.lab[2], s.lab[1]) * 180 / Math.PI + 360) % 360) / 30); if (famArea[h] / total >= maxFamily) return;
    let g = groups.get(h); if (!g) { g = []; groups.set(h, g); } g.push({ s, e: err[k], C });
  });
  // one colour can straddle a 30° bin edge: merge neighbouring groups whose mean hues are within 20°
  const hueOf = g => { let x = 0, y = 0; for (const o of g) { x += o.s.w * o.s.lab[1]; y += o.s.w * o.s.lab[2]; } return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360; };
  let list = [...groups.values()];
  for (let merged = true; merged && list.length > 1;) {
    merged = false;
    outer: for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const d = Math.abs(((hueOf(list[i]) - hueOf(list[j]) + 540) % 360) - 180);
      if (d <= 20) { list[i] = list[i].concat(list[j]); list.splice(j, 1); merged = true; break outer; }
    }
  }
  const out = [];
  for (const g of list) {
    const area = g.reduce((a, x) => a + x.s.w, 0) / Math.max(1, total); if (area < minArea) continue;
    // the ink sits at the vivid end: halftone can dull an ink toward the shirt or base but never make it more vivid,
    // so the group's most saturated quarter (by area) sets the ink, not its average (which edges and shading muddy)
    const byC = g.slice().sort((a, b) => b.C - a.C), aTot = g.reduce((a, x) => a + x.s.w, 0); let acc = 0; const top = [];
    for (const x of byC) { top.push(x); acc += x.s.w; if (acc >= 0.25 * aTot) break; }
    const wsum = top.reduce((a, x) => a + x.s.w, 0), lab = [0, 1, 2].map(i => top.reduce((a, x) => a + x.s.w * x.s.lab[i], 0) / wsum);
    const meanErr = g.reduce((a, x) => a + x.s.w * x.e, 0) / g.reduce((a, x) => a + x.s.w, 0);
    out.push({ lab, area, meanErr, members: g.map(x => x.s), score: area * meanErr });
  }
  return out.sort((a, b) => b.score - a.score);
}
export function removalCosts(inkLabs, garmentLab, samples, n, base = null, lamSel = 0.2) {
  const set = topSamples(samples, 300), b0 = reconError(inkLabs, garmentLab, set, n, lamSel, 45, base);
  return inkLabs.map((_, i) => reconError(inkLabs.filter((__, j) => j !== i), garmentLab, set, n, lamSel, 45, base) - b0);
}

/* ───────────── Halftone ───────────── */
export function invGain(a, G) { if (G <= 0) return a; const k = 4 * G, disc = (1 + k) * (1 + k) - 4 * k * a; return ((1 + k) - Math.sqrt(Math.max(0, disc))) / (2 * k); }
// Calibrated curve: measured effective area at nominal 0,10,…,100%. Returns nominal needed for a wanted effective area.
export function invCurve(a, curve) {
  if (!curve) return a;
  for (let i = 0; i < 10; i++) { const lo = curve[i], hi = curve[i + 1]; if (a <= hi || i === 9) { const t = hi > lo ? (a - lo) / (hi - lo) : 0; return Math.max(0, Math.min(1, (i + Math.max(0, Math.min(1, t))) / 10)); } }
  return a;
}
export function shapeDot(a, { gain, curve, minDot, maxDot, scatter = false }) {
  a = curve ? invCurve(a, curve) : invGain(a, gain);
  if (a < minDot && !scatter) a = a < minDot / 2 ? 0 : minDot;
  if (a > maxDot && !scatter) a = 1; // with scatter, renderPlate keeps whole smallest holes in a share of the cells
  return a;
}
/** Scatter at the dark end: a tone over the largest dot cannot keep a smaller hole (it plugs), so a share of the cells
    keep one smallest hole (the largest dot) and the rest go solid, spread evenly by the ordered pattern (offset from
    the small-dot pattern). Without it every cell goes solid at once and a fade to solid stops in a hard line. */
export function scatterHoles(a, maxDot, u, v) {
  if (a <= maxDot || a >= 1) return a;
  return bayerCell(u + 3, v + 5) < (1 - a) / Math.max(1e-6, 1 - maxDot) ? maxDot : 1;
}
// Ordered 8×8 (Bayer) threshold for halftone cell (u, v), in (0, 1): any share of cells it switches on is spread evenly
const BAYER8 = [0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21];
export function bayerCell(u, v) { return (BAYER8[(((v % 8) + 8) % 8) * 8 + (((u % 8) + 8) % 8)] + 0.5) / 64; }
// Round dot that turns into inverted round holes past 50%: area-exact at every tint.
export function amOn(x, y, a, cell, cs, sn) {
  if (a <= 0) return false; if (a >= 1) return true;
  const u = (x * cs + y * sn) / cell, v = (-x * sn + y * cs) / cell, fu = u - Math.floor(u) - 0.5, fv = v - Math.floor(v) - 0.5;
  if (a < 0.5) return fu * fu + fv * fv < a / Math.PI;
  const gu = Math.abs(fu) - 0.5, gv = Math.abs(fv) - 0.5; return !(gu * gu + gv * gv < (1 - a) / Math.PI);
}
export function sampler(arr, W, H, N, ci) {
  return (u, v) => {
    const x = Math.min(W - 1.001, Math.max(0, u * W - 0.5)), y = Math.min(H - 1.001, Math.max(0, v * H - 0.5)), x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
    const at = (xx, yy) => N ? arr[(yy * W + xx) * N + ci] : arr[yy * W + xx];
    return at(x0, y0) * (1 - fx) * (1 - fy) + at(x0 + 1, y0) * fx * (1 - fy) + at(x0, y0 + 1) * (1 - fx) * fy + at(x0 + 1, y0 + 1) * fx * fy;
  };
}
/** The same, leaving out the pixels skip(q) says are not this screen's (weights renormalised over the rest; NaN when
    all four are left out). Used beside solid shapes, so the halftone around a shape does not borrow the shape's own 100%. */
export function maskedSampler(arr, W, H, N, ci, skip) {
  return (u, v) => {
    const x = Math.min(W - 1.001, Math.max(0, u * W - 0.5)), y = Math.min(H - 1.001, Math.max(0, v * H - 0.5)), x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
    let s = 0, wt = 0;
    for (let j = 0; j < 4; j++) { const q = (y0 + (j >> 1)) * W + x0 + (j & 1), w = (j & 1 ? fx : 1 - fx) * (j >> 1 ? fy : 1 - fy);
      if (w <= 0 || skip(q)) continue; s += (N ? arr[q * N + ci] : arr[q]) * w; wt += w; }
    return wt > 0 ? s / wt : NaN;
  };
}
/* Index pixels must be big enough for the mesh to hold: printers use 180–225 dpi at print size (Fresener), not film
   resolution. Builds the shared index map at indexDpi and returns it with its scale for renderPlate. */
export function fmIndexAt(cov, W, H, N, Wp, Hp, dpi, indexDpi, c) {
  const s = Math.max(1, dpi / (indexDpi || 200)), Wi = Math.max(1, Math.round(Wp / s)), Hi = Math.max(1, Math.round(Hp / s));
  const x0 = Math.floor(c.x0 / s), y0 = Math.floor(c.y0 / s), w = Math.min(Wi - x0, Math.ceil((c.x0 + c.w) / s) - x0 + 1), h = Math.min(Hi - y0, Math.ceil((c.y0 + c.h) / s) - y0 + 1);
  return { idx: fmIndex(cov, W, H, N, Wi, Hi, x0, y0, w, h), s, x0, y0, w, h };
}
// Shared index map so FM pixels never overlap across screens.
export function fmIndex(cov, W, H, N, Wp, Hp, x0 = 0, y0 = 0, w = Wp, h = Hp) {
  const M = N + 1, idx = new Uint8Array(w * h), rows = [new Float32Array((w + 2) * M), new Float32Array((w + 2) * M)], want = new Float32Array(M);
  const samp = []; for (let i = 0; i < N; i++) samp.push(sampler(cov, W, H, N, i));
  for (let y = 0; y < h; y++) {
    const cur = rows[y & 1], nxt = rows[(y + 1) & 1]; nxt.fill(0); const vv = (y + y0 + 0.5) / Hp;
    for (let x = 0; x < w; x++) {
      const uu = (x + x0 + 0.5) / Wp; let s = 0, bi = N, bv = -Infinity;
      for (let i = 0; i < N; i++) { want[i] = samp[i](uu, vv); s += want[i]; } want[N] = Math.max(0, 1 - s);
      for (let j = 0; j < M; j++) { const t = want[j] + cur[(x + 1) * M + j]; if (t > bv) { bv = t; bi = j; } }
      idx[y * w + x] = bi;
      for (let j = 0; j < M; j++) { const e = want[j] + cur[(x + 1) * M + j] - (j === bi ? 1 : 0); cur[(x + 2) * M + j] += e * 7 / 16; nxt[x * M + j] += e * 3 / 16; nxt[(x + 1) * M + j] += e * 5 / 16; nxt[(x + 2) * M + j] += e / 16; }
    }
  }
  return idx;
}
/* Choke that keeps thin lines: a full choke erases the base under hairlines and small type (DTF RIP docs warn of this),
   so where the full choke leaves nothing but a 1 px choke still has base, keep the 1 px result. */
export function adaptiveChoke(src, W, H, r) {
  if (r <= 1) return minFilter(src, W, H, r);
  const full = minFilter(src, W, H, r), thin = minFilter(src, W, H, 1), out = new Float32Array(W * H);
  // a pixel belongs to a thin feature when no fully choked base survives within r + 1 px (the feature vanished)
  const inv = new Float32Array(W * H); for (let i = 0; i < W * H; i++) inv[i] = full[i] > 0.02 ? 0 : 1;
  const nearSurvivor = minFilter(inv, W, H, r + 1); // 0 where a survivor is within reach
  for (let i = 0; i < W * H; i++) out[i] = full[i] > 0.02 ? full[i] : nearSurvivor[i] > 0.5 ? thin[i] : 0;
  return out;
}
/** Soft choke (UBFADE): the choke hides the base's hard edges under the colour; a smooth fade has no edge to hide, and a
    full choke there cut the base's tail r px short of the colour's. The drop the full choke makes at a pixel (raw −
    choked) is under 0.1 inside a fade and near 1 at an edge; the choke is applied in proportion, smoothly between. */
export function softChoke(src, W, H, r) {
  const full = adaptiveChoke(src, W, H, r); if (r <= 0) return full; const out = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) { const e = src[i] - full[i], t = Math.max(0, Math.min(1, (e - 0.1) / 0.2)); out[i] = src[i] - e * t * t * (3 - 2 * t); }
  return out;
}
/* Render one plate as a 1-bit bitmap (Uint8Array, 1 = ink). */
/** Interlocked screens need nested dot shapes (the shape at one tone inside the shape at every larger tone), so bands
    of tone can be cut from them: ink k fills the band from the inks printed before it to itself, and two inks in one
    cell tile it (a dot and the holes around it) instead of stacking. The round dot above switches from a dot to holes
    at 50% and is not nested, so these films use the Euclidean dot (round in the highlights, a checkerboard at 50%,
    round holes in the shadows; the shape Photoshop's round dot follows), rank-scaled so a band of tone covers exactly
    that share of the cell. lockT is the tone at which a film pixel turns on. */
let LOCK_CDF = /** @type {Float32Array | null} */ (null);
const lockSpot = (X, Y) => { const ax = Math.abs(X), ay = Math.abs(Y); return ax + ay <= 1 ? (X * X + Y * Y) / 2 : 1 - ((ax - 1) * (ax - 1) + (ay - 1) * (ay - 1)) / 2; };
function lockCdf() {
  if (LOCK_CDF) return LOCK_CDF; const B = 4096, G = 512, hist = new Float64Array(B);
  for (let i = 0; i < G; i++) for (let j = 0; j < G; j++) hist[Math.min(B - 1, Math.floor(lockSpot((i + 0.5) / G * 2 - 1, (j + 0.5) / G * 2 - 1) * B))]++;
  const cdf = new Float32Array(B + 1); for (let b = 0; b < B; b++) cdf[b + 1] = cdf[b] + hist[b] / (G * G); return (LOCK_CDF = cdf);
}
export function lockT(x, y, cell, cs, sn) {
  const u = (x * cs + y * sn) / cell, v = (-x * sn + y * cs) / cell, X = (u - Math.floor(u)) * 2 - 1, Y = (v - Math.floor(v)) * 2 - 1;
  const cdf = lockCdf(), B = cdf.length - 1, f = Math.min(B - 1e-6, lockSpot(X, Y) * B), b = Math.floor(f);
  return cdf[b] + (f - b) * (cdf[b + 1] - cdf[b]);
}
/** Dot shapes for AM films (Film settings, Dot shape). Round is amOn above (the default; the films did not change). The
    others use the spot functions of ISO 32000-1:2008 (PDF 1.7) Table 128, which are also the PostScript names a RIP
    knows: a spot function gives each spot of a halftone cell (corners at ±1) its place in the order the cell fills with
    ink, highest value first. The film fills the cell in that order, rank-scaled (like lockT) so a tone a covers exactly a
    of the cell. Ellipse: dots longer than wide that join on the long side first; Square: square dots; Line: lines along
    the screen angle. */
export const DOT_SHAPES = /** @type {const} */ (["round", "ellipse", "square", "line"]);
/** @type {Record<string, (x: number, y: number) => number>} */
export const SPOT_FN = {
  round: (x, y) => { const ax = Math.abs(x), ay = Math.abs(y); return ax + ay <= 1 ? 1 - (x * x + y * y) : (ax - 1) * (ax - 1) + (ay - 1) * (ay - 1) - 1; },
  ellipse: (x, y) => { const ax = Math.abs(x), ay = Math.abs(y), w = 3 * ax + 4 * ay - 3;
    return w < 0 ? 1 - (ax * ax + (ay / 0.75) * (ay / 0.75)) / 4 : w > 1 ? ((1 - ax) * (1 - ax) + ((1 - ay) / 0.75) * ((1 - ay) / 0.75)) / 4 - 1 : 0.5 - w; },
  square: (x, y) => -Math.max(Math.abs(x), Math.abs(y)),
  line: (x, y) => -Math.abs(y),
};
/** @type {Record<string, Float32Array>} */ const SPOT_CDF = {};
function spotCdf(shape) {
  if (SPOT_CDF[shape]) return SPOT_CDF[shape]; const B = 4096, G = 512, hist = new Float64Array(B), fn = SPOT_FN[shape];
  for (let i = 0; i < G; i++) for (let j = 0; j < G; j++) hist[Math.min(B - 1, Math.max(0, Math.floor((fn((i + 0.5) / G * 2 - 1, (j + 0.5) / G * 2 - 1) + 1) / 2 * B)))]++;
  const cdf = new Float32Array(B + 1); for (let b = 0; b < B; b++) cdf[b + 1] = cdf[b] + hist[b] / (G * G); return (SPOT_CDF[shape] = cdf);
}
/** The tone at which film pixel (x, y) turns on for a dot shape: the share of the cell that fills before it. */
export function dotT(shape, x, y, cell, cs, sn) {
  const u = (x * cs + y * sn) / cell, v = (-x * sn + y * cs) / cell, X = (u - Math.floor(u)) * 2 - 1, Y = (v - Math.floor(v)) * 2 - 1;
  const cdf = spotCdf(shape), B = cdf.length - 1, f = Math.min(B - 1e-6, Math.max(0, (SPOT_FN[shape](X, Y) + 1) / 2 * B)), b = Math.floor(f);
  return 1 - (cdf[b] + (f - b) * (cdf[b + 1] - cdf[b]));
}
const isRound = shape => !shape || shape === "round" || !SPOT_FN[shape];
/** One halftone pixel for any dot shape: the screening the films, the test strip and the Print view share. */
export function dotOn(shape, x, y, a, cell, cs, sn) {
  if (isRound(shape)) return amOn(x, y, a, cell, cs, sn);
  if (a <= 0) return false; if (a >= 1) return true; return dotT(shape, x, y, cell, cs, sn) < a;
}
/** Interlocked films need a nested shape: the Euclidean round of lockT, or the chosen shape (every shape above is nested). */
export function nestedT(shape, x, y, cell, cs, sn) { return isRound(shape) ? lockT(x, y, cell, cs, sn) : dotT(shape, x, y, cell, cs, sn); }
/** Screen angle to film axes. Angles count counterclockwise from horizontal, as shops, RIPs and PostScript state them
    (setscreen). Film rows run top to bottom (y down), so a counterclockwise turn on the film is a negative turn in pixel
    space. Every film, test strip and Print view goes through here, so the films, the card, the DCS plates and the PSD
    screens carry the same angle. */
export function screenAxes(angle) { const th = -angle * Math.PI / 180; return { cs: Math.cos(th), sn: Math.sin(th) }; }
export function renderPlate({ plate, printed, ub, W, H, N, Wp, Hp, x0 = 0, y0 = 0, w = Wp, h = Hp, dpi, lpi, angle, screening, mode, dot, choke, fmIdx, lock = false, solid = null }) {
  const bits = new Uint8Array(w * h);
  const { cs, sn } = screenAxes(angle), cell = dpi / lpi, shape = dot && dot.shape;
  let src;
  // Solid shapes split the film into two colour fields with the shape's hard edge between them: inside, the screens read
  // only the shape's own pixels (its whole pixels; its edge pixels when it has none); outside, only the pixels that are
  // not the shape's (the edge pixels when nothing else is near). So no screen leaks across the edge: a shape's 100% does
  // not spill half a pixel of dots around it, and a tint shape's recipe stays inside it.
  const solidK = solid && solid.ink ? solid.ink : null, geo = solidK ? solid.geo : null;
  // inside the shape: whole pixels, and in an edge pixel the side of its straight edge (see edgeGeometry)
  const inside = (q, X, Y) => { const t = solid.frac[q]; if (t >= 1) return true; if (t <= 0) return false;
    if (!geo || (geo[q * 3] === 0 && geo[q * 3 + 1] === 0)) return t > 0.5;
    return (X - (q % W) - 0.5) * geo[q * 3] + (Y - Math.floor(q / W) - 0.5) * geo[q * 3 + 1] > geo[q * 3 + 2]; };
  let zone = null, zq = null;
  if (solidK) { zone = new Uint8Array(w * h); zq = new Int32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const X = (x + x0 + 0.5) / Wp * W, Y = (y + y0 + 0.5) / Hp * H, q = Math.min(H - 1, Math.floor(Y)) * W + Math.min(W - 1, Math.floor(X));
      if (solidK[q]) { zq[y * w + x] = q; zone[y * w + x] = inside(q, X, Y) ? 2 : 1; } } }
  const field = (arr, NN, ci) => { if (!solidK) { const s0 = sampler(arr, W, H, NN, ci); return (x, y) => s0((x + x0 + 0.5) / Wp, (y + y0 + 0.5) / Hp); }
    const core = q => solidK[q] > 0 && solid.frac[q] >= 1, at = q => NN ? arr[q * NN + ci] : arr[q];
    const out1 = maskedSampler(arr, W, H, NN, ci, q => solidK[q] > 0), in1 = maskedSampler(arr, W, H, NN, ci, q => !core(q)), open = solid.open;
    // outside: the pixels that are not the shape's; where all four are, each edge pixel un-mixed (outside = garment, 0,
    // where the edge was transparent), weighted by its outside share
    const outAt = (u, v) => { const r = out1(u, v); if (!Number.isNaN(r)) return r;
      const X = Math.min(W - 1.001, Math.max(0, u * W - 0.5)), Y = Math.min(H - 1.001, Math.max(0, v * H - 0.5)), xa = X | 0, ya = Y | 0, fx = X - xa, fy = Y - ya;
      let num = 0, den = 0, ins = NaN;
      for (let j = 0; j < 4; j++) { const q = (ya + (j >> 1)) * W + xa + (j & 1), wt = (j & 1 ? fx : 1 - fx) * (j >> 1 ? fy : 1 - fy), f = Math.min(1, solid.frac[q]); if (wt <= 0 || f >= 1) continue;
        if (open && open[q]) { den += wt * (1 - f); continue; }
        if (Number.isNaN(ins)) { ins = in1(u, v); if (Number.isNaN(ins)) ins = at(q); }
        num += wt * Math.max(0, Math.min(1, (at(q) - f * ins) / (1 - f))) * (1 - f); den += wt * (1 - f); }
      return den > 1e-6 ? num / den : 0; };
    // inside: the shape's pixels, each edge pixel un-mixed (its value is f × inside + (1 − f) × outside), weighted by f
    const inAt = (u, v) => { const o = outAt(u, v), X = Math.min(W - 1.001, Math.max(0, u * W - 0.5)), Y = Math.min(H - 1.001, Math.max(0, v * H - 0.5)), xa = X | 0, ya = Y | 0, fx = X - xa, fy = Y - ya;
      let num = 0, den = 0;
      for (let j = 0; j < 4; j++) { const q = (ya + (j >> 1)) * W + xa + (j & 1), wt = (j & 1 ? fx : 1 - fx) * (j >> 1 ? fy : 1 - fy); if (!solidK[q] || wt <= 0) continue; const f = Math.min(1, solid.frac[q]); num += wt * (at(q) - (1 - f) * o); den += wt * f; }
      return den > 1e-6 ? Math.max(0, Math.min(1, num / den)) : o; };
    const plain = sampler(arr, W, H, NN, ci);
    const whole = q => solidK[q] > 0 && solid.frac[q] >= 1;
    return (x, y) => { const u = (x + x0 + 0.5) / Wp, v = (y + y0 + 0.5) / Hp, i = y * w + x;
      if (zone[i] === 2) { const xa = Math.min(W - 1.001, Math.max(0, u * W - 0.5)) | 0, ya = Math.min(H - 1.001, Math.max(0, v * H - 0.5)) | 0, q = ya * W + xa;
        return whole(q) && whole(q + 1) && whole(q + W) && whole(q + W + 1) ? plain(u, v) : inAt(u, v); }
      // away from every shape (none of the four pixels is a shape's): the plain value
      if (!zone[i]) { const xa = Math.min(W - 1.001, Math.max(0, u * W - 0.5)) | 0, ya = Math.min(H - 1.001, Math.max(0, v * H - 0.5)) | 0, q = ya * W + xa;
        if (!solidK[q] && !solidK[q + 1] && !solidK[q + W] && !solidK[q + W + 1]) return plain(u, v); }
      return outAt(u, v); }; };
  let solidOn = null;
  if (plate.ub) {
    const smp = field(ub, 0, 0), raw = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw[y * w + x] = smp(x, y);
    // the base under a shape that needs it (over half) is solid to the shape's hard edge, not choked
    if (zone) { solidOn = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) if (zone[i] === 2 && raw[i] >= 0.5) solidOn[i] = 1; }
    const ch = UB_FADE ? softChoke(raw, w, h, choke) : adaptiveChoke(raw, w, h, choke); src = (x, y) => ch[y * w + x];
  } else src = field(printed, N, plate.idx);
  // interlocked: this ink's band starts where the inks printed before it end (their summed coverage at this spot)
  const before = lock && !plate.ub && mode === "sim" ? Array.from({ length: plate.idx }, (_, j) => sampler(printed, W, H, N, j)) : null;
  const binary = mode !== "sim";
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let on;
    if (fmIdx && !plate.ub) on = fmIdx.idx[(((y + y0) / fmIdx.s | 0) - fmIdx.y0) * fmIdx.w + (((x + x0) / fmIdx.s | 0) - fmIdx.x0)] === plate.idx;
    else if (binary) on = src(x, y) > 0.5;
    // solid line work and shapes: inside the shape its ink (or, for any shape that needs it, the base) prints solid to
    // the hard edge; every other screen is halftone from its own side's colour field (src)
    else if (zone && zone[y * w + x] === 2 && (plate.ub ? solidOn[y * w + x] : solidK[zq[y * w + x]] === plate.idx + 1)) on = true;
    else if (before) { const a = src(x, y); if (a <= 1e-4) on = false;
      else { const uu = (x + x0 + 0.5) / Wp, vv = (y + y0 + 0.5) / Hp; let c0 = 0; for (const s of before) c0 += s(uu, vv);
        // the band's edges carry the dot-gain compensation (each edge is where a printed shape ends and grows on press)
        const X = x + x0, Y = y + y0, cu = Math.floor((X * cs + Y * sn) / cell), cv = Math.floor((-X * sn + Y * cs) / cell);
        const sh = t => { if (t <= 0) return 0; if (t >= 1) return 1; const n = plate.curve ? invCurve(t, plate.curve) : invGain(t, dot.gain);
          return n <= dot.maxDot ? n : dot.scatter ? scatterHoles(n, dot.maxDot, cu, cv) : 1; };
        const lo = sh(c0), hi = sh(Math.min(1, c0 + a)), t = nestedT(shape, x + x0, y + y0, cell, cs, sn); on = t >= lo && t < hi; } }
    else { const md = Math.max(dot.minDot, plate.minDot || 0); let a = shapeDot(src(x, y), { ...dot, curve: plate.curve, minDot: md });
      // Scatter: a tone under the smallest dot prints whole smallest dots in that share of the cells (spread evenly by an
      // ordered 8×8 pattern over the halftone cells), so a fade keeps going to zero instead of stopping in a hard line
      if (dot.scatter && a > 0 && (a < md || a > dot.maxDot) && a < 1) { const X = x + x0, Y = y + y0, cu = Math.floor((X * cs + Y * sn) / cell), cv = Math.floor((-X * sn + Y * cs) / cell);
        a = a < md ? (a / md >= SCATTER_FLOOR && bayerCell(cu, cv) < a / md ? md : 0) : scatterHoles(a, dot.maxDot, cu, cv); }
      on = lock ? a > 0 && (a >= 1 || nestedT(shape, x + x0, y + y0, cell, cs, sn) < a) : dotOn(shape, x + x0, y + y0, a, cell, cs, sn); }
    bits[y * w + x] = on ? 1 : 0;
  }
  return bits;
}

/* ───────────── Solid detail ─────────────
   Thin line work and small type print solid, the way a separator keeps them on a spot channel: a halftone cell is about
   0.56 mm at 45 LPI, so a 1.5 mm line is only 2–3 dots wide and breaks up (on the sample's water lines 34% of the core
   showed bare shirt). A pixel is a detail when it stands out from its surroundings (ΔE00 ≥ contrast from the median of a
   window about 10 halftone cells wide, so the detail is the minority there) and its colour is within maxDE of one ink.
   Its soft edge is decided pixel by pixel: closer to the detail's ink joins it, otherwise it takes the background colour.
   Returns the ink index for each snapped pixel (-1 elsewhere) and a copy of the art with the edges hardened. */
/** Share of opaque pixels whose neighbours barely differ (flat fills and smooth fades): graphic art scores high (the
    sample 92%), photos low (17 real photos 0–64%). Solid detail runs on graphic art only. */
export function smoothShare(px, alpha, W, H) {
  let s = 0, n = 0;
  for (let y = 1; y < H - 1; y += 2) for (let x = 1; x < W - 1; x += 2) { const p = y * W + x; if (alpha[p] < 250) continue; n++; let mx = 0;
    for (const q of [p - 1, p + 1, p - W, p + W]) { const d = Math.abs(px[p * 3] - px[q * 3]) + Math.abs(px[p * 3 + 1] - px[q * 3 + 1]) + Math.abs(px[p * 3 + 2] - px[q * 3 + 2]); if (d > mx) mx = d; }
    if (mx <= 6) s++; }
  return s / Math.max(1, n);
}
export function solidDetail({ px, alpha, W, H, inkLabs, cellPx, garment = [17, 17, 17], maxDE = 15, contrast = 18, minArea = 15, maxSpread = 4, minSmooth = 0.8, flatDE = 3.5 }) {
  const P = W * H;
  if (smoothShare(px, alpha, W, H) < minSmooth) return { snap: new Int16Array(P).fill(-1), px: new Uint8ClampedArray(px) };
  const R = Math.max(5, Math.round(5 * cellPx)), snap = new Int16Array(P).fill(-1), out = new Uint8ClampedArray(px);
  // each shape's own colour (inCol) and whether it is an ink's colour (prints that ink solid) or a tint near it (tint 1:
  // a hard base and the shape's colour from the solve inside, clipped to the shape — cream lines stay cream)
  const inCol = new Uint8ClampedArray(P * 3), tint = new Uint8Array(P), inkRGB = inkLabs.map(l => lab2rgb(l)), tints = [];
  const bg = new Float32Array(P * 3).fill(-1), LAB = new Float32Array(P * 3), shape = new Uint8Array(P); // shape: set by the solid-shape pass (not line work)
  for (let p = 0; p < P; p++) LAB.set(rgb2lab(px[p * 3], px[p * 3 + 1], px[p * 3 + 2]), p * 3);
  const labOf = p => [LAB[p * 3], LAB[p * 3 + 1], LAB[p * 3 + 2]];
  // detection sees the art as it prints: on the garment (a hairline on a transparent background is all soft pixels)
  const cpx = new Uint8ClampedArray(P * 3); for (let p = 0; p < P; p++) { const a = alpha[p] / 255; for (let c = 0; c < 3; c++) cpx[p * 3 + c] = px[p * 3 + c] * a + garment[c] * (1 - a); }
  const vr = [], vg = [], vb = [];
  // the window's values are bytes: sorted in typed buffers (numeric sort, no comparator), the same median as before
  const WN = (2 * R + 1) * (R + 1), mr = new Uint8Array(WN), mg = new Uint8Array(WN), mb = new Uint8Array(WN);
  const median = (x, y) => { let k = 0;
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx += 2) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue; const q = yy * W + xx; mr[k] = cpx[q * 3]; mg[k] = cpx[q * 3 + 1]; mb[k++] = cpx[q * 3 + 2]; }
    if (k < 8) return null; const mid = a => a.subarray(0, k).sort()[k >> 1]; return [mid(mr), mid(mg), mid(mb)]; };
  const DIST = [Math.max(3, Math.round(R / 2)), R], AXES = [[1, 0], [0, 1], [1, 1], [1, -1]];
  const far = (p, q) => Math.abs(cpx[p * 3] - cpx[q * 3]) + Math.abs(cpx[p * 3 + 1] - cpx[q * 3 + 1]) + Math.abs(cpx[p * 3 + 2] - cpx[q * 3 + 2]) > 30;
  // pass 1: the detail's core (stands out, and close to one ink)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const p = y * W + x; if (alpha[p] < 128) continue;
    // quick skip: a thin detail differs from both sides of it along one axis while those two sides match each other;
    // a gradient pixel lies between its sides, and the edge of a large shape matches one side
    let thin = false;
    for (const d of DIST) { if (thin) break; for (const [ax, ay] of AXES) { const x1 = x - ax * d, y1 = y - ay * d, x2 = x + ax * d, y2 = y + ay * d;
      if (x1 < 0 || y1 < 0 || x2 < 0 || y2 < 0 || x1 >= W || x2 >= W || y1 >= H || y2 >= H) continue; const q1 = y1 * W + x1, q2 = y2 * W + x2;
      if (far(p, q1) && far(p, q2) && !far(q1, q2)) { thin = true; break; } } }
    if (!thin) continue;
    const m = median(x, y); if (!m) continue; bg.set(m, p * 3);
    const L = labOf(p), mb = rgb2lab(m[0], m[1], m[2]), Lc = alpha[p] < 250 ? rgb2lab(cpx[p * 3], cpx[p * 3 + 1], cpx[p * 3 + 2]) : L; if (de2000(...Lc, ...mb) < contrast) continue;
    let k = -1, best = maxDE; for (let i = 0; i < inkLabs.length; i++) { const d = de2000(...L, ...inkLabs[i]); if (d < best) { best = d; k = i; } }
    if (k >= 0) snap[p] = k; }
  // keep only real details: connected pieces of one ink, big enough to be a line or a letter, with a nearly uniform
  // colour (texture and highlights in a photo-like area are scattered or mottled)
  { const seen = new Uint8Array(P), stack = [];
    for (let p0 = 0; p0 < P; p0++) { if (snap[p0] < 0 || seen[p0]) continue; const k = snap[p0], comp = []; stack.push(p0); seen[p0] = 1;
      while (stack.length) { const p = /** @type {number} */ (stack.pop()); comp.push(p); const x = p % W, y = (p - x) / W;
        for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, y > 0 ? p - W : -1, y < H - 1 ? p + W : -1]) if (q >= 0 && !seen[q] && snap[q] === k) { seen[q] = 1; stack.push(q); } }
      let keep = comp.length >= minArea;
      if (keep) { const m = [0, 0, 0], L = comp.map(labOf); for (const l of L) for (let c = 0; c < 3; c++) m[c] += l[c] / L.length;
        let sp = 0; for (const l of L) sp += de2000(...l, m[0], m[1], m[2]); keep = sp / L.length <= maxSpread; }
      if (!keep) { for (const p of comp) snap[p] = -1; continue; }
      // extend the detail along connected pixels of its own colour (a line's ends where it runs into another shape stop
      // standing out from their surroundings, but they are the same line); capped at three times the detail's own size
      const mc = [0, 0, 0]; for (const p of comp) for (let c = 0; c < 3; c++) mc[c] += LAB[p * 3 + c] / comp.length;
      // (its own colour only: a shape of the ink's colour beside it, such as a ring the line runs under, is its own shape)
      const grow = [...comp]; let added = 0, head = 0; const ik = inkLabs[k], gap = de2000(mc[0], mc[1], mc[2], ...ik);
      while (head < grow.length && added < 3 * comp.length) { const p = grow[head++], x = p % W, y = (p - x) / W;
        for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, y > 0 ? p - W : -1, y < H - 1 ? p + W : -1]) {
          if (q < 0 || seen[q] || snap[q] >= 0 || alpha[q] < 250) continue; seen[q] = 1;
          if (de2000(LAB[q * 3], LAB[q * 3 + 1], LAB[q * 3 + 2], mc[0], mc[1], mc[2]) > 6) { seen[q] = 0; continue; } snap[q] = k; grow.push(q); added++; } }
      // within 6 of the ink it is the ink (prints solid); further, it keeps its own colour
      // within 6 of the ink it is the ink. Further off (cream line work near White) no ink matches: it prints as the ink,
      // solid and clean (a mix of inks inside a thin line reads as specks or a wrong hue: tested on the sample, White +
      // Flesh came out peach), and the separation offers a screen in its own colour (lineSuggest). SOLIDTINT=1 prints
      // it as a tint instead: a hard base and the solve's recipe inside.
      if (gap > 6) tints.push({ lab: [mc[0], mc[1], mc[2]], k, n: grow.length, gap });
      const hard = gap <= 6 || globalThis.process?.env?.SOLIDTINT !== "1", col = hard ? inkRGB[k] : lab2rgb(mc); for (const p of grow) { tint[p] = hard ? 0 : 1; inCol.set(col, p * 3); } } }
  // solid shapes: flat areas in exactly one ink's colour (lettering, rings, logo fills) print as that ink, so their edges
  // can be hard too. Flat = the same colour 6 px away in every direction (a smooth fade changes over 6 px); exact =
  // within flatDE of the ink (the sample's white type and ring are 0.5 from White; its sun's pale centre is 6 away)
  for (let y = 6; y < H - 6; y++) for (let x = 6; x < W - 6; x++) { const p = y * W + x; if (snap[p] >= 0 || alpha[p] < 250) continue;
    // cheap first: the pixel is near some ink in RGB at all
    let near = false; for (const c of inkRGB) if (Math.abs(px[p * 3] - c[0]) + Math.abs(px[p * 3 + 1] - c[1]) + Math.abs(px[p * 3 + 2] - c[2]) <= 24) { near = true; break; } if (!near) continue;
    // flat: every opaque neighbour 3 and 6 px away has the same colour (transparent ones, beside type on a transparent
    // background, do not count against it), and at least three are opaque
    let flat = true, opaque = 0; for (const q of [p - 6, p + 6, p - 6 * W, p + 6 * W, p - 3, p + 3, p - 3 * W, p + 3 * W]) { if (alpha[q] < 250) continue; opaque++;
      if (Math.abs(px[p * 3] - px[q * 3]) + Math.abs(px[p * 3 + 1] - px[q * 3 + 1]) + Math.abs(px[p * 3 + 2] - px[q * 3 + 2]) > 6) { flat = false; break; } }
    if (!flat || opaque < 3) continue; const L = labOf(p); let k = -1, best = flatDE; for (let i = 0; i < inkLabs.length; i++) { const d = de2000(...L, ...inkLabs[i]); if (d < best) { best = d; k = i; } } if (k >= 0) { snap[p] = k; shape[p] = 1; inCol.set(inkRGB[k], p * 3); } }
  // grow each shape from those flat starting points through every connected pixel that is exactly its ink's colour (a
  // ring or a letter is solid across its whole width, not only where it is 12 px wide); the start stays strict, so a
  // smooth fade never starts a shape
  { const q0 = []; for (let p = 0; p < P; p++) if (snap[p] >= 0) q0.push(p);
    for (let head = 0; head < q0.length; head++) { const p = q0[head], k = snap[p], x = p % W, y = (p - x) / W, ik = inkLabs[k];
      for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, y > 0 ? p - W : -1, y < H - 1 ? p + W : -1]) {
        if (q < 0 || snap[q] >= 0 || alpha[q] < 250) continue;
        if (de2000(LAB[q * 3], LAB[q * 3 + 1], LAB[q * 3 + 2], ik[0], ik[1], ik[2]) > flatDE) continue; snap[q] = k; shape[q] = shape[p]; tint[q] = tint[p]; inCol.copyWithin(q * 3, p * 3, p * 3 + 3); q0.push(q); } } }
  // pass 2: the soft edge. Its pixels keep the art's own anti-aliasing as the edge position: a pixel 70% shape and 30%
  // background gets 0.7 of the shape's ink, and the film is cut at 0.5 of the smoothly interpolated value, so the edge
  // follows the art's curves inside the pixel (flat and smooth, not a staircase of whole pixels). The fraction comes
  // from transparency (type on a transparent background) or from where the colour sits between the ink and the colour
  // on the other side. The rest of an edge pixel is the other side's colour.
  const frac = new Float32Array(P); for (let p = 0; p < P; p++) if (snap[p] >= 0) frac[p] = alpha[p] < 250 ? alpha[p] / 255 : 1;
  const core = Int16Array.from(snap);
  for (let ring = 0; ring < 2; ring++) { const cur = Int16Array.from(snap);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const p = y * W + x; if (cur[p] !== -1 || alpha[p] === 0) continue;
    let k = -1, from = -1; for (let dy = -1; dy <= 1 && k < 0; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue; const q = yy * W + xx; if (cur[q] >= 0 && (ring === 0 || frac[q] >= 0.5)) { k = cur[q]; from = q; break; } }
    if (k < 0) continue; tint[p] = tint[from]; inCol.copyWithin(p * 3, from * 3, from * 3 + 3);
    if (alpha[p] < 250) { snap[p] = k; frac[p] = alpha[p] / 255; continue; }
    vr.length = vg.length = vb.length = 0;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue; const q = yy * W + xx;
      if (alpha[q] < 250 || core[q] >= 0) continue; const il = rgb2lab(inCol[p * 3], inCol[p * 3 + 1], inCol[p * 3 + 2]); if ((LAB[q * 3] - il[0]) ** 2 + (LAB[q * 3 + 1] - il[1]) ** 2 + (LAB[q * 3 + 2] - il[2]) ** 2 < 625) continue; vr.push(px[q * 3]); vg.push(px[q * 3 + 1]); vb.push(px[q * 3 + 2]); }
    const c = [inCol[p * 3], inCol[p * 3 + 1], inCol[p * 3 + 2]];
    if (!vr.length) { snap[p] = k; frac[p] = 1; continue; }
    const mid = a => { a.sort((u, v) => u - v); return a[a.length >> 1]; }, m = [mid(vr), mid(vg), mid(vb)];
    // where this pixel's colour sits on the way from the other side's colour to the ink's (the art's own blend)
    let num = 0, den = 0; for (let ch = 0; ch < 3; ch++) { const d = c[ch] - m[ch]; num += (px[p * 3 + ch] - m[ch]) * d; den += d * d; }
    const t = den > 1 ? Math.max(0, Math.min(1, num / den)) : 0;
    if (t <= 0.02) continue; snap[p] = k; frac[p] = t; out[p * 3] = m[0]; out[p * 3 + 1] = m[1]; out[p * 3 + 2] = m[2]; } }
  for (let p = 0; p < P; p++) if (snap[p] >= 0 && frac[p] >= 1) out.set(inCol.subarray(p * 3, p * 3 + 3), p * 3);
  // the art with every shape pixel at its shape's own colour (the inside colour field, for the solve)
  const inPx = new Uint8ClampedArray(px); for (let p = 0; p < P; p++) if (snap[p] >= 0) inPx.set(inCol.subarray(p * 3, p * 3 + 3), p * 3);
  return { snap, frac, px: out, geo: edgeGeometry(snap, frac, W, H), tint, inPx, tints, core, shape };
}

/** Smooth map (SMOOTHMAP): a solid shape found in a fade is not a shape. The shape pass takes every flat pixel within
    flatDE of an ink, and a slow fade (the hue wheel's rim, a sky) is flat to it, so a band of the fade printed solid and
    its outline was a hard contour drawn at flatDE in colour space. A shape whose own colours spread (p95 − p5 of the
    distance to its ink over `span` ΔE00) is a fade: its pixels leave the mask and print the map's recipe, pulled toward
    the solid ink by w = 1 − smoothstep(lo, flatDE, distance), so the solid core of the fade is reached continuously.
    Flat shapes (logo fills, type, rings: one colour) and line work stay hard. Returns the weights (−1 = unchanged). */
export function fadeShapes(sd, lab, W, H, inkLabs, { span = 1, lo = 0.5, flatDE = 3.5 } = {}) {
  const P = W * H, { snap, core, shape } = sd, w = new Float32Array(P).fill(-1); if (!shape || !core) return w; const seen = new Uint8Array(P), d = new Float32Array(P);
  const inMask = p => FADE_DETAIL ? snap[p] >= 0 : shape[p]; // FADEDETAIL: line-work components are tested as well
  for (let p0 = 0; p0 < P; p0++) { if (seen[p0] || !inMask(p0) || core[p0] < 0) continue; const k = core[p0], comp = [p0]; seen[p0] = 1;
    for (let h = 0; h < comp.length; h++) { const p = comp[h], x = p % W, y = (p - x) / W;
      for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, y > 0 ? p - W : -1, y < H - 1 ? p + W : -1]) if (q >= 0 && !seen[q] && inMask(q) && core[q] === k) { seen[q] = 1; comp.push(q); } }
    const ik = inkLabs[k]; for (const p of comp) d[p] = de2000(lab[p * 3], lab[p * 3 + 1], lab[p * 3 + 2], ik[0], ik[1], ik[2]);
    const ds = comp.map(p => d[p]).sort((a, b) => a - b), sp = ds[Math.floor(0.95 * (ds.length - 1))] - ds[Math.floor(0.05 * (ds.length - 1))];
    if (sp <= span) continue;
    for (const p of comp) { const t = Math.max(0, Math.min(1, (d[p] - lo) / Math.max(1e-6, flatDE - lo))); w[p] = 1 - t * t * (3 - 2 * t); } }
  // the edge ring the shape pass grew around a fade leaves with it
  for (let ring = 0; ring < 2; ring++) { const cur = Float32Array.from(w);
    for (let p = 0; p < P; p++) { if (snap[p] < 0 || core[p] >= 0 || w[p] >= 0) continue; const x = p % W, y = (p - x) / W;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue; if (cur[yy * W + xx] >= 0) { w[p] = 0; dy = 2; break; } } } }
  return w;
}
/** Where the edge runs inside each soft edge pixel: a straight edge across the pixel, square to the way the shape's
    fraction rises (its direction n), placed so the part on the shape's side has exactly the pixel's fraction of its area.
    The film then holds the art's coverage exactly (a 1.5 px line prints 1.5 px wide, not wider) and the edge follows the
    art's direction from pixel to pixel. Returns [nx, ny, c] per pixel: the film is the shape's where (offset from the
    pixel centre) · n > c; n = 0 where there is no direction (the pixel then goes whole to the side holding over half). */
export function edgeGeometry(snap, frac, W, H) {
  const geo = new Float32Array(W * H * 3), F = q => snap[q] >= 0 ? frac[q] : 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const p = y * W + x, t = frac[p]; if (snap[p] < 0 || t >= 1 || t <= 0) continue;
    // direction from the 3×3 neighbourhood (Sobel), so a curve's direction changes smoothly from pixel to pixel
    let gx = 0, gy = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if ((dx === 0 && dy === 0) || xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      const v = F(yy * W + xx), wgt = dx && dy ? 1 : 2; gx += dx * v * wgt; gy += dy * v * wgt; }
    const g = Math.hypot(gx, gy); if (g < 1e-3) continue; const nx = gx / g, ny = gy / g;
    // the share of the unit square beyond offset c along n: the projection of the square onto n spreads as the sum of
    // two even spreads of widths |nx| and |ny|; c is found by halving
    const a = Math.max(Math.abs(nx), Math.abs(ny)), b = Math.min(Math.abs(nx), Math.abs(ny)), hw = (a + b) / 2;
    const cdf = c => { const u = c + hw; if (u <= 0) return 0; if (u >= a + b) return 1; if (b < 1e-6) return u / a; return u < b ? u * u / (2 * a * b) : u < a ? (u - b / 2) / a : 1 - (a + b - u) ** 2 / (2 * a * b); };
    let lo = -hw, hi = hw; for (let i = 0; i < 24; i++) { const c = (lo + hi) / 2; if (1 - cdf(c) > t) lo = c; else hi = c; }
    geo[p * 3] = nx; geo[p * 3 + 1] = ny; geo[p * 3 + 2] = (lo + hi) / 2; }
  return geo;
}
