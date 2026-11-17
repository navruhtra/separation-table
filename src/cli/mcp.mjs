// sep mcp: the Separation Table as an MCP server on stdio (JSON-RPC 2.0, one message a line). No network listener
// unless --port is given: then it also serves Streamable HTTP on 127.0.0.1 only, with a bearer token (httpHandler below).
// The rules each tool keeps (ZigZag's, simpsoka/zigzag src/studio/tools.rs, as design rules): a verb_noun name;
// readOnlyHint and destructiveHint; arguments a tool does not take, or of the wrong type, refused with the ones it
// does take; a screen named wrongly answered with the real ones; terse on every tool that changes the job; a batch-safe
// flag; overwrite: true before a file is written over; each call one undo step; an opt-in JSONL log of every call.
import { appendFileSync, statSync, renameSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve, extname, basename } from "node:path";
import { createInterface } from "node:readline";
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as J from "../job.js";
import { PRESETS, genericLibrary } from "../inks.js";
import { PRESS, meshFor, STOCK_MESH, SCREEN_SET } from "../plan.js";
import { CHECK_LIMITS, parseLimits } from "../checks.js";
import { SIZE_PRESETS, SIZE_KINDS } from "../sizes.js";
import { lab2rgb, rgb2hex } from "../engine.js";
import { Session, VIEWS, within } from "./session.mjs";
import { VERSION, decodePNG } from "./platform.mjs";

export const PROTOCOL = "2025-06-18", PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
export const INSTRUCTIONS = `Separation Table makes screen-print separations: films (1-bit TIFF and PDF at true size), a Photoshop file with one spot channel per screen, separation.json, an ink mix sheet and a job sheet, from a PNG of the art. Jobs live in this server's memory (list_jobs, switch_job, new_job); the tools work on the current one, and each call that changes it is one undo step (undo).
Typical flow: separate_art (a PNG path and any settings; or load_art -> set_options -> separate) -> get_job -> check_job (show_region to see where a check is) -> preview_print and preview_film to look -> fix what check_job reports: set_options, or edit screens (set_screen, add_screen, remove_screen, move_screen, order_screens, reduce_screens with dry_run first) -> save_job (a job file that reopens the same separation with open_file) -> export_job (a ZIP) or send_to_rip (the films into a RIP's hot folder).
Screens are named by print order (1 = first; the underbase prints first on a dark garment), ink name, film name or file slug ("02-gold"). A shop's press profile (exported from the page's Shop setup) applies with use_profile.
Methods: sim (simulated process: halftoned inks over a white underbase on dark garments, for photos and blends), spot (one solid screen per flat colour, for logos and type), index (square pixels of solid ink), cmyk, mono, duo, tri (1-3 colours at standard angles). screens: color screens, the underbase is extra; "auto" lets the engine pick method and count.
Domain rules: the colour ink stack limit is 240-280% and counts colour inks only, never the underbase. 9 screens is the usual press limit (12 is the most this tool makes); each screen costs money and press time, so add one only when check_job or the score says it pays. Mesh = 230 + 5 x (LPI - 45) for colours, snapped to stock mesh (${STOCK_MESH.join(", ")}); 45 LPI -> ${meshFor(45)}. Keep LPI 55 or under on a manual press. Art should be about 300 ppi at print width (200 is the floor).
Scores are model numbers (CIEDE2000; under 2 is a close match) and the stars a rating from them, until the press is calibrated; do not present them as measured.
Pass terse: true on any tool that changes the job for a short answer: ok, screens, names added, and new_problems (checks that were not there before the call). batch runs up to 64 calls in order, all or nothing and one undo step: each step is {"tool": name, "arguments": {...}}, and a string "$N.path" (e.g. "$0.screens") is step N's result field; "$$" is a literal "$". A tool whose batch-safe flag is false (files, art, jobs, undo) cannot run in a batch. Tools that write files refuse to write over one unless overwrite: true. File paths must lie under this server's root folder (the working directory it was started in, or sep mcp --root).`;

const TERSE = { type: "boolean", description: "Answer in a line: ok, the screens, names added, and new_problems (checks that were not there before). Default false." };
const SCREEN = { type: ["integer", "string"], description: "Print order (1 = first), ink name, film name or file slug (\"02-gold\")." };
const OVERWRITE = { type: "boolean", description: "Write over an existing file. Default false: an existing file is refused." };
const DRY = { type: "boolean", description: "Only say what it would come to; the job does not change. Default false." };
const ALIASES = J.VALUE_ALIASES;
const SETTING_PROPS = Object.fromEntries(Object.entries(J.SETTINGS).map(([k, v]) => [k, {
  ...(v.values ? { enum: [...v.values, ...Object.keys(ALIASES[k] || {})], type: typeof v.def === "boolean" ? "boolean" : "string" } : k === "screens" ? { type: ["integer", "string"] } : !v.range ? { type: "string" } : { type: "number", minimum: v.range[0], maximum: v.range[1] }),
  description: `${v.help}. Default ${v.def}.${k === "screens" ? ' 1 to 12, or "auto".' : ""}${ALIASES[k] ? ` Also: ${Object.entries(ALIASES[k]).map(([a, x]) => `${a} (= ${x})`).join(", ")}.` : ""}` }]));
const FORMAT_PROP = { type: "object", description: `Files in the ZIP, each true or false: ${Object.keys(J.FORMATS).join(", ")}.`, properties: Object.fromEntries(Object.keys(J.FORMATS).map(f => [f, { type: "boolean" }])), additionalProperties: false };
const SIZE_PROP = { type: "object", description: `The shop's sizes the print must fit; the checks then say when it does not. Each a preset id or {"w": in, "h": in}. platen: ${SIZE_PRESETS.platen.map(p => p.id).join(", ")}; film: ${SIZE_PRESETS.film.map(p => p.id).join(", ")}; screen: ${SIZE_PRESETS.screen.map(p => p.id).join(", ")}.`,
  properties: Object.fromEntries(SIZE_KINDS.map(k => [k, { type: ["string", "object"] }])), additionalProperties: false };
const LIMIT_PROP = { type: "object", description: `The shop's check thresholds: ${Object.entries(CHECK_LIMITS).map(([k, d]) => `${k.replace(/-/g, "_")} (${d.range[0]} to ${d.range[1]} ${d.unit}, default ${d.def})`).join(", ")}.`,
  properties: Object.fromEntries(Object.entries(CHECK_LIMITS).map(([k, d]) => [k.replace(/-/g, "_"), { type: "number", minimum: d.range[0], maximum: d.range[1] }])), additionalProperties: false };
const ART_PROPS = { path: { type: "string", description: "Path to the art file (PNG; JPEG and WebP if sharp is installed)." }, data: { type: "string", description: "The art as base64 PNG, in place of path." },
  name: { type: "string", description: "A name for art given as data. Default art.png." }, remove_background: { type: "boolean", description: "Knock out a solid background that touches the edge (it would print as a box of ink). Default false." } };

/** name, what it does, read (changes nothing), destructive (can lose work or write over a file), batch (may run in a
 *  batch: false for files, art, jobs and undo), props, required. */
const TOOLS = [
  { name: "separate_art", read: false, destructive: true, batch: false, description: "Load the art and separate it in one call, with any settings given (the rest keep their values). Replaces the job's art and separation. Returns the films in print order and the scores. Takes 5-60 s.",
    props: { ...ART_PROPS, ...SETTING_PROPS } },
  { name: "load_art", read: false, destructive: true, batch: false, description: "Load the art (a PNG file path, or base64 PNG data). Replaces the job's art and its separation; settings stay. Returns size, ppi at print width, transparency and any solid background.",
    props: { ...ART_PROPS, width_in: { type: "number", minimum: 1, maximum: 30, description: "Print width, inches (the widthIn setting)." } } },
  { name: "open_file", read: false, destructive: true, batch: false, description: "Open a job file saved by save_job (.json: the same art, settings and inks, separated again to the same result), art (.png), or separated films to re-proof and export again: a Photoshop file (.psd, one channel per screen), a TIFF film or a folder of TIFF films (as the job ZIP's tiff/). Films need the art loaded first (load_art) unless the PSD carries an RGB composite; their screens stay the films until set_options {screens} or new art.",
    props: { path: { type: "string", description: "A job .json, a .png, a .psd, a .tif or a folder of .tif films." }, separation: { type: "string", description: "Films only: the job's separation.json, for each screen's colour and name." } }, required: ["path"] },
  { name: "set_options", read: false, destructive: false, batch: true, description: "Change job settings. Any setting not given keeps its value. A change drops the current separation (locked inks stay): call separate again. Returns every setting.",
    props: { ...SETTING_PROPS, formats: FORMAT_PROP, sizes: SIZE_PROP, limits: LIMIT_PROP } },
  { name: "use_profile", read: false, destructive: false, batch: true, description: "Use a shop press profile from a profiles file exported from the page (Shop setup > Profiles > Export): press, LPI, angle, DPI, dot gain, smallest and largest dot, dot shape, mesh, the press calibration and the platen, film and screen sizes (if the profile keeps them). Settings given later override it.",
    props: { path: { type: "string", description: "The profiles .json file." }, name: { type: "string", description: "The profile's name; may be left out when the file has one profile." } }, required: ["path"] },
  { name: "separate", read: false, destructive: false, batch: true, description: "Separate the loaded art with the current settings (on Auto, the engine picks method and screen count first; inks set by hand are kept as they are). Returns the films in print order (ink, coverage, angle, mesh), the scores and the rating. Takes 5-60 s.", props: {} },
  { name: "get_job", read: true, destructive: false, batch: true, description: "The current job: art, the settings that differ from the defaults, garment, press, method, shop profile, sizes and limits, the screens in print order (ink, hex, coverage, angle, mesh, locked), scores, rating and the checks' ids.", props: {} },
  { name: "get_separation", read: true, destructive: false, batch: true, description: "separation.json for the job as it stands (screens, inks in CIELAB, print settings, fidelity), from the preview separation; export_job writes it again at full size.", props: {} },
  { name: "check_job", read: true, destructive: false, batch: true, description: "The pre-print checks for the current separation, errors first: severity (error, warning, note), what was measured, the limit and the fixes. Use explain_check for more on one and show_region for where it is.", props: {} },
  { name: "explain_check", read: true, destructive: false, batch: true, description: "Explain one check (by id from check_job, or any known id): what it measures, why it matters on press, and which change fixes it.",
    props: { id: { type: "string", description: "The check id, e.g. heavy-ink or small-screen-2." } }, required: ["id"] },
  { name: "show_region", read: true, destructive: false, batch: true, description: "Where a check (by id; a gamut colour as out-of-gamut:0) or a screen prints: its box as fractions of the art and in inches, and a PNG of the print with the box drawn.",
    props: { check: { type: "string", description: "A check id from check_job." }, screen: SCREEN } },
  { name: "preview_print", read: true, destructive: false, batch: true, description: `PNG of the job at preview size. view: ${VIEWS.join(", ")} (print: the modelled print on the garment, not a press proof; art: the art on the garment; compare: art and print side by side; differences: white = same, black = 10 dE00 or more off).`,
    props: { view: { type: "string", enum: VIEWS, description: "Default print." }, width_px: { type: "integer", minimum: 64, maximum: 2000, description: "Longest side of the image; default the preview size (900)." } } },
  { name: "preview_film", read: true, destructive: false, batch: true, description: "PNG of one film, black = ink. Without region: the whole film, shrunk (gray = dot share). With region: that part at film resolution, so the dots show.",
    props: { screen: SCREEN, region: { type: "object", description: "Part of the film as fractions 0-1: {x, y, w, h}.", properties: { x: { type: "number", minimum: 0, maximum: 1 }, y: { type: "number", minimum: 0, maximum: 1 }, w: { type: "number", minimum: 0, maximum: 1 }, h: { type: "number", minimum: 0, maximum: 1 } }, required: ["x", "y", "w", "h"], additionalProperties: false },
      max_px: { type: "integer", minimum: 64, maximum: 2000, description: "Longest side of the image. Default 1000." } }, required: ["screen"] },
  { name: "set_screen", read: false, destructive: false, batch: true, description: "Change one screen: its ink (a shelf ink by name, or a mixed ink by hex; it is then locked and the job separated again with the inks as they are), its lock (a locked ink stays when the engine picks again), the name printed on its film, its own mesh, LPI and angle (null gives the job's back; on its film, the PDF, the Photoshop file and separation.json), or hidden (left out of preview_print; its film is still made).",
    props: { screen: SCREEN, ink: { type: "string", description: "A shelf ink's name (list_inks)." }, hex: { type: "string", description: "A mixed ink, #rrggbb." }, lock: { type: "boolean", description: "Lock or unlock the ink." },
      name: { type: "string", description: "The shop's name for the screen, on its film, files and sheets (the ink keeps its own); \"\" gives the ink's name back." },
      mesh: { type: ["integer", "null"], enum: [...STOCK_MESH, null], description: "This screen's mesh count (a stock count); null: the job's (Shop setup mesh, or the one the LPI calls for)." },
      lpi: { type: ["number", "null"], minimum: SCREEN_SET.lpi[0], maximum: SCREEN_SET.lpi[1], description: "This screen's halftone lines per inch; null: the job's." },
      angle: { type: ["number", "null"], minimum: SCREEN_SET.angle[0], maximum: SCREEN_SET.angle[1], description: "This screen's halftone angle, degrees; null: the job's (or the method's)." },
      hidden: { type: "boolean", description: "Leave the screen out of preview_print, to see what it adds (the page's Print view does the same). Its film is still made. A new separation shows every screen again." } }, required: ["screen"] },
  { name: "add_screen", read: false, destructive: false, batch: true, description: "Add a screen in a shelf ink or a mixed ink (hex), locked. By default the engine picks the other inks around it, as the page's Add ink; keep_others keeps them as they are. 12 ink screens at most.",
    props: { ink: { type: "string", description: "A shelf ink's name (list_inks)." }, hex: { type: "string", description: "A mixed ink, #rrggbb." }, keep_others: { type: "boolean", description: "Keep the other inks as they are. Default false." } } },
  { name: "remove_screen", read: false, destructive: true, batch: true, description: "Remove a colour screen (its ink) and separate again with the others. The underbase is set with set_options {underbase}.", props: { screen: SCREEN }, required: ["screen"] },
  { name: "move_screen", read: false, destructive: false, batch: true, description: "Move a colour screen to another place in the print order and separate again (the underbase always prints first).",
    props: { screen: SCREEN, to: { type: "integer", minimum: 1, maximum: 13, description: "The print order it goes to." } }, required: ["screen", "to"] },
  { name: "order_screens", read: false, destructive: false, batch: true, description: "Let the engine find the best print order for this job (an ink whose fade meets the stack limit is tried later in the order; the highlight white stays last). The new order is kept only if it prints better. Returns every order tried with its score.",
    props: { dry_run: DRY } },
  { name: "reduce_screens", read: false, destructive: true, batch: true, description: "Separate at fewer colour screens and say what it costs: screens, press and aligned dE00 and stars, before and after. Try it with dry_run first.",
    props: { screens: { type: "integer", minimum: 1, maximum: 11, description: "Colour screens to keep." }, dry_run: DRY }, required: ["screens"] },
  { name: "clean_screens", read: false, destructive: false, batch: true, description: "Spot separations: take specks and pinholes smaller than min_speck_px out of the solid plates (open/close), then proof again; the export cleans the same. Says how many pixels change.",
    props: { min_speck_px: { type: "integer", minimum: 1, maximum: 400, description: "Smallest speck kept, preview pixels. Default 8 (the engine's own cleanup)." }, dry_run: DRY } },
  { name: "double_hit_screen", read: false, destructive: false, batch: true, description: "Print a screen twice (a highlight white or an underbase that needs more cover), with or without a flash between the two strokes. On the film label, job sheet, mix sheet and separation.json; the print model does not add the second ink film.",
    props: { screen: SCREEN, hits: { type: "integer", enum: [1, 2], description: "1 = once, 2 = twice." }, flash_between: { type: "boolean", description: "Flash between the two hits. Default false." } }, required: ["screen", "hits"] },
  { name: "set_print_size", read: false, destructive: false, batch: true, description: "Set the print size (width, or height with the width following the art's shape) and whether the films are mirrored (emulsion down). Drops the separation: call separate again.",
    props: { width_in: { type: "number", minimum: 1, maximum: 30, description: "Print width, inches." }, height_in: { type: "number", minimum: 1, maximum: 40, description: "Print height, inches; the width is set from it." }, mirror_films: { type: "boolean", description: "Mirror every film, the PSD and the SVG (emulsion down). Default false." } } },
  { name: "vectorize_screen", read: true, destructive: false, batch: true, description: "A spot screen traced to an SVG (VTracer) at the working size, as the job ZIP's svg/ file: the SVG text and its path count.", props: { screen: SCREEN }, required: ["screen"] },
  { name: "list_inks", read: true, destructive: false, batch: true, description: "The ink shelf the separation chooses from (generic library), or a preset's inks: name, hex, CIELAB.",
    props: { preset: { type: "string", enum: Object.keys(PRESETS), description: "An ink preset; default the generic library." } } },
  { name: "list_profiles", read: true, destructive: false, batch: true, description: "Press profiles, ink presets, the mesh rule, the shop profile in use, the sizes and check limits, and every setting with its default and valid values.", props: {} },
  { name: "list_garments", read: true, destructive: false, batch: true, description: "The garment colours by name (the page's shirt chips), each with its hex; set_options {garment} takes a name or any #rrggbb.", props: {} },
  { name: "list_jobs", read: true, destructive: false, batch: true, description: "The jobs in this server's memory: name, art, screens, which is current.", props: {} },
  { name: "switch_job", read: false, destructive: false, batch: false, description: "Make another job current, by number (1 = first, as list_jobs) or name.", props: { job: { type: ["integer", "string"], description: "Job number or name." } }, required: ["job"] },
  { name: "new_job", read: false, destructive: false, batch: false, description: "Start a new, empty job with default settings and make it current. The other jobs stay.", props: { name: { type: "string", description: "A name for it. Default Job N." } } },
  { name: "undo", read: false, destructive: false, batch: false, description: "Undo the last call that changed the current job (a batch is one step). Says what was undone.", props: {} },
  { name: "save_job", read: false, destructive: true, batch: false, description: "Write the job file: settings, inks in print order with what was set on each, shop profile, sizes, limits and the art's path relative to the file. open_file reopens it to the same separation.",
    props: { path: { type: "string", description: "Where to write the .json." }, overwrite: OVERWRITE }, required: ["path"] },
  { name: "export_job", read: false, destructive: true, batch: false, description: "Write the job ZIP (films.pdf, TIFFs, PSD, separation.json, mix sheet, job sheet; the same files as the page's step 4 download), whole or not at all.",
    props: { path: { type: "string", description: "Where to write the .zip." }, formats: FORMAT_PROP, overwrite: OVERWRITE }, required: ["path"] },
  { name: "send_to_rip", read: false, destructive: true, batch: false, description: "Write the films into a RIP's hot folder, in a folder named for the job: one 1-bit TIFF per screen (or films.pdf, or EPS), plus separation.json. Each file is written whole.",
    props: { folder: { type: "string", description: "The hot folder." }, format: { type: "string", enum: ["tif", "pdf", "eps"], description: "Default tif." }, overwrite: OVERWRITE }, required: ["folder"] },
  { name: "batch", read: false, destructive: false, batch: false, description: 'Up to 64 calls in order. Atomic by default: if a step fails, the job is as it was before the batch, and the whole batch is one undo step. Step: {"tool": name, "arguments": {...}}. A string "$N.path" in arguments is step N\'s result field ("$0.films.1.name"); "$$" is a literal "$". Tools that are not batch-safe: BATCH_UNSAFE.',
    props: { steps: { type: "array", maxItems: 64, items: { type: "object", properties: { tool: { type: "string" }, arguments: { type: "object" } }, required: ["tool"] } },
      atomic: { type: "boolean", description: "Undo every step if one fails. False: stop at the step that fails and keep the ones before it. Default true." },
      label: { type: "string", description: "What the batch does, kept in the undo list and the log." },
      terse: { type: "boolean", description: "A short answer for the whole batch: ok, steps run, results of the steps that only read, the screens, names added and new_problems. Default false." } }, required: ["steps"] },
];
const UNSAFE = TOOLS.filter(t => !t.batch).map(t => t.name);
for (const t of TOOLS) { if (t.name === "batch") t.description = t.description.replace("BATCH_UNSAFE", UNSAFE.join(", ")); if (!t.read && t.name !== "batch") t.props = { ...t.props, terse: TERSE }; }
const TOOL = Object.fromEntries(TOOLS.map(t => [t.name, t]));
export const toolList = () => TOOLS.map(t => ({ name: t.name, description: t.description + (t.batch ? "" : " Not batch-safe."), inputSchema: { type: "object", properties: t.props, ...(t.required && { required: t.required }), additionalProperties: false },
  annotations: { readOnlyHint: t.read, destructiveHint: t.destructive, idempotentHint: t.read, openWorldHint: false }, _meta: { "separation-table/batchSafe": t.batch } }));

/* ───────────── Arguments ───────────── */
const typeOf = v => v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v;
const fits = (t, v) => t === typeOf(v) || (t === "number" && typeof v === "number" && Number.isFinite(v)) || (t === "integer" && Number.isInteger(v));
const shown = v => { const s = JSON.stringify(v); return s.length > 40 ? s.slice(0, 40) + "…" : s; };
/** One value against its schema: type, enum, range, an object's own properties. Wrong types are refused, never
 *  turned into a default. */
function checkValue(where, sch, v) {
  if (sch.type) { const ts = [].concat(sch.type); if (!ts.some(t => fits(t, v))) throw new Error(`${where} must be ${ts.join(" or ")}, not ${typeOf(v)} ${shown(v)}`); }
  if (sch.enum && !sch.enum.includes(v)) throw new Error(`${where} ${shown(v)} is not valid. Valid: ${sch.enum.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(", ")}`);
  if (typeof v === "number" && ((sch.minimum != null && v < sch.minimum) || (sch.maximum != null && v > sch.maximum))) throw new Error(`${where} ${v} is out of range. Valid: ${sch.minimum} to ${sch.maximum}`);
  if (Array.isArray(v) && sch.maxItems != null && v.length > sch.maxItems) throw new Error(`${where} has ${v.length} items; at most ${sch.maxItems}`);
  if (typeOf(v) === "object" && sch.properties) {
    const bad = Object.keys(v).filter(k => !sch.properties[k]); if (bad.length && sch.additionalProperties === false) throw new Error(`${where} does not take ${bad.map(k => `\`${k}\``).join(", ")}. It takes: ${Object.keys(sch.properties).map(k => `\`${k}\``).join(", ")}.`);
    for (const k of sch.required || []) if (v[k] === undefined) throw new Error(`${where} needs \`${k}\``);
    for (const [k, x] of Object.entries(v)) if (sch.properties[k]) checkValue(`${where}.${k}`, sch.properties[k], x);
  }
}
/** Refuse arguments a tool does not take (a misspelt `lpl` would otherwise be dropped without a word), and values of
 *  the wrong type or out of range. */
export function checkArgs(name, args) {
  const t = TOOL[name]; if (!t) return;
  if (args == null) args = {}; if (typeof args !== "object" || Array.isArray(args)) throw new Error(`${name}: arguments must be an object`);
  const valid = Object.keys(t.props).sort(), bad = Object.keys(args).filter(k => !t.props[k]);
  if (bad.length) throw new Error(`${name} does not take ${bad.map(k => `\`${k}\``).join(", ")}. It takes: ${valid.length ? valid.map(k => `\`${k}\``).join(", ") : "no arguments"}.`);
  for (const k of t.required || []) if (args[k] === undefined) throw new Error(`${name} needs \`${k}\`.`);
  for (const [k, v] of Object.entries(args)) checkValue(`${name}: \`${k}\``, t.props[k], v);
}
/** "$N.path" → that field of step N's result. */
export function resolveRefs(v, results) {
  if (typeof v === "string" && v.startsWith("$$")) return v.slice(1);
  if (typeof v === "string" && /^\$\d+(\.|$)/.test(v)) {
    const [n, ...path] = v.slice(1).split("."); let cur = results[+n]; if (cur === undefined) throw new Error(`${v}: there is no earlier step ${n}`);
    for (const k of path.filter(Boolean)) { const next = Array.isArray(cur) && /^\d+$/.test(k) ? cur[+k] : cur?.[k]; if (next === undefined) throw new Error(`${v}: step ${n}'s result has no \`${k}\``); cur = next; }
    return cur;
  }
  if (Array.isArray(v)) return v.map(x => resolveRefs(x, results));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveRefs(x, results)]));
  return v;
}
/** set_options' sizes and limits arguments as the session takes them. */
const sizesArg = z => Object.fromEntries(Object.entries(z).map(([k, v]) => [k, typeof v === "string" ? { id: v } : { id: "custom", w: v.w, h: v.h }]));
const limitsArg = l => parseLimits(Object.fromEntries(Object.entries(l).map(([k, v]) => [k.replace(/_/g, "-"), v])));

/** What each check means and the change that fixes it (ids from checks.js). */
const EXPLAIN = {
  "low-resolution": { why: "Films are halftoned from the art's pixels. Under about 200 ppi at print width, edges and fine lines print soft or stepped.", fix: "Use art with about 300 ppi at the print width, or set_print_size {width_in} smaller." },
  "small-screen": { why: "A screen that covers under 0.5% of the design costs a screen, a film, setup and ink for very little print.", fix: "remove_screen, or reduce_screens {screens: one fewer, dry_run: true} to see the cost, unless that ink carries a small but important detail." },
  "solid-background": { why: "An opaque border that is not the garment colour is art to the separation: it prints as a box of ink.", fix: "load_art or separate_art with remove_background: true, or save the art as a PNG with a transparent background, or set the garment to the background colour." },
  "heavy-ink": { why: "Where the colour inks stack above the limit (240-280%, underbase not counted) the print feels heavy, needs longer flash and can crack or stay tacky.", fix: "set_options {stackLimit: 240} or fewer screens; show_region {check: \"heavy-ink\"} shows where." },
  "out-of-gamut": { why: "No mix of the shelf inks reaches these colours on this garment, so they print duller or shifted.", fix: "add_screen {hex} for each colour (one screen each), or set_options {inkSource: \"art\"} to mix inks to the art." },
  "lpi-high-manual": { why: "Fine halftones need tight registration and fine mesh; a manual press drifts and the small dots close or wash out.", fix: "set_options {lpi: 45}, or {press: \"automatic\"} if the job runs on one." },
  "index-manual-press": { why: "Index prints small solid squares side by side; on a manual press they shift and blur.", fix: "set_options {method: \"sim\"}, or {press: \"automatic\"}." },
  "index-few-colors": { why: "Index mixes colours from small squares; with few colours the mix is coarse.", fix: "set_options {screens: 6 or more}, or {method: \"sim\"}." },
  "lpi-low": { why: "Under 30 LPI the dots are visible at a short distance.", fix: "set_options {lpi: 35 to 45}." },
  "too-large": { why: "The print with its film margin is larger than the shop's platen, film sheet or screen image area (set_options sizes): it cannot be printed as set.", fix: "set_print_size {width_in} smaller, or set_options {sizes} to the shop's real platen, film or screen." },
  "off-centre": { why: "Films are placed by their centre marks; art that sits off centre in its canvas prints off centre on the shirt.", fix: "Crop the art to the design, or place it by hand on press." },
  "fine-line": { why: "Lines thinner than the mesh holds at this LPI break up or do not print.", fix: "set_options {lpi} lower or a finer mesh (use_profile), or thicken the lines in the art." },
  "reverse-gap": { why: "Open lines in the ink (reverse type, gaps) narrower than the dot gain fill in on press.", fix: "set_options {gain} to the press's real dot gain, or open the gaps in the art." },
};
const explainKey = id => id.replace(/-\d+$/, "").replace(/^too-large-.*$/, "too-large");

const imageResult = (png, meta) => ({ content: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }, { type: "text", text: JSON.stringify(meta) }] });
const json = v => ({ content: [{ type: "text", text: JSON.stringify(v) }], structuredContent: v });
const noRegion = c => { const { region, colors, ...rest } = c; return { ...rest, ...(region && { region: region.box }), ...(colors && { colors: colors.map(({ region, ...g }) => g) }) }; };
const valueOf = r => r.structuredContent ?? (r.content.find(c => c.type === "text") ? JSON.parse(r.content.find(c => c.type === "text").text) : null);
const UNDO_MAX = 30;

export class Server {
  /** root: the only folder whose files the tools read or write (default the working directory). */
  constructor({ log = null, root = process.cwd() } = {}) { this.jobs = [{ name: "Job 1", session: new Session(), undo: [] }]; this.cur = 0; this.made = 1; this.log = log ? resolve(log) : null; this.client = null; this.root = resolve(root); }
  /** A tool's file path, inside the root or refused. */
  path(p, what) { return within(this.root, p, `${what}:`); }
  get entry() { return this.jobs[this.cur]; }
  get job() { return this.entry.session; }
  problems() { try { return this.job.res ? this.job.checks().map(c => c.id) : []; } catch { return []; } }
  terse(value, before) { const j = this.job, sum = j.res ? j.summary() : null;
    return { ok: true, ...(sum && { screens: sum.screens, press_de00: sum.score.press_de00 }), ...(value && value.added && { added: value.added }), ...(value && value.changed && { changed: value.changed }), new_problems: this.problems().filter(id => !before.includes(id)) }; }
  jobOf(sel) {
    const s = String(sel), i = /^\d+$/.test(s) ? +s - 1 : this.jobs.findIndex(x => x.name.toLowerCase() === s.toLowerCase());
    if (!this.jobs[i]) throw new Error(`no job "${sel}". Jobs: ${this.jobs.map((x, k) => `${k + 1} ${x.name}`).join(", ")}`); return i;
  }
  async loadArt(a) {
    const j = this.job; if ((a.path == null) === (a.data == null)) throw new Error("give path (a file) or data (base64 PNG), one of them");
    if (a.data != null) { let r; try { r = decodePNG(Buffer.from(a.data, "base64")); } catch (e) { throw new Error(`data is not a base64 PNG: ${e.message}`); }
      j.setArt({ ...r, info: "From base64 data. Used as sRGB." }, { name: a.name || "art.png", path: null, sha256: null }); }
    else await j.load(this.path(a.path, "path"));
    const bg = a.remove_background ? j.removeBackground() : null; if (!this.entry.named) this.entry.name = j.file.name;
    return { ...j.artInfo(), ...(bg && { background_removed: bg }) };
  }
  /** Run one tool; returns its JSON value (or an image result). Throws with a message the agent can act on. Each top
   *  level call that changes the job is one undo step, and a call that fails leaves the job as it was. */
  async run(name, args, inBatch = false) {
    const t = TOOL[name]; if (!t) throw new Error(`no tool "${name}". Tools: ${TOOLS.map(x => x.name).join(", ")}`);
    args = args || {}; checkArgs(name, args);
    if (inBatch && !t.batch) throw new Error(`${name} cannot run in a batch (not batch-safe: ${UNSAFE.join(", ")})`);
    const undoable = !inBatch && !t.read && !["undo", "switch_job", "new_job", "batch"].includes(name), entry = this.entry, snap = undoable ? this.job.snapshot() : null;
    const terse = args.terse === true, before = terse ? this.problems() : null;
    let value;
    try { value = await this.dispatch(name, args); }
    catch (e) { if (snap && !(e && e.keep)) this.job.restore(snap); throw e; }
    if (snap) { entry.undo.push({ snap, label: name }); if (entry.undo.length > UNDO_MAX) entry.undo.shift(); }
    return terse && name !== "batch" ? json(this.terse(value, before)) : value && value.content ? value : json(value);
  }
  async dispatch(name, args) {
    const j = this.job;
    switch (name) {
      case "separate_art": { const { path, data, name: nm, remove_background, terse: _t, ...o } = args; const art = await this.loadArt({ path, data, name: nm, remove_background }); j.set(o); return { art, separation: await j.separate() }; }
      case "load_art": { const art = await this.loadArt(args); if (args.width_in != null) j.set({ widthIn: args.width_in }); return art; }
      case "open_file": { const p = this.path(String(args.path), "open_file"), ext = extname(p).toLowerCase();
        if (ext === ".json") { const r = await j.openJob(p); if (!this.entry.named) this.entry.name = basename(p, ext); return r; }
        if ([".png", ".jpg", ".jpeg", ".webp"].includes(ext)) return this.loadArt({ path: p });
        if ([".psd", ".tif", ".tiff"].includes(ext) || (existsSync(p) && statSync(p).isDirectory())) {
          const spec = args.separation ? JSON.parse(readFileSync(this.path(String(args.separation), "separation"), "utf8")) : null; return j.importFilms([p], spec, this.root); }
        throw new Error(`open_file: ${ext || "no extension"} is not a file it opens. It opens: .json (a job file from save_job), .png (art), .psd, .tif or a folder of .tif (films)`); }
      case "set_options": { const { terse: _t, sizes, limits, ...o } = args; if (sizes) j.setSizes(sizesArg(sizes)); if (limits) j.setLimits(limitsArg(limits)); const s = j.set(o);
        return { ...s, ...(j.ctx.sizes && { sizes: Object.fromEntries(Object.entries(j.ctx.sizes).map(([k, z]) => [k, z.name])) }), ...(j.ctx.limits && { limits: j.ctx.limits }) }; }
      case "use_profile": { const p = J.pickProfile(readFileSync(this.path(String(args.path), "use_profile"), "utf8"), args.name || ""), r = j.useProfile(p); return { profile: r.name, settings: r.settings, mesh: r.mesh, calibrated: !!r.calib, sizes: r.sizes ? Object.fromEntries(Object.entries(r.sizes).map(([k, z]) => [k, /** @type {any} */ (z).name])) : null }; }
      case "separate": return j.separate();
      case "get_job": return { job: this.entry.name, ...j.describe(), undo_steps: this.entry.undo.length };
      case "get_separation": return j.separationSpec();
      case "check_job": return { checks: j.checks().map(noRegion) };
      case "explain_check": { const id = String(args.id), e = EXPLAIN[explainKey(id)]; if (!e) throw new Error(`no check "${id}". Checks: ${Object.keys(EXPLAIN).join(", ")} (small-screen-N, fine-line-N for screen N; too-large-platen, -film, -screen)`);
        const live = j.res ? j.checks().find(c => c.id === id) : null; return { id, ...(live && { title: live.title, detail: live.detail, measured: live.measured, limit: live.limit, fixes: live.fix.map(f => f.label) }), why: e.why, fix: e.fix, in_this_job: !!live }; }
      case "show_region": { const r = j.showRegion({ check: args.check ?? null, screen: args.screen ?? null }); if (!r.png) return r; const { png, W, H, ...meta } = r; return imageResult(png, { ...meta, width: W, height: H }); }
      case "preview_print": { const p = j.previewPrint(args.view || "print", args.width_px || null); return imageResult(p.png, { view: p.view, width: p.W, height: p.H, note: "print model on the garment, not a press proof" }); }
      case "preview_film": { const r = j.previewFilm(args.screen, args.region || null, args.max_px || 1000); return imageResult(r.png, { screen: r.screen, order: r.order, width: r.W, height: r.H, note: r.note }); }
      case "set_screen": { const { screen, ink, hex, lock, name: nm, hidden } = args, own = Object.fromEntries(["mesh", "lpi", "angle"].filter(k => args[k] !== undefined).map(k => [k, args[k]]));
        if ([ink, hex, lock, nm, hidden].every(v => v === undefined) && !Object.keys(own).length) throw new Error("set_screen: give ink, hex, lock, name, mesh, lpi, angle or hidden");
        const prod = { ...(nm !== undefined && { label: nm }), ...own };
        return j.setScreen(screen, { ink, hex, lock, hidden, prod: Object.keys(prod).length ? prod : null }); }
      case "add_screen": if ((args.ink == null) === (args.hex == null)) throw new Error("add_screen: give ink (a shelf ink name) or hex (#rrggbb), one of them"); return j.addScreen({ ink: args.ink, hex: args.hex, keepOthers: !!args.keep_others });
      case "remove_screen": return j.removeScreen(args.screen);
      case "move_screen": return j.moveScreen(args.screen, args.to);
      case "order_screens": return j.orderScreens({ dryRun: !!args.dry_run });
      case "reduce_screens": return j.reduceScreens({ screens: args.screens, dryRun: !!args.dry_run });
      case "clean_screens": return j.cleanScreens({ minPx: args.min_speck_px ?? 8, dryRun: !!args.dry_run });
      case "double_hit_screen": { if (args.flash_between && args.hits !== 2) throw new Error("double_hit_screen: flash_between needs hits: 2");
        return j.setScreen(args.screen, { prod: { hits: args.hits, flashBetween: args.hits === 2 && !!args.flash_between } }); }
      case "set_print_size": { const o = {}; if (args.width_in != null && args.height_in != null) throw new Error("set_print_size: give width_in or height_in, not both (the other follows the art's shape)");
        if (args.height_in != null) { j.need(); const w = +(args.height_in * j.art.W / j.art.H).toFixed(2); if (w < 1 || w > 30) throw new Error(`set_print_size: ${args.height_in} in tall makes the print ${w} in wide; the width must be 1 to 30 in`); o.widthIn = w; }
        if (args.width_in != null) o.widthIn = args.width_in; if (args.mirror_films != null) o.mirror = args.mirror_films ? "mirror" : "right";
        if (!Object.keys(o).length) throw new Error("set_print_size: give width_in, height_in or mirror_films"); j.set(o);
        return { width_in: +j.s.widthIn, height_in: j.art ? +(j.s.widthIn * j.art.H / j.art.W).toFixed(2) : null, ...(j.s.mirror && { films: j.s.mirror === "mirror" ? "mirrored (emulsion down)" : "right reading" }), note: "call separate" }; }
      case "vectorize_screen": return j.vectorizeScreen(args.screen);
      case "list_inks": return { inks: (args.preset ? PRESETS[args.preset].inks() : genericLibrary()).map(i => ({ name: i.name, hex: rgb2hex(lab2rgb(i.lab)).toUpperCase(), lab: i.lab.map(v => +v.toFixed(1)), ...(i.code && { system: i.system, code: i.code }) })) };
      case "list_profiles": return { press: Object.fromEntries(Object.entries(PRESS).map(([k, p]) => [k, { registration_drift_mm: p.mm }])), ink_presets: Object.fromEntries(Object.entries(PRESETS).map(([k, p]) => [k, p.name])),
        shop_profile: j.ctx.profile, mesh_rule: "230 + 5 x (LPI - 45), snapped to stock", stock_mesh: STOCK_MESH, sizes: Object.fromEntries(SIZE_KINDS.map(k => [k, SIZE_PRESETS[k].map(p => ({ id: p.id, name: p.name, w: p.w, h: p.h }))])),
        check_limits: Object.fromEntries(Object.entries(CHECK_LIMITS).map(([k, d]) => [k.replace(/-/g, "_"), { default: d.def, range: d.range, unit: d.unit }])),
        settings: Object.fromEntries(Object.entries(J.SETTINGS).map(([k, v]) => [k, { default: v.def, ...(v.values ? { values: v.values } : { range: v.range }), ...(ALIASES[k] && { also: ALIASES[k] }), help: v.help }])), formats: J.FORMATS };
      case "list_garments": return { garments: Object.entries(J.GARMENTS).map(([name, hex]) => ({ name, hex: hex.toUpperCase() })), note: "any #rrggbb works too" };
      case "list_jobs": return { jobs: this.jobs.map((x, k) => ({ job: k + 1, name: x.name, current: k === this.cur, art: x.session.file ? x.session.file.name : null, screens: x.session.res ? x.session.plates().length : null, undo_steps: x.undo.length })) };
      case "switch_job": { this.cur = this.jobOf(args.job); return { current: this.cur + 1, name: this.entry.name }; }
      case "new_job": { const nm = args.name ? String(args.name) : `Job ${++this.made}`; if (this.jobs.some(x => x.name.toLowerCase() === nm.toLowerCase())) throw new Error(`there is already a job named ${nm}. Jobs: ${this.jobs.map(x => x.name).join(", ")}`);
        this.jobs.push({ name: nm, session: new Session(), undo: [], named: !!args.name }); this.cur = this.jobs.length - 1; return { current: this.cur + 1, name: nm }; }
      case "undo": { const u = this.entry.undo.pop(); if (!u) throw new Error("nothing to undo in this job"); j.restore(u.snap); return { undone: u.label, undo_steps: this.entry.undo.length, separation: j.res ? j.summary() : null }; }
      case "save_job": return j.saveJob(this.path(String(args.path), "save_job"), { overwrite: args.overwrite === true });
      case "export_job": { const p = this.path(String(args.path), "export_job"); if (!/\.zip$/i.test(p)) throw new Error("export_job: path must end in .zip"); if (existsSync(p) && args.overwrite !== true) throw new Error(`${p} exists. Pass overwrite: true to write over it.`);
        return j.exportJob(p, { formats: args.formats || null }); }
      case "send_to_rip": { const f = args.format || "tif", formats = { pdf: f === "pdf", tif: f === "tif", eps: f === "eps", png: false, svg: false, psd: false, psdPreview: false, dcs: false };
        return j.exportFolder(this.path(String(args.folder), "send_to_rip"), { overwrite: args.overwrite === true, formats, only: n => n === "separation.json" || (f === "pdf" ? n === "films.pdf" : n.startsWith(f === "tif" ? "tiff/" : "eps/")) }); }
      case "batch": return this.batch(args);
    }
  }
  async batch({ steps, terse, atomic = true, label = "" }) {
    if (!Array.isArray(steps) || !steps.length) throw new Error("batch: steps must be a non-empty array");
    const snap = this.job.snapshot(), before = this.problems(), results = [], reads = {}, added = [];
    const finish = () => !terse ? { ok: true, ...(label && { label }), results } : { ok: true, steps: results.length, reads, ...(added.length && { added }), ...(this.job.res && { screens: this.job.summary().screens }), new_problems: this.problems().filter(id => !before.includes(id)) };
    for (const [i, st] of steps.entries()) {
      try {
        if (!st || typeof st.tool !== "string") throw new Error(`needs {"tool": name, "arguments": {...}}`);
        if (st.tool === "batch") throw new Error("a batch cannot run in a batch");
        const v = valueOf(await this.run(st.tool, resolveRefs(st.arguments || {}, results), true)); results.push(v); if (TOOL[st.tool].read) reads[i] = v; if (v && v.added) added.push(...v.added);
      } catch (e) {
        const msg = `step ${i} (${st && st.tool}): ${e.message}`;
        if (atomic) { this.job.restore(snap); throw new Error(`${msg}. Nothing changed: the batch was undone.`); }
        const err = /** @type {any} */ (new Error(`${msg}. Steps 0 to ${i - 1} were kept (atomic: false).`)); err.keep = true;
        if (i > 0) { this.entry.undo.push({ snap, label: label || "batch" }); if (this.entry.undo.length > UNDO_MAX) this.entry.undo.shift(); }
        throw err;
      }
    }
    this.entry.undo.push({ snap, label: label || `batch of ${steps.length}` }); if (this.entry.undo.length > UNDO_MAX) this.entry.undo.shift();
    return finish();
  }
  /** A tools/call: the result, or an error result (isError) the agent can read. Logged when a log file is set. */
  async call(name, args) {
    const t0 = performance.now(); let res, err = null;
    try { res = await this.run(name, args); } catch (e) { err = e && e.message || String(e); res = { content: [{ type: "text", text: err }], isError: true }; }
    this.write({ time: new Date().toISOString(), client: this.client, job: this.entry.name, tool: name, arguments: args, ms: +(performance.now() - t0).toFixed(1), ok: !err, ...(err && { error: err }) });
    return res;
  }
  /** One line of JSON a call; the file starts again past 8 MB, keeping the one before as .1. Never fails the call. */
  write(entry) {
    if (!this.log) return;
    try { mkdirSync(dirname(this.log), { recursive: true }); if (existsSync(this.log) && statSync(this.log).size > 8 * 1024 * 1024) renameSync(this.log, this.log.replace(/(\.jsonl)?$/, ".1.jsonl"));
      appendFileSync(this.log, JSON.stringify(entry, (k, v) => typeof v === "string" && v.length > 4000 ? v.slice(0, 4000) + "…" : v) + "\n"); } catch { /* a log that cannot be written is left out */ }
  }
  /** One JSON-RPC message → its reply, or null for a notification. */
  async handle(msg) {
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") return { jsonrpc: "2.0", id: msg && msg.id !== undefined ? msg.id : null, error: { code: -32600, message: "invalid request" } };
    if (msg.id === undefined || msg.id === null) return null; // notification (notifications/initialized, cancelled)
    const p = msg.params || {}, ok = result => ({ jsonrpc: "2.0", id: msg.id, result });
    switch (msg.method) {
      case "initialize": this.client = p.clientInfo && p.clientInfo.name || null;
        return ok({ protocolVersion: PROTOCOLS.includes(p.protocolVersion) ? p.protocolVersion : PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "separation-table", title: "Separation Table", version: VERSION }, instructions: INSTRUCTIONS });
      case "ping": return ok({});
      case "tools/list": return ok({ tools: toolList() });
      case "resources/list": return ok({ resources: [] });
      case "prompts/list": return ok({ prompts: [] });
      case "tools/call": return ok(await this.call(String(p.name || ""), p.arguments));
      default: return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } };
    }
  }
}

/** Serve on stdin/stdout, one message a line, in order. Anything else the engine prints goes to stderr. */
export async function serve({ log = null, root = process.cwd() } = {}) {
  const server = new Server({ log, root }), out = m => process.stdout.write(JSON.stringify(m) + "\n");
  console.log = console.warn = console.info = (...a) => process.stderr.write(a.join(" ") + "\n"); // stdout carries JSON-RPC only
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue; let msg;
    try { msg = JSON.parse(line); } catch (e) { out({ jsonrpc: "2.0", id: null, error: { code: -32700, message: `parse error: ${e.message}` } }); continue; }
    if (Array.isArray(msg)) { const rs = []; for (const m of msg) { const r = await server.handle(m); if (r) rs.push(r); } if (rs.length) out(rs); }
    else { const r = await server.handle(msg); if (r) out(r); }
  }
}

/** Streamable HTTP (MCP 2025-06-18) on 127.0.0.1 only: POST /mcp with one JSON-RPC message (or a list) answers with
 *  JSON. A request whose Origin is not this machine's is refused (403), so a web page cannot drive the server
 *  (DNS rebinding). Resolves when the server closes. */
export function httpHandler(server, { token, port }) {
  if (!token || token.length < 32) throw new Error("httpHandler needs a token of 32 or more characters");
  const local = o => !o || /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(o), hosts = ["127.0.0.1", "localhost", "[::1]"].map(h => `${h}:${port}`), want = Buffer.from(`Bearer ${token}`);
  const authed = h => { const got = Buffer.from(String(h || "")); return got.length === want.length && timingSafeEqual(got, want); };
  return async (req, res) => {
    const send = (code, body, type = "application/json") => { res.writeHead(code, { "content-type": type }); res.end(body == null ? "" : typeof body === "string" ? body : JSON.stringify(body)); };
    // DNS rebinding: a name that resolves here still carries its own Host
    if (!hosts.includes(String(req.headers.host || "").toLowerCase())) return send(403, { jsonrpc: "2.0", id: null, error: { code: -32600, message: `host ${req.headers.host} is not allowed: use ${hosts.join(" or ")}` } });
    if (!authed(req.headers.authorization)) { res.setHeader("www-authenticate", "Bearer"); return send(401, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Authorization: Bearer <token> is required (the token sep mcp --port printed and wrote to its token file)" } }); }
    if (!local(req.headers.origin)) return send(403, { jsonrpc: "2.0", id: null, error: { code: -32600, message: `origin ${req.headers.origin} is not allowed: this server answers this machine only` } });
    if ((req.url || "").split("?")[0] !== "/mcp") return send(404, { error: "the MCP endpoint is /mcp" });
    if (req.method !== "POST") { res.setHeader("allow", "POST"); return send(405, { error: "POST JSON-RPC to /mcp; this server sends no event stream" }); }
    let body = ""; for await (const c of req) { body += c; if (body.length > 64 * 1024 * 1024) return send(413, { error: "request too large" }); }
    let msg; try { msg = JSON.parse(body); } catch (e) { return send(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: `parse error: ${e.message}` } }); }
    const rs = Array.isArray(msg) ? (await Promise.all(msg.map(m => server.handle(m)))).filter(Boolean) : await server.handle(msg);
    if (rs == null || (Array.isArray(rs) && !rs.length)) return send(202, null);
    send(200, rs);
  };
}
/** The bearer token's file for a port: ~/.separation-table/mcp-<port>.token, readable by its owner only. */
export const tokenFile = port => join(homedir(), ".separation-table", `mcp-${port}.token`);
export async function serveHTTP({ port, log = null, root = process.cwd() }) {
  const host = "127.0.0.1", token = randomBytes(32).toString("hex"), server = new Server({ log, root }), http = createServer(httpHandler(server, { token, port }));
  await new Promise((res, rej) => { http.once("error", rej); http.listen(port, host, () => res(null)); });
  const tf = tokenFile(port); mkdirSync(dirname(tf), { recursive: true, mode: 0o700 }); writeFileSync(tf, token + "\n", { mode: 0o600 }); chmodSync(tf, 0o600);
  process.stderr.write(`sep mcp: http://${host}:${port}/mcp (this machine only; Ctrl-C stops)\nsend Authorization: Bearer ${token}\ntoken file: ${tf}\n`);
  await new Promise(res => { process.on("SIGINT", () => http.close(() => res(null))); process.on("SIGTERM", () => http.close(() => res(null))); });
}
