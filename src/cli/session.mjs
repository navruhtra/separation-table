// One job in Node: art, settings, the separation, its checks, previews and the job ZIP. The sep CLI and the MCP
// server both drive this, and it drives the shared engine the page uses (job.js, pipeline.js, checks.js) the way the
// page does: separate the preview copy (900 px) to choose the inks, then the working copy (up to 2400 px) with those
// inks for the films. Screen edits (an ink set by hand, a screen removed, moved or added) separate again with the
// inks as they are, as the page's run(false) does.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, unlinkSync, statSync, realpathSync, readdirSync, lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, basename, dirname, resolve, relative, isAbsolute } from "node:path";
import * as J from "../job.js";
import { runSeparation, evaluate, autoPick, pickOrder, ORDER_GAIN } from "../pipeline.js";
import { checkPlan, printRating, plateSlug, specFor, cleanScreenSet } from "../plan.js";
import { preflightChecks, regionMask, maskBox, knockOutBackground } from "../checks.js";
import { genericLibrary } from "../inks.js";
import { lab2rgb, rgb2lab, hex2rgb, de2000, indexToCov } from "../engine.js";
import { cleanSpotSync } from "../cvtools.js";
import { cleanSizes, SIZE_KINDS } from "../sizes.js";
import * as F from "../filmimport.js";
import { mirrorX } from "../output.js";
import { ROOT, loadVendor, readArt, downsample, nodePlatform, encodePNG } from "./platform.mjs";

const reproof = m => evaluate(m, m.inks, m.cov);
/** Settings whose change makes the engine pick the inks again (the page's run(true)); any other change separates with
 *  the inks as they are (run(false)), as the page does. */
const REPICK = new Set(["screens", "inkSource", "forceWhite", "rare", "garment", "method"]);
/** Write a file whole or not at all: a temporary file beside it, then a rename over the old one. */
export function writeAtomic(path, data) {
  mkdirSync(dirname(path), { recursive: true }); const tmp = `${path}.${process.pid}.part`;
  try { writeFileSync(tmp, data); renameSync(tmp, path); } catch (e) { try { unlinkSync(tmp); } catch { /* nothing to clean */ } throw e; }
}
/** Largest art file read (bytes). */
export const ART_MAX_BYTES = 200 * 1024 * 1024;
/** A path's real location: symlinks resolved, for a file that does not exist yet through its nearest existing folder. */
function realOf(p) { const abs = resolve(p); if (existsSync(abs)) return realpathSync(abs); const up = dirname(abs); return up === abs ? abs : join(realOf(up), basename(abs)); }
/** p (relative to base, or absolute) when it lies inside base, symlinks resolved; otherwise an Error naming the rule. */
export function within(base, p, what = "path") {
  const root = realOf(base), real = realOf(resolve(base, String(p))), rel = relative(root, real);
  if (rel === ".." || rel.startsWith(".." + "/") || rel.startsWith("..\\") || isAbsolute(rel)) throw new Error(`${what} ${p} is outside ${root}; only files under it are read or written`);
  return real;
}
const sha256 = buf => createHash("sha256").update(buf).digest("hex");
const rgbHex = rgb => "#" + rgb.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("").toUpperCase();
/** The print model's PNG views (preview_print view). */
export const VIEWS = ["print", "art", "compare", "differences"];

export class Session {
  constructor() {
    /** @type {Record<string, any>} */ this.s = J.defaults();
    /** Settings the caller set: Auto does not change these. */ this.fixed = new Set();
    this.ctx = { library: genericLibrary(), calib: null, targets: [], salience: 1, sizes: null, limits: null, mesh: null, profile: null };
    this.art = null; this.prev = null; this.file = null; this.res = null; this.inks = null; this.auto = null; this.autoK = 0;
    /** Inks to separate with as they are (a screen edit, a reopened job): no new pick, no Auto. */ this.keep = null;
    /** Locked inks a new pick keeps (the page's lock). */ this.locked = [];
    /** Spot cleanup: smallest speck kept, preview pixels (clean_screens); null = the engine's. */ this.speck = null;
    this.workCache = null;
    /** Imported films (importFilms), or null. */ this.imp = null;
    /** What was done to the art after it was read ("remove-background"), so a job file can do it again. */ this.artEdits = [];
  }
  /** Apply settings ({ key: value }, values checked against job.SETTINGS); a change drops the separation. */
  set(opts) {
    const next = { ...this.s, formats: { ...this.s.formats } };
    for (const [k, v] of Object.entries(opts)) {
      if (k === "formats") { for (const [f, on] of Object.entries(v)) { if (!(f in J.FORMATS)) throw new Error(`unknown format "${f}". Formats: ${Object.keys(J.FORMATS).join(", ")}`); next.formats[f] = !!on; } continue; }
      next[k] = J.parseSetting(k, v);
    }
    for (const k of Object.keys(opts)) if (k !== "formats") this.fixed.add(k);
    // a fabric sets its own settings (fleece: the choke) unless the caller set them
    for (const [k, v] of Object.entries(J.fabricSettings(next.fabric))) if (!this.fixed.has(k)) next[k] = v;
    const repick = Object.keys(opts).some(k => REPICK.has(k)) || next.screens === "auto", inks = this.keep || this.inks; if (repick) this.dropImport();
    this.locked = (inks || []).filter(i => i.locked);
    this.s = next; this.drop(); if (!repick && inks && this.art) this.keep = inks; return this.s;
  }
  drop() { this.res = null; this.keep = null; this.auto = null; this.autoK = 0; this.workCache = null; }
  /** Imported films (importFilms) make the screens until new screens are asked for: a setting that picks the inks
   *  again, or new art. */
  dropImport() { this.imp = null; }
  /** The shop's platen, film and screen (sizes.cleanSizes input: { platen: { id } | { id: "custom", w, h }, … }). */
  setSizes(sizes) { this.ctx = { ...this.ctx, sizes: sizes ? cleanSizes({ ...(this.ctx.sizes || {}), ...sizes }) : null }; return this.ctx.sizes; }
  setLimits(limits) { this.ctx = { ...this.ctx, limits }; return limits; }
  /** A shop profile (job.profileSettings): its settings over the job's, its mesh, calibration and sizes (if it keeps them) in the context. */
  useProfile(p) {
    const ps = J.profileSettings(p); this.set(ps.settings);
    this.ctx = { ...this.ctx, mesh: ps.mesh, calib: ps.calib, profile: ps.name, ...(ps.sizes && { sizes: ps.sizes }) }; return ps;
  }
  /** separation.json's settings and colour inks (job.settingsFromSpec): separate with those inks, in that order. */
  applySpec(spec) {
    const r = J.settingsFromSpec(spec); this.set({ ...r.settings, underbase: r.underbase ? "on" : "off" }); this.keep = r.inks; this.locked = r.inks;
    if (r.ubSet) this.ctx = { ...this.ctx, ub: { ...(this.ctx.ub || {}), ...r.ubSet } };
    return { settings: r.settings, inks: r.inks.map(i => i.name) };
  }
  async load(path) {
    let st; try { st = statSync(path); } catch { throw new Error(`${path}: no such file`); }
    if (!st.isFile()) throw new Error(`${path}: not a file`); if (st.size > ART_MAX_BYTES) throw new Error(`${path}: ${(st.size / 1e6).toFixed(0)} MB is over the ${ART_MAX_BYTES / 1024 / 1024} MB art limit`);
    const buf = readFileSync(path), a = await readArt(path);
    this.setArt(a, { name: basename(path), path: resolve(path), sha256: sha256(buf) }); return this.artInfo();
  }
  setArt(a, f) {
    const s = Math.min(1, J.WORK_MAX / Math.max(a.W, a.H));
    this.file = { ...f, W: a.W, H: a.H, info: a.info + (s < 1 ? ` Work size ${Math.round(a.W * s)} × ${Math.round(a.H * s)} px.` : "") };
    const work = s < 1 ? downsample(a, J.WORK_MAX) : downsample(a, Infinity);
    this.art = work; this.prev = work.W > J.PREV_MAX || work.H > J.PREV_MAX ? downsample(work, J.PREV_MAX) : work; this.inks = null; this.locked = []; this.artEdits = []; this.imp = null; this.drop();
  }
  /** Knock out a solid background (checks.solidBackground) that touches the edge: those pixels become transparent. */
  removeBackground() {
    this.need(); const bg = J.checkJob(this.s, this.ctx, this.art, null, []).art.background;
    if (!bg) return { removed_pct: 0, background: null };
    const full = { rgba: this.art.rgba, W: this.art.W, H: this.art.H }, out = knockOutBackground(full.rgba, full.W, full.H, bg);
    let n = 0; for (let q = 0; q < full.W * full.H; q++) if (full.rgba[q * 4 + 3] && !out[q * 4 + 3]) n++;
    const edits = [...this.artEdits, "remove-background"];
    this.setArt({ rgba: out, W: full.W, H: full.H, info: this.file.info.replace(/ Work size.*$/, "") + ` Solid ${bg} background removed.` }, { name: this.file.name, path: this.file.path, sha256: this.file.sha256 }); this.artEdits = edits;
    return { removed_pct: +(n / (full.W * full.H) * 100).toFixed(1), background: bg };
  }
  artInfo() {
    const f = this.file, w = +this.s.widthIn, ppi = Math.round(this.art.W / w), bg = J.checkJob(this.s, this.ctx, this.art, null, []).art.background;
    let clear = 0; for (let q = 0; q < this.art.alpha.length; q++) if (this.art.alpha[q] < 128) clear++;
    return { file: f.name, width_px: f.W, height_px: f.H, work_px: [this.art.W, this.art.H], preview_px: [this.prev.W, this.prev.H], ppi_at_width: ppi, width_in: w, height_in: +(w * this.art.H / this.art.W).toFixed(2), transparent_pct: +(clear / this.art.alpha.length * 100).toFixed(1), solid_background: bg, info: f.info };
  }
  need(what = "art") { if (!this.art) throw new Error("no art loaded: call load_art (CLI: give an art file) first"); if (what === "res" && !this.res) throw new Error("no separation yet: call separate first"); }
  /** Auto (screens = auto): the engine's autoPick on the preview, then its settings, as the page's Auto. Settings the
   *  caller fixed stay. Then the preview separation, which chooses the inks. With kept inks (a screen edit or a
   *  reopened job) the inks are used as they are and Auto does not run. */
  async separate() {
    this.need(); if (this.imp) return this.reproofImport();
    const s = this.s; let inks = [], repick = true;
    if (this.keep) { inks = this.keep; repick = false; }
    else if (s.screens === "auto") {
      const apply = c => { for (const [k, v] of Object.entries(c)) if (!this.fixed.has(k)) s[k] = v; };
      if (J.methodKey(s)) { apply(J.autoChoices(s, null, this.ctx.calib, this.ctx.mesh && this.ctx.mesh.color)); this.auto = { method: s.method, why: "this method sets its own inks and screens" }; }
      else {
        const m = J.sepModel({ ...s, screens: 6 }, this.prev, this.ctx), r = autoPick({ ...m, ...(this.fixed.has("method") && { autoMethod: J.engineMode(s) }) }), b = r.best;
        if (!this.fixed.has("method")) s.method = b.mode; this.ctx.salience = b.salience ?? 1; apply(J.autoChoices(s, b, this.ctx.calib, this.ctx.mesh && this.ctx.mesh.color));
        this.auto = { method: b.mode, screens: b.k, score: +b.score.toFixed(2), tried: r.rows.length }; if (b.inks) { inks = b.inks.map(i => ({ ...i, locked: false })); repick = false; }
        this.autoK = b.k;
      }
    } else inks = this.locked;
    const k = this.keep ? this.keep.length : Math.max(s.screens === "auto" ? this.autoK || 6 : s.screens, inks.length);
    const m = { ...J.sepModel({ ...s, screens: k }, this.prev, this.ctx), preview: true, repick, defer: false, mode: J.engineMode(s), inks, locked: repick ? inks : inks.filter(i => i.locked) };
    const t0 = performance.now(); let r = runSeparation({ ...J.withMethod(m), costs: true });
    r = await J.cleanSpot(s, this.ctx, r, this.prev, reproof, this.speck);
    r.ms = Math.round(performance.now() - t0); this.res = r; this.inks = r.inks; this.workCache = null; return this.summary();
  }
  plates(r = this.res) { return J.filmPlates(this.s, r.inks, !!r.ub, this.ctx); }
  rating() { const st = this.res.stats; let failed = 0; try { failed = this.checks().length; } catch { /* no checks without a separation */ }
    const R = printRating({ onPress: st.robustMean, aligned: st.mean, inTol: st.cmcWithin2, failedChecks: failed }); return { stars: R.stars, failed_checks: failed }; }
  summary() {
    const r = this.res, st = r.stats, pl = this.plates();
    return { method: this.s.method, method_name: J.methodName(this.s), garment: this.s.garment, ...(this.auto && { auto: this.auto }), screens: pl.length,
      films: pl.map(p => ({ order: p.order, name: p.name, file: plateSlug(p), hex: rgbHex(lab2rgb(p.lab)), coverage_pct: +((p.ub ? r.ubPct : r.covPct[p.idx]) * 100).toFixed(1), angle: p.angle, mesh: p.mesh, ...(p.lpi && { lpi: p.lpi }), ...(p.ub && { underbase: true }),
        ...(!p.ub && r.inks[p.idx] && r.inks[p.idx].locked && { locked: true }), ...(p.ink && { ink: p.ink }), ...(p.hits === 2 && { hits: 2, flash_between: !!p.flashBetween }),
        ...(p.set && { screen_settings: p.set }), ...((r.hidden || []).includes(this.hideKey(p)) && { hidden: true }) })),
      dropped: r.dropped || [], score: { press_de00: +st.robustMean.toFixed(2), aligned_de00: +st.mean.toFixed(2), p95_de00: +st.p95.toFixed(2), within_cmc2_pct: Math.round(st.cmcWithin2 * 100), ink_stack_p99_pct: Math.round(st.stackP99 * 100) },
      rating: this.rating(), ms: r.ms };
  }
  checkJobData() { return J.checkJob(this.s, this.ctx, this.art, this.prev, this.plates(), false); }
  checks() { this.need("res"); return preflightChecks(this.checkJobData(), this.res); }

  /* ───────────── Screens ───────────── */
  /** A screen by print order (1 = first), ink name, film name or file slug ("02-gold"); otherwise an Error that lists them. */
  screen(sel) {
    this.need("res"); const pl = this.plates(), s = String(sel ?? "").trim(), low = s.toLowerCase();
    const p = /^\d+$/.test(s) ? pl.find(x => x.order === +s) : pl.find(x => x.name.toLowerCase() === low) || pl.find(x => (x.ink || "").toLowerCase() === low) || pl.find(x => plateSlug(x) === low);
    if (!p) throw new Error(`no screen "${sel}". Screens: ${pl.map(x => `${x.order} ${x.name} (${plateSlug(x)})`).join(", ")}`);
    return p;
  }
  colorScreen(sel, what) {
    const p = this.screen(sel); if (this.imp) throw new Error(`${what}: the screens are the imported films (${this.imp.name}). Load the art again (load_art) or set_options {screens} to make new screens from the art.`); if (p.ub) throw new Error(`${what}: the underbase is not an ink screen. It is set with set_options {underbase: "on" | "off" | "auto"} and ubStrength.`);
    if (J.methodKey(this.s)) throw new Error(`${what}: the ${J.methodName(this.s)} method sets its own inks. Use set_options {method: "sim"} or "spot" to choose inks by hand.`);
    return p;
  }
  /** An ink by shelf name (the library, case not counted) or #rrggbb (a custom mixed ink), or an Error. */
  inkOf({ ink, hex }) {
    if (ink != null && hex != null) throw new Error("give ink (a shelf ink name) or hex (#rrggbb), not both");
    if (hex != null) { const h = String(hex).toLowerCase(); if (!/^#[0-9a-f]{6}$/.test(h)) throw new Error(`hex "${hex}" is not #rrggbb`); return { name: `Custom ${h.toUpperCase()}`, lab: rgb2lab(...hex2rgb(h)), source: "target" }; }
    const n = String(ink).toLowerCase(), k = this.ctx.library.find(i => i.name.toLowerCase() === n);
    if (!k) throw new Error(`no shelf ink "${ink}". Shelf inks: ${this.ctx.library.map(i => i.name).join(", ")} (or give hex: "#rrggbb")`);
    return { ...k, lab: k.lab.slice() };
  }
  /** New inks in place of the old ones (the result's copy too, so its plates read them), without touching a snapshot. */
  setInks(inks) { this.inks = inks; this.res = { ...this.res, inks }; this.workCache = null; }
  async reseparate(inks, why) { this.keep = inks; this.s = { ...this.s, screens: Math.max(1, Math.min(12, inks.length)) }; this.fixed.add("screens");
    const sum = await this.separate(); return { ...sum, changed: why }; }
  /** Change one screen's ink (a shelf ink or a hex colour; it is locked) or its lock; the shop's name and double hit
   *  (prod: label, hits, flashBetween) when the engine has them; its own mesh, LPI and angle (prod: mesh, lpi, angle;
   *  null gives the job's back); hidden leaves it out of preview_print, as the page's Print view (its film is still made). */
  async setScreen(sel, { ink, hex, lock, prod = null, hidden }) {
    const p = (ink != null || hex != null || lock != null) ? this.colorScreen(sel, "set_screen") : this.screen(sel);
    if (prod && ("lpi" in prod || "angle" in prod) && (J.engineMode(this.s) !== "sim" || this.s.screening === "fm"))
      throw new Error(`set_screen: lpi and angle are for halftone screens; this job prints ${J.engineMode(this.s) === "sim" ? "index (FM) dots" : J.engineMode(this.s)}. Mesh can be set.`);
    if (prod) { const own = { mesh: prod.mesh, lpi: prod.lpi, angle: prod.angle }; cleanScreenSet(own, `set_screen: screen ${p.order}`); }
    if (hidden != null) { const key = this.hideKey(p), h = new Set(this.res.hidden || []); if (hidden) h.add(key); else h.delete(key); this.res = { ...this.res, hidden: [...h] }; }
    let inks = this.inks.map(i => ({ ...i }));
    // a value of null takes the screen's own setting away (the job's applies again)
    const put = (o, v) => { for (const [k, x] of Object.entries(v)) if (x === null) delete o[k]; else o[k] = x; return o; };
    if (prod) { if (p.ub) this.ctx = { ...this.ctx, ub: put({ ...(this.ctx.ub || {}) }, prod) }; else put(inks[p.idx], prod); }
    if (lock != null) inks[p.idx].locked = !!lock;
    if (ink != null || hex != null) { const k = this.inkOf({ ink, hex }); inks[p.idx] = { ...k, locked: lock ?? true, chosen: true, ...(prod && prod) };
      return this.reseparate(inks, `screen ${p.order} is now ${k.name}`); }
    this.setInks(inks); return { ...this.summary(), changed: `screen ${p.order} ${p.name}: ${[lock != null && (lock ? "locked" : "unlocked"), prod && Object.keys(prod).join(", "), hidden != null && (hidden ? "hidden" : "shown")].filter(Boolean).join("; ")}` };
  }
  /** A screen's key in res.hidden: its ink's name, or the underbase's. */
  hideKey(p) { return p.ub ? "\u0000underbase" : this.res.inks[p.idx].name; }
  async removeScreen(sel) {
    const p = this.colorScreen(sel, "remove_screen"); if (this.inks.length < 2) throw new Error("remove_screen: the job has one ink screen; it needs at least one");
    const inks = this.inks.filter((_, i) => i !== p.idx); return this.reseparate(inks, `${p.name} removed`);
  }
  /** Move a colour screen to print order position `to` (the underbase always prints first). */
  async moveScreen(sel, to) {
    const p = this.colorScreen(sel, "move_screen"), first = this.res.ub ? 2 : 1, last = first + this.inks.length - 1;
    if (!Number.isInteger(+to) || +to < first || +to > last) throw new Error(`move_screen: to must be a print order from ${first} to ${last}${first === 2 ? " (the underbase prints first)" : ""}`);
    const inks = this.inks.slice(), [k] = inks.splice(p.idx, 1); inks.splice(+to - first, 0, k);
    return this.reseparate(inks, `${p.name} moved to ${to}`);
  }
  /** Add a screen in a shelf ink or a hex colour, locked. keepOthers: the other inks stay as they are (the page's
   *  "Add a … screen" note); otherwise the engine picks the rest around it (the page's Add ink). */
  async addScreen({ ink, hex, keepOthers = false }) {
    this.need("res"); if (J.methodKey(this.s)) throw new Error(`add_screen: the ${J.methodName(this.s)} method sets its own inks. Use set_options {method: "sim"} or "spot" to add inks by hand.`);
    if (this.inks.length >= 12) throw new Error("add_screen: the job has 12 ink screens, the most this tool makes");
    const k = { ...this.inkOf({ ink, hex }), locked: true, chosen: true }, hl = this.inks.findIndex(i => i.lab[0] > 92);
    if (keepOthers) { const inks = hl < 0 ? this.inks.concat([k]) : [...this.inks.slice(0, hl), k, ...this.inks.slice(hl)]; return { ...(await this.reseparate(inks, `${k.name} added`)), added: [k.name] }; }
    this.locked = this.inks.filter(i => i.locked).concat([k]); this.keep = null; this.s = { ...this.s, screens: Math.min(12, this.inks.length + 1) }; this.fixed.add("screens");
    return { ...(await this.separate()), changed: `${k.name} added; the other inks chosen around it`, added: [k.name] };
  }
  /** The print order the engine finds best for this job (pipeline.pickOrder; the page's per-job order), kept only when
   *  it beats the current order at preview size too. */
  async orderScreens({ dryRun = false } = {}) {
    this.need("res"); if (J.methodKey(this.s)) throw new Error(`order_screens: the ${J.methodName(this.s)} method prints at its own standard order`);
    const m = J.withMethod({ ...J.sepModel({ ...this.s, screens: this.inks.length }, this.prev, this.ctx), mode: J.engineMode(this.s) }), o = pickOrder(m, this.inks);
    const before = this.res.stats.robustMean, out = { start_order: this.inks.map(i => i.name), fades: o.fades, tries: o.tries, best: o.best ? { order: o.best.inks.map(i => i.name), moved: o.best.name, after: o.best.after } : null, applied: false, before_press_de00: +before.toFixed(2) };
    if (!o.best || dryRun) return { ...out, ...(dryRun && { dry_run: true }) };
    const snap = this.snapshot(), sum = await this.reseparate(o.best.inks.map(i => ({ ...i })), `${o.best.name} moved after ${o.best.after}`);
    if (sum.score.press_de00 < before * (1 - ORDER_GAIN)) return { ...out, applied: true, after_press_de00: sum.score.press_de00, separation: sum };
    const after = sum.score.press_de00; this.restore(snap); return { ...out, after_press_de00: after, note: "the better order on the small copy did not beat the current order at preview size; the order is kept" };
  }
  /** Separate at fewer colour screens and say what it costs: screens, scores and stars before and after. */
  async reduceScreens({ screens, dryRun = false }) {
    this.need("res"); const now = this.inks.length; if (!Number.isInteger(screens) || screens < 1 || screens >= now) throw new Error(`reduce_screens: screens must be a whole number from 1 to ${now - 1} (the job has ${now} colour screens)`);
    const snap = this.snapshot(), before = this.summary(); this.set({ screens }); const after = await this.separate();
    const pick = x => ({ screens: x.screens, colour_screens: x.films.filter(f => !f.underbase).length, press_de00: x.score.press_de00, aligned_de00: x.score.aligned_de00, stars: x.rating.stars, inks: x.films.filter(f => !f.underbase).map(f => f.name) });
    const out = { before: pick(before), after: pick(after), applied: !dryRun };
    if (dryRun) this.restore(snap); return out;
  }
  /** Spot screens: take out specks and fill pinholes smaller than minPx preview pixels (cvtools open/close), then
   *  proof again. The same cleanup runs on the export. */
  async cleanScreens({ minPx = 8, dryRun = false }) {
    this.need("res"); if (J.engineMode(this.s) !== "spot" || !this.res.spotIdx) throw new Error("clean_screens works on spot separations (solid plates). Halftone screens take out small dots with minDot and scatter: set_options {minDot, scatter}.");
    if (!Number.isFinite(minPx) || minPx < 1 || minPx > 400) throw new Error("clean_screens: min_speck_px must be from 1 to 400");
    const r = this.res, { W, H } = this.prev, N = r.inks.length, idx = cleanSpotSync(r.spotIdx, N, W, H, minPx);
    let changed = 0; for (let q = 0; q < idx.length; q++) if (idx[q] !== r.spotIdx[q]) changed++;
    const out = { min_speck_px: minPx, changed_px: changed, changed_pct: +(changed / idx.length * 100).toFixed(3), applied: !dryRun && changed > 0 };
    if (dryRun || !changed) return out;
    const cov = indexToCov(idx, N, W * H), pr = await reproof(J.reproofModel(this.s, this.ctx, r, this.prev, cov));
    this.res = { ...r, ...pr, spotIdx: idx, cov }; this.speck = minPx; this.workCache = null; return { ...out, separation: this.summary() };
  }

  /* ───────────── Pictures ───────────── */
  /** The modelled print at preview size (PNG), or the art, both side by side, or the colour difference (white = 0,
   *  black = 10 ΔE00 or more). width: longest side of the image. */
  previewPrint(view = "print", width = null) {
    this.need("res"); if (!VIEWS.includes(view)) throw new Error(`no view "${view}". Views: ${VIEWS.join(", ")}`);
    const { W, H } = this.prev, P = W * H, gar = hex2rgb(this.s.garment), img = this.hiddenProof().img;
    const printPx = q => [img[q * 4], img[q * 4 + 1], img[q * 4 + 2]];
    const artPx = q => { const a = this.prev.alpha[q] / 255; return [0, 1, 2].map(c => this.prev.px[q * 3 + c] * a + gar[c] * (1 - a)); };
    const diffPx = q => { const pl = rgb2lab(...printPx(q)), al = rgb2lab(...artPx(q)), v = 255 - Math.min(255, de2000(...pl, ...al) * 25.5); return [v, v, v]; };
    const cols = view === "compare" ? 2 : 1, OW = W * cols, d = new Uint8ClampedArray(OW * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < OW; x++) { const q = y * W + (x % W), o = (y * OW + x) * 4;
      const c = view === "art" || (view === "compare" && x < W) ? artPx(q) : view === "differences" ? diffPx(q) : printPx(q); d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255; }
    const out = width ? scaleRGBA(d, OW, H, width) : { d, W: OW, H };
    return { png: encodePNG(out.d, out.W, out.H), W: out.W, H: out.H, view };
  }
  /** The proof with the hidden screens left out (the page's reproofHidden), or the separation's own. */
  hiddenProof() {
    const r = this.res, hid = new Set(r.hidden || []); if (!hid.size) return r;
    const N = r.inks.length, cov = Float32Array.from(r.cov); r.inks.forEach((k, i) => { if (hid.has(k.name)) for (let q = i; q < cov.length; q += N) cov[q] = 0; });
    const ubOff = hid.has("\u0000underbase");
    if (this.imp) { const u = this.imp.ub, m = this.proofModel(this.imp.ch.map(c => c.prev), this.imp.ch); m.cov = cov; if (ubOff || u == null) { m.underbase = false; m.ubIn = null; } return evaluate(m, m.inks, m.cov); }
    const m = J.reproofModel(this.s, this.ctx, r, this.prev, cov); if (ubOff) m.underbase = false; return reproof({ ...m, noBase: r.noBase });
  }
  /** One film from the preview separation, black = ink. region: fractions of the film { x, y, w, h } shown at film
   *  resolution (cut to max px a side); without it the whole film is box-averaged to max px. */
  previewFilm(screen, region = null, max = 1000) {
    const p = this.screen(screen);
    const g = J.filmGeometry(this.s, this.prev.W, this.prev.H), req = J.filmRequest(this.s, this.ctx, this.res, this.prev, [p], g);
    if (region) { const x0 = Math.round(region.x * g.Wp), y0 = Math.round(region.y * g.Hp), w = Math.min(max, Math.max(1, Math.round(region.w * g.Wp)), g.Wp - x0), h = Math.min(max, Math.max(1, Math.round(region.h * g.Hp)), g.Hp - y0); req.crop = { x0, y0, w, h }; }
    let out = null; J.renderFilms(req, (_, bits, w, h) => { out = { bits, w, h }; });
    const k = region ? 1 : Math.max(1, Math.ceil(Math.max(out.w, out.h) / max)), W = Math.ceil(out.w / k), H = Math.ceil(out.h / k), d = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let on = 0, n = 0; for (let yy = y * k; yy < Math.min(out.h, (y + 1) * k); yy++) for (let xx = x * k; xx < Math.min(out.w, (x + 1) * k); xx++) { on += out.bits[yy * out.w + xx]; n++; }
      const v = Math.round(255 * (1 - on / n)), q = (y * W + x) * 4; d[q] = d[q + 1] = d[q + 2] = v; d[q + 3] = 255; }
    return { png: encodePNG(d, W, H), W, H, screen: p.name, order: p.order, dpi: g.dpi / k, note: region ? "film pixels at full resolution" : `whole film, ${k}×${k} film pixels per image pixel (gray = dot share)` };
  }
  /** Where a check (by id) or a screen prints: its box (fractions of the art) and the print with the box drawn. */
  showRegion({ check = null, screen = null }) {
    this.need("res"); if ((check == null) === (screen == null)) throw new Error("show_region: give check (an id from check_job) or screen, one of them");
    let box = null, what;
    if (check != null) { const list = this.checks(), c = list.find(x => x.id === check) || list.flatMap(x => (x.colors || []).map((g, k) => ({ ...g, id: `${x.id}:${k}` }))).find(x => x.id === check);
      if (!c) throw new Error(`no check "${check}" in this job. Checks now: ${list.map(x => x.id).join(", ") || "none"}${list.some(x => x.colors) ? " (a gamut colour: out-of-gamut:0, :1, …)" : ""}`);
      box = c.region ? c.region.box : null; what = `check ${check}`; if (!box) return { what, box: null, note: "this check is about the whole job, not a part of the art" }; }
    else { const p = this.screen(screen), m = regionMask(p.ub ? "ink" : `screen:${p.idx}`, this.checkJobData(), this.res); box = m && maskBox(m, this.prev.W, this.prev.H); what = `screen ${p.order} ${p.name}`;
      if (!box) return { what, box: null, note: "this screen prints nothing" }; }
    const { W, H } = this.prev, d = new Uint8ClampedArray(W * H * 4), img = this.res.img; for (let q = 0; q < W * H; q++) { for (let c = 0; c < 3; c++) d[q * 4 + c] = img[q * 4 + c]; d[q * 4 + 3] = 255; }
    const t = Math.max(2, Math.round(W / 300)), x0 = Math.floor(box.x * W), y0 = Math.floor(box.y * H), x1 = Math.min(W - 1, Math.ceil((box.x + box.w) * W)), y1 = Math.min(H - 1, Math.ceil((box.y + box.h) * H));
    for (let y = Math.max(0, y0 - t); y <= Math.min(H - 1, y1 + t); y++) for (let x = Math.max(0, x0 - t); x <= Math.min(W - 1, x1 + t); x++) {
      const edge = x < x0 || x > x1 || y < y0 || y > y1 || x < x0 + t || x > x1 - t || y < y0 + t || y > y1 - t; if (!edge) continue; const o = (y * W + x) * 4; d[o] = 220; d[o + 1] = 20; d[o + 2] = 40; }
    const r = v => +v.toFixed(4);
    return { what, box: { x: r(box.x), y: r(box.y), w: r(box.w), h: r(box.h) }, png: encodePNG(d, W, H), W, H, inches: { x: r(box.x * this.s.widthIn), y: r(box.y * this.s.widthIn * H / W), w: r(box.w * this.s.widthIn), h: r(box.h * this.s.widthIn * H / W) } };
  }

  /* ───────────── Files ───────────── */
  /* ───────────── Re-proof separated films ───────────── */
  /** What the job's screening shows of each printed film (filmimport.printedToVisible), as the page's shownOf. */
  shown(planes, P) { const o = J.overprint(this.s); return F.printedToVisible(planes, P, o, o === "same" ? J.rhoOf(this.s, this.ctx.calib) : 0); }
  /** The films' proof model at the preview size (the page's reproofImport). */
  proofModel(planes, chs) {
    const P = this.prev.W * this.prev.H, inks = chs.filter(c => !c.ub), vis = this.shown(planes.filter((_, j) => !chs[j].ub), P), cov = new Float32Array(P * inks.length);
    vis.forEach((c, i) => { for (let q = 0; q < P; q++) cov[q * inks.length + i] = c[q]; });
    const u = chs.findIndex(c => c.ub), ubIn = u >= 0 ? planes[u] : null;
    return { ...J.sepModel(this.s, this.prev, this.ctx), mode: "sim", screening: "am", film: { minDot: 0, maxDot: 1, lpi: 0, widthIn: +this.s.widthIn }, cov, inks: inks.map(c => ({ name: c.name, lab: c.lab })), underbase: !!ubIn, ubIn };
  }
  /** Read separated films back as the job's screens: a Photoshop file (one channel per screen) or TIFF films, one per
   *  screen, with an optional separation.json for colours and names, as the page's Re-proof films. The art is the
   *  loaded art, or the Photoshop file's own composite. Mirrored films are found by proofing both ways. */
  async importFilms(paths, spec = null, root = null) {
    // a folder's films: regular files only, inside the root (or the folder), no symlinks, each under the size cap
    paths = paths.flatMap(p => !statSync(p).isDirectory() ? [p] : readdirSync(p).filter(f => /\.tiff?$/i.test(f)).map(f => join(p, f))
      .filter(e => { const l = lstatSync(e); return !l.isSymbolicLink() && l.isFile(); }).map(e => within(root || p, e, "film")));
    const bufOf = p => { const st = statSync(p); if (!st.isFile()) throw new Error(`${p}: not a file`);
      if (st.size > ART_MAX_BYTES) throw new Error(`${p}: ${(st.size / 1e6).toFixed(0)} MB is over the ${ART_MAX_BYTES / 1024 / 1024} MB film limit`);
      const b = readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); };
    const psd = paths.filter(p => /\.psd$/i.test(p)), tifs = paths.filter(p => /\.tiff?$/i.test(p));
    if (!psd.length && !tifs.length) throw new Error("give a Photoshop file (.psd), or the TIFF films (.tif), one for each screen");
    if (psd.length > 1 || (psd.length && tifs.length)) throw new Error("give one Photoshop file, or a set of TIFF films; not both");
    /** @type {any} */ let set;
    if (psd.length) { set = F.readPSD(bufOf(psd[0])); set.name = basename(psd[0]); }
    else { const parts = tifs.slice().sort((a, b) => basename(a).localeCompare(basename(b), undefined, { numeric: true })).map(p => { try { return { p, t: F.readTIFF(bufOf(p)) }; } catch (e) { throw new Error(`${p}: ${e.message}`); } });
      const [a] = parts, bad = parts.find(x => x.t.W !== a.t.W || x.t.H !== a.t.H); if (bad) throw new Error(`${bad.p} is ${bad.t.W} × ${bad.t.H} px and ${a.p} is ${a.t.W} × ${a.t.H} px. All the films must be the same size.`);
      set = { W: a.t.W, H: a.t.H, dpi: a.t.dpi, rgba: null, mode: "tiff", name: parts.length === 1 ? basename(a.p) : `${parts.length} TIFF films`,
        channels: parts.map(({ p, t }) => { const stem = basename(p).replace(/\.tiff?$/i, ""), nm = F.stripOrder(stem); return { name: nm, file: stem, lab: null, ink: t.ink, ub: F.isBaseName(nm), hits: 1 }; }) }; }
    F.colorChannels(set, spec, this.ctx.library);
    if (!this.art && set.rgba) this.setArt({ rgba: set.rgba, W: set.W, H: set.H, info: "The art is the Photoshop file's composite." }, { name: set.name, path: null, sha256: null });
    if (!this.art) throw new Error("load the art first (load_art; sep convert --art art.png): the rating compares the films with the art. A Photoshop file in RGB mode carries its art.");
    const area = F.artArea(set.W, set.H, set.mode === "tiff" ? set.dpi : null, this.art.W / this.art.H, { widthIn: spec && spec.print && +spec.print.width_in || 0, planes: set.channels.map(c => c.ink) });
    if (!area) throw new Error(`the films are ${set.W} × ${set.H} px and the art is ${this.art.W} × ${this.art.H} px; their shapes do not match: load the art these films were made from`);
    if (set.dpi) { const w = Math.round(area.w / set.dpi * 100) / 100; if (w >= 1 && w <= 30) this.s = { ...this.s, widthIn: w }; }
    const workW = this.art.W, workH = this.art.H, ch = F.channelCoverage(set, area, { prevW: this.prev.W, prevH: this.prev.H, workW, workH, lpi: +this.s.lpi || 45, widthIn: +this.s.widthIn || 11, gain: +this.s.gain / 100 });
    const err = planes => { const m = this.proofModel(planes, ch); return evaluate(m, m.inks, m.cov).stats.mean; };
    const asRead = err(ch.map(c => c.prev)), flipped = err(ch.map(c => mirrorX(c.prev, this.prev.W, this.prev.H))), flip = flipped < asRead - 0.5;
    if (flip) for (const c of ch) { c.prev = mirrorX(c.prev, this.prev.W, this.prev.H); if (c.work) c.work = mirrorX(c.work, workW, workH); }
    const u = ch.findIndex(c => c.ub), inks = ch.map((c, j) => ({ c, j })).filter(x => !x.c.ub).map(({ c, j }) => ({ name: c.name, lab: c.lab.slice(), source: "imported", locked: true, imp: j, ...(c.hits === 2 && { hits: 2, flashBetween: c.flashBetween }), ...c.set }));
    this.drop(); this.s = { ...this.s, method: "sim", screens: inks.length }; this.fixed.add("screens"); this.fixed.add("method");
    this.ctx = { ...this.ctx, ub: u >= 0 && (ch[u].hits === 2 || ch[u].set) ? { ...(ch[u].hits === 2 && { hits: 2, flashBetween: ch[u].flashBetween }), ...ch[u].set } : this.ctx.ub };
    this.imp = { name: set.name, mode: set.mode, ch, ub: u >= 0 ? u : null, workW, workH, flipped: flip, trimmed: !!area.x }; this.inks = inks;
    const sum = await this.reproofImport();
    return { imported: set.name, kind: set.mode, colour_screens: inks.length, underbase: u >= 0, margin_trimmed: !!area.x, mirrored_films_read_right: flip, width_in: +this.s.widthIn, separation: sum };
  }
  async reproofImport() {
    const t0 = performance.now(), im = this.imp, planes = im.ch.map(c => c.prev), m = this.proofModel(planes, im.ch), ev = evaluate(m, m.inks, m.cov);
    this.res = { ...ev, inks: this.inks, cov: m.cov, spotIdx: null, noBase: null, dropped: [], costs: null, gamut: null, lab: this.prev.lab, solid: null, imported: true, ms: Math.round(performance.now() - t0) };
    this.workCache = null; return this.summary();
  }
  /** The imported screens at the working size: the separation the films and the Photoshop file are made from. */
  importedWork() {
    const im = this.imp, N = this.inks.length, work = this.art, P = work.W * work.H, val = c => c.work ? Float32Array.from(c.work, v => v / 255) : c.prev;
    const cov = new Float32Array(P * N), covPct = this.inks.map(() => 0), vis = this.shown(this.inks.map(k => val(im.ch[k.imp])), P);
    this.inks.forEach((k, i) => { const c = vis[i]; for (let q = 0; q < P; q++) { cov[q * N + i] = c[q]; covPct[i] += c[q]; } covPct[i] /= P; });
    const ub = im.ub != null && this.res.ub ? val(im.ch[im.ub]) : null; let ubPct = 0; if (ub) { for (let q = 0; q < P; q++) ubPct += ub[q]; ubPct /= P; }
    return { inks: this.inks, cov, ub, covPct, ubPct, stats: this.res.stats, spotIdx: null, noBase: null, solid: null };
  }
  /** The working-copy separation the films are made from (cached until the job changes). */
  async work() {
    this.need("res"); if (this.workCache && this.workCache.res === this.res) return this.workCache;
    const s = { ...this.s, screens: this.s.screens === "auto" ? this.autoK || 6 : this.s.screens }, work = this.art;
    if (this.imp) { this.workCache = { res: this.res, s, r: this.importedWork(), work }; return this.workCache; }
    let r = runSeparation({ ...J.withMethod({ ...J.sepModel(s, work, this.ctx), preview: false, repick: false, defer: false, mode: J.engineMode(s), inks: this.inks, locked: this.inks.filter(i => i.locked) }), costs: false });
    r = await J.cleanSpot(s, this.ctx, r, work, reproof, this.speck == null ? null : this.speck * (work.W / this.prev.W) ** 2);
    this.workCache = { res: this.res, s, r, work }; return this.workCache;
  }
  /** A spot screen traced to SVG paths at the working size (vector.js, VTracer), as the job ZIP's svg/ files. */
  async vectorizeScreen(sel) {
    const p = this.colorScreen(sel, "vectorize_screen"); if (J.engineMode(this.s) !== "spot") throw new Error("vectorize_screen traces solid spot plates; this job is halftoned. Use set_options {method: \"spot\"} first.");
    const { r, work } = await this.work(), trace = await this.tracer(); if (!r.spotIdx) throw new Error("vectorize_screen: the separation has no spot plates");
    const m = new Uint8Array(work.W * work.H); for (let q = 0; q < m.length; q++) m[q] = r.spotIdx[q] === p.idx ? 1 : 0;
    const paths = await trace.traceMask(m, work.W, work.H), svg = trace.wrapSVG(paths, work.W, work.H, +this.s.widthIn);
    return { screen: p.name, order: p.order, file: `${plateSlug(p)}.svg`, paths: (paths.match(/<path/g) || []).length, width_in: +this.s.widthIn, svg };
  }
  async tracer() { const t = await import("../vector.js"); t.useWasmBytes(readFileSync(join(ROOT, "vendor", "vtracer.wasm"))); return t; }
  /** The job's files, as the page's step 4 download, in memory: [name, bytes] in the order written. */
  async buildJob({ date = new Date(), say = () => {}, formats = null } = {}) {
    loadVendor(); const w = await this.work(), s = formats ? { ...w.s, formats: { ...w.s.formats, ...formats } } : w.s, work = w.work;
    const geom = J.filmGeometry(s, work.W, work.H); if (geom.Wp * geom.Hp > 120e6) throw new Error("a film would be over 120 megapixels: lower the DPI or the print width");
    const r = w.r, pl = J.filmPlates(s, r.inks, !!r.ub, this.ctx), errs = checkPlan(pl, r); if (errs.length) throw new Error("film plan is inconsistent: " + errs.join("; "));
    const bits = []; J.renderFilms(J.filmRequest(s, this.ctx, r, work, pl, geom), (j, b, ww, h) => { bits[j] = { bits: b, w: ww, h }; });
    const trace = s.formats.svg && J.engineMode(s) === "spot" ? await this.tracer() : null, slug = J.jobSlug(s, date);
    // JSZip in Node takes no Blob: entries are collected in the order written, as bytes
    const entries = [], collect = { file: (name, data) => { entries.push(data instanceof Blob ? data.arrayBuffer().then(b => [name, new Uint8Array(b)]) : Promise.resolve([name, typeof data === "string" ? Buffer.from(data) : data])); } };
    const { spec } = await J.writeJob({ s, ctx: this.ctx, work, r, pl, bits, prev: this.prev, proof: this.res.img, art: work, zip: collect, slug, created: date.toISOString(), trace, platform: nodePlatform, say,
      imported: this.imp ? { from: this.imp.name, kind: this.imp.mode, rescreened: true } : null });
    return { entries: await Promise.all(entries), slug, spec };
  }
  /** The job ZIP, written whole or not at all. */
  async exportJob(path, { date = new Date(), say = () => {}, formats = null, built = null } = {}) {
    const { entries, slug, spec } = built || await this.buildJob({ date, say, formats }), JSZip = /** @type {any} */ (globalThis).JSZip, zip = new JSZip();
    for (const [name, data] of entries) zip.file(name, data, { date });
    const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }); writeAtomic(path, buf);
    return { path, bytes: buf.length, files: entries.map(e => e[0]), slug, screens: spec.screens.length };
  }
  /** The job's files into a folder (a RIP's hot folder): <dir>/<slug>/…, each file written whole. Refuses to write
   *  over files unless overwrite. */
  async exportFolder(dir, { overwrite = false, formats = null, date = new Date(), only = null } = {}) {
    const built = await this.buildJob({ date, formats }), { slug, spec } = built, root = join(resolve(dir), slug), entries = only ? built.entries.filter(([n]) => only(n)) : built.entries;
    const there = entries.filter(([n]) => existsSync(join(root, n))).map(([n]) => n);
    if (there.length && !overwrite) throw new Error(`${root} already has ${there.length} of these files (${there.slice(0, 3).join(", ")}${there.length > 3 ? ", …" : ""}). Pass overwrite: true to write over them.`);
    let bytes = 0; for (const [n, data] of entries) { writeAtomic(join(root, n), data); bytes += data.length; }
    return { folder: root, files: entries.map(e => e[0]), bytes, slug, screens: spec.screens.length };
  }
  /** separation.json for the job as it stands, from the preview separation (export makes it again at full size). */
  separationSpec() {
    this.need("res"); const s = this.s, r = this.res, pl = this.plates(), dpi = +s.dpi;
    return specFor({ plates: pl, result: r, mode: J.engineMode(s), method: J.methodName(s), garment: { hex: s.garment, lab: J.garmentLab(s) },
      print: { width_in: +s.widthIn, dpi, lpi: +s.lpi, screening: s.screening, angle: +s.angle, dot_shape: s.dot || "round", dot_gain_50: +s.gain, min_dot: +s.minDot, scatter_small_dots: !!s.scatter, max_dot: +s.maxDot, choke_mm: +s.choke, choke_px: J.chokePx(s, dpi), index_dpi: +s.indexDpi, stack_limit_pct: +s.stackLimit, press: s.press, ...(s.mirror && { mirror: s.mirror === "mirror" }) },
      model: { yule_nielsen_n: this.ctx.calib ? this.ctx.calib.n : 1.7, calibrated: !!this.ctx.calib, calibration_residual_de00: this.ctx.calib ? this.ctx.calib.residual : null }, targets: this.ctx.targets });
  }
  /** The job file (job.jobFile): settings, inks and the art's path relative to the file, so the folder can move. */
  jobFile(path) {
    this.need("res"); const at = resolve(path), f = this.file, rel = f.path ? relative(dirname(at), f.path) : null;
    return J.jobFile({ s: this.s, inks: this.inks, art: f.path ? { file: f.name, path: rel, sha256: f.sha256, W: f.W, H: f.H, edits: this.artEdits } : null, ctx: this.ctx, auto: this.auto });
  }
  saveJob(path, { overwrite = false } = {}) {
    const p = resolve(path); if (existsSync(p) && !overwrite) throw new Error(`${p} exists. Pass overwrite: true to write over it.`);
    const d = this.jobFile(p); writeAtomic(p, JSON.stringify(d, null, 2) + "\n"); return { path: p, art: d.art && d.art.path, inks: d.inks.length, settings: Object.keys(d.settings).length };
  }
  /** Reopen a job file: its art (relative to the file), settings, shop context and inks, separated with those inks as
   *  they are, so it is the same separation. */
  /** allowOutside: the art may be an absolute path or outside the job file's folder (sep --allow-outside); otherwise
   *  only art in that folder or under it is read. A recorded SHA-256 must match the art. */
  async openJob(path, { run = true, allowOutside = false } = {}) {
    const p = resolve(path), d = J.readJobFile(readFileSync(p, "utf8")); if (!d.art) throw new Error(`${p}: the job file names no art`);
    if (!allowOutside && isAbsolute(d.art.path)) throw new Error(`${p}: its art path ${d.art.path} is absolute; a job file names its art relative to its own folder (--allow-outside reads it anyway)`);
    const artPath = allowOutside ? resolve(dirname(p), d.art.path) : within(dirname(p), d.art.path, `${p}: its art`); if (!existsSync(artPath)) throw new Error(`${p}: its art ${artPath} is not there`);
    const sum0 = sha256(readFileSync(artPath));
    if (d.art.sha256 && d.art.sha256 !== sum0) throw new Error(`${p}: the art at ${artPath} is not the file the job was saved with (its SHA-256 differs); the job is not opened`);
    await this.load(artPath); for (const e of d.art.edits || []) if (e === "remove-background") this.removeBackground(); else throw new Error(`${p}: unknown art edit "${e}". Edits: remove-background`);
    const warn = d.art.sha256 ? null : "the job file records no SHA-256 for its art, so it cannot say the art is unchanged";
    this.s = { ...J.defaults(), ...d.settings, formats: d.formats }; this.fixed = new Set(Object.keys(d.settings));
    this.ctx = { ...this.ctx, ...d.ctx, ...(d.ub && { ub: d.ub }) }; this.auto = d.auto; this.keep = d.inks; this.locked = (d.inks || []).filter(i => i.locked);
    if (!d.inks && this.s.screens === "auto") this.keep = null;
    if (warn && !run) process.stderr.write(`warning: ${warn}\n`);
    return { opened: p, art: artPath, ...(warn && { warning: warn }), ...(run && { separation: await this.separate() }) };
  }
  snapshot() { return { s: structuredClone(this.s), fixed: new Set(this.fixed), ctx: { ...this.ctx }, art: this.art, prev: this.prev, file: this.file, res: this.res, inks: this.inks, auto: this.auto, autoK: this.autoK, keep: this.keep, locked: this.locked, speck: this.speck, workCache: this.workCache, artEdits: this.artEdits, imp: this.imp }; }
  restore(x) { Object.assign(this, x); }
  /** The job in one object: art, settings that differ from the defaults, screens, scores, rating and checks. */
  describe() {
    const d = J.defaults(), changed = Object.fromEntries(Object.keys(J.SETTINGS).filter(k => JSON.stringify(this.s[k]) !== JSON.stringify(d[k])).map(k => [k, this.s[k]]));
    return { art: this.art ? this.artInfo() : null, settings: changed, garment: this.s.garment, press: this.s.press, method: this.s.method, print_width_in: +this.s.widthIn,
      shop: { profile: this.ctx.profile, mesh: this.ctx.mesh, calibrated: !!this.ctx.calib, sizes: this.ctx.sizes ? Object.fromEntries(SIZE_KINDS.map(k => [k, this.ctx.sizes[k].name])) : null, limits: this.ctx.limits },
      separation: this.res ? this.summary() : null, checks: this.res ? this.checks().map(c => ({ id: c.id, severity: c.severity, title: c.title })) : null };
  }
}
/** Box-resample RGBA so the longest side is `max` px (never up). */
function scaleRGBA(d, W, H, max) {
  const k = Math.min(1, max / Math.max(W, H)); if (k >= 1) return { d, W, H };
  const OW = Math.max(1, Math.round(W * k)), OH = Math.max(1, Math.round(H * k)), o = new Uint8ClampedArray(OW * OH * 4);
  for (let y = 0; y < OH; y++) for (let x = 0; x < OW; x++) { const xa = Math.floor(x / k), xb = Math.max(xa + 1, Math.floor((x + 1) / k)), ya = Math.floor(y / k), yb = Math.max(ya + 1, Math.floor((y + 1) / k)), s = [0, 0, 0]; let n = 0;
    for (let yy = ya; yy < Math.min(H, yb); yy++) for (let xx = xa; xx < Math.min(W, xb); xx++) { const q = (yy * W + xx) * 4; s[0] += d[q]; s[1] += d[q + 1]; s[2] += d[q + 2]; n++; }
    const q = (y * OW + x) * 4; o[q] = s[0] / n; o[q + 1] = s[1] / n; o[q + 2] = s[2] / n; o[q + 3] = 255; }
  return { d: o, W: OW, H: OH };
}
