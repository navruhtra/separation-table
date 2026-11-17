// sep CLI and MCP server: flags, exit codes, the job ZIP, the hot folder and an MCP round trip with a scripted client.
//   node tests/cli.mjs        (needs vendor/: npm run setup)
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { encodePNG, decodePNG, loadVendor } from "../src/cli/platform.mjs";
import { toolList, checkArgs, resolveRefs, Server, httpHandler } from "../src/cli/mcp.mjs";
import * as J from "../src/job.js";
import { createServer, request } from "node:http";

const HERE = dirname(fileURLToPath(import.meta.url)), SEP = join(HERE, "..", "src", "cli", "sep.mjs"), TMP = mkdtempSync(join(tmpdir(), "sep-cli-"));
let fails = 0; const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails++; };
const sep = (...a) => spawnSync(process.execPath, ["--no-warnings", SEP, ...a], { encoding: "utf8", timeout: 300000 });

/* Test art, written as PNG: flat discs on transparent (240 ppi at 1 in wide), the same on an opaque red box. */
function art(file, { W = 240, box = null } = {}) {
  const d = new Uint8ClampedArray(W * W * 4);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) { const q = (y * W + x) * 4, r = Math.hypot(x - W / 2, y - W / 2);
    const c = r < W * 0.2 ? [240, 200, 30] : r < W * 0.4 ? [30, 90, 200] : box; if (c) { d[q] = c[0]; d[q + 1] = c[1]; d[q + 2] = c[2]; d[q + 3] = 255; } }
  const p = join(TMP, file); writeFileSync(p, encodePNG(d, W, W)); return p;
}
const clean = art("discs.png"), boxed = art("boxed.png", { box: [200, 20, 20] });
const FAST = ["--shirt", "white", "--width", "1", "--dpi", "150", "--screens", "2"];

// PNG: the writer's output reads back pixel for pixel
{ const d = new Uint8ClampedArray(7 * 3 * 4).map((_, i) => (i * 37) & 255), r = decodePNG(encodePNG(d, 7, 3)); ok(r.W === 7 && r.H === 3 && r.rgba.every((v, i) => v === d[i]), "a PNG the CLI writes reads back pixel for pixel"); }

// flags: unknown ones and bad values are refused with what is valid (exit 64)
{ const r = sep("convert", clean, "--lpl", "45"); ok(r.status === 64 && /unknown flag --lpl/.test(r.stderr) && /--lpi/.test(r.stderr), "an unknown flag is refused with the list of valid flags"); }
{ const r = sep("convert", clean, "--dot", "star"); ok(r.status === 64 && /round, ellipse, square, line/.test(r.stderr), "a bad --dot lists the valid dot shapes"); }
{ const r = sep("convert", clean, "--mode", "sepia"); ok(r.status === 64 && /sim, spot, index, cmyk, duotone, gray/.test(r.stderr), "a bad --mode lists the valid modes"); }
{ const r = sep("check", clean, "--lpi", "200"); ok(r.status === 64 && /20 to 85/.test(r.stderr), "an out-of-range --lpi gives the range"); }
{ const r = sep("frobnicate"); ok(r.status === 64 && /Commands: convert, check/.test(r.stderr), "an unknown command lists the commands"); }
{ const r = sep("version"); ok(r.status === 0 && /^sep \d+\.\d+\.\d+/.test(r.stdout), `sep version prints the version (${r.stdout.trim()})`); }
{ const r = sep("presets", "--json"), j = JSON.parse(r.stdout); ok(r.status === 0 && j.settings.dot.values.length === 4 && j.press_profiles.manual, "sep presets lists press profiles and every setting"); }
{ const r = sep("inks", "--json"), j = JSON.parse(r.stdout); ok(r.status === 0 && j.length > 5 && j.every(i => /^#[0-9A-F]{6}$/.test(i.hex)), `sep inks lists the shelf (${j.length} inks)`); }

// check: exit 0 clean, 1 warnings, 2 errors
{ const r = sep("check", clean, ...FAST, "--json"), j = JSON.parse(r.stdout); ok(r.status === 0 && j.checks.every(c => c.severity === "note"), `sep check exits 0 for clean art (${j.checks.map(c => c.id).join(", ") || "no checks"})`);
  ok(j.checks.every(c => c.measured && c.limit && Array.isArray(c.fix)), "every check carries severity, measurement, limit and fix"); }
{ const r = sep("check", boxed, ...FAST); ok(r.status === 2 && /ERROR solid-background/.test(r.stdout) && /rating \d\.\d of 5/.test(r.stdout), "a solid background box exits 2 (error), names the check and gives the rating"); }
{ const r = sep("check", clean, "--shirt", "white", "--width", "11", "--dpi", "150", "--screens", "2"); ok(r.status === 1 && /WARN  low-resolution/.test(r.stdout), "240 px art at 11 in exits 1 (low-resolution warning)"); }

// convert: the job ZIP holds the page's files, TIFFs in separation.json order
const zipPath = join(TMP, "job.zip");
{ const r = sep("convert", clean, ...FAST, "--dot", "ellipse", "-o", zipPath, "--quiet"); ok(r.status === 0 && existsSync(zipPath), "sep convert writes the job ZIP");
  loadVendor(); const zip = await new globalThis.JSZip().loadAsync(readFileSync(zipPath)), names = Object.keys(zip.files).filter(n => !zip.files[n].dir), spec = JSON.parse(await zip.file("separation.json").async("string"));
  ok(["films.pdf", "mix-sheet.pdf", "job-sheet.pdf", "separation.json"].every(n => names.includes(n)) && names.some(n => n.endsWith(".psd")), `the ZIP has films.pdf, mix sheet, job sheet, separation.json and the PSD (${names.length} files)`);
  ok(JSON.stringify(names.filter(n => n.startsWith("tiff/")).map(n => n.slice(5, -4))) === JSON.stringify(spec.screens.map(s => s.file)), "one TIFF per screen, in separation.json order");
  ok(spec.print.dot_shape === "ellipse" && spec.print.dpi === 150 && spec.garment.hex === "#ffffff", "separation.json records the flags (dot shape, DPI, garment)");
  const tif = await zip.file(names.find(n => n.startsWith("tiff/"))).async("uint8array"), dv = new DataView(tif.buffer, tif.byteOffset);
  ok(dv.getUint16(0) === 0x4949 && dv.getUint16(2, true) === 42, "the TIFFs are little-endian TIFF files");
  const r2 = sep("info", zipPath, "--json"), j2 = JSON.parse(r2.stdout); ok(r2.status === 0 && j2.separation.screens.length === spec.screens.length, "sep info reads the job ZIP back"); }
// --formats dcs: the DCS 2.0 file, from the same shared writer as the page
{ const zp = join(TMP, "dcs.zip"), r = sep("convert", clean, ...FAST, "--dot", "line", "--formats", "tif,dcs", "-o", zp, "--quiet");
  const zip = r.status === 0 ? await new globalThis.JSZip().loadAsync(readFileSync(zp)) : null, eps = zip && Object.keys(zip.files).find(n => n.endsWith("-dcs2.eps"));
  const head = eps ? (await zip.file(eps).async("string")).slice(0, 4000) : "";
  ok(!!eps && /^%!PS-Adobe-3\.0/.test(head) && /%%PlateFile/.test(head) && !Object.keys(zip.files).some(n => n.endsWith(".psd")), `sep convert --formats tif,dcs writes the DCS 2.0 file and no PSD (${eps || r.stderr.trim().slice(0, 80)})`); }
// --mirror mirror: mirrored films, and the DCS file honours it: plates flip and each screen angle reads 180° − θ
{ const run = (m, f) => { const zp = join(TMP, `mir-${m}.zip`), r = sep("convert", clean, ...FAST, "--mirror", m, "--formats", f, "-o", zp, "--quiet"); return r.status === 0 ? new globalThis.JSZip().loadAsync(readFileSync(zp)) : Promise.resolve(null); };
  const [zr, zm] = [await run("right", "tif,dcs"), await run("mirror", "tif,dcs")], dcsOf = async z => z ? z.file(Object.keys(z.files).find(n => n.endsWith("-dcs2.eps"))).async("binarystring") : "";
  const [dr, dm] = [await dcsOf(zr), await dcsOf(zm)], spec = zm ? JSON.parse(await zm.file("separation.json").async("string")) : null;
  ok(!!spec && spec.print.mirror === true && spec.print.film_reading === "mirrored, emulsion down" && /\b22\.50*\b[^\n]*setscreen/.test(dr) && /\b157\.50*\b[^\n]*setscreen/.test(dm) && !/\b22\.50*\b[^\n]*setscreen/.test(dm),
    "sep --mirror mirror: separation.json says mirrored, and the DCS plates carry the mirrored angle (22.5° → 157.5°)"); }
{ const r = sep("info", clean, "--width", "1"); ok(r.status === 0 && /240 × 240 px, 240 ppi at 1 in/.test(r.stdout), `sep info describes an art file (${r.stdout.trim().slice(0, 60)})`); }

// watch: a file dropped in the hot folder becomes a ZIP in the out folder
{ const inD = join(TMP, "in"), outD = join(TMP, "out"); spawnSync("mkdir", ["-p", inD]);
  const child = spawn(process.execPath, ["--no-warnings", SEP, "watch", inD, outD, ...FAST], { stdio: "ignore" });
  writeFileSync(join(inD, "drop.png"), readFileSync(clean));
  let made = false; for (let i = 0; i < 240 && !made; i++) { await new Promise(r => setTimeout(r, 500)); made = existsSync(join(outD, "drop.zip")); }
  child.kill("SIGINT"); ok(made && !readdirSync(outD).some(f => f.endsWith(".error.txt")), "sep watch turns a dropped art file into <name>.zip"); }


// CLI flags: each new one validated with the valid list, and recorded in the job
const specOf = async zp => JSON.parse(await (await new globalThis.JSZip().loadAsync(readFileSync(zp))).file("separation.json").async("string"));
{ const zp = join(TMP, "flags.zip"), r = sep("convert", clean, ...FAST, "--screening", "interlocked", "--press", "automatic", "--min-dot", "9", "--garment", "navy", "-o", zp, "--quiet"), j = r.status === 0 ? await specOf(zp) : null;
  ok(j && j.print.screening === "lock" && j.print.press === "automatic" && j.print.min_dot === 9 && j.garment.hex === "#1c2a4a", "--screening interlocked, --press automatic, --min-dot 9 and --garment navy land in separation.json"); }
{ const r = sep("check", clean, "--screening", "crosshatch"); ok(r.status === 64 && /one-angle \(same\), interlocked \(lock\)/.test(r.stderr), "a bad --screening lists one-angle, rotated, interlocked and index"); }
{ const r = sep("check", clean, "--garment", "puce"); ok(r.status === 64 && /black, white, navy/.test(r.stderr), "a bad --garment lists the garment names"); }
{ const r = sep("check", clean, "--press", "hand"); ok(r.status === 64 && /manual, automatic/.test(r.stderr), "a bad --press lists manual and automatic"); }
{ const r = sep("check", clean, "--min-dot", "50"); ok(r.status === 64 && /0 to 20/.test(r.stderr), "an out-of-range --min-dot gives the range"); }
{ const r = sep("check", clean, "--shirt", "white", "--width", "3", "--dpi", "150", "--screens", "2", "--platen", "2x2"); ok(r.status === 2 && /too-large-platen/.test(r.stdout), "--platen 2x2 under a 3 in print is an error check (exit 2)"); }
{ const r = sep("check", clean, "--platen", "huge"); ok(r.status === 64 && /youth \(14x16\), standard \(16x18\)/.test(r.stderr), "a bad --platen lists WxH and the platen presets"); }
{ const r = sep("check", clean, ...FAST, "--check-limits", "min-ppi=300"); ok(r.status === 1 && /low-resolution/.test(r.stdout) && /300 ppi/.test(r.stdout), "--check-limits min-ppi=300 makes 240 ppi art a warning"); }
{ const r = sep("check", clean, "--check-limits", "max-fun=3"); ok(r.status === 64 && /min-ppi .*small-screen .*manual-max-lpi/.test(r.stderr), "an unknown --check-limits name lists the limits"); }
const profs = join(TMP, "profiles.json"); writeFileSync(profs, JSON.stringify({ format: "adn-separation-table-profiles", version: 1, profiles: [
  { name: "Auto press", press: "automatic", lpi: 55, angle: 22.5, dpi: 150, gain: 18, minDot: 5, maxDot: 90, dotShape: "ellipse", mesh: { base: 156, color: 305, white: null }, sizes: { platen: { id: "youth" }, film: { id: "custom", w: 12, h: 18 } } },
  { name: "Manual", press: "manual", lpi: 45, angle: 22.5, dpi: 150, gain: 22, minDot: 6, maxDot: 92, dotShape: "round", mesh: {} }] }));
{ const zp = join(TMP, "prof.zip"), r = sep("convert", clean, "--shirt", "white", "--width", "1", "--screens", "2", "--profile", `${profs}#Auto press`, "-o", zp, "--quiet"), j = r.status === 0 ? await specOf(zp) : null;
  ok(j && j.print.press === "automatic" && j.print.lpi === 55 && j.print.dot_shape === "ellipse" && j.screens.every(sc => sc.mesh === 305), "--profile file#name sets press, LPI, dot and the profile's colour mesh"); }
{ const jp = join(TMP, "prof-job.json"), r = sep("convert", clean, "--shirt", "white", "--width", "1", "--screens", "2", "--profile", `${profs}#Auto press`, "-o", jp, "--quiet"), z = r.status === 0 ? JSON.parse(readFileSync(jp, "utf8")).shop.sizes : null;
  const r2 = sep("convert", clean, "--shirt", "white", "--width", "1", "--screens", "2", "--profile", `${profs}#Auto press`, "--platen", "16x18", "-o", jp, "--quiet"), z2 = r2.status === 0 ? JSON.parse(readFileSync(jp, "utf8")).shop.sizes : null;
  const r3 = sep("convert", clean, "--shirt", "white", "--width", "1", "--screens", "2", "--profile", `${profs}#Manual`, "-o", jp, "--quiet"), z3 = r3.status === 0 ? JSON.parse(readFileSync(jp, "utf8")).shop.sizes : undefined;
  ok(z && z.platen.id === "youth" && z.film.id === "custom" && z.film.w === 12 && z.film.h === 18 && z.screen.id === "20x24" && z2 && z2.platen.id === "custom" && z2.platen.w === 16 && z2.film.w === 12 && r3.status === 0 && z3 == null,
    `--profile sets the profile's sizes (youth platen, 12 x 18 film); --platen after it wins; a profile without sizes leaves them (${JSON.stringify(z)})`); }
{ const r = sep("check", clean, "--profile", profs); ok(r.status === 64 && /name one: Auto press, Manual/.test(r.stderr), "--profile on a file of two profiles asks for a name and lists them"); }
{ const r = sep("garments", "--json"), j = JSON.parse(r.stdout); ok(r.status === 0 && j.some(g => g.name === "navy" && g.hex === "#1C2A4A"), `sep garments lists the garment colours (${j.length})`); }
// convert: several -o outputs by extension, the job file reopens to the same separation, --spec reuses the inks
{ const d = join(TMP, "outs"), outs = ["a.zip", "films.pdf", "proof.png", "../job.json", "separation.json", "p.psd", "dir/"].map(f => join(d, f)); spawnSync("mkdir", ["-p", d]);
  const r = sep("convert", clean, ...FAST, ...outs.flatMap(o => ["-o", o]), "--json"), j = r.status === 0 ? JSON.parse(r.stdout) : null;
  ok(j && j.outputs.length === 7 && outs.slice(0, 6).every(existsSync) && readFileSync(outs[1]).subarray(0, 5).toString() === "%PDF-" && readFileSync(outs[2]).subarray(1, 4).toString() === "PNG" && readFileSync(outs[5]).subarray(0, 4).toString() === "8BPS" && readdirSync(join(d, "dir")).length === 1,
    "convert writes one output per -o by extension: zip, films PDF, preview PNG, job file, separation.json, PSD and a folder");
  const re = sep("convert", outs[3], "-o", join(d, "again.zip"), "--json"), jr = re.status === 0 ? JSON.parse(re.stdout) : null;
  ok(jr && JSON.stringify(jr.separation.films) === JSON.stringify(j.separation.films), "sep convert job.json reopens the job to the same films");
  const inf = sep("info", outs[3]); ok(inf.status === 0 && /job file for discs\.png/.test(inf.stdout), "sep info describes a job file");
  const sp = sep("convert", boxed, ...FAST, "--spec", outs[4], "-o", join(d, "spec.zip"), "--json"), js = sp.status === 0 ? JSON.parse(sp.stdout) : null;
  ok(js && JSON.stringify(js.separation.films.map(f => f.name)) === JSON.stringify(j.separation.films.map(f => f.name)), "--spec separation.json separates other art with the same inks in the same order");
  const names = j.separation.films.map(f => f.name).join("|"), rp = sep("convert", outs[5], "--art", clean, "--spec", outs[4], "-o", join(d, "re-psd.zip"), "--json"), jp = rp.status === 0 ? JSON.parse(rp.stdout) : null;
  ok(jp && jp.separation.films.map(f => f.name).join("|") === names && existsSync(join(d, "re-psd.zip")), `sep convert job.psd --art re-proofs the separated PSD and exports it again (${rp.status ? rp.stderr.trim().slice(0, 120) : names})`);
  const tdir = join(d, "dir", readdirSync(join(d, "dir"))[0], "tiff"), rt = sep("convert", tdir, "--art", clean, "--spec", outs[4], "-o", join(d, "re-tif.zip"), "--json"), jt = rt.status === 0 ? JSON.parse(rt.stdout) : null;
  ok(jt && jt.separation.films.length === j.separation.films.length, "sep convert on a folder of TIFF films re-proofs them");
  const na = sep("convert", outs[5], "-o", join(d, "x.zip")); ok(na.status !== 0 && /load the art first/.test(na.stderr), "films without art are refused: the rating needs the art"); }
// job files: the art must sit in the job file's folder or under it, and match its recorded SHA-256
{ const jf = JSON.parse(readFileSync(join(TMP, "job.json"), "utf8")), sub = join(TMP, "sub"); spawnSync("mkdir", ["-p", sub]);
  writeFileSync(join(sub, "up.json"), JSON.stringify({ ...jf, art: { ...jf.art, path: "../discs.png" } }));
  const up = sep("convert", join(sub, "up.json"), "-o", join(TMP, "up.zip")); ok(up.status !== 0 && /outside/.test(up.stderr), "a job file whose art path climbs out of its folder (../) is refused");
  ok(sep("convert", join(sub, "up.json"), "-o", join(TMP, "up.zip"), "--allow-outside", "--quiet").status === 0, "--allow-outside opens it anyway");
  writeFileSync(join(sub, "abs.json"), JSON.stringify({ ...jf, art: { ...jf.art, path: clean } }));
  const ab = sep("convert", join(sub, "abs.json"), "-o", join(TMP, "abs.zip")); ok(ab.status !== 0 && /absolute/.test(ab.stderr), "a job file with an absolute art path is refused without --allow-outside");
  writeFileSync(join(TMP, "sha.json"), JSON.stringify({ ...jf, art: { ...jf.art, sha256: "0".repeat(64) } }));
  const sh = sep("convert", join(TMP, "sha.json"), "-o", join(TMP, "sha.zip")); ok(sh.status !== 0 && /SHA-256 differs/.test(sh.stderr) && !existsSync(join(TMP, "sha.zip")), "a job file whose art does not match its SHA-256 is refused"); }
{ const r = sep("convert", clean, "-o", join(TMP, "x.tif")); ok(r.status === 64 && /\.zip \(job ZIP\), \.pdf/.test(r.stderr), "an -o with an unknown extension is refused with the outputs"); }

// MCP tools, in process: every new tool, its refusals and the undo list
{ const s = new Server({ root: TMP }), call = async (n, a = {}) => s.call(n, a), val = r => r.structuredContent ?? JSON.parse(r.content.find(c => c.type === "text").text), err = r => r.isError ? r.content[0].text : "";
  const SET = { garment: "white", widthIn: 1, dpi: 150, screens: 3 };
  ok(/outside/.test(err(await call("load_art", { path: "/etc/hostname" }))) && /outside/.test(err(await call("save_job", { path: "../escape.json" }))), "file tools refuse paths outside the root");
  const sa = val(await call("separate_art", { path: boxed, remove_background: true, ...SET })); ok(sa.art.background_removed && sa.art.background_removed.background === "#c81414" && sa.separation.screens === 3, "separate_art loads, knocks out the solid background and separates in one call");
  const gj = val(await call("get_job")); ok(gj.separation.films.length === 3 && gj.settings.widthIn === 1 && Array.isArray(gj.checks) && gj.separation.rating.stars >= 1, "get_job gives the art, changed settings, screens, rating and checks");
  const gs = val(await call("get_separation")); ok(gs.screens.length === 3 && gs.print.dpi === 150, "get_separation gives separation.json for the job as it stands");
  const pv = await call("preview_print", { view: "compare", width_px: 200 }), pm = JSON.parse(pv.content[1].text); ok(pm.width === 200 && pm.height === 100 && pm.view === "compare", "preview_print view compare puts art and print side by side at width_px");
  ok(!(await call("preview_print", { view: "differences" })).isError && /Views: print, art, compare, differences|Valid: print, art, compare, differences/.test(err(await call("preview_print", { view: "xray" }))), "preview_print draws differences and refuses an unknown view with the views");
  const ws = err(await call("preview_film", { screen: "nope" })); ok(/Screens: 1 .* \(01-.*\), 2 /.test(ws), "a wrong screen name lists the screens with print order and file slug");
  const f2 = gj.separation.films[1]; ok(!(await call("preview_film", { screen: f2.file })).isError && !(await call("preview_film", { screen: f2.name })).isError, "a screen is named by print order, ink name or file slug");
  const sr = await call("show_region", { screen: 1 }), sm = JSON.parse(sr.content[1].text); ok(sr.content[0].type === "image" && sm.box && sm.box.w > 0 && sm.inches.w > 0, "show_region gives a screen's box in fractions and inches with a picture");
  ok(/Checks now:/.test(err(await call("show_region", { check: "heavy-ink" }))), "show_region on a check this job does not have lists the checks it has");
  const third = val(await call("get_job")).separation.films[2].name, mv = val(await call("move_screen", { screen: 3, to: 1 })); ok(mv.films[0].name === third, `move_screen moves a screen in the print order (${mv.films.map(f => f.name).join(", ")})`);
  ok(/Shelf inks: White, /.test(err(await call("set_screen", { screen: 2, ink: "Plaid" }))), "set_screen with an unknown ink lists the shelf inks");
  const ss = val(await call("set_screen", { screen: 2, hex: "#00aa00", terse: true })); ok(ss.ok && /Custom #00AA00/.test(ss.changed), "set_screen hex sets a mixed ink on a screen (terse)");
  ok(val(await call("get_job")).separation.films.find(f => f.name === "Custom #00AA00").locked === true, "an ink set by hand is locked");
  const lk = val(await call("set_screen", { screen: "Custom #00AA00", lock: false })); ok(!lk.films.some(f => f.locked), "set_screen lock: false unlocks without separating again");
  ok(/to must be a print order from 1 to 3/.test(err(await call("move_screen", { screen: 1, to: 9 }))), "move_screen out of range gives the valid print orders");
  const ad = val(await call("add_screen", { ink: "Black", keep_others: true, terse: true })); ok(ad.added[0] === "Black" && ad.screens === 4, "add_screen adds a locked shelf ink as a screen");
  ok(/underbase is not an ink screen|no screen/.test(err(await call("remove_screen", { screen: "Underbase" }))), "remove_screen refuses the underbase and says how it is set");
  const rm = val(await call("remove_screen", { screen: "black" })); ok(rm.screens === 3 && !rm.films.some(f => f.name === "Black"), "remove_screen removes a screen and separates again");
  const before = val(await call("get_job")).separation, rd = val(await call("reduce_screens", { screens: 2, dry_run: true }));
  ok(rd.before.colour_screens === 3 && rd.after.colour_screens === 2 && val(await call("get_job")).separation.screens === before.screens, "reduce_screens dry_run reports before and after and leaves the job as it was");
  ok(/from 1 to 2/.test(err(await call("reduce_screens", { screens: 5 }))), "reduce_screens to more screens is refused with the range");
  const os = val(await call("order_screens", { dry_run: true })); ok(Array.isArray(os.start_order) && os.applied === false, "order_screens dry_run reports the orders tried without changing the job");
  ok(/spot separations/.test(err(await call("clean_screens", {}))), "clean_screens on a halftone job says it works on spot plates and what to use");
  const u0 = val(await call("list_jobs")).jobs[0].undo_steps, ud = val(await call("undo")); ok(ud.undone === "order_screens" && val(await call("list_jobs")).jobs[0].undo_steps === u0 - 1, "undo takes back the last call that changed the job");
  ok(val(await call("set_print_size", { height_in: 2 })).width_in === 2 && /not both/.test(err(await call("set_print_size", { width_in: 1, height_in: 1 }))), "set_print_size sets the width from a height and refuses both");
  await call("set_print_size", { width_in: 1 }); await call("separate");
  const jf = join(TMP, "mcp-job.json"), sv = val(await call("save_job", { path: jf })); ok(sv.inks === 3 && existsSync(jf), "save_job writes the job file");
  ok(/overwrite: true/.test(err(await call("save_job", { path: jf }))), "save_job will not write over a file without overwrite");
  const keep = val(await call("get_job")).separation.films; await call("new_job", { name: "Second" });
  const op = val(await call("open_file", { path: jf })); ok(JSON.stringify(op.separation.films) === JSON.stringify(keep), "open_file reopens a saved job to the same films");
  ok(val(await call("list_jobs")).jobs.length === 2 && /Jobs: 1 boxed\.png, 2 Second/.test(err(await call("switch_job", { job: "Third" }))), "list_jobs lists both jobs; a wrong job name lists them");
  ok(val(await call("switch_job", { job: 1 })).name === "boxed.png", "switch_job makes another job current");
  const rip = join(TMP, "rip"), r1 = val(await call("send_to_rip", { folder: rip })); ok(r1.files.filter(f => f.endsWith(".tif")).length === 3 && r1.files.includes("separation.json") && !r1.files.includes("films.pdf"), "send_to_rip writes one TIFF per screen and separation.json into the hot folder");
  ok(/overwrite: true/.test(err(await call("send_to_rip", { folder: rip }))) && !(await call("send_to_rip", { folder: rip, overwrite: true })).isError, "send_to_rip refuses to write over films unless overwrite");
  const ez = val(await call("export_job", { path: join(TMP, "nopsd.zip"), formats: { psd: false } })); ok(!ez.files.some(f => f.endsWith(".psd")), "export_job takes formats");
  ok(val(await call("list_garments")).garments.some(g => g.name === "black") && val(await call("list_profiles")).check_limits.min_ppi.default === 200, "list_garments and list_profiles list garments, sizes and check limits");
  const up = val(await call("use_profile", { path: profs, name: "auto press" })); ok(up.profile === "Auto press" && up.settings.lpi === 55 && /Youth/.test(up.sizes.platen) && val(await call("get_job")).shop.profile === "Auto press" && /Youth/.test(val(await call("get_job")).shop.sizes.platen), "use_profile applies a shop profile from its file, with its sizes");
  await call("set_options", { lpi: 45, press: "manual" }); await call("separate");
  const lim = val(await call("set_options", { limits: { min_ppi: 300 }, sizes: { platen: "youth" } })); ok(lim.limits.minPpi === 300 && /Youth/.test(lim.sizes.platen), "set_options takes the shop's check limits and sizes");
  await call("separate"); ok(val(await call("check_job")).checks.some(c => c.id === "low-resolution"), "a raised min_ppi limit makes the check fire");
  // batch: non-atomic keeps the steps before the failure; a label is kept in the undo list; more than 64 steps are refused
  const na = await call("batch", { steps: [{ tool: "set_options", arguments: { lpi: 50 } }, { tool: "set_options", arguments: { lpi: 999 } }], atomic: false });
  ok(na.isError && /Steps 0 to 0 were kept/.test(err(na)) && val(await call("set_options", {})).lpi === 50, "batch atomic: false stops at the failing step and keeps the ones before it");
  const lb = val(await call("batch", { steps: [{ tool: "set_options", arguments: { lpi: 45 } }, { tool: "separate" }], label: "back to 45" })); ok(lb.label === "back to 45" && val(await call("undo")).undone === "back to 45", "a batch is one undo step, under its label");
  ok(/at most 64/.test(err(await call("batch", { steps: Array.from({ length: 65 }, () => ({ tool: "get_job" })) }))), "a batch of more than 64 steps is refused");
  // spot: clean_screens and vectorize_screen
  await call("set_options", { method: "spot" }); await call("separate");
  const cl = val(await call("clean_screens", { min_speck_px: 40, dry_run: true })); ok(typeof cl.changed_px === "number" && cl.applied === false, `clean_screens dry_run counts the pixels it would change (${cl.changed_px})`);
  const vz = val(await call("vectorize_screen", { screen: 1 })); ok(/^<\?xml/.test(vz.svg) && vz.paths > 0, `vectorize_screen traces a spot screen to SVG (${vz.paths} paths)`);
  // production settings: rename, double hit, mirrored films
  await call("set_options", { method: "sim", garment: "black" }); await call("separate");
  const rn = val(await call("set_screen", { screen: 2, name: "Big red" })); ok(rn.films[1].name === "Big red" && rn.films[1].ink, "set_screen name puts the shop's name on the screen and keeps the ink's");
  const dh = val(await call("double_hit_screen", { screen: 1, hits: 2, flash_between: true })); ok(dh.films[0].hits === 2 && dh.films[0].flash_between === true, "double_hit_screen prints a screen twice with a flash between (the underbase here)");
  ok(/flash_between needs hits: 2/.test(err(await call("double_hit_screen", { screen: 1, hits: 1, flash_between: true }))), "a flash between one hit is refused");
  ok(/mirrored/.test(val(await call("set_print_size", { mirror_films: true })).films), "set_print_size mirror_films mirrors the films");
  await call("separate"); const mz = join(TMP, "mirror.zip"); await call("export_job", { path: mz }); const ms = await specOf(mz);
  ok(ms.print.mirror === true && ms.screens.some(sc => sc.name === "Big red") && ms.screens[0].hits === 2, "the export records mirror, the screen's name and the double hit");
  // A screen's own mesh, LPI and angle, and hidden; bad values are refused with the valid ones
  { const png = r => r.content.find(c => c.type === "image").data, film0 = png(await call("preview_film", { screen: 2, region: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 } }));
    ok(/`mesh` 231 is not valid\. Valid: 86, 110/.test(err(await call("set_screen", { screen: 2, mesh: 231 }))) && /`lpi` 200 is out of range\. Valid: 20 to 85/.test(err(await call("set_screen", { screen: 2, lpi: 200 })))
      && /`angle` 95 is out of range\. Valid: 0 to 90/.test(err(await call("set_screen", { screen: 2, angle: 95 }))) && /`angle` must be number or null/.test(err(await call("set_screen", { screen: 2, angle: "steep" }))),
      "set_screen refuses a mesh that is not stock, an LPI or angle out of range, with the valid values");
    const o = val(await call("set_screen", { screen: 2, mesh: 230, lpi: 60, angle: 37.5 })), f = o.films[1], others = o.films.filter((_, i) => i !== 1);
    const film1 = png(await call("preview_film", { screen: 2, region: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 } }));
    ok(f.mesh === 230 && f.lpi === 60 && f.angle === 37.5 && JSON.stringify(f.screen_settings) === JSON.stringify({ mesh: 230, lpi: 60, angle: 37.5 }) && others.every(x => !x.screen_settings && x.angle === ms.print.angle) && film1 !== film0,
      `set_screen mesh, lpi and angle set one screen's own (${f.mesh} mesh, ${f.lpi} LPI, ${f.angle} deg), and its film changes`);
    const oz = join(TMP, "own.zip"); await call("export_job", { path: oz }); const os = await specOf(oz), sc = os.screens[1], zz = await new globalThis.JSZip().loadAsync(readFileSync(oz));
    const pdf = zz.file("films.pdf") ? Buffer.from(await zz.file("films.pdf").async("uint8array")).toString("latin1") : "";
    ok(sc.mesh === 230 && sc.lpi === 60 && sc.angle === 37.5 && sc.screen_settings.lpi === 60 && os.screens[0].angle === ms.print.angle && !!pdf,
      "the export's separation.json carries the screen's own mesh, LPI and angle (and the others keep the job's)");
    const back = J.settingsFromSpec(os), ink = back.inks.find(i => i.name === (sc.ink || sc.name));
    ok(ink && ink.mesh === 230 && ink.lpi === 60 && ink.angle === 37.5, "sep --spec reads the screen's own mesh, LPI and angle back from separation.json");
    const ojf = join(TMP, "own-job.json"); await call("save_job", { path: ojf }); const reo = val(await call("open_file", { path: ojf }));
    ok(reo.separation.films[1].mesh === 230 && reo.separation.films[1].lpi === 60 && reo.separation.films[1].angle === 37.5, "a saved job file reopens with the screen's own settings");
    const printA = png(await call("preview_print", {})), hd = val(await call("set_screen", { screen: 2, hidden: true })), print1 = png(await call("preview_print", {}));
    ok(hd.films[1].hidden === true && hd.films.filter(x => x.hidden).length === 1 && print1 !== printA, "set_screen hidden leaves the screen out of preview_print (the films are still made)");
    const sh = val(await call("set_screen", { screen: 2, hidden: false, lpi: null, angle: null, mesh: null })), print2 = png(await call("preview_print", {}));
    ok(!sh.films[1].hidden && !sh.films[1].screen_settings && sh.films[1].angle === ms.print.angle && sh.films[1].mesh === ms.screens[1].mesh && print2 === printA, "hidden: false shows it again; null gives the job's mesh, LPI and angle back"); }
  const psdOut = join(TMP, "outs", "p.psd"), sp2 = join(TMP, "outs", "separation.json"); await call("load_art", { path: clean });
  const of = val(await call("open_file", { path: psdOut, separation: sp2 })); ok(of.imported === "p.psd" && of.colour_screens >= 1, `open_file re-proofs a separated PSD (${of.colour_screens} colour screens)`);
  // a folder of films: a symlink to a file outside the root is skipped, never read
  { const tdirs = join(TMP, "outs", "dir"), tif = join(tdirs, readdirSync(tdirs)[0], "tiff"), outside = mkdtempSync(join(tmpdir(), "sep-out-")), lnk = join(TMP, "linked");
    const first = readdirSync(tif).find(n => /\.tif$/.test(n)); writeFileSync(join(outside, first), readFileSync(join(tif, first)));
    spawnSync("mkdir", ["-p", lnk]); symlinkSync(join(outside, first), join(lnk, first));
    const e = err(await call("open_file", { path: lnk })); rmSync(outside, { recursive: true });
    ok(/give a Photoshop file/.test(e), `open_file on a folder skips a symlinked film that points outside the root (${e.slice(0, 60)})`); }
  ok(/imported films/.test(err(await call("remove_screen", { screen: 1 }))), "screen edits on imported films are refused with how to make new screens");
  await call("new_job"); ok(/nothing to undo/.test(err(await call("undo"))), "undo on a new job says there is nothing to undo"); }

// MCP over Streamable HTTP on 127.0.0.1 (a port in 8470-8479, this process's own listener)
{ let handler = null; const http = createServer((q, r) => handler(q, r)); let port = 0;
  for (let p = 8470; p <= 8479 && !port; p++) port = await new Promise(res => { http.once("error", () => res(0)); http.listen(p, "127.0.0.1", () => res(p)); });
  ok(port > 0, `the HTTP server listens on 127.0.0.1:${port}`);
  const token = "t".repeat(40); handler = httpHandler(new Server({ root: TMP }), { token, port });
  const post = (body, headers = {}) => fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify(body) });
  ok((await post({ jsonrpc: "2.0", id: 9, method: "ping" }, { authorization: "" })).status === 401 && (await post({ jsonrpc: "2.0", id: 9, method: "ping" }, { authorization: "Bearer wrong" })).status === 401, "a request with no token or a wrong token is 401");
  const badHost = await new Promise(res => { const q = request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { host: `evil.example:${port}`, authorization: `Bearer ${token}`, "content-type": "application/json" } }, r => { r.resume(); res(r.statusCode); }); q.end("{}"); });
  ok(badHost === 403, "a request with another Host (DNS rebinding) is 403");
  const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "http-test", version: "1" } } }), ij = await init.json();
  ok(init.status === 200 && ij.result.serverInfo.name === "separation-table", "POST /mcp answers initialize");
  const tl = await (await post({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json(); ok(tl.result.tools.length === toolList().length, "tools/list over HTTP lists every tool");
  ok((await post({ jsonrpc: "2.0", id: 3, method: "ping" }, { origin: "https://evil.example" })).status === 403, "a request from another origin is refused (403)");
  ok((await post({ jsonrpc: "2.0", method: "notifications/initialized" })).status === 202 && (await fetch(`http://127.0.0.1:${port}/mcp`, { headers: { authorization: `Bearer ${token}` } })).status === 405, "a notification is 202 and GET is 405");
  await new Promise(r => http.close(r)); }

// MCP: tool list design rules
{ const tools = toolList(), names = tools.map(t => t.name);
  ok(["load_art", "separate", "check_job", "preview_film", "preview_print", "set_options", "list_inks", "list_profiles", "export_job", "explain_check", "batch"].every(n => names.includes(n)), `MCP lists the required tools (${names.length})`);
  ok(tools.every(t => typeof t.annotations.readOnlyHint === "boolean" && typeof t.annotations.destructiveHint === "boolean"), "every tool has readOnlyHint and destructiveHint");
  ok(names.every(n => /^(load|open|separate|check|preview|set|use|get|show|add|remove|move|order|reduce|clean|double|vectorize|list|switch|new|undo|save|export|send|explain|batch)(_[a-z]+)*$/.test(n)), "tool names start with a verb (verb_noun, or the verb alone)");
  ok(tools.length >= 32, `the server has at least ZigZag's 32 tools (${tools.length})`);
  ok(tools.every(t => typeof t._meta["separation-table/batchSafe"] === "boolean") && ["export_job", "save_job", "send_to_rip", "load_art", "undo", "new_job"].every(n => tools.find(t => t.name === n)._meta["separation-table/batchSafe"] === false), "every tool carries a batch-safe flag; files, art, jobs and undo are not batch-safe");
  ok(tools.filter(t => !t.annotations.readOnlyHint && t.name !== "batch").every(t => t.inputSchema.properties.terse), "every tool that changes the job takes terse");
  ok(["export_job", "save_job", "send_to_rip"].every(n => { const t = tools.find(x => x.name === n); return t.inputSchema.properties.overwrite && t.annotations.destructiveHint; }), "every tool that writes a file takes overwrite and is marked destructive");
  let wt = ""; try { checkArgs("set_options", { lpi: "45" }); } catch (e) { wt = e.message; } ok(/must be number, not string/.test(wt), "a wrong-type argument is refused, not defaulted");
  let msg = ""; try { checkArgs("set_options", { lpl: 45 }); } catch (e) { msg = e.message; } ok(/doesn't take|does not take `lpl`/.test(msg) && /`lpi`/.test(msg), "an unknown argument is refused with the valid ones");
  ok(resolveRefs({ a: "$0.films.1.name", b: "$$0", c: ["$1.x"] }, [{ films: [{}, { name: "Royal" }] }, { x: 3 }]).a === "Royal" && resolveRefs("$$0", []) === "$0" && resolveRefs(["$1.x"], [0, { x: 3 }])[0] === 3, "$N.path references resolve; $$ is a literal $"); }

// MCP round trip over stdio with a scripted client
{ const log = join(TMP, "calls.jsonl"), child = spawn(process.execPath, ["--no-warnings", SEP, "mcp", "--log", log, "--root", TMP], { stdio: ["pipe", "pipe", "inherit"] });
  let buf = "", id = 0; const waiting = new Map();
  child.stdout.on("data", d => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); const m = JSON.parse(line); waiting.get(m.id)?.(m); waiting.delete(m.id); } });
  const rpc = (method, params) => new Promise(res => { const n = ++id; waiting.set(n, res); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n"); });
  const call = async (name, args) => (await rpc("tools/call", { name, arguments: args })).result;
  const val = r => r.structuredContent ?? JSON.parse(r.content.find(c => c.type === "text").text);
  const init = (await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "sep-test", version: "1" } })).result;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  ok(init.protocolVersion === "2025-06-18" && /stack limit is 240-280%/.test(init.instructions) && /9 screens/.test(init.instructions) && /230 \+ 5 x \(LPI - 45\)/.test(init.instructions), "initialize: protocol 2025-06-18; instructions give the flow and the stack, screen and mesh rules");
  ok((await rpc("tools/list", {})).result.tools.length >= 11, "tools/list answers");
  ok((await call("separate", {})).isError, "separate before load_art is an error the agent can read");
  const loaded = await call("load_art", { path: clean }); ok(!loaded.isError && val(loaded).width_px === 240, "load_art reads the PNG");
  const bad = await call("set_options", { lpl: 50 }); ok(bad.isError && /`lpi`/.test(bad.content[0].text), "set_options refuses an unknown argument and lists the valid ones");
  const badV = await call("set_options", { dot: "star" }); ok(badV.isError && /round, ellipse, square, line/.test(badV.content[0].text), "set_options refuses a bad value with the valid values");
  await call("set_options", { garment: "white", widthIn: 1, dpi: 150, screens: 2 });
  const sepd = val(await call("separate", { terse: true })); ok(sepd.ok === true && sepd.screens >= 2 && Array.isArray(sepd.new_problems), `separate terse: ok, ${sepd.screens} screens, new_problems [${sepd.new_problems}]`);
  const checks = val(await call("check_job", {})); ok(Array.isArray(checks.checks), "check_job returns the checks");
  const ex = val(await call("explain_check", { id: "heavy-ink" })); ok(/240-280%/.test(ex.why) && /set_options/.test(ex.fix), "explain_check says why and which setting fixes it");
  const pp = await call("preview_print", {}), img = pp.content.find(c => c.type === "image"); ok(img && img.mimeType === "image/png" && Buffer.from(img.data, "base64").subarray(1, 4).toString() === "PNG", "preview_print returns a PNG image");
  const pf = await call("preview_film", { screen: 1, region: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 } }), fimg = pf.content.find(c => c.type === "image"); ok(fimg && Buffer.from(fimg.data, "base64").subarray(1, 4).toString() === "PNG", "preview_film returns a PNG of a film region");
  const before = val(await call("list_profiles", {})); ok(before.stock_mesh.includes(230), "list_profiles lists stock mesh and settings");
  const b1 = val(await call("batch", { steps: [{ tool: "set_options", arguments: { lpi: 55 } }, { tool: "separate" }, { tool: "preview_film", arguments: { screen: "$1.films.0.order" } }] }));
  ok(b1.ok && b1.results.length === 3, "batch runs steps in order and $1.films.0.order feeds a later step");
  const b2 = await call("batch", { steps: [{ tool: "set_options", arguments: { lpi: 60 } }, { tool: "set_options", arguments: { lpi: 999 } }] });
  const after = val(await call("set_options", {})); ok(b2.isError && /undone/.test(b2.content[0].text) && after.lpi === 55, "a failing batch changes nothing (lpi stays 55)");
  const b3 = await call("batch", { steps: [{ tool: "export_job", arguments: { path: join(TMP, "x.zip") } }] }); ok(b3.isError && /cannot run in a batch/.test(b3.content[0].text), "export_job is refused inside a batch");
  await call("separate", {}); const out = join(TMP, "mcp.zip"), e1 = await call("export_job", { path: out }); ok(!e1.isError && existsSync(out) && val(e1).files.includes("separation.json"), "export_job writes the job ZIP");
  const e2 = await call("export_job", { path: out }); ok(e2.isError && /overwrite: true/.test(e2.content[0].text), "export_job will not write over a file without overwrite");
  const unknown = await rpc("no/such", {}); ok(unknown.error && unknown.error.code === -32601, "an unknown method is JSON-RPC -32601");
  child.stdin.end(); await new Promise(r => child.on("close", r));
  const lines = readFileSync(log, "utf8").trim().split("\n").map(l => JSON.parse(l));
  ok(lines.length >= 15 && lines.every(l => l.tool && l.time && typeof l.ms === "number" && typeof l.ok === "boolean") && lines[0].client === "sep-test" && lines.some(l => !l.ok && /lpl/.test(l.error)), `the opt-in log has one JSON line per call (${lines.length}), with client, ms, ok and the error`); }

rmSync(TMP, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : "all passed"); process.exit(fails ? 1 : 0);
