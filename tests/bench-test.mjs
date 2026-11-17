// Before/after regression test on the shared test images.
//   python3 scripts/prep-images.py   (once: decodes PNGs into .cache/img/*.rgba)
//   node tests/bench-test.mjs [--json out.json]   (from the repository root: .cache/img is read from there)
// Every variant is scored two ways: ADN's base-aware print model and the neutral yardstick used for competitors.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import * as E from "../src/engine.js";
import { runSeparation, evaluate, printView, pickOrder, toneSteps, ORDER_GAIN, STACK_LIMIT } from "../src/pipeline.js";
import { genericLibrary, PRESETS } from "../src/inks.js";
import { cleanSpotSync } from "../src/cvtools.js";

/* Full-resolution fine-detail error for spot plates, after the app's spot cleanup (the neutral scorer works at 260 px,
   which hid the old cleanup erasing 1–2 px strokes). Thin = art that is not the garment and that a 5×5 opening would
   remove, i.e. features under 5 px. Returns mean ΔE00 of the printed label vs the art there, or null if none. */
function thinDetail(img, garmentLab, r) {
  const { W, H, lab, alpha } = img, P = W * H, N = r.inks.length, rad = W > 1200 ? 2 : 1, idx = cleanSpotSync(r.spotIdx, N, W, H, 8 * rad * rad);
  const art = p => alpha[p] > 127 ? [lab[p * 3], lab[p * 3 + 1], lab[p * 3 + 2]] : garmentLab, nong = new Uint8Array(P);
  for (let p = 0; p < P; p++) nong[p] = E.de2000(...art(p), ...garmentLab) > 5 ? 1 : 0;
  const box = (m, erode) => { const o = new Uint8Array(P); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let v = erode ? 1 : 0;
    for (let dy = -2; dy <= 2 && v === (erode ? 1 : 0); dy++) for (let dx = -2; dx <= 2; dx++) { const X = x + dx, Y = y + dy, b = X < 0 || Y < 0 || X >= W || Y >= H ? (erode ? 1 : 0) : m[Y * W + X]; if (erode ? !b : b) { v = erode ? 0 : 1; break; } }
    o[y * W + x] = v; } return o; };
  const opened = box(box(nong, true), false); let s = 0, n = 0;
  for (let p = 0; p < P; p++) if (nong[p] && !opened[p]) { s += E.de2000(...art(p), ...(idx[p] === N ? garmentLab : r.inks[idx[p]].lab)); n++; }
  return n ? +(s / n).toFixed(2) : null;
}

/** Gradient steps: each fade box (x0, y0, x1, y1) is averaged across its short side into a profile along its long side
    (6 px trimmed at each end); a step is the ΔE00 between profile samples 2 px apart. Returns the largest step and the
    count over 1 ΔE00, over all fades. The same reading as the review harness takes from the app's Print view. */
export function gradientSteps(rgba, W, fades, K = 2) {
  let max = 0, over = 0;
  for (const [x0, y0, x1, y1] of fades) {
    const along = x1 - x0 >= y1 - y0, n = along ? x1 - x0 : y1 - y0, m = along ? y1 - y0 : x1 - x0, prof = [];
    for (let i = 0; i < n; i++) { const s = [0, 0, 0];
      for (let j = 0; j < m; j++) { const q = ((along ? y0 + j : y0 + i) * W + (along ? x0 + i : x0 + j)) * 4; for (let c = 0; c < 3; c++) s[c] += rgba[q + c]; }
      prof.push(E.rgb2lab(s[0] / m, s[1] / m, s[2] / m)); }
    for (let i = 6; i + K < n - 6; i++) { const d = E.de2000(...prof[i], ...prof[i + K]); if (d > max) max = d; if (d > 1) over++; }
  }
  return { max: +max.toFixed(2), over };
}
const meta = JSON.parse(readFileSync(".cache/img/meta.json", "utf8"));
function loadImage(name) {
  const [W, H] = meta[name], raw = readFileSync(`.cache/img/${name}.rgba`), P = W * H;
  const px = new Uint8ClampedArray(P * 3), alpha = new Uint8Array(P), lab = new Float32Array(P * 3);
  for (let j = 0; j < P; j++) { px[j * 3] = raw[j * 4]; px[j * 3 + 1] = raw[j * 4 + 1]; px[j * 3 + 2] = raw[j * 4 + 2]; alpha[j] = raw[j * 4 + 3]; lab.set(E.rgb2lab(px[j * 3], px[j * 3 + 1], px[j * 3 + 2]), j * 3); }
  return { px, alpha, lab, W, H };
}
const CASES = JSON.parse(readFileSync(".cache/img/cases.json", "utf8")).filter(c => !process.env.ONLY || c.img.includes(process.env.ONLY));
const library = process.env.LIB ? PRESETS[process.env.LIB].inks() : genericLibrary(), n = 1.7, 
  // sweeps are opt-in (LAMS=0.2,0.5 OPS=0.55,1); by default the gate tests the shipped defaults exactly
  LAMS = process.env.LAMS ? process.env.LAMS.split(",").map(Number) : [undefined], OPS = process.env.OPS ? process.env.OPS.split(",").map(Number) : [undefined];

// v1 = the engine as committed before these fixes (k-free, lightness-weighted base, no white gating, no shirt filter)
const V1 = existsSync(".cache/v1/engine.js") && !process.argv.includes("--gate") ? await import("../.cache/v1/engine.js") : null;
function runV1(base, palette) {
  const m = { ...base }, P = m.W * m.H, fixed = [];
  const { samples } = V1.imageSamples(m.px, m.alpha, P, m.garmentLab, n, { rareFrac: 0.0005 });
  let locked = [];
  if (m.garmentLab[0] < 50) { const w = library.find(i => i.lab[0] > 92); locked.push({ ...w, locked: false }); fixed.push(w.lab); }
  let chosen;
  if (palette === "library") { const lib = library.filter(i => !fixed.some(f => V1.de2000(...f, ...i.lab) < 1)); chosen = V1.librarySubset(samples, lib, m.k, fixed, m.garmentLab, n).map(i => lib[i]); }
  else chosen = V1.hullPalette(samples, m.k, fixed, m.garmentLab, n).map(lab => ({ name: "art", lab }));
  const inks = locked.concat(chosen).sort((a, b) => { const wa = a.lab[0] > 92, wb = b.lab[0] > 92; if (wa !== wb) return wa ? 1 : -1; return b.lab[0] - a.lab[0]; });
  const args = { ...m, inkLabs: inks.map(i => i.lab), n };
  const cov = m.mode === "sim" ? V1.separateSim(args) : V1.separateSpot(args).cov;
  const ev = evaluate({ ...m, legacyUB: (c, N, P2, labs) => V1.buildUnderbase(c, N, P2, labs, 1) }, inks, cov);
  return { inks, ...ev, dropped: [] };
}

/* CPU time (E7): process CPU in ms, user + system. The gate compares the bench's CPU total with the baseline's, each
   divided by the same fixed workload timed in the same process (calibrate), so a slower or busier machine moves both. */
const cpuMs = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
/** A fixed pure-JS workload like the bench's (transcendental colour maths over typed arrays, a sort). It does not
    use the engine, so engine changes never move it. Median of 3, in CPU ms. */
function calibrate() {
  const runs = [];
  for (let r = 0; r < 3; r++) { const t = cpuMs(), a = new Float64Array(1 << 18); let s = 0;
    for (let k = 0; k < 8; k++) { for (let i = 0; i < a.length; i++) { const x = (i * 0.618034 + k) % 100, y = Math.atan2(x - 50, 30 + k), c = Math.cos(y) * Math.pow(x + 1, 1.7);
        a[i] = Math.sqrt(c * c + x) + Math.exp(-x / 25) + Math.cbrt(x); s += a[i]; }
      a.sort(); }
    if (s === 0) console.log(""); runs.push(cpuMs() - t); }
  return runs.sort((x, y) => x - y)[1];
}
const rows = [];
for (const c of CASES) {
  const img = loadImage(c.img), garmentLab = E.rgb2lab(...c.garment);
  const base = { ...img, mode: c.mode, garmentLab, n, k: c.k, smooth: +(process.env.SMOOTH || 0.1), toneBoost: process.env.TONE ? +process.env.TONE : undefined, rareFrac: 0.0005, underbase: garmentLab[0] < 55, ubStrength: +(process.env.UBS || 1), library, locked: [], inks: [], forceWhite: true, screening: "am", overprint: process.env.OVERPRINT || "same", driftMm: +(process.env.DRIFT || 0), shiftAll: !!process.env.SHIFTALL, rho: +(process.env.RHO0 ?? 0.6), rhos: process.env.RHOS ? process.env.RHOS.split(",").map(Number) : [0, 0.5, 1], stackLimit: +(process.env.STACK ?? STACK_LIMIT), ...(process.env.FILM && { film: { minDot: 0.06, maxDot: 0.92, lpi: +process.env.FILM, widthIn: +(process.env.WIDTH || 11) } }) }; // manual-press profile; FILM=45 scores what 45 LPI films can print
  for (const palette of ["library", "art"]) {
    const variants = [];
    if (V1) variants.push(["v1", () => runV1(base, palette)]);
    for (const lamSel of LAMS) for (const opacity of OPS) variants.push([`v2${LAMS.length > 1 ? " λ" + lamSel : ""}${OPS.length > 1 ? " op" + opacity : ""}`, () => runSeparation({ ...base, repick: true, paletteMode: palette, ...(lamSel !== undefined && { lamSel }), ...(opacity !== undefined && { opacity }) })]);
    for (const [ver, fn] of variants) {
      const c0 = cpuMs(), t0 = performance.now(); let r = fn(), order = "";
      // print order per job, as Auto picks it in the app (pipeline.orderPlan, ORDERSEARCH=0 = dark-first only): the best
      // move on the 240 px copy, kept if the full-size press score and Print view error beat dark-first by ORDER_GAIN too
      const t1 = performance.now(), sepMs = Math.round(t1 - t0);
      if (ver.startsWith("v2") && c.mode === "sim" && process.env.ORDERSEARCH !== "0") { const p = pickOrder(base, r.inks);
        if (p.best) { const r1 = runSeparation({ ...base, paletteMode: palette, inks: p.best.inks, repick: false });
          const view = x => printView(base, x.inks, x.cov).viewMean, v0 = view(r), v1 = view(r1);
          order = `${p.best.name} after ${p.best.after} ${r.stats.robustMean.toFixed(3)} -> ${r1.stats.robustMean.toFixed(3)}, view ${v0.toFixed(3)} -> ${v1.toFixed(3)}`;
          if (r1.stats.robustMean <= r.stats.robustMean * (1 - ORDER_GAIN) && v1 <= v0 * (1 - ORDER_GAIN)) r = r1; else order += " (not kept)"; } }
      const ms = sepMs, orderMs = Math.round(performance.now() - t1), cpu = Math.round(cpuMs() - c0), s = r.stats;
      // channel roughness: mean absolute coverage step to the right/down neighbour, summed over screens (grain that halftones badly)
      let rough = NaN; if (r.cov) { rough = 0; const N = r.inks.length, W = img.W, H = img.H; for (let y = 0; y < H - 1; y += 2) for (let x = 0; x < W - 1; x += 2) { const p = y * W + x; for (let i = 0; i < N; i++) rough += Math.abs(r.cov[(p + 1) * N + i] - r.cov[p * N + i]) + Math.abs(r.cov[(p + W) * N + i] - r.cov[p * N + i]); } rough /= ((W >> 1) * (H >> 1)); }
      // tonal steps: share of neighbour pairs (2 px apart) where the proof jumps more than the art by over 0.5 ΔE00
      // (blends that step where inks hand over; the in-register and on-press scores average them away)
      const steps = r.img ? toneSteps(r.img, img.lab, img.alpha, img.W, img.H) : NaN;
      // gradient steps along the case's fades (cases.json "fades": boxes read along their long side; see gradientSteps)
      const gs = r.img && c.fades ? gradientSteps(r.img, img.W, c.fades) : null;
      const thin = r.spotIdx ? thinDetail(img, garmentLab, r) : null;
      rows.push({ image: c.img, palette, ver, thin, screens: r.inks.length + (r.ub ? 1 : 0), inks: r.inks.map(i => i.name).join("/"), dropped: r.dropped.join("/"), refilled: r.inks.filter(i => i.refill).map(i => i.name).join("/"), order, orderMs,
        adnMean: +s.mean.toFixed(2), adnP95: +s.p95.toFixed(2), cmc2: +(s.cmcWithin2 * 100).toFixed(1), neutralMean: +s.neutralMean.toFixed(2), neutralMedian: +s.neutralMedian.toFixed(2), neutralP95: +s.neutralP95.toFixed(2), filtered: +s.filteredMean.toFixed(2), robust: +s.robustMean.toFixed(2), stack: +(s.stackP99 * 100).toFixed(0), robustP95: +s.robustP95.toFixed(2), rough: +(rough * 100).toFixed(2), steps: +(steps * 100).toFixed(2), gradSteps: gs ? gs.over : null, gradMax: gs ? gs.max : null, ub: +(r.ubPct * 100).toFixed(1), ms, cpuMs: cpu });
    }
  }
}
console.table(rows.map(r => ({ image: r.image.slice(0, 11), palette: r.palette, ver: r.ver, screens: r.screens, "ADN ΔE00": r.adnMean, "ADN p95": r.adnP95, "CMC≤2 %": r.cmc2, "neutral ΔE00": r.neutralMean, "neutral med": r.neutralMedian, "UB %": r.ub, "grad steps": r.gradSteps ?? "", ms: r.ms })));
for (const r of rows) console.log(`${r.image} ${r.palette} ${r.ver}: ${r.inks}${r.order ? "  (order: " + r.order + ")" : ""}${r.refilled ? "  (refill " + r.refilled + ")" : ""}${r.dropped ? "  (dropped " + r.dropped + ")" : ""}`);
const ji = process.argv.indexOf("--json"); if (ji > 0) writeFileSync(process.argv[ji + 1], JSON.stringify(rows, null, 1));
// Regression gate: compare v2 rows with a committed baseline. Fails if any case worsens beyond tolerance.
//   node tests/bench-test.mjs --gate tests/baseline.json   (add --update to rewrite the baseline after an intended change)
// Scorer agreement alarm: where physics says two scorers must agree (no halftone overlap to model: spot and index
// without an underbase, or spot on any shirt), a large disagreement means a scorer bug, not a separation result.
// This rule would have caught the robust-score bug that once produced a false headline finding.
const alarms = rows.filter(r => r.ver.startsWith("v2") && r.ub === 0 && /spot|index/.test((CASES.find(c => c.img === r.image) || {}).mode || "") && Math.abs(r.robust - r.adnMean) > 0.1 + 0.05 * r.adnMean);
if (alarms.length) { console.log("SCORER ALARM: robust and proof disagree where they must agree:\n  " + alarms.map(r => `${r.image} ${r.palette}: proof ${r.adnMean}, robust ${r.robust}`).join("\n  ")); if (process.argv.includes("--gate")) process.exit(2); }
const gi = process.argv.indexOf("--gate");
if (gi > 0) {
  const file = process.argv[gi + 1], cur = rows.filter(r => r.ver.startsWith("v2")), TOL = { adnMean: 0.5, adnP95: 1.0, neutralMean: 1.0, filtered: 0.5, thin: 1.0 };
  // CPU ceiling (E7): the CPU total over all cases, as a multiple of the calibration workload, may grow at most CPU_TOL
  // over the baseline's. Only for the full default set (ONLY or a sweep runs other work). The baseline keeps it in one
  // extra row, ver "cpu".
  const CPU_TOL = 0.15, fullSet = !process.env.ONLY && LAMS.length === 1 && OPS.length === 1, calib = fullSet ? calibrate() : NaN;
  const cpuRow = { image: "(all cases)", palette: "-", ver: "cpu", cpuMs: cur.reduce((a, r) => a + r.cpuMs, 0), calibMs: Math.round(calib) };
  if (fullSet) console.log(`CPU: ${(cpuRow.cpuMs / 1000).toFixed(1)} s over ${cur.length} cases, calibration ${cpuRow.calibMs} ms, ratio ${(cpuRow.cpuMs / calib).toFixed(1)}`);
  if (process.argv.includes("--update") || !existsSync(file)) { writeFileSync(file, JSON.stringify(fullSet ? cur.concat([cpuRow]) : cur, null, 1)); console.log(`baseline written: ${file}`); }
  else {
    const base = JSON.parse(readFileSync(file, "utf8")), fails = [];
    for (const r of cur) {
      const b = base.find(x => x.image === r.image && x.palette === r.palette && x.ver === r.ver); if (!b) continue;
      for (const [k, t] of Object.entries(TOL)) if (b[k] != null && r[k] != null && r[k] > b[k] + t) fails.push(`${r.image} ${r.palette} ${k}: ${b[k]} → ${r[k]} (tolerance +${t})`);
      if (r.screens > b.screens) fails.push(`${r.image} ${r.palette} screens: ${b.screens} → ${r.screens}`);
    }
    const bc = base.find(x => x.ver === "cpu");
    if (fullSet && bc) { const was = bc.cpuMs / bc.calibMs, now = cpuRow.cpuMs / calib;
      console.log(`CPU ratio: baseline ${was.toFixed(1)}, now ${now.toFixed(1)} (${now >= was ? "+" : ""}${(100 * (now / was - 1)).toFixed(1)}%, ceiling +${100 * CPU_TOL}%)`);
      if (now > was * (1 + CPU_TOL)) fails.push(`CPU total: ${was.toFixed(1)} → ${now.toFixed(1)} calibration units (ceiling +${100 * CPU_TOL}%)`); }
    if (fails.length) { console.log("GATE FAILED\n  " + fails.join("\n  ")); process.exit(1); }
    console.log(`gate passed: ${cur.length} cases within tolerance of ${file}`);
  }
}
