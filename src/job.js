// @ts-check
// A job as plain data: the settings, the separation model they give, the film plan, the film rendering and the job ZIP.
// One source for the page (app.js reads its controls into these settings), the worker, the sep CLI and the MCP server,
// so each makes the same separation and the same files from the same settings. No DOM here: the few steps that draw
// (film margins, PNG encoding) come in as a platform object.
import { rgb2lab, lab2rgb, hex2rgb, rgb2hex, de2000, trapSpot, adaptiveChoke, softChoke, UB_FADE, renderPlate, fmIndexAt, indexToCov, DOT_SHAPES, shapeDot, dotOn, screenAxes } from "./engine.js";
import { printedFrom, methodSettings, STACK_RANGE, STACK_LIMIT } from "./pipeline.js";
import { platesFor, filmLabel, plateSlug, specFor, PRESS, mixRows, nearestStock, meshFor, minDotFor, pressTime, pressTimeText, FABRICS, FABRIC_KEYS, fabricText, fabricSettings, CHECK_LIMITS, cleanProfile, profilesFromJSON, cleanScreenSet } from "./plan.js";
export { FABRICS, fabricSettings, fabricText };
import { solidBackground, parseLimits, CHECK_LIMITS as LIMIT_NAMES } from "./checks.js";
import { cleanSizes } from "./sizes.js";
import { PRESETS } from "./inks.js";
import { cleanSpotSync } from "./cvtools.js";
import { deltaECMC as cjCMC, Lab as cjLab } from "./vendor/color-fn.js";
import * as out from "./output.js";
import { mirrorX } from "./output.js";

/** Brand catalogs used for "nearest stock ink" hints on the mix sheet. */
export const STOCK_CATALOGS = [{ system: "Rio", inks: PRESETS.wilflexRio.inks() }, { system: "FN", inks: PRESETS.fnInk.inks() }];
export const MODE_NAME = { sim: "Simulated process", spot: "Spot colors", index: "Index" };
export const METHOD_NAME = { ...MODE_NAME, cmyk: "CMYK", mono: "Grayscale", duo: "Duotone", tri: "Tritone" };
/** Largest art side the page separates for export, and for its preview. */
export const WORK_MAX = 2400, PREV_MAX = 900;

/**
 * Every setting, with its default (the page's control default), its valid values or range, and one line of help.
 * Numbers are in the units the page shows (percent for gain, dots and stack limit; inches; millimetres).
 * @type {Record<string, { def: any, values?: any[], range?: [number, number], help: string }>}
 */
export const SETTINGS = {
  method: { def: "sim", values: ["sim", "spot", "index", "cmyk", "mono", "duo", "tri"], help: "print method: simulated process, spot, index, CMYK, 1-3 colors (mono = grayscale, duo = duotone, tri = tritone)" },
  garment: { def: "#111111", help: "shirt color, #rrggbb or a shirt chip name (black, white, navy, charcoal, maroon, sand, royal, red, forest, heather)" },
  screens: { def: 6, range: [1, 12], help: "color screens (the underbase is extra); 0 or auto = Auto picks the count" },
  widthIn: { def: 11, range: [1, 30], help: "print width, inches" },
  dpi: { def: 400, range: [150, 1440], help: "film resolution" },
  lpi: { def: 45, range: [20, 85], help: "halftone lines per inch" },
  angle: { def: 22.5, range: [0, 90], help: "halftone angle, degrees" },
  dot: { def: "round", values: [...DOT_SHAPES], help: "halftone dot shape" },
  screening: { def: "same", values: ["same", "lock", "rotated", "fm"], help: "AM one angle, AM interlocked, AM rotated angles, or index (FM square pixels)" },
  press: { def: "manual", values: ["manual", "automatic"], help: "press type (registration drift and trap)" },
  gain: { def: 22, range: [0, 50], help: "dot gain at 50%, percent" },
  minDot: { def: 6, range: [0, 20], help: "smallest dot, percent" },
  maxDot: { def: 92, range: [80, 100], help: "largest dot before solid, percent" },
  scatter: { def: true, values: [true, false], help: "tones under the smallest dot print scattered whole dots" },
  choke: { def: 0.2, range: [0, 1], help: "underbase choke, mm" },
  trap: { def: 0.4, range: [0, 1], help: "spot trap, mm" },
  indexDpi: { def: 200, range: [100, 400], help: "index square-pixel resolution" },
  stackLimit: { def: 240, range: [240, 280], help: "colour ink limit, percent (the base not counted)" },
  inkSource: { def: "library", values: ["library", "art"], help: "inks from the shelf library, or mixed from the art" },
  forceWhite: { def: "auto", values: ["auto", "on", "off"], help: "highlight white screen" },
  underbase: { def: "auto", values: ["auto", "on", "off"], help: "underbase (auto: on dark garments)" },
  ubStrength: { def: 100, range: [40, 100], help: "underbase strength, percent" },
  opacity: { def: 0.55, range: [0.3, 1], help: "ink opacity over the base" },
  smooth: { def: 0.1, range: [0, 1], help: "tonal smoothness" },
  rare: { def: 0.0005, range: [0, 0.01], help: "share of the art below which a colour is ignored" },
  cleanSpot: { def: true, values: [true, false], help: "clean spot plate edges" },
  solidDetail: { def: true, values: [true, false], help: "thin line work prints solid" },
  shirts: { def: 100, range: [1, 100000], help: "shirts in the run (mix sheet batch weights)" },
  mirror: { def: "right", values: ["right", "mirror"], help: "films right reading, or mirrored (emulsion down): films, SVG, Photoshop and DCS files flip left to right" },
  setupMin: { def: null, range: [0, 240], help: "press time estimate: setup minutes for each screen (default: the press type's, plan.PRESS_TIME)" },
  perHour: { def: null, range: [1, 3000], help: "press time estimate: prints per hour (default: the press type's, plan.PRESS_TIME)" },
  fabric: { def: "cotton", values: FABRIC_KEYS, help: `garment fabric: ${FABRIC_KEYS.map(k => `${k} = ${FABRICS[k].name}`).join(", ")}. Sets the base ink, cure and flash notes; fleece sets a 0.35 mm choke unless choke is set` },
  minPpi: { def: CHECK_LIMITS.minPpi[0], range: [CHECK_LIMITS.minPpi[1], CHECK_LIMITS.minPpi[2]], help: "check limit: lowest art resolution at the print width, pixels per inch" },
  offCentreIn: { def: CHECK_LIMITS.offCentreIn[0], range: [CHECK_LIMITS.offCentreIn[1], CHECK_LIMITS.offCentreIn[2]], help: "check limit: design off the centre of the art by more than this, inches" },
  manualMaxLpi: { def: CHECK_LIMITS.manualMaxLpi[0], range: [CHECK_LIMITS.manualMaxLpi[1], CHECK_LIMITS.manualMaxLpi[2]], help: "check limit: highest LPI on a manual press" },
  smallScreenPct: { def: CHECK_LIMITS.smallScreenPct[0], range: [CHECK_LIMITS.smallScreenPct[1], CHECK_LIMITS.smallScreenPct[2]], help: "check limit: a screen under this share of the design gets a small screen note, percent" },
};
/** Saved settings (a restored job, an undo step) checked against SETTINGS: a missing or invalid value is the default.
 *  Returns the settings and the keys that were dropped. */
export function cleanSettings(v) {
  const s = defaults(), dropped = []; if (!v || typeof v !== "object") return { s, dropped: ["all"] };
  for (const k of Object.keys(SETTINGS)) { if (!(k in v) || v[k] == null) continue; try { s[k] = parseSetting(k, v[k]); } catch { dropped.push(k); } }
  if (v.formats && typeof v.formats === "object") for (const f of Object.keys(FORMATS)) if (f in v.formats) s.formats[f] = !!v.formats[f];
  return { s, dropped };
}
/** The check limits in the settings (checks.js job.limits). */
export const limitsOf = s => ({ minPpi: +s.minPpi, offCentreIn: +s.offCentreIn, manualMaxLpi: +s.manualMaxLpi, smallScreenPct: +s.smallScreenPct });
/** Files in the job ZIP, as the page's step 4 checkboxes (same defaults). */
export const FORMATS = { pdf: true, tif: true, png: false, eps: false, svg: true, psd: true, psdPreview: false, dcs: false };
/** @returns {Record<string, any>} */
export const defaults = () => ({ ...Object.fromEntries(Object.entries(SETTINGS).map(([k, v]) => [k, v.def])), formats: { ...FORMATS } });

/** Names a shop types for some values, beside the engine's own (sep --mode duotone, --screening interlocked). */
export const VALUE_ALIASES = /** @type {Record<string, Record<string, string>>} */ ({
  method: { duotone: "duo", gray: "mono", grey: "mono", grayscale: "mono", tritone: "tri" },
  screening: { "one-angle": "same", interlocked: "lock", index: "fm" } });
/** Garment names, the page's shirt chips (index.html #shirtChips). */
export const GARMENTS = { black: "#111111", white: "#ffffff", navy: "#1c2a4a", charcoal: "#6e6e6e", maroon: "#7a1f2b", sand: "#c9b48f", royal: "#1f4e9c", red: "#b3121e", forest: "#2d5a3a", heather: "#a7a9ac" };

/**
 * Check one setting and return its value in the settings' own type, or throw with the valid values.
 * @param {string} key @param {any} v
 */
export function parseSetting(key, v) {
  const spec = SETTINGS[key]; if (!spec) throw new Error(`unknown setting "${key}". Settings: ${Object.keys(SETTINGS).join(", ")}`);
  const al = VALUE_ALIASES[key]; if (al && typeof v === "string" && al[v.toLowerCase()]) v = al[v.toLowerCase()];
  if (key === "garment") { const h = String(v).toLowerCase(), hex = GARMENTS[h] || h; if (!/^#[0-9a-f]{6}$/.test(hex)) throw new Error(`garment "${v}" is not #rrggbb or one of: ${Object.keys(GARMENTS).join(", ")}`); return hex; }
  if (key === "screens" && (v === "auto" || v === 0 || v === "0")) return "auto";
  if (spec.values) { const s = typeof spec.def === "boolean" ? (v === true || v === "true" || v === "on" ? true : v === false || v === "false" || v === "off" ? false : v) : String(v);
    if (!spec.values.includes(s)) throw new Error(`${key} "${v}" is not valid. Valid: ${spec.values.join(", ")}${al ? `; also ${Object.entries(al).map(([a, x]) => `${a} (${x})`).join(", ")}` : ""}`); return s; }
  const n = typeof v === "number" ? v : Number(v), [lo, hi] = spec.range;
  if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${key} "${v}" is out of range. Valid: ${lo} to ${hi}${key === "screens" ? ", or auto" : ""}`);
  return n;
}

/* ───────────── Settings → engine ───────────── */
/** The engine (sim, spot, index) a method runs on. */
export const engineMode = s => s.method === "spot" || s.method === "index" ? s.method : "sim";
/** The engine method for cmyk and 1-3 colors, or null for sim, spot and index. */
export const methodKey = s => ["cmyk", "mono", "duo", "tri"].includes(s.method) ? s.method : null;
export const methodName = s => METHOD_NAME[s.method] || MODE_NAME[engineMode(s)];
export const garmentLab = s => rgb2lab(...hex2rgb(s.garment));
export const needsUB = s => s.underbase === "on" || (s.underbase === "auto" && garmentLab(s)[0] < 55);
/** Methods with standard angles print rotated screens (Demichel overlap); otherwise the Screening setting decides. */
export const overprint = s => methodKey(s) ? "rotated" : s.screening === "rotated" ? "rotated" : s.screening === "lock" && engineMode(s) === "sim" ? "lock" : "same";
/** Colour ink limit (base not counted), held inside the allowed range whatever was typed or stored; CMYK holds 240%. */
export const stackLimit = s => { const v = Math.min(STACK_RANGE[1], Math.max(STACK_RANGE[0], +s.stackLimit / 100 || STACK_RANGE[0])); return methodKey(s) === "cmyk" ? Math.min(2.4, v) : v; };
export const dotOf = s => ({ gain: +s.gain / 100, minDot: +s.minDot / 100, maxDot: +s.maxDot / 100, scatter: !!s.scatter, shape: s.dot || "round" });
/** Choke is set in millimetres (printers quote 0.17–0.34 mm) and converted to film pixels at the film DPI. */
export const chokePx = (s, dpi) => Math.round(+s.choke / 25.4 * dpi);
export const rhoOf = (s, calib) => calib && calib.overlap != null ? calib.overlap : PRESS[s.press].rho;
export const screeningOf = s => s.screening === "fm" ? "fm" : "am";
const calibratedLab = (ink, calib) => { const c = calib && calib.inks[ink.name]; return c ? c.solid : ink.lab; };

/**
 * Everything a separation needs from the settings (the page's sepParams).
 * @param {Record<string, any>} s settings @param {{ px: any, alpha: any, lab: any, W: number, H: number }} src
 * @param {{ library: any[], calib?: any, salience?: number }} ctx
 */
export function sepModel(s, src, ctx) {
  const lib = ctx.library.map(i => ({ ...i, lab: calibratedLab(i, ctx.calib) })), mk = methodKey(s);
  return { px: src.px, alpha: src.alpha, lab: src.lab, W: src.W, H: src.H,
    library: lib, k: (s.screens === "auto" ? 0 : +s.screens) || 6, ...(mk && { method: mk }), paletteMode: s.inkSource === "library" ? "library" : "art", forceWhite: s.forceWhite,
    garmentLab: garmentLab(s), n: ctx.calib ? ctx.calib.n : 1.7, smooth: +s.smooth, rareFrac: +s.rare, underbase: needsUB(s), ubStrength: +s.ubStrength / 100, opacity: +s.opacity, screening: screeningOf(s), overprint: overprint(s), rho: rhoOf(s, ctx.calib), rhos: PRESS[s.press].rhos, stackLimit: stackLimit(s),
    film: { minDot: +s.minDot / 100, maxDot: +s.maxDot / 100, scatter: !!s.scatter, lpi: +s.lpi, widthIn: +s.widthIn },
    driftMm: PRESS[s.press].mm, trapMm: +s.trap, salience: ctx.salience ?? 1, solidDetail: !!s.solidDetail };
}
/** The model a re-proof needs after the spot cleanup changed the coverage (the page's cleanIfSpot). */
export function reproofModel(s, ctx, r, src, cov) {
  return { mode: engineMode(s), cov, W: src.W, H: src.H, lab: r.lab || src.lab, alpha: src.alpha, inks: r.inks, garmentLab: garmentLab(s), n: ctx.calib ? ctx.calib.n : 1.7, underbase: needsUB(s), ubStrength: +s.ubStrength / 100, opacity: +s.opacity, screening: screeningOf(s), overprint: overprint(s), rho: rhoOf(s, ctx.calib), rhos: PRESS[s.press].rhos, stackLimit: stackLimit(s) };
}
/** Spot plates: OpenCV-style open/close cleanup of the label image, then the proof again (reproof: evaluate, in a
 *  worker on the page). Other modes come back unchanged. area: the smallest speck kept, in pixels of src (default
 *  the engine's 8 at preview size, 32 past 1200 px). */
export async function cleanSpot(s, ctx, r, src, reproof, area = null) {
  if (engineMode(s) !== "spot" || !s.cleanSpot || !r.spotIdx) return r;
  const N = r.inks.length, rad = src.W > 1200 ? 2 : 1, idx = cleanSpotSync(r.spotIdx, N, src.W, src.H, area ?? 8 * rad * rad), cov = indexToCov(idx, N, src.W * src.H);
  const pr = await reproof(reproofModel(s, ctx, r, src, cov));
  return { ...r, ...pr, spotIdx: idx, cov };
}
/** A print method (cmyk, mono, duo, tri) sets its own inks, screen count and overprint; sim, spot and index pass through. */
export const withMethod = m => m.method ? { ...m, ...methodSettings(m.method, m) } : m;
/** What Auto sets besides the method and screen count (the page's autoVals): the smallest dot the mesh holds at the
 *  LPI, trap from the press, ink opacity from a calibration, and from Auto's pick the ink source and tonal smoothness.
 *  best: autoPick's best row, or null. colorMesh: the shop's mesh for color screens (Shop setup), else the LPI's.
 *  Returns settings to apply over the defaults. */
export function autoChoices(s, best, calib, colorMesh = null) {
  const lpi = +s.lpi, v = /** @type {Record<string, any>} */ ({ minDot: Math.max(3, Math.round(minDotFor(lpi, colorMesh || meshFor(lpi)) * 100)), trap: s.press === "automatic" ? 0.2 : 0.4 });
  if (calib && calib.opacity != null) v.opacity = calib.opacity;
  Object.assign(v, fabricSettings(s.fabric)); // the fabric's own values (fleece: a 0.35 mm choke)
  if (best) { if (best.mode === "spot" || best.mode === "index") v.inkSource = "art"; if (best.smooth != null) v.smooth = best.smooth; }
  return v;
}
/** The job preflightChecks reads (checks.js Job). art: the art the separation reads, full size; prev: its preview copy. */
export function checkJob(s, ctx, art, prev, pl, sample = false) {
  return { art: art ? { W: art.W, sample, background: solidBackground(art.rgba, art.W, art.H, garmentLab(s)) } : null,
    widthIn: +s.widthIn || 11, lpi: +s.lpi, press: s.press, mode: engineMode(s), screening: s.screening, method: methodKey(s) || null,
    screens: (s.screens === "auto" ? 0 : +s.screens) || 6, inkSource: s.inkSource, shelfSize: ctx.library.length, stackLimit: stackLimit(s),
    plates: pl.map(p => ({ name: p.name, idx: p.idx, ub: !!p.ub })), gain: +s.gain / 100, minDot: +s.minDot / 100, maxDot: +s.maxDot / 100, scatter: !!s.scatter, solidDetail: !!s.solidDetail, choke: +s.choke, driftMm: PRESS[s.press].mm,
    preview: prev ? { W: prev.W, H: prev.H, alpha: prev.alpha, lab: prev.lab, px: prev.px } : null,
    // the check limits in the settings, under any the caller keeps in the context (sep --check-limits, a job file)
    limits: { ...limitsOf(s), ...(ctx.limits || {}) },
    // the shop's sizes and colour mesh, when the caller keeps them in the context (the page adds its own)
    ...(ctx.sizes && { sizes: ctx.sizes }), ...(ctx.mesh && ctx.mesh.color && { mesh: ctx.mesh.color }) };
}
/** The film list for an ink set (plan.platesFor with the settings). */
export function filmPlates(s, inks, hasUB, ctx) {
  const mk = methodKey(s);
  return platesFor(inks, hasUB, { screening: s.screening, angle: +s.angle, lpi: +s.lpi, library: ctx.library, calib: ctx.calib, ...(ctx.mesh && { mesh: ctx.mesh }), ...(ctx.ub && { ub: ctx.ub }), ...(mk && { method: mk }) });
}
/** Film size in pixels for art W × H. */
export function filmGeometry(s, W, H) { const dpi = +s.dpi, Wp = Math.round(+s.widthIn * dpi); return { dpi, Wp, Hp: Math.round(Wp * H / W) }; }
/** The film-rendering request for a separation (what the page sends the worker). */
export function filmRequest(s, ctx, r, src, pl, geom) {
  return { cov: r.cov, solid: r.solid || null, trapMm: +s.trap, widthIn: +s.widthIn, ub: r.ub, W: src.W, H: src.H, N: r.inks.length, mode: engineMode(s), plates: pl, Wp: geom.Wp, Hp: geom.Hp, dpi: geom.dpi, lpi: +s.lpi,
    screening: screeningOf(s), overprint: overprint(s), rho: rhoOf(s, ctx.calib), rhos: PRESS[s.press].rhos, stackLimit: stackLimit(s), dot: dotOf(s), choke: chokePx(s, geom.dpi), indexDpi: +s.indexDpi };
}
/**
 * Render the 1-bit films for a request (filmRequest, or the page's preview crops). onPlate(j, bits) gets each film.
 * @param {any} m @param {(j: number, bits: Uint8Array, w: number, h: number) => void} onPlate
 */
export function renderFilms(m, onPlate) {
  const { cov, ub, W, H, N, mode } = m, P = W * H;
  const printed0 = printedFrom(cov, N, P, mode, m.screening, m.overprint, m.rho || 0, ub, m.stackLimit ?? STACK_LIMIT);
  // spot films carry the trap: each ink spreads under the inks printed after it
  const printed = mode === "spot" && m.trapMm ? trapSpot(printed0, N, W, H, m.trapMm * W / ((m.widthIn || 11) * 25.4)) : printed0;
  const c = m.crop || { x0: 0, y0: 0, w: m.Wp, h: m.Hp };
  // Index separations print square pixels at the index DPI (not the art's pixel grid), shared so screens never overlap.
  const fmIdx = (mode === "sim" && m.screening === "fm") || mode === "index" ? fmIndexAt(cov, W, H, N, m.Wp, m.Hp, m.dpi, m.indexDpi, c) : null;
  for (let j = 0; j < m.plates.length; j++) {
    const plate = m.plates[j];
    const bits = renderPlate({ plate, printed, ub, W, H, N, Wp: m.Wp, Hp: m.Hp, x0: c.x0, y0: c.y0, w: c.w, h: c.h, dpi: m.dpi, lpi: plate.lpi || m.lpi,
      angle: plate.angle, screening: m.screening, mode, dot: m.dot, choke: m.choke, fmIdx, lock: m.overprint === "lock", solid: m.solid || null });
    onPlate(j, bits, c.w, c.h);
  }
}
/* ───────────── Test films ─────────────
   One film with a row of tint patches for each value of one setting (LPI, angle, dot gain or smallest dot), the other
   settings as the job has them. Print it on the press, then pick the row that prints best. Each row starts with as
   many solid marks as its place in the list (1 mark = the first value), and the film label lists the values in order. */
export const TEST_TINTS = [2, 5, 10, 15, 20, 30, 40, 50, 60, 70, 80, 90, 95, 98];
/** The settings a test film can step, with its standard steps and the unit for the label. */
export const TEST_STEPS = { lpi: { name: "LPI", values: [35, 45, 55, 65], unit: " LPI" }, angle: { name: "Angle", values: [15, 22.5, 30, 45], unit: "°" },
  gain: { name: "Dot gain", values: [10, 15, 20, 25, 30], unit: "% gain" }, minDot: { name: "Smallest dot", values: [2, 4, 6, 8, 10], unit: "% smallest dot" } };
/** Values for a test film from text such as "35, 45, 55": each checked against the setting's range, 2 to 8 of them. */
export function testValues(param, text) {
  const t = TEST_STEPS[param]; if (!t) throw new Error(`a test film steps one of: ${Object.keys(TEST_STEPS).join(", ")}`);
  const v = String(text ?? "").split(/[\s,;]+/).filter(Boolean).map(x => parseSetting(param, x));
  if (v.length < 2 || v.length > 8) throw new Error(`List 2 to 8 values for ${t.name}, for example ${t.values.join(", ")}.`); return v;
}
/** The film's pixels (1 = ink), its size and its label. Patches 0.4 in square, rows 0.15 in apart. */
export function testFilmBits(s, param, values) {
  const dpi = +s.dpi, cw = Math.round(0.4 * dpi), gap = Math.round(0.15 * dpi), mark = Math.round(0.08 * dpi), lead = Math.round(0.12 * dpi) * 8 + gap;
  const w = lead + TEST_TINTS.length * cw, h = values.length * (cw + gap) - gap, bits = new Uint8Array(w * h);
  values.forEach((v, r) => { const t = { lpi: +s.lpi, angle: +s.angle, gain: +s.gain, minDot: +s.minDot, [param]: v }, cell = dpi / t.lpi, { cs, sn } = screenAxes(t.angle), y0 = r * (cw + gap);
    for (let k = 0; k <= r; k++) for (let y = 0; y < mark; y++) for (let x = 0; x < mark; x++) bits[(y0 + y) * w + k * Math.round(0.12 * dpi) + x] = 1; // row marks
    TEST_TINTS.forEach((tint, c) => { const a = shapeDot(tint / 100, { gain: t.gain / 100, curve: null, minDot: t.minDot / 100, maxDot: +s.maxDot / 100 }), x0 = lead + c * cw;
      for (let y = 0; y < cw; y++) for (let x = 0; x < cw - 2; x++) if (dotOn(s.dot || "round", x0 + x, y0 + y, a, cell, cs, sn)) bits[(y0 + y) * w + x0 + x] = 1; }); });
  const T = TEST_STEPS[param], other = Object.keys(TEST_STEPS).filter(k => k !== param).map(k => `${TEST_STEPS[k].name} ${s[k]}`).join(", ");
  return { bits, w, h, dpi, label: `Test film: ${T.name} ${values.join(" / ")} (rows top to bottom). Tints ${TEST_TINTS[0]} to ${TEST_TINTS[TEST_TINTS.length - 1]}%. ${other}.` };
}
/** The test film as a one-page PDF (the page's Test films button; the CLI can call it with its platform). */
export async function writeTestFilm(s, param, values, platform) {
  const f = testFilmBits(s, param, values), film = platform.composeFilm(f.bits, f.w, f.h, f.dpi, f.label, null, s.mirror === "mirror");
  film.png = await platform.toPNG(film); return { pdf: await out.toPDF([film], f.dpi), label: f.label, w: f.w, h: f.h };
}

/** Merge screen `from` into screen `into`: `from`'s ink is dropped and `into`'s is kept and locked, so the next
 *  separation (with these inks, no new pick) prints `from`'s colors with the inks left. Returns a new list. */
export function mergeInks(inks, from, into) {
  if (!inks[from] || !inks[into] || from === into) throw new Error(`merge: screens ${from} and ${into} are not two screens of ${inks.length}`);
  return inks.filter((_, i) => i !== from).map(k => k === inks[into] ? { ...k, locked: true } : k);
}

/** The job's file stem: separations-<mode>-<date>. */
export const jobSlug = (s, date = new Date()) => `separations-${engineMode(s)}-${date.toISOString().slice(0, 10)}`;
/** The film column of the job sheet. */
const filmText = (s, sc) => engineMode(s) === "spot" ? "Solid" : s.screening === "fm" || engineMode(s) === "index" ? "Index" : `${sc.lpi || +s.lpi} LPI ${sc.angle} deg${s.dot && s.dot !== "round" ? ` ${s.dot} dot` : ""}${s.screening === "lock" && !sc.underbase ? " interlocked" : ""}`;

/**
 * Write the job's files into a JSZip: films (PDF, TIFF, PNG, EPS), spot vectors, mix sheet, job sheet, separation.json
 * and the Photoshop file. The page's step 4 download and the CLI both call this. imported: the films the job was
 * re-proofed from (the page's Re-proof films), recorded in separation.json and on the job sheet.
 * @param {{ s: Record<string, any>, ctx: { library: any[], calib?: any, targets: any[] }, work: any, r: any, pl: any[], bits: { bits: Uint8Array, w: number, h: number }[],
 *   prev: any, proof: ArrayLike<number> | null, art: any, zip: any, slug: string, created?: string, profile?: { name: string, changed?: boolean, builtin?: boolean, source?: string } | null, imported?: { from: string, kind: string, rescreened: boolean } | null,
 *   platform: { composeFilm: Function, toPNG: Function, rgbaPNG: (rgba: Uint8ClampedArray, W: number, H: number) => Promise<Blob> }, trace?: { traceMask: Function, wrapSVG: Function } | null, say?: (t: string) => void | Promise<void> }} a
 */
export async function writeJob(a) {
  const { s, ctx, work, r, pl, bits, prev, proof, zip, slug, platform } = a, say = a.say || (() => {}), f = s.formats || FORMATS;
  const dpi = +s.dpi, mode = engineMode(s), fm = s.screening === "fm", films = [], mir = s.mirror === "mirror";
  for (let j = 0; j < pl.length; j++) {
    const p = pl[j], stem = plateSlug(p);
    const label = filmLabel(p, { mode, screening: s.screening, lpi: +s.lpi, dpi, last: p.order === pl.length, shape: s.dot || "round", mirror: mir });
    await say(`Encoding ${j + 1}/${pl.length}: ${p.name}…`);
    const film = platform.composeFilm(bits[j].bits, bits[j].w, bits[j].h, dpi, label, mode === "sim" && !fm ? { lpi: p.lpi || +s.lpi, angle: p.angle, shape: s.dot || "round" } : null, mir);
    film.png = await platform.toPNG(film); films.push(film);
    if (f.png) zip.file(`png/${stem}.png`, film.png);
    if (f.tif) zip.file(`tiff/${stem}.tif`, out.toTIFF(film.bits, film.w, film.h, dpi));
    if (f.eps) zip.file(`eps/${stem}.eps`, out.toEPS(film.bits, film.w, film.h, dpi, `${p.order}. ${p.name}`));
  }
  if (f.pdf) { await say("Writing PDF…"); zip.file("films.pdf", await out.toPDF(films, dpi)); }
  if (f.svg && mode === "spot" && r.spotIdx && a.trace) {
    await say("Tracing vectors…"); const N = r.inks.length; let all = "";
    for (let i = 0; i < N; i++) {
      const m = new Uint8Array(work.W * work.H); for (let q = 0; q < m.length; q++) m[q] = r.spotIdx[q] === i ? 1 : 0;
      const paths = await a.trace.traceMask(m, work.W, work.H), hex = rgb2hex(lab2rgb(r.inks[i].lab)), p = pl.find(x => !x.ub && x.idx === i);
      // a screen's SVG is a film: mirrored with the films. The composite shows the print as it lands on the garment.
      zip.file(`svg/${plateSlug(p)}.svg`, a.trace.wrapSVG(mir ? await a.trace.traceMask(mirrorX(m, work.W, work.H), work.W, work.H) : paths, work.W, work.H, +s.widthIn));
      all += `<g fill="${hex}">${paths.replace(/fill="#000000"/g, "")}</g>\n`;
    }
    zip.file("svg/composite.svg", `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${s.widthIn}in" height="${(+s.widthIn * work.H / work.W).toFixed(4)}in" viewBox="0 0 ${work.W} ${work.H}">\n<rect width="100%" height="100%" fill="${s.garment}"/>\n${all}</svg>\n`);
  }
  const spec = specFor({ plates: pl, result: r, mode, method: methodName(s), garment: { hex: s.garment, lab: garmentLab(s), fabric: s.fabric || "cotton", fabric_notes: fabricText(s.fabric || "cotton") }, profile: a.profile || null, ...(a.created && { created: a.created }),
    print: { width_in: +s.widthIn, dpi, lpi: +s.lpi, screening: s.screening, angle: +s.angle, dot_shape: s.dot || "round", dot_gain_50: +s.gain, min_dot: +s.minDot, scatter_small_dots: !!s.scatter, max_dot: +s.maxDot, choke_mm: +s.choke, choke_px: chokePx(s, dpi), index_dpi: +s.indexDpi, stack_limit_pct: +s.stackLimit, mirror: mir, film_reading: mir ? "mirrored, emulsion down" : "right reading", press: s.press },
    model: { yule_nielsen_n: ctx.calib ? ctx.calib.n : 1.7, calibrated: !!ctx.calib, calibration_residual_de00: ctx.calib ? ctx.calib.residual : null }, targets: ctx.targets,
    pressTime: pressTime({ plates: pl, shirts: +s.shirts || 100, press: s.press, setupMin: s.setupMin ?? NaN, perHour: s.perHour ?? NaN }), imported: a.imported || null });
  // ink mix sheet: per screen target color, batch weight and blanks for the producer's Pantone match and formula
  const areaIn2 = +s.widthIn * (+s.widthIn * work.H / work.W), shirts = Math.max(1, +s.shirts || 100);
  const cjl = l => ({ space: cjLab, coords: /** @type {[number, number, number]} */ (l.slice(0, 3)), alpha: 1 });
  const mix = mixRows({ plates: pl, covPct: r.covPct, ubPct: r.ubPct, areaIn2, shirts, targets: ctx.targets, cmc: (x, y) => cjCMC(cjl(x), cjl(y)), press: s.press })
    .map(m => ({ ...m, hex: rgb2hex(lab2rgb(m.lab)).toUpperCase(), rgb: lab2rgb(m.lab), stock: m.ub ? [] : nearestStock(m.lab, STOCK_CATALOGS, (x, y) => de2000(...x, ...y)) }));
  zip.file("mix-sheet.pdf", await out.toMixSheet({ rows: mix, job: { title: `${slug} · ${shirts} shirts`, line: `Garment ${s.garment} · ${s.widthIn} in wide · ${s.press} press · ${mode === "sim" ? s.lpi + " LPI" : mode}`, shirts, areaIn2 } }));
  spec.mix = mix.map(({ rgb, ...m }) => m);
  // job sheet: the art beside the print preview, the screens in print order and lines to sign (preview size, all screens)
  await say("Writing job sheet…");
  const pv = prev, gar = hex2rgb(s.garment), P0 = pv.W * pv.H, artRGBA = new Uint8ClampedArray(P0 * 4);
  for (let q = 0; q < P0; q++) { const al = pv.alpha[q] / 255; for (let c = 0; c < 3; c++) artRGBA[q * 4 + c] = pv.px[q * 3 + c] * al + gar[c] * (1 - al); artRGBA[q * 4 + 3] = 255; }
  const artPng = await platform.rgbaPNG(artRGBA, pv.W, pv.H);
  let proofPng = null; if (proof) { const d = new Uint8ClampedArray(P0 * 4); for (let q = 0; q < P0; q++) { for (let c = 0; c < 3; c++) d[q * 4 + c] = proof[q * 4 + c]; d[q * 4 + 3] = 255; } proofPng = await platform.rgbaPNG(d, pv.W, pv.H); }
  const notes = [pressTimeText(spec.press_time), `${(FABRICS[s.fabric] || FABRICS.cotton).name}: ${fabricText(s.fabric || "cotton")}`, ...(a.profile ? [`Profile: ${a.profile.name}${a.profile.changed ? " (changed for this job)" : ""}.`] : []), mir ? "Films are mirrored (emulsion down): they read the right way through the film. The pictures above show the print on the garment." : "Films are right reading.",
    ...(a.imported ? [`Re-proofed from ${a.imported.from}: the screens are the imported films, screened again at the settings above.`] : [])];
  zip.file("job-sheet.pdf", await out.toJobSheet({ job: { title: `${slug} · ${shirts} shirts`, line: `${methodName(s)} · garment ${s.garment} · ${s.widthIn} in wide · ${s.press} press`, notes },
    screens: spec.screens.map(sc => ({ ...sc, film: filmText(s, sc), hex: rgb2hex(lab2rgb(sc.lab)).toUpperCase(), rgb: lab2rgb(sc.lab) })),
    print: `Films ${dpi} DPI · dot gain ${s.gain}% at 50% · smallest dot ${s.minDot}% · underbase choke ${s.choke} mm · ${s.screening === "lock" ? "interlocked screens" : s.screening === "rotated" ? "rotated angles" : "one angle"}`,
    art: artPng, proof: proofPng }));
  if (proofPng) zip.file("proof.png", proofPng); // the Print view as a picture: the proof the customer approves
  zip.file("separation.json", JSON.stringify(spec, null, 2));
  if (f.psd || f.dcs) {
    // Photoshop file: the art plus one spot channel per screen at print size, for hand finishing or a RIP to screen
    await say(f.psd ? "Writing Photoshop file…" : "Writing DCS 2.0 file…");
    const P = work.W * work.H, N = r.inks.length, printed0 = printedFrom(r.cov, N, P, mode, screeningOf(s), overprint(s), rhoOf(s, ctx.calib), r.ub, stackLimit(s)),
      printed = mode === "spot" ? trapSpot(printed0, N, work.W, work.H, +s.trap * work.W / (+s.widthIn * 25.4)) : printed0;
    const workDpi = work.W / +s.widthIn, chokeW = Math.round(+s.choke / 25.4 * workDpi), ubCh = r.ub ? (UB_FADE ? softChoke : adaptiveChoke)(r.ub, work.W, work.H, chokeW) : null;
    // halftone screens (ruling, angle, dot shape) go with the channels when the films are AM dots. Mirrored (emulsion
    // down), the channels flip left to right like the films, and so does each screen angle (θ → 180° − θ), so the RIP's
    // dots land on the film as they do on the TIFF films.
    const am = mode === "sim" && !fm, shape = s.dot || "round", flipAngle = t => mir ? (180 - t) % 180 : t;
    const channels = pl.map(p => { const d = new Uint8Array(P); for (let q = 0; q < P; q++) { const v = p.ub ? ubCh[q] : printed[q * N + p.idx]; d[q] = Math.round(255 * (1 - Math.max(0, Math.min(1, v)))); }
      return { name: `${p.order}. ${p.name}${p.hits === 2 ? (p.flashBetween ? " 2x flash" : " 2x") : ""}`, rgb: lab2rgb(p.lab), solidity: 100, data: mir ? mirrorX(d, work.W, work.H) : d,
        ...(am && { lpi: p.lpi || +s.lpi, angle: flipAngle(p.angle), shape }) }; });
    if (f.psd) {
      // production file: Multichannel, spot channels only, so nothing but the screens can come out of a RIP or Print Separations.
      // A dot shape other than round is written as Photoshop's halftone screens; round leaves the file as it was.
      zip.file(`${slug}.psd`, out.toPSD({ W: work.W, H: work.H, dpi: workDpi, channels, screens: am && shape !== "round" ? channels.map(c => ({ lpi: c.lpi, angle: c.angle, shape })) : null }));
      if (f.psdPreview) { const rgba = work.rgba || a.art.rgba; zip.file(`${slug}-preview-rgb.psd`, out.toPSD({ W: work.W, H: work.H, dpi: workDpi, rgba: mir ? mirrorX(rgba, work.W, work.H, 4) : rgba, channels })); }
    }
    // DCS 2.0: the same channels in one EPS with a composite preview, for RIPs that take Separation Studio's files
    if (f.dcs) { await say("Writing DCS 2.0 file…"); zip.file(`${slug}-dcs2.eps`, out.toDCS({ W: work.W, H: work.H, dpi: workDpi, channels, background: hex2rgb(s.garment), title: slug }).blob); }
  }
  return { spec, films: films.length };
}

/* ───────────── Shop profiles and job files ───────────── */
/** A shop profile (plan.cleanProfile; the page's Shop setup > Profiles, exported as JSON) as job settings and the
 *  context it sets: the colour, base and white mesh, the press calibration and the platen, film and screen sizes. The page's applyProfile sets the same. */
export function profileSettings(p) {
  const c = /** @type {any} */ (cleanProfile(p)), settings = /** @type {Record<string, any>} */ ({ press: c.press, lpi: c.lpi, angle: c.angle, dpi: c.dpi, gain: c.gain, minDot: c.minDot, maxDot: c.maxDot, dot: c.dotShape });
  for (const k of ["mirror", "setupMin", "perHour"]) if (k in SETTINGS && c[k] != null) settings[k] = c[k];
  for (const [k, v] of Object.entries(c.limits || {})) if (k in SETTINGS) settings[k] = v; // the profile's check limits
  return { name: c.name, settings, mesh: c.mesh, calib: c.calib, sizes: c.sizes ? cleanSizes(c.sizes) : null };
}
/** The profile named `name` in a profiles file's text (the only one when no name is given), or an Error naming the
 *  profiles in the file. */
export function pickProfile(text, name = "") {
  const list = profilesFromJSON(text), names = list.map(p => p.name);
  if (!name) { if (list.length === 1) return list[0]; throw new Error(`the profiles file has ${list.length} profiles; name one: ${names.join(", ")}`); }
  const p = list.find(q => q.name === name) || list.find(q => q.name.toLowerCase() === String(name).toLowerCase());
  if (!p) throw new Error(`no profile "${name}". Profiles in the file: ${names.join(", ")}`); return p;
}

/** A job file: the settings, the inks in print order with what was set on each, the shop context and a
 *  reference to the art, so the same separation can be made again. JSON; written by sep and the MCP server (save_job),
 *  read back by readJobFile. */
export const JOB_FORMAT = "adn-separation-table-job", JOB_VERSION = 1;
/** Ink fields a job file keeps. */
const INK_KEYS = ["name", "lab", "locked", "chosen", "source", "code", "system", "process", "label", "hits", "flashBetween", "mesh", "lpi", "angle"];
/**
 * @param {{ s: Record<string, any>, inks: any[] | null, art: { file: string, path: string, sha256: string, W: number, H: number, edits?: string[] } | null,
 *   ctx: { sizes?: any, limits?: any, mesh?: any, calib?: any, profile?: string | null, ub?: any }, auto?: any, saved?: string }} a
 */
export function jobFile(a) {
  const { s, ctx } = a;
  return { format: JOB_FORMAT, version: JOB_VERSION, tool: "ADN Separation Table", saved: a.saved || new Date().toISOString(),
    art: a.art ? { file: a.art.file, path: a.art.path, sha256: a.art.sha256, width_px: a.art.W, height_px: a.art.H, edits: a.art.edits || [] } : null,
    settings: Object.fromEntries(Object.keys(SETTINGS).filter(k => s[k] !== undefined && s[k] !== null).map(k => [k, s[k]])), formats: { ...FORMATS, ...(s.formats || {}) },
    inks: a.inks ? a.inks.map(i => Object.fromEntries(INK_KEYS.filter(k => i[k] !== undefined).map(k => [k, k === "lab" ? i.lab.map(v => +(+v).toFixed(4)) : i[k]]))) : null,
    ...(ctx.ub && { underbase: ctx.ub }), ...(a.auto && { auto: a.auto }),
    shop: { profile: ctx.profile || null, mesh: ctx.mesh || null, calib: ctx.calib || null, sizes: ctx.sizes ? Object.fromEntries(Object.entries(ctx.sizes).map(([k, z]) => [k, /** @type {any} */ (z).id === "custom" ? { id: "custom", w: /** @type {any} */ (z).w, h: /** @type {any} */ (z).h } : { id: /** @type {any} */ (z).id }])) : null, limits: ctx.limits || null } };
}
/** A job file's text, checked: every setting through parseSetting, the inks, the sizes and limits. Throws an Error
 *  that says what is wrong and what is valid. */
export function readJobFile(text) {
  let d; try { d = JSON.parse(text); } catch (e) { throw new Error(`not JSON: ${e.message}`); }
  if (!d || d.format !== JOB_FORMAT) throw new Error(`not a Separation Table job file (format must be "${JOB_FORMAT}")`);
  if (d.version !== JOB_VERSION) throw new Error(`job file version ${d.version} is not supported (this tool reads version ${JOB_VERSION})`);
  const settings = /** @type {Record<string, any>} */ ({});
  for (const [k, v] of Object.entries(d.settings || {})) settings[k] = parseSetting(k, v);
  const formats = { ...FORMATS }; for (const [k, v] of Object.entries(d.formats || {})) { if (!(k in FORMATS)) throw new Error(`unknown format "${k}". Formats: ${Object.keys(FORMATS).join(", ")}`); formats[k] = !!v; }
  let inks = null;
  if (d.inks != null) { if (!Array.isArray(d.inks) || !d.inks.length || d.inks.length > 12) throw new Error("inks must be a list of 1 to 12 inks");
    inks = d.inks.map((i, n) => { if (!i || typeof i.name !== "string" || !i.name || !Array.isArray(i.lab) || i.lab.length !== 3 || !i.lab.every(Number.isFinite)) throw new Error(`ink ${n + 1}: needs a name and lab [L, a, b]`);
      cleanScreenSet(i, `ink ${n + 1}`); return Object.fromEntries(INK_KEYS.filter(k => i[k] !== undefined).map(k => [k, i[k]])); }); }
  if (d.underbase != null) cleanScreenSet(d.underbase, "underbase");
  const sh = d.shop || {}, art = d.art && typeof d.art.path === "string" ? { file: String(d.art.file || ""), path: d.art.path, sha256: String(d.art.sha256 || ""), W: +d.art.width_px, H: +d.art.height_px, edits: Array.isArray(d.art.edits) ? d.art.edits.map(String) : [] } : null;
  return { settings, formats, inks, art, auto: d.auto || null, ub: d.underbase || null,
    ctx: { profile: sh.profile || null, mesh: sh.mesh || null, calib: sh.calib || null, sizes: sh.sizes ? cleanSizes(sh.sizes) : null, limits: sh.limits ? parseLimitsObj(sh.limits) : null } };
}
/** Limits as a job file keeps them (the Limits keys) back through the same checks parseLimits makes. */
function parseLimitsObj(l) { const name = Object.fromEntries(Object.entries(LIMIT_NAMES).map(([n, d]) => [d.key, n]));
  return parseLimits(Object.fromEntries(Object.entries(l).map(([k, v]) => k === "smallScreen" ? ["small-screen", +v * 100] : [name[k] || k, v]))); } // smallScreen: a 0–1 share in older job files

/** A separation.json (specFor; a job ZIP's or get_separation's) as job settings and the colour inks in print order,
 *  locked, so other art (or the same) is separated with the same inks, order and print settings (sep --spec). */
export function settingsFromSpec(spec) {
  if (!spec || typeof spec !== "object" || !Array.isArray(spec.screens) || !spec.print) throw new Error("not a separation.json: it needs screens and print");
  const p = spec.print, map = { width_in: "widthIn", dpi: "dpi", lpi: "lpi", screening: "screening", angle: "angle", dot_shape: "dot", dot_gain_50: "gain", min_dot: "minDot", scatter_small_dots: "scatter", max_dot: "maxDot", choke_mm: "choke", index_dpi: "indexDpi", stack_limit_pct: "stackLimit", press: "press" };
  const s = /** @type {Record<string, any>} */ ({});
  for (const [k, key] of Object.entries(map)) if (p[k] != null) s[key] = parseSetting(key, p[k]);
  if (p.mirror != null && "mirror" in SETTINGS) s.mirror = p.mirror === true || p.mirror === "mirror" ? "mirror" : "right";
  if (spec.garment && spec.garment.hex) s.garment = parseSetting("garment", spec.garment.hex);
  const byName = Object.entries(METHOD_NAME).find(([, n]) => n === spec.method), method = byName ? byName[0] : spec.separation;
  if (method) s.method = parseSetting("method", method);
  const isBase = sc => sc.underbase === true || (sc.ink || sc.name) === "Underbase";
  const inks = spec.screens.filter(sc => !isBase(sc)).map((sc, n) => { if (!Array.isArray(sc.lab) || sc.lab.length !== 3) throw new Error(`screen ${n + 1}: no lab`);
    return { name: sc.ink || sc.name, lab: sc.lab.map(Number), locked: true, ...(sc.ink && sc.ink !== sc.name && { label: sc.name }), ...(sc.hits === 2 && { hits: 2, flashBetween: !!sc.flash_between_hits }), ...cleanScreenSet(sc.screen_settings, `screen ${n + 1}`) }; });
  if (!inks.length) throw new Error("the separation.json has no colour screens");
  const base = spec.screens.find(isBase);
  return { settings: { ...s, screens: inks.length }, inks, underbase: !!base, ubSet: base ? cleanScreenSet(base.screen_settings, "underbase") : null };
}
