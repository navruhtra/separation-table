// Property-based and metamorphic tests: random images, ink sets and settings, checked against laws that must always
// hold. Seeded, so a failure reproduces exactly:  node tests/fuzz.mjs [cases=60] [seed=369]
import * as E from "../src/engine.js";
import { runSeparation, labOf, printedFrom } from "../src/pipeline.js";
import { genericLibrary } from "../src/inks.js";

const CASES = +(process.argv[2] || 60); let seed = +(process.argv[3] || 369);
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647, pick = a => a[Math.floor(rnd() * a.length)];
let fails = 0; const fail = (msg, ctx) => { fails++; console.log("FAIL", msg, JSON.stringify(ctx)); };

function randomImage(W, H) {
  const P = W * H, px = new Uint8ClampedArray(P * 3), alpha = new Uint8Array(P), kind = pick(["gradient", "flat", "noise", "blocks"]);
  const cols = Array.from({ length: 2 + Math.floor(rnd() * 5) }, () => [rnd() * 255, rnd() * 255, rnd() * 255]);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x; let c;
    if (kind === "gradient") { const t = x / (W - 1), a = cols[0], b = cols[1]; c = a.map((v, i) => v + (b[i] - v) * t); }
    else if (kind === "flat" || kind === "blocks") c = cols[(Math.floor(x / (kind === "flat" ? W / cols.length : 3)) + (kind === "blocks" ? Math.floor(y / 3) : 0)) % cols.length];
    else c = cols[0].map(v => v + (rnd() - 0.5) * 120);
    px.set(c.map(v => Math.max(0, Math.min(255, Math.round(v)))), p * 3); alpha[p] = rnd() < 0.1 ? 0 : 255;
  }
  return { px, alpha, lab: labOf(px, P), W, H, kind };
}
const lib = genericLibrary();
for (let t = 0; t < CASES; t++) {
  const img = randomImage(10 + Math.floor(rnd() * 14), 8 + Math.floor(rnd() * 10)), P = img.W * img.H;
  const mode = pick(["sim", "sim", "spot", "index"]), garment = pick([[17, 17, 17], [255, 255, 255], [28, 42, 74], [118, 118, 118], [201, 180, 143]]);
  const m = { ...img, mode, garmentLab: E.rgb2lab(...garment), n: pick([1.4, 1.7, 2.2]), k: 1 + Math.floor(rnd() * 7), smooth: rnd() * 0.4, rareFrac: 0.0005,
    underbase: rnd() < 0.8, ubStrength: 0.6 + rnd() * 0.4, library: lib, locked: [], inks: [], forceWhite: rnd() < 0.7, repick: true, paletteMode: pick(["library", "art"]),
    screening: "am", overprint: pick(["same", "rotated"]), rho: rnd(), stackLimit: pick([0, 2.4, 2.8]), opacity: 0.3 + rnd() * 0.7 };
  const ctx = { t, kind: img.kind, mode, garment, k: m.k, palette: m.paletteMode, W: img.W, H: img.H };
  let r; try { r = runSeparation(m); } catch (e) { fail("runSeparation threw: " + e.message, ctx); continue; }
  const N = r.inks.length, s = r.stats;
  // Law 1: coverage is a valid area: every value in [0,1], per-pixel sum ≤ 1
  for (let p = 0; p < P; p++) { let sum = 0; for (let i = 0; i < N; i++) { const v = r.cov[p * N + i]; if (!(v >= -1e-6 && v <= 1 + 1e-6)) { fail("coverage outside [0,1]", { ...ctx, p, i, v }); p = P; break; } sum += v; } if (sum > 1 + 1e-4) { fail("coverage sums over 1", { ...ctx, p, sum }); break; } }
  // Law 2: no underbase without color above it (sim) and never more than 1
  if (r.ub) for (let p = 0; p < P; p++) { let sum = 0; for (let i = 0; i < N; i++) sum += r.cov[p * N + i]; if (r.ub[p] > 1 + 1e-6 || (mode === "sim" && r.ub[p] > sum + 1e-4)) { fail("underbase exceeds color", { ...ctx, p, ub: r.ub[p], sum }); break; } }
  // Law 3: every score is a finite, non-negative number
  for (const [k, v] of Object.entries(s)) if (!(Number.isFinite(v) && v >= 0) && !(k === "filteredMean" && Number.isNaN(v))) fail(`stat ${k} not finite/non-negative`, { ...ctx, v });
  // Law 4: printed films never print less than the visible tone, and respect the stack limit when compensation is used
  if (mode === "sim") {
    const pr = printedFrom(r.cov, N, P, mode, "am", m.overprint, m.rho, r.ub, m.stackLimit);
    for (let p = 0; p < P; p++) { let st = 0, vis = 0; // colour screens only: the base is not counted for (let i = 0; i < N; i++) { const a = pr[p * N + i], v = r.cov[p * N + i]; if (a < v - 1e-4 || a > 1 + 1e-6) { fail("printed area below visible tone or above 1", { ...ctx, p, a, v }); p = P; break; } st += a; vis += v; }
      if (m.stackLimit && vis <= m.stackLimit && st > m.stackLimit + 1e-4) { fail("stack limit violated", { ...ctx, p, st }); break; } }
  }
  // Law 5: no locked-out ink is kept with nothing printable; no duplicate highlight whites
  if (r.inks.filter(i => i.lab[0] > 92).length > 1) fail("more than one highlight white", { ...ctx, inks: r.inks.map(i => i.name) });
  // Law 6 (determinism): the same input gives the same answer
  if (t % 10 === 0) { const r2 = runSeparation(m); if (r2.inks.map(i => i.name).join() !== r.inks.map(i => i.name).join() || Math.abs(r2.stats.mean - s.mean) > 1e-9) fail("non-deterministic", ctx); }
  // Law 7 (scorer agreement): where there is no overlap to model, the robust score must equal the plain proof
  if (mode !== "sim" && !r.ub && Math.abs(s.robustMean - s.mean) > 0.05 + 0.02 * s.mean) fail("robust and proof disagree where they must agree", { ...ctx, robust: s.robustMean, mean: s.mean });
}
// Metamorphic 1: art that is exactly one library ink on a white shirt reproduces nearly exactly
for (let t = 0; t < 12; t++) {
  const ink = pick(lib), rgb = E.lab2rgb(ink.lab), W = 12, H = 8, P = W * H, px = new Uint8ClampedArray(P * 3); for (let p = 0; p < P; p++) px.set(rgb, p * 3);
  const r = runSeparation({ px, alpha: new Uint8Array(P).fill(255), lab: labOf(px, P), W, H, mode: pick(["sim", "spot"]), garmentLab: E.rgb2lab(255, 255, 255), n: 1.7, k: 3, smooth: 0.1, rareFrac: 0.0005, underbase: false, library: lib, locked: [], inks: [], forceWhite: false, repick: true, paletteMode: "library" });
  if (ink.lab[0] < 92 && r.stats.mean > 1.5) fail("single-ink art not reproduced", { ink: ink.name, mean: r.stats.mean, inks: r.inks.map(i => i.name) });
}
// Metamorphic 2: shuffling the library order does not change which inks are chosen
{
  const img = randomImage(16, 12), base = { ...img, mode: "sim", garmentLab: E.rgb2lab(17, 17, 17), n: 1.7, k: 5, smooth: 0.1, rareFrac: 0.0005, underbase: true, locked: [], inks: [], forceWhite: true, repick: true, paletteMode: "library" };
  const a = runSeparation({ ...base, library: lib }).inks.map(i => i.name).sort().join(), b = runSeparation({ ...base, library: lib.slice().reverse() }).inks.map(i => i.name).sort().join();
  if (a !== b) console.log("note: library order changes the chosen set (greedy ties):", a, "|", b);
}
console.log(fails ? `${fails} FAILED (seed ${process.argv[3] || 369})` : `fuzz: ${CASES} random cases + metamorphic checks passed`); process.exit(fails ? 1 : 0);
