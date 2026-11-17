#!/usr/bin/env node
// sep: the Separation Table on the command line, on the page's own engine (job.js). Run `sep help`.
import { readFileSync, readdirSync, existsSync, mkdirSync, statSync, writeFileSync, watch, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, extname, basename, resolve } from "node:path";
import * as J from "../job.js";
import { PRESETS, genericLibrary } from "../inks.js";
import { PRESS, meshFor } from "../plan.js";
import { lab2rgb, rgb2hex } from "../engine.js";
import { parseLimits, CHECK_LIMITS } from "../checks.js";
import { SIZE_PRESETS } from "../sizes.js";
import { Session, writeAtomic } from "./session.mjs";
import { loadVendor, VERSION } from "./platform.mjs";
/** Exit codes: check 0 clean, 1 warnings, 2 errors; 64 a usage error (EX_USAGE); 1 any other failure. */
const USAGE = 64;
class UsageError extends Error {}

/* ───────────── Flags ───────────── */
const kebab = k => k.replace(/[A-Z]/g, c => "-" + c.toLowerCase());
/** --flag → setting key. Every setting has its own flag; --shirt, --mode and --width are the short names a shop uses. */
const FLAGS = { ...Object.fromEntries(Object.keys(J.SETTINGS).map(k => [kebab(k), k])), shirt: "garment", mode: "method", width: "widthIn", inks: "inkSource", white: "forceWhite" };
/** --mode values a shop types, beside the engine's own names (job.VALUE_ALIASES). */
const MODE_ALIAS = J.VALUE_ALIASES.method;
const MODE_VALUES = ["sim", "spot", "index", "cmyk", "duotone", "gray", "tritone"];
/** Flags that set the shop's context, not a setting: the platen size, a separation.json to reuse, a shop profile, the
 *  check limits. */
const SHOP = ["platen", "spec", "profile", "check-limits", "allow-outside", "art"];
const COMMON = ["json", "quiet"], OUT = ["o", "out", "formats"];
const COMMANDS = {
  convert: { args: "<art.png | job.json | films.psd | film.tif | tiff-dir/>", flags: [...Object.keys(FLAGS), ...SHOP, ...OUT, ...COMMON], about: "art or a job file → the files named by -o, by extension (.zip job ZIP, .pdf films, .psd, .png print preview, separation.json, other .json the job file, dir/ the job's files)" },
  check: { args: "<art.png | job.json>", flags: [...Object.keys(FLAGS), ...SHOP, ...COMMON], about: "pre-print checks; exit 0 clean, 1 warnings, 2 errors" },
  info: { args: "<job.zip | job.json | art.png>", flags: ["width", ...COMMON], about: "what a job ZIP or job file holds, or what an art file is" },
  inks: { args: "[preset]", flags: COMMON, about: "the ink library (generic) or a preset's inks" },
  garments: { args: "", flags: COMMON, about: "garment colours by name (--garment takes a name or #rrggbb)" },
  presets: { args: "", flags: COMMON, about: "ink presets, press profiles, sizes, check limits, and every setting with its default and range" },
  profiles: { args: "", flags: COMMON, about: "same as presets" },
  watch: { args: "<in-dir> <out-dir>", flags: [...Object.keys(FLAGS), ...SHOP, "formats", "quiet"], about: "hot folder: each new art file becomes <out-dir>/<name>.zip" },
  mcp: { args: "", flags: ["log", "port", "root"], about: "MCP server on stdio (JSON-RPC); --port N serves Streamable HTTP on 127.0.0.1:N/mcp instead (bearer token printed and kept in ~/.separation-table/mcp-N.token); --root DIR: the only folder its tools read and write (default the working directory); --log FILE keeps a JSONL log of every call" },
  version: { args: "", flags: [], about: "print the version" },
  help: { args: "", flags: [], about: "this help" },
};
const BOOL_FLAGS = new Set(["json", "quiet", "allow-outside", ...Object.entries(FLAGS).filter(([, k]) => typeof J.SETTINGS[k].def === "boolean").map(([f]) => f)]);

/** Parse argv for a command: positional args, settings, and the other flags. Unknown flags are refused. */
export function parseArgs(cmd, argv) {
  const spec = COMMANDS[cmd], pos = [], settings = {}, other = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; if (!a.startsWith("-") || a === "-") { pos.push(a); continue; }
    let [name, val] = a.replace(/^--?/, "").split(/=(.*)/s); let neg = false;
    if (name.startsWith("no-") && BOOL_FLAGS.has(name.slice(3))) { neg = true; name = name.slice(3); }
    if (!spec.flags.includes(name)) throw new UsageError(`sep ${cmd}: unknown flag --${name}. Valid flags: ${spec.flags.map(f => f.length === 1 ? "-" + f : "--" + f).join(" ") || "none"}`);
    if (BOOL_FLAGS.has(name)) { if (val === undefined) val = neg ? "false" : "true"; }
    else if (val === undefined) { val = argv[++i]; if (val === undefined) throw new UsageError(`sep ${cmd}: --${name} needs a value`); }
    const key = FLAGS[name];
    if (key && spec.flags.includes(name) && !OUT.includes(name)) {
      let v = val; if (key === "method") { if (!MODE_VALUES.includes(v) && !J.SETTINGS.method.values.includes(v)) throw new UsageError(`--${name} "${v}" is not valid. Valid: ${MODE_VALUES.join(", ")}`); v = MODE_ALIAS[v] || v; }
      try { settings[key] = J.parseSetting(key, v); } catch (e) { throw new UsageError(`--${name}: ${e.message}`); }
    } else if (name === "o" || name === "out") (other.out ||= []).push(val);
    else other[name] = val;
  }
  return { pos, settings, other };
}
/** --platen 16x18 (inches, across × along the shirt) or a preset id. */
export function parsePlaten(v) {
  const m = /^(\d+(?:\.\d+)?)\s*[x×X]\s*(\d+(?:\.\d+)?)$/.exec(String(v).trim()); if (m) return { id: "custom", w: +m[1], h: +m[2] };
  if (SIZE_PRESETS.platen.some(p => p.id === v)) return { id: v };
  throw new UsageError(`--platen "${v}" is not WxH in inches (e.g. 16x18) or a platen: ${SIZE_PRESETS.platen.map(p => `${p.id} (${p.w}x${p.h})`).join(", ")}`);
}
/** A session for one input: its shop context, the input (art or a job file), then a separation.json's inks, then the
 *  settings flags, which win over the profile and the spec. */
async function prepare(file, { settings, other: other0 }) {
  let other = other0;
  const s = new Session();
  const films = /\.(psd|tiff?)$/i.test(file) || (existsSync(file) && statSync(file).isDirectory());
  if (/\.json$/i.test(file)) await s.openJob(file, { run: false, allowOutside: other["allow-outside"] === "true" });
  else if (films) { if (other.art) await s.load(other.art); let spec = null; if (other.spec) try { spec = JSON.parse(readFileSync(other.spec, "utf8")); } catch (e) { throw new UsageError(`--spec: ${e.message}`); }
    await s.importFilms([file], spec); other = { ...other, spec: undefined }; }
  else { if (other.art) throw new UsageError("--art goes with films (a .psd, .tif or a folder of .tif) to re-proof"); await s.load(file); }
  if (other.profile) { const [path, name = ""] = String(other.profile).split("#"); let p;
    try { p = J.pickProfile(readFileSync(path, "utf8"), name); } catch (e) { throw new UsageError(`--profile: ${e.message}`); } s.useProfile(p); }
  if (other.platen) try { s.setSizes({ platen: parsePlaten(other.platen) }); } catch (e) { throw e instanceof UsageError ? e : new UsageError(`--platen: ${e.message}`); }
  if (other["check-limits"]) try { s.setLimits(parseLimits(other["check-limits"])); } catch (e) { throw new UsageError(`--check-limits: ${e.message}`); }
  if (other.spec) { let spec; try { spec = JSON.parse(readFileSync(other.spec, "utf8")); s.applySpec(spec); } catch (e) { throw new UsageError(`--spec: ${e.message}`); } }
  if (Object.keys(settings).length) s.set(settings);
  if (other.formats) s.set({ formats: parseFormats(other.formats) });
  return s;
}
/** What an -o path makes, by its extension: an Error lists what is valid. */
function outKind(o) {
  if (/[\/\\]$/.test(o) || (existsSync(o) && statSync(o).isDirectory())) return "folder";
  const e = extname(o).toLowerCase(); if (basename(o).toLowerCase() === "separation.json") return "spec";
  const k = { ".zip": "zip", ".pdf": "pdf", ".psd": "psd", ".png": "png", ".json": "job" }[e];
  if (!k) throw new UsageError(`-o ${o}: ${e || "no extension"} is not an output. Outputs: .zip (job ZIP), .pdf (films), .psd (Photoshop file), .png (print preview), separation.json, other .json (job file), dir/ (the job's files)`);
  return k;
}
/** Write each -o output; the job's files are made once for all of them. */
async function writeOutputs(s, outs, say) {
  const kinds = outs.map(outKind), done = []; let built = null; const build = async () => built ||= await s.buildJob({ say });
  const member = async (o, test, what) => { const b = await build(), e = b.entries.find(([n]) => test(n)); if (!e) throw new UsageError(`-o ${o}: the job has no ${what} (see --formats)`); writeAtomic(o, e[1]); return { path: o, bytes: e[1].length }; };
  for (const [i, o] of outs.entries()) switch (kinds[i]) {
    case "zip": done.push(await s.exportJob(o, { built: await build() })); break;
    case "folder": done.push(await s.exportFolder(o, { overwrite: true })); break;
    case "pdf": done.push(await member(o, n => n === "films.pdf", "films.pdf")); break;
    case "psd": done.push(await member(o, n => n.endsWith(".psd") && !n.endsWith("-preview-rgb.psd"), "Photoshop file")); break;
    case "spec": done.push(await member(o, n => n === "separation.json", "separation.json")); break;
    case "png": { const p = s.previewPrint(); writeAtomic(o, p.png); done.push({ path: o, bytes: p.png.length }); break; }
    case "job": done.push(s.saveJob(o, { overwrite: true })); break;
  }
  return done;
}
function parseFormats(list) {
  const f = Object.fromEntries(Object.keys(J.FORMATS).map(k => [k, false])), names = { "psd-preview": "psdPreview", tiff: "tif" };
  for (const x of String(list).split(",").map(t => t.trim()).filter(Boolean)) { const k = names[x] || x; if (!(k in f)) throw new UsageError(`--formats: "${x}" is not valid. Valid: pdf, tif, png, eps, svg, psd, psd-preview, dcs`); f[k] = true; }
  return f;
}

/* ───────────── Output ───────────── */
const SEV = { error: "ERROR", warning: "WARN ", note: "NOTE " };
function printChecks(list) {
  if (!list.length) { console.log("clean: no checks fired"); return; }
  for (const c of list) {
    console.log(`${SEV[c.severity]} ${c.id}  ${c.title}`);
    console.log(`       measured ${c.measured}; limit ${c.limit}`);
    if (c.fix.length) console.log(`       fix: ${c.fix.map(f => f.label).join(" | ")}`);
    for (const g of c.colors || []) console.log(`       ${g.hex} ${g.name}: ${(g.area * 100).toFixed(1)}% of the art, off by ${g.de.toFixed(0)} dE`);
  }
}
const checkExit = list => list.some(c => c.severity === "error") ? 2 : list.some(c => c.severity === "warning") ? 1 : 0;
function printSummary(sum) {
  console.log(`${sum.method_name} on ${sum.garment}: ${sum.screens} screens${sum.auto ? ` (Auto: ${sum.auto.method}, ${sum.auto.screens ?? "method"} color screens)` : ""}`);
  for (const f of sum.films) console.log(`  ${String(f.order).padStart(2)}. ${f.name.padEnd(18)} ${f.hex}  ${String(f.coverage_pct).padStart(5)}%  ${f.angle}°  mesh ${f.mesh}`);
  const sc = sum.score; console.log(`  print dE00 ${sc.aligned_de00} aligned, ${sc.press_de00} with press drift; ${sc.within_cmc2_pct}% within CMC 2; ink stack p99 ${sc.ink_stack_p99_pct}%`);
  if (sum.rating) console.log(`  rating ${sum.rating.stars.toFixed(1)} of 5 (a model rating, not measured)${sum.rating.failed_checks ? `; ${sum.rating.failed_checks} check${sum.rating.failed_checks > 1 ? "s" : ""} to do` : ""}`);
}

/* ───────────── Commands ───────────── */
async function convert(a) {
  const { pos, other } = a; if (pos.length !== 1) throw new UsageError("sep convert: give one art file or job file. Usage: sep convert art.png [flags] -o job.zip [-o films.pdf ...]");
  const outs = other.out || [basename(pos[0], extname(pos[0])) + ".zip"]; outs.forEach(outKind);
  const s = await prepare(pos[0], a), sum = await s.separate(), checks = s.checks();
  const done = await writeOutputs(s, outs, other.quiet || other.json || !process.stderr.isTTY ? () => {} : t => { process.stderr.write(`\r\x1b[K  ${t}`); });
  if (other.json) console.log(JSON.stringify({ ...done[0], outputs: done, separation: sum, checks: checks.map(stripRegions) }, null, 1));
  else if (!other.quiet) { process.stderr.write("\x1b[K"); printSummary(sum); if (checks.length) printChecks(checks);
    for (const r of done) console.log(`wrote ${r.path || r.folder} (${((r.bytes || 0) / 1e6).toFixed(1)} MB${r.files ? `, ${r.files.length} files` : ""})`); }
  return 0;
}
const stripRegions = ({ region, ...c }) => ({ ...c, ...(region && { region: region.box }), ...(c.colors && { colors: c.colors.map(({ region, ...g }) => g) }) });
async function check(a) {
  const { pos, other } = a; if (pos.length !== 1) throw new UsageError("sep check: give one art file or job file. Usage: sep check art.png [flags] [--json]");
  const s = await prepare(pos[0], a), sum = await s.separate(), list = s.checks();
  if (other.json) console.log(JSON.stringify({ separation: sum, checks: list.map(stripRegions) }, null, 1));
  else { if (!other.quiet) printSummary(sum); printChecks(list); }
  return checkExit(list);
}
async function info({ pos, settings, other }) {
  if (pos.length !== 1) throw new UsageError("sep info: give one job ZIP or art file");
  const f = pos[0];
  if (/\.zip$/i.test(f)) {
    loadVendor(); const zip = await new (/** @type {any} */ (globalThis).JSZip)().loadAsync(readFileSync(f)), files = Object.keys(zip.files).filter(n => !zip.files[n].dir);
    const sj = zip.file("separation.json"); if (!sj) throw new Error(`${f}: no separation.json (not a Separation Table job ZIP)`);
    const spec = JSON.parse(await sj.async("string"));
    if (other.json) { console.log(JSON.stringify({ files, separation: spec }, null, 1)); return 0; }
    console.log(`${f}: ${spec.method || spec.separation} on ${spec.garment.hex}, ${spec.print.width_in} in wide, ${spec.print.dpi} DPI, ${spec.print.lpi} LPI, created ${spec.created}`);
    for (const sc of spec.screens) console.log(`  ${String(sc.order).padStart(2)}. ${sc.name.padEnd(18)} ${(sc.coverage * 100).toFixed(1).padStart(5)}%  ${sc.angle ?? "solid"}${sc.angle != null ? "°" : ""}  mesh ${sc.mesh}${sc.flash ? "  flash" : ""}${sc.cure ? "  cure" : ""}`);
    console.log(`  ${files.length} files: ${files.join(", ")}`); return 0;
  }
  if (/\.json$/i.test(f)) { const d = J.readJobFile(readFileSync(f, "utf8"));
    if (other.json) { console.log(JSON.stringify(d, null, 1)); return 0; }
    console.log(`${f}: job file for ${d.art ? `${d.art.file} (${d.art.path})` : "no art"}, ${d.settings.method || "sim"} on ${d.settings.garment || J.SETTINGS.garment.def}, ${d.inks ? d.inks.length + " inks: " + d.inks.map(i => i.name).join(", ") : "inks picked on open"}`); return 0; }
  const s = new Session(); s.set(settings); const a = await s.load(f);
  if (other.json) console.log(JSON.stringify(a, null, 1));
  else console.log(`${a.file}: ${a.width_px} × ${a.height_px} px, ${a.ppi_at_width} ppi at ${a.width_in} in, ${a.transparent_pct}% transparent${a.solid_background ? `, solid ${a.solid_background} background` : ""}. ${a.info}`);
  return 0;
}
function inks({ pos, other }) {
  const key = pos[0]; if (key && !PRESETS[key]) throw new UsageError(`sep inks: no preset "${key}". Presets: ${Object.keys(PRESETS).join(", ")}`);
  const list = (key ? PRESETS[key].inks() : genericLibrary()).map(i => ({ name: i.name, hex: rgb2hex(lab2rgb(i.lab)).toUpperCase(), lab: i.lab.map(v => +v.toFixed(1)), system: i.system || "", code: i.code || "" }));
  if (other.json) console.log(JSON.stringify(list, null, 1)); else for (const i of list) console.log(`${i.hex}  ${i.name}${i.code ? `  (${i.system} ${i.code})` : ""}  L${i.lab.join("/")}`);
  return 0;
}
function garments({ other }) {
  const list = Object.entries(J.GARMENTS).map(([name, hex]) => ({ name, hex: hex.toUpperCase() }));
  if (other.json) console.log(JSON.stringify(list, null, 1)); else for (const g of list) console.log(`${g.hex}  ${g.name}`);
  return 0;
}
function presets({ other }) {
  const data = { ink_presets: Object.fromEntries(Object.entries(PRESETS).map(([k, p]) => [k, { name: p.name, inks: p.inks().length }])),
    press_profiles: Object.fromEntries(Object.entries(PRESS).map(([k, p]) => [k, { registration_drift_mm: p.mm, overlap_rho: p.rho }])),
    mesh_rule: `230 + 5 × (LPI − 45), snapped to stock; at 45 LPI: ${meshFor(45)}`, platens: SIZE_PRESETS.platen, check_limits: CHECK_LIMITS, aliases: J.VALUE_ALIASES,
    settings: Object.fromEntries(Object.entries(J.SETTINGS).map(([k, v]) => [kebab(k), { default: v.def, ...(v.values ? { values: v.values } : { range: v.range }), help: v.help }])) };
  if (other.json) { console.log(JSON.stringify(data, null, 1)); return 0; }
  console.log("Ink presets (sep inks <preset>):"); for (const [k, p] of Object.entries(data.ink_presets)) console.log(`  ${k.padEnd(14)} ${p.name}, ${p.inks} inks`);
  console.log("Press profiles (--press):"); for (const [k, p] of Object.entries(data.press_profiles)) console.log(`  ${k.padEnd(14)} registration drift ${p.registration_drift_mm} mm`);
  console.log(`Mesh: ${data.mesh_rule}`); console.log(`Platens (--platen id or WxH): ${SIZE_PRESETS.platen.map(p => `${p.id} ${p.w}x${p.h}`).join(", ")}`);
  console.log(`Check limits (--check-limits name=value,...): ${Object.entries(CHECK_LIMITS).map(([k, d]) => `${k} (default ${d.def}, ${d.range.join(" to ")} ${d.unit})`).join(", ")}`);
  console.log("Settings (--flag, default, valid):");
  for (const [k, v] of Object.entries(data.settings)) { const al = J.VALUE_ALIASES[J.SETTINGS[k] ? k : FLAGS[k]];
    console.log(`  --${k.padEnd(13)} ${String(v.default).padEnd(9)} ${v.values ? v.values.join("|") + (al ? ` (also ${Object.keys(al).join("|")})` : "") : v.range ? v.range.join(" to ") : ""}  ${v.help}`); }
  return 0;
}
const ART = /\.(png|jpe?g|webp)$/i;
/** Hot folder: each art file that appears (and stops growing) becomes a job ZIP; failures leave <name>.error.txt. */
async function watchDirs({ pos, settings, other }) {
  if (pos.length !== 2) throw new UsageError("sep watch: give an input and an output folder. Usage: sep watch <in-dir> <out-dir> [flags]");
  const [inDir, outDir] = pos; if (!existsSync(inDir) || !statSync(inDir).isDirectory()) throw new UsageError(`sep watch: ${inDir} is not a folder`);
  mkdirSync(outDir, { recursive: true }); const seen = new Map(), queue = []; let busy = false;
  const log = t => { if (!other.quiet) console.log(`${new Date().toISOString().slice(11, 19)} ${t}`); };
  const outFor = f => join(outDir, basename(f, extname(f)) + ".zip");
  const run = async () => { if (busy) return; busy = true;
    while (queue.length) { const f = queue.shift(), p = join(inDir, f), out = outFor(f);
      try { const s = await prepare(p, { settings, other }); await s.separate(); const c = s.checks(), r = await s.exportJob(out);
        log(`${f} -> ${out} (${r.screens} screens${c.length ? `; ${c.filter(x => x.severity !== "note").map(x => x.id).join(", ") || "notes only"}` : ""})`); }
      catch (e) { writeFileSync(join(outDir, basename(f, extname(f)) + ".error.txt"), String(e && e.message || e) + "\n"); log(`${f} FAILED: ${e.message}`); } }
    busy = false; };
  // a file is taken once its size holds still for one poll (a copy in progress keeps growing)
  const scan = () => { for (const f of readdirSync(inDir)) { if (!ART.test(f) || f.startsWith(".")) continue; let st; try { st = statSync(join(inDir, f)); } catch { continue; }
      const key = `${st.size}:${st.mtimeMs}`, prev = seen.get(f); if (prev === "done:" + key) continue;
      if (prev === key) { seen.set(f, "done:" + key); if (!existsSync(outFor(f)) || statSync(outFor(f)).mtimeMs < st.mtimeMs) { queue.push(f); run(); } } else seen.set(f, key); } };
  log(`watching ${inDir} -> ${outDir} (Ctrl-C stops)`); scan(); const timer = setInterval(scan, 1000);
  try { watch(inDir, () => scan()); } catch { /* polling alone still works */ }
  await new Promise(res => process.on("SIGINT", () => { clearInterval(timer); res(null); }));
  return 0;
}
function help() {
  console.log(`sep ${VERSION}: screen-print separations on the Separation Table engine\n`);
  for (const [k, c] of Object.entries(COMMANDS)) console.log(`  sep ${(k + " " + c.args).padEnd(32)} ${c.about}`);
  console.log(`\nMain flags: --garment black|#rrggbb (--shirt)  --mode ${MODE_VALUES.join("|")}  --screens N|auto\n  --lpi 45 --angle 22.5 --dot ${J.SETTINGS.dot.values.join("|")} --screening one-angle|rotated|interlocked|index\n  --width IN --platen WxH --press manual|automatic --min-dot PCT --profile profiles.json[#name]\n  --spec separation.json --check-limits min-ppi=250,small-screen=1 -o job.zip -o films.pdf -o proof.png -o job.json\nAll flags with defaults and ranges: sep presets`);
  return 0;
}

export async function main(argv) {
  const [cmd = "help", ...rest] = argv;
  const name = cmd === "--help" || cmd === "-h" ? "help" : cmd === "--version" || cmd === "-v" ? "version" : cmd;
  try {
    if (!COMMANDS[name]) throw new UsageError(`sep: unknown command "${cmd}". Commands: ${Object.keys(COMMANDS).join(", ")}`);
    const a = parseArgs(name, rest);
    switch (name) {
      case "convert": return await convert(a);
      case "check": return await check(a);
      case "info": return await info(a);
      case "inks": return inks(a);
      case "garments": return garments(a);
      case "presets": case "profiles": return presets(a);
      case "watch": return await watchDirs(a);
      case "mcp": { const { serve, serveHTTP } = await import("./mcp.mjs"), log = a.other.log || process.env.SEP_MCP_LOG || null, root = resolve(a.other.root || ".");
        if (!existsSync(root) || !statSync(root).isDirectory()) throw new UsageError(`--root ${root} is not a folder`);
        if (a.other.port != null) { const port = Number(a.other.port); if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UsageError(`--port "${a.other.port}" is not a port number (1 to 65535)`); await serveHTTP({ port, log, root }); } else await serve({ log, root }); return 0; }
      case "version": console.log(`sep ${VERSION}`); return 0;
      default: return help();
    }
  } catch (e) { console.error(e instanceof UsageError ? e.message : `sep ${name}: ${e && e.message || e}`); return e instanceof UsageError ? USAGE : 1; }
}
const isMain = (() => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) process.exitCode = await main(process.argv.slice(2));
