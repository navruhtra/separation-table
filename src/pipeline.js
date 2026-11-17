// @ts-check
// The separation pipeline as one pure function, shared by the worker (UI) and bench-test.mjs (regression tests).
import * as E from "./engine.js";
import { printRating, screenGain } from "./plan.js";

// Base-aware appearance applies when an underbase is printed on a dark shirt.
// One definition of a dark shirt (also used by the UI's automatic underbase).
export const DARK_L = 55, isDark = lab => lab[0] < DARK_L;
// On a dark shirt with the underbase off, every ink prints straight on the shirt: strength 0 (found by fuzz testing).
export const baseOpt = m => (m.mode === "sim" && isDark(m.garmentLab) && m.baseAware !== false) ? { strength: m.underbase ? (m.ubStrength ?? 1) : 0, op: m.opacity ?? 0.55 } : null;
// Locality for palette choice: halftones stack inks, so sim builds colors from nearby inks; index and spot place inks
// side by side, so any inks may combine (the old low value).
export const selLam = m => m.lamSel ?? ((m.mode ?? "sim") === "sim" ? 0.2 : 0.02); // art-only 0.05/0.1 tested: marginal gain, worse neutral; kept 0.2
/* Highlight white: "on", "off" or "auto" (also true/false). Auto leaves it off. Model scores, black shirts, ADN with the
   art palette: on the real-art set (7 images, 3 print models) white off is better at every screen count from 2 to 10
   (e.g. 4 screens: print model 8.6 -> 7.7 dE, opaque 14.2 -> 12.0; 10 screens: 4.6 -> 4.4, 9.9 -> 9.5); on the kite set
   off wins up to 6 screens and on is 0.1-0.2 dE better at 8. The underbase already prints white where the art is white.
   Revisit after the press calibration: a final opaque white may matter more than these models show. */
export const HW_AUTO_MIN_INKS = Infinity;
export function highlightWhite(m) {
  const v = m.forceWhite;
  if (v === "auto" || v == null) return (m.k ?? 6) >= HW_AUTO_MIN_INKS;
  return v === true || v === "on";
}
/** Spot v2: palette by k-means in OKLab or the old hull, and nearest ink in OKLab or CIELAB, whichever pair reproduces
    the art's colors best. Real-art A/B, 84 cases: better than the old spot on 62 (by >0.5 ΔE on 2+ of 3 print models),
    worse on 1 (borderline); mean ΔE 11.2 -> 9.1 (print model), 11.6 -> 10.2 (translucent), 12.1 -> 10.4 (opaque).
    On by default; m.spotV2 = false (or env SPOTV2=0) gives the old spot. */
/** Spot shelf inks chosen by the spot rule (nearest ink), not the mixing objective. m.spotSubset = false or env SPOTSUB=0: old. */
export const spotSubset = m => m.spotSubset ?? globalThis.process?.env?.SPOTSUB !== "0";
export const spotV2 = m => m.spotV2 ?? globalThis.process?.env?.SPOTV2 !== "0";
export function choosePalette(m, samples) {
  const locked = m.locked.map(i => ({ ...i })), fixed = locked.map(i => i.lab);
  const dark = isDark(m.garmentLab);
  // highlight white is a sim-process tool; spot and index jobs use white only where the art has white
  if (highlightWhite(m) && dark && (m.mode ?? "sim") === "sim" && !fixed.some(l => l[0] > 92)) {
    const white = m.library.find(i => i.lab[0] > 92) || { name: "White", lab: [96, 0, 1.5], source: "generic" };
    locked.push({ ...white, auto: true }); fixed.push(white.lab);
  }
  const k = Math.max(m.k, fixed.length);
  let chosen = [];
  if (m.paletteMode === "library" && m.library.length) {
    // On a dark shirt the shirt is the black: inks that read as the shirt are never worth a screen. Only true near-blacks
    // (ΔE00 < 12): at 18 it also dropped maroon, navy and brown, which dark hair and navy grounds need (portrait 3.95 → 1.79).
    const lib = m.library.filter(i => !fixed.some(f => E.de2000(...f, ...i.lab) < 1) && !(m.shirtBlack !== false && dark && E.de2000(...i.lab, ...m.garmentLab) < (m.shirtTol ?? +(globalThis.process?.env?.SHIRTTOL || 12))));
    let pick;
    // spot v2: shelf inks judged the way spot prints them (nearest ink or shirt), in whichever metric serves the art best
    if (m.mode === "spot" && spotV2(m) && spotSubset(m)) {
      const cand = ["oklab", "lab"].map(metric => { const idx = E.librarySubset(samples, lib, k, fixed, m.garmentLab, m.n, selLam(m), null, { spotMetric: metric });
        return { idx, metric, e: E.spotError(samples, fixed.concat(idx.map(i => lib[i].lab)), m.garmentLab, metric) }; }).sort((x, y) => x.e - y.e)[0];
      pick = cand.idx; m.spotMetric = cand.metric;
    } else pick = E.librarySubset(samples, lib, k, fixed, m.garmentLab, m.n, selLam(m), baseOpt(m));
    chosen = pick.map(i => ({ ...lib[i], locked: false }));
  } else {
    // spot v2: the art's own colors by k-means in OKLab (solid plates); otherwise the mixing hull
    const hull = () => E.hullPalette(samples, k, fixed, m.garmentLab, m.n, selLam(m), baseOpt(m));
    // spot v2: k-means in OKLab wins at 6+ screens; with 2-4 inks the hull's distinct extreme colors can win, so both
    // are built and the one that reproduces the art's colors better (nearest ink or shirt, weighted ΔE00) is kept
    let pal;
    if (m.mode === "spot" && spotV2(m)) {
      const km = E.kmeansPalette(samples, k, fixed), hl = hull(), cand = [];
      for (const [p, nm] of [[km, "kmeans"], [hl, "hull"]]) for (const metric of ["oklab", "lab"]) cand.push({ p, nm, metric, e: E.spotError(samples, fixed.concat(p), m.garmentLab, metric) });
      const best = cand.sort((x, y) => x.e - y.e)[0]; pal = best.p; m.spotMetric = best.metric; m.spotPick = best.nm;
    } else pal = hull();
    chosen = pal.map(lab => {
      let best = null, bd = Infinity; for (const i of m.library) { const d = E.de2000(...lab, ...i.lab); if (d < bd) { bd = d; best = i; } }
      // name after the closest shelf ink; say "mix" when it is not that ink (a light gray is not "White")
      return { name: best ? (bd > 6 ? `${best.name} mix` : best.name) : "Mixed ink", lab, source: "art", nearest: best ? { name: best.name, de: bd } : null, locked: false };
    });
  }
  // sim: make sure small saturated accents (red stripes, green stems, gauge lights) get an ink when one is worth it
  if ((m.mode ?? "sim") === "sim" && m.accents !== false && !globalThis.process?.env?.NOACCENT) chosen = accentRescue(m, samples, fixed, chosen);
  // an ink this light acts as highlight white (printed last, full appearance): never more than one (found by fuzzing)
  const all = locked.map(i => ({ ...i, locked: !i.auto })).concat(chosen);
  let seenWhite = false;
  return all.filter(i => { if (i.lab[0] <= 92) return true; if (seenWhite && !i.locked) return false; seenWhite = true; return true; });
}
/* Accent rescue: for up to three accent groups (see engine findAccents), try the accent's colour in place of each chosen
   ink and keep the swap that serves the accent best, only if the accent's error falls by ≥ 40% and the art as a whole
   (pixel-weighted ΔE00) gets no more than 0.3 worse. The swapped-in ink is named after the nearest shelf ink. */
function accentRescue(m, samples, fixed, chosen, swaps = true) {
  if (!chosen.length || !samples.length) return chosen;
  const base = baseOpt(m), lam = selLam(m), byW = samples.slice().sort((a, b) => b.w - a.w), top = byW.slice(0, 300);
  // colour families (30° hue bins, plus one for near-neutrals) covering ≥ 5% of the art: an accent may not cost any of
  // them more than 2 ΔE00 (the lemons' yellow, a sky's blue, a painting's greens)
  const fam = x => Math.hypot(x.lab[1], x.lab[2]) < 12 ? 12 : Math.floor(((Math.atan2(x.lab[2], x.lab[1]) * 180 / Math.PI + 360) % 360) / 30);
  const famErr = (labs, set) => { const e = E.sampleErrors(labs, m.garmentLab, set, m.n, lam, 45, base, gates), acc = new Map(); let tw = 0;
    set.forEach((x, k) => { const f = fam(x), a = acc.get(f) || [0, 0]; a[0] += x.w * e[k]; a[1] += x.w; acc.set(f, a); tw += x.w; });
    const out = new Map(); for (const [f, [se, w]] of acc) if (w / tw >= 0.05) out.set(f, se / w); return out; };
  const hueOf = l => (Math.atan2(l[2], l[1]) * 180 / Math.PI + 360) % 360;
  let gates = null; // accent hues of the palette under test (fixed inks first), so swaps are judged as they will print
  const setGates = list => { gates = fixed.map(() => null).concat(list.map(i => i.source === "accent" ? hueOf(i.lab) : null)); };
  const pw = (labs, set) => { const e = E.sampleErrors(labs, m.garmentLab, set, m.n, lam, 45, base, gates); let s = 0, w = 0; set.forEach((x, k) => { s += x.w * e[k]; w += x.w; }); return s / Math.max(1, w); };
  let cur = chosen.slice();
  for (let round = 0; swaps && round < 3; round++) {
    setGates(cur); const asm = m.accentSamples || samples, labs = fixed.concat(cur.map(i => i.lab)), err = E.sampleErrors(labs, m.garmentLab, asm, m.n, lam, 45, base, gates);
    // near-twin inks (ΔE00 < 10) waste a screen: one of them may go to the art's worst-missing colour even when that colour
    // is common (lemons' red wallpaper at 3 screens), not only to a rare accent
    const twins = new Set(); for (let i = 0; i < cur.length; i++) for (let j = i + 1; j < cur.length; j++) if (!cur[i].locked && !cur[j].locked && E.de2000(...cur[i].lab, ...cur[j].lab) < 10) { twins.add(i); twins.add(j); }
    let accs = E.findAccents(asm, err), onlyTwins = false;
    // no rare accent: the worst-missing saturated colour may still take a screen (a twin first; otherwise any ink, under
    // the same hue gate and family guard)
    if (!accs.length) { accs = E.findAccents(asm, err, { maxFamily: 1 }); onlyTwins = twins.size > 0; }
    /** @type {any} */ let acc = accs[0];
    // shelf-ink jobs print only real shelf inks: the accent becomes the nearest one, or is skipped if none is close
    if (acc && m.paletteMode === "library" && m.library.length) {
      let nb = null, bd = Infinity; for (const i of m.library) { if (i.lab[0] > 92) continue; const d = E.de2000(...acc.lab, ...i.lab); if (d < bd) { bd = d; nb = i; } }
      acc = nb && bd < 15 ? { ...acc, lab: nb.lab, shelf: nb } : null;
    }
    if (!acc) break;
    const set = top.concat(acc.members.filter(s => !top.includes(s))), all0 = pw(labs, set), acc0 = pw(labs, acc.members);
    setGates(cur); const fam0 = famErr(labs, top);
    let best = null;
    // the darkest ink anchors every shadow, so it is never traded for an accent
    const darkest = cur.reduce((b, i, j) => i.lab[0] < cur[b].lab[0] ? j : b, 0);
    for (let j = 0; j < cur.length; j++) {
      if (cur[j].locked || cur[j].lab[0] > 92 || j === darkest || cur[j].source === "accent" || (onlyTwins && !twins.has(j))) continue; // never trade an earlier accent
      const trial = cur.slice(); trial[j] = { ...cur[j], lab: acc.lab, source: "accent" }; const tl = fixed.concat(trial.map(i => i.lab)); setGates(trial);
      const a1 = pw(tl, acc.members), all1 = pw(tl, set);
      if (a1 > 0.6 * acc0 || all1 > all0 + 0.3) continue;
      const fam1 = famErr(tl, top); let hurt = false; for (const [f, e0] of fam0) if ((fam1.get(f) ?? e0) > e0 + 2) { hurt = true; break; }
      if (hurt) continue;
      if ((!best || all1 + 0.1 * a1 < best.all1 + 0.1 * best.a1)) best = { j, a1, all1 };
    }
    if (!best) break;
    let nb = null, bd = Infinity; for (const i of m.library) { const d = E.de2000(...acc.lab, ...i.lab); if (d < bd) { bd = d; nb = i; } }
    cur[best.j] = acc.shelf ? { ...acc.shelf, source: "accent", locked: false } : { name: nb ? (bd > 6 ? `${nb.name} mix` : nb.name) : "Accent ink", lab: acc.lab, source: "accent", nearest: nb ? { name: nb.name, de: bd } : null, locked: false };
    m.accentLog = (m.accentLog || []).concat([{ lab: acc.lab.map(v => +v.toFixed(1)), area: +acc.area.toFixed(4), before: +acc0.toFixed(2), after: +best.a1.toFixed(2), overall: [+all0.toFixed(2), +best.all1.toFixed(2)] }]);
  }
  m.accentSuggest = accentAddOption(m, samples, fixed, cur, top, pw, famErr, setGates, lam, base);
  return cur;
}
/* An accent that no swap could place without harm may still be worth one more screen. Tests the worst remaining accent
   (rare first, else the worst-missing saturated colour) as an added ink, under the same hue gate and family guard.
   Returns a suggestion { name, lab, area, accentBefore, accentAfter, overallBefore, overallAfter } or null. The
   engine never adds the screen itself: Auto may take it, and a hand-set screen count shows it as a suggestion. */
function accentAddOption(m, samples, fixed, cur, top, pw, famErr, setGates, lam, base) {
  setGates(cur); const asm = m.accentSamples || samples, labs = fixed.concat(cur.map(i => i.lab));
  const err = E.sampleErrors(labs, m.garmentLab, asm, m.n, lam, 45, base, null);
  let accs = E.findAccents(asm, err); if (!accs.length) accs = E.findAccents(asm, err, { maxFamily: 1 });
  /** @type {any} */ let acc = accs[0]; if (!acc) return null;
  if (m.paletteMode === "library" && m.library.length) {
    let nb = null, bd = Infinity; for (const i of m.library) { if (i.lab[0] > 92) continue; const d = E.de2000(...acc.lab, ...i.lab); if (d < bd) { bd = d; nb = i; } }
    if (!nb || bd >= 15) return null; acc = { ...acc, lab: nb.lab, shelf: nb };
  }
  const set = top.concat(acc.members.filter(x => !top.includes(x)));
  setGates(cur); const all0 = pw(labs, set), acc0 = pw(labs, acc.members), fam0 = famErr(labs, top);
  const add = cur.concat([{ lab: acc.lab, source: "accent" }]), al = fixed.concat(add.map(i => i.lab)); setGates(add);
  const a1 = pw(al, acc.members), all1 = pw(al, set), fam1 = famErr(al, top); setGates(cur);
  for (const [f, e0] of fam0) if ((fam1.get(f) ?? e0) > e0 + 2) return null;
  if (a1 > 0.6 * acc0 || all1 > all0) return null;
  let nb = null, bd = Infinity; for (const i of m.library) { const d = E.de2000(...acc.lab, ...i.lab); if (d < bd) { bd = d; nb = i; } }
  const name = acc.shelf ? acc.shelf.name : nb ? (bd > 6 ? `${nb.name} mix` : nb.name) : "Accent ink";
  return { name, lab: acc.lab.map(v => +v.toFixed(1)), area: +acc.area.toFixed(4), accentBefore: +acc0.toFixed(2), accentAfter: +a1.toFixed(2), overallBefore: +all0.toFixed(2), overallAfter: +all1.toFixed(2) };
}
export function orderInks(inks, order) {
  // process inks print in the standard wet-on-wet order Y, M, C, K
  if (order === "process") return inks.slice().sort((a, b) => "YMCK".indexOf(a.process ?? "") - "YMCK".indexOf(b.process ?? ""));
  // light to dark, highlight white last
  // dark to light on dark shirts (Wilflex) tested better under misregistration than light to dark (robust 8.96 → 8.90)
  const darkFirst = (order ?? globalThis.process?.env?.ORDER ?? "dark") === "dark";
  return inks.slice().sort((a, b) => { const wa = a.lab[0] > 92, wb = b.lab[0] > 92; if (wa !== wb) return wa ? 1 : -1; return darkFirst ? a.lab[0] - b.lab[0] : b.lab[0] - a.lab[0]; });
}
function solveCoverage(m, inks) {
  const args = { ...m, inkLabs: inks.map(i => i.lab), hw: m.hw, base: baseOpt(m) };
  // accent inks print only on their own hue (engine accentGatePen)
  const gates = inks.map(i => i.source === "accent" ? (Math.atan2(i.lab[2], i.lab[1]) * 180 / Math.PI + 360) % 360 : null);
  if (gates.some(g => g != null)) args.opts = { ...(args.opts || m.opts || {}), accentGates: gates };
  // halftone films: tell the solver the smallest printable dot so it plans around it (env NOFILMSOLVE=1 to compare)
  // (with scattered small dots every tone prints on average, so the solver needs no film rounding)
  if (m.film && m.film.minDot && !m.film.scatter && m.screening !== "fm" && !globalThis.process?.env?.NOFILMSOLVE) args.opts = { ...(args.opts || m.opts || {}), minDot: m.film.minDot };
  // the press's stack limit, so the solve keeps each colour's ink stack printable (STACKAWARE=0 to compare)
  // interlocked screens: two inks per spot side by side, no hidden ink (so no stack to keep)
  if (m.mode === "sim" && m.overprint === "lock") args.opts = { ...(args.opts || m.opts || {}), ...(globalThis.process?.env?.SOFTPAIR === "0" ? { maxInks: 2 } : { softPair: +(globalThis.process?.env?.SOFTPAIR || 0.15) }) };
  else if (m.mode === "sim" && (m.screening || "am") === "am" && (m.stackLimit ?? STACK_LIMIT) > 0 && m.stackAware !== false && globalThis.process?.env?.STACKAWARE !== "0")
    args.opts = { ...(args.opts || m.opts || {}), stack: { limit: m.stackLimit ?? STACK_LIMIT, overprint: m.overprint || "same", rho: m.rho || 0, rhos: m.rhos || [0, 0.5, 1] } };
  // smooth recipes in the separation you get (two passes); Auto's trials (lite) keep the plain solve, so Auto's choice of
  // inks and screen count is the same as before and only the final recipes are smoothed (SMOOTHP=n to compare)
  if (m.mode === "sim" && !m.lite) { const sp = globalThis.process?.env?.SMOOTHP; args.opts = { ...(args.opts || m.opts || {}), smoothPasses: sp != null ? +sp : 2, smoothMu: 0.05 }; }
  // smooth ink map (engine SMOOTHMAP): the final table is solved jointly, smooth across colours; Auto's trials (lite) keep
  // the plain solve, so Auto's ink choice is not moved by it. Graphic art only (smoothShare >= 0.8, the same test as solid
  // line work): on photos the joint solve cost accuracy (benchmark, 17 photos, Auto: on-press 4.510 -> 4.455, colour
  // 2.532 -> 2.491; 8 photos better, sunflowers-white worse 2.654 -> 2.808; the net gain was kept), while gradients and
  // flat art keep it.
  if (m.mode === "sim" && !m.lite && E.SMOOTHMAP && m.overprint !== "lock" && (!m.px || E.smoothShare(m.px, m.alpha, m.W, m.H) >= 0.8)) { const ev = globalThis.process?.env || {};
    args.opts = { ...(args.opts || m.opts || {}), smoothMap: { mu: +(ev.SMMU || 0.003), kappa: +(ev.SMKAPPA || 0.05), hid: +(ev.SMHID || 0), iters: +(ev.SMITERS || 300) } }; }
  // 8-bit steps break into dots before the lookup (engine DITHER): only once the screens are decided (m.ditherFinal), so
  // the noise cannot tip an ink over the printable share and keep a screen that prints nothing
  if (m.mode === "sim" && m.ditherFinal) args.opts = { ...(args.opts || m.opts || {}), dither: true };
  if (m.mode === "sim") return { cov: E.separateSim(args), spotIdx: null };
  if (m.mode === "spot") { const r = E.separateSpot({ ...args, metric: spotV2(m) ? (m.spotMetric || "oklab") : "lab" }); return { cov: r.cov, spotIdx: r.idx }; }
  // index shades on a dark shirt with base: each based ink also prints bare (INDEXSHADE=0 or m.indexShade = false: off)
  const noBase = m.underbase && isDark(m.garmentLab) && m.indexShade !== false && globalThis.process?.env?.INDEXSHADE !== "0" ? new Uint8Array(m.W * m.H) : null;
  return { cov: E.separateIndex({ ...args, noBase, op: m.opacity ?? 0.55 }), spotIdx: null, noBase };
}
// printable: share of pixels where the ink is at least a holdable dot (min dot), so a faint haze does not count as a screen
const coverageStats = (cov, N, P, minDot = 0.06) => {
  const pct = new Float64Array(N), mx = new Float64Array(N), pr = new Float64Array(N);
  for (let p = 0; p < P; p++) for (let i = 0; i < N; i++) { const v = cov[p * N + i]; pct[i] += v; if (v > mx[i]) mx[i] = v; if (v >= minDot) pr[i]++; }
  return { pct: [...pct].map(v => v / P), max: [...mx], printable: [...pr].map(v => v / P) };
};
/* Printed dot areas for the films. Full overlap compensation is the most accurate but piles hidden ink under later
   dots (stacks of 300–450% measured on the test set). With stackLimit, each spot keeps as much compensation as fits:
   share s in [0, 1] of the hidden ink, largest s with the colour stack ≤ limit. The limit counts the colour screens
   only, not the white base: that is how shops state it (about 210–240% of colour ink). */
export function printedFrom(cov, N, P, mode, screening, overprint, rho = 0, ub = null, stackLimit = 0, ramp = E.HIDDEN_RAMP) {
  if (mode !== "sim" || screening !== "am") return cov;
  const printed = new Float32Array(P * N), v = new Float32Array(N), o = new Float32Array(N);
  for (let p = 0; p < P; p++) {
    for (let i = 0; i < N; i++) v[i] = cov[p * N + i];
    E.visibleToPrinted(v, N, o, overprint, rho, ramp);
    let st = 0, vis = 0; for (let i = 0; i < N; i++) { st += o[i]; vis += v[i]; }
    // E.STACK_FADE (width w): the stack bends into the limit over the last w below it (soft knee, never over the limit)
    const lim = stackLimit > 0 && E.STACK_FADE > 0 ? E.stackKnee(st, stackLimit, E.STACK_FADE) : stackLimit;
    const trim = stackLimit > 0 && st > lim;
    if (trim && E.STACK_FADE > 0 && E.FADE_TONE > 0 && E.fadeTrim(o, v, N, st - lim, E.FADE_TONE) <= 1e-9) { /* within the limit */ }
    else if (trim) { if (E.STACK_FADE > 0 && E.FADE_TONE > 0) { st = 0; for (let i = 0; i < N; i++) st += o[i]; } const s = vis >= lim ? 0 : (lim - vis) / Math.max(1e-6, st - vis); for (let i = 0; i < N; i++) o[i] = v[i] + s * (o[i] - v[i]); }
    // one angle: the largest dot covers the colour (E.FOOTHOLD: "3" near-solid colours, "1" every colour, "0" the old floor)
    const fp = E.FOOTPRINT && ramp > 0 && overprint === "same";
    if (fp && (E.FOOTHOLD === "1" || E.FOOTHOLD === "3")) E.footprintHold(o, v, N, Math.min(1, vis), lim, E.FOOTHOLD === "3" ? E.holdShare(vis) : 1);
    else if (trim && fp) {
      // FOOTHOLD=0, the floor before: the dot that was largest keeps the colour's coverage, by a soft maximum, inside the
      // press's limit: taken from the other films' hidden ink, never below their visible tone; all or nothing
      let top = 0; for (let i = 1; i < N; i++) if (o[i] > o[top]) top = i;
      const before = o.slice(); E.footprintFloor(o, N, Math.min(1, vis));
      let sum = 0, room = 0; for (let i = 0; i < N; i++) { sum += o[i]; if (i !== top) room += o[i] - v[i]; }
      const ex = sum - stackLimit;
      if (ex > 1e-9) { if (room >= ex) { const f = 1 - ex / room; for (let i = 0; i < N; i++) if (i !== top) o[i] = v[i] + (o[i] - v[i]) * f; } else o.set(before); }
    }
    for (let i = 0; i < N; i++) printed[p * N + i] = o[i];
  }
  return printed;
}
/* Score a coverage set: our base-aware proof, plus the neutral yardstick on the films we would print. */
/* What the films can actually print, so the score sees the film settings (step 3), not ideal ink:
   dots under the smallest dot drop out or round up to it and dots over the largest go solid, exactly as the film
   renderer does; and detail finer than one halftone cell (print width and LPI set its size in art pixels) is averaged
   away, modeled as a box blur over one cell. Halftone (AM) only: spot, index and FM print solid pixels. */
export function filmLimited(cov, N, W, H, film) {
  // scattered small dots print every tone under the smallest dot on average: only the blur over a cell is left
  const out = new Float32Array(cov.length), lo = film.scatter ? 0 : film.minDot ?? 0, hi = film.scatter ? 1 : film.maxDot ?? 1;
  for (let j = 0; j < cov.length; j++) { let a = cov[j]; if (a < lo) a = a < lo / 2 ? 0 : lo; if (a > hi) a = 1; out[j] = a; }
  const r = film.lpi && film.widthIn ? Math.floor(W / film.widthIn / film.lpi / 2) : 0;
  return r < 1 ? out : boxBlur(out, N, W, H, r);
}
/** Box blur of radius r over each of N channels (pixel-interleaved), edges clamped. In place on a copy; returns it. */
export function boxBlur(src, N, W, H, r) {
  const out = Float32Array.from(src), tmp = new Float32Array(src.length), k = 2 * r + 1;
  for (let y = 0; y < H; y++) for (let i = 0; i < N; i++) { let s = 0; for (let x = -r; x <= r; x++) s += out[(y * W + Math.min(W - 1, Math.max(0, x))) * N + i];
    for (let x = 0; x < W; x++) { tmp[(y * W + x) * N + i] = s / k; s += out[(y * W + Math.min(W - 1, x + r + 1)) * N + i] - out[(y * W + Math.max(0, x - r)) * N + i]; } }
  for (let x = 0; x < W; x++) for (let i = 0; i < N; i++) { let s = 0; for (let y = -r; y <= r; y++) s += tmp[(Math.min(H - 1, Math.max(0, y)) * W + x) * N + i];
    for (let y = 0; y < H; y++) { out[(y * W + x) * N + i] = s / k; s += tmp[(Math.min(H - 1, y + r + 1) * W + x) * N + i] - tmp[(Math.max(0, y - r) * W + x) * N + i]; } }
  return out;
}
/* Index and FM print each pixel as one solid ink; at viewing distance the eye mixes neighbours. Their scores (rating,
   verdict, differences) compare the blended print, a 5-pixel box (about the σ 1.5 px of the filtered metric the bench
   judges index by). The preview picture stays unblurred. Auto's trials (lite) keep the
   per-pixel score until a bench run shows how the blend changes Auto's choice of art type. */
export const EYE_R = 2;
const eyeBlend = m => !m.lite && (m.mode === "index" || m.screening === "fm") && m.eyeBlend !== false;
/** The films as they print for a coverage: the film limits, the base (trimmed to the ink printed on it) and the printed
    coverage of each screen. ubPlan is the base as planned (before the trim), which the proof shows. */
export function printedFilms(m, inks, cov) {
  const N = inks.length, P = m.W * m.H, inkLabs = inks.map(i => i.lab);
  // The film limits apply where the films apply them: to the printed coverage (each screen's dot), after the hidden ink
  // under later dots is added. Before 2026-11-12 they were applied to the visible coverage first, so a 2% ink showing
  // around a 40% dot counted as dropped while its film printed a 42% dot: the score was optimistic exactly where the
  // print is fragile, and once chose an ink set that banded (sample sunset). The proof sees only the cell blur.
  const filmOn = !!(m.film && m.mode === "sim" && m.screening !== "fm");
  if (filmOn) cov = filmLimited(cov, N, m.W, m.H, { ...m.film, minDot: 0, maxDot: 1 });
  // ubIn: a base read from imported films (re-proof, filmimport.js) is used as it is, never built again from the inks
  const ub = m.ubIn ? Float32Array.from(m.ubIn) : m.underbase && N ? (m.legacyUB ? m.legacyUB(cov, N, P, inkLabs) : E.buildUnderbase(cov, N, P, m.lab, m.ubStrength, { solid: m.mode !== "sim", fade: E.UB_FADE && !m.lite, inkLabs, garmentLab: m.garmentLab, noBase: m.mode === "index" ? m.noBase : null })) : null;
  // Auto's trials (lite) score the films as before the smooth map (step hidden dots), so its ink choice does not move
  let printed = printedFrom(cov, N, P, m.mode, m.screening || "am", m.overprint || "same", m.rho || 0, ub, m.stackLimit ?? STACK_LIMIT, m.lite && globalThis.process?.env?.LITERAMP !== "1" ? 0 : E.HIDDEN_RAMP);
  if (filmOn) printed = filmLimited(printed, N, m.W, m.H, { ...m.film, lpi: 0 });
  // The base sits under ink: the solve and the proof never show it alone. Where the press's stack limit trimmed the
  // hidden ink (or a screen's dot came out smaller than the base under it), the base was wider than every dot on it
  // and showed as a white ring: the pale streak in the sample's sky. The base is trimmed to the ink printed on it (the
  // largest dot with one angle, all the dots together with rotated or interlocked screens), so it never shows alone.
  // The proof shows the plan (the inks as solved, before the stack limit trims them), so it keeps the base as planned;
  // the films, the print-on-press score and the screens use the trimmed base.
  const ubPlan = ub ? Float32Array.from(ub) : null;
  if (ub && m.mode === "sim" && m.trimBase !== false) { const ov = m.overprint || "same";
    for (let p = 0; p < P; p++) { let mx = 0, sum = 0, free = 1; for (let i = 0; i < N; i++) { const a = printed[p * N + i]; if (a > mx) mx = a; sum += a; free *= 1 - a; }
      const union = ov === "lock" || ov === "none" ? Math.min(1, sum) : ov === "rotated" ? 1 - free : mx; if (ub[p] > union) ub[p] = union; } }
  return { cov, ub, ubPlan, printed };
}
/** @param {any} m @param {number[][]} inkLabs @param {Float32Array} cov @param {Float32Array} printed @param {Float32Array | null} ub */
function fadeView(m, inkLabs, cov, printed, ub) {
  const N = inkLabs.length, P = m.W * m.H;
  // fade tails at the stack limit (m.fadeTails, the print-order step): per ink, the share of the art where its tone
  // ends (visible coverage 1-15%) while the films' stack is within 5 points of the limit. With one screen angle the
  // first-printed ink's dot is the outer ring there, so the trim moves tone onto it and its fade ends in an edge
  // printed later, the same ink can fade out.
  let fadeTails = null;
  if (m.fadeTails && m.mode === "sim") { fadeTails = new Array(N).fill(0); let art = 0; const lim = (m.stackLimit ?? STACK_LIMIT) - 0.05;
    for (let p = 0; p < P; p++) { if (m.alpha[p] < 128) continue; art++; let st = 0; for (let i = 0; i < N; i++) st += printed[p * N + i]; if (st < lim) continue;
      for (let i = 0; i < N; i++) { const c = cov[p * N + i]; if (c > 0.01 && c < 0.15) fadeTails[i]++; } }
    fadeTails = fadeTails.map(v => v / Math.max(1, art)); }
  // Print view error (same flag): the app's Print view draws one screen angle, each later dot over the earlier ones, every
  // ink at full strength, and the eye averages the dots as the blurred canvas does (in sRGB). Mean ΔE00 to the art. The
  // on-press score mixes the inks in its print model instead and can miss a band the Print view shows (18 grey ramp,
  // on-press 1.91 -> 1.78, Print view 2.61 -> 2.60 with a red stripe; sky 3.05 -> 2.20, no edge).
  let viewMean = NaN;
  if (m.fadeTails && m.mode === "sim") { const rgb = inkLabs.map(l => E.lab2rgb(l)), g = E.lab2rgb(m.garmentLab), wb = E.lab2rgb(m.whiteLab || [96, 0, 1.5]), v = new Float64Array(N);
    let sum = 0, n = 0; const pair = E.pairScorer(E.rgb2lab);
    for (let p = 0; p < P; p++) { if (m.alpha[p] < 128) continue; let mx = 0;
      for (let k = N - 1; k >= 0; k--) { const a = printed[p * N + k]; v[k] = Math.max(0, a - mx); if (a > mx) mx = a; }
      const u = ub ? Math.max(0, Math.min(1, ub[p]) - mx) : 0, gs = Math.max(0, 1 - mx - u), c = [0, 0, 0];
      for (let ch = 0; ch < 3; ch++) { c[ch] = gs * g[ch] + u * wb[ch]; for (let k = 0; k < N; k++) c[ch] += v[k] * rgb[k][ch]; }
      sum += pair.de(m.lab[p * 3], m.lab[p * 3 + 1], m.lab[p * 3 + 2], c[0], c[1], c[2]); n++; }
    viewMean = n ? sum / n : 0; }
  return { fadeTails, viewMean };
}
/** The print-order step's Print view reading alone (fadeTails and viewMean as evaluate reports them with m.fadeTails),
    without the proofs and scores: Auto's full-size order check reads only this. */
export function printView(m, inks, cov) { const f = printedFilms(m, inks, cov); return fadeView({ ...m, fadeTails: true }, inks.map(i => i.lab), f.cov, f.printed, f.ub); }
export function evaluate(m, inks, cov) {
  const N = inks.length, P = m.W * m.H, inkLabs = inks.map(i => i.lab);
  const f = printedFilms(m, inks, cov), { ub, ubPlan, printed } = f; cov = f.cov;
  const { fadeTails, viewMean } = fadeView(m, inkLabs, cov, printed, ub);
  // dark shirt, no underbase: the proof must show ink on the bare shirt (a zero base), like the solver and robust score
  const ubForProof = ubPlan || (isDark(m.garmentLab) ? new Float32Array(P) : null);
  const blend = eyeBlend(m), bl = (a, n) => a && blend ? boxBlur(a, n, m.W, m.H, EYE_R) : a;
  // m.trialScoresOnly (Auto's full trials, runAutoJob): the same scores, without the per-pixel proof image and error
  // map, the neutral yardstick, the blurred difference and the ink-stack numbers, which a trial never reads
  const scoresOnly = !!m.lite || !!m.trialScoresOnly;
  const pr0 = E.proofWithBase({ cov, ub: ubForProof, N, W: m.W, H: m.H, lab: m.lab, alpha: m.alpha, inkLabs, garmentLab: m.garmentLab, n: m.n, op: m.opacity ?? 0.55, lite: scoresOnly && !m.liteDe });
  const pr = blend ? E.proofWithBase({ cov: bl(cov, N), ub: bl(ubForProof, 1), N, W: m.W, H: m.H, lab: m.lab, alpha: m.alpha, inkLabs, garmentLab: m.garmentLab, n: m.n, op: m.opacity ?? 0.55 }) : pr0;
  // lite (Auto's trials): only the scores a trial is judged by are computed. The neutral yardstick, the blurred
  // difference and the ink-stack numbers are for the screen; a trial never shows them.
  const lite = scoresOnly, neutral = lite ? { mean: NaN, median: NaN, p95: NaN } : E.neutralScore({ printed, ub, N, W: m.W, H: m.H, lab: m.lab, alpha: m.alpha, inkLabs, garmentLab: m.garmentLab, whiteLab: m.whiteLab });
  // interlocked screens: the share of a halftone cell the press's drift misplaces (two edges per cell move)
  const lock = m.overprint === "lock" && m.mode === "sim" && m.screening !== "fm" ? Math.min(1, 2 * (m.driftMm || 0) / (25.4 / ((m.film && m.film.lpi) || 45))) : null;
  const rbase = { ub, N, W: m.W, H: m.H, lab: m.lab, alpha: m.alpha, inkLabs, garmentLab: m.garmentLab, n: m.n, op: m.opacity ?? 0.55, lock };
  let robust;
  const pxmm0 = m.W / ((m.film && m.film.widthIn || 11) * 25.4), d0 = (m.driftMm || 0) * pxmm0;
  if (m.mode === "sim" && m.screening !== "fm" && m.shiftAll && d0 > 0.05) {
    // Auto compares art types on one footing: halftone screens also move as a whole (edges shift), on top of dot overlap
    let sm = 0, s95 = 0; const K = 4, rho = (m.rhos || [0, 0.5, 1])[1] ?? 0.5;
    for (let t = 0; t < K; t++) { const offs = Array.from({ length: N }, (_, i) => { const a = 2.399963 * (i + 1) + t * Math.PI / 2; return [d0 * Math.cos(a), d0 * Math.sin(a)]; });
      const r = E.robustScore({ ...rbase, printed: E.shiftCov(printed, N, m.W, m.H, offs), rhos: [rho] }); sm += r.mean; s95 += r.p95; }
    robust = { mean: sm / K, p95: s95 / K };
  } else if (m.mode === "sim" && m.screening !== "fm") robust = E.robustScore({ ...rbase, printed, rhos: m.rhos || [0, 0.5, 1] });
  else {
    // Solid screens (spot, index, FM): move each screen by the press's typical drift in its own direction, four trials,
    // after trapping (spot), and average. Without drift info (old callers, tests) this is the in-register score.
    const pxmm = m.W / ((m.film && m.film.widthIn || 11) * 25.4), d = (m.driftMm || 0) * pxmm, solid = m.mode === "spot" && m.trapMm ? E.trapSpot(cov, N, m.W, m.H, m.trapMm * pxmm) : cov;
    // blended index pixels lie side by side, never on top of each other: the side-by-side (interlocked, in-register) model
    const rb = blend ? { ...rbase, ub: bl(rbase.ub, 1), lock: 0 } : rbase;
    if (d <= 0.05) robust = E.robustScore({ ...rb, printed: bl(solid, N), rhos: [0] });
    else { let sm = 0, s95 = 0; const K = 4;
      for (let t = 0; t < K; t++) { const offs = Array.from({ length: N }, (_, i) => { const a = 2.399963 * (i + 1) + t * Math.PI / 2; return [d * Math.cos(a), d * Math.sin(a)]; });
        const r = E.robustScore({ ...rb, printed: bl(E.shiftCov(solid, N, m.W, m.H, offs), N), rhos: [0] }); sm += r.mean; s95 += r.p95; }
      robust = { mean: sm / K, p95: s95 / K }; }
  }
  const filtered = m.px && !lite ? E.filteredDE({ img: pr0.img, W: m.W, H: m.H, px: m.px, alpha: m.alpha, garmentRGB: E.lab2rgb(m.garmentLab) }) : NaN;
  // ink stack: total printed colour dot area per spot, base not counted (the way shops state the limit, about 210–240%)
  // stackMap: each sampled spot's stack (× 50, 2% steps) over its run of three pixels, for the heavy-ink check's region
  const stacks = [], stackMap = lite ? null : new Uint8Array(P); if (!lite) for (let p = 0; p < P; p += 3) { if (m.alpha[p] < 128) continue; let s = 0; for (let i = 0; i < N; i++) s += printed[p * N + i]; stacks.push(s); stackMap.fill(Math.min(255, Math.round(s * 50)), p, Math.min(P, p + 3)); }
  stacks.sort((a, b) => a - b); const stackP99 = stacks[Math.floor(stacks.length * 0.99)] || 0, stackMax = stacks[stacks.length - 1] || 0;
  const cs = coverageStats(cov, N, P);
  let ubPct = 0; if (ub) { for (let p = 0; p < P; p++) ubPct += ub[p]; ubPct /= P; }
  return { ub, covPct: cs.pct, covMax: cs.max, ubPct, img: pr0.img, de: pr.de, stackMap,
    stats: { mean: pr.mean, median: pr.median, p95: pr.p95, within3: pr.within3, cmcMean: pr.cmcMean, cmcP95: pr.cmcP95, cmcWithin1: pr.cmcWithin1, cmcWithin2: pr.cmcWithin2, neutralMean: neutral.mean, neutralMedian: neutral.median, neutralP95: neutral.p95, filteredMean: filtered, robustMean: robust.mean, robustP95: robust.p95, stackP99, stackMax, ...(fadeTails && { fadeTails, viewMean }) } };
}
export function labOf(px, P) { const lab = new Float32Array(P * 3); for (let j = 0; j < P; j++) lab.set(E.rgb2lab(px[j * 3], px[j * 3 + 1], px[j * 3 + 2]), j * 3); return lab; }
/* Palette choice scores candidates on a sample of the art's colors, which does not always predict the full separation
   (deeper search on that objective made results worse). So build a few candidates with different locality and judge
   each by an actual separation of a small thumbnail: our model's mean ΔE00 plus a quarter of the neutral yardstick.
   Off by default (m.rerank = true to enable): 2.613 → 2.591 on the 15-image set for 2.2× the time. */
function thumb(m, max = 140) {
  const s = Math.min(1, max / Math.max(m.W, m.H)); if (s >= 1) return m;
  const W = Math.max(1, Math.round(m.W * s)), H = Math.max(1, Math.round(m.H * s)), P = W * H, px = new Uint8ClampedArray(P * 3), alpha = new Uint8Array(P), lab = new Float32Array(P * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const q = Math.min(m.H - 1, (y / s) | 0) * m.W + Math.min(m.W - 1, (x / s) | 0), p = y * W + x;
    px[p * 3] = m.px[q * 3]; px[p * 3 + 1] = m.px[q * 3 + 1]; px[p * 3 + 2] = m.px[q * 3 + 2]; alpha[p] = m.alpha[q]; lab[p * 3] = m.lab[q * 3]; lab[p * 3 + 1] = m.lab[q * 3 + 1]; lab[p * 3 + 2] = m.lab[q * 3 + 2]; }
  return { ...m, px, alpha, lab, W, H };
}
function rerankPalettes(m, samples) {
  const lams = m.rerankLams || [0.05, 0.2, 0.4], t = thumb(m), seen = new Set(), cands = [];
  for (const lamSel of lams) { const inks = orderInks(choosePalette({ ...m, lamSel }, samples)), key = inks.map(i => i.lab.map(v => v.toFixed(1)).join(",")).join("|"); if (!seen.has(key)) { seen.add(key); cands.push(inks); } }
  if (cands.length === 1) return cands[0];
  let best = cands[0], bs = Infinity;
  for (const inks of cands) {
    const cov = E.separateSim({ ...t, inkLabs: inks.map(i => i.lab), base: baseOpt(t), opts: { lutG: 13 } });
    const ev = evaluate({ ...t, px: null }, inks, cov), score = ev.stats.mean + 0.25 * ev.stats.neutralMean;
    if (score < bs) { bs = score; best = inks; }
  }
  return best;
}
/* ───────────── Print methods ─────────────
   A method is a set of engine settings a shop would choose by hand (from published shop practice):
   sim / spot / index: the engines as they are. cmyk: four fixed process inks, rotated-angle (Demichel) overprint and a
   240% ink limit (Coudray: 210-240% for screen printed process). mono / duo / tri: 1-3 inks from the art with
   rotated-angle overprint; mono on a dark shirt is one white halftone with no base. Highlight white stays off (the
   real-art test). Angles per method are set on the films by plan.js methodAngles. */
// ISO 12647-2 process solids on coated stock (the published characterization targets; not a brand's inks), CIELAB
export const PROCESS_INKS = [
  { name: "Process Cyan", lab: [55, -37, -50], process: "C", source: "process" }, { name: "Process Magenta", lab: [48, 74, -3], process: "M", source: "process" },
  { name: "Process Yellow", lab: [89, -5, 93], process: "Y", source: "process" }, { name: "Process Black", lab: [16, 0, 0], process: "K", source: "process" }];
export const CMYK_INK_LIMIT = 2.4, METHODS = ["sim", "spot", "index", "cmyk", "mono", "duo", "tri"];
export function methodSettings(method, m) {
  const dark = isDark(m.garmentLab);
  switch (method) {
    case "cmyk": return { mode: "sim", k: 4, locked: PROCESS_INKS.map(i => ({ ...i, locked: true })), inks: [], repick: true, forceWhite: "off", screening: "am", overprint: "rotated", stackLimit: CMYK_INK_LIMIT, order: "process" };
    case "mono": {
      if (!dark) return { mode: "sim", k: 1, forceWhite: "off", overprint: "rotated" };
      const white = (m.library || []).find(i => i.lab[0] > 92) || { name: "White", lab: [96, 0, 1.5], source: "generic" };
      return { mode: "sim", k: 1, locked: [{ ...white, locked: true }], inks: [], repick: true, underbase: false, forceWhite: "off", overprint: "rotated" };
    }
    case "duo": return { mode: "sim", k: 2, forceWhite: "off", overprint: "rotated" };
    case "tri": return { mode: "sim", k: 3, forceWhite: "off", overprint: "rotated" };
    case "sim": case "spot": case "index": return { mode: method };
    default: return {};
  }
}
/* A separation in two parts. separateCore picks the inks and solves the coverage; finishSeparation scores the result
   for the screen (proof picture, difference map, press and neutral scores, removal costs). The app runs the core alone
   for a separation it may replace a moment later (an added ink: the mix search and the print-order check follow), and
   finishes only the one it keeps. runSeparation is both, as before. */
const DROP_GAIN = 0.05;
export function runSeparation(m) {
  const r = finishSeparation(separateCore(m));
  // inks the engine picks for a set screen count (a shop's press size): an ink the print is better without on the press
  // score (screens moving) is left out. Picked for the plan, more inks printed worse: undergrowth-white 6.11 / 7.16 /
  // 9.01 on press at 4 / 6 / 8 screens (a photo benchmark that is not in this repository, 2026-11-16).
  // a clear gain only (DROP_GAIN, ΔE00 on the small copy): a hair-thin gain there dropped the brown and tan mixes of
  // 13-sky-gradient-black (art inks) and its greys went 1.97 -> 3.65 at full size
  if (!m.repick || (m.mode ?? "sim") !== "sim" || m.lite || m.trialScoresOnly || m.method || r.inks.length < 3) return r;
  const t = thumb(m, m.autoMax || 240), score = inks => runSeparation({ ...t, inks, locked: inks, repick: false, costs: false, dropEmpty: false, opts: { lutG: 13 }, trialScoresOnly: true }).stats.robustMean;
  let inks = r.inks, best = score(inks);
  for (;;) { let pick = null;
    for (let i = 0; i < inks.length; i++) { if (inks[i].locked) continue; const o = inks.filter((_, j) => j !== i), s = score(o); if (s < best - DROP_GAIN && (!pick || s < pick.s)) pick = { o, s }; }
    if (!pick) break; inks = pick.o; best = pick.s; }
  return inks === r.inks ? r : runSeparation({ ...m, inks: inks.map(i => ({ ...i, locked: false })), repick: false });
}
export function separateCore(m) {
  const P = m.W * m.H;
  let inks = m.inks, samples = null;
  if (!m.lab) m = { ...m, lab: labOf(m.px, P) };
  if (m.repick || m.costs) samples = E.imageSamples(m.px, m.alpha, P, m.garmentLab, m.n, { rareFrac: m.rareFrac, garmentTol: isDark(m.garmentLab) ? 10 : 7, toneBoost: m.toneBoost, salience: m.salience }).samples;
  // accents are found among rare colours judged as families (a shaded red spreads over many tiny bins); the palette
  // itself is still chosen from the usual samples, so only a missing accent changes the inks
  if (m.repick && (m.mode ?? "sim") === "sim" && m.accents !== false) m = { ...m, accentSamples: E.imageSamples(m.px, m.alpha, P, m.garmentLab, m.n, { rareFrac: 0.0001, garmentTol: isDark(m.garmentLab) ? 10 : 7, toneBoost: m.toneBoost, salience: m.salience, groupRare: true }).samples };
  if (m.repick) inks = m.mode === "sim" && (m.rerank === true || !!(globalThis.process?.env?.RERANK)) ? rerankPalettes(m, samples) : orderInks(choosePalette(m, samples), m.order);
  // inks chosen elsewhere (Auto's ink search, inks kept from the last run): still say when an accent has no ink and one
  // more screen would print it
  if (!m.repick && (m.mode ?? "sim") === "sim" && m.accents !== false && !m.method && inks && inks.length && m.px) {
    const P2 = m.W * m.H, gt = isDark(m.garmentLab) ? 10 : 7;
    const smp = samples || E.imageSamples(m.px, m.alpha, P2, m.garmentLab, m.n, { rareFrac: m.rareFrac, garmentTol: gt, toneBoost: m.toneBoost, salience: m.salience }).samples;
    m = { ...m, accentSamples: E.imageSamples(m.px, m.alpha, P2, m.garmentLab, m.n, { rareFrac: 0.0001, garmentTol: gt, toneBoost: m.toneBoost, salience: m.salience, groupRare: true }).samples };
    accentRescue(m, smp, [], inks.map(i => ({ ...i, locked: true })), false);
  }
  // screens decided before the solve (no screen can drop or be refilled: Auto's full trials): the one table lookup is
  // the dithered one, instead of a plain lookup that the dither then replaces
  if ((m.mode ?? "sim") === "sim" && !m.lite && E.DITHER && m.dropEmpty === false && !samples) m = { ...m, ditherFinal: true };
  let { cov, spotIdx, noBase } = solveCoverage(m, inks);
  // Drop screens that print nothing (unlocked only), then solve again without them.
  const dropped = [];
  let lostWhite = false, lostColour = false; const droppedInks = [];
  if (m.dropEmpty !== false) {
    for (let pass = 0; pass < 2; pass++) {
      const cs = coverageStats(cov, inks.length, P, m.minDot ?? 0.06);
      const keep = inks.map((k, i) => k.locked || cs.printable[i] >= 0.002);
      if (keep.every(Boolean)) break;
      inks.forEach((k, i) => { if (!keep[i]) { dropped.push(k.name); droppedInks.push(k); if (k.auto) lostWhite = true; else if (k.lab[0] <= 92) lostColour = true; } });
      inks = inks.filter((_, i) => keep[i]);
      ({ cov, spotIdx, noBase } = solveCoverage(m, inks));
    }
  }
  // Refill: the forced highlight white printed nothing and was dropped, so the job is one screen short of k. Give that
  // screen to the next best ink, never more screens than k.
  // REFILLANY: the same when a colour ink (not locked) printed nothing in sim, up to the screens it left
  // REFILLSLOTS (default on; 0 = old): a colour ink that prints nothing once the refill is in is refilled too, one more
  // round (13 sky library: the white's screen went to Lime, then Kelly Green printed nothing and was dropped, so the job
  // printed 4 colours of 5 and no yellow; the yellow end's tail rose 2.02 -> 3.93)
  const sim = (m.mode ?? "sim") === "sim";
  for (let round = 0; round < (refillSlots(m) ? 2 : 1); round++) {
    const go = round === 0 ? lostWhite || (lostColour && sim && refillAny(m)) : lostColour && sim && refillAny(m);
    if (!go || !samples || inks.length >= m.k) break;
    const next = refillInks(m, samples, inks, droppedInks, round === 0 && lostWhite ? 1 : m.k - inks.length);
    if (!(next && next.length <= m.k && next.length > inks.length)) break;
    inks = next; ({ cov, spotIdx, noBase } = takeRefillSolve(m, inks)); lostColour = false;
    const cs = coverageStats(cov, inks.length, P, m.minDot ?? 0.06), keep = inks.map((k, i) => k.locked || cs.printable[i] >= 0.002);
    if (!keep.every(Boolean)) { inks.forEach((k, i) => { if (!keep[i]) { dropped.push(k.name); droppedInks.push(k); if (!k.auto && k.lab[0] <= 92) lostColour = true; } }); inks = inks.filter((_, i) => keep[i]); ({ cov, spotIdx, noBase } = solveCoverage(m, inks)); }
    m = { ...m, refilled: inks.filter(i => i.refill).map(i => i.name) };
  }
  if (sim && !m.lite && E.DITHER && /** @type {any} */ (cov).dithered) { cov = /** @type {any} */ (cov).dithered(); m = { ...m, ditherFinal: true }; }
  // Solid detail (final separation only, so Auto's choices do not move): thin line work and small type in an ink's
  // colour print as that ink at 100% with hard edges instead of breaking into dots (SOLIDDETAIL=0 to compare)
  if ((m.mode ?? "sim") === "sim" && !m.lite && !m.method && m.solidDetail !== false && globalThis.process?.env?.SOLIDDETAIL !== "0" && m.px && inks.length) {
    const cellPx = m.W / ((m.film && m.film.widthIn) || 11) / ((m.film && m.film.lpi) || 45);
    const sd = E.solidDetail({ px: m.px, alpha: m.alpha, W: m.W, H: m.H, inkLabs: inks.map(i => i.lab), cellPx, garment: m.garmentLab ? E.lab2rgb(m.garmentLab) : undefined });
    // smooth map: fades the shape pass took for solid shapes print the map's recipe instead, pulled toward the solid ink
    // continuously in colour space (engine fadeShapes); FADESHAPE=0 to compare
    const fw = E.SMOOTHMAP && sd.shape && globalThis.process?.env?.FADESHAPE !== "0" ? E.fadeShapes(sd, m.lab, m.W, m.H, inks.map(i => i.lab)) : null, fk = fw ? Int16Array.from(sd.snap) : null;
    if (fw) for (let p = 0; p < P; p++) if (fw[p] >= 0) { sd.snap[p] = -1; sd.frac[p] = 0; sd.tint[p] = 0; for (let c = 0; c < 3; c++) sd.px[p * 3 + c] = sd.inPx[p * 3 + c] = m.px[p * 3 + c]; }
    if (fw) sd.geo = E.edgeGeometry(sd.snap, sd.frac, m.W, m.H);
    let n = 0; for (let p = 0; p < P; p++) if (sd.snap[p] >= 0) n++;
    if (fw && !n) for (let p = 0; p < P; p++) if (fw[p] > 0 && fk) { const N = inks.length; for (let i = 0; i < N; i++) cov[p * N + i] = (1 - fw[p]) * cov[p * N + i] + (i === fk[p] ? fw[p] * m.alpha[p] / 255 : 0); }
    if (n) { ({ cov, spotIdx, noBase } = solveCoverage({ ...m, px: sd.px }, inks)); const N = inks.length;
      // a shape in a tint (not exactly an ink's colour) keeps its colour: the recipe solved for that colour inside
      let covIn = null; const tintOpts = { ...(m.opts || {}), maxInks: +(globalThis.process?.env?.TINTINKS ?? 2) || undefined };
      if (globalThis.process?.env?.TINTHUE === "1") covIn = tintRecipes(m, sd, inks, tintOpts, P);
      else for (let p = 0; p < P && !covIn; p++) if (sd.snap[p] >= 0 && sd.tint[p]) covIn = solveCoverage({ ...m, px: sd.inPx, opts: tintOpts }, inks).cov;
      // the shape takes its fraction of each pixel (1 inside, the art's blend on the edge); the rest is the other side's
      // colour, solved from the cleaned art (none where the edge was transparent)
      for (let p = 0; p < P; p++) { const k = sd.snap[p]; if (k < 0) continue; const f = sd.frac[p], opaque = m.alpha[p] >= 250, tn = sd.tint[p] && covIn;
        for (let i = 0; i < N; i++) cov[p * N + i] = (tn ? f * covIn[p * N + i] : i === k ? f : 0) + (opaque && (tn || i !== k) ? (1 - f) * cov[p * N + i] : 0); }
      if (fw && fk) for (let p = 0; p < P; p++) if (fw[p] > 0) for (let i = 0; i < N; i++) cov[p * N + i] = (1 - fw[p]) * cov[p * N + i] + (i === fk[p] ? fw[p] * m.alpha[p] / 255 : 0);
      // the films: 1..N = that ink prints solid in the shape; 255 = a tint shape (hard base, its recipe inside)
      m = { ...m, lineSuggest: lineScreenOption(m, sd.tints, inks, P) };
      m = { ...m, solidMask: { ink: Uint8Array.from(sd.snap, (k, p) => k < 0 ? 0 : sd.tint[p] && covIn ? 255 : k + 1), frac: sd.frac, geo: sd.geo, open: Uint8Array.from(m.alpha, a => a < 250 ? 1 : 0) } }; }
  }
  return { m, inks, cov, spotIdx, noBase, dropped, samples };
}
/** Refill mode (m.refill or env REFILL): "top" adds the search's best next ink to the inks kept (library: greedy
    librarySubset step; art: one more hull vertex), "gain" does the same only when it cuts the sample reconstruction
    error by at least m.refillGain (default 3%), "rerun" chooses the whole palette again for the same k with highlight
    white off; "0" or "off" keeps the short job. Bench 2026-11-13: top robust 2.808 → 2.772, gain 2.795, rerun 2.778,
    thumbnail-judged pick of the three 2.778. Default "top". Returns the new ink list or null. */
export const refillMode = m => m.refill ?? globalThis.process?.env?.REFILL ?? "top";
/** Refill pick (m.refillPick or env REFILLPICK = n ≥ 2): take the search's n best next inks (art: at most REFILLARTN,
    default 12, colours at least REFILLARTGAP ΔE00 apart, default 10) and keep the one whose full-size separation has the
    lowest robust (on-press) score, not the lowest sample error; 0 or 1: the search's top. Default 99 (the whole shelf):
    the sample error ranked the best ink 14th of 16 on the hue wheel (Turquoise 9.54 vs Orange 9.83). Bench 2026-11-13,
    with refill any: robust 2.772 → 2.709, adnMean 2.146 → 2.127, W/L 5/0; top 3: 2.755, top 5: 2.764 (alone).
    Time: one full-size solve per candidate, refill cases only (bench total 54 s → 79 s; 4–12 s per refilled case). */
export const refillPick = m => m.lite ? 0 : +(m.refillPick ?? globalThis.process?.env?.REFILLPICK ?? 99); // Auto's trials (lite): the search's top
/** Refill any (m.refillAny or env REFILLANY=0 for off): refill also when an unlocked colour ink printed nothing (sim). */
/** Refill again when a colour ink prints nothing once the refill is in (m.refillSlots or env REFILLSLOTS=0: old, one round). */
export const refillSlots = m => !!(m.refillSlots ?? (globalThis.process?.env?.REFILLSLOTS !== "0"));
/** Refill tie (m.refillTie or env REFILLTIE, default 0.02; 0 = off): candidates whose on-press score is within this share of
    the best are a tie, and the tie goes to the lowest in-register p95 (13 sky art: Brown mix beat Navy mix by 0.9% on
    the on-press score and lifted the tail 7.63 -> 9.39). */
export const refillTie = m => +(m.refillTie ?? globalThis.process?.env?.REFILLTIE ?? 0.02);
export const refillAny = m => !m.lite && !!(m.refillAny ?? (globalThis.process?.env?.REFILLANY !== "0")); // not in Auto's trials: its choices stay
/** The search's next inks for one more screen beside `inks`, best first: each pick is taken out and the search run
    again (library: the shelf ink; art: the colours near it). Never a white, never an ink just dropped. */
export function refillCandidates(m, samples, inks, excl = [], count = 1) {
  const lib0 = m.paletteMode === "library" && m.library.length, out = []; excl = excl.filter(d => d.lab[0] <= 92);
  let lib = m.library.filter(i => i.lab[0] <= 92 && !excl.some(d => d.name === i.name && E.de2000(...d.lab, ...i.lab) < 1));
  let smp = lib0 ? samples : samples.filter(s => !excl.some(d => E.de2000(...d.lab, ...s.lab) < 5));
  for (let t = 0; t < count; t++) {
    const mm = { ...m, library: lib, locked: inks.map(i => ({ ...i, locked: true })), forceWhite: "off", k: inks.length + 1, accents: false };
    const c = smp.length ? choosePalette(mm, smp).slice(inks.length).find(i => i.lab[0] <= 92) : null;
    if (!c) break; out.push({ ...c, refill: true });
    if (lib0) lib = lib.filter(i => !(i.name === c.name && E.de2000(...c.lab, ...i.lab) < 1)); else smp = smp.filter(s => E.de2000(...c.lab, ...s.lab) >= (m.refillArtGap ?? +(globalThis.process?.env?.REFILLARTGAP || 10)));
  }
  return out;
}
/** Refill screen (m.refillScreen or env REFILLSCREEN = n, default 4; 0 = off): with more than n + 1 candidates, each is
    first scored on a half-size copy of the art and only the search's top and the n best there (under the same
    in-register guard) get the full-size score that picks. The full-size score is the same; only fewer candidates
    reach it. Applies to art of at least REFILLSCREEN_PX pixels (smaller art is cheap to score whole). */
export const refillScreen = m => +(m.refillScreen ?? globalThis.process?.env?.REFILLSCREEN ?? 4);
const REFILLSCREEN_PX = 250000;
function refillShortlist(m, cands, score, gm, gp) {
  const n = refillScreen(m);
  if (!(n > 0) || cands.length <= n + 1 || m.W * m.H < REFILLSCREEN_PX) return cands;
  const half = thumb(m, Math.round(Math.max(m.W, m.H) / 2)); let ref = null;
  const rows = cands.map((c, i) => { const { st } = score(half, c); if (!ref) ref = st;
    if (globalThis.process?.env?.REFILLDBG) console.error(`refill screen ${c.name} robust ${st.robustMean.toFixed(3)} mean ${st.mean.toFixed(3)} p95 ${st.p95.toFixed(3)}`);
    return { c, i, r: st.robustMean, ok: st.mean <= ref.mean + gm && st.p95 <= ref.p95 + gp }; });
  const keep = new Set([0, ...rows.filter(o => o.ok && o.i > 0).sort((a, b) => a.r - b.r).slice(0, n).map(o => o.i)]);
  return cands.filter((_, i) => keep.has(i)); // the search's order: its top stays first, the in-register reference
}
export function refillInks(m, samples, inks, excl = [], slots = 1) {
  const mode = refillMode(m);
  if (!mode || mode === "0" || mode === "off") return null;
  const tag = list => list.map(i => inks.some(j => j.name === i.name && j.lab === i.lab) ? i : { ...i, refill: true });
  if (mode === "rerun") return tag(orderInks(choosePalette({ ...m, forceWhite: "off" }, samples), m.order));
  const pickN = refillPick(m), solved = new Map();
  let next = inks, last = null;
  for (let s = 0; s < slots && next.length < m.k; s++) {
    const lib0 = m.paletteMode === "library" && m.library.length, artN = +(m.refillArtN ?? globalThis.process?.env?.REFILLARTN ?? 12);
    const cands = refillCandidates(m, samples, next, excl, Math.max(1, lib0 ? pickN : Math.min(pickN, artN)));
    if (!cands.length) break;
    let extra = cands[0];
    if (cands.length > 1) { // judge each by its full-size on-press score (lite: same robust score, no screen extras)
      // in-register guard: a pick may not print worse in register than the search's top by more than gm (mean) or gp (p95)
      const gm = +(m.refillGuard ?? globalThis.process?.env?.REFILLGUARD ?? 0.1), gp = +(globalThis.process?.env?.REFILLGUARDP ?? 1);
      let bs = Infinity, ref = null; const ok = [], tie = refillTie(m);
      const score = (mm, c) => { const trial = orderInks(next.concat([c]), m.order), sc = solveCoverage(mm, trial);
        return { sc, st: evaluate({ ...(sc.noBase ? { ...mm, noBase: sc.noBase } : mm), lite: true }, trial, sc.cov).stats }; };
      for (const c of refillShortlist(m, cands, score, gm, gp)) { const { sc, st } = score(m, c), r = st.robustMean;
        if (!ref) ref = st;
        if (globalThis.process?.env?.REFILLDBG) console.error(`refill cand ${c.name} robust ${r.toFixed(3)} mean ${st.mean.toFixed(3)} p95 ${st.p95.toFixed(3)}`);
        if (st.mean <= ref.mean + gm && st.p95 <= ref.p95 + gp) { ok.push({ c, r, p95: st.p95 }); if (r < bs) { bs = r; extra = c; }
          // the solves that can still be the pick (within the tie of the best so far) are kept for the caller, the rest freed
          solved.set(c, { sc, r }); for (const [k, v] of solved) if (v.r > bs * (1 + Math.max(0, tie))) solved.delete(k); } }
      if (tie > 0 && ok.length > 1) { const near = ok.filter(o => o.r <= bs * (1 + tie)).sort((a, b) => a.p95 - b.p95); if (near.length) extra = near[0].c; }
      // the pick's solve goes to the caller (the last slot's is the final ink set's)
      last = solved.get(extra)?.sc ?? null; solved.clear();
    } else last = null;
    next = next.concat([extra]);
  }
  if (next.length === inks.length) return null;
  if (mode === "gain") {
    const set = samples.slice().sort((a, b) => b.wt - a.wt).slice(0, 400), lam = selLam(m), base = baseOpt(m);
    const e0 = E.reconError(inks.map(i => i.lab), m.garmentLab, set, m.n, lam, 45, base), e1 = E.reconError(next.map(i => i.lab), m.garmentLab, set, m.n, lam, 45, base);
    if (e1 > e0 * (1 - (m.refillGain ?? +(globalThis.process?.env?.REFILLGAIN || 0.03)))) return null;
  }
  const out = orderInks(next, m.order);
  // the pick was solved for exactly these inks with this m: separateCore takes that solve instead of solving again
  if (last) refillSolve.set(out, last);
  return out;
}
/** The solve refillInks already made for the ink list it returned (taken once: separateCore may change the coverage). */
const refillSolve = new WeakMap();
const takeRefillSolve = (m, inks) => { const sc = refillSolve.get(inks); refillSolve.delete(inks); return sc || solveCoverage(m, inks); };
/* Line work in a colour no ink matches (more than 6 from its nearest ink, which it prints as) is worth offering one more
   screen in its own colour: the lines then print flat and exact (sample's cream water lines: colour error 17 as White,
   1.4 with a cream screen). Pieces of the same colour (within 4) count together; offered when they cover at least 0.1%
   of the art. The screen count is the printer's choice, so it is offered, not added. */
function lineScreenOption(m, tints, inks, P) {
  if (!tints || !tints.length || inks.length >= 12) return null;
  const groups = [];
  for (const t of tints) { const g = groups.find(g => E.de2000(...g.lab, ...t.lab) < 4); if (g) { g.lab = g.lab.map((v, c) => (v * g.n + t.lab[c] * t.n) / (g.n + t.n)); g.n += t.n; g.gap = Math.max(g.gap, t.gap); } else groups.push({ ...t }); }
  const g = groups.sort((a, b) => b.n - a.n)[0]; if (g.n / P < 0.001) return null;
  let nb = null, bd = Infinity; for (const i of m.library || []) { const d = E.de2000(...g.lab, ...i.lab); if (d < bd) { bd = d; nb = i; } }
  // a pale colour gets its plain name (its nearest shelf ink is usually White, and "White mix" reads as white)
  const [L, a, b] = g.lab, C = Math.hypot(a, b), h = (Math.atan2(b, a) * 180 / Math.PI + 360) % 360;
  const pale = L > 78 && C < 35 ? (C < 6 ? "Off-white" : h >= 40 && h < 110 ? "Cream" : h >= 110 && h < 200 ? "Mint" : h >= 200 && h < 290 ? "Ice blue" : "Blush") : null;
  const name = pale || (nb ? (bd > 6 ? `${nb.name} mix` : nb.name) : "Line color");
  return { name, lab: g.lab.map(v => +v.toFixed(1)), area: +(g.n / P).toFixed(4), asInk: inks[g.k].name, before: +g.gap.toFixed(1) };
}
/* A tint shape's recipe from its own ink and only the inks that move the colour the way the shape's colour lies from
   that ink (within 40° of hue direction in a*b*), so a yellowish cream near White never takes a pinkish ink. Shapes with
   the same allowed inks are solved together. Returns coverage over all inks (null when there is no tint shape). */
function tintRecipes(m, sd, inks, opts, P) {
  const N = inks.length, groups = new Map();
  for (let p = 0; p < P; p++) { if (sd.snap[p] < 0 || !sd.tint[p]) continue; const k = sd.snap[p], c = E.rgb2lab(sd.inPx[p * 3], sd.inPx[p * 3 + 1], sd.inPx[p * 3 + 2]), ik = inks[k].lab;
    const da = c[1] - ik[1], db = c[2] - ik[2], dn = Math.hypot(da, db), ok = [k];
    for (let i = 0; i < N; i++) { if (i === k) continue; const ea = inks[i].lab[1] - ik[1], eb = inks[i].lab[2] - ik[2], en = Math.hypot(ea, eb);
      if (dn > 1 && en > 1 && (da * ea + db * eb) / (dn * en) >= Math.cos(40 * Math.PI / 180)) ok.push(i); }
    const key = ok.join(","); if (!groups.has(key)) groups.set(key, { ok, px: [] }); groups.get(key).px.push(p); }
  if (!groups.size) return null; const covIn = new Float32Array(P * N);
  for (const { ok, px } of groups.values()) { const sub = ok.map(i => inks[i]), M = sub.length, r = solveCoverage({ ...m, px: sd.inPx, opts }, sub).cov;
    for (const p of px) for (let j = 0; j < M; j++) covIn[p * N + ok[j]] = r[p * M + j]; }
  return covIn;
}
export function finishSeparation({ m, inks, cov, spotIdx, noBase = null, dropped, samples }) {
  const ev = evaluate(noBase ? { ...m, noBase } : m, inks, cov);
  const costs = m.costs && samples ? E.removalCosts(inks.map(i => i.lab), m.garmentLab, samples, m.n, baseOpt(m), selLam(m)) : null;
  // the page's separations only (costs = ui): the art's colours the shelf cannot mix, for the pre-print check
  const gamut = m.costs && samples && !m.method && m.library ? gamutGaps(m, samples, inks) : null;
  return { inks, cov, spotIdx, noBase, dropped, costs, gamut, lab: m.lab, accentSuggest: m.accentSuggest || null, lineSuggest: m.lineSuggest || null, solid: m.solidMask || null, ...ev };
}

/* Out of gamut (warn and name the colours): the art's colours that no mix of the shop's inks reaches on this
   garment, whatever the screen count. Each art sample is rebuilt from the whole shelf plus the job's own inks by the
   solver's per-sample unmix (no locality, GAMUT_ITERS), not a separation: at most 0.11 s on the hue wheel's 1,242
   samples. Misses are grouped by colour (within 12 ΔE00) and kept when a group covers GAMUT_AREA of the art.
   Threshold from the 15-image set, generic 24-ink shelf: in-gamut art peaks at 7.2 ΔE00 per sample (02 spot logo; the
   others 6.0 or less) with none of the art at 10 or more; out of reach at 10 or more: 04 hue wheel 47% of the art,
   09 neon 37%, 15 photo 22%, 07 pastels 15% (a lilac bluer than the shelf white; the library run's p95 is 12.9 too). */
export const GAMUT_DE = 10, GAMUT_AREA = 0.005, GAMUT_ITERS = 150;
/** @returns {{ lab: number[], rgb: number[], area: number, de: number, near: { name: string, de: number } | null }[]} worst
 *  colour groups, largest first (at most 4) */
export function gamutGaps(m, samples, inks = []) {
  const shelf = [...(m.library || []), ...inks.filter(i => !(m.library || []).some(l => l.name === i.name))];
  if (!shelf.length || !samples.length) return [];
  const err = E.sampleErrors(shelf.map(i => i.lab), m.garmentLab, samples, m.n, 0, GAMUT_ITERS, baseOpt(m));
  const total = samples.reduce((a, s) => a + s.w, 0), groups = [];
  samples.map((s, k) => ({ s, e: err[k] })).filter(o => o.e >= GAMUT_DE).sort((a, b) => b.s.w - a.s.w).forEach(({ s, e }) => {
    const g = groups.find(g => E.de2000(...g.lab, ...s.lab) < 12);
    if (!g) { groups.push({ lab: s.lab.slice(), w: s.w, e: e * s.w }); return; }
    const t = g.w + s.w; g.lab = g.lab.map((v, i) => (v * g.w + s.lab[i] * s.w) / t); g.e += e * s.w; g.w = t;
  });
  return groups.filter(g => g.w / total >= GAMUT_AREA).sort((a, b) => b.w - a.w).slice(0, 4).map(g => {
    let near = null; for (const i of m.library || []) { const d = E.de2000(...g.lab, ...i.lab); if (!near || d < near.de) near = { name: i.name, de: +d.toFixed(1) }; }
    return { lab: g.lab.map(v => +v.toFixed(2)), rgb: E.lab2rgb(g.lab), area: g.w / total, de: +(g.e / g.w).toFixed(1), near };
  });
}

/* Auto settings. Two steps, the way a separator decides:
   1. Art type from the art itself: cluster its colors; if a handful of flat colors cover nearly all of it, it is flat
      (spot) art and the screen count is that number of colors (the garment-colored one prints nothing). Edge
      anti-aliasing is a thin fringe, so it falls under the coverage cut instead of counting as gradients.
   2. Screen count by search for photo art: separate a small copy at 3–10 inks and keep the best trade-off on the
      press-drift score the verdict uses, robust ΔE00 + SCREEN_COST per screen (an extra screen must buy a visible gain).
   Index stays a user choice: its drift (pixel gaps and overlaps) isn't in the robust score yet, so it would win unfairly. */
/* Ink stack limit: the most colour ink at one spot, the white base not counted. Shops cap colour ink near 210–240%
   (research 2026-11-12, all stated, none measured). The rule here: colours only, 240% default, range 240–280%.
   Counted with the base, the old 280% left only 180% for colours over a full base and the press trim of hidden ink
   showed as rings and seams in fades (the sample's sun glow); 320% with the base (220% of colour) fixed that. */
export const STACK_LIMIT = 2.4, STACK_RANGE = [2.4, 2.8];
export const SCREEN_COST = 0.3, FLAT_COVER = 0.93, FLAT_MAX = 8, SPOT_PREF = 1;
export function flatColors(m, tol = 5) {
  const P = m.W * m.H, step = Math.max(1, Math.floor(P / 40000)), cl = []; let n = 0;
  for (let p = 0; p < P; p += step) {
    if (m.alpha[p] < 128) continue; n++; const L = m.lab[p * 3], a = m.lab[p * 3 + 1], b = m.lab[p * 3 + 2];
    let hit = null; for (const c of cl) { const dl = c.L - L, da = c.a - a, db = c.b - b; if (dl * dl + da * da + db * db < tol * tol) { hit = c; break; } }
    if (hit) hit.n++; else if (cl.length < 96) cl.push({ L, a, b, n: 1 });
  }
  cl.sort((x, y) => y.n - x.n); let acc = 0, K = 0; for (const c of cl) { acc += c.n; K++; if (acc >= FLAT_COVER * n) break; }
  const top = cl.slice(0, K), onGarment = top.filter(c => E.de2000(c.L, c.a, c.b, ...m.garmentLab) < 6).length;
  return { K, inks: K - onGarment, flat: n > 0 && K <= FLAT_MAX && acc >= FLAT_COVER * n, colors: top };
}
/** Region miss: how well every distinct color region of the art prints, whatever its size. Pixels are grouped by color
    (similar groups merged, within 12 ΔE00) and each region's mean ΔE counts with weight √area, so a small sun printed
    blue counts far more than in a plain pixel average. lab/alpha/de are per pixel (de: the proof's ΔE00 map). */
export function regionMiss(lab, alpha, de, P) {
  const g = new Map();
  for (let q = 0; q < P; q++) { if (alpha && alpha[q] < 128) continue; const L = lab[q * 3], a = lab[q * 3 + 1], b = lab[q * 3 + 2], key = Math.floor(L / 8) * 1e6 + (Math.floor(a / 10) + 50) * 1e3 + (Math.floor(b / 10) + 50);
    let o = g.get(key); if (!o) { o = { n: 0, L: 0, a: 0, b: 0, e: 0 }; g.set(key, o); } o.n++; o.L += L; o.a += a; o.b += b; o.e += de[q]; }
  const cl = [];
  for (const o of [...g.values()].sort((x, y) => y.n - x.n)) { const l = [o.L / o.n, o.a / o.n, o.b / o.n], c = cl.find(c => E.de2000(...c.lab, ...l) < 12);
    if (c) { const t = c.n + o.n; c.lab = c.lab.map((v, i) => (v * c.n + l[i] * o.n) / t); c.e += o.e; c.n = t; } else cl.push({ lab: l, n: o.n, e: o.e }); }
  const minN = Math.max(4, P * 0.00005); let sw = 0, se = 0;
  for (const c of cl) if (c.n >= minN) { const w = Math.sqrt(c.n); sw += w; se += w * c.e / c.n; }
  return sw ? se / sw : 0;
}
/** Best print-order place for inks the user added: each one is tried at every position in the order, the separation is
    scored on a small copy (press ΔE00, screens moving), and the lowest score wins; the highlight white stays last.
    keys: names of the added inks. Returns the new order and every position's score. */
export function bestPlacement(m, inks, keys) {
  const t = thumb(m, m.autoMax || 240), score = order => runSeparation({ ...t, inks: order, locked: order, repick: false, costs: false, dropEmpty: false, opts: { lutG: 13 }, trialScoresOnly: true }).stats.robustMean;
  let order = inks.slice(); const tries = [];
  for (const key of keys) {
    const i = order.findIndex(k => k.name === key); if (i < 0) continue; const ink = order[i], rest = order.filter((_, j) => j !== i);
    const lastWhite = rest.length && rest[rest.length - 1].lab[0] > 92 && ink.lab[0] <= 92, top = lastWhite ? rest.length - 1 : rest.length;
    let best = null;
    for (let pos = 0; pos <= top; pos++) { const o = rest.slice(0, pos).concat([ink], rest.slice(pos)), s = score(o); tries.push({ name: ink.name, pos: pos + 1, s: +s.toFixed(3) }); if (!best || s < best.s - 1e-6) best = { o, s }; }
    order = best.o;
  }
  return { inks: order, tries };
}
/** Print order per job: the engine picks it. Auto may change the order when a fade needs it
    and the score improves"). Dark-first stays the start. The start is separated on a 240 px copy with the full film
    model (Auto's lite trials keep the old film model, which misses how the stack trim moves tone between inks); an ink
    whose fade ends where the films' stack is at the limit on at least ORDER_TAIL of the art (evaluate fadeTails) is
    tried at every later place (the highlight white stays last), each scored on press ΔE00 and on the Print view error
    (evaluate viewMean). The best press score is returned when both beat the start by ORDER_GAIN on the copy, else
    best: null; the caller keeps it only if both beat the start by ORDER_GAIN at full size too. */
export const ORDER_GAIN = 0.02, ORDER_TAIL = 0.01, ORDER_SIZE = 240;
/** Orders with ink `i` moved to each later place, before a highlight white. */
export function orderMoves(inks, i) {
  const hl = inks.findIndex(k => k.lab[0] > 92), top = hl < 0 ? inks.length : hl, moves = [];
  for (let to = i + 1; to < top; to++) { const o = inks.slice(), [k] = o.splice(i, 1); o.splice(to, 0, k); moves.push({ name: k.name, after: inks[to].name, inks: o }); }
  return moves;
}
/** @returns {Generator<any[], any, any[]>} */
export function* orderPlan(m, inks, size = ORDER_SIZE) {
  const job = o => ({ size, args: { mode: m.mode ?? "sim", inks: o, locked: o, repick: false, costs: false, dropEmpty: false, accents: false, fadeTails: true, opts: { lutG: 13 } } });
  const [r0] = yield [job(inks)], start = r0.robust, view0 = r0.view, tails = r0.fadeTails || [];
  const fades = inks.map((k, i) => ({ name: k.name, i, tail: tails[i] || 0 })).filter(x => x.tail >= ORDER_TAIL && inks[x.i].lab[0] <= 92);
  const moves = fades.flatMap(x => orderMoves(inks, x.i));
  const out = { start: +start.toFixed(3), view: +view0.toFixed(3), fades: fades.map(x => ({ name: x.name, tail: +x.tail.toFixed(4) })), best: null, tries: [] };
  if (!moves.length) return out;
  const rs = yield moves.map(x => job(x.inks));
  out.tries = moves.map((x, i) => ({ name: x.name, after: x.after, s: +rs[i].robust.toFixed(3), view: +rs[i].view.toFixed(3) }));
  // the press score must improve, and the Print view too (it shows the edge, and bands the press score averages away)
  moves.forEach((x, i) => { const s = rs[i].robust; if (s < start * (1 - ORDER_GAIN) && rs[i].view < view0 * (1 - ORDER_GAIN) && (!out.best || s < out.best.s)) out.best = { ...x, s, view: rs[i].view }; });
  return out;
}
export function pickOrder(m, inks, size = ORDER_SIZE) { return drive(orderPlan(m, inks, size), { m, thumbs: {} }); }
/** Share of neighbour pairs (2 px apart) where the proof `img` (RGBA) jumps more than the art `lab` by over 0.5 ΔE00:
    blends that step where inks hand over (the in-register and on-press scores average them away). */
export function toneSteps(img, lab, alpha, W, H) {
  const pl = new Float32Array(W * H * 3); for (let p = 0; p < W * H; p++) pl.set(E.rgb2lab(img[p * 4], img[p * 4 + 1], img[p * 4 + 2]), p * 3);
  let hit = 0, cnt = 0; const d = (A, p, q) => E.de2000(A[p * 3], A[p * 3 + 1], A[p * 3 + 2], A[q * 3], A[q * 3 + 1], A[q * 3 + 2]);
  for (let y = 0; y < H - 2; y += 2) for (let x = 0; x < W - 2; x += 2) { const p = y * W + x; if (alpha[p] < 128) continue;
    for (const q of [p + 2, p + 2 * W]) { if (alpha[q] < 128) continue; cnt++; if (d(pl, p, q) - d(lab, p, q) > 0.5) hit++; } }
  return cnt ? hit / cnt : 0;
}
/** Mix search: find the ink set with the best print rating (stars, the confidence score) from a pool of the 12 shelf
    inks that best cover the art, leaning to fewer screens. Start from `start` (inks), then repeat the best of: add a
    pool ink, remove one, or swap one for a pool ink, each scored by a real separation of a small copy (press dE00 and
    in-tolerance share -> stars). A move that adds a screen must gain more than SEARCH_GAIN stars (past 9 screens,
    PAST_USUAL_GAIN: plan.screenGain); a move that keeps or cuts screens is taken when it loses no more than that. Locked inks (chosen with Add ink, or locked) always stay.
    Halftone (sim) art with the ink library only. Returns { inks, stars, evals, log }. */
export const SEARCH_GAIN = 0.05;
/* Auto runs many trial separations on small copies of the art. The plans below (searchPlan, autoPlan) are generators:
   they yield batches of independent trials (jobs) and get the results back, so the same logic runs one job after
   another here (searchMix, autoPick) or spread over several workers in the app. A job is { size, args }: separate the
   copy of the art that is `size` pixels on its long side with `args` on top of the job's settings. */
/** Run one trial where the art is. ctx: { m, thumbs: {} } (thumbs are made once per size). */
export function runAutoJob(ctx, job) {
  const t = ctx.thumbs[job.size] || (ctx.thumbs[job.size] = thumb(ctx.m, job.size));
  const r = runSeparation({ ...t, ...job.args, ...(!job.region && { trialScoresOnly: true }) });
  return { inks: r.inks.length, ub: !!r.ub, robust: r.stats.robustMean, ...(r.stats.fadeTails && { fadeTails: r.stats.fadeTails, view: r.stats.viewMean }), mean: r.stats.mean, cmc: r.stats.cmcWithin2, region: job.region ? regionMiss(t.lab, t.alpha, r.de, t.W * t.H) : 0, ...(job.wantInks && { inkList: r.inks }) };
}
/** The copy sizes a plan's jobs use for this art (the app makes these once and gives them to every worker). */
export function autoSizes(m) { const fc = flatColors(m); return [...new Set([m.autoMax || (fc.flat ? 480 : 240), m.autoMax || 240, ...(m.autoSalience === true ? [m.autoMax || 480] : []), 160])]; }
export { thumb as autoThumb };
/** @param {Generator<any[], any, any[]>} gen */
function drive(gen, ctx) { let res = gen.next(); while (!res.done) res = gen.next(res.value.map(j => runAutoJob(ctx, j))); return res.value; }
export function searchMix(m, start, opts = {}) { return drive(searchPlan(m, start, opts), { m, thumbs: {} }); }
/** @returns {Generator<any[], any, any[]>} */
// Tested and not used (28 images): rating only the moves a quick estimate ranks best (4 adds, 8 swaps, 36 trials)
// made Auto 1.3x faster and the engine's own press score slightly better, but the independent yardstick got worse on
// 4 of the 6 images it changed (two by more than 1 dE). Trying 4, 6, 8 screens first and then the neighbours picked
// another count on 1 of 28 (3 more screens) and saves no time once the trials run side by side.
export function* searchPlan(m, start, opts = {}) {
  const size = opts.size || 160, t = thumb(m, size), dark = isDark(m.garmentLab), budget = opts.budget || 70, onStep = opts.onStep, sample = E.imageSamples(t.px, t.alpha, t.W * t.H, m.garmentLab, m.n, { rareFrac: 0.0002, garmentTol: dark ? 10 : 7, salience: 0.5 }).samples;
  const key = i => i.name, locked = (m.locked || []).map(i => ({ ...i })), white = dark && m.forceWhite !== false && m.forceWhite !== "off" ? m.library.find(i => i.lab[0] > 92) : null; // the search may use white unless it is off
  // pool: the 12 shelf inks nearest to the most art (each sample counts sqrt(pixels), so small distinct colors count)
  const lib = m.library.filter(i => i.lab[0] <= 92 && !(dark && E.de2000(...i.lab, ...m.garmentLab) < 12) && !locked.some(l => key(l) === key(i)));
  const vote = new Map(); for (const smp of sample) { let b = null, bd = Infinity; for (const i of lib) { const d = E.de2000(...i.lab, ...smp.lab); if (d < bd) { bd = d; b = i; } } if (b) vote.set(key(b), (vote.get(key(b)) || 0) + smp.wt); }
  const pool = lib.slice().sort((a, b) => (vote.get(key(b)) || 0) - (vote.get(key(a)) || 0)).slice(0, 12);
  for (const i of start) if (!i.locked && i.lab[0] <= 92 && !pool.some(p => key(p) === key(i))) { const li = m.library.find(l => key(l) === key(i)); if (li) pool.push(li); }
  const cache = new Map(); let evals = 0; const log = [], setKey = set => set.map(key).sort().join("|");
  const inksOf = set => orderInks(locked.concat(set.filter(i => !locked.some(l => key(l) === key(i)))).concat(white && !locked.some(l => l.lab[0] > 92) ? [white] : []));
  // accents: false: with fixed inks the accent step only writes the add-a-screen note, which a trial never shows
  const job = inks => ({ size, args: { mode: m.mode, smooth: m.smooth, underbase: m.underbase, inks, locked: [], repick: false, costs: false, lite: true, dropEmpty: false, accents: false, opts: { lutG: 13 } } });
  const value = (inks, r) => {
    // the rating's stars, continued past its ends (it is flat at 1 above 10 dE and at 5 below 1 dE) so a worse print always
    // scores lower: without this, mixes at the floor all tie and the search cut screens on the hue wheel (press 12 -> 36)
    const R = printRating({ onPress: r.robust, aligned: r.mean, inTol: r.cmc }), d = r.robust;
    const base = d > 10 ? 1 - (d - 10) * 0.125 : d < 1 ? 5 + (1 - d) * 0.2 : R.base; return { stars: base + R.tol, screens: inks.length + (r.ub ? 1 : 0), inks, press: d }; };
  /** Score ink sets, in order, while the budget lasts: new sets go out as one batch of jobs. Returns the sets it scored. */
  const scoreMany = function* (sets) {
    const todo = [], used = []; let n = evals;
    for (const set of sets) { if (n >= budget) break; const k = setKey(set); if (!cache.has(k) && !todo.some(x => x.k === k)) { todo.push({ k, inks: inksOf(set) }); n++; } used.push(set); }
    if (todo.length) { const rs = yield todo.map(x => job(x.inks)); todo.forEach((x, i) => cache.set(x.k, value(x.inks, rs[i]))); evals = n; if (onStep) onStep(Math.min(1, evals / budget)); }
    return used.map(set => ({ mv: set, v: cache.get(setKey(set)) }));
  };
  let cur = start.filter(i => !i.locked && i.lab[0] <= 92).map(i => m.library.find(l => key(l) === key(i)) || i);
  // the start mix is always scored, as before (the budget only limits the moves)
  { const k = setKey(cur), inks = inksOf(cur), [r] = yield [job(inks)]; cache.set(k, value(inks, r)); evals++; if (onStep) onStep(Math.min(1, evals / budget)); }
  let best = cache.get(setKey(cur)); const first = best;
  // a screen past the usual 9 must gain more (plan.screenGain): Auto stays uncapped, but leans to 9
  const better = (a, b) => a.screens > b.screens ? a.stars > b.stars + screenGain(b.screens, a.screens, SEARCH_GAIN) : a.screens < b.screens ? a.stars >= b.stars - screenGain(a.screens, b.screens, SEARCH_GAIN) : a.stars > b.stars + 1e-6;
  for (let round = 0; round < 12 && evals < budget; round++) {
    const moves = [], out = pool.filter(p => !cur.some(c => key(c) === key(p)));
    for (const o of out) moves.push(cur.concat([o]));
    if (cur.length > 1) for (let i = 0; i < cur.length; i++) moves.push(cur.filter((_, j) => j !== i));
    for (let i = 0; i < cur.length; i++) for (const o of out) moves.push(cur.map((c, j) => j === i ? o : c));
    let pick = null; for (const x of yield* scoreMany(moves)) if (better(x.v, pick ? pick.v : best)) pick = x;
    if (!pick) break; cur = pick.mv; best = pick.v; log.push({ round, stars: +best.stars.toFixed(2), screens: best.screens, inks: best.inks.map(key) });
  }
  // the best mix the search scored at each screen count (no extra trials): what fewer or more screens would rate
  const byScreens = {}; for (const v of cache.values()) { const o = byScreens[v.screens]; if (!o || v.stars > o.stars + 1e-9) byScreens[v.screens] = v; }
  return { inks: best.inks, stars: best.stars, screens: best.screens, press: best.press, startStars: first.stars, startScreens: first.screens, evals, log, pool: pool.map(key), byScreens };
}
export function autoPick(m, onStep) { return drive(autoPlan(m, onStep), { m, thumbs: {} }); }
/** @returns {Generator<any[], any, any[]>} */
export function* autoPlan(m, onStep) {
  const fc = flatColors(m), dark = isDark(m.garmentLab), rows = [];
  // Flat art is judged on a bigger copy: on a small one, thin lines and small type blur into blends that only halftones can match.
  const size = m.autoMax || (fc.flat ? 480 : 240), ub = m.underbase ?? dark, artInks = mode => (mode === "spot" || mode === "index") && { paletteMode: "art" };
  // λ: how much the region miss counts in Auto's score (0 = pixel average only); sal: also try salience-weighted inks
  const lam = m.autoRegion ?? +(globalThis.process?.env?.AUTO_REGION ?? 0), salCand = m.autoSalCand ?? !!(globalThis.process?.env?.AUTO_SAL);
  const trial = (mode, k, sal) => ({ size, region: !!lam, args: { mode, k, salience: sal, repick: true, shiftAll: true, ...artInks(mode), costs: false, lite: true, liteDe: !!lam, locked: [], inks: [], underbase: ub, opts: { lutG: 13 } } });
  const toRow = (mode, k, sal, r) => { const screens = r.inks + (r.ub ? 1 : 0), robust = r.robust, region = lam ? r.region : 0;
    return { mode, k, sal, inks: r.inks, screens, robust: +robust.toFixed(2), mean: +r.mean.toFixed(2), stars: +printRating({ onPress: r.robust, aligned: r.mean, inTol: r.cmc }).stars.toFixed(2), region: +region.toFixed(2), score: +((1 - lam) * robust + lam * region + SCREEN_COST * screens).toFixed(3) }; };
  // Flat-looking art: try spot at its color count and one or two more (small colors such as white type fall under the
  // coverage cut), and a few halftone counts as a check. Spot wins if within SPOT_PREF of the best halftone score:
  // solid screens are cleaner and easier to print. Photo art: halftone counts 3 to 10 only.
  // A print method chosen by the user (m.autoMethod: sim, spot or index) is kept: Auto only tunes the settings inside it.
  // Without one (new art, nothing picked yet), Auto suggests the method as below.
  const only = m.autoMethod, spotKs = fc.flat ? [fc.inks, fc.inks + 1, fc.inks + 2].map(k => Math.max(1, k)) : [2, 3, 4, 5, 6, 7, 8];
  /** @type {[string, number[]][]} */ const plan = only === "sim" ? [["sim", [3, 4, 5, 6, 7, 8, 9, 10]]] : only === "spot" ? [["spot", spotKs]]
    : only === "index" ? [["index", [4, 5, 6, 7, 8, 9, 10]]]
    : fc.flat ? [["spot", spotKs], ["sim", [3, 4, 5, 6]]] : [["sim", [3, 4, 5, 6, 7, 8, 9, 10]]];
  // every screen count is an independent trial: one batch
  { const list = []; for (const [mode, ks] of plan) for (const k of [...new Set(ks)]) { list.push([mode, k, 1]); if (salCand) list.push([mode, k, 0.5]); }
    const rs = yield list.map(([mode, k, sal]) => trial(mode, k, sal)); list.forEach(([mode, k, sal], i) => rows.push(toRow(mode, k, sal, rs[i]))); if (onStep) onStep(1); }
  const pick = rs => rs.reduce((b, r) => r.score < b.score - 1e-9 || (Math.abs(r.score - b.score) < 1e-9 && r.screens < b.screens) ? r : b);
  const sims = rows.filter(r => r.mode === "sim"), spots = rows.filter(r => r.mode === "spot"), sim = sims.length ? pick(sims) : null, spot = spots.length ? pick(spots) : null;
  const pickd = only ? pick(rows) : spot && spot.score <= sim.score + SPOT_PREF ? spot : sim;
  // Spot and Index inks are mixed to match the art (as shops do for logos); halftone inks come from the shelf library as set.
  // Index with art inks, 17 test images × 3/6/9 screens (51 jobs): mean ΔE00 16.5 → 13.0 against shelf inks, better on 35.
  // apply the screens it really used (empty screens are dropped), not the count it was asked for
  // Halftone art: also pick the tonal smoothness for this image (0.05 / 0.1 / 0.25), judged on the same small copy; 0.1
  // stays unless another is clearly better there. Full-size result on the 10 photo images: robust 4.88 → 4.66 ΔE (−4.5%),
  // neutral 7.74 → 7.37; worse on 1 of 10 (portrait, +0.13). Ceiling if always right: 4.63.
  let smooth = null, smoothTries = null;
  if (pickd.mode === "sim" && m.autoSmooth !== false) {
    const sms = [0.1, 0.05, 0.25], rs = yield sms.map(sm => ({ size: m.autoMax || 240, args: { mode: "sim", k: pickd.k, smooth: sm, salience: pickd.sal ?? 1, repick: true, shiftAll: true, costs: false, lite: true, locked: [], inks: [], underbase: ub, opts: { lutG: 13 } } }));
    const tries = sms.map((sm, i) => ({ sm, s: rs[i].robust }));
    smooth = tries.reduce((a, b) => b.s < a.s - 0.02 ? b : a).sm; smoothTries = tries.map(t => ({ sm: t.sm, s: +t.s.toFixed(2) }));
  }
  // Color weighting: inks are chosen by pixel area (1) or by salience (0.5: pixels^0.5), which lets a small, distinct color
  // (a sun, a logo dot) win a screen. Auto tries both at the chosen screen count and keeps salience only if clearly better.
  // 15-image set, per image: press ΔE 3.688 → 3.565 (−3.3%), neutral 5.357 → 5.283; salience on for all hurt skin (4.30 → 6.41).
  let salience = pickd.sal ?? 1, salienceTries = null;
  if (m.autoSalience === true) { // off by default: the per-image gain above is an oracle estimate, not yet measured through Auto
    const one = sal => ({ size: m.autoMax || (pickd.mode === "spot" ? 480 : 240), args: { mode: pickd.mode, k: pickd.k, ...(smooth != null && { smooth }), salience: sal, repick: true, shiftAll: true, ...artInks(pickd.mode), costs: false, lite: true, locked: [], inks: [], underbase: ub, opts: { lutG: 13 } } });
    const [r1, r5] = yield [one(1), one(0.5)], s1 = r1.robust, s5 = r5.robust; salienceTries = [{ sal: 1, s: +s1.toFixed(2) }, { sal: 0.5, s: +s5.toFixed(2) }]; if (s5 < s1 - 0.02) salience = 0.5;
  }
  // Mix search (halftone art, shelf inks): from Auto's pick, test add / remove / swap moves over the 12 best-covering shelf
  // inks and keep the best print rating, leaning to fewer screens. 10 photo images + kite: stars 2.98 → 3.11, press dE
  // 3.97 → 3.58, neutral 6.87 → 6.33, screens 6.0 → 6.4; no image worse beyond 0.02 stars (that one saves a screen).
  let inks = null, search = null;
  if (pickd.mode === "sim" && m.paletteMode !== "art" && m.autoSearch !== false && m.library && m.library.length) {
    const [st0] = yield [{ size: 160, wantInks: true, args: { mode: "sim", k: pickd.k, smooth: smooth ?? m.smooth, salience, repick: true, costs: false, lite: true, locked: [], inks: [], underbase: ub, opts: { lutG: 13 } } }];
    search = yield* searchPlan({ ...m, mode: "sim", smooth: smooth ?? m.smooth, locked: [], underbase: ub }, st0.inkList, { onStep: f => onStep && onStep(-f) }); inks = search.inks;
  }
  const best = { ...pickd, k: Math.max(1, inks ? inks.length : pickd.inks), palette: pickd.mode === "spot" || pickd.mode === "index" ? "art" : m.paletteMode, smooth, smoothTries, salience, salienceTries, inks, search: search && { stars: +search.stars.toFixed(2), startStars: +search.startStars.toFixed(2), screens: search.screens, startScreens: search.startScreens, evals: search.evals, pool: search.pool }, byScreens: search && Object.fromEntries(Object.entries(search.byScreens).map(([n, v]) => [n, { stars: +v.stars.toFixed(2), press: +v.press.toFixed(2), inks: v.inks }])) };
  return { best, rows, flat: fc };
}
