// @ts-check
// Film plan: which films to make, in what order, at what angle and mesh, and what separation.json says.
// Pure (no DOM), so the export path is tested in Node (check.mjs).
import { VERSION } from "./version.js";
import { cleanSizes, sizeSetting } from "./sizes.js";

/** @typedef {{ idx: number, name: string, ink?: string, lab: number[], ub?: boolean, curve?: number[] | null, set?: ScreenSet, order: number, angle: number, lpi?: number, mesh?: number, minDot?: number, code?: string, system?: string, process?: string, hits?: number, flashBetween?: boolean }} Plate */
/** What the shop sets on a screen for production, not for the separation: the name on its film (rename) and a double
 *  hit (print it twice, with or without a flash between the two strokes). Kept on the ink (or, for the underbase, in
 *  the job) and copied onto its plate, so every export reads the same values. */
/** @typedef {{ mesh?: number, lpi?: number, angle?: number }} ScreenSet  one screen's own mesh, LPI and angle */
/** @typedef {{ label?: string, hits?: number, flashBetween?: boolean } & ScreenSet} ScreenProd */

const WHITE = [96, 0, 1.5];

/* Mesh counts sold in the US (threads per inch). */
export const STOCK_MESH = [86, 110, 125, 156, 160, 180, 196, 200, 230, 255, 280, 305, 330, 355, 380];
/** Mesh for a halftone screen follows the LPI: 45 LPI → 230, 55 LPI → 280, a straight
 *  line of 5 mesh per LPI through those two points (65 → 330), never below 230 for colour tops, snapped to a stock count
 *  that is not a whole-number multiple of the LPI (moiré; Zoomer). Sources split at 45 LPI: 230 from Ortolani, blue moon,
 *  ScreenPrinting.com help, UltraSeps; 280–305 from Coudray. The underbase runs
 *  coarser: 156 at low LPI, 230 from 55 LPI. */
export const MESH_45 = 230, MESH_PER_LPI = 5;
export function meshFor(lpi, ub = false) {
  if (ub) return lpi >= 55 ? 230 : 156;
  const want = Math.max(MESH_45, MESH_45 + MESH_PER_LPI * (lpi - 45)), ok = STOCK_MESH.filter(m => m >= MESH_45 && Math.abs(m / lpi - Math.round(m / lpi)) > 0.08);
  return ok.reduce((b, m) => Math.abs(m - want) < Math.abs(b - want) ? m : b, ok[0]);
}
/** A highlight white: a colour screen as light as the underbase white (the shop may run it on its own mesh). */
export const isHighlightWhite = lab => lab[0] > 92;

/* ───────────── Shop and press profiles ─────────────
   A profile is a press as the shop runs it: mesh for each kind of screen, LPI, angle, film DPI, smallest and largest
   dot, dot gain, dot shape, press type and the press calibration. Kept in the browser (and the ADN account when signed
   in) and moved between computers as a JSON file. */
/** @typedef {{ base: number | null, color: number | null, white: number | null }} ProfileMesh */
/** @typedef {{ name: string, press: string, lpi: number, angle: number, dpi: number, gain: number, minDot: number, maxDot: number, dotShape: string, mirror: "right" | "mirror", setupMin: number, perHour: number, mesh: ProfileMesh, calib: any, formats?: Record<string, boolean>, sizes?: import("./sizes.js").SizeSetting, limits?: Record<string, number>, builtin?: boolean, source?: string, tested?: boolean }} Profile */
export const PROFILE_FORMAT = "adn-separation-table-profiles", PROFILE_SHAPES = ["round", "ellipse", "square", "line"];
/* the same limits as the controls (index.html) */
const PROFILE_NUM = { lpi: [20, 85], angle: [0, 90], dpi: [150, 1440], gain: [0, 50], minDot: [0, 20], maxDot: [80, 100] };
/** A checked copy of a profile, or an Error that says in plain words what is wrong. */
export function cleanProfile(p) {
  if (!p || typeof p !== "object") throw new Error("A profile is not an object.");
  const name = String(p.name ?? "").trim().slice(0, 60); if (!name) throw new Error("A profile has no name.");
  /** @type {any} */ const out = { name };
  if (p.press !== "manual" && p.press !== "automatic") throw new Error(`Profile "${name}": press must be manual or automatic.`);
  out.press = p.press;
  for (const [k, [lo, hi]] of Object.entries(PROFILE_NUM)) { const v = Number(p[k]);
    if (!Number.isFinite(v) || v < lo || v > hi) throw new Error(`Profile "${name}": ${k} must be a number from ${lo} to ${hi}.`); out[k] = v; }
  out.dotShape = p.dotShape ?? "round"; if (!PROFILE_SHAPES.includes(out.dotShape)) throw new Error(`Profile "${name}": dot shape must be one of ${PROFILE_SHAPES.join(", ")}.`);
  // film reading and the press time numbers; a profile saved before they were kept gets right reading and the press's defaults
  out.mirror = p.mirror ?? "right"; if (out.mirror !== "right" && out.mirror !== "mirror") throw new Error(`Profile "${name}": mirror must be right or mirror.`);
  const pt = PRESS_TIME[out.press];
  for (const [k, [lo, hi]] of /** @type {[string, [number, number]][]} */ ([["setupMin", [0, 240]], ["perHour", [1, 3000]]])) { const v = Number(p[k] ?? pt[k]);
    if (!Number.isFinite(v) || v < lo || v > hi) throw new Error(`Profile "${name}": ${k} must be a number from ${lo} to ${hi}.`); out[k] = v; }
  const m = p.mesh || {}; out.mesh = {};
  for (const k of ["base", "color", "white"]) { const v = m[k] == null || m[k] === "" ? null : Number(m[k]);
    if (v != null && !STOCK_MESH.includes(v)) throw new Error(`Profile "${name}": ${k} mesh ${m[k]} is not a stock mesh count (${STOCK_MESH.join(", ")}).`); out.mesh[k] = v; }
  out.calib = p.calib && typeof p.calib === "object" ? p.calib : null;
  // the film formats this press's RIP takes (a profile saved before has none: the job's checkboxes stay)
  if (p.formats != null) { if (typeof p.formats !== "object") throw new Error(`Profile "${name}": formats must be an object.`);
    out.formats = Object.fromEntries(FORMAT_KEYS.map(k => [k, !!p.formats[k]])); }
  // the shop's platen, film sheet and screen for this press (a profile saved before has none: the shop's sizes stay)
  if (p.sizes != null) { try { out.sizes = sizeSetting(cleanSizes(p.sizes)); } catch (e) { throw new Error(`Profile "${name}": ${e.message}`); } }
  // the pre-print check limits for this press (a profile saved before has the standard ones)
  out.limits = cleanLimits(p.limits, name);
  if (p.builtin) { out.builtin = true; out.source = String(p.source || ""); out.tested = !!p.tested; }
  return /** @type {Profile} */ (out);
}
/** Files a job can write (job.FORMATS has the defaults). */
export const FORMAT_KEYS = ["pdf", "tif", "png", "eps", "svg", "psd", "psdPreview", "dcs"];
/** Pre-print check limits a shop can set per press: [standard, lowest, highest]. checks.js reads job.limits. */
export const CHECK_LIMITS = { minPpi: [200, 100, 600], offCentreIn: [0.5, 0.1, 3], manualMaxLpi: [55, 35, 85], smallScreenPct: [0.5, 0, 5] };
export const limitDefaults = () => Object.fromEntries(Object.entries(CHECK_LIMITS).map(([k, [d]]) => [k, d]));
/** Check limits with every key, in range; a missing or empty one is the standard value. */
export function cleanLimits(l, name = "") {
  const out = limitDefaults(); if (l == null) return out; if (typeof l !== "object") throw new Error(`Profile "${name}": limits must be an object.`);
  for (const [k, [, lo, hi]] of Object.entries(CHECK_LIMITS)) { if (l[k] == null || l[k] === "") continue; const v = Number(l[k]);
    if (!Number.isFinite(v) || v < lo || v > hi) throw new Error(`${name ? `Profile "${name}": ` : ""}${k} must be a number from ${lo} to ${hi}.`); out[k] = v; }
  return out;
}

/* ───────────── Built-in press profiles ─────────────
   Starting points, each value from a published source or labelled as the Separation Table's own rule or estimate. None
   is press-tested (tested: false): print a test film (Shop setup, Test films) and save your own profile from it.
   Sources: the NOTICE file. */
const rule = "Separation Table rule";
const BUILTIN = /** @type {any[]} */ ([
  { name: "Manual press, 45 LPI", press: "manual", lpi: 45, angle: 22.5, dpi: 400, gain: 22, minDot: 6, maxDot: 92, dotShape: "round", mirror: "right", mesh: { base: 156, color: 230, white: null },
    source: "45 LPI on 230 mesh for colours on a manual press: UltraSeps film output settings (Roginski, 2015); 230 mesh for 45 LPI: The Shirt Board (blue moon, 2013) and ScreenPrinting.com help. 156 base: Impressions (Ortolani, 2014). Angle 22.5°, 400 DPI, 22% dot gain, 6% smallest and 92% largest dot: Separation Table defaults (estimates). Press time: Separation Table estimates." },
  { name: "Automatic press, 55 LPI", press: "automatic", lpi: 55, angle: 22.5, dpi: 400, gain: 22, minDot: 6, maxDot: 92, dotShape: "round", mirror: "right", mesh: { base: 230, color: 305, white: null },
    source: "Tops 280 to 305 mesh at 55 LPI: UltraSeps film output settings (Roginski, 2015); 305 mesh for 55 LPI: The Shirt Board (blue moon, 2013). Base 180 to 230: T-Biz (Fresener, 2018). Smallest dot 5 to 7% on 305 at 55 LPI: The Shirt Board (blue moon, 2018). Angle, DPI, dot gain and largest dot: Separation Table defaults (estimates)." },
  { name: "Automatic press, 65 LPI", press: "automatic", lpi: 65, angle: 22.5, dpi: 600, gain: 22, minDot: 6, maxDot: 92, dotShape: "round", mirror: "right", mesh: { base: 230, color: null, white: null },
    source: `65 LPI on an automatic press, tops 280 to 355, base 180 to 230: T-Biz (Fresener, 2018). Colour mesh follows the LPI (${rule}: 330 at 65 LPI, inside Fresener's range). 600 DPI, angle, dot gain and dot sizes: Separation Table defaults (estimates).` },
]);
/** The built-in profiles, checked like a saved one (a function: cleanProfile reads PRESS_TIME, defined further down). */
export const builtinProfiles = () => BUILTIN.map(p => cleanProfile({ ...p, builtin: true, tested: false }));

/* ───────────── Garment fabrics ─────────────
   What each fabric changes: the base ink, the cure and flash, and for fleece the choke and mesh. Dot gain: no published
   source gives a figure by fabric (searched 2026-11-14), so every fabric keeps the job's dot gain. Each line names its
   source (FABRIC_SOURCES, also in NOTICE). choke: the fabric's choke in mm, or null to keep the press's. */
export const FABRIC_SOURCES = {
  wilflexPoly: "Avient Wilflex Epic Polywhite LC technical data sheet, V3.04, 2023",
  wilflexCure: "Avient Wilflex Ink Curing Tips, 2020",
  wilflexGuide: "Avient Wilflex Product Selection Guide, 2024",
  rutland: "Rutland Ink Guide (Avient)",
  icLB: "International Coatings 741 Ultra LB White technical data sheet, 2011",
  laster: "Impressions magazine, Fewer Problems with Poly (Laster, 2020)",
  heather: "ScreenPrinting.com, The 4 most common types of t-shirts (Wedman, 2023)",
  fleece: "Impressions magazine, Screen Printing on Fleece (Ortolani, 2014)",
  colin: "The Shirt Board, fleece choke (Colin, Ryonet, 2014)",
};
/** @typedef {{ name: string, base: string, cure: string, flash: string, choke: number | null, note: string, src: (keyof typeof FABRIC_SOURCES)[] }} Fabric */
/** @type {Record<string, Fabric>} */
export const FABRICS = {
  cotton: { name: "100% cotton", base: "Standard white plastisol base.", cure: "Standard plastisol cures at 320 °F (160 °C).", flash: "", choke: null,
    note: "Cotton has no dye bleed: standard 320 °F inks.", src: ["wilflexGuide", "rutland", "wilflexCure"] },
  blend: { name: "50/50 cotton-poly", base: "Low-bleed white base.", cure: "Low-cure ink: 270 to 320 °F (132 to 160 °C), not 320 °F.", flash: "", choke: null,
    note: "The polyester can bleed dye into the ink when it gets hot.", src: ["laster", "wilflexCure", "rutland"] },
  triblend: { name: "Tri-blend", base: "Low-bleed white base (rated for tri-blends).", cure: "Low-cure ink: 270 to 320 °F (132 to 160 °C). Dye starts to migrate at about 270 °F.", flash: "", choke: null,
    note: "Polyester content: use low-cure ink and keep the dryer cool.", src: ["wilflexPoly", "laster"] },
  poly: { name: "100% polyester", base: "Low-bleed poly white base. On sublimated (dyed) poly, print a gray or black bleed blocker first.", cure: "Low cure: 280 °F (138 °C) is recommended; range 270 to 320 °F. Some low-bleed whites fuse at 325 °F: follow your ink's sheet.",
    flash: "Flash at about 220 °F (105 °C), 2 to 3 seconds.", choke: null, note: "Poly white: 86 to 180 mesh.", src: ["wilflexPoly", "wilflexCure", "icLB", "rutland"] },
  heather: { name: "Heather", base: "Low-bleed white base: heathers have polyester in them, and dark heathers bleed more.", cure: "Low-cure ink: 270 to 320 °F (132 to 160 °C).", flash: "", choke: null,
    note: "", src: ["laster", "heather", "rutland"] },
  fleece: { name: "Fleece", base: "White base on 156 mesh, colors on 230.", cure: "", flash: "Keep flashes short: about 6 seconds.", choke: 0.35,
    note: "Choke the base at least 0.35 mm: the fibres lift the base past the colors.", src: ["fleece", "colin"] },
};
export const FABRIC_KEYS = Object.keys(FABRICS);
/** The settings a fabric sets (the rest come from the press and the job). Settings a caller set by hand win. */
export function fabricSettings(fabric) { const f = FABRICS[fabric]; return f && f.choke != null ? { choke: f.choke } : {}; }
/** The fabric's lines for the job sheet and separation.json. */
export function fabricText(fabric) { const f = FABRICS[fabric]; return f ? [f.base, f.cure, f.flash, f.note].filter(Boolean).join(" ") : ""; }

/** "Name", or "Name (2)", "Name (3)"… when the name is taken. */
export function uniqueName(name, taken) { if (!taken.includes(name)) return name; let k = 2; while (taken.includes(`${name} (${k})`)) k++; return `${name} (${k})`; }
/** The JSON file a shop exports and imports. */
export function profilesToJSON(list) { return JSON.stringify({ format: PROFILE_FORMAT, version: 1, profiles: list.map(cleanProfile) }, null, 2); }
/** Profiles from an exported file. Throws a plain-English Error for a file that is not one. */
export function profilesFromJSON(text) {
  let d; try { d = JSON.parse(text); } catch { throw new Error("This file is not JSON. Choose a profiles file exported from Separation Table."); }
  if (!d || d.format !== PROFILE_FORMAT || !Array.isArray(d.profiles)) throw new Error("This JSON file is not a Separation Table profiles file.");
  if (!d.profiles.length) throw new Error("This profiles file has no profiles in it.");
  return d.profiles.map(cleanProfile);
}
/** Add imported profiles to a list: a name already in the list gets a number, nothing is overwritten. */
export function mergeProfiles(list, add) { const out = [...list]; for (const p of add) out.push({ ...p, name: uniqueName(p.name, out.map(q => q.name)) }); return out; }

/** A plain name for a colour, from its sRGB: hue word from the HSV hue, with light, dark, pale or bright. */
export function colorName(rgb) {
  const [r, g, b] = rgb.map(v => Math.max(0, Math.min(255, v)) / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b), c = mx - mn, s = mx ? c / mx : 0;
  if (s < 0.15 || c < 0.06) return mx > 0.9 ? "white" : mx < 0.15 ? "black" : mx > 0.65 ? "light gray" : mx < 0.35 ? "dark gray" : "gray";
  const h = (c === 0 ? 0 : mx === r ? ((g - b) / c + 6) % 6 : mx === g ? (b - r) / c + 2 : (r - g) / c + 4) * 60;
  /** @type {[number, string][]} */ const HUES = [[12, "red"], [40, "orange"], [65, "yellow"], [90, "lime"], [150, "green"], [175, "turquoise"], [195, "cyan"], [215, "sky blue"], [250, "blue"], [280, "violet"], [300, "purple"], [330, "magenta"], [348, "pink"], [360, "red"]];
  const hue = (HUES.find(([u]) => h < u) || HUES[0])[1];
  if (mx < 0.65 && s > 0.4 && h >= 12 && h < 50) return mx < 0.3 ? "dark brown" : "brown";
  const tone = mx < 0.4 ? "dark " : s < 0.4 && mx > 0.8 ? "pale " : s > 0.8 && mx > 0.9 ? "bright " : mx > 0.85 && s < 0.6 ? "light " : "";
  return tone + hue;
}
/** The smallest feature a mesh holds, in thread pitches (1 / mesh in): a dot or a line must span about this much. */
export const MESH_HOLD = 1.5;
/** Smallest dot the mesh can hold: the dot must span about 1.5 thread pitches (matches 5% at 55 LPI on 305 and about
 *  15% on a 156 base at 45 LPI from shop reports). Area fraction of a round dot of diameter 1.5/mesh in a 1/LPI cell. */
export function minDotFor(lpi, mesh) { const d = MESH_HOLD * lpi / mesh; return Math.min(0.3, Math.PI / 4 * d * d); }
/** Press registration: an automatic holds about 0.05 mm, a manual about 0.15–0.25 mm (Coudray). Expressed as the
 *  overlap behaviour films are compensated for (0 stacked dots, 1 random) and the spread scored by the robust metric. */
export const PRESS = { automatic: { rho: 0.3, rhos: [0, 0.3, 0.6], mm: 0.05 }, manual: { rho: 0.6, rhos: [0, 0.5, 1], mm: 0.2 } };

/** A screen's own mesh, LPI and angle, the ones given: mesh a stock count, LPI and angle in the job's ranges. Throws an
 *  Error that names the valid values. null or undefined: the job's value. @returns {ScreenSet | null} */
export const SCREEN_SET = { lpi: [20, 85], angle: [0, 90] };
export function cleanScreenSet(s, where = "screen") {
  if (s == null) return null; if (typeof s !== "object") throw new Error(`${where}: mesh, lpi and angle must be an object`);
  /** @type {any} */ const out = {};
  if (s.mesh != null) { const v = Number(s.mesh); if (!STOCK_MESH.includes(v)) throw new Error(`${where}: mesh ${s.mesh} is not a stock mesh count. Valid: ${STOCK_MESH.join(", ")}`); out.mesh = v; }
  for (const [k, [lo, hi]] of Object.entries(SCREEN_SET)) if (s[k] != null) { const v = Number(s[k]);
    if (typeof s[k] === "boolean" || !Number.isFinite(v) || v < lo || v > hi) throw new Error(`${where}: ${k} ${s[k]} is out of range. Valid: ${lo} to ${hi}`); out[k] = v; }
  return Object.keys(out).length ? out : null;
}
/**
 * Films for an ink set. Plate idx always refers to the coverage arrays of THIS ink set (the underbase is idx = inks.length).
 * @param {({ name: string, lab: number[], code?: string, system?: string, process?: string } & ScreenProd)[]} inks
 * @param {boolean} hasUB
 * @param {{ screening: string, angle: number, lpi?: number, method?: string, library?: { lab: number[] }[], calib?: { inks: Record<string, { curve: number[] }> } | null, mesh?: ProfileMesh | null, ub?: ScreenProd }} o
 * @returns {Plate[]}
 */
export function platesFor(inks, hasUB, o) {
  const meshOf = p => (o.mesh && (p.ub ? o.mesh.base : isHighlightWhite(p.lab) ? o.mesh.white : o.mesh.color)) || meshFor(lpi, !!p.ub);
  const N = inks.length, base = o.angle, list = [];
  // Rotated: six angles 15° apart (as far apart as 90° allows). Past six screens the angles repeat: two screens at the
  // SAME angle make no moiré, while two at 7.5° make a coarse one (period ≈ 1 / (2·LPI·sin 3.75°): 4.3 mm at 45 LPI).
  const ROT = [base, base + 30, base + 60, base - 15, base + 15, base + 45];
  if (hasUB) list.push({ ub: true, idx: N, ...prodOf("Underbase", o.ub), lab: ((o.library || []).find(i => i.lab[0] > 92) || { lab: WHITE }).lab });
  inks.forEach((k, i) => list.push({ idx: i, ...prodOf(k.name, k), lab: k.lab, code: k.code || "", system: k.system || "", ...(k.process && { process: k.process }), curve: o.calib && o.calib.inks[k.name] ? o.calib.inks[k.name].curve : null }));
  const lpi = o.lpi || 45, ma = o.method ? methodAngles(list, o.method) : null;
  // a screen's own mesh, LPI and angle (set_screen) win over the job's and the method's
  return list.map((p, j) => { const set = p.set, mesh = set && set.mesh || meshOf(p), m = ma && ma[j];
    const angle = set && set.angle != null ? set.angle : m ? m.angle : o.screening === "rotated" ? ((ROT[j % ROT.length] % 90) + 90) % 90 : base;
    const own = set && set.lpi ? set.lpi : m && m.lpi ? Math.round(lpi * m.lpi * 10) / 10 : null;
    return { ...p, order: j + 1, angle, ...(own && { lpi: own }), mesh, minDot: minDotFor(own || lpi, mesh) }; });
}

/** A screen's film name and hits: the shop's name if it gave one (ink keeps its own name for calibration and the
 *  library), and 1 or 2 hits. */
export const NAME_MAX = 40;
export function cleanName(v) { return String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, NAME_MAX); }
function prodOf(name, s) {
  const label = cleanName(s && s.label), hits = s && s.hits === 2 ? 2 : 1, set = s ? cleanScreenSet({ mesh: s.mesh, lpi: s.lpi, angle: s.angle }) : null;
  return { name: label || name, ...(label && label !== name && { ink: name }), hits, flashBetween: hits === 2 && !!(s && s.flashBetween), ...(set && { set }) };
}

/* Standard screen angles per print method (The Print Guide, "Halftone screen angles", 2009):
   - 1 ink (single colour / grayscale): 45°, the least visible angle; a base under it on a dark shirt takes 75°.
   - duotone: darkest ink 45°, the other 75° (30–45° apart); a base takes 15°.
   - tritone: darkest 45°, middle 75°, lightest 15°; a base takes 0°.
   - CMYK (U.S. standard): C 15°, M 75°, Y 0°, K 45°, yellow at about 108% of the line count to dodge moiré.
   Ink plates are ranked by lightness (CIELAB L*), darkest first; CMYK plates are found by their process letter.
   Returns one { angle, lpi? } per plate (lpi is a factor on the job's line count), or null if the method has no rule. */
export const TONE_ANGLES = [45, 75, 15], TONE_BASE = { 1: 75, 2: 15, 3: 0 }, CMYK_ANGLES = { C: 15, M: 75, Y: 0, K: 45 }, YELLOW_LPI = 1.08;
export function methodAngles(plates, method) {
  // a highlight white (CMYK on a dark shirt) shares the base's angle: white on white, so no moiré between them
  if (method === "cmyk") return plates.map(p => { const k = p.process || p.code; return p.ub || (!k && p.lab && p.lab[0] > 92) ? { angle: 30 } : k in CMYK_ANGLES ? { angle: CMYK_ANGLES[k], ...(k === "Y" && { lpi: YELLOW_LPI }) } : { angle: 45 }; });
  const n = { mono: 1, duo: 2, tri: 3 }[method]; if (!n) return null;
  const inks = plates.filter(p => !p.ub).slice().sort((a, b) => a.lab[0] - b.lab[0]), rank = new Map(inks.map((p, i) => [p, i]));
  return plates.map(p => ({ angle: p.ub ? TONE_BASE[Math.min(3, inks.length)] ?? 0 : TONE_ANGLES[rank.get(p) % TONE_ANGLES.length] }));
}

/** Film label printed in the margin. */
export function filmLabel(p, { mode, screening, lpi, dpi, last = false, shape = "round", mirror = false }) {
  const how = mode !== "sim" ? "SOLID" : screening === "fm" ? "INDEX" : `${p.lpi || lpi} LPI ${p.angle}°${shape && shape !== "round" ? ` ${shape.toUpperCase()} DOT` : ""}${screening === "lock" && !p.ub ? " INTERLOCKED" : ""}`;
  // what follows this screen on press: the base is flashed, the last screen is cured (printed on the film, not in the app)
  const hits = p.hits === 2 ? (p.flashBetween ? "  PRINT 2X, FLASH BETWEEN" : "  PRINT 2X") : "";
  const then = last ? "  THEN CURE" : p.ub ? "  THEN FLASH" : "";
  // a mirrored film carries the whole label mirrored too: it reads the right way through the film, emulsion down
  return `${p.order}. ${p.name.toUpperCase()}  L${p.lab.map(v => v.toFixed(0)).join("/")}  ${how}  ${dpi} DPI${hits}${then}${mirror ? "  MIRRORED" : ""}`;
}
/** Flashes per print: after the base (unless it is the last screen), and between the two hits of a double hit. */
export function flashesFor(plates) { const n = plates.length; return plates.reduce((s, p) => s + (p.ub && p.order < n ? 1 : 0) + (p.hits === 2 && p.flashBetween ? 1 : 0), 0); }
/** Screens to burn for one plate: a double hit with a flash between needs a second screen on an automatic (the flash
 *  sits between two heads); on a manual press, and wet on wet, the same screen is printed twice. */
export const screensFor = (p, press) => p.hits === 2 && p.flashBetween && press === "automatic" ? 2 : 1;

/* Press time for quoting. An estimate from two shop numbers kept with the press: setup minutes for each screen
   (mount, register, test print) and prints per hour for a running job on that press. The starting values are typical,
   from published sources, not measured (the medians of 13 sources:
   manual setup 2.5-10 min, 40-100 prints an hour; automatic setup 5-9 min, 300-800 an hour). Set them to the shop's
   own times. A double hit is counted and shown. A flash on a manual press slows the run: the printer waits for it,
   so a job with a flash runs at MANUAL_FLASH_RATE of the prints an hour (the 0.67 of the same research). */
export const PRESS_TIME = { manual: { setupMin: 5, perHour: 60 }, automatic: { setupMin: 7.5, perHour: 500 } };
export const MANUAL_FLASH_RATE = 0.67;
export function pressTime({ plates, shirts, press = "manual", setupMin, perHour }) {
  const d = PRESS_TIME[press] || PRESS_TIME.manual, su = Number.isFinite(setupMin) && setupMin >= 0 ? setupMin : d.setupMin, ph = Number.isFinite(perHour) && perHour > 0 ? perHour : d.perHour;
  const screens = plates.reduce((s, p) => s + screensFor(p, press), 0), strokes = plates.reduce((s, p) => s + (p.hits === 2 ? 2 : 1), 0), flashes = flashesFor(plates);
  const rate = press === "manual" && flashes > 0 ? ph * MANUAL_FLASH_RATE : ph, n = Math.max(1, Math.round(shirts) || 1), setup = screens * su, runMin = n / rate * 60;
  return { press, shirts: n, screens, strokes, flashes, setup_min_per_screen: su, prints_per_hour: ph, prints_per_hour_run: Math.round(rate), setup_min: Math.round(setup), run_min: Math.round(runMin), total_min: Math.round(setup + runMin), estimate: true };
}
/** The press time in one line, for the job sheet and the page. */
export function pressTimeText(t) {
  return `Press time, estimate: about ${hoursMin(t.total_min)} for ${t.shirts} prints. Setup ${t.screens} screen${t.screens === 1 ? "" : "s"} x ${t.setup_min_per_screen} min = ${hoursMin(t.setup_min)}. Run at ${t.prints_per_hour_run ?? t.prints_per_hour} an hour${t.prints_per_hour_run != null && t.prints_per_hour_run !== t.prints_per_hour ? ` (${t.prints_per_hour} with no flash; a manual press waits for the flash)` : ""} = ${hoursMin(t.run_min)}. Each print: ${t.strokes} stroke${t.strokes === 1 ? "" : "s"}, ${t.flashes} flash${t.flashes === 1 ? "" : "es"}.`;
}
/** "2 h 5 min" */
export const hoursMin = m => { m = Math.round(m); const h = Math.floor(m / 60), r = m % 60; return h ? `${h} h${r ? ` ${r} min` : ""}` : `${r} min`; };

/** File name stem for a plate ("03-royal"). */
export const plateSlug = p => `${String(p.order).padStart(2, "0")}-${p.name.replace(/\W+/g, "-").toLowerCase()}`;

/**
 * separation.json for an export.
 * @param {{ plates: Plate[], result: { covPct: number[], ubPct: number, stats: Record<string, number> }, mode: string, garment: { hex: string, lab: number[], fabric?: string, fabric_notes?: string }, profile?: { name: string, changed?: boolean, builtin?: boolean, source?: string } | null,
 *   print: { width_in: number, dpi: number, lpi: number, screening: string, angle: number, dot_gain_50: number, min_dot: number, scatter_small_dots?: boolean, max_dot: number, choke_mm: number, choke_px: number, index_dpi: number, stack_limit_pct?: number, press?: string, dot_shape?: string, mirror?: boolean, film_reading?: string },
 *   model: { yule_nielsen_n: number, calibrated: boolean, calibration_residual_de00: number | null }, targets: { label: string, lab: number[], tier: number }[], created?: string, method?: string, pressTime?: object, imported?: object | null }} a
 */
export function specFor(a) {
  const fm = a.print.screening === "fm", n = a.plates.length;
  return {
    tool: "ADN Separation Table", version: VERSION, created: a.created || new Date().toISOString(), separation: a.mode, method: a.method || null,
    garment: { hex: a.garment.hex, lab: a.garment.lab.map(v => +v.toFixed(2)), ...(a.garment.fabric && { fabric: a.garment.fabric, fabric_notes: a.garment.fabric_notes }) }, print: a.print, model: a.model,
    profile: a.profile ? { name: a.profile.name, changed: !!a.profile.changed, ...(a.profile.builtin && { built_in: true, source: a.profile.source, press_tested: false }) } : undefined,
    fidelity: Object.fromEntries(Object.entries(a.result.stats).map(([k, v]) => [k, +(+v).toFixed(3)])),
    press_time: a.pressTime || undefined, imported: a.imported || undefined, flashes_per_print: flashesFor(a.plates),
    screens: a.plates.map(p => ({ order: p.order, name: p.name, ...(p.ink && { ink: p.ink }), file: plateSlug(p), ...(p.ub && { underbase: true }), hits: p.hits || 1, flash_between_hits: !!p.flashBetween, lab: p.lab.map(v => +v.toFixed(2)), angle: a.mode === "sim" && !fm ? p.angle : null, ...(p.lpi && { lpi: p.lpi }),
      coverage: +(p.ub ? a.result.ubPct : a.result.covPct[p.idx]).toFixed(4), mesh: p.mesh || meshFor(a.print.lpi, !!p.ub), min_dot_pct: p.minDot != null ? +(p.minDot * 100).toFixed(1) : null, flash: !!(p.ub && p.order < n), cure: p.order === n, ...(p.set && { screen_settings: p.set }) })),
    color_targets: a.targets.map(t => ({ requested: t.label, lab: t.lab, tolerance_cmc_2_1: t.tier, condition: "D65/10° as supplied by the user" })),
    notes: "Color names are recorded as the creator wrote them. No PANTONE® data is included. Verify critical colors with a printed, measured drawdown.",
  };
}

/** Consistency check run before writing any files: every plate must point at real coverage for its ink set. */
export function checkPlan(plates, result) {
  const N = result.covPct.length, errs = [];
  plates.forEach((p, j) => {
    if (p.order !== j + 1) errs.push(`plate ${j} has order ${p.order}`);
    if (p.ub ? p.idx !== N : (p.idx < 0 || p.idx >= N)) errs.push(`plate ${p.name} points at screen ${p.idx} of ${N}`);
  });
  if (plates.filter(p => !p.ub).length !== N) errs.push(`${plates.filter(p => !p.ub).length} color films for ${N} separated inks`);
  return errs;
}

/* Ink to mix per screen for a run. Deposits are estimates for plastisol (grams per square inch at full coverage):
   about 0.035 for colors on 280–305 mesh, 0.05 for highlight white, 0.07 for the base on 156–230 mesh, plus about 15%
   waste and 120 g to flood and fill each screen. They are starting points: weigh a test batch and adjust. */
export const DEPOSIT = { color: 0.035, white: 0.05, base: 0.07, waste: 0.15, perScreen: 120 };
export function inkGrams({ areaIn2, coverage, shirts, kind = "color", hits = 1, screens = 1 }) {
  const g = areaIn2 * coverage * DEPOSIT[kind] * shirts * hits * (1 + DEPOSIT.waste) + DEPOSIT.perScreen * screens;
  return Math.round(g / 10) * 10;
}
/** Mix sheet rows: what a producer needs per screen to match and mix the ink with their own Pantone guide and
 *  mixing system. requested: the creator's color target closest to this ink (CMC ≤ 3), if any. */
export function mixRows({ plates, covPct, ubPct, areaIn2, shirts, targets = [], cmc, press = "manual" }) {
  return plates.map(p => {
    const kind = p.ub ? "base" : p.lab[0] > 92 ? "white" : "color", cov = p.ub ? ubPct : covPct[p.idx];
    let req = null, best = Infinity;
    if (cmc && !p.ub) for (const t of targets) { const d = cmc(t.lab, p.lab); if (d < best && d <= 3) { best = d; req = t.label; } }
    return { order: p.order, name: p.name, ub: !!p.ub, code: p.code || "", system: p.system || "", lab: p.lab.map(v => +v.toFixed(1)), coverage: +(cov * 100).toFixed(1),
      grams: inkGrams({ areaIn2, coverage: cov, shirts, kind, hits: p.hits === 2 ? 2 : 1, screens: screensFor(p, press) }), requested: req, mesh: p.mesh, hits: p.hits || 1, flashBetween: !!p.flashBetween };
  });
}

/** Nearest stock ink in each brand catalog: a starting bucket for the producer when no formula is at hand.
 *  catalogs: [{ system, inks: [{ name, code, lab }] }]; de: color difference. Keeps matches within maxDE. */
export function nearestStock(lab, catalogs, de, maxDE = 10) {
  const out = [];
  for (const c of catalogs) {
    let best = null;
    for (const k of c.inks) { const d = de(lab, k.lab); if (!best || d < best.de) best = { system: c.system, code: k.code || "", name: k.name, de: d }; }
    if (best && best.de <= maxDE) out.push({ ...best, de: +best.de.toFixed(1) });
  }
  return out.sort((a, b) => a.de - b.de);
}

/* Print rating, 1.0–5.0 stars, from the numbers the bench already measures.
   Base: the on-press score (ΔE00 with screens moving) on a scale set by common ΔE conventions:
   1 or less → 5, 2 → 4, 4 → 3, 6 → 2, 10 or more → 1, straight lines between.
   Then −0.5 at most when the share of the design inside garment tolerance (CMC 2:1 < 2) falls from 85% to 50%,
   and −0.3 for each pre-print check that fails. Shown to one decimal. */
export function starsFromDE(d) {
  const pts = [[0, 5], [1, 5], [2, 4], [4, 3], [6, 2], [10, 1]];
  if (d >= 10) return 1;
  for (let i = 1; i < pts.length; i++) if (d <= pts[i][0]) { const [x0, y0] = pts[i - 1], [x1, y1] = pts[i]; return y0 + (y1 - y0) * (d - x0) / (x1 - x0); }
  return 1;
}
export function printRating({ onPress, aligned, inTol, failedChecks = 0 }) {
  const base = starsFromDE(onPress), tol = -0.5 * Math.max(0, Math.min(1, (0.85 - inTol) / 0.35)), checks = -0.3 * failedChecks;
  const stars = Math.round(Math.max(1, Math.min(5, base + tol + checks)) * 10) / 10;
  return { stars, base, tol, checks, alignedStars: starsFromDE(aligned) };
}

/* Screen count. Auto is not capped, but it must be good enough that a shop can run fewer screens; 9 is the
   usual normal limit". Each screen costs the printer a screen, a setup and a press head. 9 screens, colours and the
   underbase together, is the usual most. Auto stays uncapped, but a screen past 9 must be clearly worth it: in the mix
   search (pipeline.searchPlan) a screen costs SCREEN_COST (0.3 ΔE00 on press) up to 9, and double past 9.
   (2026-11-13 to 11-17 the search judged in stars, 0.05 a screen and 0.15 past 9.) */
export const USUAL_SCREENS = 9;
