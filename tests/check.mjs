import * as E from "../src/engine.js";
import { fitCalibration, TINTS } from "../src/calib.js";
import { deltaE2000, deltaECMC, Lab } from "../src/vendor/color-fn.js";
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log("FAIL", m); } else console.log("ok  ", m); };

// Sharma, Wu, Dalal (2005) CIEDE2000 test pairs (subset: pairs 1,7,13,17,19,25,31,34)
const sharma = [[[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425], [[50, 0, 0], [50, -1, 2], 2.3669], [[50, 2.49, -0.001], [50, -2.49, 0.0011], 7.2195],
  [[50, 2.5, 0], [73, 25, -18], 27.1492], [[50, 2.5, 0], [50, 3.1736, 0.5854], 1.0], [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
  [[90.8027, -2.0831, 1.441], [91.1528, -1.6435, 0.0447], 1.4441], [[2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514], 0.9082]];
for (const [a, b, want] of sharma) ok(Math.abs(E.de2000(...a, ...b) - want) < 1e-4, `CIEDE2000 Sharma pair → ${E.de2000(...a, ...b).toFixed(4)} vs ${want}`);
// Cross-check against color.js with values passed in its own Lab space (no illuminant conversion happens).
const cj = l => ({ space: Lab, coords: l, alpha: 1 });
let worst00 = 0, worstC = 0;
for (let i = 0; i < 400; i++) {
  const a = [Math.random() * 100, Math.random() * 160 - 80, Math.random() * 160 - 80], b = a.map((v, j) => v + (Math.random() - 0.5) * (j ? 20 : 10));
  worst00 = Math.max(worst00, Math.abs(E.de2000(...a, ...b) - deltaE2000(cj(a), cj(b))));
  worstC = Math.max(worstC, Math.abs(E.deCMC(...a, ...b) - deltaECMC(cj(a), cj(b))));
}
ok(worst00 < 1e-6, `CIEDE2000 matches color.js (max diff ${worst00.toExponential(2)})`);
ok(worstC < 1e-6, `ΔE CMC(2:1) matches color.js (max diff ${worstC.toExponential(2)})`);

// Lab round trip
const lab = E.rgb2lab(200, 60, 40), back = E.lab2rgb(lab); ok(back.every((v, i) => Math.abs(v - [200, 60, 40][i]) <= 1), "sRGB ↔ Lab round trip");

// Solver: a 50/50 mix of two inks is recovered
const n = 1.7, inkA = E.rgb2lab(230, 30, 30), inkB = E.rgb2lab(30, 30, 200), gar = E.rgb2lab(20, 20, 20);
const C = new Float64Array(9); C.set(E.mixFromLab(inkA, n), 0); C.set(E.mixFromLab(inkB, n), 3); C.set(E.mixFromLab(gar, n), 6);
const t = [0, 1, 2].map(i => 0.5 * C[i] + 0.5 * C[3 + i]); const out = new Float64Array(3);
E.makeSolver(C, 3)(t[0], t[1], t[2], 0.0, 400, out); ok(Math.abs(out[0] - 0.5) < 0.02 && Math.abs(out[1] - 0.5) < 0.02, `unmix 50/50 → ${[...out].map(v => v.toFixed(3))}`);

// Same-angle overprint: simulate concentric dots numerically and check visible areas
const v = [0.2, 0.15, 0.3], pr = new Float64Array(3); E.visibleToPrinted(v, 3, pr, "same");
// concentric: visible_k = a_k - max(later a), clipped at 0
const vis = [0, 1, 2].map(k => Math.max(0, pr[k] - Math.max(0, ...pr.slice(k + 1))));
ok(vis.every((x, i) => Math.abs(x - v[i]) < 1e-9), `same-angle compensation visible ${vis.map(x => x.toFixed(3))}`);
const pr2 = new Float64Array(3); E.visibleToPrinted(v, 3, pr2, "rotated");
const vis2 = [0, 1, 2].map(k => pr2[k] * pr2.slice(k + 1).reduce((s, a) => s * (1 - a), 1));
ok(vis2.every((x, i) => Math.abs(x - v[i]) < 1e-9), `rotated (Demichel) compensation visible ${vis2.map(x => x.toFixed(3))}`);

// Smooth map: a trace ink just over / under 1e-4 under later inks prints nearly the same film with the hidden-ink ramp
// (the step gave it a 0.6+ hidden dot); and the joint table solve keeps a slow hue fade free of recipe jumps
{ const a = new Float64Array(3), b = new Float64Array(3), worst = ramp => { let w = 0; for (const rho of [0, 0.6]) {
    E.visibleToPrinted([1.1e-4, 0.30, 0.69], 3, a, "same", rho, ramp); E.visibleToPrinted([0.9e-4, 0.30, 0.69], 3, b, "same", rho, ramp); w = Math.max(w, Math.abs(a[0] - b[0])); } return w; };
  ok(worst(0.03) < 0.01 && worst(0) > 0.5, `smooth map: trace ink film jump ${worst(0.03).toFixed(4)} with ramp (step: ${worst(0).toFixed(2)})`);
  const W = 240, H = 1, px = new Uint8ClampedArray(W * 3), alpha = new Uint8Array(W).fill(255);
  for (let x = 0; x < W; x++) { const u = x / (W - 1); px.set([Math.round(250 - 40 * u), Math.round(60 + 160 * u), 40], x * 3); } // red-orange to yellow
  const inkLabs = [[48, 70, 50], [65, 40, 70], [88, -5, 85], [55, -40, 40]], garmentLab = [12, 0, 0], stack = { limit: 2.4, overprint: "same", rho: 0.6, rhos: [0, 0.5, 1] };
  const jump = cov => { let m = 0; for (let x = 1; x < W; x++) for (let i = 0; i < 4; i++) m = Math.max(m, Math.abs(cov[x * 4 + i] - cov[(x - 1) * 4 + i])); return m; };
  const plain = E.separateSim({ px, alpha, W, H, inkLabs, garmentLab, n: 1.7, smooth: 0.1, hw: {}, base: { strength: 1, op: 0.55 }, opts: { stack } });
  const sm = E.separateSim({ px, alpha, W, H, inkLabs, garmentLab, n: 1.7, smooth: 0.1, hw: {}, base: { strength: 1, op: 0.55 }, opts: { stack, smoothMap: { mu: 0.003, kappa: 0.05, iters: 300 } } });
  ok(jump(sm) <= jump(plain) + 1e-6 && jump(sm) < 0.05, `smooth map: largest coverage step between neighbouring pixels ${jump(sm).toFixed(3)} (plain ${jump(plain).toFixed(3)})`); }

// AM dot area is exact
for (const a of [0.1, 0.35, 0.5, 0.75, 0.9]) { let on = 0; const cell = 40, N = 400; for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) on += E.amOn(x, y, a, cell, 1, 0) ? 1 : 0; ok(Math.abs(on / (N * N) - a) < 0.01, `AM dot ${a} → ${(on / (N * N)).toFixed(3)}`); }

// Dot shapes (engine dotOn): every shape prints its tint's exact area at a rotated angle, and the chain (ellipse) and square dots are
// nested (a pixel on at one tint stays on at every larger tint), so blends never jump where dots join
{ const cell = 23, N = 230, cs = Math.cos(0.39), sn = Math.sin(0.39);
  for (const shape of E.DOT_SHAPES) { let worst = 0, nested = true;
    for (const a of [0.03, 0.2, 0.45, 0.5, 0.55, 0.8, 0.97]) { let on = 0; for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) on += E.dotOn(shape, x, y, a, cell, cs, sn) ? 1 : 0; worst = Math.max(worst, Math.abs(on / (N * N) - a)); }
    if (shape !== "round") for (let y = 0; y < N; y += 3) for (let x = 0; x < N; x += 3) for (let a = 0.05; a < 0.95; a += 0.05) if (E.dotOn(shape, x, y, a, cell, cs, sn) && !E.dotOn(shape, x, y, a + 0.05, cell, cs, sn)) nested = false;
    ok(worst < 0.01 && nested, `dot shape ${shape}: area within ${(worst * 100).toFixed(2)}% of the tint at every tested tint${shape !== "round" ? ", dots nested from tint to tint" : ""}`); }
  ok([0.2, 0.7].every(a => { for (let y = 0; y < 80; y++) for (let x = 0; x < 80; x++) if (E.amOn(x, y, a, cell, cs, sn) !== E.dotOn("round", x, y, a, cell, cs, sn)) return false; return true; }), "dot shape round is the default dot, pixel for pixel"); }

// Hull palette returns real art colors, no centroids
const W = 60, H = 60, P = W * H, px = new Uint8ClampedArray(P * 3), alpha = new Uint8Array(P).fill(255);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const p = y * W + x, u = x / (W - 1), w = y / (H - 1); px.set([Math.round(240 * u + 20 * (1 - u)), Math.round(200 * w + 20), Math.round(30 + 180 * (1 - u) * w)], p * 3); }
const { samples } = E.imageSamples(px, alpha, P, gar, n);
const pal = E.hullPalette(samples, 4, [], gar, n);
ok(pal.length === 4 && pal.every(l => samples.some(s => s.lab === l)), `hull palette picks ${pal.length} colors that occur in the art`);
const lib = [["r", [230, 30, 30]], ["g", [30, 200, 40]], ["b", [30, 30, 220]], ["y", [240, 220, 30]], ["w", [245, 245, 240]], ["m", [200, 30, 160]]].map(([name, c]) => ({ name, lab: E.rgb2lab(...c) }));
const sub = E.librarySubset(samples, lib, 3, [], gar, n); ok(sub.length === 3, `library subset picks ${sub.map(i => lib[i].name)}`);
// Spot shelf inks are judged by the spot rule (nearest ink or shirt): cream, red and navy on a heather shirt get white,
// red and navy, not the white + yellow a halftone could mix the cream from (the mixing objective's pick on the bench)
{ const sh = [["White", [244, 244, 240]], ["Golden Yellow", [247, 181, 0]], ["Red", [184, 29, 44]], ["Navy", [27, 37, 71]], ["Tan", [200, 167, 124]]].map(([name, c]) => ({ name, lab: E.rgb2lab(...c) }));
  const hz = E.rgb2lab(118, 118, 118), arts = [[[236, 226, 196], 40], [[170, 60, 50], 55], [[30, 44, 60], 5]].map(([c, w]) => { const lab = E.rgb2lab(...c); return { lab, mix: E.mixFromLab(lab, n), w, wt: w }; });
  const pick = E.librarySubset(arts, sh, 3, [], hz, n, 0.02, null, { spotMetric: "oklab" }).map(i => sh[i].name).sort().join("/"), mixPick = E.librarySubset(arts, sh, 3, [], hz, n, 0.02).map(i => sh[i]);
  ok(pick === "Navy/Red/White" && E.spotError(arts, ["Navy", "Red", "White"].map(nm => sh.find(i => i.name === nm).lab), hz) <= E.spotError(arts, mixPick.map(i => i.lab), hz), `spot shelf subset by nearest ink picks ${pick} (mixing objective: ${mixPick.map(i => i.name)})`); }

// Calibration recovers a known n and dot gain
const solid = E.rgb2lab(220, 40, 40), substrate = E.rgb2lab(240, 240, 235), trueN = 2.1, gain = a => a + 0.6 * a * (1 - a);
const rows = TINTS.map(t => { const a = t / 100, ae = gain(a), ms = E.mixFromLab(solid, trueN), mg = E.mixFromLab(substrate, trueN); return { ink: "Red", tint: t, lab: E.mixToLab([0, 1, 2].map(i => ae * ms[i] + (1 - ae) * mg[i]), trueN) }; });
const cal = fitCalibration(rows);
ok(Math.abs(cal.n - trueN) < 0.11 && Math.abs(cal.inks.Red.curve[5] - gain(0.5)) < 0.03, `calibration n=${cal.n} (true ${trueN}), 50% → ${cal.inks.Red.curve[5]} (true ${gain(0.5)})`);
// ── Pipeline: drop-empty, underbase bounds, base-aware consistency, neutral yardstick, encoders ──
const { runSeparation, evaluate, labOf } = await import("../src/pipeline.js");
{
  // gamut check: art made of shelf colours stays quiet; a neon cyan block no shelf mix reaches is named, about its size
  const { gamutGaps, GAMUT_DE } = await import("../src/pipeline.js"), { genericLibrary } = await import("../src/inks.js"), lib = genericLibrary();
  const W = 60, H = 20, P = W * H, gar = E.rgb2lab(17, 17, 17), shelfRGB = [E.hex2rgb("#1f3f9c"), E.hex2rgb("#f7b500"), E.hex2rgb("#d8262f")];
  const art = neon => { const px = new Uint8ClampedArray(P * 3); for (let p = 0; p < P; p++) px.set(neon && p % W >= 45 ? [0, 236, 251] : shelfRGB[Math.floor((p % W) / 15) % 3], p * 3); return px; };
  const run = px => gamutGaps({ library: lib, garmentLab: gar, n: 1.7, mode: "sim", underbase: true, ubStrength: 1 }, E.imageSamples(px, new Uint8Array(P).fill(255), P, gar, 1.7, { rareFrac: 0.0005, garmentTol: 10 }).samples);
  const clean = run(art(false)), neon = run(art(true));
  ok(clean.length === 0, `gamut check stays quiet on shelf colours (${clean.length} groups)`);
  ok(neon.length === 1 && neon[0].de >= GAMUT_DE && Math.abs(neon[0].area - 0.25) < 0.02 && neon[0].near && neon[0].rgb[2] > 200, `gamut check names the neon cyan: ${neon.map(g => `${E.rgb2hex(g.rgb)} ${(g.area * 100).toFixed(0)}% ΔE ${g.de}`).join(", ")}`);
}
{
  // flat two-color art on a black shirt: red block and navy block
  const W = 40, H = 20, P = W * H, px = new Uint8ClampedArray(P * 3), alpha = new Uint8Array(P).fill(255);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) px.set(x < 20 ? [200, 30, 40] : x < 30 ? [30, 40, 110] : [22, 26, 48], (y * W + x) * 3);
  const lab = labOf(px, P), gar = E.rgb2lab(17, 17, 17);
  const inks = [{ name: "Red", lab: E.rgb2lab(200, 30, 40), locked: true }, { name: "Navy", lab: E.rgb2lab(30, 40, 110), locked: true }, { name: "Unused green", lab: E.rgb2lab(30, 180, 60), locked: false }];
  const base = { px, alpha, lab, W, H, garmentLab: gar, n: 1.7, smooth: 0.15, underbase: true, ubStrength: 0.92, library: [], inks, repick: false };
  const sim = runSeparation({ ...base, mode: "sim" });
  ok(sim.dropped.includes("Unused green") && sim.inks.length === 2, `drop-empty removes the unused screen (dropped: ${sim.dropped}; coverage ${sim.covPct.map(v => (v * 100).toFixed(2)).join("/")}%, max ${sim.covMax.map(v => v.toFixed(2)).join("/")})`);
  let over = 0, sumBad = 0; for (let p = 0; p < P; p++) { let s = 0; for (let i = 0; i < sim.inks.length; i++) { const v = sim.cov[p * sim.inks.length + i]; if (v < -1e-6) sumBad++; s += v; } if (s > 1 + 1e-4) sumBad++; if (sim.ub[p] > s + 1e-4) over++; }
  ok(sumBad === 0, "coverage stays on the simplex (each ≥ 0, sum ≤ 1)");
  ok(over === 0, "sim underbase never exceeds the color coverage above it");
  ok(sim.stats.mean < 2, `base-aware solver and proof agree on flat colors (ΔE00 ${sim.stats.mean.toFixed(2)})`);
  const red = sim.ub[10 * W + 5], solidNavy = sim.ub[10 * W + 25], tint = sim.ub[10 * W + 35];
  let tintCov = 0; for (let i = 0; i < sim.inks.length; i++) tintCov += sim.cov[(10 * W + 35) * sim.inks.length + i];
  ok(red > 0.85 && solidNavy > 0.85, `sim base: full under solids (red ${red.toFixed(2)}, navy ${solidNavy.toFixed(2)})`);
  ok(tint / tintCov < 0.6, `sim base: little white under a dark navy tint (${(tint / tintCov).toFixed(2)} of its ink area)`);
  const spot = runSeparation({ ...base, mode: "spot" });
  ok(spot.ub[10 * W + 25] > 0.85, `spot base: full base under dark spot colors (${spot.ub[10 * W + 25].toFixed(2)})`);
  // neutral yardstick is exact when a single solid ink reproduces the art on a white shirt with no base
  const one = { ...base, mode: "spot", garmentLab: E.rgb2lab(255, 255, 255), underbase: false, inks: [inks[0]] };
  const px1 = new Uint8ClampedArray(P * 3); for (let p = 0; p < P; p++) px1.set([200, 30, 40], p * 3);
  const ev = evaluate({ ...one, px: px1, lab: labOf(px1, P) }, [inks[0]], new Float32Array(P).fill(1));
  ok(ev.stats.neutralMean < 0.5, `neutral yardstick is exact on a solid match (${ev.stats.neutralMean.toFixed(3)})`);
  ok(ev.stats.robustMean < 0.5, `robust score is exact on a solid match on a white shirt (${ev.stats.robustMean.toFixed(3)})`);
  // highlight white is kept out of midtones
  const pen = E.inkPenalties([[96, 0, 1.5]], gar, [55, 25, 25]); ok(pen[0] > 0.5, "highlight white is penalized in colored midtones");
  const pg = E.inkPenalties([[96, 0, 1.5]], gar, [55, 0, 0]); ok(pg[0] < 0.05, "white stays available for neutral grays");
  const pt = E.inkPenalties([[96, 0, 1.5]], gar, [84, 20, 45]); ok(pt[0] < 0.1, "white stays available for light tints (pastels, light orange)");
}
{
  // flat art with fewer colors than screens: every color becomes an ink (the hull needs >= 4 points)
  const W = 30, H = 10, P = W * H, px = new Uint8ClampedArray(P * 3), alpha = new Uint8Array(P).fill(255);
  for (let p = 0; p < P; p++) px.set((p % W) < 10 ? [176, 58, 46] : (p % W) < 20 ? [240, 228, 200] : [32, 44, 64], p * 3);
  const heather = E.rgb2lab(118, 118, 118), lib = [{ name: "White", lab: [96, 0, 1.5] }, { name: "Red", lab: E.rgb2lab(176, 58, 46) }];
  const r = runSeparation({ px, alpha, lab: labOf(px, P), W, H, mode: "spot", garmentLab: heather, n: 1.7, k: 3, smooth: 0.15, underbase: true, ubStrength: 0.92, library: lib, locked: [], inks: [], forceWhite: true, repick: true, paletteMode: "art" });
  ok(r.inks.length === 3, `3-color spot art gets 3 inks from the art (${r.inks.map(i => i.name).join("/")})`);
  ok(r.stats.mean < 1.5, `3-color spot art reproduces (ΔE00 ${r.stats.mean.toFixed(2)})`);
  // sim on black with white in the art: one white only
  const px2 = new Uint8ClampedArray(P * 3); for (let p = 0; p < P; p++) px2.set((p % W) < 15 ? [245, 245, 240] : [200, 40, 40], p * 3);
  const r2 = runSeparation({ px: px2, alpha, lab: labOf(px2, P), W, H, mode: "sim", garmentLab: E.rgb2lab(17, 17, 17), n: 1.7, k: 4, smooth: 0.15, underbase: true, ubStrength: 0.92, library: lib, locked: [], inks: [], forceWhite: true, repick: true, paletteMode: "art" });
  ok(r2.inks.filter(i => i.lab[0] > 92).length === 1, `only one white screen (${r2.inks.map(i => i.name).join("/")})`);
}
{
  // index pixels render at indexDpi blocks (200 dpi on a 400 dpi film = 2×2 film pixels per index pixel)
  const W = 20, H = 20, N = 2, P = W * H, cov = new Float32Array(P * N); for (let p = 0; p < P; p++) { cov[p * 2] = 0.4; cov[p * 2 + 1] = 0.35; }
  const Wp = 80, Hp = 80, c = { x0: 0, y0: 0, w: Wp, h: Hp }, fm = E.fmIndexAt(cov, W, H, N, Wp, Hp, 400, 200, c);
  const bits = E.renderPlate({ plate: { idx: 0 }, printed: cov, ub: null, W, H, N, Wp, Hp, dpi: 400, lpi: 45, angle: 22.5, screening: "fm", mode: "sim", dot: { gain: 0, minDot: 0, maxDot: 1 }, choke: 0, fmIdx: fm });
  let blocky = true; for (let y = 0; y < Hp; y += 2) for (let x = 0; x < Wp; x += 2) { const v = bits[y * Wp + x]; if (bits[y * Wp + x + 1] !== v || bits[(y + 1) * Wp + x] !== v || bits[(y + 1) * Wp + x + 1] !== v) blocky = false; }
  let on = 0; for (const b of bits) on += b;
  ok(blocky && Math.abs(on / bits.length - 0.4) < 0.05, `index pixels are 2×2 film pixels at 200/400 dpi, coverage ${(on / bits.length).toFixed(2)}`);
}
{
  // film plan: plates follow the separated ink set, spec matches, mesh rule, rotated angles stay in [0, 90)
  const P = await import("../src/plan.js");
  const inks = [{ name: "Gold", lab: [80, 10, 70] }, { name: "Royal", lab: [30, 20, -55] }, { name: "White", lab: [96, 0, 1.5] }];
  const pl = P.platesFor(inks, true, { screening: "same", angle: 22.5 });
  ok(pl.length === 4 && pl[0].ub && pl[0].idx === 3 && pl.slice(1).every((p, i) => p.idx === i && p.order === i + 2 && p.angle === 22.5), "plates: underbase first, then each separated ink in order");
  const rot = P.platesFor(inks, false, { screening: "rotated", angle: 22.5 }); ok(new Set(rot.map(p => p.angle)).size === 3 && rot.every(p => p.angle >= 0 && p.angle < 90), `rotated angles distinct and in [0, 90): ${rot.map(p => p.angle)}`);
  { const many = Array.from({ length: 12 }, (_, i) => ({ name: "I" + i, lab: [50, i, 0] })), r12 = P.platesFor(many, false, { screening: "rotated", angle: 22.5 });
    const gap = (a, b) => { const d = Math.abs(a - b) % 90; return Math.min(d, 90 - d); }; let worst = 90;
    for (let i = 0; i < r12.length; i++) for (let j = i + 1; j < r12.length; j++) { const g = gap(r12[i].angle, r12[j].angle); if (g > 1e-9) worst = Math.min(worst, g); }
    ok(worst >= 15 - 1e-9, `12 rotated screens: any two angles are equal or ≥ 15° apart (closest distinct pair ${worst}°)`); }
  const result = { covPct: [0.1, 0.2, 0.05], ubPct: 0.3, stats: { mean: 1.234567 } };
  ok(P.checkPlan(pl, result).length === 0, "consistent plan passes");
  const dropped = { covPct: [0.1, 0.2], ubPct: 0.3, stats: {} };
  ok(P.checkPlan(pl, dropped).length > 0, "a plan built for 3 inks is rejected when the export separated 2 (review bug 1)");
  const spec = P.specFor({ plates: pl, result, mode: "sim", garment: { hex: "#111111", lab: [5, 0, 0] }, print: { width_in: 11, dpi: 400, lpi: 45, screening: "same", angle: 22.5, dot_gain_50: 18, min_dot: 6, max_dot: 92, choke_mm: 0.2, choke_px: 3, index_dpi: 200 }, model: { yule_nielsen_n: 1.7, calibrated: false, calibration_residual_de00: null }, targets: [], created: "x" });
  ok(spec.screens.length === 4 && spec.screens[0].coverage === 0.3 && spec.screens[2].coverage === 0.2 && spec.screens[0].flash && !spec.screens[1].flash && !spec.screens[3].flash && spec.screens[3].cure && !spec.screens[0].cure, "spec: coverage per plate, flash after the base, cure after the last screen");
  ok(P.meshFor(45) === 230 && P.meshFor(55) === 280 && P.meshFor(35) === 230 && P.meshFor(50) === 255 && P.meshFor(45, true) === 156 && P.meshFor(55, true) === 230 && [35, 40, 45, 50, 55, 60, 65, 85].every(l => P.STOCK_MESH.includes(P.meshFor(l)) && P.meshFor(l) >= 230), "mesh follows LPI: 45 → 230, 55 → 280, 5 per LPI, stock counts, never below 230; underbase unchanged");
  ok(P.colorName([0, 236, 251]) === "bright cyan" && P.colorName([230, 210, 250]) === "pale violet" && P.colorName([128, 128, 128]) === "gray" && P.colorName([139, 69, 19]) === "brown", "plain colour names for the gamut check");
  ok([35, 40, 45, 50, 55, 60, 65].every(l => Math.abs(P.meshFor(l) / l - Math.round(P.meshFor(l) / l)) > 0.08), "mesh is never a whole-number multiple of the LPI");
  ok(Math.abs(P.minDotFor(55, 305) - 0.057) < 0.005 && P.minDotFor(45, 156) > 0.13, "min dot follows the mesh (5.7% at 55/305, about 15% on a 156 base)");
  ok(/THEN FLASH$/.test(P.filmLabel(pl[0], { mode: "sim", screening: "same", lpi: 45, dpi: 400 })) && /THEN CURE$/.test(P.filmLabel(pl[3], { mode: "sim", screening: "same", lpi: 45, dpi: 400, last: true })) && !/THEN/.test(P.filmLabel(pl[1], { mode: "sim", screening: "same", lpi: 45, dpi: 400 })), "film labels say THEN FLASH on the base and THEN CURE on the last screen");
  ok(spec.fidelity.mean === 1.235 && spec.screens[1].file === "02-gold", "spec rounds fidelity and names files");
  { const { VERSION } = await import("../src/version.js");
    ok(/^\d+\.\d+\.\d+$/.test(VERSION) && spec.version === VERSION, `separation.json carries the semantic version (${VERSION})`); }
}
{
  // spot cleanup removes specks and pinholes by size and keeps thin lines (the old 3×3 open erased strokes under 3 px)
  const { cleanSpotSync } = await import("../src/cvtools.js"), W = 40, H = 30, N = 2, idx = new Uint8Array(W * H).fill(N);
  for (let y = 5; y < 25; y++) for (let x = 2; x < 20; x++) idx[y * W + x] = 0;      // solid block of ink 0
  idx[15 * W + 10] = N; idx[15 * W + 11] = N;                                         // 2 px pinhole in it
  for (let y = 2; y < 28; y++) idx[y * W + 30] = 1;                                   // 1 px rule of ink 1, 26 px long
  idx[3 * W + 25] = 0; idx[3 * W + 26] = 0;                                           // 2 px speck of ink 0 on the shirt
  const out = cleanSpotSync(idx, N, W, H, 8);
  ok(out[15 * W + 10] === 0 && out[15 * W + 11] === 0, "cleanup fills a 2 px pinhole with the ink around it");
  ok(out[3 * W + 25] === N && out[3 * W + 26] === N, "cleanup removes a 2 px speck");
  let line = 0; for (let y = 2; y < 28; y++) line += out[y * W + 30] === 1 ? 1 : 0;
  ok(line === 26, `cleanup keeps a 1 px rule whole (${line}/26 px)`);
  let same = 0; for (let p = 0; p < W * H; p++) if (out[p] === idx[p]) same++;
  ok(same === W * H - 4, "cleanup changes only the speck and pinhole pixels");
}
{
  // color targets: closest ink by CMC(2:1), pass/fail by tier, calibrated Lab honored
  const { matchTarget } = await import("../src/targets.js");
  const lib = [{ name: "Red", lab: [48, 68, 42] }, { name: "Blue", lab: [30, 20, -55] }];
  const m1 = matchTarget({ lab: [48.3, 67.5, 42.4], tier: 1 }, lib); ok(m1.ink.name === "Red" && m1.pass && m1.cmc < 1, `target near Red passes brand tier (CMC ${m1.cmc.toFixed(2)})`);
  const m2 = matchTarget({ lab: [52, 60, 30], tier: 1 }, lib); ok(m2.ink.name === "Red" && !m2.pass, `target off Red fails brand tier (CMC ${m2.cmc.toFixed(2)})`);
  const m3 = matchTarget({ lab: [48, 68, 42], tier: 1 }, lib, i => i.name === "Red" ? [60, 40, 40] : i.lab); ok(!m3.pass, "calibrated (measured) Lab is used instead of the nominal one");
}
{
  // 1-bit TIFF: header, tags, and PackBits data decode back to the input
  const { toTIFF } = await import("../src/output.js");
  const w = 37, h = 5, bits = new Uint8Array(w * h); for (let i = 0; i < bits.length; i++) bits[i] = (i * 7) % 3 === 0 ? 1 : 0;
  const buf = new Uint8Array(await toTIFF(bits, w, h, 300).arrayBuffer()), dv = new DataView(buf.buffer);
  const tags = {}; const ifd = dv.getUint32(4, true), nt = dv.getUint16(ifd, true);
  for (let i = 0; i < nt; i++) { const o = ifd + 2 + i * 12, t = dv.getUint16(o, true), ty = dv.getUint16(o + 2, true); tags[t] = ty === 3 ? dv.getUint16(o + 8, true) : dv.getUint32(o + 8, true); }
  const out = []; let q = tags[273]; const end = q + tags[279];
  while (q < end) { const c = dv.getInt8(q++); if (c >= 0) { for (let k = 0; k <= c; k++) out.push(buf[q++]); } else if (c !== -128) { const v = buf[q++]; for (let k = 0; k < 1 - c; k++) out.push(v); } }
  const rb = Math.ceil(w / 8); let same = out.length === rb * h;
  for (let y = 0; same && y < h; y++) for (let x = 0; x < w; x++) if (((out[y * rb + (x >> 3)] >> (7 - (x & 7))) & 1) !== bits[y * w + x]) { same = false; break; }
  ok(dv.getUint16(0) === 0x4949 && tags[256] === w && tags[257] === h && tags[258] === 1 && tags[259] === 32773 && tags[262] === 0, "TIFF header: little-endian, size, 1-bit, PackBits, WhiteIsZero");
  ok(same, "TIFF PackBits data decodes back to the plate bits");
}
{
  // calibration recovers ink opacity on the bare shirt and same-angle dot overlap from synthetic readings
  const { fitCalibration, overlapVisible, TINTS: T } = await import("../src/calib.js");
  const n = 2.0, shirt = E.rgb2lab(17, 17, 17), base = E.rgb2lab(240, 240, 235), trueOp = 0.42, trueRho = 0.35, gain = a => a + 0.4 * a * (1 - a);
  const inks = { Red: E.rgb2lab(210, 40, 45), Blue: E.rgb2lab(40, 70, 190) }, mix = l => E.mixFromLab(l, n), lab = m => E.mixToLab(m, n);
  const rows = [{ ink: "_shirt", tint: 0, lab: shirt }];
  for (const [k, sol] of Object.entries(inks)) {
    for (const t of T) { const a = gain(t / 100), s = mix(sol), b = mix(base); rows.push({ ink: k, tint: t, lab: lab([0, 1, 2].map(i => a * s[i] + (1 - a) * b[i])) }); }
    const s = mix(sol), sh = mix(shirt); rows.push({ ink: k, tint: "bare100", lab: lab([0, 1, 2].map(i => trueOp * s[i] + (1 - trueOp) * sh[i])) });
  }
  const v = overlapVisible(gain(0.5), gain(0.5), trueRho), r = mix(inks.Red), bl = mix(inks.Blue), bs = mix(base);
  rows.push({ ink: "Red", tint: "ov:blue", over: "Blue", lab: lab([0, 1, 2].map(i => v.vA * r[i] + v.vB * bl[i] + v.vBase * bs[i])) });
  const cal = fitCalibration(rows);
  ok(Math.abs(cal.opacity - trueOp) < 0.02, `calibration recovers ink opacity on the shirt (${cal.opacity} vs ${trueOp})`);
  ok(Math.abs(cal.overlap - trueRho) < 0.05, `calibration recovers same-angle dot overlap (${cal.overlap} vs ${trueRho})`);
  // registration sensitivity: overlap patches at deliberate shifts recover a rising overlap curve
  const rows2 = rows.filter(r => !String(r.tint).startsWith("ov:")), curve = [[0, 0.1], [0.1, 0.4], [0.25, 0.8]];
  for (const [mm, rho] of curve) { const vv = overlapVisible(gain(0.5), gain(0.5), rho); rows2.push({ ink: "Red", tint: "ov:blue@" + mm, over: "Blue", offset: mm, lab: lab([0, 1, 2].map(i => vv.vA * r[i] + vv.vB * bl[i] + vv.vBase * bs[i])) }); }
  const cal2 = fitCalibration(rows2);
  ok(cal2.overlapByOffset && cal2.overlapByOffset.every((o, i) => Math.abs(o.rho - curve[i][1]) < 0.05), `calibration recovers overlap vs deliberate shift (${cal2.overlapByOffset && cal2.overlapByOffset.map(o => o.mm + "mm→" + o.rho).join(", ")})`);
  // measured overlap: the films show exactly the planned tones under the print model's overlap blend (robustScore:
  // (1 - rho) max(0, a - M) + rho a F of each ink under the later dots), no ramp; before 2026-11-15 a blend of the two
  // compensations, which printed a different mix
  for (const [vv, rho] of [[[0.2, 0.3], 0.5], [[0.2, 0.3, 0.4], 0.6], [[0.05, 0.6, 0.1, 0.2], 0.3]]) { const N = vv.length, a = new Float64Array(N);
    E.visibleToPrinted(vv, N, a, "same", rho, 0); let M = 0, F = 1, err = 0;
    for (let k = N - 1; k >= 0; k--) { err = Math.max(err, Math.abs((1 - rho) * Math.max(0, a[k] - M) + rho * a[k] * F - vv[k])); if (a[k] > M) M = a[k]; F *= 1 - a[k]; }
    ok(err < 1e-9, `measured overlap ${rho}: the films show the planned tones exactly (largest error ${err.toExponential(1)})`); }
}
{
  // adaptive choke: a 4 px choke keeps base under a 3 px line, still chokes a wide block
  const W = 40, H = 20, src = new Float32Array(W * H);
  for (let y = 0; y < H; y++) { for (let x = 2; x < 5; x++) src[y * W + x] = 1; for (let x = 12; x < 38; x++) src[y * W + x] = 1; }
  const out = E.adaptiveChoke(src, W, H, 4), plain = E.minFilter(src, W, H, 4);
  ok(plain[10 * W + 3] === 0 && out[10 * W + 3] > 0.9, "thin line keeps its base (plain choke would erase it)");
  ok(out[10 * W + 13] === 0 && out[10 * W + 25] === 1, "wide block is still choked at its edge");
}
{
  // ink stack limit: compensation is scaled back per spot so the colour dots (the base not counted) stay under the limit
  const { printedFrom } = await import("../src/pipeline.js");
  const N = 3, P = 1, cov = Float32Array.from([0.5, 0.5, 0.5]), ub = Float32Array.from([0.9]);
  const full = printedFrom(cov, N, P, "sim", "am", "same", 0, ub, 0), lim = printedFrom(cov, N, P, "sim", "am", "same", 0, ub, 2.4);
  const st = a => a[0] + a[1] + a[2];
  // footprint hold: a near-solid colour's largest film reaches its coverage (no scattered holes under the shirt), inside
  // the limit, and two films trading the lead change smoothly (hue wheel yellow into orange; sky Brown fading under Orange)
  const E = await import("../src/engine.js");
  if (E.FOOTHOLD !== "0") {
    const pf = v => printedFrom(Float32Array.from(v), v.length, 1, "sim", "am", "same", 0.6, null, 2.4), mx = a => Math.max(...a), sum = a => a.reduce((x, y) => x + y, 0);
    const wheel = pf([0, 0.032, 0.323, 0.645]), sky = pf([0.025, 0, 0.470, 0.472, 0.033]);
    // wheel: 0.914 with the blended compensation, 0.892 with the exact one (2026-11-15: the colour lands nearer the plan,
    // the shirt covered 96.3% -> 95.4% at the stack limit); floor 0.88
    // an early ink fading out under the others (the sky's bottom band), in steps of 0.000006 of its tone: no film jumps (steep where the ramp is, but no step)
    let jump = 0, prev = null; for (let t = 0.45; t <= 0.6; t += 0.0001) { const a = pf([0.06 * (1 - t), 0, 0.47, 0.53 - 0.06 * (1 - t)]); if (prev) jump = Math.max(jump, ...a.map((x, i) => Math.abs(x - prev[i]))); prev = a; }
    ok(mx(wheel) > 0.88 && mx(sky) > 0.999 && sum(wheel) <= 2.4 + 1e-6 && sum(sky) <= 2.4 + 1e-6 && jump < 0.01, `footprint hold: near-solid colours keep the largest dot up (wheel ${mx(wheel).toFixed(3)}, sky ${mx(sky).toFixed(3)}) inside the stack limit; no film jumps along a fade (largest step ${jump.toFixed(3)})`);
  }
  ok(st(full) > 2.4 && Math.abs(st(lim) - 2.4) < 1e-6 && lim.every((v, i) => v >= cov[i] - 1e-9), `stack limit holds (${(st(full) * 100).toFixed(0)}% → ${(st(lim) * 100).toFixed(0)}%) and never prints less than the visible tone; the base is not counted`);
}
{
  // tests added after mutation testing showed these planted bugs went unnoticed
  ok(E.baseFraction([45, 55, 35], 1) > E.baseFraction([45, 0, 0], 1) + 0.2, "base boost: a saturated red gets more base than a gray of the same lightness");
  { const ub = E.buildUnderbase(Float32Array.from([0.2, 0.1]), 2, 1, Float32Array.from([70, 50, 40]), 0.92)[0];
    ok(ub > 0.2 && ub <= 0.3 + 1e-6, `underbase is never larger than the colour dots above it (${ub.toFixed(3)} under 0.300 of ink)`); }
  const pc = E.inkPenalties([[96, 0, 1.5]], E.rgb2lab(17, 17, 17), [66, 40, 45]); ok(pc[0] > 1.0, `white is kept out of saturated midtones by both terms (${pc[0].toFixed(2)})`);
  for (const [a, G] of [[0.3, 0.22], [0.5, 0.22], [0.7, 0.3]]) { const x = E.invGain(a, G), back = x + 4 * G * x * (1 - x); ok(Math.abs(back - a) < 1e-6 && x < a, `dot gain inverse: film ${(x * 100).toFixed(1)}% grows back to ${(a * 100).toFixed(0)}% on press`); }
  { // index: error diffusion reproduces a 30/70 mix of two inks in the right proportions
    const W = 60, H = 40, P = W * H, inkA = [60, 60, 40], inkB = [30, 10, -50], n = 1.7, ma = E.mixFromLab(inkA, n), mb = E.mixFromLab(inkB, n);
    const rgb = E.mixToRGB([0, 1, 2].map(i => 0.3 * ma[i] + 0.7 * mb[i]), n), px = new Uint8ClampedArray(P * 3); for (let p = 0; p < P; p++) px.set(rgb, p * 3);
    const cov = E.separateIndex({ px, alpha: new Uint8Array(P).fill(255), W, H, inkLabs: [inkA, inkB], garmentLab: E.rgb2lab(255, 255, 255), n });
    let a = 0; for (let p = 0; p < P; p++) a += cov[p * 2]; ok(Math.abs(a / P - 0.3) < 0.03, `index dither keeps ink proportions (${(a / P * 100).toFixed(1)}% vs 30%)`);
  }
  { // film index map: each ink's share of pixels matches its coverage closely (error diffusion conserves error)
    const W = 10, H = 10, N = 2, P = W * H, cov = new Float32Array(P * N); for (let p = 0; p < P; p++) { cov[p * 2] = 0.4; cov[p * 2 + 1] = 0.35; }
    const idx = E.fmIndex(cov, W, H, N, 120, 120); let a = 0, b = 0; for (const v of idx) { if (v === 0) a++; else if (v === 1) b++; }
    ok(Math.abs(a / idx.length - 0.4) < 0.01 && Math.abs(b / idx.length - 0.35) < 0.01, `film index map keeps shares (${(a / idx.length * 100).toFixed(1)}% / ${(b / idx.length * 100).toFixed(1)}% vs 40 / 35)`);
  }
  { // neutral yardstick: an exposed white base on a black shirt reads as white
    const W = 4, H = 4, P = W * H, white = [96, 0, 1.5], lab = new Float32Array(P * 3); for (let p = 0; p < P; p++) lab.set(white, p * 3);
    const nsc = E.neutralScore({ printed: new Float32Array(P), ub: new Float32Array(P).fill(1), N: 1, W, H, lab, alpha: new Uint8Array(P).fill(255), inkLabs: [[50, 0, 0]], garmentLab: E.rgb2lab(17, 17, 17), stride: 1 });
    ok(nsc.mean < 1, `neutral score sees the exposed base as white (${nsc.mean.toFixed(2)})`);
  }
}
{
  // Photoshop file: valid header, one spot channel per screen, names and print-size resolution in the resources
  const { toPSD } = await import("../src/output.js");
  const W = 20, H = 10, rgba = new Uint8ClampedArray(W * H * 4).fill(255), data = new Uint8Array(W * H).fill(128);
  const buf = new Uint8Array(await toPSD({ W, H, dpi: 300, rgba, channels: [{ name: "1. Underbase", rgb: [244, 244, 240], data }, { name: "2. Sim Red", rgb: [208, 42, 48], data }] }).arrayBuffer());
  const dv = new DataView(buf.buffer), sig = String.fromCharCode(...buf.subarray(0, 4));
  const txt = new TextDecoder("utf-16be").decode(buf);
  ok(sig === "8BPS" && dv.getUint16(12) === 5 && dv.getUint32(14) === H && dv.getUint32(18) === W && dv.getUint16(24) === 3, "PSD header: 8BPS, RGB, 3 + 2 spot channels, right size");
  ok(txt.includes("1. Underbase") && txt.includes("2. Sim Red"), "PSD spot channels are named in print order");
  // the production file is Multichannel with only the spot channels: no composite a RIP could print as extra plates
  const mb = new Uint8Array(await toPSD({ W, H, dpi: 300, channels: [{ name: "1. Underbase", rgb: [244, 244, 240], data }, { name: "2. Sim Red", rgb: [208, 42, 48], data }] }).arrayBuffer()), mv = new DataView(mb.buffer);
  ok(mv.getUint16(12) === 2 && mv.getUint16(24) === 7, "production PSD: Multichannel mode, the 2 spot channels and nothing else");
}
{
  // ink mix sheet rows: batch weight grows with shirts and coverage, the base uses the heavier deposit, creator targets attach
  const P = await import("../src/plan.js"), { PRESETS } = await import("../src/inks.js");
  const g1 = P.inkGrams({ areaIn2: 100, coverage: 0.5, shirts: 100 }), g2 = P.inkGrams({ areaIn2: 100, coverage: 0.5, shirts: 200 }), gb = P.inkGrams({ areaIn2: 100, coverage: 0.5, shirts: 100, kind: "base" });
  ok(g2 > g1 && gb > g1 && g1 === Math.round((100 * 0.5 * 0.035 * 100 * 1.15 + 120) / 10) * 10, `batch weights: ${g1} g, ${g2} g for twice the shirts, ${gb} g for the base`);
  const plates = P.platesFor([{ name: "Royal", lab: [30, 20, -55], code: "67050", system: "Wilflex Epic Rio" }], true, { screening: "same", angle: 22.5, lpi: 55 });
  const rows = P.mixRows({ plates, covPct: [0.3], ubPct: 0.4, areaIn2: 120, shirts: 50, targets: [{ label: "PANTONE 286 C (creator)", lab: [31, 21, -54] }], cmc: (a, b) => E.deCMC(...a, ...b) });
  ok(rows.length === 2 && rows[1].code === "67050" && rows[1].requested === "PANTONE 286 C (creator)" && rows[0].requested === null, "mix rows carry the brand code and the creator's requested color");
  { const { nearestStock } = await import("../src/plan.js"), cat = [{ system: "A", inks: [{ name: "Red", code: "1", lab: [50, 70, 50] }, { name: "Blue", code: "2", lab: [30, 10, -60] }] }, { system: "B", inks: [{ name: "Far", code: "9", lab: [90, 0, 0] }] }];
    const ns = nearestStock([49, 68, 48], cat, (x, y) => Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]));
    ok(ns.length === 1 && ns[0].code === "1" && ns[0].de === 3, "nearest stock ink picks the closest per catalog and drops far ones"); }
  const rio = PRESETS.wilflexRio.inks(); ok(rio.length === 33 && rio.every(i => i.approx && i.system === "Wilflex Epic Rio"), "Wilflex Epic Rio catalog: 33 inks, all marked approximate");
  { const fn = PRESETS.fnInk.inks(), gen = Object.fromEntries((await import("../src/inks.js")).genericLibrary().map(i => [i.name, i.lab]));
    // ADN's own estimates: a single-shade ink is exactly that generic shade, so no third-party value can slip back in
    ok(fn.length === 15 && fn.every(i => i.approx && i.system === "FN-INK") && E.de2000(...fn.find(i => i.name === "Navy Blue").lab, ...gen.Navy) < 1e-6
      && E.de2000(...fn.find(i => i.name === "Royal Blue").lab, ...gen.Royal) < 1e-6, "FN-INK catalog: 15 inks, ADN estimates from the generic shades"); }
  { const { libraryKind, genericLibrary } = await import("../src/inks.js"), gen = genericLibrary(), fn = PRESETS.fnInk.inks(), mine = [{ name: "Red", lab: [45, 60, 40], source: "measured" }];
    ok(libraryKind(fn).kind === "estimate" && libraryKind(fn).estimate === 15 && libraryKind([...mine, ...fn]).kind === "estimate" && libraryKind(mine).kind === "measured" && libraryKind(gen).kind === "generic"
      && libraryKind(PRESETS.simkit.inks()).kind === "generic" && libraryKind(PRESETS.simkitSkin.inks()).kind === "generic",
      "ink library pill: the FN-INK preset reads estimate, never measured; drawdown readings read measured"); }
}
// Spot and Index base: solid white under inks that need it, none under an ink as dark as the shirt (navy on black)
{
  const cov = Float32Array.from([1, 0, 0, 1]), ub = E.buildUnderbase(cov, 2, 2, new Float32Array(6), 1, { solid: true, inkLabs: [[15, 2, -11], [62, 50, 60]], garmentLab: [5, 0, 0] });
  ok(ub[0] === 0 && ub[1] === 1, `spot base: none under navy (L 15), full under orange (got ${ub[0]}, ${ub[1]})`);
  const ub2 = E.buildUnderbase(cov, 2, 2, new Float32Array(6), 1, { solid: true, inkLabs: [[15, 2, -11], [62, 50, 60]], garmentLab: [50, 0, 0] });
  ok(ub2[0] === 1, "spot base: a navy on a heather shirt keeps its base");
}
// Index shades: art that is the ink printed bare on a black shirt prints with that ink and no base under it; art that is
// the ink over base keeps its base. Bare = 0.55·ink + 0.45·shirt in mix space (the proof's model).
{
  const W = 40, H = 20, P = W * H, n = 1.7, ink = [62, 50, 60], shirt = E.rgb2lab(17, 17, 17), mi = E.mixFromLab(ink, n), ms = E.mixFromLab(shirt, n);
  const bare = E.mixToRGB(mi.map((v, k) => 0.55 * v + 0.45 * ms[k]), n), full = E.mixToRGB(mi, n), px = new Uint8ClampedArray(P * 3);
  for (let p = 0; p < P; p++) px.set(p % W < W / 2 ? full : bare, p * 3);
  const noBase = new Uint8Array(P), cov = E.separateIndex({ px, alpha: new Uint8Array(P).fill(255), W, H, inkLabs: [ink], garmentLab: shirt, n, noBase });
  const ub = E.buildUnderbase(cov, 1, P, new Float32Array(P * 3), 1, { solid: true, inkLabs: [ink], garmentLab: shirt, noBase });
  let inkL = 0, inkR = 0, ubL = 0, ubR = 0; for (let p = 0; p < P; p++) { if (p % W < W / 2) { inkL += cov[p]; ubL += ub[p]; } else { inkR += cov[p]; ubR += ub[p]; } }
  ok(inkL === P / 2 && inkR === P / 2 && ubL === P / 2 && ubR === 0, `index shade: one ink both halves, base only under the bright half (base ${ubL}/${ubR} of ${P / 2})`);
}
// Auto settings: flat art goes to spot with one screen per color; a smooth photo-like gradient goes to halftones
{
  const { autoPick, flatColors } = await import("../src/pipeline.js"), { genericLibrary } = await import("../src/inks.js");
  const mk = f => { const W = 90, H = 90, P = W * H, px = new Uint8ClampedArray(P * 3), alpha = new Uint8Array(P).fill(255), lab = new Float32Array(P * 3);
    for (let p = 0; p < P; p++) { const c = f(p % W, (p / W) | 0, W, H); px.set(c, p * 3); lab.set(E.rgb2lab(...c), p * 3); } return { px, alpha, lab, W, H }; };
  const base = { garmentLab: E.rgb2lab(255, 255, 255), n: 1.7, smooth: 0.1, rareFrac: 0.0005, underbase: false, ubStrength: 1, library: genericLibrary(), forceWhite: true, screening: "am", overprint: "same", rho: 0.6, rhos: [0, 0.5, 1], stackLimit: 2.8, paletteMode: "library" };
  const flat = mk((x, y) => x < 30 ? [200, 30, 40] : x < 60 ? [20, 60, 160] : y < 45 ? [250, 200, 20] : [255, 255, 255]);
  const fc = flatColors({ ...flat, garmentLab: base.garmentLab }), a1 = autoPick({ ...flat, ...base });
  ok(fc.flat && fc.K === 4 && fc.inks === 3 && a1.best.mode === "spot" && a1.best.k === 3 && a1.best.palette === "art", `auto: 3 flat colors on a white garment → spot, 3 screens, inks mixed to match (got ${a1.best.mode}/${a1.best.k})`);
  const grad = mk((x, y, W, H) => [Math.round(255 * x / W), Math.round(255 * y / H), Math.round(255 * (1 - x / W))]);
  const a2 = autoPick({ ...grad, ...base }), simRows = a2.rows.filter(r => r.mode === "sim");
  ok(!flatColors({ ...grad, garmentLab: base.garmentLab }).flat && a2.best.mode === "sim" && simRows.every(r => a2.best.score <= r.score + 1e-9), `auto: a smooth gradient → halftones at the lowest score of ${simRows.length} screen counts (${a2.best.k})`);
  // a print method you pick stays: Auto only tunes inside it (spot on the gradient, sim on the flat art, index with art inks)
  const a3 = autoPick({ ...grad, ...base, autoMethod: "spot" }), a4 = autoPick({ ...flat, ...base, autoMethod: "sim" }), a5 = autoPick({ ...flat, ...base, autoMethod: "index" });
  ok(a3.best.mode === "spot" && a3.rows.every(r => r.mode === "spot") && a4.best.mode === "sim" && a4.rows.every(r => r.mode === "sim") && a5.best.mode === "index" && a5.best.palette === "art",
    `auto keeps the picked method: spot ${a3.best.k} inks, sim ${a4.best.k}, index ${a5.best.k} with art inks (got ${a3.best.mode}/${a4.best.mode}/${a5.best.mode}/${a5.best.palette})`);
}
// Screen count: 9 screens is the usual most. Auto is not capped, but in the mix search a screen past 9 must
// raise the rating by more than PAST_USUAL_GAIN (0.15 stars) instead of 0.05. The search is driven with made-up trial
// results where every screen adds the same rating: 0.1 stars a screen stops at 9, 0.2 a screen goes past it.
{
  const { searchPlan, autoPick } = await import("../src/pipeline.js"), { screenGain, USUAL_SCREENS, PAST_USUAL_GAIN } = await import("../src/plan.js"), { genericLibrary } = await import("../src/inks.js");
  ok(USUAL_SCREENS === 9 && screenGain(5, 6, 0.05) === 0.05 && screenGain(8, 9, 0.05) === 0.05 && screenGain(9, 10, 0.05) === PAST_USUAL_GAIN && screenGain(10, 11, 0.05) === PAST_USUAL_GAIN && screenGain(8, 10, 0.05) === PAST_USUAL_GAIN && Math.abs(screenGain(9, 11, 0.05) - 2 * PAST_USUAL_GAIN) < 1e-12,
    "screen rule: up to 9 screens a screen needs 0.05 stars, each screen past 9 needs 0.15");
  const W = 60, H = 60, P = W * H, px = new Uint8ClampedArray(P * 3), alpha = new Uint8Array(P).fill(255), lab = new Float32Array(P * 3);
  for (let p = 0; p < P; p++) { const x = p % W, y = (p / W) | 0, c = [Math.round(255 * x / W), Math.round(255 * y / H), Math.round(255 * (1 - x / W))]; px.set(c, p * 3); lab.set(E.rgb2lab(...c), p * 3); }
  const lib = genericLibrary(), m = { px, alpha, lab, W, H, mode: "sim", garmentLab: E.rgb2lab(255, 255, 255), n: 1.7, smooth: 0.1, underbase: false, library: lib, locked: [], forceWhite: "off" };
  const start = lib.filter(i => i.lab[0] <= 92).slice(0, 8);
  const drive = (perScreen) => { const gen = searchPlan(m, start, { budget: 5000 }); let r = gen.next();
    // on-press ΔE falls 2 per 10 screens per 0.1 stars wanted: the rating gains perScreen stars a screen (0.5 stars per ΔE between 2 and 6)
    while (!r.done) r = gen.next(r.value.map(j => { const d = 6 - perScreen * 2 * (j.args.inks.length - 3); return { robust: d, mean: d, cmc: 1, ub: false }; }));
    return r.value; };
  const slow = drive(0.1), fast = drive(0.2);
  ok(slow.screens === USUAL_SCREENS && fast.screens > USUAL_SCREENS, `screen rule: a search gaining 0.1 stars a screen stops at 9 screens (${slow.screens}); gaining 0.2 a screen it goes past 9 (${fast.screens})`);
  ok(slow.byScreens[8] && slow.byScreens[9] && slow.byScreens[10] && slow.byScreens[9].stars - slow.byScreens[8].stars > 0.05 && slow.byScreens[10].stars - slow.byScreens[9].stars <= PAST_USUAL_GAIN,
    "screen rule: the search keeps its best mix at each screen count it rated (what fewer screens would rate, for Auto's note)");
  // Auto's pick carries those ratings to the app: the chosen count's entry is the search's own rating, every entry has its inks
  const a = autoPick({ px, alpha, lab, W, H, garmentLab: m.garmentLab, n: 1.7, smooth: 0.1, rareFrac: 0.0005, underbase: false, ubStrength: 1, library: lib, forceWhite: "off", screening: "am", overprint: "same", rho: 0.6, rhos: [0, 0.5, 1], stackLimit: 2.4, paletteMode: "library" }), by = a.best.byScreens;
  ok(by && by[a.best.search.screens] && by[a.best.search.screens].stars >= a.best.search.stars && Object.entries(by).every(([n, v]) => v.inks.length === +n && Number.isFinite(v.stars)) && a.rows.every(r => Number.isFinite(r.stars)),
    `screen rule: Auto's pick lists the rating at each screen count it tried (${Object.entries(by || {}).map(([n, v]) => n + ": " + v.stars).join(", ")})`);
}
// Film limits in the proof: dots under the smallest dot vanish or round up, over the largest go solid, and detail finer
// than a halftone cell averages out (coarser LPI or a smaller print blur more)
{
  const { filmLimited } = await import("../src/pipeline.js"), W = 100, H = 1, cov = Float32Array.from({ length: W }, (_, x) => x === 0 ? 0.02 : x === 1 ? 0.04 : x === 2 ? 0.95 : x % 2 ? 1 : 0);
  const c = filmLimited(cov, 1, W, H, { minDot: 0.06, maxDot: 0.92 });
  ok(c[0] === 0 && Math.abs(c[1] - 0.06) < 1e-6 && c[2] === 1, "film limits: 2% drops out, 4% rounds up to the 6% smallest dot, 95% goes solid");
  const stripes = Float32Array.from({ length: 200 * 200 }, (_, p) => (p % 200) % 2), fine = filmLimited(stripes, 1, 200, 200, { lpi: 45, widthIn: 1 }), coarse = filmLimited(stripes, 1, 200, 200, { lpi: 300, widthIn: 1 });
  const contrast = a => { let mx = 0, mn = 1; for (let x = 20; x < 180; x++) { mx = Math.max(mx, a[100 * 200 + x]); mn = Math.min(mn, a[100 * 200 + x]); } return mx - mn; };
  ok(contrast(fine) < 0.3 && contrast(coarse) === 1, `film limits: 1-pixel stripes blur out at 45 LPI on a 1 in print (contrast ${contrast(fine).toFixed(2)}) but survive when the cell is under a pixel`);
}
// Index rating: a checkerboard of two inks reads as their mix at viewing distance, so the score (rating, verdict) must
// judge the blended print; per pixel every pixel is a whole ink and the score was off by the full ink difference
{
  const { evaluate } = await import("../src/pipeline.js"), W = 60, H = 60, N = 2, P = W * H, lab = new Float32Array(P * 3), alpha = new Uint8Array(P).fill(255), cov = new Float32Array(P * N);
  const A = [55, 70, 50], B = [85, 5, 80], inks = [{ lab: A }, { lab: B }], g = [96, 0, 2];
  const flat = { W, H, lab: new Float32Array(P * 3), alpha, mode: "sim", garmentLab: g, n: 1.7, underbase: false, opacity: 0.55, film: { widthIn: 1 } }, half = new Float32Array(P * N).fill(0.5);
  const mix = evaluate({ ...flat, lab: new Float32Array(P * 3).fill(0) }, inks, half).img; // what a 50/50 mix looks like in the model
  for (let p = 0; p < P; p++) { lab.set(E.rgb2lab(mix[p * 4], mix[p * 4 + 1], mix[p * 4 + 2]), p * 3); cov[p * N + (((p % W) + ((p / W) | 0)) % 2)] = 1; }
  const m = { W, H, lab, alpha, mode: "index", garmentLab: g, n: 1.7, underbase: false, opacity: 0.55, film: { widthIn: 1 } };
  const blended = evaluate(m, inks, cov).stats, perPixel = evaluate({ ...m, eyeBlend: false }, inks, cov).stats;
  ok(blended.mean < 1.5 && perPixel.mean > 10 && blended.robustMean < perPixel.robustMean / 4, `index rating judges the blended print: mean ${blended.mean.toFixed(2)} (per pixel ${perPixel.mean.toFixed(2)}), on press ${blended.robustMean.toFixed(2)} (per pixel ${perPixel.robustMean.toFixed(2)})`);
}
// Spot drift and trapping: two flat colors touching on a dark garment; moving the screens opens gaps the drift score
// must see, and a trap (earlier ink spread under the later one) must close most of them
{
  const { evaluate } = await import("../src/pipeline.js"), W = 120, H = 60, N = 2, P = W * H, lab = new Float32Array(P * 3), alpha = new Uint8Array(P), cov = new Float32Array(P * N);
  // only a band around the color boundary is scored, so the image border (which no trap can fix) stays out
  const A = [55, 60, 40], B = [40, 10, -50]; for (let p = 0; p < P; p++) { const x = p % W, left = x < 60; lab.set(left ? A : B, p * 3); cov[p * N + (left ? 0 : 1)] = 1; alpha[p] = Math.abs(x - 60) < 6 ? 255 : 0; }
  const m = { W, H, lab, alpha, mode: "spot", garmentLab: [12, 0, 0], n: 1.7, underbase: true, ubStrength: 1, opacity: 0.55, film: { widthIn: 1 } }, inks = [{ lab: A }, { lab: B }];
  const still = evaluate(m, inks, cov).stats.robustMean, moved = evaluate({ ...m, driftMm: 0.2 }, inks, cov).stats.robustMean, trapped = evaluate({ ...m, driftMm: 0.2, trapMm: 0.5 }, inks, cov).stats.robustMean;
  ok(still < 0.1 && moved > still + 2 && trapped < moved - 0.3, `spot drift at the color edge: in register ${still.toFixed(2)}, screens moved 0.2 mm ${moved.toFixed(2)}, with a 0.5 mm trap ${trapped.toFixed(2)}`);
  const { trapSpot } = await import("../src/engine.js"), t = trapSpot(cov, N, W, H, 3);
  let spreadIntoLater = 0, spreadIntoOpen = 0; for (let p = 0; p < P; p++) { if (t[p * N] > cov[p * N]) { if (cov[p * N + 1] > 0.5) spreadIntoLater++; else spreadIntoOpen++; } }
  ok(spreadIntoLater === 3 * H && spreadIntoOpen === 0 && t.every((v, j) => j % N === 1 ? v === cov[j] : true), `trap: the first ink spreads 3 px under the later ink only (${spreadIntoLater} px), never into open garment, and the last ink is unchanged`);
}
// Print rating: 5 stars from the on-press score, less for low tolerance share and failed checks; one decimal
{
  const { printRating, starsFromDE } = await import("../src/plan.js");
  ok(starsFromDE(1) === 5 && starsFromDE(2) === 4 && starsFromDE(4) === 3 && starsFromDE(6) === 2 && starsFromDE(10) === 1 && starsFromDE(30) === 1 && Math.abs(starsFromDE(3.7) - 3.15) < 1e-9, "rating scale: 1→5, 2→4, 4→3, 6→2, 10→1 stars, straight lines between");
  const r = printRating({ onPress: 3.7, aligned: 1.6, inTol: 0.82, failedChecks: 0 }), r2 = printRating({ onPress: 3.7, aligned: 1.6, inTol: 0.4, failedChecks: 2 });
  ok(r.stars === 3.1 && Math.abs(r.alignedStars - 4.4) < 1e-9 && r2.stars === Math.round((3.15 - 0.5 - 0.6) * 10) / 10 && printRating({ onPress: 0.5, aligned: 0.4, inTol: 1 }).stars === 5 && printRating({ onPress: 15, aligned: 9, inTol: 0, failedChecks: 5 }).stars === 1,
    `print rating: sample 3.1 stars (4.4 aligned); low tolerance and 2 failed checks give ${r2.stars}; held to 1–5`);
}
// Index films: square pixels at the index DPI, every film pixel is a whole index pixel, screens never share one
{
  const W = 40, H = 40, N = 2, cov = new Float32Array(W * H * N);
  for (let p = 0; p < W * H; p++) { const x = p % W; cov[p * N] = x < 20 ? 0.6 : 0; cov[p * N + 1] = x >= 20 ? 0.4 : 0; }
  const Wp = 160, Hp = 160, c = { x0: 0, y0: 0, w: Wp, h: Hp }, fmIdx = E.fmIndexAt(cov, W, H, N, Wp, Hp, 400, 100, c);
  const a = E.renderPlate({ plate: { idx: 0 }, printed: cov, W, H, N, Wp, Hp, dpi: 400, lpi: 45, angle: 22.5, screening: "am", mode: "index", dot: { minDot: 0, maxDot: 1, gain: 0 }, choke: 0, fmIdx });
  const b = E.renderPlate({ plate: { idx: 1 }, printed: cov, W, H, N, Wp, Hp, dpi: 400, lpi: 45, angle: 22.5, screening: "am", mode: "index", dot: { minDot: 0, maxDot: 1, gain: 0 }, choke: 0, fmIdx });
  let square = true, overlap = 0, onA = 0; for (let y = 0; y < Hp; y++) for (let x = 0; x < Wp; x++) { const i = y * Wp + x, q = (y & ~3) * Wp + (x & ~3); if (a[i] !== a[q]) square = false; if (a[i] && b[i]) overlap++; onA += a[i]; }
  ok(square && overlap === 0 && Math.abs(onA / (Wp * Hp / 2) - 0.6) < 0.08, `index films are 4×4 film-pixel squares at 100 dpi on 400 dpi film, never overlap, keep coverage (${(onA / (Wp * Hp / 2) * 100).toFixed(0)}% vs 60%)`);
}
// Highlight white: Auto leaves it off; on/off and the old booleans are respected
{
  const { highlightWhite } = await import("../src/pipeline.js");
  ok(highlightWhite({ forceWhite: "auto", k: 5 }) === false && highlightWhite({ forceWhite: "auto", k: 12 }) === false && highlightWhite({ k: 4 }) === false
    && highlightWhite({ forceWhite: "on", k: 2 }) === true && highlightWhite({ forceWhite: "off", k: 9 }) === false && highlightWhite({ forceWhite: true, k: 2 }) === true && highlightWhite({ forceWhite: false, k: 9 }) === false,
    "highlight white: auto leaves it off (real-art test); on/off and true/false respected");
}
// Trap: whole pixels spread fully, a fraction of a pixel spreads partially (so a 0.4 mm trap survives on a 600 px job), never into open garment
{
  const W = 8, H = 1, N = 2, cov = new Float32Array(W * H * N);
  for (let x = 0; x < W; x++) { cov[x * N] = x < 4 ? 1 : 0; cov[x * N + 1] = x >= 4 && x < 7 ? 1 : 0; } // ink 0 left, ink 1 printed after it on the right, x=7 open garment
  const t1 = E.trapSpot(cov, N, W, H, 1), tf = E.trapSpot(cov, N, W, H, 0.6), t0 = E.trapSpot(cov, N, W, H, 0.02), t2 = E.trapSpot(cov, N, W, H, 1.5);
  ok(t1[4 * N] === 1 && t1[5 * N] === 0 && Math.abs(tf[4 * N] - 0.6) < 1e-6 && tf[5 * N] === 0 && t0[4 * N] === 0 && t2[4 * N] === 1 && Math.abs(t2[5 * N] - 0.5) < 1e-6
    && [t1, tf, t2].every(t => t[7 * N] === 0 && t[7 * N + 1] === 0) && [t1, tf, t2].every(t => t[3 * N + 1] === 0),
    `trap: 1 px → full under the next ink, 0.6 px → ${tf[4 * N].toFixed(2)}, 1.5 px → 1 then ${t2[5 * N].toFixed(2)}; nothing into open garment; the last ink never spreads`);
  // 0.4 mm on an 11 in film from 600 px art is 0.86 working px: before the fix this rounded to 0
  const r = 0.4 * 600 / (11 * 25.4), tt = E.trapSpot(cov, N, W, H, r); ok(tt[4 * N] > 0.8, `trap 0.4 mm at 600 px wide (${r.toFixed(2)} px) is no longer lost to rounding (${tt[4 * N].toFixed(2)})`);
}
// OKLab matches Ottosson's reference values (sRGB white and red), and spot v2 palettes are real art colors
{
  const w = E.lab2oklab(...E.rgb2lab(255, 255, 255)), r = E.lab2oklab(...E.rgb2lab(255, 0, 0));
  ok(Math.abs(w[0] - 1) < 2e-3 && Math.abs(w[1]) < 2e-3 && Math.abs(w[2]) < 2e-3 && Math.abs(r[0] - 0.62796) < 2e-3 && Math.abs(r[1] - 0.22486) < 2e-3 && Math.abs(r[2] - 0.12585) < 2e-3,
    `OKLab: white ${w.map(v => v.toFixed(3))}, red ${r.map(v => v.toFixed(3))} (reference 0.628, 0.225, 0.126)`);
  const cols = [[220, 30, 40], [30, 60, 200], [240, 200, 20]], samples = [];
  for (const c of cols) for (let j = -2; j <= 2; j++) samples.push({ lab: E.rgb2lab(c[0] + j * 3, c[1] + j * 2, c[2]), w: 10, wt: 10 });
  const pal = E.kmeansPalette(samples, 3), again = E.kmeansPalette(samples, 3);
  ok(pal.length === 3 && cols.every(c => pal.some(l => E.de2000(...l, ...E.rgb2lab(...c)) < 3)) && JSON.stringify(pal) === JSON.stringify(again),
    "k-means palette finds the three flat colors, the same every time");
  const g = E.rgb2lab(17, 17, 17);
  ok(E.spotError(samples, pal, g) < 2 && E.spotError(samples, pal.slice(0, 1), g) > 10, `spot palette error: 3 right inks ${E.spotError(samples, pal, g).toFixed(2)}, 1 ink ${E.spotError(samples, pal.slice(0, 1), g).toFixed(1)}`);
}
// Print-method screen angles (The Print Guide): duotone dark 45 / light 75 (base 15), tritone 45/75/15 (base 0),
// CMYK C15 M75 Y0 K45 with yellow at 108% of the line count; other methods keep the job's angle
{
  const { platesFor } = await import("../src/plan.js"), dark = { name: "Navy", lab: [20, 5, -30] }, mid = { name: "Red", lab: [50, 60, 40] }, light = { name: "Yellow", lab: [85, 0, 80] };
  const ang = (inks, ub, method) => platesFor(inks, ub, { screening: "same", angle: 22.5, lpi: 45, method }).map(p => (p.ub ? "B" : p.name[0]) + p.angle);
  ok(ang([light, dark], false, "duo").join(" ") === "Y75 N45" && ang([light, dark], true, "duo").join(" ") === "B15 Y75 N45" && ang([light, mid, dark], false, "tri").join(" ") === "Y15 R75 N45" && ang([dark], true, "mono").join(" ") === "B75 N45",
    `tone angles: ${ang([light, dark], true, "duo").join(" ")} · ${ang([light, mid, dark], false, "tri").join(" ")} · ${ang([dark], true, "mono").join(" ")}`);
  const cmyk = ["C", "M", "Y", "K"].map((k, i) => ({ name: k, lab: [50 + i, 0, 0], process: k })), pl = platesFor(cmyk, false, { screening: "same", angle: 22.5, lpi: 50, method: "cmyk" });
  ok(pl.map(p => p.name + p.angle).join(" ") === "C15 M75 Y0 K45" && pl.find(p => p.name === "Y").lpi === 54 && pl.filter(p => p.lpi).length === 1 && platesFor(cmyk, false, { screening: "same", angle: 22.5, lpi: 50 }).every(p => p.angle === 22.5 && !p.lpi),
    `CMYK angles ${pl.map(p => p.name + p.angle).join(" ")}, yellow at ${pl.find(p => p.name === "Y").lpi} lpi (108%); without a method the job angle stays`);
}
// CMYK method: four process inks in Y, M, C, K order, and printed films never stack past the 240% ink limit
{
  const { runSeparation, methodSettings, printedFrom, CMYK_INK_LIMIT } = await import("../src/pipeline.js"), { genericLibrary } = await import("../src/inks.js");
  const W = 24, H = 16, P = W * H, px = new Uint8ClampedArray(P * 3);
  for (let p = 0; p < P; p++) { const x = p % W, y = (p / W) | 0; px.set([Math.round(255 * x / (W - 1)), Math.round(255 * y / (H - 1)), 128 + (x * y) % 100], p * 3); }
  const base = { px, alpha: new Uint8Array(P).fill(255), W, H, garmentLab: E.rgb2lab(255, 255, 255), n: 1.7, smooth: 0.1, rareFrac: 0.0005, underbase: false, library: genericLibrary(), locked: [], inks: [] };
  const m = { ...base, ...methodSettings("cmyk", base) }, r = runSeparation(m), N = r.inks.length;
  const pr = printedFrom(r.cov, N, P, "sim", "am", m.overprint, 0.6, r.ub, m.stackLimit); let worst = 0;
  for (let p = 0; p < P; p++) { let s = 0; for (let i = 0; i < N; i++) s += pr[p * N + i]; worst = Math.max(worst, s); }
  ok(r.inks.map(i => i.process).join("") === "YMCK" && worst <= CMYK_INK_LIMIT + 1e-6, `CMYK: inks ${r.inks.map(i => i.process).join("")}, highest ink stack ${(worst * 100).toFixed(0)}% (limit ${CMYK_INK_LIMIT * 100}%)`);
  const mono = methodSettings("mono", { ...base, garmentLab: E.rgb2lab(17, 17, 17) });
  ok(mono.k === 1 && mono.underbase === false && mono.locked[0].lab[0] > 92 && methodSettings("duo", base).k === 2 && methodSettings("tri", base).k === 3, "one-ink job on a dark shirt is one white screen with no base; duotone 2 inks, tritone 3");
}
{
  // accents: a red accent ink is barred from yellow and blue targets but allowed on reds; a hue that covers much of the
  // art is a main colour, not an accent; a small saturated red on a blue field is found as an accent
  const red = 30, pen = n => E.accentGatePen([red, null], E.rgb2lab(...n), new Float64Array(3));
  ok(pen([200, 30, 40])[0] === 0 && pen([230, 200, 40])[0] > 0 && pen([60, 90, 200])[0] > 0 && pen([128, 128, 128])[0] > 0 && pen([230, 200, 40])[1] === 0,
    "accent ink prints only on its own hue: allowed on red, barred on yellow, blue and gray; ordinary inks unaffected");
  const smp = (rgb, w) => { const lab = E.rgb2lab(...rgb); return { lab, w, mix: E.mixFromRGB(...rgb, 1.7) }; };
  const field = [smp([60, 90, 200], 9500), smp([70, 100, 210], 300), smp([210, 30, 40], 120), smp([200, 40, 50], 80)];
  const acc = E.findAccents(field, field.map(s => Math.hypot(s.lab[1], s.lab[2]) > 50 && s.lab[1] > 40 ? 40 : 1));
  ok(acc.length === 1 && acc[0].lab[1] > 40 && acc[0].area > 0.015 && acc[0].area < 0.03, `a small red on a blue field is an accent (area ${acc[0] ? (acc[0].area * 100).toFixed(1) : "-"}%)`);
  const mostlyRed = [smp([210, 30, 40], 5000), smp([60, 90, 200], 5000)];
  ok(E.findAccents(mostlyRed, [40, 1]).length === 0, "a hue covering half the art is a main colour, not an accent");
}
// Interlocked screens: two inks in one cell tile it (the second fills the holes of the first): no pixel carries both,
// each ink prints its own share, and where the two add up to 100% nothing is left uncovered
{ const W = 4, H = 4, N = 2, Wp = 360, Hp = 360, dpi = 360, lpi = 30, dot = { gain: 0, minDot: 0, maxDot: 1 };
  for (const [a, b] of [[0.3, 0.7], [0.55, 0.45], [0.2, 0.5]]) {
    const printed = new Float32Array(W * H * N); for (let p = 0; p < W * H; p++) { printed[p * N] = a; printed[p * N + 1] = b; }
    const film = idx => E.renderPlate({ plate: { idx }, printed, ub: null, W, H, N, Wp, Hp, dpi, lpi, angle: 22.5, screening: "am", mode: "sim", dot, choke: 0, lock: true });
    const fa = film(0), fb = film(1); let both = 0, ca = 0, cb = 0, none = 0;
    for (let q = 0; q < fa.length; q++) { both += fa[q] & fb[q]; ca += fa[q]; cb += fb[q]; none += !fa[q] && !fb[q] ? 1 : 0; }
    const P = fa.length;
    ok(both === 0 && Math.abs(ca / P - a) < 0.02 && Math.abs(cb / P - b) < 0.02 && (a + b < 0.999 || none / P < 0.005),
      `interlocked ${Math.round(a * 100)}% + ${Math.round(b * 100)}%: no overlap (${both} px), shares ${(ca / P * 100).toFixed(1)}% and ${(cb / P * 100).toFixed(1)}%, uncovered ${(none / P * 100).toFixed(1)}%`); }
  const { printedFrom } = await import("../src/pipeline.js"), cov = Float32Array.from([0.4, 0.5]);
  ok(Array.from(printedFrom(cov, 2, 1, "sim", "am", "lock", 0.6, null, 2.8)).every((v, i) => Math.abs(v - cov[i]) < 1e-6), "interlocked: each screen prints only what shows (no hidden ink)"); }
// Scatter at the dark end: a tone over the largest dot keeps whole smallest holes in a share of the cells instead of
// every cell going solid at once (the hard line where a fade reaches solid)
{ const W = 8, H = 8, tone = 0.97, printed = new Float32Array(W * H).fill(tone), dpi = 400, lpi = 40, Wp = 400, Hp = 400;
  const film = scatter => E.renderPlate({ plate: { idx: 0 }, printed, ub: null, W, H, N: 1, Wp, Hp, dpi, lpi, angle: 0, screening: "am", mode: "sim", dot: { gain: 0, minDot: 0.05, maxDot: 0.92, scatter }, choke: 0 });
  const cover = b => b.reduce((s, v) => s + v, 0) / b.length, on = film(true), off = film(false);
  ok(Math.abs(cover(on) - tone) < 0.006 && cover(off) === 1, `scatter: a 97% tone over a 92% largest dot prints ${(cover(on) * 100).toFixed(1)}% (without scatter ${(cover(off) * 100).toFixed(0)}%)`);
  for (const lock of [false, true]) { const two = new Float32Array(W * H * 2); for (let p = 0; p < W * H; p++) { two[p * 2] = 0.5; two[p * 2 + 1] = 0.47; }
    const f = idx => E.renderPlate({ plate: { idx }, printed: two, ub: null, W, H, N: 2, Wp, Hp, dpi, lpi, angle: 0, screening: "am", mode: "sim", dot: { gain: 0, minDot: 0.05, maxDot: 0.92, scatter: true }, choke: 0, lock });
    if (!lock) continue; const a = f(0), b = f(1); let both = 0, any = 0; for (let q = 0; q < a.length; q++) { both += a[q] & b[q]; any += a[q] | b[q]; }
    ok(both === 0 && Math.abs(any / a.length - 0.97) < 0.006, `interlocked 50% + 47% over the largest dot: no overlap, ${(any / a.length * 100).toFixed(1)}% inked`); } }
// Stack-aware solve: a sunset strip on black (purple → pink → orange → yellow) with the inks that once printed a pale band.
// Where a mix would pass the stack limit, the solve keeps whichever answer prints closer once the press trims it, so the
// on-press score can only get better than the solve that ignores the limit.
{ const { runSeparation } = await import("../src/pipeline.js"), { genericLibrary } = await import("../src/inks.js"), lib = genericLibrary();
  const W = 90, H = 60, P = W * H, px = new Uint8ClampedArray(P * 3), alpha = new Uint8Array(P).fill(255), stops = [[90, 40, 140], [224, 69, 123], [247, 162, 27], [255, 241, 168]];
  for (let y = 0; y < H; y++) { const t = y / (H - 1) * 3, i = Math.min(2, Math.floor(t)), f = t - i; for (let x = 0; x < W; x++) for (let c = 0; c < 3; c++) px[(y * W + x) * 3 + c] = Math.round(stops[i][c] + f * (stops[i + 1][c] - stops[i][c])); }
  const inks = ["Purple", "Scarlet", "Orange", "Pink", "Golden Yellow", "White"].map(nm => ({ ...lib.find(k => k.name === nm), locked: true }));
  const m = { px, alpha, W, H, mode: "sim", garmentLab: E.rgb2lab(17, 17, 17), n: 1.7, smooth: 0.1, underbase: true, ubStrength: 1, inks, repick: false, screening: "am", overprint: "same", rho: 0.6, rhos: [0, 0.5, 1], stackLimit: 2.8, film: { minDot: 0.05, maxDot: 0.92, lpi: 45, widthIn: 11, scatter: true }, dropEmpty: false };
  const off = runSeparation({ ...m, stackAware: false }).stats.robustMean, on = runSeparation(m).stats.robustMean;
  ok(on <= off + 0.02, `stack-aware solve: on-press ΔE on a sunset strip ${off.toFixed(2)} → ${on.toFixed(2)}`); }
// Smooth recipes: on a gray ramp mixed from colour inks (many mixes print the same gray), the plain solve zigzags from
// one recipe to another; the smoothing passes keep the recipe steady without losing colour accuracy
{ const W = 4, H = 240, P = W * H, px = new Uint8ClampedArray(P * 3), alpha = new Uint8Array(P).fill(255);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) px.fill(Math.round(30 + y / (H - 1) * 200), (y * W + x) * 3, (y * W + x) * 3 + 3);
  const inkLabs = [[30, 24, -54], [47, 66, 41], [55, -55, 35], [64, 55, -6], [90, -5, 85], [96, -1, 2]], garmentLab = E.rgb2lab(17, 17, 17), N = inkLabs.length;
  const args = { px, alpha, W, H, inkLabs, garmentLab, n: 1.7, smooth: 0.1, hw: undefined, base: { strength: 0.92, op: 0.55 } };
  const zig = cov => { let s = 0; for (let y = 1; y < H - 1; y++) for (let i = 0; i < N; i++) { const c = k => cov[(k * W) * N + i]; s += Math.abs(c(y + 1) - 2 * c(y) + c(y - 1)); } return s; };
  const plain = E.separateSim({ ...args, opts: {} }), smooth = E.separateSim({ ...args, opts: { smoothPasses: 2, smoothMu: 0.05 } });
  ok(zig(smooth) < 0.8 * zig(plain), `smooth recipes: recipe zigzag on a gray ramp ${zig(plain).toFixed(2)} → ${zig(smooth).toFixed(2)}`); }
// The base never shows alone: where the stack limit trims the hidden ink, the base is trimmed to the largest dot on it
{ const { runSeparation, printedFrom } = await import("../src/pipeline.js"), { genericLibrary } = await import("../src/inks.js"), lib = genericLibrary();
  const W = 60, H = 40, P = W * H, px = new Uint8ClampedArray(P * 3), alpha = new Uint8Array(P).fill(255);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) px.set([200 + Math.round(x / W * 30), 70 + Math.round(y / H * 60), 120 - Math.round(x / W * 60)], (y * W + x) * 3);
  const inks = ["Purple", "Scarlet", "Orange", "Pink", "Golden Yellow", "White"].map(nm => ({ ...lib.find(k => k.name === nm), locked: true }));
  const r = runSeparation({ px, alpha, W, H, mode: "sim", garmentLab: E.rgb2lab(17, 17, 17), n: 1.7, smooth: 0.1, underbase: true, ubStrength: 1, inks, repick: false, screening: "am", overprint: "same", rho: 0.6, rhos: [0, 0.5, 1], stackLimit: 2.0, dropEmpty: false, stackAware: false });
  const N = r.inks.length, pr = printedFrom(r.cov, N, P, "sim", "am", "same", 0.6, r.ub, 2.0); let over = 0;
  for (let p = 0; p < P; p++) { let mx = 0; for (let i = 0; i < N; i++) mx = Math.max(mx, pr[p * N + i]); if (r.ub[p] > mx + 1e-4) over++; }
  ok(over === 0, `the base is never wider than the largest dot on it, even under a tight stack limit (${over} of ${P} spots)`); }
// Solid line work: a thin near-white line on a teal fade (graphic art) prints as solid White with a hard edge on the film;
// a photo-like (textured) image is left alone
{ const { runSeparation } = await import("../src/pipeline.js"), { genericLibrary } = await import("../src/inks.js"), lib = genericLibrary();
  const W = 120, H = 60, P = W * H, px = new Uint8ClampedArray(P * 3), alpha = new Uint8Array(P).fill(255);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const line = y >= 28 && y <= 31 && x >= 10 && x < 110, t = y / H; px.set(line ? [240, 238, 228] : [10, Math.round(70 + 40 * t), 75], (y * W + x) * 3); }
  const inks = ["Teal", "Royal", "White"].map(nm => ({ ...lib.find(k => k.name === nm), locked: true }));
  const m = { px, alpha, W, H, mode: "sim", garmentLab: E.rgb2lab(17, 17, 17), n: 1.7, smooth: 0.1, underbase: true, ubStrength: 1, inks, library: lib, repick: false, screening: "am", overprint: "same", rho: 0.6, stackLimit: 3.2, film: { minDot: 0.05, maxDot: 0.92, lpi: 45, widthIn: 2 }, dropEmpty: false };
  const r = runSeparation(m), N = r.inks.length, wi = r.inks.findIndex(k => k.name === "White"); let solid = 0, n = 0;
  for (let y = 29; y <= 30; y++) for (let x = 20; x < 100; x++) { const p = y * W + x; n++; if (r.solid && r.solid.ink[p] === wi + 1 && r.cov[p * N + wi] === 1) solid++; }
  ok(solid === n, `solid line work: a 4 px white line on a teal fade prints White at 100% (${solid}/${n} core pixels)`);
  const off = runSeparation({ ...m, solidDetail: false }); ok(!off.solid, "solid line work can be turned off");
  const noisy = Uint8ClampedArray.from(px, (v, i) => Math.max(0, Math.min(255, v + ((i * 2654435761) % 41) - 20)));
  const rn = runSeparation({ ...m, px: noisy, lab: undefined }); ok(!rn.solid, "a photo-like (textured) image is left alone");
  // a line in a tint near an ink (cream, 12 from White) keeps its colour: a tint shape, its recipe not pure White
  const cream = Uint8ClampedArray.from(px); for (let y = 44; y <= 47; y++) for (let x = 10; x < 110; x++) cream.set([221, 215, 182], (y * W + x) * 3);
  const inks2 = ["Teal", "Royal", "Golden Yellow", "White"].map(nm => ({ ...lib.find(k => k.name === nm), locked: true }));
  const rc = runSeparation({ ...m, px: cream, lab: undefined, inks: inks2 }), N2 = rc.inks.length, w2 = rc.inks.findIndex(k => k.name === "White"), pc = 45 * W + 60;
  ok(rc.solid && rc.solid.ink[pc] === w2 + 1 && rc.cov[pc * N2 + w2] === 1, "a cream line (no ink matches) prints as solid White");
  const ls = rc.lineSuggest; ok(!!ls && ls.name === "Cream" && ls.asInk === "White" && ls.before > 6, `and a Cream screen is offered for it (${ls ? `${ls.name}, ${ls.before} from ${ls.asInk}, ${(ls.area * 100).toFixed(1)}% of the art` : "none"})`);
  const rc2 = runSeparation({ ...m, px: cream, lab: undefined, inks: inks2.concat([{ name: "Cream", lab: ls.lab, locked: true }]) }), ci = rc2.inks.findIndex(k => k.name === "Cream");
  ok(rc2.solid && rc2.solid.ink[pc] === ci + 1 && !rc2.lineSuggest, "with a Cream screen added the line prints as solid Cream and nothing more is offered"); }
// Solid shape films: an edge pixel 30% shape prints 30% of its area on the film (exact width), and no dots of the shape's
// ink leak into the pixel beyond it
{ const W = 6, H = 4, P = W * H, frac = new Float32Array(P), ink = new Uint8Array(P), printed = new Float32Array(P);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const p = y * W + x; if (x <= 2) { ink[p] = 1; frac[p] = 1; printed[p] = 1; } if (x === 3) { ink[p] = 1; frac[p] = 0.3; printed[p] = 0.3; } }
  const solid = { ink, frac, geo: E.edgeGeometry(Int16Array.from(ink, v => v - 1), frac, W, H), open: new Uint8Array(P).fill(1) };
  const Wp = 600, Hp = 400, b = E.renderPlate({ plate: { idx: 0 }, printed, ub: null, W, H, N: 1, Wp, Hp, dpi: 400, lpi: 40, angle: 22.5, screening: "am", mode: "sim", dot: { gain: 0, minDot: 0.05, maxDot: 0.95, scatter: true }, choke: 0, solid });
  const share = x0 => { let on = 0, n = 0; for (let y = 100; y < 300; y++) for (let x = x0 * 100; x < x0 * 100 + 100; x++) { n++; on += b[y * Wp + x]; } return on / n; };
  ok(Math.abs(share(3) - 0.3) < 0.02, `solid edge: a 30% edge pixel prints 30% of its area (${(100 * share(3)).toFixed(1)}%)`);
  ok(share(4) === 0 && share(2) === 1, `solid edge: solid inside, no dots leak past the edge (${(100 * share(4)).toFixed(1)}% beyond)`); }
// Scatter small dots: a tone under the smallest dot prints whole smallest dots in that share of the cells
{ let on = 0; for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) if (E.bayerCell(u, v) < 0.3) on++;
  ok(on === Math.round(0.3 * 64), `scatter: 30% of an 8×8 block of cells switches on (${on} of 64)`);
  const W = 8, H = 8, N = 1, tone = 0.02, printed = new Float32Array(W * H).fill(tone), dpi = 400, lpi = 40, Wp = 400, Hp = 400;
  const film = scatter => E.renderPlate({ plate: { idx: 0 }, printed, ub: null, W, H, N, Wp, Hp, dpi, lpi, angle: 0, screening: "am", mode: "sim", dot: { gain: 0, minDot: 0.05, maxDot: 0.95, scatter }, choke: 0 });
  const cover = b => b.reduce((s, v) => s + v, 0) / b.length, on2 = film(true), off2 = film(false);
  ok(Math.abs(cover(on2) - tone) < 0.004, `scatter: a 2% tone under a 5% smallest dot prints 2% on average (${(cover(on2) * 100).toFixed(2)}%)`);
  ok(cover(off2) === 0, "without scatter the same tone drops out of the film");
  // every scattered dot is a whole smallest dot: per cell, ink is either none or about 5% of the cell
  const cell = dpi / lpi, sizes = []; for (let cy = 0; cy < Hp / cell; cy++) for (let cx = 0; cx < Wp / cell; cx++) { let s = 0; for (let y = cy * cell; y < (cy + 1) * cell; y++) for (let x = cx * cell; x < (cx + 1) * cell; x++) s += on2[y * Wp + x]; sizes.push(s / (cell * cell)); }
  ok(sizes.every(v => v === 0 || Math.abs(v - 0.05) < 0.03), `scatter: each cell prints no dot or a whole smallest dot (${[...new Set(sizes.map(v => v.toFixed(2)))].join(", ")})`); }
// Adjust the art: neutral changes nothing; brightness and contrast keep solid black and white and every step of a gradient
{ const A = await import("../src/adjust.js"), grad = new Uint8ClampedArray(256 * 4); for (let v = 0; v < 256; v++) grad.set([v, v, v, 255], v * 4);
  ok(A.adjustArt(grad, 256, 1, A.ADJ0).every((v, i) => v === grad[i]), "Adjust: neutral sliders leave the art as it is");
  for (const [k, v] of [["bright", 60], ["bright", -60], ["contrast", 60], ["contrast", -60]]) { const t = A.toneCurve({ ...A.ADJ0, [k]: v });
    let mono = true; for (let i = 1; i < 256; i++) if (t[i] < t[i - 1]) mono = false;
    ok(t[0] === 0 && t[255] === 255 && mono, `Adjust: ${k} ${v} keeps solid black and white and never reverses a gradient`); }
  const lv = A.toneCurve({ ...A.ADJ0, black: 40, white: 220 }); ok(lv[30] === 0 && lv[40] === 0 && lv[230] === 255 && lv[130] > 120 && lv[130] < 136, "Adjust: black and white point clip outside, spread inside");
  const red = A.colorMove(200, 60, 60, { ...A.ADJ0, sat: -100 }); ok(Math.max(...red) - Math.min(...red) <= 3, `Adjust: saturation −100 makes gray (${red})`);
  const flat = new Uint8ClampedArray(16 * 16 * 4).fill(120); for (let i = 3; i < flat.length; i += 4) flat[i] = 255; const fs = A.adjustArt(flat, 16, 16, { ...A.ADJ0, sharpen: 100 });
  ok(fs.every((v, i) => v === flat[i]), "Adjust: sharpen leaves a flat area alone");
  const clear = new Uint8ClampedArray([10, 20, 30, 0]); ok(A.adjustArt(clear, 1, 1, { ...A.ADJ0, bright: 80, sat: 50 }).every((v, i) => v === clear[i]), "Adjust: transparent pixels are not touched"); }
// Refill: a forced highlight white that prints nothing (dark art, no highlights) leaves its screen to the next best ink,
// so the job prints k colour screens, never more; refill "off" keeps the short job
{ const { runSeparation } = await import("../src/pipeline.js"), { genericLibrary } = await import("../src/inks.js");
  const W = 48, H = 48, P = W * H, px = new Uint8ClampedArray(P * 3), alpha = new Uint8Array(P).fill(255), cols = [[150, 20, 30], [20, 40, 140], [20, 110, 40], [190, 90, 20], [110, 30, 120]];
  for (let p = 0; p < P; p++) { const c = cols[Math.floor((p % W) / (W / cols.length))], t = 0.6 + 0.4 * Math.floor(p / W) / H; px.set(c.map(v => Math.round(v * t)), p * 3); }
  const m = { px, alpha, W, H, mode: "sim", garmentLab: E.rgb2lab(17, 17, 17), n: 1.7, k: 4, smooth: 0.1, rareFrac: 0.0005, underbase: true, ubStrength: 1, library: genericLibrary(), locked: [], inks: [], forceWhite: true, repick: true, paletteMode: "library", screening: "am", overprint: "same", rho: 0.6, rhos: [0, 0.5, 1], stackLimit: 2.4 };
  const off = runSeparation({ ...m, refill: "off" }), on = runSeparation({ ...m, refill: "top" });
  ok(off.dropped.includes("White") && off.inks.length === 3 && on.inks.length === 4 && on.inks.every(i => i.lab[0] <= 92) && on.inks.some(i => i.refill),
    `refill: dropped white's screen goes to a colour ink, k = 4 kept (off: ${off.inks.map(i => i.name)}; on: ${on.inks.map(i => i.name)})`); }
// Refill pick: the search's best few next inks, judged by the full-size on-press score; never more than k, never a white,
// never an ink just dropped (refill any)
{ const { runSeparation, refillCandidates } = await import("../src/pipeline.js"), { genericLibrary } = await import("../src/inks.js");
  const W = 48, H = 48, P = W * H, px = new Uint8ClampedArray(P * 3), alpha = new Uint8Array(P).fill(255), cols = [[150, 20, 30], [20, 40, 140], [20, 110, 40], [190, 90, 20], [110, 30, 120]];
  for (let p = 0; p < P; p++) { const c = cols[Math.floor((p % W) / (W / cols.length))], t = 0.6 + 0.4 * Math.floor(p / W) / H; px.set(c.map(v => Math.round(v * t)), p * 3); }
  const m = { px, alpha, W, H, mode: "sim", garmentLab: E.rgb2lab(17, 17, 17), n: 1.7, k: 4, smooth: 0.1, rareFrac: 0.0005, underbase: true, ubStrength: 1, library: genericLibrary(), locked: [], inks: [], forceWhite: true, repick: true, paletteMode: "library", screening: "am", overprint: "same", rho: 0.6, rhos: [0, 0.5, 1], stackLimit: 2.4, solidDetail: false };
  const top = runSeparation({ ...m, refill: "top", refillPick: 0 }), pk = runSeparation({ ...m, refill: "top", refillPick: 4 });
  ok(pk.inks.length === 4 && pk.inks.every(i => i.lab[0] <= 92) && pk.stats.robustMean <= top.stats.robustMean + 1e-6,
    `refill pick: k = 4 kept, on-press ${pk.stats.robustMean.toFixed(3)} ≤ search top ${top.stats.robustMean.toFixed(3)} (${pk.inks.map(i => i.name)})`);
  const smp = E.imageSamples(px, alpha, P, m.garmentLab, 1.7, { rareFrac: 0.0005, garmentTol: 10 }).samples, kept = top.inks.slice(0, 2), gone = top.inks[2];
  const cs = refillCandidates(m, smp, kept, [gone], 3);
  ok(cs.length === 3 && new Set(cs.map(c => c.name)).size === 3 && cs.every(c => c.lab[0] <= 92 && c.name !== gone.name && !kept.some(k => k.name === c.name)),
    `refill candidates: 3 distinct colour inks, not the dropped ${gone.name} (${cs.map(c => c.name)})`); }
// Gradient round: an ink fading under later inks near 100% shows a ring no larger than its own tone and its film moves
// smoothly (RINGCAP); a stray 0.1% tone prints no lone dots, a 1% tone under the smallest dot still prints scattered
// dots (SCATTERFLOOR); a smooth base fade keeps its tail under the soft choke while a hard edge is choked in full (UBFADE)
{ const N = 3, out = new Float32Array(N); let worst = 0, jump = 0, prev = null;
  for (let i = 0; i <= 100; i++) { const vb = 0.1 * (1 - i / 100), v = Float32Array.from([vb, 0.45, 0.9 - vb - 0.45 + 0.08]);
    E.visibleToPrinted(v, N, out, "same", 0.6, 0.03); const ring = out[0] - Math.max(out[1], out[2]);
    if (E.RING_CAP) worst = Math.max(worst, ring - v[0]); if (prev != null) jump = Math.max(jump, Math.abs(Math.max(0, ring) - prev)); prev = Math.max(0, ring); }
  ok(!E.RING_CAP || (worst <= 1e-6 && jump < 0.02), E.RING_CAP ? `ring cap: an ending ink shows at most its tone (excess ${worst.toFixed(4)}), ring moves ≤ ${jump.toFixed(4)} per step` : "ring cap: off (RINGCAP=1 to check)");
  const W = 8, H = 8, Wp = 400, Hp = 400, dot = { gain: 0, minDot: 0.06, maxDot: 0.92, scatter: true }, film = a => E.renderPlate({ plate: { idx: 0 }, printed: new Float32Array(W * H).fill(a), ub: null, W, H, N: 1, Wp, Hp, dpi: 400, lpi: 45, angle: 22.5, screening: "am", mode: "sim", dot, choke: 0 }).reduce((s, b) => s + b, 0) / (Wp * Hp);
  const stray = film(0.001), low = film(0.01);
  ok((!E.SCATTER_FLOOR || stray === 0) && Math.abs(low - 0.01) < 0.004, `scatter: 0.1% prints ${(stray * 100).toFixed(3)}% (no lone dots), 1% prints ${(low * 100).toFixed(2)}%`);
  const Wb = 64, ramp = new Float32Array(Wb * 4), edge = new Float32Array(Wb * 4);
  for (let y = 0; y < 4; y++) for (let x = 0; x < Wb; x++) { ramp[y * Wb + x] = Math.max(0, Math.min(1, (x - 8) / 48)); edge[y * Wb + x] = x >= 32 ? 1 : 0; }
  const sr = E.softChoke(ramp, Wb, 4, 3), se = E.softChoke(edge, Wb, 4, 3), hr = E.adaptiveChoke(edge, Wb, 4, 3);
  ok(Math.abs(sr[2 * Wb + 20] - ramp[2 * Wb + 20]) < 1e-6 && se.every((v, i) => Math.abs(v - hr[i]) < 1e-6), `soft choke: a fade keeps its base (${sr[2 * Wb + 20].toFixed(3)}), an edge is choked as before`); }
// Stack fade: the soft knee never lets the stack over the limit, is the identity below the knee and
// moves continuously (STACKFADE off by default; the function is checked either way)
{ let over = 0, jump = 0, prev = null, below = 0; for (let st = 1.5; st <= 4; st += 0.001) { const t = E.stackKnee(st, 2.4, 0.4);
    over = Math.max(over, t - 2.4); if (st <= 2.0) below = Math.max(below, Math.abs(t - st)); if (prev != null) jump = Math.max(jump, Math.abs(t - prev)); prev = t; }
  ok(over <= 0 && below === 0 && jump <= 0.001 + 1e-9, `stack fade: never over the limit (${over.toFixed(4)}), unchanged below the knee, continuous (step ${jump.toFixed(4)})`); }
// Print order per job: Auto moves an ink that fades out at the stack limit later in the order and keeps
// the move only by ORDER_GAIN; everything the job writes (films, flash/cure, mix sheet, job sheet, PSD) follows that order
{ const Pp = await import("../src/pipeline.js"), Pl = await import("../src/plan.js");
  const ink = (name, L) => ({ name, lab: [L, 10, 20] }), inks = [ink("Brown", 28), ink("Royal", 30), ink("Orange", 61), ink("Flesh", 78), ink("White", 96)];
  const mv = Pp.orderMoves(inks, 0);
  ok(mv.map(x => x.after).join() === "Royal,Orange,Flesh" && mv.every(x => x.inks[x.inks.length - 1].name === "White" && x.inks.length === 5), "order moves: one ink to every later place, the highlight white stays last");
  // the plan: only an ink whose fade sits at the limit (tail >= ORDER_TAIL) is moved; a move must beat the start by ORDER_GAIN
  const run = (tails, scores, views = scores.map(() => 2)) => { const g = Pp.orderPlan({ mode: "sim" }, inks); let r = g.next(); const sent = [];
    r = g.next([{ robust: 2.5, view: 3, fadeTails: tails }]); if (!r.done) { sent.push(...r.value.map(j => j.args.inks.map(i => i.name).join("/"))); r = g.next(r.value.map((_, i) => ({ robust: scores[i], view: views[i] }))); } return { out: r.value, sent }; };
  const a = run([0.04, 0.001, 0, 0, 0.5], [2.47, 2.38, 3.2]);
  ok(a.sent.length === 3 && a.sent[1] === "Royal/Orange/Brown/Flesh/White" && a.out.best && a.out.best.after === "Orange", `order plan: Brown (tail 4%) tried at 3 places, best Brown after Orange (${a.out.best && a.out.best.s})`);
  const b = run([0.04, 0, 0, 0, 0], [2.47, 2.46, 2.6]); ok(!b.out.best, "order plan: a move under 2% better keeps dark-first");
  const v = run([0.04, 0, 0, 0, 0], [2.3, 2.38, 3.2], [2.99, 3.1, 2]); ok(!v.out.best, "order plan: a better press score with no better Print view keeps dark-first (18 grey ramp)");
  const c = run([0.005, 0, 0, 0, 0], []); ok(!c.out.best && !c.sent.length && c.out.fades.length === 0, "order plan: no ink fading out at the limit, no trials");
  // fade tails: ink 0 at 5% under a full stack counts; ink 1 at 5% on an open area does not
  const W = 2, H = 1, P = 2, cov = new Float32Array([0.05, 0.5, 0.5, 0.5, 0.05, 0]), px = new Uint8ClampedArray(P * 3).fill(128);
  const ev = Pp.evaluate({ mode: "sim", W, H, px, alpha: new Uint8Array(P).fill(255), lab: Pp.labOf(px, P), garmentLab: E.rgb2lab(17, 17, 17), n: 1.7, underbase: true, ubStrength: 1, stackLimit: 1, fadeTails: true }, inks.slice(0, 3), cov);
  ok(ev.stats.fadeTails && ev.stats.fadeTails[0] === 0.5 && ev.stats.fadeTails[1] === 0, `fade tails: an ink ending under a full stack counts, one ending in the open does not (${ev.stats.fadeTails})`);
  // a chosen order is the job's order: plates, flash and cure, mix sheet rows, PSD channel names
  const ord = [ink("Royal", 30), ink("Orange", 61), ink("Brown", 28), ink("Flesh", 78)], pl = Pl.platesFor(ord, true, { screening: "same", angle: 22.5 });
  ok(pl.map(p => p.name).join() === "Underbase,Royal,Orange,Brown,Flesh" && pl.every((p, j) => p.order === j + 1) && Pl.checkPlan(pl, { covPct: [0.1, 0.1, 0.1, 0.1] }).length === 0, "chosen order: films in that order (Brown third), plan check clean");
  const sp = Pl.specFor({ plates: pl, result: { stats: {}, covPct: [0.1, 0.2, 0.3, 0.4], ubPct: 0.5 }, mode: "sim", garment: { hex: "#111111", lab: [5, 0, 0] }, print: { screening: "same", lpi: 45 }, model: {}, targets: [] });
  ok(sp.screens.map(x => `${x.order}.${x.name}${x.flash ? "+flash" : ""}${x.cure ? "+cure" : ""}`).join() === "1.Underbase+flash,2.Royal,3.Orange,4.Brown,5.Flesh+cure" && sp.screens[3].coverage === 0.3, "chosen order: job sheet screens, flash after the base, cure after the last, coverage by ink");
  const mx = Pl.mixRows({ plates: pl, covPct: [0.1, 0.2, 0.3, 0.4], ubPct: 0.5, areaIn2: 100, shirts: 10 });
  ok(mx.map(x => `${x.order}.${x.name}`).join() === "1.Underbase,2.Royal,3.Orange,4.Brown,5.Flesh", "chosen order: mix sheet rows in print order");
  const { toPSD } = await import("../src/output.js"), d1 = new Uint8Array(4).fill(128);
  const psd = new TextDecoder("utf-16be").decode(new Uint8Array(await toPSD({ W: 2, H: 2, dpi: 300, channels: pl.map(p => ({ name: `${p.order}. ${p.name}`, rgb: [0, 0, 0], data: d1 })) }).arrayBuffer()));
  const at = n => psd.indexOf(n); ok(at("2. Royal") >= 0 && at("2. Royal") < at("3. Orange") && at("3. Orange") < at("4. Brown") && at("4. Brown") < at("5. Flesh"), "chosen order: PSD spot channels in print order");
}
// Framed on an ADN page the page does all the scrolling: nothing may stop a drag on the table from scrolling the page
// (overscroll-behavior: none on the frame's root did: on the live tool page no drag on the table scrolled at all)
{ const { readFileSync } = await import("node:fs"), css = readFileSync(new URL("../src/bench.css", import.meta.url), "utf8");
  ok(!/html:has\(> body\.framed\)\{[^}]*overscroll-behavior:\s*none/.test(css), "framed: a drag on the table scrolls the page (no overscroll-behavior: none on the frame's root)"); }
// README status: every number comes from the test output; a layer that did not run says so instead of guessing
{ const { summarize } = await import("../scripts/status.mjs");
  const r = summarize({ check: "ok   a\nok   b\nall passed\n", fuzz: "fuzz: 60 random cases + metamorphic checks passed\n", mutate: "killed  x\nSURVIVED  y\n\nmutation score: 1/2 planted bugs caught\n", gate: "GATE FAILED\n  x", e2e: null });
  ok(r[0][1] === "2 checks passed, 0 failed" && r[0][2] === true && r[1][1] === "60 random cases" && r[2][1] === "1 of 2 planted bugs caught" && r[2][2] === false && r[3][2] === false && r[4][1] === "not run" && r[4][2] === null,
    "status: counts are read from the test output; a survivor or a failed gate fails; a missing layer reads not run"); }
// Release files follow version.js: a disagreeing file or tag is named; the draft lists only PRs CHANGELOG.md does not name
{ const R = await import("../scripts/release.mjs");
  const files = { pkg: '{"version":"1.2.3"}', changelog: "# Changelog\n\n## 1.2.3 (2026-01-01)\n\n- x (#5)\n\n[Full release notes](releases/1.2.3.md)\n\n## 1.2.2\n", readme: "<!-- status:begin (x) -->\nVersion 1.2.3. Generated" };
  const good = R.releaseProblems({ version: "1.2.3", files, notes: () => "# Separation Table 1.2.3\n", tag: "v1.2.3", prefix: "v" });
  const bad = R.releaseProblems({ version: "1.2.4", files, notes: () => null, tag: "v1.2.3", prefix: "v" });
  ok(good.length === 0 && bad.length === 5 && bad.some(l => /package.json/.test(l)) && bad.some(l => /tag v1.2.3/.test(l)), `release: agreeing files pass; a version bump alone names package.json, CHANGELOG, notes, README and the tag (${bad.length})`);
  const d = R.draftLines(["Separation Table: Faster films (#7)", "Fix (#5)", "no number", "Separation Table: Faster films (#7)"], files.changelog);
  ok(d.length === 1 && d[0] === "- Faster films (#7)" && R.bump("1.2.3", "patch") === "1.2.4" && R.bump("1.2.3", "minor") === "1.3.0" && R.bump("1.2.3", "major") === "2.0.0", "release: the draft lists each new PR once, without the tool prefix; versions bump"); }
// Pinned files: a changed byte, a missing file or an unpinned file in vendor/ is named
{ const { verifyVendor } = await import("../scripts/notices.mjs"), fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path"), crypto = await import("node:crypto");
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "sep-pins-")), h = t => crypto.createHash("sha256").update(t).digest("hex");
  fs.mkdirSync(path.join(d, "vendor")); fs.mkdirSync(path.join(d, "models")); fs.writeFileSync(path.join(d, "vendor/a.js"), "a"); fs.writeFileSync(path.join(d, "models/m.onnx"), "m");
  fs.writeFileSync(path.join(d, "vendor.sha256"), `${h("a")}  vendor/a.js\n${h("m")}  models/m.onnx\n`);
  const clean = verifyVendor({ dir: d, models: "require" }).length; fs.writeFileSync(path.join(d, "vendor/a.js"), "b"); fs.writeFileSync(path.join(d, "vendor/x.js"), "x"); fs.rmSync(path.join(d, "models/m.onnx"));
  const v = verifyVendor({ dir: d, models: "require" }), skip = verifyVendor({ dir: d, models: "skip" }); fs.rmSync(d, { recursive: true });
  ok(clean === 0 && v.length === 3 && skip.length === 2 && v.some(l => /a\.js: SHA-256/.test(l)) && v.some(l => /x\.js: not pinned/.test(l)) && v.some(l => /m\.onnx: missing/.test(l)), "pins: a changed vendor file, an unpinned one and a missing model are each named"); }
// Every file of the job ZIP read back through our own readers; CI also opens them with outside programs (tests/outside-readers.mjs)
{ const { readbackChecks } = await import("./readback.mjs"); await readbackChecks(ok); }
// ───────────── Shop production: film mirror, rename, double hit, press time, re-proof imported films ─────────────
{ const { mirrorX, toPSD, toTIFF } = await import("../src/output.js"), w = 5, h = 3, a = Uint8Array.from({ length: w * h }, (_, i) => i), m = mirrorX(a, w, h);
  const rgba = Uint8Array.from({ length: w * h * 4 }, (_, i) => i % 251), m4 = mirrorX(rgba, w, h, 4);
  ok(m[0] === 4 && m[4] === 0 && m[5] === 9 && mirrorX(m, w, h).every((v, i) => v === a[i]) && m4[0] === rgba[16] && m4[3] === rgba[19] && mirrorX(m4, w, h, 4).every((v, i) => v === rgba[i]),
    "film mirror: each row is flipped left to right (plates and RGBA), and mirroring twice gives the film back");
  const P = await import("../src/plan.js"), inks = [{ name: "Red", lab: [50, 60, 40], label: "  Customer\u0007 Red  " }, { name: "White", lab: [96, 0, 2], hits: 2, flashBetween: true }, { name: "Blue", lab: [30, 10, -50], label: "Blue" }];
  const calib = { inks: { Red: { curve: [0, 0.5, 1] } } }, pl = P.platesFor(inks, true, { screening: "same", angle: 22.5, lpi: 45, calib, ub: { label: "Base", hits: 2 } });
  ok(pl[1].name === "Customer Red" && pl[1].ink === "Red" && pl[1].curve && P.plateSlug(pl[1]) === "02-customer-red" && pl[3].name === "Blue" && !pl[3].ink && pl[0].name === "Base" && P.cleanName("x".repeat(60)).length === P.NAME_MAX,
    "rename: the shop's name goes on the plate and its file name, the ink keeps its own name (and calibration), control characters and extra spaces go, 40 characters at most");
  const lab = P.filmLabel(pl[2], { mode: "sim", screening: "same", lpi: 45, dpi: 400 }), labM = P.filmLabel(pl[1], { mode: "sim", screening: "same", lpi: 45, dpi: 400, mirror: true });
  ok(/PRINT 2X, FLASH BETWEEN/.test(lab) && /PRINT 2X  THEN FLASH/.test(P.filmLabel(pl[0], { mode: "sim", screening: "same", lpi: 45, dpi: 400 })) && /CUSTOMER RED .*MIRRORED$/.test(labM) && !/2X/.test(labM),
    "double hit and mirror on the film label: PRINT 2X (with FLASH BETWEEN when set), MIRRORED on mirrored films");
  ok(P.flashesFor(pl) === 2 && P.screensFor(pl[2], "automatic") === 2 && P.screensFor(pl[2], "manual") === 1 && P.screensFor(pl[0], "automatic") === 1,
    "double hit: the base flash plus the flash between hits; a flash between needs a second screen on an automatic, not on a manual");
  const spec = P.specFor({ plates: pl, result: { covPct: [0.2, 0.1, 0.3], ubPct: 0.4, stats: { mean: 1 } }, mode: "sim", garment: { hex: "#111111", lab: [5, 0, 0] }, print: { width_in: 11, dpi: 400, lpi: 45, screening: "same", angle: 22.5, dot_gain_50: 18, min_dot: 6, max_dot: 92, choke_mm: 0.2, choke_px: 3, index_dpi: 200, mirror: true },
    model: { yule_nielsen_n: 1.7, calibrated: false, calibration_residual_de00: null }, targets: [], pressTime: P.pressTime({ plates: pl, shirts: 120, press: "automatic", setupMin: 12, perHour: 360 }) });
  ok(spec.print.mirror === true && spec.screens[1].name === "Customer Red" && spec.screens[1].ink === "Red" && spec.screens[1].file === "02-customer-red" && spec.screens[2].hits === 2 && spec.screens[2].flash_between_hits && spec.screens[0].underbase && spec.screens[0].hits === 2 && !spec.screens[0].flash_between_hits && spec.flashes_per_print === 2 && spec.press_time.total_min === 80 && !("imported" in JSON.parse(JSON.stringify(spec))),
    "separation.json carries the mirror, each screen's name, ink, hits and flash between, the flashes per print and the press time");
  const mix = P.mixRows({ plates: pl, covPct: [0.2, 0.1, 0.3], ubPct: 0.4, areaIn2: 100, shirts: 100, press: "automatic" }), one = P.inkGrams({ areaIn2: 100, coverage: 0.1, shirts: 100, kind: "white" });
  ok(mix[2].hits === 2 && mix[2].grams === P.inkGrams({ areaIn2: 100, coverage: 0.1, shirts: 100, kind: "white", hits: 2, screens: 2 }) && mix[2].grams > one && mix[0].ub && !mix[1].ub,
    `mix sheet: a double hit mixes twice the ink and fills a second screen on an automatic (${one} → ${mix[2].grams} g)`);
  const t = P.pressTime({ plates: pl, shirts: 120, press: "automatic", setupMin: 12, perHour: 360 }), tm = P.pressTime({ plates: pl, shirts: 120, press: "manual" });
  ok(t.screens === 5 && t.strokes === 6 && t.flashes === 2 && t.setup_min === 60 && t.run_min === 20 && t.total_min === 80 && t.estimate && tm.screens === 4 && tm.setup_min_per_screen === P.PRESS_TIME.manual.setupMin && P.hoursMin(125) === "2 h 5 min" && P.hoursMin(60) === "1 h" && P.hoursMin(7) === "7 min",
    "press time: screens × setup minutes plus prints ÷ prints per hour, stated as an estimate; missing numbers take the press type's start values");
  { const noFlash = pl.filter(p => !p.ub).map(p => ({ ...p, hits: 1, flashBetween: false })), m1 = P.pressTime({ plates: noFlash, shirts: 120, press: "manual" }), m2 = P.pressTime({ plates: pl, shirts: 120, press: "manual" });
    ok(P.PRESS_TIME.manual.setupMin === 5 && P.PRESS_TIME.manual.perHour === 60 && P.PRESS_TIME.automatic.setupMin === 7.5 && P.PRESS_TIME.automatic.perHour === 500
      && m1.flashes === 0 && m1.prints_per_hour_run === 60 && m1.run_min === 120 && m2.flashes > 0 && m2.prints_per_hour_run === 40 && m2.run_min === Math.round(120 / (60 * 0.67) * 60) && t.prints_per_hour_run === 360 && /60 with no flash/.test(P.pressTimeText(m2)),
      `press time start values are the published medians (manual 5 min, 60/h; automatic 7.5 min, 500/h); a flashed job on a manual press runs at 0.67 (${m1.run_min} → ${m2.run_min} min)`); }
  // re-proof: what output.js writes, filmimport.js reads back
  const F = await import("../src/filmimport.js"), W = 24, H = 16, base = Uint8Array.from({ length: W * H }, (_, i) => i % W < 12 ? 0 : 255), red = Uint8Array.from({ length: W * H }, (_, i) => (i % W) * 10);
  const psd = F.readPSD(new Uint8Array(await toPSD({ W, H, dpi: 300, channels: [{ name: "1. Base 2x flash", rgb: [244, 244, 240], data: base }, { name: "2. Customer Red", rgb: [208, 42, 48], data: red }] }).arrayBuffer()));
  ok(psd.mode === "multichannel" && psd.W === W && psd.H === H && psd.dpi === 300 && psd.channels[0].ub && psd.channels[0].hits === 2 && psd.channels[0].flashBetween && psd.channels[0].name === "Base" && psd.channels[1].name === "Customer Red" && !psd.channels[1].ub
    && E.de2000(...psd.channels[1].lab, ...E.rgb2lab(208, 42, 48)) < 0.5 && psd.channels[0].ink[0] === 255 && psd.channels[0].ink[20] === 0 && psd.channels[1].ink[1] === 245,
    "re-proof: a Photoshop file reads back with each screen's name, color, ink, the base and a double hit (\"2x flash\")");
  const rgbPsd = F.readPSD(new Uint8Array(await toPSD({ W, H, dpi: 300, rgba: new Uint8ClampedArray(W * H * 4).map((_, i) => i % 4 === 3 ? 255 : 200), channels: [{ name: "2. Customer Red", rgb: [208, 42, 48], data: red }] }).arrayBuffer()));
  ok(rgbPsd.mode === "rgb" && rgbPsd.rgba && rgbPsd.rgba[0] === 200 && rgbPsd.channels.length === 1, "re-proof: an RGB Photoshop file gives the art (its composite) and only its spot channels as screens");
  const bits = Uint8Array.from({ length: W * H }, (_, i) => (i * 7) % 5 === 0 ? 1 : 0), tif = F.readTIFF(new Uint8Array(await toTIFF(bits, W, H, 400).arrayBuffer()));
  ok(tif.W === W && tif.H === H && tif.dpi === 400 && tif.ink.every((v, i) => v === (bits[i] ? 255 : 0)), "re-proof: a 1-bit TIFF film reads back bit for bit at its DPI");
  // an 8-bit gray, BlackIsZero, LZW TIFF (the way Photoshop saves a grayscale plate): 24 × 16 px written by Pillow (libtiff)
  const lzwTif = Buffer.from("SUkqAEQBAACAACBQOCQWDQM8J1hOcGDErHtQMV1A8aFk/KNkO0JDcuIFTMt4BUdF9CKlnPMMD0xIdWNF7BsgGVFK9qPkPEM0I1ZNd+CEjGtILVtP8SEk3JNcN0BCcmHFLLuD1GpFg+qJjuwIjYtoBSsp3hQcl5BqhmvILjwwoZVtB6hofmREq5pvgOkIzoxYtZ9iAimpHrRsv4Rkg2pJbtwAiYlnBKrpvgQUk45pheuIDiwonZN1LOQUcF1BKdmPELDswIVVM96BkfGNEK1pPcOEEzItYNV9B8iGlHLNsP0REc2JFbNsACUlG9KLlvAMUE05JdeOEDCsoHVNL9yAkXFOEwuGw/O+MASmVy2XzGZzWbzmdz2f0Gh0Wj0ml02nuACionnRMl8cYEBaKQ7k4YJzAWGAqj0T5iHSBwZqoqysK0gIDAAAAQMAAQAAABgAAAABAQMAAQAAABAAAAACAQMAAQAAAAgAAAADAQMAAQAAAAUAAAAGAQMAAQAAAAEAAAARAQQAAQAAAAgAAAAWAQMAAQAAABAAAAAXAQQAAQAAADwBAAAaAQUAAQAAANoBAAAbAQUAAQAAAOIBAAAcAQMAAQAAAAEAAAAoAQMAAQAAAAIAAAAAAAAALAEAAAEAAAAsAQAAAQAAAA==", "base64");
  const lt = F.readTIFF(new Uint8Array(lzwTif)), gray = i => (Math.floor(i / 24) % 4 ? (i * 37) % 256 : 0);
  ok(lt.W === 24 && lt.H === 16 && lt.dpi === 300 && lt.ink.every((v, i) => v === 255 - gray(i)), "re-proof: an 8-bit gray LZW TIFF (black is zero) reads back, dark = ink");
  const sq = new Uint8Array(1400 * 1400); for (let y = 200; y < 1200; y++) for (let x = 200; x < 1200; x++) sq[y * 1400 + x] = 255;
  ok(JSON.stringify(F.artArea(1100 + 400, 800 + 400, 400, 1100 / 800)) === JSON.stringify({ x: 200, y: 200, w: 1100, h: 800 }) && F.artArea(1100, 800, 400, 1100 / 800).x === 0 && F.artArea(1100, 800, 400, 1) === null
    && F.artArea(1400, 1400, 400, 1, { widthIn: 2.5 }).x === 200 && F.artArea(1400, 1400, 400, 1, { widthIn: 3.5 }).x === 0 && F.artArea(1400, 1400, 400, 1, { planes: [sq] }).x === 200 && F.artArea(1400, 1400, 400, 1, { planes: [new Uint8Array(1400 * 1400).fill(255)] }).x === 0,
    "re-proof: the 0.5 in film margin is trimmed when that matches the art's shape (a square: by the job's width, else by an empty margin); a film of another shape is refused");
  const half = new Uint8Array(400 * 400); for (let y = 0; y < 400; y++) for (let x = 0; x < 400; x++) half[y * 400 + x] = E.amOn(x, y, 0.3, 8.9, Math.cos(0.4), Math.sin(0.4)) ? 255 : 0;
  const dc = F.inkToCov(half, 400, { x: 0, y: 0, w: 400, h: 400 }, 80, 80, 1), mean = dc.reduce((s, v) => s + v, 0) / dc.length, spread = Math.max(...dc) - Math.min(...dc);
  ok(F.isBilevel(half) && Math.abs(mean - 0.3) < 0.03 && spread < 0.25, `re-proof: a 30% halftone film descreens to its dot area (${(mean * 100).toFixed(1)}%, spread ${(spread * 100).toFixed(0)} points)`);
  { let worst = 0; for (const model of ["same", "rotated", "lock"]) for (let t = 0; t < 300; t++) {
      const N = 4, v = Array.from({ length: N }, () => Math.random() * 0.2), o = new Float32Array(N); E.visibleToPrinted(Float32Array.from(v), N, o, model, 0, 0);
      const back = F.printedToVisible([...o].map(x => Float32Array.of(x)), 1, model, 0); back.forEach((b, k) => { worst = Math.max(worst, Math.abs(b[0] - v[k])); }); }
    ok(worst < 1e-4, `re-proof: the films' printed dots go back to the ink that shows (one angle, rotated, interlocked; worst ${worst.toExponential(1)})`); }
  { const a = Float32Array.from([0.1, 0.3, 0.5, 0.8]), back = F.withGain(Float32Array.from(a, v => E.invGain(v, 0.18)), 0.18);
    ok(back.every((v, i) => Math.abs(v - a[i]) < 1e-5) && Math.abs(F.withGain(Float32Array.of(0.5), 0.2)[0] - 0.7) < 1e-6, "re-proof: a halftone film gets the press's dot gain back (the inverse of the film's compensation)"); }
  ok(["Underbase", "1. Underbase", "01-underbase", "White base", "Base", "UB", "02-under-base"].every(F.isBaseName) && !["Baseball Red", "Highlight White", "Blue"].some(F.isBaseName), "re-proof: the base screen is found by its name, other screens are not");
  // the re-proof keeps an imported base exactly: it is not built again from the inks
  { const { evaluate } = await import("../src/pipeline.js"), Wq = 12, Hq = 12, Pq = Wq * Hq, px = new Uint8ClampedArray(Pq * 3).fill(180), alpha = new Uint8Array(Pq).fill(255), labq = new Float32Array(Pq * 3);
    for (let j = 0; j < Pq; j++) labq.set(E.rgb2lab(180, 180, 180), j * 3);
    const ubIn = Float32Array.from({ length: Pq }, (_, j) => j % Wq < 6 ? 1 : 0), m = { W: Wq, H: Hq, px, alpha, lab: labq, garmentLab: [5, 0, 0], n: 1.7, mode: "sim", screening: "am", underbase: true, ubIn, trimBase: false };
    const r = evaluate(m, [{ name: "Gray", lab: [70, 0, 0] }], new Float32Array(Pq).fill(0.6));
    ok(r.ub.every((v, j) => v === ubIn[j]) && Math.abs(r.ubPct - 0.5) < 1e-6, "re-proof: an imported underbase is used as it is, not built again from the inks"); }
}
// ───────────── Dot shapes ─────────────
{
  const th = 22.5 * Math.PI / 180, cs = Math.cos(th), sn = Math.sin(th), cell = 17.3, N = 400;
  const cover = (shape, a) => { let on = 0; for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) on += E.dotOn(shape, x, y, a, cell, cs, sn) ? 1 : 0; return on / (N * N); };
  for (const shape of E.DOT_SHAPES) { const errs = [0.05, 0.25, 0.5, 0.75, 0.95].map(a => Math.abs(cover(shape, a) - a));
    ok(Math.max(...errs) < 0.006, `${shape} dots cover the tone within 0.6% at 5–95% (worst ${(Math.max(...errs) * 100).toFixed(2)}%)`); }
  const P = await import("../src/plan.js");
  ok(JSON.stringify([...E.DOT_SHAPES]) === JSON.stringify(P.PROFILE_SHAPES), "profiles accept exactly the engine's dot shapes");
  // a flat tone renders to the same coverage with every shape, the shapes differ (coarse 15 LPI cells, so a shape has room), and Round is the films as before
  const W = 60, H = 60, Wp = 240, Hp = 240, printed = new Float32Array(W * H).fill(0.4);
  const film = (shape, lock = false) => E.renderPlate({ plate: { idx: 0 }, printed, ub: null, W, H, N: 1, Wp, Hp, dpi: 400, lpi: 15, angle: 22.5, screening: "am", mode: "sim", dot: { gain: 0, minDot: 0, maxDot: 1, ...(shape && { shape }) }, choke: 0, lock });
  const share = b => b.reduce((s, v) => s + v, 0) / b.length, base = film(null);
  const lock0 = film(null, true), round = film("round"), roundLock = film("round", true);
  ok(round.every((v, i) => v === base[i]) && roundLock.every((v, i) => v === lock0[i]), "Round is the default: the same films with or without the setting, plain and interlocked");
  for (const shape of ["ellipse", "square", "line"]) { const f = film(shape), fl = film(shape, true), diff = f.reduce((s, v, i) => s + (v !== base[i] ? 1 : 0), 0) / f.length;
    ok(Math.abs(share(f) - 0.4) < 0.02 && Math.abs(share(fl) - 0.4) < 0.02 && diff > 0.03, `${shape} film of a 40% tone covers ${(share(f) * 100).toFixed(1)}% (interlocked ${(share(fl) * 100).toFixed(1)}%), ${(diff * 100).toFixed(0)}% of pixels differ from round`); }
}
// Screen angle: counterclockwise from horizontal, as RIPs and PostScript count it. One ellipse dot of a 22.5° film (y
// down on the film) has its long axis at +22.5°: found from the dot's second moments with y turned up.
{
  const W = 30, H = 30, Wp = 300, Hp = 300, printed = new Float32Array(W * H).fill(0.25);
  const f = E.renderPlate({ plate: { idx: 0 }, printed, ub: null, W, H, N: 1, Wp, Hp, dpi: 600, lpi: 15, angle: 22.5, screening: "am", mode: "sim", dot: { gain: 0, minDot: 0, maxDot: 1, shape: "ellipse" }, choke: 0 });
  let seed = -1; for (let r = 0; r < 60 && seed < 0; r++) for (let dx = -r; dx <= r && seed < 0; dx++) { const q = (150 + r) * Wp + 150 + dx; if (f[q]) seed = q; }
  const seen = new Uint8Array(Wp * Hp), stack = [seed], pts = []; seen[seed] = 1;
  while (stack.length) { const q = stack.pop(), x = q % Wp, y = (q / Wp) | 0; pts.push([x, -y]);
    for (const n of [q - 1, q + 1, q - Wp, q + Wp]) if (n >= 0 && n < Wp * Hp && !seen[n] && f[n] && Math.abs((n % Wp) - x) <= 1) { seen[n] = 1; stack.push(n); } }
  const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length, my = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  let sxx = 0, syy = 0, sxy = 0; for (const [x, y] of pts) { sxx += (x - mx) ** 2; syy += (y - my) ** 2; sxy += (x - mx) * (y - my); }
  const axis = 0.5 * Math.atan2(2 * sxy, sxx - syy) * 180 / Math.PI;
  ok(pts.length > 50 && Math.abs(axis - 22.5) < 2, `an ellipse film at 22.5° has its long axis at ${axis.toFixed(1)}°, counterclockwise from horizontal (${pts.length} px dot)`);
}
// ───────────── DCS 2.0 writer ─────────────
{
  const { toDCS, PS_SPOT } = await import("../src/output.js");
  const W = 40, H = 30, mk = f => { const d = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) d[i] = Math.round(255 * (1 - f(i % W, Math.floor(i / W)))); return d; };
  const channels = [{ name: "1. Underbase", rgb: [244, 244, 240], data: mk(() => 1), lpi: 45, angle: 22.5, shape: "ellipse" },
    { name: "2. Red (sim)", rgb: [208, 42, 48], data: mk(x => x / (W - 1)), lpi: 45, angle: 22.5, shape: "ellipse" },
    { name: "3. Highlight White", rgb: [250, 250, 250], data: mk((x, y) => y > 20 ? 0.4 : 0), lpi: 45, angle: 22.5, shape: "ellipse" }];
  const { blob, plates } = toDCS({ W, H, dpi: 100, channels, background: [17, 17, 17], title: "check" }), b = new Uint8Array(await blob.arrayBuffer());
  const latin = u => Array.from(u, c => String.fromCharCode(c)).join(""), all = latin(b), head = all.slice(0, all.indexOf("%%EndComments"));
  const pf = [...head.matchAll(/^%%PlateFile: \((.*)\) EPS #(\d+) (\d+)$/gm)].map(m => ({ name: m[1], offset: +m[2], size: +m[3] }));
  ok(all.startsWith("%!PS-Adobe-3.0 EPSF-3.0\n") && /^%%BoundingBox: 0 0 29 22$/m.test(head) && head.split("\n").every(l => l.length <= 255), "DCS main: EPSF header, bounding box at print size, header lines under 255 characters");
  ok(pf.length === 3 && pf.map(p => p.name).join("|") === "1. Underbase|2. Red sim|3. Highlight White" && JSON.stringify(pf) === JSON.stringify(plates), "DCS: one single-file %%PlateFile per screen, in print order, parentheses taken out of names");
  ok(/%%DocumentCustomColors: \(1\. Underbase\)\n%%\+ \(2\. Red sim\)\n%%\+ \(3\. Highlight White\)/.test(head) && (head.match(/^%%RGBCustomColor: /gm) || []).length === 3 && (head.match(/^%%CMYKCustomColor: /gm) || []).length === 3, "DCS: every screen is a custom color with RGB and CMYK approximations");
  ok(pf[0].offset === all.indexOf("%%Trailer\n") + 10 && pf.every((p, i) => i === 0 || p.offset === pf[i - 1].offset + pf[i - 1].size) && pf[2].offset + pf[2].size === b.length, "DCS: the main section ends where the first plate starts; plates follow one another to the end of the file");
  // PostScript RunLengthDecode (PLRM 3.13.3), written here from the spec: the reader is not the writer's packBits
  const rld = (u, from) => { const out = []; let i = from; for (;;) { const n = u[i++]; if (n === 128) return { out, end: i }; if (n < 128) { for (let k = 0; k <= n; k++) out.push(u[i++]); } else { const v = u[i++]; for (let k = 0; k < 257 - n; k++) out.push(v); } } };
  const read = (seg, comps) => { const t = latin(seg), m = /%%BeginData: (\d+) Binary Bytes\nexec\n/.exec(t), start = m.index + m[0].length, r = rld(seg, start);
    return { ok: t.startsWith("%!PS-Adobe-3.0 EPSF-3.0\n") && t.endsWith("\n%%Trailer\n") && +m[1] === 5 + (r.end - start) && t.slice(r.end, r.end + 11) === "\n%%EndData\n" && r.out.length === W * H * comps, data: r.out, text: t }; };
  const segs = pf.map((p, i) => ({ ...read(b.subarray(p.offset, p.offset + p.size), 1), ch: channels[i] }));
  ok(segs.every(s => s.ok && s.data.every((v, q) => v === s.ch.data[q])), "DCS plates read back: EPS section, %%BeginData count, end of data, every channel byte equal");
  ok(segs.every(s => s.text.includes(`45 22.5 ${PS_SPOT.ellipse} setscreen`) && !/%%PlateFile/.test(s.text)), "DCS plates set their own halftone: 45 LPI, 22.5°, the Ellipse spot function; no %%PlateFile inside a plate");
  const comp = read(b.subarray(0, pf[0].offset), 3), q = 25 * W + 39, mixed = [17, 17, 17].map((g, c) => { let v = g; for (const ch of channels) { const a = 1 - ch.data[q] / 255; v += (ch.rgb[c] - v) * a; } return Math.round(v); });
  ok(comp.ok && comp.data.slice(q * 3, q * 3 + 3).join() === mixed.join() && comp.data.slice(0, 3).join() === "244,244,240", `DCS composite: the screens laid on the garment in print order (${mixed})`);
  const plain = toDCS({ W, H, dpi: 100, channels: channels.map(({ lpi, ...c }) => c) }), pt = latin(new Uint8Array(await plain.blob.arrayBuffer()));
  ok(!pt.includes("setscreen"), "DCS without halftone settings (spot, index) leaves the screen to the RIP");
  // independent reader: Ghostscript renders the composite and each plate, and the plate's own screen makes the dots
  const { execFileSync } = await import("node:child_process"), { writeFileSync, mkdtempSync, readFileSync } = await import("node:fs"), { tmpdir } = await import("node:os"), { join } = await import("node:path");
  let gs = null; try { gs = execFileSync("gs", ["--version"]).toString().trim(); } catch { }
  if (!gs) console.log("skip  Ghostscript is not installed: DCS rendering not checked");
  else {
    const dir = mkdtempSync(join(tmpdir(), "dcs-")), f = join(dir, "job.eps"); writeFileSync(f, b);
    let errs = ""; const run = (src, dev, res, out) => { try { execFileSync("gs", ["-q", "-dSAFER", "-dBATCH", "-dNOPAUSE", "-dEPSCrop", `-sDEVICE=${dev}`, `-r${res}`, `-sOutputFile=${out}`, src], { stdio: "pipe" }); return true; } catch (e) { errs += String(e.stderr || e.message).slice(0, 200); return false; } };
    const okAll = run(f, "pgmraw", 100, join(dir, "comp.pgm")) && pf.every((p, i) => { writeFileSync(join(dir, `p${i}.eps`), b.subarray(p.offset, p.offset + p.size)); return run(join(dir, `p${i}.eps`), "pgmraw", 100, join(dir, `p${i}.pgm`)); });
    // a flat plate printed 1-bit (pbmraw: rows of 600 bits, 1 = black): Ghostscript screens it with the plate's own setscreen
    const screened = (shape, gray) => { const fl = toDCS({ W: 100, H: 100, dpi: 100, channels: [{ name: "1. Red", rgb: [200, 30, 30], data: new Uint8Array(100 * 100).fill(gray), lpi: 30, angle: 22.5, shape }] });
      const p0 = fl.plates[0], src = join(dir, `flat-${shape}-${gray}.eps`), out = src.replace(".eps", ".pbm"); return fl.blob.arrayBuffer().then(ab => { writeFileSync(src, new Uint8Array(ab).subarray(p0.offset, p0.offset + p0.size));
        if (!run(src, "pbmraw", 600, out)) return null; const pbm = readFileSync(out); return pbm.subarray(pbm.length - 600 * 600 / 8); }); };
    const bits = u => u.reduce((s, v) => { let c = 0; for (let k = 0; k < 8; k++) c += (v >> k) & 1; return s + c; }, 0) / (600 * 600);
    const tones = await Promise.all([204, 153, 102].map(g => screened("ellipse", g))), cov = tones.map(t => t ? bits(t) : NaN);
    const ln = await screened("line", 153), rd = await screened("round", 153), apart = ln && rd ? ln.reduce((s, v, i) => { let x = v ^ rd[i], c = 0; while (x) { c += x & 1; x >>= 1; } return s + c; }, 0) / (600 * 600) : 0;
    // Ghostscript applies its own tone curve on this device: measured 16, 34 and 52% for 20, 40 and 60%, for every shape
    ok(okAll && cov[0] < cov[1] && cov[1] < cov[2] && cov.every((c, i) => Math.abs(c - [0.2, 0.4, 0.6][i]) < 0.1) && apart > 0.2,
      `Ghostscript ${gs} reads the DCS file: composite and every plate render; a plate screens with its own dot shape (20/40/60% → ${cov.map(c => (c * 100).toFixed(0)).join("/")}% black; line and round plates differ on ${(apart * 100).toFixed(0)}% of pixels)${errs ? " (" + errs + ")" : ""}`);
  }
}
// ───────────── Photoshop halftone screens ─────────────
{
  const { toPSD } = await import("../src/output.js"), W = 8, H = 4, data = new Uint8Array(W * H).fill(100), chans = [{ name: "1. A", rgb: [1, 2, 3], data }, { name: "2. B", rgb: [4, 5, 6], data }];
  const res1012 = u => { const dv = new DataView(u.buffer), n = dv.getUint32(26); let o = 30 + n + 4; const end = o + dv.getUint32(o - 4);
    for (; o < end;) { const id = dv.getUint16(o + 4), nl = u[o + 6], po = o + 6 + ((nl + 2) & ~1), len = dv.getUint32(po); if (id === 1012) return new DataView(u.buffer, po + 4, len); o = po + 4 + len + (len & 1); } return null; };
  const withS = new Uint8Array(await toPSD({ W, H, dpi: 300, channels: chans, screens: [{ lpi: 45, angle: 22.5, shape: "ellipse" }, { lpi: 55, angle: -15, shape: "line" }] }).arrayBuffer());
  const r = res1012(withS), rec = k => r && { lpi: r.getUint32(k * 18) / 65536, unit: r.getUint16(k * 18 + 4), angle: r.getInt32(k * 18 + 6) / 65536, shape: r.getUint16(k * 18 + 10) };
  ok(!!r && r.byteLength === 36 && JSON.stringify([rec(0), rec(1)]) === JSON.stringify([{ lpi: 45, unit: 1, angle: 22.5, shape: 1 }, { lpi: 55, unit: 1, angle: -15, shape: 2 }]),
    "PSD halftone screens (resource 1012): 18 bytes per channel, LPI, angle and Photoshop's shape code (1 Ellipse, 2 Line)");
  ok(res1012(new Uint8Array(await toPSD({ W, H, dpi: 300, channels: chans }).arrayBuffer())) === null, "PSD with round dots has no halftone resource: the file is as before");
}
// ───────────── Shop and press profiles ─────────────
{
  const P = await import("../src/plan.js");
  const a = P.cleanProfile({ name: " Auto press ", press: "automatic", lpi: 55, angle: 22.5, dpi: 600, gain: 18, minDot: 5, maxDot: 92, dotShape: "ellipse", mesh: { base: 156, color: 305, white: "" }, calib: { n: 1.7, inks: {} } });
  const b = P.cleanProfile({ name: "Manual", press: "manual", lpi: 45, angle: 22.5, dpi: 400, gain: 22, minDot: 6, maxDot: 92, mesh: {}, calib: null });
  const back = P.profilesFromJSON(P.profilesToJSON([a, b]));
  ok(JSON.stringify(back) === JSON.stringify([a, b]) && a.name === "Auto press" && a.mesh.white === null && b.dotShape === "round", "profiles round-trip through the JSON file: every setting, mesh and calibration kept");
  const err = f => { try { f(); return ""; } catch (e) { return e.message; } };
  ok(/not JSON/.test(err(() => P.profilesFromJSON("{"))) && /not a Separation Table profiles file/.test(err(() => P.profilesFromJSON('{"profiles":[]}'))) && /lpi must be a number from 20 to 85/.test(err(() => P.cleanProfile({ ...a, lpi: 300 })))
    && /not a stock mesh/.test(err(() => P.cleanProfile({ ...a, mesh: { color: 231 } }))) && /dot shape/.test(err(() => P.cleanProfile({ ...a, dotShape: "star" }))) && /no name/.test(err(() => P.cleanProfile({ ...a, name: " " }))),
    "a wrong profiles file or value is refused with a plain message");
  { const m = P.cleanProfile({ ...b, mirror: "mirror", setupMin: 12, perHour: 90 });
    ok(a.mirror === "right" && a.setupMin === P.PRESS_TIME.automatic.setupMin && b.perHour === P.PRESS_TIME.manual.perHour && m.mirror === "mirror" && m.setupMin === 12 && m.perHour === 90
      && JSON.stringify(P.profilesFromJSON(P.profilesToJSON([m]))[0]) === JSON.stringify(m) && /mirror must be/.test(err(() => P.cleanProfile({ ...a, mirror: "flip" }))) && /perHour must be/.test(err(() => P.cleanProfile({ ...a, perHour: 0 }))),
      "profiles keep the film mirror and the press time numbers; an older profile gets right reading and its press type's times"); }
  { const z = P.cleanProfile({ ...b, sizes: { platen: { id: "youth" }, screen: { id: "custom", w: 15, h: 18 } } });
    ok(a.sizes === undefined && JSON.stringify(z.sizes) === JSON.stringify({ platen: { id: "youth" }, film: { id: "super-b" }, screen: { id: "custom", w: 15, h: 18 } })
      && JSON.stringify(P.profilesFromJSON(P.profilesToJSON([z]))[0]) === JSON.stringify(z) && /^Profile "Manual": Platen "huge" is not a standard size/.test(err(() => P.cleanProfile({ ...b, sizes: { platen: { id: "huge" } } })))
      && /^Profile "Manual": Custom film sheet: width must be a number from 1 to 40 in/.test(err(() => P.cleanProfile({ ...b, sizes: { film: { id: "custom", w: 99, h: 10 } } }))),
      "profiles keep the platen, film and screen sizes through the file (sizes.js); an older profile has none; a wrong size is refused with the profile's name"); }
  const merged = P.mergeProfiles([a, b], [a, a]);
  ok(merged.map(p => p.name).join("|") === "Auto press|Manual|Auto press (2)|Auto press (3)", "import adds profiles and never overwrites one: a taken name gets a number");
  const pl = P.platesFor([{ name: "Red", lab: [45, 60, 40] }, { name: "White", lab: [96, 0, 1] }], true, { screening: "same", angle: 22.5, lpi: 55, mesh: a.mesh });
  ok(pl.map(p => p.mesh).join() === `156,305,${P.meshFor(55)}` && pl.every(p => Math.abs(p.minDot - P.minDotFor(55, p.mesh)) < 1e-9), `the shop's mesh goes on each screen (base 156, colors 305, white follows LPI: ${pl.map(p => p.mesh)}) and sets its smallest dot`);
  // A screen's own mesh, LPI and angle win over the job's, the shop's and the method's, on that screen only
  { const own = P.platesFor([{ name: "Red", lab: [45, 60, 40], mesh: 230, lpi: 65, angle: 37.5 }, { name: "Blue", lab: [30, 10, -50] }], true, { screening: "rotated", angle: 22.5, lpi: 55, mesh: a.mesh, ub: { angle: 60 } });
    const F = await import("../src/filmimport.js"), set = { channels: [{ name: "Red", file: "02-red" }] }, spec = { screens: [{ name: "Red", file: "02-red", lab: [45, 60, 40], screen_settings: { mesh: 230, lpi: 65 } }] };
    const err2 = f => { try { f(); return ""; } catch (e) { return e.message; } };
    ok(own[1].mesh === 230 && own[1].lpi === 65 && own[1].angle === 37.5 && Math.abs(own[1].minDot - P.minDotFor(65, 230)) < 1e-9 && own[0].angle === 60 && own[2].angle !== 37.5 && own[2].mesh === 305 && !own[2].lpi && !own[2].set
      && F.colorChannels(set, spec, []).channels[0].set.lpi === 65 && /lpi 99 is out of range\. Valid: 20 to 85/.test(err2(() => F.colorChannels({ channels: [{ name: "Red", file: "02-red" }] }, { screens: [{ ...spec.screens[0], screen_settings: { lpi: 99 } }] }, [])))
      && /mesh 231 is not a stock mesh count/.test(err2(() => P.cleanScreenSet({ mesh: 231 }))) && P.cleanScreenSet({ mesh: null }) === null,
      "a screen's own mesh, LPI and angle go on its plate only (and its smallest dot); separation.json brings them back on re-proof; a bad one is refused with the valid values"); }
}
// Speed-ups that must not move a result (2026-11-14): the scorers' shortcuts give the same bits as the plain formulas
{ let s = 11, bad = 0; const rnd = () => (s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296, v = () => { const r = rnd(); return r < 0.1 ? 0 : r < 0.15 ? -0 : rnd() * 260 - 130; };
  for (let i = 0; i < 20000; i++) { const x = v(), y = v(); if (!Object.is(E.hypot2(x, y), Math.hypot(x, y))) bad++; }
  ok(!bad, `hypot2 gives Math.hypot's bits (${bad} of 20000 differ)`);
  const pair = E.pairScorer((c0, c1, c2) => E.mixToLab([c0, c1, c2], 1.7)), plain = (L, A, B, c0, c1, c2) => { const l = E.mixToLab([c0, c1, c2], 1.7); return [E.de2000(L, A, B, ...l), E.deCMC(L, A, B, ...l)]; };
  let same = true; for (let i = 0; i < 3000; i++) { const t = [rnd() * 100, v() / 2, v() / 2], c = [rnd(), rnd(), rnd()], reps = 1 + (i % 3);
    for (let r = 0; r < reps; r++) { const [e, cm] = plain(...t, ...c); if (!Object.is(pair.de(...t, ...c), e) || !Object.is(pair.cmc(), cm)) same = false; } }
  ok(same, "pairScorer: the remembered pair gives the same ΔE00 and ΔE CMC as computing it again");
  const { evaluate, printView, runSeparation } = await import("../src/pipeline.js"), W = 48, H = 40, P = W * H, px = new Uint8ClampedArray(P * 3), alpha = new Uint8Array(P).fill(255);
  for (let p = 0; p < P; p++) { const x = p % W, y = (p / W) | 0; px[p * 3] = (x * 5) & 255; px[p * 3 + 1] = (y * 6) & 255; px[p * 3 + 2] = x > 30 ? 40 : 200; }
  const lab = new Float32Array(P * 3); for (let p = 0; p < P; p++) lab.set(E.rgb2lab(px[p * 3], px[p * 3 + 1], px[p * 3 + 2]), p * 3);
  const { genericLibrary } = await import("../src/inks.js"), m = { px, alpha, lab, W, H, mode: "sim", garmentLab: E.rgb2lab(20, 20, 20), n: 1.7, k: 4, underbase: true, ubStrength: 1, library: genericLibrary(), locked: [], inks: [], forceWhite: true, screening: "am", rhos: [0, 0.5, 1] };
  const r = runSeparation({ ...m, repick: true, paletteMode: "library" }), full = evaluate({ ...m, fadeTails: true }, r.inks, r.cov).stats, pv = printView(m, r.inks, r.cov);
  ok(Object.is(pv.viewMean, full.viewMean) && JSON.stringify(pv.fadeTails) === JSON.stringify(full.fadeTails), `printView reads the same Print view error as evaluate (${pv.viewMean.toFixed(4)})`);
  const trial = evaluate({ ...m, trialScoresOnly: true }, r.inks, r.cov).stats, all = evaluate(m, r.inks, r.cov).stats;
  ok(["mean", "p95", "robustMean", "robustP95", "cmcWithin2"].every(k => Object.is(trial[k], all[k])), "trialScoresOnly keeps the scores a trial is judged by");
  const f1 = E.filteredDE({ img: r.img, W, H, px, alpha, garmentRGB: [20, 20, 20] }), f2 = E.filteredDE({ img: r.img, W, H, px, alpha, garmentRGB: [20, 20, 20] });
  const edited = Uint8ClampedArray.from(px); const fresh = E.filteredDE({ img: r.img, W, H, px: edited.fill(90), alpha, garmentRGB: [20, 20, 20] }); px.fill(90);
  ok(Object.is(f1, f2) && Object.is(E.filteredDE({ img: r.img, W, H, px, alpha, garmentRGB: [20, 20, 20] }), fresh), "filteredDE: the art blur is kept per art, and art edited in place is blurred again"); }
// Pre-print checks (checks.js): each check fires on plain data that breaks its rule and stays quiet on data that does
// not; errors come first; a check about part of the art carries the box of the pixels it marks.
{ const C = await import("../src/checks.js"), W = 20, H = 10, P = W * H;
  const plates = [{ name: "White base", idx: 3, ub: true }, { name: "Red", idx: 0 }, { name: "Blue", idx: 1 }, { name: "Gold", idx: 2 }];
  const cov = new Float32Array(P * 3); for (let q = 0; q < P; q++) { cov[q * 3] = 0.5; cov[q * 3 + 1] = 0.4; } cov[(4 * W + 6) * 3 + 2] = 0.9; // Gold: one pixel at x 6, y 4
  const lab = new Float32Array(P * 3); for (let q = 0; q < P; q++) lab.set(q % W < 5 ? [60, 80, -100] : [50, 0, 0], q * 3); // a blue strip, 5 px wide
  const stackMap = new Uint8Array(P); for (let y = 2; y < 6; y++) for (let x = 10; x < 14; x++) stackMap[y * W + x] = 150; // 300% in a 4 × 4 square
  const job0 = { art: { W: 3300, sample: false, background: null }, widthIn: 11, lpi: 45, press: "automatic", mode: "sim", screening: "same", method: null, screens: 3, inkSource: "art", shelfSize: 24, stackLimit: 2.4, plates,
    preview: { W, H, alpha: new Uint8Array(P).fill(255), lab } };
  const res0 = { covPct: [0.5, 0.4, 0.01], ubPct: 0.6, stats: { stackP99: 2.3 }, gamut: [], cov, stackMap };
  const run = (j = {}, r = {}) => C.preflightChecks({ ...job0, ...j }, { ...res0, ...r, stats: { ...res0.stats, ...(r.stats || {}) } });
  const ids = (j, r) => run(j, r).map(c => c.id);
  ok(ids().length === 0, "checks: a clean job has no checks");
  ok(ids({ art: { W: 1650 } }).includes("low-resolution") && !ids({ art: { W: 2200 } }).includes("low-resolution") && !ids({ art: { W: 100, sample: true } }).includes("low-resolution"), "checks: low resolution fires under 200 ppi, not at 200 or on the sample");
  { const c = run({ art: { W: 1650 } })[0]; ok(c.severity === "warning" && c.measured === "150 ppi at 11 in" && c.limit === "200 ppi" && c.fix.map(f => f.action).join() === "upscale,w:8" && /150 pixels for each inch at 11 in wide/.test(c.detail), `checks: low resolution reads 150 ppi, offers Upscale and Make it 8 in wide (${c.fix.map(f => f.label)})`); }
  { const r = run({}, { covPct: [0.5, 0.4, 0.003] }), c = r.find(c => c.id === "small-screen-2");
    ok(c && c.severity === "note" && /Gold covers only 0.3%/.test(c.detail) && c.region && c.region.mask === "screen:2" && Math.abs(c.region.box.x - 6 / W) < 1e-9 && Math.abs(c.region.box.y - 4 / H) < 1e-9 && Math.abs(c.region.box.w - 1 / W) < 1e-9, "checks: small screen fires under 0.5% with its one pixel as the region");
    ok(!ids({}, { covPct: [0.5, 0.4, 0.005] }).some(i => i.startsWith("small-screen")) && !ids({}, { covPct: [0.5, 0.4, 0] }).some(i => i.startsWith("small-screen")), "checks: small screen quiet at 0.5% and at 0% (an empty screen)"); }
  { const c = run({ art: { W: 3300, background: "#ff0000" } })[0]; ok(c.id === "solid-background" && c.severity === "error" && c.fix[0].action === "bg" && /solid #ff0000 background/.test(c.detail), "checks: solid background is an error with Remove background");
    ok(!ids().includes("solid-background"), "checks: no background, no check"); }
  { const c = run({}, { stats: { stackP99: 2.5 } }).find(c => c.id === "heavy-ink");
    ok(c && c.severity === "warning" && /ink is 250%/.test(c.detail) && c.limit === "240% stack limit" && c.region.mask === "stack" && Math.abs(c.region.box.w - 4 / W) < 1e-9 && Math.abs(c.region.box.h - 4 / H) < 1e-9 && Math.abs(c.region.box.x - 10 / W) < 1e-9, "checks: heavy ink fires over the limit + 5% with the 4 × 4 square as the region");
    ok(!ids({}, { stats: { stackP99: 2.44 } }).includes("heavy-ink") && !ids({ stackLimit: 2.8 }, { stats: { stackP99: 2.5 } }).includes("heavy-ink"), "checks: heavy ink quiet within limit + 5% and under a 280% limit"); }
  { const g = [{ lab: [60, 80, -100], rgb: [120, 0, 255], area: 0.25, de: 31.4, near: { name: "Violet", de: 18.2 } }], c = run({}, { gamut: g }).find(c => c.id === "out-of-gamut");
    ok(c && c.severity === "warning" && /One color in the art is outside what your 24 shelf inks/.test(c.detail) && c.fix.map(f => f.label).join() === "Add a mixed ink" && c.colors[0].hex === "#7800FF" && c.colors[0].region.box.w === 5 / W && c.region.mask === "gamut", "checks: out of gamut names the colour, offers one mixed ink, and marks the 5 px blue strip");
    ok(run({ inkSource: "library" }, { gamut: g }).find(c => c.id === "out-of-gamut").fix.map(f => f.action).join() === "mixes,palArt", "checks: out of gamut on the shelf palette also offers Choose inks from the art");
    ok(run({ screens: 12 }, { gamut: g }).find(c => c.id === "out-of-gamut").fix.length === 0 && /already has 12 screens/.test(run({ screens: 12 }, { gamut: g }).find(c => c.id === "out-of-gamut").detail), "checks: out of gamut at 12 screens offers no mix and says to remove one first");
    ok(!ids({ method: "cmyk" }, { gamut: g }).includes("out-of-gamut") && !ids({}, { gamut: null }).includes("out-of-gamut"), "checks: out of gamut quiet for a fixed method and with no gaps"); }
  ok(ids({ press: "manual", lpi: 65 }).includes("lpi-high-manual") && !ids({ press: "manual", lpi: 55 }).includes("lpi-high-manual") && !ids({ press: "automatic", lpi: 65 }).includes("lpi-high-manual") && !ids({ press: "manual", lpi: 65, screening: "fm" }).includes("lpi-high-manual") && !ids({ press: "manual", lpi: 65, mode: "spot" }).includes("lpi-high-manual"), "checks: LPI too high only for halftones over 55 LPI on a manual press");
  ok(ids({ mode: "index", press: "manual" }).includes("index-manual-press") && run({ mode: "index", press: "manual" }).find(c => c.id === "index-manual-press").severity === "warning" && !ids({ mode: "index" }).includes("index-manual-press"), "checks: index on a manual press is a warning (it prints, with care); automatic is quiet");
  { const six = [...plates, { name: "A", idx: 4 }, { name: "B", idx: 5 }, { name: "C", idx: 6 }]; const r6 = { covPct: [0.5, 0.4, 0.01, 0.1, 0.1, 0.1] };
    ok(ids({ mode: "index" }).includes("index-few-colors") && /With 3 colors/.test(run({ mode: "index" }).find(c => c.id === "index-few-colors").detail) && !ids({ mode: "index", plates: six, preview: null }, r6).includes("index-few-colors"), "checks: few index colors fires under 6 colours (the base not counted), quiet at 6"); }
  ok(ids({ lpi: 25 }).includes("lpi-low") && !ids({ lpi: 30 }).includes("lpi-low") && !ids({ lpi: 25, mode: "spot" }).includes("lpi-low"), "checks: LPI too low under 30 LPI for simulated process only");
  { const r = run({ art: { W: 1650, background: "#ff0000" }, mode: "index", press: "manual" }, { covPct: [0.5, 0.4, 0.003] }).map(c => c.severity);
    ok(r.join() === "error,warning,warning,warning,note", `checks: errors first, then warnings, then notes (${r})`); }
  ok(run({ preview: null }, { covPct: [0.5, 0.4, 0.003], stats: { stackP99: 2.5 } }).every(c => !c.region), "checks: without the preview image the checks carry no regions");
  { const rgba = new Uint8ClampedArray(40 * 40 * 4); for (let q = 0; q < 1600; q++) rgba.set([250, 250, 250, 255], q * 4);
    ok(C.solidBackground(rgba, 40, 40, E.rgb2lab(17, 17, 17)) === "#fafafa" && C.solidBackground(rgba, 40, 40, E.rgb2lab(250, 250, 250)) === null, "checks: a solid white border on a black shirt is a background box; on a white shirt it is not");
    rgba[3] = 0; ok(C.solidBackground(rgba, 40, 40, E.rgb2lab(17, 17, 17)) === null, "checks: a transparent border is no background box");
    const bm = C.regionMask("background:#fafafa", { ...job0, preview: { W: 40, H: 40, alpha: new Uint8Array(1600).fill(255), lab: Float32Array.from({ length: 4800 }, (_, i) => E.rgb2lab(250, 250, 250)[i % 3]) } }, res0);
    ok(bm && bm.every(v => v === 1), "checks: the background region marks the background colour"); } }
// Platen, film and screen sizes (sizes.js): standard sizes and custom ones, checked in plain words
{ const Z = await import("../src/sizes.js"), d = Z.cleanSizes(null);
  ok(d.platen.w === 16 && d.platen.h === 18 && d.film.id === "super-b" && d.screen.w === 14, "sizes: the standard set is a 16 × 18 in platen, 13 × 19 in film and a 20 × 24 in frame that prints 14 × 16 in");
  const c = Z.cleanSizes({ platen: { id: "custom", w: 20, h: 24 } });
  ok(c.platen.w === 20 && c.platen.name === "Custom 20 × 24 in" && c.film.id === "super-b" && JSON.stringify(Z.cleanSizes(Z.sizeSetting(c))) === JSON.stringify(c), "sizes: a custom platen is kept, the other sizes take the standard, and the saved setting reads back the same");
  const err = f => { try { f(); return ""; } catch (e) { return e.message; } };
  ok(/Custom film sheet: width must be a number from 1 to 40 in/.test(err(() => Z.cleanSizes({ film: { id: "custom", w: 0.5, h: 10 } }))) && /Platen "huge" is not a standard size/.test(err(() => Z.cleanSizes({ platen: { id: "huge" } }))), "sizes: a custom size out of range and an unknown size each say what is wrong"); }
// Size, centre, fine line and reverse gap checks (checks.js): measured on the preview, quiet on clean art
{ const C = await import("../src/checks.js"), Z = await import("../src/sizes.js"), sizes = Z.cleanSizes(null), big = Z.cleanSizes({ platen: { id: "custom", w: 40, h: 40 }, film: { id: "custom", w: 40, h: 40 }, screen: { id: "custom", w: 40, h: 40 } });
  const L0 = C.lineLimits({ lpi: 45, mode: "sim", screening: "same", minDot: 0.06, gain: 0.22 });
  ok(L0.mesh === 230 && Math.abs(L0.line - 0.1657) < 1e-3 && Math.abs(L0.spread - 0.0495) < 1e-3 && Math.abs(L0.reverse - 0.2647) < 1e-3, `checks: at 45 LPI the mesh is 230 and holds 0.17 mm lines; 22% gain spreads 0.05 mm, so gaps need 0.26 mm (${L0.line.toFixed(3)}, ${L0.reverse.toFixed(3)})`);
  ok(C.lineLimits({ lpi: 65, mode: "sim" }).mesh === 305 && C.lineLimits({ lpi: 65, mode: "sim" }).line < 0.13, "checks: at 65 LPI the mesh rule (230 + 5 per LPI over 45 = 330, a multiple of 65, so 305) holds thinner lines");
  ok(C.lineLimits({ lpi: 45, mode: "sim", minDot: 0.12 }).byDot && Math.abs(C.lineLimits({ lpi: 45, mode: "sim", minDot: 0.12 }).line - 25.4 / 45 * Math.sqrt(0.48 / Math.PI)) < 1e-9 && !C.lineLimits({ lpi: 45, mode: "spot", minDot: 0.12 }).byDot, "checks: a halftone line must also hold the smallest dot; a solid spot line holds to the mesh only");
  /** A job on a W × H preview with one screen (Red); cov and lab from functions of x, y. */
  const mk = (W, H, j, covF, labF, alphaF = () => 255) => { const P = W * H, cov = new Float32Array(P), lab = new Float32Array(P * 3), alpha = new Uint8Array(P);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const q = y * W + x; cov[q] = covF(x, y); lab.set(labF(x, y), q * 3); alpha[q] = alphaF(x, y); }
    return [{ art: { W: 3300, sample: false, background: null }, widthIn: 1, lpi: 45, press: "automatic", mode: "sim", screening: "same", method: null, screens: 1, inkSource: "art", shelfSize: 24, stackLimit: 2.4, gain: 0.22, minDot: 0.06,
      plates: [{ name: "Red", idx: 0 }], preview: { W, H, alpha, lab }, ...j }, { covPct: [0.2], ubPct: 0, stats: { stackP99: 1 }, gamut: [], cov }]; };
  const ids = ([j, r]) => C.preflightChecks(j, r).map(c => c.id), find = ([j, r], id) => C.preflightChecks(j, r).find(c => c.id === id);
  const WHITE = [95, 0, 0], DARK = [20, 0, 0];
  // too large: a 20 × 10 px preview, 1 px per inch at 20 in wide
  const wide = j => mk(20, 10, { widthIn: 20, ...j }, () => 1, () => DARK);
  { const c = find(wide({ sizes: { ...big, platen: sizes.platen } }), "too-large-platen");
    ok(c && c.severity === "error" && c.measured === "20 × 10 in" && c.limit === "16 × 18 in, Standard 16 × 18 in" && c.fix.map(f => f.action).join() === "w:16,sizes" && c.region.mask === "oversize:platen" && c.region.box.x === 0 && c.region.box.w === 1 && /goes past the edge of the platen/.test(c.detail), "checks: a 20 in print on a 16 × 18 in platen is an error: Make it 16 in wide, Change sizes, and the parts past the platen marked");
    const m = C.regionMask("oversize:platen", wide({ sizes })[0], wide({})[1]); ok(m && m.reduce((a, b) => a + b, 0) === 40, "checks: the platen region marks the 2 in past each side of a centred 16 in platen (4 columns)"); }
  ok(ids(wide({ sizes: { ...big, screen: sizes.screen } })).includes("too-large-screen") && find(wide({ sizes: { ...big, screen: sizes.screen } }), "too-large-screen").fix[0].action === "w:14", "checks: a 20 in print is larger than the 14 × 16 in image area of a 20 × 24 in frame; it fits at 14 in");
  ok(ids(wide({ sizes: { ...big, film: sizes.film } })).includes("too-large-film") && find(wide({ sizes: { ...big, film: sizes.film } }), "too-large-film").measured === "21 × 11 in", "checks: a film is the art plus a 0.5 in margin each side (21 × 11 in), larger than a 13 × 19 in sheet");
  ok(!ids(wide({ widthIn: 17, sizes: { ...big, film: sizes.film } })).includes("too-large-film"), "checks: a 17 × 8.5 in print fits a 13 × 19 in film turned 90° (18 × 9.5 in with margins)");
  ok(!ids(wide({ widthIn: 11, sizes })).some(i => i.startsWith("too-large")) && !ids(wide({ sizes: null })).some(i => i.startsWith("too-large")), "checks: an 11 in print fits the standard sizes; no sizes, no size check");
  { const r = C.preflightChecks(...wide({ sizes, art: { W: 1000 } })).map(c => c.severity); ok(r[0] === "error" && r.includes("warning"), `checks: a size error comes before the low resolution warning (${r})`); }
  // off centre: the design in the left quarter of the art
  const off = (x0, x1) => mk(20, 10, { widthIn: 11 }, () => 1, () => DARK, x => x >= x0 && x <= x1 ? 255 : 0);
  { const c = find(off(0, 4), "off-centre"); ok(c && c.severity === "warning" && c.measured === "4.1 in left" && c.region.mask === "ink" && c.region.box.w === 5 / 20, "checks: a design 4.1 in left of the art's centre is a warning, with the design marked"); }
  ok(!ids(off(8, 11)).includes("off-centre") && !ids(off(9, 11)).includes("off-centre"), "checks: a centred design, and one 0.3 in off centre, are quiet");
  // fine lines: 1 in wide on 100 px, so 0.254 mm for each pixel; the line limit is 0.166 mm (0.65 px)
  const line = (v, j = {}, labF = (x, y) => x === 50 ? DARK : WHITE, y0 = 5, y1 = 25) => mk(100, 30, j, (x, y) => x === 50 && y >= y0 && y <= y1 ? v : 0, labF);
  { const c = find(line(0.6), "fine-line-0");
    ok(c && c.severity === "warning" && c.measured === "lines 0.15 mm wide in Red" && c.limit === "0.17 mm, 230 mesh at 45 LPI" && c.fix[0].action === "w:1.5" && c.region.mask === "thin:0" && c.region.box.x === 0.5 && c.region.box.w === 0.01 && c.help === "ckFineLine", `checks: a 0.15 mm line on 230 mesh is a warning: Make it 1.5 in wide, and the line marked (${c && c.measured})`); }
  ok(!ids(line(1)).includes("fine-line-0") && !ids(line(0.6, { lpi: 65 })).includes("fine-line-0"), "checks: a 0.25 mm line is quiet, and so is the 0.15 mm line on the 305 mesh of 65 LPI");
  ok(!ids(line(0.6, {}, () => WHITE)).includes("fine-line-0") && !ids(line(0.6, {}, (x, y) => [50 + x / 4, 0, 0])).includes("fine-line-0"), "checks: ink that rises and falls where the art has no line (flat art, a smooth gradient) is not a line");
  ok(!ids(line(0.6, {}, undefined, 5, 6)).includes("fine-line-0") && !ids(line(0.6, {}, undefined, 5, 10)).includes("fine-line-0") && !ids(line(0.6, { mode: "index" })).includes("fine-line-0"), "checks: a 2 px speck and a 1.5 mm stub (a soft corner) are not lines; index art (square pixels by design) is not measured");
  // reverse gaps: solid red with one open column
  const gap = (open, j = {}, x0 = 50, x1 = 50) => mk(100, 30, j, x => x >= x0 && x <= x1 ? 1 - open : 1, x => x >= x0 && x <= x1 ? DARK : [55, 60, 40]);
  { const c = find(gap(0.7), "reverse-gap");
    ok(c && c.severity === "warning" && c.measured === "gaps 0.18 mm wide" && c.limit === "0.26 mm, 230 mesh and 22% dot gain" && c.region.mask === "reverse" && c.region.box.x === 0.5 && c.help === "ckReverse" && /spreads about 0.05 mm past each edge/.test(c.detail), `checks: a 0.18 mm gap that 22% dot gain closes is a warning, with the gap marked (${c && c.measured})`); }
  ok(!ids(gap(1, {}, 50, 51)).includes("reverse-gap") && !ids(gap(0.7, { gain: 0 })).includes("reverse-gap"), "checks: a 0.51 mm gap stays open; with no dot gain the 0.18 mm gap stays open");
  ok(!ids(gap(0.7, {}, 0, 0)).includes("reverse-gap"), "checks: an open edge at the side of the art is not a gap (ink on one side only)");
  ok(C.regionKey({ ...line(1)[0], widthIn: 2 }) !== C.regionKey(line(1)[0]), "checks: a marked region is measured again when the print width changes");
  ok(C.newChecks([{ id: "a" }, { id: "b" }], [{ id: "b" }, { id: "c" }]).map(c => c.id).join() === "c", "checks: newChecks lists only the checks a change added");
  // check limits per profile: the shop's limits move each check, the standard ones stay
  { const lo = mk(20, 10, { art: { W: 1000 }, widthIn: 11 }, () => 1, () => DARK);
    ok(ids(lo).includes("low-resolution") && !ids([{ ...lo[0], limits: { minPpi: 80 } }, lo[1]]).includes("low-resolution") && find([{ ...lo[0], limits: { minPpi: 120 } }, lo[1]], "low-resolution").limit === "120 ppi", "checks: a shop's lowest resolution (80 or 120 ppi) replaces the standard 200 ppi");
    ok(ids(off(8, 11)).length === ids([{ ...off(8, 11)[0], limits: {} }, off(8, 11)[1]]).length && ids([{ ...off(9, 11)[0], limits: { offCentreIn: 0.2 } }, off(9, 11)[1]]).includes("off-centre"), "checks: an off centre limit of 0.2 in flags the design 0.3 in off centre"); }
  // base halo: a base choked less than the press drifts shows at its edges
  { const halo = (choke, drift = 0.2, L = DARK) => { const [j, r] = mk(40, 20, { choke, driftMm: drift, press: "manual", widthIn: 11 }, (x, y) => x >= 10 && x < 30 && y >= 5 && y < 15 ? 1 : 0, () => L);
      return [j, { ...r, ub: Float32Array.from(r.cov) }]; };
    const c = find(halo(0.1), "base-halo");
    ok(c && c.severity === "warning" && c.fix[0].action === "choke:0.2" && c.region.mask === "halo" && /up to 0.1 mm of white base/.test(c.detail) && c.help === "ckHalo", "checks: a 0.1 mm choke on a press that drifts 0.2 mm is a base halo warning, fix Choke 0.2 mm");
    ok(!ids(halo(0.2)).includes("base-halo") && !ids(halo(0.1, 0.2, WHITE)).includes("base-halo") && !ids(halo(0.04, 0.05)).includes("base-halo"), "checks: no halo when the choke covers the drift, under white art, or on a tight automatic");
    ok(C.regionMask("halo", ...halo(0.1)).reduce((a, b) => a + b, 0) === 56, "checks: the halo region is the base's outer edge (56 pixels round a 20 × 10 base)"); }
  // detail too small to print: specks with less ink than one dot the mesh holds
  { const sp = (v, widthIn = 0.5) => mk(100, 30, { widthIn }, (x, y) => (x === 20 || x === 50 || x === 80) && y === 15 ? v : 0, () => DARK);
    const c = find(sp(0.6), "small-detail-0");
    ok(c && c.severity === "warning" && /has 3 dots and specks/.test(c.detail) && c.region.mask === "speck:0" && c.help === "ckSpeck", "checks: three 0.13 mm specks at 60% are detail too small for 230 mesh at 45 LPI");
    ok(!ids(sp(0.6, 6)).includes("small-detail-0") && !ids(sp(0.3)).includes("small-detail-0"), "checks: the same specks at a 6 in print, and light ones (a tone, not detail), are quiet"); }
  // thin lines as dots: only with Print thin lines solid off, from the engine's own solid detail test
  { const W = 120, H = 60, P = W * H, px = new Uint8ClampedArray(P * 3).fill(17), alpha = new Uint8Array(P).fill(255), lab = new Float32Array(P * 3), cov = new Float32Array(P);
    for (let y = 10; y < 50; y++) for (let x = 0; x < W; x++) if (x % 20 < 2) { const q = y * W + x; px[q * 3] = 220; px[q * 3 + 1] = 30; px[q * 3 + 2] = 40; cov[q] = 1; }
    const red = E.rgb2lab(220, 30, 40), j = { art: { W: 3300 }, widthIn: 11, lpi: 45, press: "manual", mode: "sim", screening: "same", method: null, stackLimit: 2.4, plates: [{ name: "Red", idx: 0 }], preview: { W, H, alpha, lab, px }, solidDetail: false },
      r = { covPct: [0.1], stats: { stackP99: 1 }, gamut: [], cov, inks: [{ lab: red }] };
    const c = C.preflightChecks(j, r).find(c => c.id === "thin-lines-dots");
    ok(c && c.fix[0].action === "solid:on" && c.region.mask === "dots" && c.help === "ckDotLines", "checks: red line work with Print thin lines solid off is a warning, fix Print thin lines solid");
    ok(!C.preflightChecks({ ...j, solidDetail: true }, r).some(c => c.id === "thin-lines-dots") && !C.preflightChecks({ ...j, mode: "spot" }, r).some(c => c.id === "thin-lines-dots"), "checks: no thin line warning with it on, or for spot screens"); } }
// garment fabrics, built-in press profiles, profile formats and limits, saved settings
{ const P = await import("../src/plan.js"), J = await import("../src/job.js");
  ok(Object.keys(P.FABRICS).join() === "cotton,blend,triblend,poly,heather,fleece" && Object.values(P.FABRICS).every(f => f.src.length && f.src.every(k => P.FABRIC_SOURCES[k])), "fabrics: six fabrics, each line with a named source");
  ok(P.fabricSettings("fleece").choke === 0.35 && !Object.keys(P.fabricSettings("cotton")).length && /320 °F/.test(P.fabricText("cotton")) && /blocker/.test(P.fabricText("poly")), "fabrics: fleece chokes 0.35 mm; cotton keeps the press's; the notes name the cure and base");
  const b = P.builtinProfiles(); ok(b.length === 3 && b.every(p => p.builtin && !p.tested && p.source.length > 40) && b[0].mesh.color === 230 && b[1].lpi === 55, "profiles: three built-in press profiles, each with its source, none press-tested");
  const f = P.cleanProfile({ ...b[0], name: "Mine", builtin: false, formats: { pdf: true, tif: 1 }, limits: { minPpi: 150 } });
  ok(f.formats.pdf && f.formats.tif && !f.formats.psd && f.limits.minPpi === 150 && f.limits.offCentreIn === 0.5 && !f.builtin, "profiles: a profile keeps its film formats and check limits; missing limits are the standard ones");
  let bad = ""; try { P.cleanProfile({ ...f, limits: { minPpi: 5 } }); } catch (e) { bad = e.message; } ok(/minPpi must be a number from 100 to 600/.test(bad), "profiles: a limit out of range is refused in plain words");
  const { s, dropped } = J.cleanSettings({ lpi: 55, fabric: "poly", gain: 900, nope: 1, formats: { psd: false } });
  ok(s.lpi === 55 && s.fabric === "poly" && s.gain === 22 && dropped.join() === "gain" && s.formats.psd === false && s.formats.pdf === true, "settings: a saved job's valid settings come back, an invalid one is the default");
  const { Session } = await import("../src/cli/session.mjs"), se = new Session(); se.set({ fabric: "fleece" }); const se2 = new Session(); se2.set({ fabric: "fleece", choke: 0.25 });
  ok(se.s.choke === 0.35 && se2.s.choke === 0.25, "settings: the CLI's fleece sets a 0.35 mm choke unless --choke is given");
  { const d = { ...J.defaults(), dpi: 200 }, f = J.testFilmBits(d, "gain", [10, 30]), cw = 80, ink = (r, c) => { let n = 0; const y0 = r * (cw + 30), x0 = 222 + c * cw; for (let y = 0; y < cw; y++) for (let x = 0; x < cw - 2; x++) n += f.bits[(y0 + y) * f.w + x0 + x]; return n / (cw * (cw - 2)); };
    ok(f.h === 2 * cw + 30 && /Dot gain 10 \/ 30/.test(f.label) && ink(0, 7) > ink(1, 7) + 0.05 && Math.abs(ink(0, 7) - E.invGain(0.5, 0.1)) < 0.05, `test film: the 10% gain row's 50% patch carries more film than the 30% row (${ink(0, 7).toFixed(2)} vs ${ink(1, 7).toFixed(2)})`);
    let e = ""; try { J.testValues("lpi", "45"); } catch (x) { e = x.message; } ok(/List 2 to 8 values for LPI/.test(e) && J.testValues("angle", "15, 22.5;45").join() === "15,22.5,45", "test film: 2 to 8 values, each in the setting's range"); }
  { const pl = P.platesFor([{ name: "Red", lab: [50, 60, 40] }], false, { screening: "same", angle: 22.5, lpi: 45 }), base = { plates: pl, result: { stats: {}, covPct: [0.1] }, mode: "sim", print: { screening: "same", lpi: 45 }, model: {}, targets: [] };
    const sp = P.specFor({ ...base, garment: { hex: "#111111", lab: [5, 0, 0], fabric: "poly", fabric_notes: P.fabricText("poly") }, profile: { name: b[1].name, changed: true, builtin: true, source: b[1].source } }), plain = P.specFor({ ...base, garment: { hex: "#111111", lab: [5, 0, 0] } });
    ok(sp.garment.fabric === "poly" && /low-bleed/i.test(sp.garment.fabric_notes) && sp.profile.name === "Automatic press, 55 LPI" && sp.profile.changed && sp.profile.built_in && sp.profile.press_tested === false && /UltraSeps/.test(sp.profile.source) && plain.profile === undefined && plain.garment.fabric === undefined,
      "separation.json: the fabric with its notes and the job's profile (built in, its source, not press-tested); none when the job has none"); }
  { const inks = [{ name: "Red", lab: [50, 60, 40] }, { name: "Orange", lab: [65, 40, 60] }, { name: "Blue", lab: [30, 10, -50] }], m = J.mergeInks(inks, 1, 0);
    let e = ""; try { J.mergeInks(inks, 1, 1); } catch (x) { e = x.message; }
    ok(m.map(k => k.name).join() === "Red,Blue" && m[0].locked && !m[1].locked && !inks[0].locked && /are not two screens/.test(e), "merge: Orange into Red keeps Red (locked) and Blue, and leaves the list given alone"); }
  ok(J.limitsOf(J.defaults()).minPpi === 200 && J.checkJob(J.defaults(), { library: [] }, null, null, []).limits.manualMaxLpi === 55, "settings: the check limits go from the settings into the checks"); }
console.log(fails ? `${fails} FAILED` : "all passed"); process.exit(fails ? 1 : 0);
