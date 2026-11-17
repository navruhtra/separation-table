// @ts-check
// Pre-print checks: what a printer should fix before burning screens. Pure (no DOM): the page, check.mjs, a CLI or an
// agent call preflightChecks on plain data and get the same list the page shows.
import { rgb2lab, rgb2hex, de2000, lab2rgb, solidDetail } from "./engine.js";
import { colorName, meshFor, minDotFor, MESH_HOLD, limitDefaults, CHECK_LIMITS as PLAN_LIMITS } from "./plan.js";
import { SIZE_NAME, FILM_MARGIN_IN } from "./sizes.js";
import { GAMUT_DE } from "./pipeline.js";

/** @typedef {"error" | "warning" | "note"} Severity
 *  error: the print comes out wrong as set up. warning: it prints, worse than it could. note: a choice to review. */
/** @typedef {{ x: number, y: number, w: number, h: number }} Box  fractions (0–1) of the art's width and height */
/** @typedef {{ box: Box, mask: string }} Region  mask: a reference regionMask resolves to the pixels themselves */
/** @typedef {{ action: string, label: string }} Fix  the first fix is the main one */
/** @typedef {{ hex: string, name: string, area: number, de: number, near: { name: string, de: number } | null, region?: Region }} GamutColor */
/** @typedef {{ id: string, severity: Severity, title: string, detail: string, measured: string, limit: string, fix: Fix[], region?: Region, colors?: GamutColor[], help?: string }} Check
 *  help: the help.js entry that explains the check */
/** @typedef {{ name: string, idx: number, ub?: boolean }} PlateRef */
/**
 * @typedef {{
 *   art?: { W: number, sample?: boolean, background?: string | null } | null,
 *   widthIn?: number, lpi: number, press: "manual" | "automatic", mode: "sim" | "spot" | "index", screening?: string,
 *   method?: string | null, screens?: number, inkSource?: "art" | "library", shelfSize?: number, stackLimit: number,
 *   plates: PlateRef[], preview?: { W: number, H: number, alpha: ArrayLike<number>, lab: ArrayLike<number> } | null,
 *   sizes?: import("./sizes.js").Sizes | null, gain?: number, minDot?: number, mesh?: number, choke?: number, driftMm?: number,
 *   solidDetail?: boolean, limits?: Limits | null
 * }} Job
 * art.W: the art file's pixel width; art.background: solidBackground() of the art. preview: the image the separation
 * read (result arrays are at its size); without it the checks carry no regions and the size, centre, line and gap
 * checks do not run. sizes: the shop's platen, film and screen (sizes.cleanSizes). gain: dot gain at 50% (0.22 = 22%).
 * minDot: the smallest dot (0.06 = 6%). mesh: the colour screens' mesh, default plan.meshFor(lpi). choke: the underbase
 * choke, mm; driftMm: how far the press's screens drift (plan.PRESS). solidDetail: thin line work prints solid (the
 * engine's solid detail pass). limits: the shop's check limits for this press (plan.CHECK_LIMITS: the settings, a profile, sep --check-limits),
 * standard when missing.
 * preview.px: its sRGB (3 per pixel), for the thin line check.
 */
/** @typedef {Partial<Record<"minPpi" | "offCentreIn" | "manualMaxLpi" | "smallScreenPct", number>>} Limits */
/** @typedef {{ covPct: number[], ubPct?: number, stats: { stackP99: number }, gamut?: { lab: number[], rgb: number[], area: number, de: number, near: { name: string, de: number } | null }[] | null, cov?: ArrayLike<number>, ub?: ArrayLike<number> | null, stackMap?: ArrayLike<number>, inks?: { lab: number[] }[], solid?: any }} Result
 *  ub: the underbase coverage (0–1) for each preview pixel */

export const MIN_PPI = 200, SMALL_SCREEN = 0.005, STACK_ALLOW = 0.05, MANUAL_MAX_LPI = 55, MIN_LPI = 30, INDEX_MIN_COLORS = 6, MAX_SCREENS = 12;
export const SEVERITY_ORDER = { error: 0, warning: 1, note: 2 };
/** Check thresholds a shop may set (sep --check-limits, MCP set_options limits): name → key, default, range, unit.
 *  The default and range are plan.CHECK_LIMITS's, the same the page's Shop setup and a profile take. */
export const CHECK_LIMITS = Object.fromEntries(/** @type {[string, string, string][]} */ ([["min-ppi", "minPpi", "ppi at print width"],
  ["small-screen", "smallScreenPct", "percent of the design"], ["manual-max-lpi", "manualMaxLpi", "LPI on a manual press"],
  ["off-centre", "offCentreIn", "inches off the centre"]]).map(([n, key, unit]) => { const [def, lo, hi] = PLAN_LIMITS[key]; return [n, { key, def, range: [lo, hi], unit }]; }));
/** "min-ppi=250,small-screen=1" (or an object of the same names) → Limits, or an Error that lists the valid names and
 *  ranges. */
export function parseLimits(v) {
  const pairs = typeof v === "string" ? v.split(",").map(t => t.trim()).filter(Boolean).map(t => { const [k, x] = t.split("="); if (x === undefined) throw new Error(`check limit "${t}" needs name=value. Limits: ${limitList()}`); return [k.trim(), x.trim()]; })
    : v && typeof v === "object" && !Array.isArray(v) ? Object.entries(v) : null;
  if (!pairs) throw new Error(`check limits must be name=value pairs. Limits: ${limitList()}`);
  /** @type {Limits} */ const out = {};
  for (const [k, x] of pairs) { const d = CHECK_LIMITS[k]; if (!d) throw new Error(`no check limit "${k}". Limits: ${limitList()}`);
    const n = Number(x); if (x === "" || !Number.isFinite(n) || n < d.range[0] || n > d.range[1]) throw new Error(`check limit ${k} "${x}" is out of range. Valid: ${d.range[0]} to ${d.range[1]} (${d.unit})`);
    out[d.key] = n; }
  return out;
}
const limitList = () => Object.entries(CHECK_LIMITS).map(([k, d]) => `${k} (${d.range[0]} to ${d.range[1]} ${d.unit}, default ${d.def})`).join(", ");
/** Pixels a region marks: a screen with at least this much coverage; colours within GAMUT_GROUP ΔE00 of a gamut colour
 *  (the grouping radius gamutGaps uses); art within BG_DE of a solid background (the garment-match cut it uses). */
const SCREEN_MARK = 0.02, GAMUT_GROUP = 12, BG_DE = 6;

/** An opaque, near-uniform border that differs from the garment: a background box that would print. Returns its hex or null. */
export function solidBackground(rgba, W, H, garmentLab) {
  const px = [];
  for (let i = 0; i < 400; i++) { const t = i / 400, pts = [[t * (W - 1), 0], [t * (W - 1), H - 1], [0, t * (H - 1)], [W - 1, t * (H - 1)]]; for (const [x, y] of pts) px.push((Math.round(y) * W + Math.round(x)) * 4); }
  if (px.some(o => rgba[o + 3] < 250)) return null;
  const m = [0, 1, 2].map(c => px.reduce((s, o) => s + rgba[o + c], 0) / px.length);
  const sd = Math.sqrt(px.reduce((s, o) => s + [0, 1, 2].reduce((q, c) => q + (rgba[o + c] - m[c]) ** 2, 0), 0) / px.length / 3);
  if (sd > 8) return null;
  const lab = rgb2lab(m[0], m[1], m[2]); if (de2000(...lab, ...garmentLab) < 6) return null; // matches the garment: the separation leaves it unprinted
  return rgb2hex(m.map(Math.round));
}

/** The art with a solid background (solidBackground's hex) knocked out: pixels within BG_DE of it that join the edge
 *  become transparent (a flood fill from the border, so the same colour inside the design stays). Returns new RGBA. */
export function knockOutBackground(rgba, W, H, hex) {
  const t = rgb2lab(parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)), out = new Uint8ClampedArray(rgba), seen = new Uint8Array(W * H), stack = [];
  const near = q => rgba[q * 4 + 3] > 0 && de2000(...rgb2lab(rgba[q * 4], rgba[q * 4 + 1], rgba[q * 4 + 2]), ...t) < BG_DE;
  const push = q => { if (!seen[q]) { seen[q] = 1; if (near(q)) stack.push(q); } };
  for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); } for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
  while (stack.length) { const q = stack.pop(), x = q % W, y = (q - x) / W; out[q * 4 + 3] = 0;
    if (x > 0) push(q - 1); if (x < W - 1) push(q + 1); if (y > 0) push(q - W); if (y < H - 1) push(q + W); }
  return out;
}
/** The pixels a region reference marks, at the preview's size (1 = marked), or null when the data is missing.
 *  References: "screen:<idx>", "stack", "gamut:<k>", "gamut" (every gamut colour), "background:<hex>",
 *  "oversize:<platen|film|screen>" (the design past that size), "ink" (the whole design), "thin:<idx>" (that screen's
 *  thin lines), "reverse" (the open gaps that fill in), "halo" (base edges that can show), "speck:<idx>" (that screen's
 *  detail too small to hold), "dots" (thin line work that prints as dots). */
export function regionMask(ref, job, result) {
  const pv = job.preview; if (!pv) return null; const P = pv.W * pv.H, out = new Uint8Array(P), [kind, arg] = ref.split(":");
  if (kind === "oversize") return sizeMask(arg, job);
  if (kind === "ink") { for (let q = 0; q < P; q++) out[q] = pv.alpha[q] >= 128 ? 1 : 0; return out; }
  if (kind === "thin" || kind === "reverse") return thinMask(ref, job, result);
  if (kind === "halo") return haloMask(job, result);
  if (kind === "speck") return speckMask(+arg, job, result);
  if (kind === "dots") return dotLineMask(job, result);
  if (kind === "screen") { const cov = result.cov, N = result.covPct.length, i = +arg; if (!cov || cov.length !== P * N) return null;
    for (let q = 0; q < P; q++) if (pv.alpha[q] >= 128 && cov[q * N + i] >= SCREEN_MARK) out[q] = 1; return out; }
  if (kind === "stack") { const s = result.stackMap; if (!s || s.length !== P) return null; const t = (job.stackLimit + STACK_ALLOW) * 50;
    for (let q = 0; q < P; q++) if (s[q] > t) out[q] = 1; return out; }
  /** @type {number[][]} */ const labs = kind === "gamut" ? (result.gamut || []).filter((_, k) => arg == null || k === +arg).map(g => g.lab)
    : kind === "background" ? [rgb2lab(parseInt(arg.slice(1, 3), 16), parseInt(arg.slice(3, 5), 16), parseInt(arg.slice(5, 7), 16))] : [];
  if (!labs.length || !pv.lab || pv.lab.length !== P * 3) return null; const r = kind === "gamut" ? GAMUT_GROUP : BG_DE, L = pv.lab;
  for (let q = 0; q < P; q++) { if (pv.alpha[q] < 128) continue; const l = L[q * 3], a = L[q * 3 + 1], b = L[q * 3 + 2];
    for (const t of labs) if (Math.abs(l - t[0]) < 2 * r && de2000(l, a, b, t[0], t[1], t[2]) < r) { out[q] = 1; break; } }
  return out;
}
/** The bounding box of a mask as fractions of the image, or null when it marks nothing. */
export function maskBox(mask, W, H) {
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (mask[y * W + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return x1 < 0 ? null : { x: x0 / W, y: y0 / H, w: (x1 - x0 + 1) / W, h: (y1 - y0 + 1) / H };
}
/** Regions are cached per result: the page asks for the checks on every control change. */
const boxes = new WeakMap();
/** The job settings a region's pixels depend on: when this changes, a marked region is measured again. */
export function regionKey(job) { return [job.stackLimit, job.widthIn, job.lpi, job.mode, job.screening, job.gain, job.minDot, job.mesh, job.choke, job.driftMm, JSON.stringify(job.sizes || null), JSON.stringify(job.limits || null)].join("|"); }
function region(ref, job, result) {
  if (!job.preview) return undefined; const key = `${ref}|${regionKey(job)}`;
  let c = boxes.get(result); if (!c) boxes.set(result, c = new Map());
  if (!c.has(key)) { const m = regionMask(ref, job, result); c.set(key, m && maskBox(m, job.preview.W, job.preview.H)); }
  const box = c.get(key); return box ? { box, mask: ref } : undefined;
}

/** The pre-print checks for a job and its separation, errors first, then warnings, then notes. */
export function preflightChecks(job, result) {
  const w = job.widthIn || 11, art = job.art, ppi = art && !art.sample ? Math.round(art.W / w) : 300, lpi = job.lpi, colors = job.plates.filter(p => !p.ub).length;
  const am = job.screening !== "fm", manual = job.press === "manual", L = { ...limitDefaults(), ...(job.limits || {}) }, smallScreen = L.smallScreenPct / 100;
  /** @type {Check[]} */ const out = [];
  if (ppi < L.minPpi) { const fitW = art ? Math.floor(art.W / L.minPpi * 2) / 2 : 0;
    out.push({ id: "low-resolution", severity: "warning", title: "Low resolution", detail: `The art has ${ppi} pixels for each inch at ${w} in wide. Use 300. The edges can print soft.`,
      measured: `${ppi} ppi at ${w} in`, limit: `${L.minPpi} ppi`, fix: [{ action: "upscale", label: "Upscale 2×" }, ...(fitW >= 1 && fitW < w ? [{ action: `w:${fitW}`, label: `Make it ${fitW} in wide` }] : [])] }); }
  for (const p of job.plates) { const c = p.ub ? 0 : result.covPct[p.idx]; if (!p.ub && c > 0 && c < smallScreen)
    out.push({ id: `small-screen-${p.idx}`, severity: "note", title: "Small screen", detail: `${p.name} covers only ${(c * 100).toFixed(1)}% of the design. If it is not important, push − to remove one screen.`,
      measured: `${(c * 100).toFixed(1)}% of the design`, limit: `${+(smallScreen * 100).toFixed(2)}%`, fix: [], region: region(`screen:${p.idx}`, job, result) }); }
  const bg = art && art.background; if (bg) out.push({ id: "solid-background", severity: "error", title: "Solid background", detail: `The art has a solid ${bg} background. It prints as a box of ink. Or save your art as a PNG with a transparent background.`,
    measured: `a solid ${bg} border`, limit: "transparent or the garment color", fix: [{ action: "bg", label: "Remove background" }], region: region(`background:${bg}`, job, result) });
  const sp = result.stats.stackP99, lim = job.stackLimit; if (sp > lim + STACK_ALLOW) out.push({ id: "heavy-ink", severity: "warning", title: "Heavy ink", detail: `In some areas, the ink is ${Math.round(sp * 100)}%. These areas can feel heavy and need more flash time.`,
    measured: `${Math.round(sp * 100)}% ink`, limit: `${Math.round(lim * 100)}% stack limit`, fix: [], region: region("stack", job, result) });
  const gc = gamutCheck(job, result); if (gc) out.push(gc);
  out.push(...geometryChecks(job, result, L));
  const halo = haloCheck(job, result); if (halo) out.push(halo);
  const dl = dotLineCheck(job, result); if (dl) out.push(dl);
  if (job.mode === "sim" && am && manual && lpi > L.manualMaxLpi) out.push({ id: "lpi-high-manual", severity: "warning", title: "LPI too high", detail: `${lpi} LPI is difficult to print on a manual press. Use 45.`,
    measured: `${lpi} LPI, manual press`, limit: `${L.manualMaxLpi} LPI on a manual press`, fix: [{ action: "lpi:45", label: "Use 45 LPI" }] });
  // index: research (Dream Shirt Studios qc5kzJAvi_w 00:00) recommends it only on an automatic press with more than 6 to 8 colors
  if (job.mode === "index" && manual) out.push({ id: "index-manual-press", severity: "warning", title: "Index on a manual press", detail: "Index prints small solid squares side by side. On a manual press they shift and blur. Print index on an automatic press, or use Simulated process.",
    measured: "a manual press", limit: "an automatic press", fix: [] });
  if (job.mode === "index" && colors < INDEX_MIN_COLORS) out.push({ id: "index-few-colors", severity: "warning", title: "Few index colors", detail: `Index mixes the colors from small squares. With ${colors} colors the mix is coarse. Use 6 or more, or use Simulated process.`,
    measured: `${colors} colors`, limit: `${INDEX_MIN_COLORS} colors`, fix: [] });
  if (job.mode === "sim" && lpi < MIN_LPI) out.push({ id: "lpi-low", severity: "warning", title: "LPI too low", detail: `At ${lpi} LPI, you can see the dots at a short distance. Use 35 to 45.`,
    measured: `${lpi} LPI`, limit: `${MIN_LPI} LPI`, fix: [{ action: "lpi:45", label: "Use 45 LPI" }] });
  return out.map((c, i) => ({ c, i })).sort((a, b) => SEVERITY_ORDER[a.c.severity] - SEVERITY_ORDER[b.c.severity] || a.i - b.i).map(o => o.c);
}

/** Out of gamut (pipeline.gamutGaps): the art's colours no mix of the shelf reaches on this garment, with how far off
 *  they print, and a mixed ink for each. The separation itself does not change until a fix is pushed.
 *  @returns {Check | null} */
function gamutCheck(job, result) {
  const g = result.gamut; if (!g || !g.length || job.method) return null;
  const n = g.length, one = n === 1, room = Math.min(n, MAX_SCREENS - (job.screens || 6));
  /** @type {GamutColor[]} */ const colors = g.map((c, k) => { const nm = colorName(c.rgb); return { hex: rgb2hex(c.rgb).toUpperCase(), name: nm[0].toUpperCase() + nm.slice(1), area: c.area, de: c.de, near: c.near, region: region(`gamut:${k}`, job, result) }; });
  /** @type {Fix[]} */ const fix = room > 0 ? [{ action: "mixes", label: room === 1 ? "Add a mixed ink" : `Add ${room} mixed inks` }] : [];
  if (job.inkSource === "library") fix.push({ action: "palArt", label: "Choose inks from the art" });
  const worst = Math.max(...g.map(c => c.de));
  return { id: "out-of-gamut", severity: "warning", title: "Colors your inks cannot reach", detail: `${one ? "One color" : `${n} colors`} in the art ${one ? "is" : "are"} outside what your ${job.shelfSize} shelf inks can mix on this garment, so ${one ? "it prints" : "they print"} duller or shifted. ${one ? "A mixed ink on one more screen matches it" : "A mixed ink for each, one more screen each, matches them"}${room > 0 ? "" : " (the job already has 12 screens: remove one first)"}. The mix sheet lists each mix with its target swatch and batch weight.`,
    measured: `${one ? "1 color" : `${n} colors`} off by up to ${worst.toFixed(0)} ΔE`, limit: `${GAMUT_DE} ΔE`, fix, colors, region: region("gamut", job, result) };
}

/* ───────────── Print size, centre, fine lines and reverse gaps ───────────── */
/** Art off centre by more than this many inches: the films are placed by their centre marks. */
export const OFF_CENTRE_IN = 0.5;
/** Fine lines and reverse gaps: coverage at or under INK is open film; a pixel is measured when it carries at least
 *  SEEN of ink (or of open film for a gap); a check fires when at least MIN_THIN_PX pixels are under the limit. */
const INK = 0.02, SEEN = 0.5, MIN_THIN_PX = 6;
/** A thin line or gap counts when it runs at least this far (mm): a stroke of a letter 2 mm tall does. */
const MIN_RUN_MM = 2;
/** What the screens hold, in mm. line: the thinnest line, the larger of 1.5 thread pitches (plan.MESH_HOLD) and, for
 *  halftones, the smallest dot's diameter. spread: how far ink spreads past each edge, the spread that gives the dot gain
 *  at 50% (a round 50% dot of radius r gains 2πr·spread = gain × cell², so spread = gain × cell / √(2π)). reverse: the
 *  narrowest open gap that stays open, the line plus the spread from both sides. */
export function lineLimits(job) {
  const lpi = job.lpi || 45, mesh = job.mesh || meshFor(lpi), cell = 25.4 / lpi, half = job.mode === "sim" && job.screening !== "fm";
  const meshMm = MESH_HOLD * 25.4 / mesh, dotMm = half ? cell * Math.sqrt(4 * (job.minDot ?? minDotFor(lpi, mesh)) / Math.PI) : 0;
  const line = Math.max(meshMm, dotMm), spread = (job.gain ?? 0.22) * cell / Math.sqrt(2 * Math.PI);
  return { mesh, line, spread, reverse: line + 2 * spread, byDot: dotMm > meshMm };
}
const DIRS = [[1, 0, 1], [0, 1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2]];
/** A measured line must look like a line in the art. On each side the art is read one pixel past where the walk ended
 *  (past a soft edge pixel). The line's colour must differ by over LINE_DE ΔE00 from both sides and be over LINE_DE (Lab
 *  distance) from every blend of the two. A tone ridge in a smooth gradient is like its sides; the soft edge pixel
 *  between two areas is a blend of them. One screen's ink rises and falls there, but the art has no line. */
const LINE_DE = 10;
/**
 * Stroke width transform on one quantity v (0–1 for each pixel: ink of one screen, or open film for gaps). From each
 * pixel it walks both ways in four directions (across, down and the two diagonals) while v is over INK, and adds up v:
 * the sum is the stroke's width in pixels, also for strokes thinner than one pixel (the preview averages them into a
 * lighter pixel). The narrowest direction is the width across the stroke. A pixel is thin when that width is under
 * limitPx, the stroke runs at least 3 pixels in some direction (a lone speck is not a line) and, with art, the art at
 * the pixel is not a blend of the art on its two sides (LINE_DE). bounded: the walk must end on full ink at both sides
 * (a gap); a walk that leaves the image does not count, and with art the two sides must be the same colour (within
 * LINE_DE): reversed text and open lines cut into one area. A seam where two different areas almost meet is not one:
 * when it fills in, the two areas only touch.
 * @param {ArrayLike<number>} v @param {number} W @param {number} H @param {number} limitPx @param {boolean} [bounded]
 * @param {{ lab: ArrayLike<number>, alpha: ArrayLike<number> } | null} [art]
 * @param {number} [minRun] the shortest run of thin pixels that counts (a line is long; a soft corner is a few pixels)
 * @returns {Float32Array} the width in pixels at each thin pixel, 0 elsewhere
 */
export function thinWidths(v, W, H, limitPx, bounded = false, art = null, minRun = 1) {
  const out = new Float32Array(W * H), R = Math.ceil(limitPx) + 2, DX = [1, 0, 1, 1], DY = [0, 1, 1, -1], ST = [1, 1, Math.SQRT2, Math.SQRT2];
  /** The art one pixel past a walk's end (x, y) going (dx, dy), else the end itself; -1 off the image or transparent. */
  const past = (x, y, dx, dy) => { if (x < 0) return -1; const X = x + dx, Y = y + dy, inA = (a, b) => a >= 0 && b >= 0 && a < W && b < H && /** @type {any} */ (art).alpha[b * W + a] >= 128;
    return inA(X, Y) ? Y * W + X : inA(x, y) ? y * W + x : -1; };
  const L = art && art.lab, de = (q, e) => de2000(L[q * 3], L[q * 3 + 1], L[q * 3 + 2], L[e * 3], L[e * 3 + 1], L[e * 3 + 2]);
  /** Lab distance² from pixel q to the segment between pixels a and b. */
  const off = (q, a, b) => { let t = 0, ab = 0;
    for (let c = 0; c < 3; c++) { const d = L[b * 3 + c] - L[a * 3 + c]; ab += d * d; t += (L[q * 3 + c] - L[a * 3 + c]) * d; }
    t = ab > 0 ? Math.max(0, Math.min(1, t / ab)) : 0; let e = 0; for (let c = 0; c < 3; c++) { const d = L[q * 3 + c] - (L[a * 3 + c] + t * (L[b * 3 + c] - L[a * 3 + c])); e += d * d; } return e; };
  // only pixels with open film (or the image edge) within R + 1 can be thin: a box test, rows then columns (prefix sums)
  const r = R + 1, row = new Uint8Array(W * H), cnt = new Int32Array(Math.max(W, H) + 1);
  for (let y = 0; y < H; y++) { for (let x = 0; x < W; x++) cnt[x + 1] = cnt[x] + (v[y * W + x] <= INK ? 1 : 0);
    for (let x = 0; x < W; x++) row[y * W + x] = x < r || x >= W - r || cnt[Math.min(W, x + r + 1)] - cnt[Math.max(0, x - r)] > 0 ? 1 : 0; }
  const near = new Uint8Array(W * H);
  for (let x = 0; x < W; x++) { for (let y = 0; y < H; y++) cnt[y + 1] = cnt[y] + row[y * W + x];
    for (let y = 0; y < H; y++) near[y * W + x] = y < r || y >= H - r || cnt[Math.min(H, y + r + 1)] - cnt[Math.max(0, y - r)] > 0 ? 1 : 0; }
  for (let Y = 0; Y < H; Y++) for (let X = 0; X < W; X++) { const q = Y * W + X; if (v[q] < SEEN || !near[q]) continue;
    let best = Infinity, longest = 0, bd = -1, fx = -1, fy = -1, bx = -1, by = -1;
    for (let d = 0; d < 4; d++) { const dx = DX[d], dy = DY[d]; let s = v[q], n = 1, wide = false, ax = -1, ay = -1, cx = -1, cy = -1;
      for (let sg = 1; sg >= -1 && !wide; sg -= 2) for (let k = 1, x = X, y = Y; ; k++) { x += sg * dx; y += sg * dy;
        if (x < 0 || y < 0 || x >= W || y >= H) { if (bounded) wide = true; break; }
        const t = v[y * W + x]; if (t <= INK) { if (sg > 0) { ax = x; ay = y; } else { cx = x; cy = y; } break; }
        if (k > R) { wide = true; break; }
        s += t; n++; }
      if (wide) { longest = Infinity; continue; } if (n > longest) longest = n;
      if (s * ST[d] < best) { best = s * ST[d]; bd = d; fx = ax; fy = ay; bx = cx; by = cy; } }
    if (longest < 3 || best >= limitPx) continue;
    if (art) { const a = past(fx, fy, DX[bd], DY[bd]), b = past(bx, by, -DX[bd], -DY[bd]);
      if (bounded && (a < 0 || b < 0 || de(a, b) > LINE_DE)) continue;
      if (art.alpha[q] >= 128 && (a >= 0 || b >= 0)) { const A = a < 0 ? b : a, B = b < 0 ? a : b; if (de(q, A) <= LINE_DE || de(q, B) <= LINE_DE || off(q, A, B) <= LINE_DE * LINE_DE) continue; } }
    out[q] = Math.max(best, 1e-6); }
  // a line or gap is a run of thin pixels: drop runs (8-connected) shorter than minRun pixels, the soft corners of shapes
  if (minRun > 1) { const seen = new Uint8Array(W * H), stack = [], comp = [];
    for (let q0 = 0; q0 < W * H; q0++) { if (!out[q0] || seen[q0]) continue; stack.push(q0); seen[q0] = 1; comp.length = 0;
      while (stack.length) { const q = /** @type {number} */ (stack.pop()); comp.push(q); const x = q % W, y = (q - x) / W;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const X = x + dx, Y = y + dy, n = Y * W + X; if (X >= 0 && Y >= 0 && X < W && Y < H && out[n] && !seen[n]) { seen[n] = 1; stack.push(n); } } }
      if (comp.length < minRun) for (const q of comp) out[q] = 0; } }
  return out;
}
/** Per result: thin-pixel widths for each screen ("thin:<idx>") and for the gaps ("reverse"), at a limit in pixels. */
const thinCache = new WeakMap();
function thinFor(ref, job, result, limitPx) {
  const pv = job.preview; if (!pv || !result.cov) return null; const P = pv.W * pv.H, N = result.covPct.length, cov = result.cov;
  if (cov.length !== P * N) return null; const key = `${ref}|${limitPx.toFixed(4)}|${pv.W}|${job.widthIn}`;
  let c = thinCache.get(result); if (!c) thinCache.set(result, c = new Map()); if (c.has(key)) return c.get(key);
  const v = new Float32Array(P), [kind, arg] = ref.split(":");
  // coverage already falls off with the art's transparency, so soft (part transparent) edges are measured as they print
  if (kind === "thin") { const i = +arg; for (let q = 0; q < P; q++) v[q] = cov[q * N + i]; }
  else { const col = job.plates.filter(p => !p.ub).map(p => p.idx), ub = result.ub && result.ub.length === P ? result.ub : null; // open under every screen, the base too: the garment shows
    for (let q = 0; q < P; q++) { let o = ub ? 1 - Math.min(1, ub[q]) : 1; for (const i of col) o *= 1 - Math.min(1, cov[q * N + i]); v[q] = o; } }
  const mmPx = (job.widthIn || 11) * 25.4 / pv.W, w = thinWidths(v, pv.W, pv.H, limitPx, kind === "reverse", pv.lab && pv.lab.length === P * 3 ? pv : null, Math.max(3, Math.ceil(MIN_RUN_MM / mmPx)));
  c.set(key, w); return w;
}
/** The bounding box of the art's opaque pixels, in preview pixels, or null. */
const boxCache = new WeakMap();
function inkBox(pv) {
  if (boxCache.has(pv.alpha)) return boxCache.get(pv.alpha); const m = new Uint8Array(pv.W * pv.H);
  for (let q = 0; q < m.length; q++) m[q] = pv.alpha[q] >= 128 ? 1 : 0; const b = maskBox(m, pv.W, pv.H), r = b && { x0: b.x * pv.W, y0: b.y * pv.H, w: b.w * pv.W, h: b.h * pv.H };
  boxCache.set(pv.alpha, r); return r;
}
/** The space a print needs on each size, inches: the design on the platen and the screen, the whole art with its film
 *  margin on the film (which may turn 90°). Returns how much smaller the print must be to fit (1 = it fits). */
function fitScale(kind, z, inkW, inkH, w, h) {
  if (kind !== "film") return Math.min(1, z.w / inkW, z.h / inkH);
  const m = 2 * FILM_MARGIN_IN, one = (A, B) => Math.min((A - m) / w, (B - m) / h);
  return Math.min(1, Math.max(one(z.w, z.h), one(z.h, z.w)));
}
const inch = v => `${Math.round(v * 10) / 10}`;
/** Mask helpers for regionMask: the opaque pixels outside a centred window of the size, and the thin pixels. */
function sizeMask(kind, job) {
  const pv = job.preview, z = job.sizes && job.sizes[kind]; if (!pv || !z) return null; const w = job.widthIn || 11, ppi = pv.W / w, out = new Uint8Array(pv.W * pv.H);
  let cx, cy, hw, hh;
  if (kind === "film") { const h = w * pv.H / pv.W, rot = fitScale("film", { w: z.h, h: z.w }, 0, 0, w, h) > fitScale("film", z, 0, 0, w, h), A = rot ? z.h : z.w, B = rot ? z.w : z.h;
    cx = pv.W / 2; cy = pv.H / 2; hw = (A / 2 - FILM_MARGIN_IN) * ppi; hh = (B / 2 - FILM_MARGIN_IN) * ppi; }
  else { const b = inkBox(pv); if (!b) return null; cx = b.x0 + b.w / 2; cy = b.y0 + b.h / 2; hw = z.w / 2 * ppi; hh = z.h / 2 * ppi; }
  for (let y = 0; y < pv.H; y++) for (let x = 0; x < pv.W; x++) { const q = y * pv.W + x; if (pv.alpha[q] >= 128 && (Math.abs(x + 0.5 - cx) > hw || Math.abs(y + 0.5 - cy) > hh)) out[q] = 1; }
  return out;
}
function thinMask(ref, job, result) {
  const pv = job.preview; if (!pv) return null; const L = lineLimits(job), mmPx = (job.widthIn || 11) * 25.4 / pv.W;
  const w = thinFor(ref, job, result, (ref === "reverse" ? L.reverse : L.line) / mmPx); if (!w) return null;
  const out = new Uint8Array(w.length); for (let q = 0; q < w.length; q++) if (w[q] > 0) out[q] = 1; return out;
}

/** The size, centre, fine line and reverse gap checks (preflightChecks adds them to the list). @returns {Check[]} */
function geometryChecks(job, result, lim = limitDefaults()) {
  const pv = job.preview; if (!pv) return []; const w = job.widthIn || 11, h = w * pv.H / pv.W, ppi = pv.W / w, b = inkBox(pv); if (!b) return [];
  /** @type {Check[]} */ const out = []; const inkW = b.w / ppi, inkH = b.h / ppi;
  if (job.sizes) for (const kind of /** @type {("platen" | "film" | "screen")[]} */ (["platen", "film", "screen"])) {
    const z = job.sizes[kind]; if (!z) continue; const s = fitScale(kind, z, inkW, inkH, w, h); if (s >= 1) continue;
    const fitW = Math.floor(w * s * 4) / 4, film = kind === "film", need = film ? `${inch(w + 2 * FILM_MARGIN_IN)} × ${inch(h + 2 * FILM_MARGIN_IN)} in` : `${inch(inkW)} × ${inch(inkH)} in`;
    out.push({ id: `too-large-${kind}`, severity: "error", title: `Print larger than the ${SIZE_NAME[kind]}`, help: "ckSize",
      detail: film ? `Each film is ${need}: the art and a ${FILM_MARGIN_IN} in margin for the registration marks and the test strip. The ${z.name} film does not hold it. Make the print smaller, or set a larger film in Shop setup.`
        : `The design prints ${need}. The ${z.name} ${SIZE_NAME[kind]} holds ${z.w} × ${z.h} in. ${kind === "platen" ? "The print goes past the edge of the platen" : "The squeegee cannot print the full design"}. Make the print smaller, or set a larger ${SIZE_NAME[kind]} in Shop setup.`,
      measured: need, limit: `${z.w} × ${z.h} in, ${z.name}`, fix: [...(fitW >= 1 ? [{ action: `w:${fitW}`, label: `Make it ${fitW} in wide` }] : []), { action: "sizes", label: "Change sizes" }],
      region: region(`oversize:${kind}`, job, result) });
  }
  const dx = (b.x0 + b.w / 2 - pv.W / 2) / ppi, dy = (b.y0 + b.h / 2 - pv.H / 2) / ppi;
  if (Math.max(Math.abs(dx), Math.abs(dy)) > lim.offCentreIn) {
    const where = [Math.abs(dx) > 0.05 ? `${inch(Math.abs(dx))} in ${dx < 0 ? "left" : "right"}` : "", Math.abs(dy) > 0.05 ? `${inch(Math.abs(dy))} in ${dy < 0 ? "high" : "low"}` : ""].filter(Boolean).join(" and ");
    out.push({ id: "off-centre", severity: "warning", title: "Design off centre", help: "ckCentre",
      detail: `The design is ${where} of the centre of the art file. The films go on the press by their centre marks, so the print is off centre on the shirt by the same distance. Crop the empty space from your art, or move each film by that distance when you register it.`,
      measured: where, limit: `${lim.offCentreIn} in from the centre`, fix: [], region: region("ink", job, result) });
  }
  if (job.mode === "index") return out; // index prints square pixels by design: the dither is not a line
  const L = lineLimits(job), mmPx = w * 25.4 / pv.W, p10 = a => { a.sort((x, y) => x - y); return a[Math.floor(a.length * 0.1)]; };
  const mm = v => v < 0.1 ? v.toFixed(2) : v.toFixed(2).replace(/0$/, ""), held = `${L.mesh} mesh at ${job.lpi} LPI${L.byDot ? `, ${Math.round((job.minDot ?? 0) * 100)}% smallest dot` : ""}`;
  const grow = got => { const want = Math.ceil(w * L.line / got * 2) / 2; return want <= 30 && want > w ? [{ action: `w:${want}`, label: `Make it ${want} in wide` }] : []; };
  for (const p of job.plates) { if (p.ub) continue; const t = thinFor(`thin:${p.idx}`, job, result, L.line / mmPx); if (!t) continue;
    const ws = []; for (let q = 0; q < t.length; q++) if (t[q] > 0) ws.push(t[q]); if (ws.length < MIN_THIN_PX) continue; const got = p10(ws) * mmPx;
    out.push({ id: `fine-line-${p.idx}`, severity: "warning", title: "Lines too thin for the mesh", help: "ckFineLine",
      detail: `${p.name} has lines and small text that are ${mm(got)} mm wide. The ${held} holds lines of ${mm(L.line)} mm and wider. Thinner lines break up or do not print. Make the lines thicker in the art, print the design larger, or use a finer mesh.`,
      measured: `lines ${mm(got)} mm wide in ${p.name}`, limit: `${mm(L.line)} mm, ${held}`, fix: grow(got), region: region(`thin:${p.idx}`, job, result) });
  }
  for (const p of job.plates) { if (p.ub) continue; const sp = specks(p.idx, job, result); if (!sp || sp.n < SPECK_MIN) continue; const d = mm(2 * Math.sqrt(sp.hold / Math.PI));
    out.push({ id: `small-detail-${p.idx}`, severity: "warning", title: "Detail too small to print", help: "ckSpeck",
      detail: `${p.name} has ${sp.n} dots and specks smaller than the smallest dot the ${held} holds (${d} mm across). They close up in the mesh or wash out. Make them larger in the art, print the design larger, or use a finer mesh.`,
      measured: `${sp.n} specks under ${d} mm in ${p.name}`, limit: `${d} mm, ${held}`, fix: [], region: region(`speck:${p.idx}`, job, result) }); }
  const g = thinFor("reverse", job, result, L.reverse / mmPx);
  if (g) { const ws = []; for (let q = 0; q < g.length; q++) if (g[q] > 0) ws.push(g[q]);
    if (ws.length >= MIN_THIN_PX) { const got = p10(ws) * mmPx, want = Math.ceil(w * L.reverse / got * 2) / 2;
      out.push({ id: "reverse-gap", severity: "warning", title: "Open lines fill in", help: "ckReverse",
        detail: `The art has open lines and reversed text, where the shirt shows between inks, that are ${mm(got)} mm wide. Ink spreads about ${mm(L.spread)} mm past each edge (${Math.round((job.gain ?? 0.22) * 100)}% dot gain), so a gap must be ${mm(L.reverse)} mm or wider to stay open on ${L.mesh} mesh. Make the gaps wider in the art, or print the design larger.`,
        measured: `gaps ${mm(got)} mm wide`, limit: `${mm(L.reverse)} mm, ${L.mesh} mesh and ${Math.round((job.gain ?? 0.22) * 100)}% dot gain`, fix: want <= 30 && want > w ? [{ action: `w:${want}`, label: `Make it ${want} in wide` }] : [], region: region("reverse", job, result) }); } }
  return out;
}

/* ───────────── Base halo, detail too small, thin lines as dots ───────────── */
/** Base halo: screens drift on press by about driftMm (plan.PRESS); a base choked less than that shows past the
 *  colours at its edges. The marked pixels: the base's outer edge (base on, a neighbour with no base) under art that is
 *  not white (a white top colour over the base hides it). HALO_MIN edge pixels make a check. */
const HALO_MIN = 20, HALO_WHITE_L = 85;
function haloMask(job, result) {
  const pv = job.preview, ub = result.ub; if (!pv || !ub || ub.length !== pv.W * pv.H) return null; const W = pv.W, H = pv.H, out = new Uint8Array(W * H), L = pv.lab && pv.lab.length === W * H * 3 ? pv.lab : null;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const q = y * W + x; if (ub[q] < 0.5 || (L && L[q * 3] > HALO_WHITE_L)) continue;
    if ((x > 0 && ub[q - 1] < 0.1) || (x < W - 1 && ub[q + 1] < 0.1) || (y > 0 && ub[q - W] < 0.1) || (y < H - 1 && ub[q + W] < 0.1)) out[q] = 1; }
  return out;
}
/** @returns {Check | null} */
function haloCheck(job, result) {
  const drift = job.driftMm, choke = job.choke; if (drift == null || choke == null || !result.ub) return null; const show = +(drift - choke).toFixed(2); if (show < 0.02) return null;
  const m = haloMask(job, result); if (m) { let n = 0; for (let q = 0; q < m.length; q++) n += m[q]; if (n < HALO_MIN) return null; }
  const want = Math.ceil(drift * 100) / 100;
  return { id: "base-halo", severity: "warning", title: "Base can show at the edges", help: "ckHalo",
    detail: `On a ${job.press} press the screens drift about ${drift} mm. The base is choked ${choke} mm, so up to ${show} mm of white base can show past the colors at the edges of the design. Choke the base by the drift or more.`,
    measured: `${choke} mm choke, ${drift} mm drift`, limit: `a choke of ${want} mm or more`, fix: [{ action: `choke:${want}`, label: `Choke ${want} mm` }], region: region("halo", job, result) };
}
/** Detail too small to print: an island of one screen's ink (cov over INK, 8-connected, darkest at least SEEN)
 *  whose ink adds up to less than one dot the screen holds (a circle of lineLimits().line). It closes in the mesh or
 *  washes out. SPECK_MIN islands make a check. Index prints square pixels and has no such dot. */
const SPECK_MIN = 3;
const speckCache = new WeakMap();
function specks(i, job, result) {
  const pv = job.preview; if (!pv || !result.cov) return null; const W = pv.W, H = pv.H, P = W * H, N = result.covPct.length, cov = result.cov; if (cov.length !== P * N) return null;
  const mmPx = (job.widthIn || 11) * 25.4 / W, hold = Math.PI / 4 * lineLimits(job).line ** 2, key = `${i}|${hold.toFixed(5)}|${mmPx.toFixed(5)}`;
  let c = speckCache.get(result); if (!c) speckCache.set(result, c = new Map()); if (c.has(key)) return c.get(key);
  const out = new Uint8Array(P), seen = new Uint8Array(P), stack = [], comp = []; let n = 0;
  for (let q0 = 0; q0 < P; q0++) { if (seen[q0] || cov[q0 * N + i] <= INK) continue; stack.push(q0); seen[q0] = 1; comp.length = 0; let sum = 0, top = 0;
    while (stack.length) { const q = /** @type {number} */ (stack.pop()); comp.push(q); const v = cov[q * N + i]; sum += v; if (v > top) top = v; if (comp.length > 64) { sum = Infinity; }
      const x = q % W, y = (q - x) / W; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const X = x + dx, Y = y + dy, k = Y * W + X; if (X >= 0 && Y >= 0 && X < W && Y < H && !seen[k] && cov[k * N + i] > INK) { seen[k] = 1; stack.push(k); } } }
    if (top >= SEEN && sum * mmPx * mmPx < hold) { n++; for (const q of comp) out[q] = 1; } }
  const r = { mask: out, n, hold }; c.set(key, r); return r;
}
function speckMask(i, job, result) { const r = specks(i, job, result); return r ? r.mask : null; }
/** Thin line work as dots: with Print thin lines solid off, the engine's solid detail pass (engine.solidDetail,
 *  the same test the separation runs) still finds line work and small type in an ink's colour; those print as dots. */
const DOTLINE_MIN = 30, dotCache = new WeakMap();
function dotLineMask(job, result) {
  const pv = job.preview; if (!pv || !pv.px || !result.inks || !result.inks.length) return null; const key = `${job.widthIn}|${job.lpi}`;
  let c = dotCache.get(result); if (!c) dotCache.set(result, c = new Map()); if (c.has(key)) return c.get(key);
  const cellPx = pv.W / (job.widthIn || 11) / (job.lpi || 45), sd = solidDetail({ px: pv.px, alpha: pv.alpha, W: pv.W, H: pv.H, inkLabs: result.inks.map(k => k.lab), cellPx });
  const out = new Uint8Array(pv.W * pv.H); for (let q = 0; q < out.length; q++) if (sd.snap[q] >= 0) out[q] = 1; c.set(key, out); return out;
}
/** @returns {Check | null} */
function dotLineCheck(job, result) {
  if (job.solidDetail !== false || job.mode !== "sim" || job.method || job.screening === "fm") return null;
  const m = dotLineMask(job, result); if (!m) return null; let n = 0; for (let q = 0; q < m.length; q++) n += m[q]; if (n < DOTLINE_MIN) return null;
  return { id: "thin-lines-dots", severity: "warning", title: "Thin lines print as dots", help: "ckDotLines",
    detail: "The art has line work and small type in an ink's color. With Print thin lines solid off they are halftoned, so their edges break into dots. Turn it on to print them as solid ink with hard edges.",
    measured: `${(n / m.length * 100).toFixed(1)}% of the art is line work`, limit: "line work prints solid", fix: [{ action: "solid:on", label: "Print thin lines solid" }], region: region("dots", job, result) };
}

/** Checks in `after` that are not in `before` (by id): the problems a change made. An agent reads this after each call. */
export function newChecks(before, after) { const had = new Set(before.map(c => c.id)); return after.filter(c => !had.has(c.id)); }
