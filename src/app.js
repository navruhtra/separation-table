// @ts-check
// ADN Separation Table — UI and orchestration.
import { rgb2lab, lab2rgb, hex2rgb, rgb2hex, indexToCov, de2000, trapSpot } from "./engine.js";
import { genericLibrary, parseInkCSV, inksToCSV, PRESETS, libraryKind } from "./inks.js";
import { parseWedgeCSV, fitCalibration, TINTS } from "./calib.js";
import { matchTarget } from "./targets.js";
import { autoPlan, autoSizes, autoThumb, searchPlan, orderPlan, ORDER_GAIN, ORDER_SIZE, STACK_RANGE, SCREEN_COST } from "./pipeline.js";
import { platesFor, filmLabel, plateSlug, specFor, meshFor, minDotFor, checkPlan, PRESS, mixRows, nearestStock, printRating, inkGrams, colorName, USUAL_SCREENS, cleanName, NAME_MAX, screensFor, pressTime, pressTimeText, PRESS_TIME, hoursMin, STOCK_MESH, cleanProfile, uniqueName, profilesToJSON, profilesFromJSON, mergeProfiles, builtinProfiles, FABRICS, fabricSettings, fabricText, FORMAT_KEYS, CHECK_LIMITS } from "./plan.js";
import { deltaECMC as cjCMC, Lab as cjLab } from "./vendor/color-fn.js";
import { initHelp } from "./help.js";
import { VERSION } from "./version.js";
import { printedToVisible } from "./filmimport.js";
import { ADJ0, isNeutral, adjustArt } from "./adjust.js";
import { preflightChecks, regionMask, regionKey, maskBox, solidBackground, STACK_ALLOW } from "./checks.js";
import { SIZE_PRESETS, SIZE_KINDS, cleanSizes, sizeSetting } from "./sizes.js";
import * as J from "./job.js";

/** @type {(id: string) => any} DOM lookup; elements are inputs, canvases and buttons by id */
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const { PREV_MAX, WORK_MAX } = J;
/** The shop's platen, film and screen (Shop setup), or the standard sizes when none are saved or the saved ones are not valid. */
function loadSizes() { try { return cleanSizes(store.get("sizes", null)); } catch { return cleanSizes(null); } }
const store = { get(k, d) { try { const v = localStorage.getItem("sepbench." + k); return v ? JSON.parse(v) : d; } catch { return d; } }, set(k, v) { try { localStorage.setItem("sepbench." + k, JSON.stringify(v)); } catch { } } };

/** Shop and press profiles (Shop setup): the saved list, the one in use, and the shop's mesh for each kind of screen. */
const SHOP0 = { list: /** @type {import("./plan.js").Profile[]} */ ([]), active: /** @type {string | null} */ (null), mesh: { base: null, color: null, white: null } };
const shopIn = (() => { const v = store.get("profiles", null); return v && Array.isArray(v.list) ? { ...SHOP0, ...v, mesh: { ...SHOP0.mesh, ...(v.mesh || {}) } } : { ...SHOP0 }; })();
/** The page state that belongs to the open job, as a new job has it. clearJob puts it back when another job opens. */
const JOB0 = () => ({
  art: null, history: [], prev: null, adj: { ...ADJ0 }, adjOff: false, artAdj: /** @type {any} */ (null), inks: [],
  mode: "sim", method: "sim", methodPicked: false, tone: 2, freeK: 0, view: "film", chan: 0, src: /** @type {Record<string, string>} */ ({}), refocus: /** @type {number | null} */ (null), autoWhy: /** @type {any} */ (null), whyOpen: false, salience: 1, placed: /** @type {any} */ (null), searched: /** @type {any} */ (null), openRows: /** @type {Set<number>} */ (new Set()), sugOpen: false, chipInfo: /** @type {string | null} */ (null), res: null,
  prod: /** @type {Map<string, import("./plan.js").ScreenProd>} */ (new Map()), imp: /** @type {any} */ (null),
  fewer: /** @type {any} */ (null), sel: null, selPoints: [], selecting: false, autoRunning: false, autoBest: /** @type {any} */ (null), profile: null, sample: false, step: 0, exported: false, checksFailed: 0, mark: null, rOpen: false, fold: false, compare: false, splitX: 0.5, hidden: new Set(), cmpFilm: /** @type {any} */ (null), artCv: /** @type {any} */ (null), hidRes: /** @type {any} */ (null), autoBy: false, tab: "preview", why: "", artFile: /** @type {any} */ (null),
  probe: /** @type {any} */ (null), pressOn: false, pressK: 0, pressRes: /** @type {any} */ (null), savedArt: /** @type {any} */ (null), savedBlob: /** @type {any} */ (null), _encoded: false,
});
const st = {
  shop: shopIn, ...JOB0(),
  library: store.get("library", null) || genericLibrary(), calib: store.get("calib", null),
  targets: store.get("targets", null) || [{ label: "Creator red (example)", lab: [48, 68, 42], tier: 2 }],
  sizes: loadSizes(), units: "in", busy: false, autoTok: 0, autoLive: 0, advOpen: false, jobId: "", insp: { z: /** @type {number | "fit"} */ ("fit"), cx: null, cy: null, all: true, tok: 0, quiet: false, view: /** @type {any} */ (null) },
};

/* ───────────── Worker plumbing ───────────── */
const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
let reqId = 0; const pending = new Map();
worker.onmessage = ({ data: m }) => {
  const p = pending.get(m.id); if (!p) return;
  if (m.type === "error") { pending.delete(m.id); p.reject(new Error(m.message)); return; }
  if (m.type === "autoStep") { p.onPlate && p.onPlate(m.f); return; }
  if (m.type === "plate") { p.plates[m.j] = m; p.onPlate && p.onPlate(m.j); return; }
  if (m.type === "platesDone") { pending.delete(m.id); p.resolve(p.plates); return; }
  pending.delete(m.id); p.resolve(m);
};
function call(msg, transfer = [], onPlate) { const id = ++reqId, t0 = performance.now(); const pr = new Promise((resolve, reject) => { pending.set(id, { resolve, reject, plates: [], onPlate }); worker.postMessage({ ...msg, id }, transfer); });
  return TIMING ? pr.then(r => { timed(msg.type, performance.now() - t0); return r; }) : pr; }
/* Timing log: open the page with ?timing=1 and every worker job (separate, reproof, plates, Auto's steps) is
   written to the console with its time, and kept in window.sepTiming and in the problem report. Off by default. */
/** A page address parameter: the page's own, or the ADN page's around it (the site frames bench.html; same origin). */
function urlParam(k) { for (const w of [window, window.parent]) { try { const v = new URLSearchParams(w.location.search).get(k); if (v != null) return v; } catch { /* another origin */ } } return null; }
/* v1 surface: the groups marked data-later (Press and Stack views, profiles, press time, DCS, dot shape,
   re-proof, units, test films, report) are not shown. ?later=1 shows them: bench.css hides [data-later] without .later. */
const LATER = urlParam("later") === "1"; document.documentElement.classList.toggle("later", LATER);
const TIMING = urlParam("timing") === "1";
/** @type {{ job: string, ms: number, at: string }[]} */ const timings = [];
function timed(job, ms) { const e = { job, ms: Math.round(ms), at: new Date().toISOString() }; timings.push(e); if (timings.length > 200) timings.shift(); console.info(`[timing] ${job} ${e.ms} ms`); }
if (TIMING) /** @type {any} */ (window).sepTiming = timings;
/* Local error log: the last 20 errors on this device (message and where), never the art. Kept under
   sepbench.errors; Shop setup > Report a problem copies them with the settings. */
const ERR_MAX = 20;
function logError(msg, where = "") { const l = store.get("errors", []), m = String(msg || "").slice(0, 300); if (!m) return; l.push({ at: new Date().toISOString(), msg: m, where: String(where).slice(0, 200) }); store.set("errors", l.slice(-ERR_MAX)); }
window.addEventListener("error", e => logError(e.message, `${(e.filename || "").split("/").pop()}:${e.lineno || 0}`));
window.addEventListener("unhandledrejection", e => logError(e.reason && e.reason.message || e.reason, "promise"));
{ const ce = console.error.bind(console); console.error = (...a) => { const x = a[0]; logError(x && x.message ? x.message : a.map(String).join(" "), x && x.stack ? String(x.stack).split("\n")[1] || "" : ""); ce(...a); }; }
/* Auto's trial separations are independent, so they run side by side: the worker above plus a few helpers that are
   made on the first Auto and kept. Each holds only the small copies of the art that the trials use (160 to 480 px),
   never the full-size art. Phones get one helper; a desktop up to five, leaving cores for the page and the browser. */
/** @type {{ call: (msg: any) => Promise<any> }[]} */ const helpers = [];
function helperCount() { const hc = navigator.hardwareConcurrency || 2; return Math.max(0, Math.min(phone() ? 1 : 5, hc - 2)); }
function newHelper() {
  const w = new Worker(new URL("./worker.js", import.meta.url), { type: "module" }), pend = new Map(); let n = 0, dead = false;
  const fail = msg => { dead = true; for (const p of pend.values()) p.reject(new Error(msg)); pend.clear(); };
  w.onmessage = ({ data: m }) => { const p = pend.get(m.id); if (!p) return; pend.delete(m.id); if (m.type === "error") p.reject(new Error(m.message)); else p.resolve(m); };
  w.onerror = e => fail(e.message || "A helper worker stopped.");
  return { call: msg => dead ? Promise.reject(new Error("A helper worker stopped.")) : new Promise((resolve, reject) => { const id = ++n; pend.set(id, { resolve, reject }); w.postMessage({ ...msg, id }); }) };
}
/** Run a plan of trials (pipeline.autoPlan or searchPlan): each batch is shared out to the workers; results keep their
    order, so the pick is the same as with one worker. A helper that fails is dropped and its trial runs on the main worker. */
const autoPooled = (params, onStep, stopped = () => false) => pooled(params, autoSizes(params), autoPlan(params, null), onStep, stopped);
/** @param {Generator<any[], any, any[]>} gen */
async function pooled(params, sizes, gen, onStep, stopped = () => false) {
  while (helpers.length < helperCount()) { try { helpers.push(newHelper()); } catch { break; } }
  const thumbs = {}; for (const size of sizes) thumbs[size] = autoThumb(params, size);
  const main = { call: msg => call(msg) }; let crew = [main];
  for (const h of helpers.slice()) { try { await h.call({ type: "autoInit", thumbs }); crew.push(h); } catch { helpers.splice(helpers.indexOf(h), 1); } }
  await main.call({ type: "autoInit", thumbs });
  let res = gen.next(), done = 0;
  while (!res.done) {
    const jobs = res.value, out = new Array(jobs.length); let next = 0;
    const work = async w => { while (next < jobs.length && !stopped()) { const i = next++;
      try { out[i] = (await w.call({ type: "autoJob", job: jobs[i] })).r; }
      catch (e) { if (w === main) throw e; crew = crew.filter(x => x !== w); const k = helpers.indexOf(w); if (k >= 0) helpers.splice(k, 1); out[i] = (await main.call({ type: "autoJob", job: jobs[i] })).r; return; }
      if (onStep) onStep(++done); } };
    await Promise.all(crew.map(work)); if (stopped()) return null; res = gen.next(out);
  }
  return res.value;
}

/* ───────────── Art handling ───────────── */
function setArt(rgba, W, H, keepHistory = true) {
  if (keepHistory && st.art) { st.history.push(st.art); if (st.history.length > 6) st.history.shift(); }
  st.art = { rgba, W, H }; st.artAdj = null; $("undoArt").disabled = !st.history.length;
  st.sel = null; st.selPoints = []; import("./ai.js").then(a => a.samReset()).catch(() => { });
  st.prev = downsample(artIn(), PREV_MAX); renderArtCard();
  syncH(); renderTabs();
}
/** The art the separation reads: the file (after any Fix the art) with Adjust the art applied. The adjusted copy is
    kept until the art or a slider changes. Before/After shows and separates the art without the sliders. */
function artIn() {
  const a = st.art; if (!a || st.adjOff || isNeutral(st.adj)) return a;
  if (!st.artAdj) st.artAdj = { W: a.W, H: a.H, rgba: adjustArt(a.rgba, a.W, a.H, st.adj) };
  return st.artAdj;
}
/** The art changed under the separation (a slider, Before/After, Reset): a new preview copy, then separate again. On
    Auto, Auto tunes the job for the new art (its inks can change: more saturated art can want other inks); off Auto, the
    inks are kept and only the screens are made again. A separation still running is waited for, then this one runs. */
let adjTok = 0;
async function artAdjusted() {
  const tok = ++adjTok; st.artAdj = null; if (!st.art) return; renderAdjust();
  while (st.busy) { await new Promise(r => setTimeout(r, 120)); if (tok !== adjTok) return; }
  st.prev = downsample(artIn(), PREV_MAX); renderArtCard(); st.why = "art";
  if (st.autoBy || st.autoRunning) autoSettings(true); else run(false);
}
/** The artwork card inside the drop box: a thumbnail on the garment, the file name, size and resolution at print width. */
function renderArtCard() {
  const a = artIn(), f = st.artFile; $("fileCard").hidden = !a; $("drop").hidden = !!a; if (!a || !f) return;
  const t = $("artThumb"), g = t.getContext("2d"), s = Math.min(t.width / a.W, t.height / a.H), w = Math.max(1, Math.round(a.W * s)), h = Math.max(1, Math.round(a.H * s));
  const c = document.createElement("canvas"); c.width = a.W; c.height = a.H; c.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(a.rgba), a.W, a.H), 0, 0);
  g.fillStyle = $("garment").value; g.fillRect(0, 0, t.width, t.height); g.imageSmoothingQuality = "high"; g.drawImage(c, (t.width - w) / 2, (t.height - h) / 2, w, h);
  const ppi = Math.round(f.W / Math.max(1, +$("outW").value || 11));
  $("artName").textContent = f.name; $("artSize").textContent = `${f.W} × ${f.H} px · ${ppi} pixels for each inch at ${lenText(`${$("outW").value} in`)}${ppi < 200 ? " (low)" : ""}`; $("artInfo").textContent = f.info;
}
// withLab:false leaves the Lab conversion to the worker (export at working size would otherwise block the page).
function downsample(art, max, withLab = true) {
  const s = Math.min(1, max / Math.max(art.W, art.H)), W = Math.max(1, Math.round(art.W * s)), H = Math.max(1, Math.round(art.H * s));
  let rgba = art.rgba;
  if (s < 1) { const a = document.createElement("canvas"); a.width = art.W; a.height = art.H; a.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(art.rgba), art.W, art.H), 0, 0);
    const c = document.createElement("canvas"); c.width = W; c.height = H; const g = c.getContext("2d"); g.imageSmoothingQuality = "high"; g.drawImage(a, 0, 0, W, H); rgba = g.getImageData(0, 0, W, H).data; }
  const P = W * H, px = new Uint8ClampedArray(P * 3), alpha = new Uint8Array(P), lab = withLab ? new Float32Array(P * 3) : null;
  for (let j = 0; j < P; j++) { px[j * 3] = rgba[j * 4]; px[j * 3 + 1] = rgba[j * 4 + 1]; px[j * 3 + 2] = rgba[j * 4 + 2]; alpha[j] = rgba[j * 4 + 3]; if (lab) lab.set(rgb2lab(px[j * 3], px[j * 3 + 1], px[j * 3 + 2]), j * 3); }
  return { px, alpha, lab, W, H, rgba: new Uint8ClampedArray(rgba) };
}
function sampleArt() {
  const c = document.createElement("canvas"); c.width = 1200; c.height = 1200; const g = c.getContext("2d"), S = 1200 / 900; g.scale(S, S);
  // transparent outside the design, like a real PNG, so the garment shows through
  g.save(); g.beginPath(); g.arc(450, 430, 330, 0, Math.PI * 2); g.clip();
  let gr = g.createLinearGradient(0, 100, 0, 620); gr.addColorStop(0, "#1d3f8f"); gr.addColorStop(.45, "#e0457b"); gr.addColorStop(.75, "#f7a21b"); gr.addColorStop(1, "#fff1a8"); g.fillStyle = gr; g.fillRect(0, 0, 900, 900);
  gr = g.createRadialGradient(450, 520, 10, 450, 520, 150); gr.addColorStop(0, "#fffbe6"); gr.addColorStop(.5, "#ffd447"); gr.addColorStop(1, "rgba(255,180,40,0)"); g.fillStyle = gr; g.beginPath(); g.arc(450, 520, 150, 0, Math.PI * 2); g.fill();
  g.fillStyle = "#2b1b3d"; g.beginPath(); g.moveTo(80, 640); g.lineTo(260, 470); g.lineTo(360, 560); g.lineTo(480, 430); g.lineTo(640, 600); g.lineTo(720, 520); g.lineTo(860, 650); g.lineTo(860, 900); g.lineTo(80, 900); g.fill();
  gr = g.createLinearGradient(0, 600, 0, 780); gr.addColorStop(0, "#0f6d6a"); gr.addColorStop(1, "#062b33"); g.fillStyle = gr;
  g.beginPath(); g.moveTo(80, 700); g.bezierCurveTo(260, 640, 420, 720, 600, 670); g.bezierCurveTo(720, 640, 800, 690, 860, 680); g.lineTo(860, 900); g.lineTo(80, 900); g.fill();
  g.strokeStyle = "rgba(255,240,200,.85)"; g.lineWidth = 5; for (let i = 0; i < 6; i++) { g.beginPath(); g.moveTo(330 + i * 10, 700 + i * 18); g.lineTo(570 - i * 10, 700 + i * 18); g.stroke(); }
  g.restore(); g.lineWidth = 14; g.strokeStyle = "#f4f4f0"; g.beginPath(); g.arc(450, 430, 338, 0, Math.PI * 2); g.stroke();
  g.fillStyle = "#f4f4f0"; g.font = "700 92px Helvetica Neue, Helvetica, Arial, sans-serif"; g.textAlign = "center"; g.fillText("MADE HERE", 450, 860); g.fillStyle = "#d8262f"; g.fillRect(250, 872, 400, 10);
  return { rgba: g.getImageData(0, 0, 1200, 1200).data, W: 1200, H: 1200 };
}
/** Framed in an ADN tool page, the page keeps a copy of the art and of each ZIP in the device file manager
    (pillars/tools/SeparationTableProgram.tsx). Standalone, nobody listens. */
function tellPage(type, file, name) {
  if (window.parent !== window) window.parent.postMessage({ type, file, name }, location.origin);
}
async function loadFile(f) {
  if (!f || !/^image\/(png|jpeg|webp)$/.test(f.type)) { setStatus("Use a PNG, JPG or WebP file.", "bad"); return; }
  try {
    const job = st.jobId; setStatus("Reading…"); const buf = await f.arrayBuffer();
    const bmp = await createImageBitmap(new Blob([buf], { type: f.type }), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
    const s = Math.min(1, WORK_MAX / Math.max(bmp.width, bmp.height)), W = Math.round(bmp.width * s), H = Math.round(bmp.height * s);
    const c = document.createElement("canvas"); c.width = W; c.height = H; const g = c.getContext("2d", { colorSpace: "srgb" }); g.drawImage(bmp, 0, 0, W, H);
    const rgba = g.getImageData(0, 0, W, H).data;
    let info = "";
    try {
      const { extractICC, convertToSRGB } = await import("./icc.js"); const icc = await extractICC(buf);
      if (icc) { const r = await convertToSRGB(rgba, icc, $("intent").value); info = r.converted ? `Changed from ${r.name} to sRGB.` : `${r.name}: ${r.reason}.`; }
      else info = "No color profile. Used as sRGB.";
    } catch (e) { info = `Color profile not used (${e.message}).`; }
    if (bmp.width > WORK_MAX || bmp.height > WORK_MAX) info += ` Work size ${W} × ${H} px.`;
    if (job !== st.jobId) return; // another job opened while the file was read
    st.artFile = { name: f.name, W: bmp.width, H: bmp.height, info }; st.sample = false; st.adj = { ...ADJ0 }; st.adjOff = false; renderAdjust(); setArt(rgba, W, H); setStep(2); dropImport(); st.prod.clear(); st.inks = st.inks.filter(i => i.locked); autoSettings(true);
    tellPage("separation:art", f, f.name);
  } catch (e) { setStatus("The image could not be read: " + e.message, "bad"); }
}

/* ───────────── Separation ───────────── */
/** The page's controls as job settings (job.js SETTINGS): the separation, the films and the export all read these. */
function settings() {
  const n = id => +$(id).value, v = id => $(id).value, on = id => !!$(id).checked;
  // a setting with no control on the v1 page (dot shape, DCS, check limits) is its default, whatever a restored job holds
  const lim = id => LATER ? n(id) : CHECK_LIMITS[id][0];
  return { method: methodKey() || st.mode, garment: v("garment"), screens: n("nInks") || 6, widthIn: n("outW"), dpi: n("dpi"), lpi: n("lpi"), angle: n("angle"), dot: LATER ? v("dotShape") : "round", screening: v("screening"), press: v("press"),
    gain: n("gain"), minDot: n("minDot"), maxDot: n("maxDot"), scatter: on("scatter"), choke: n("choke"), trap: n("trap"), indexDpi: n("indexDpi"), stackLimit: n("stackLimit"), inkSource: v("palSrc") === "library" ? "library" : "art",
    forceWhite: v("forceWhite"), underbase: v("ubMode"), ubStrength: n("ubStrength"), opacity: n("opacity"), smooth: n("smooth"), rare: n("rare"), cleanSpot: on("cleanSpot"), solidDetail: on("solidDetail"), shirts: n("shirts"), mirror: v("mirror"), setupMin: n("setupMin"), perHour: n("perHour"),
    fabric: v("fabric"), minPpi: lim("minPpi"), offCentreIn: lim("offCentreIn"), manualMaxLpi: lim("manualMaxLpi"), smallScreenPct: lim("smallScreenPct"),
    formats: { pdf: on("fPDF"), tif: on("fTIF"), png: on("fPNG"), eps: on("fEPS"), svg: on("fSVG"), psd: on("fPSD"), psdPreview: on("fPSDprev"), dcs: LATER && on("fDCS") } };
}
const jobCtx = () => ({ library: st.library, calib: st.calib, targets: st.targets, salience: st.salience });
const garmentLab = () => J.garmentLab(settings());
const needsUB = () => J.needsUB(settings());
const ymodel = () => st.calib ? st.calib.n : 1.7;
function calibratedLab(ink) { const c = st.calib && st.calib.inks[ink.name]; return c ? c.solid : ink.lab; }
function setStatus(t, cls) { const s = $("status"); s.textContent = t; s.className = "small statusline " + (cls || ""); if (busyN) $("busyText").textContent = $("mrBusyText").textContent = t; }
/** A loading mask over the image while it works (separating, Auto, art fixes, drawing films), so a slow step never looks
    like nothing is happening. It shows only after 200 ms (no flash on quick steps), mirrors the status text, and lets
    taps through. Nested work is counted, and it hides a moment after the last one ends so back-to-back steps do not blink. */
let busyN = 0, busyShowT = 0, busyHideT = 0;
/** The loader is the ADN logo. Swap in the animated logo from the motion work by pointing LOADER at it (an animated
    SVG, GIF or WebP, or a WebM / MP4 video) and setting animated: true. Until then the still mark pulses. */
const LOADER = { src: "assets/adn-mark-still.svg", animated: false };
["busyLogo", "busyLogoSm"].forEach(id => { const box = $(id), video = /\.(webm|mp4)$/i.test(LOADER.src), el = document.createElement(video ? "video" : "img");
  el.setAttribute("src", LOADER.src); el.setAttribute("alt", "");
  if (video) { const v = /** @type {HTMLVideoElement} */ (el); v.muted = true; v.loop = true; v.autoplay = true; v.playsInline = true; }
  box.classList.toggle("still", !LOADER.animated); box.append(el); });
// phones: the image may be scrolled off, so the rating row at the bottom also shows the logo and what is happening
function busyShow(on) { $("busyMask").hidden = !on; document.body.classList.toggle("busy", on); }
function busyOn(t) { busyN++; $("busyText").textContent = $("mrBusyText").textContent = t; clearTimeout(busyHideT); if (busyN === 1 && $("busyMask").hidden) { clearTimeout(busyShowT); busyShowT = window.setTimeout(() => { if (busyN) busyShow(true); }, 200); } }
function busyOff() { busyN = Math.max(0, busyN - 1); if (busyN) return; clearTimeout(busyShowT); clearTimeout(busyHideT); busyHideT = window.setTimeout(() => { if (!busyN) busyShow(false); }, 120); }

/** defer: solve only (inks and coverage), for a separation that may be replaced at once; finishDeferred scores the one kept.
    quick: a picture Auto replaces: an empty screen is refilled with the ink search's top (pipeline.refillPick 0), not
    the shelf ink with the best full-size on-press score (one solve per shelf ink: 11 skin's first picture took 27.6 s of CPU, 3.5 s this way). */
async function separate(src, repick, inks, preview = true, defer = false, quick = false) {
  return call({ type: "separate", preview, repick, defer, ...sepParams(src), mode: st.mode, inks, locked: inks.filter(i => i.locked), ...(quick && { refillPick: 0 }) });
}
const finishDeferred = r => r && r.deferred ? call({ type: "finish" }) : r;
/** Everything a separation needs from the controls, shared by Separate and Auto. */
function sepParams(src) { return J.sepModel(settings(), src, jobCtx()); }
/** Auto: the worker picks art type and screen count (pipeline.autoPick), then the normal separation runs with them. */
const MODE_NAME = { sim: "Simulated process", spot: "Spot colors", index: "Index" };
/* Print method (step 3): sim, spot, index are the engines; cmyk and tone (1–3 colors) are methods the worker turns into
   engine settings (pipeline.methodSettings), with standard screen angles on the films (plan.methodAngles). */
const METHOD_NAME = { ...MODE_NAME, cmyk: "CMYK" }, TONE_NAME = ["Grayscale", "Duotone", "Tritone"];
/** The engine method for the current choice: cmyk, mono / duo / tri, or null for sim, spot and index. */
const methodKey = () => st.method === "cmyk" ? "cmyk" : st.method === "tone" ? ["mono", "duo", "tri"][st.tone - 1] : null;
const methodName = () => st.method === "tone" ? TONE_NAME[st.tone - 1] : METHOD_NAME[st.method] || MODE_NAME[st.mode];
/** Methods with standard angles print rotated screens (Demichel overlap); otherwise the Screening setting decides. */
const AUTO_LOCK = false; // Auto tries interlocked screens (see autoSettings); off until their blends stop stepping
const ovp = () => J.overprint(settings());
/** The interlocked note under Screening shows while that screening is chosen. */
function syncLockNote() { $("lockNote").hidden = $("screening").value !== "lock"; }
/** Total ink cap: CMYK holds 240% (Coudray, screen-printed process), never more than the Stack limit setting. */
/** Colour ink limit (base not counted), held inside the allowed range whatever was typed or stored. */
const stackLim = () => J.stackLimit(settings());
/** Show a separation that was already made (and give it back to the worker, which draws the films from it). */
async function putBack(r) {
  if (st.busy) return; st.busy = true; $("run").disabled = true; busyOn("Separating…");
  try { await call({ type: "restore", cov: r.cov, ub: r.ub, W: st.prev.W, H: st.prev.H, mode: st.mode, inks: r.inks, solid: r.solid || null });
    st.placed = null; st.res = r; st.inks = r.inks; st.insp.cx = st.insp.cy = null; st.probe = null; st.hidden.clear(); st.hidRes = null; showStats(); renderOrder(); renderTargets(); renderSummaries(); draw(); renderAccent();
    setStatus(`Updated in ${(r.ms / 1000).toFixed(1)} s`, "ok"); st.why = "";
  } catch (e) { console.error(e); setStatus("Separation failed: " + e.message, "bad"); }
  finally { st.busy = false; $("run").disabled = false; busyOff(); }
}
/** first: show a separation with the current settings at once (new art, a new method, a garment change), then refine. */
async function autoSettings(first = false) {
  if (!st.prev || st.busy) return;
  const tok = st.autoLive = st.autoTok + 1;
  try { await autoWork(first); } finally { if (st.autoLive === tok) st.autoLive = 0; }
}
/** Auto is at work on the open job (its first picture, its trials or its last steps) and nothing stopped it. */
const autoLive = () => !!st.autoLive && st.autoLive === st.autoTok;
async function autoWork(first) {
  applyAuto(null); st.fewer = null;
  const tok = ++st.autoTok; // a newer Auto, or a change by hand while this one works, makes this one stop
  // Auto keeps the print method you picked and tunes the settings inside it. CMYK and 1–3 colors fix their own inks and
  // screen count, so Auto only sets the Advanced values for them. Before you pick a method, Auto suggests one.
  if (st.methodPicked && methodKey()) { st.inks = st.inks.filter(i => i.locked && !i.chosen); await run(true);
    $("autoNote").textContent = `Auto: ${methodName()}. This method sets its own inks and screens; Auto set the film and press settings.`;
    st.autoWhy = null; st.autoBy = true; renderSummaries(); renderAutoState(); return; }
  // A picture at once: the first separation takes a second or two and stays on screen (not masked) while Auto tests
  // its trials on small copies in the background. You can keep working: a change by hand stops this Auto.
  st.autoBy = false; renderAutoState();
  if (first) { await run(true, true, false, true); if (tok !== st.autoTok) return; }
  st.autoRunning = true; $("auto").disabled = true; const say = n => { if (tok === st.autoTok) setStatus(`Auto is refining… ${n ? n + " tried" : ""}`); }; say(0);
  let r;
  // progress: the number of trial separations done (screen counts first, then smoothness and ink mixes)
  try { r = await autoPooled({ ...sepParams(st.prev), ...(st.methodPicked && { autoMethod: st.mode }) }, say, () => tok !== st.autoTok); }
  catch (e) { if (tok === st.autoTok) { st.autoRunning = false; $("auto").disabled = false; setStatus("Auto failed: " + e.message, "bad"); } return; }
  if (!r || tok !== st.autoTok) return; // stopped: the newer work owns the screen
  st.autoRunning = false; $("auto").disabled = false;
  const b = r.best; if (!st.methodPicked) setMethod(b.mode, false); $("mode").querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", String(x.dataset.v === b.mode)));
  // Auto starts fresh: inks you chose with Add ink are cleared (locked shelf inks stay)
  $("nInks").value = String(b.k); applyAuto(b); st.inks = st.inks.filter(i => i.locked && !i.chosen);
  // the mix search's inks are used as found (a plain re-pick would choose by area again)
  if (b.inks) { st.inks = b.inks.map(i => ({ ...i, locked: false })); await run(false); } else await run(true);
  // Auto goes for the best print even when that takes one more screen: an accent the budget cannot carry (see
  // renderAccent) is added, and kept only if the print on press does not get worse
  let accentAdded = null;
  const sg = st.res && st.res.accentSuggest;
  if (sg && b.mode === "sim" && b.k < 12) {
    const before = st.res.stats.robustMean, inks0 = st.inks.slice(), k0 = $("nInks").value, res0 = b.inks ? st.res : null;
    const accent = { name: sg.name, lab: sg.lab.slice(), source: "accent", locked: true, chosen: true, auto: false };
    // Auto's own inks stay: the accent is one screen added to them. A re-pick chose every other ink again by area and
    // could trade Auto's set for one that scores a little better per pixel but builds gradients from inks that keep
    // swapping (the sample's sunset gained a magenta stripe and a pale band that way).
    st.inks = b.inks ? inks0.concat([accent]) : st.inks.filter(i => i.locked).concat([accent]);
    $("nInks").value = String(b.k + 1); st.why = `${sg.name} screen`; await run(!b.inks, false, true);
    if (st.res && st.res.stats.robustMean <= before + 0.1) { accentAdded = { ...sg, before, after: st.res.stats.robustMean }; setStatus(`Updated for the new ${st.why} in ${(st.res.ms / 1000).toFixed(1)} s`, "ok"); st.why = ""; }
    // going back: the separation from before the try is put back as it was (it came from these same inks), not made again
    else { st.inks = inks0; st.why = ""; $("nInks").value = k0; if (res0) await putBack(res0); else await run(false); }
  }
  // Interlocked screens print two inks side by side instead of stacking them: cleaner blends, but only a press that
  // holds registration keeps the tiles fitting, and two inks per spot mix fewer colours. Model scores on 17 real images
  // (Auto choosing inks for each way): interlocked won on 6 of the 9 black-shirt prints on an Automatic press and on no
  // white-shirt print, and on none on a Manual press. So on an Automatic press with an underbase, Auto also searches
  // inks for interlocked screens and keeps them if the print on press (drift included) gets better.
  // Off for now (AUTO_LOCK): a gradient audit (skin, sunset, gray ramps) still shows steps of up to 1.6 ΔE where the
  // interlocked ink pairs hand over, and the print-on-press score does not see steps, so Auto could choose a stepped
  // print. Interlocked stays a choice by hand.
  let lockKept = false, lockK = 0;
  if (AUTO_LOCK && b.mode === "sim" && !methodKey() && $("press").value === "automatic" && needsUB() && st.src.screening === "auto" && st.res && tok === st.autoTok) {
    const before = st.res.stats.robustMean, res0 = st.res, inks0 = st.inks.slice(), k0 = $("nInks").value;
    st.autoRunning = true; $("auto").disabled = true; say(0);
    let r2 = null; try { r2 = await autoPooled({ ...sepParams(st.prev), overprint: "lock" }, say, () => tok !== st.autoTok); } catch (e) { console.error(e); }
    if (tok !== st.autoTok) return; st.autoRunning = false; $("auto").disabled = false;
    const b2 = r2 && r2.best;
    if (b2 && b2.mode === "sim") {
      $("screening").value = "lock"; $("nInks").value = String(b2.k); st.inks = b2.inks ? b2.inks.map(i => ({ ...i, locked: false })) : st.inks.filter(i => i.locked && !i.chosen);
      st.why = "interlocked screens"; await run(!b2.inks, false, true); if (tok !== st.autoTok) return;
      if (st.res && st.res.stats.robustMean < before - 0.05) { lockKept = true; lockK = b2.k; setStatus(`Updated for interlocked screens in ${(st.res.ms / 1000).toFixed(1)} s`, "ok"); st.why = ""; }
      else { $("screening").value = "same"; st.inks = inks0; $("nInks").value = k0; st.why = ""; await putBack(res0); }
    }
    syncLockNote();
  }
  // Print order per job: dark-first stays unless moving an ink that fades out at the stack limit later
  // prints clearly better, on a small copy and then at full size (autoOrder). The order shows on the colour cards; a drag by hand turns Auto off.
  const order = b.mode === "sim" && !methodKey() && st.res && tok === st.autoTok ? await autoOrder(tok, say) : null;
  if (tok !== st.autoTok) return;
  const more = r.rows.filter(x => x.mode === b.mode && x.screens > b.screens).sort((x, y) => x.screens - y.screens)[0];
  const why = b.mode === "index" ? `${b.k} colors give the best print for the number of screens.` : b.mode === "spot" ? `The art has ${b.k} flat color${b.k > 1 ? "s" : ""}${r.flat.inks < r.flat.K ? " and the garment color" : ""}. Each color gets one solid screen. Mix each ink to match the art.`
    : b.search && b.search.screens !== b.search.startScreens ? `${b.k} color screens give the best print for the number of screens. The ink mix search changed ${b.search.startScreens} screens to ${b.search.screens}${b.search.startScreens > USUAL_SCREENS && b.search.screens <= USUAL_SCREENS ? `: past ${USUAL_SCREENS} screens, a screen must improve the press score by more than ${2 * SCREEN_COST} ΔE` : ""}.`
    : `${b.k} color screens give the best print for the number of screens.${more ? (b.robust - more.robust >= 0.05 ? ` ${more.inks} screens improve the score by only ${(b.robust - more.robust).toFixed(1)}. That is not sufficient for one more screen.` : " More screens do not make it better.") : ""}`;
  const kShown = lockKept ? lockK : accentAdded ? b.k + 1 : b.k;
  $("autoNote").textContent = `Auto${st.methodPicked ? ", best settings for" : ":"} ${MODE_NAME[b.mode]}, ${kShown} screen${kShown > 1 ? "s" : ""}. ${why.replace(/^\d+ color screens give the best print for the number of screens\.\s*/, "")}`.trim()
    + (lockKept ? " Screens interlock: two inks per spot side by side, which prints better on this press and shirt." : "")
    + (accentAdded ? ` Then Auto added screen ${kShown} for ${accentAdded.name} (${(accentAdded.area * 100).toFixed(accentAdded.area >= 0.01 ? 0 : 1)}% of the art), which had no ink: its color error goes from ${accentAdded.accentBefore.toFixed(0)} to ${accentAdded.accentAfter.toFixed(0)}.` : "")
    + (order && order.kept ? ` ${order.kept.name} prints after ${order.kept.after} so ${order.kept.name} fades out without an edge. The score with press movement goes from ${order.kept.before.toFixed(2)} to ${order.kept.after2.toFixed(2)}.` : "");
  st.autoWhy = { rows: r.rows, best: b, flat: r.flat, why, order }; st.autoBy = true;
  st.fewer = fewerOptions(r, b, lockKept || accentAdded ? null : b); renderSummaries(); renderAutoState();
}
/* Fewer screens. Auto is not capped, but a shop that wants fewer screens can have them. Each
   screen costs the printer a screen, a setup and a press head, so Auto's note lists what fewer screens would rate, one
   tap each. The ratings come from Auto's own trials on its small test copy, no extra separation: the ink mix search
   keeps the best mix it rated at each screen count (pipeline best.byScreens); without the search (art inks, Spot,
   Index) the screen-count trials rated each count with inks picked again. The list holds while the art, the method
   and the settings are the ones Auto used and the inks are Auto's or one of the listed mixes (fewerShown). */
const FEWER_MAX = 3;
const fewerSig = () => JSON.stringify({ ...sepParams(st.prev), px: 0, alpha: 0, lab: 0, library: 0, k: 0, mode: st.mode, method: methodKey() });
const mixKey = inks => inks.map(i => i.name).slice().sort().join("|");
/** trial: Auto's pick as its trials rated it (null after an added accent or interlocked screens: then its count and
    inks are not a trial's, so it gets no trial rating). */
function fewerOptions(r, b, trial) {
  if (methodKey() || !st.res) return null;
  const autoScreens = st.inks.length + (st.res.ub ? 1 : 0), by = new Map();
  if (b.byScreens) { for (const [n, v] of Object.entries(b.byScreens)) by.set(+n, { screens: +n, stars: v.stars, press: v.press, inks: v.inks.map(i => ({ ...i, locked: false })) }); }
  else for (const x of r.rows) if (x.mode === b.mode && x.stars != null && (x.sal ?? 1) === (b.sal ?? 1)) { const o = by.get(x.screens); if (!o || x.stars > o.stars) by.set(x.screens, { screens: x.screens, stars: x.stars, press: x.robust, k: x.k }); }
  const own = trial && by.get(autoScreens);
  let opts = [...by.values()].filter(o => o.screens < autoScreens).sort((x, y) => y.screens - x.screens);
  // past the usual limit the list reaches down to it (11 → 10, 9); otherwise the next counts down
  if (opts.length > FEWER_MAX) { const usual = opts.find(o => o.screens === USUAL_SCREENS); opts = opts.slice(0, FEWER_MAX); if (usual && autoScreens > USUAL_SCREENS && !opts.includes(usual)) opts[FEWER_MAX - 1] = usual; }
  if (!opts.length) return null;
  return { opts, autoScreens, autoStars: own ? own.stars : null, autoPress: own ? own.press : null, autoK: +$("nInks").value, autoInks: st.inks.slice(), autoRes: st.res, prev: st.prev, sig: fewerSig(), cur: null };
}
const fmtStars = s => Math.max(1, Math.min(5, s)).toFixed(1);
/** The list shows only while it still describes the job: same art and settings, and the inks are Auto's or a listed mix. */
function fewerShown() {
  const f = st.fewer; if (!f || f.prev !== st.prev || !st.res || methodKey() || fewerSig() !== f.sig) return false;
  if (f.cur == null) return mixKey(st.inks) === mixKey(f.autoInks);
  // a listed count, as its separation came out (the full-size run can drop an ink that prints nothing)
  const o = f.opts.find(x => x.screens === f.cur); return !!o && (o.got == null || mixKey(st.inks) === o.got);
}
function renderFewer() {
  const el = $("fewerNote"), show = fewerShown(); el.hidden = !show; if (!show) return;
  // stars stop at 1 and 5, so the colour error (on press, lower is better) goes with them: hard art all rates 1.0
  const f = st.fewer, auto = f.autoStars != null ? `Auto's ${f.autoScreens} screens rate ${fmtStars(f.autoStars)} stars, color error ${f.autoPress.toFixed(1)}, on its small test copy.` : `Auto picked ${f.autoScreens} screens.`;
  $("fewerText").textContent = f.cur == null
    ? `Fewer screens cost less to print (screens, setup, press heads). ${auto} With fewer screens:`
    : `You picked ${f.cur} screens. ${auto}`;
  const btns = f.opts.map(o => { const b = document.createElement("button"); b.type = "button"; const sub = `${fmtStars(o.stars)} stars · error ${o.press.toFixed(1)}`; b.innerHTML = `${o.screens} screens<span class="fsub">${sub}</span>`; b.setAttribute("aria-label", `${o.screens} screens, ${sub}`);
    b.setAttribute("aria-pressed", String(f.cur === o.screens)); b.dataset.screens = String(o.screens); b.onclick = () => useFewer(o); return b; });
  if (f.cur != null) { const b = document.createElement("button"); b.type = "button"; b.textContent = `Auto's ${f.autoScreens} screens`; b.dataset.screens = "auto"; b.onclick = () => useFewer(null); btns.push(b); }
  $("fewerBtns").replaceChildren(...btns);
}
/** One tap: separate with that count's inks (or Auto's again). A count you pick is your choice, so Auto is off until
    you go back to Auto's pick, which is shown again as it was (no new separation). */
async function useFewer(o) {
  const f = st.fewer; if (!f || st.busy || (o ? f.cur === o.screens : f.cur == null)) return;
  if (!o) { $("nInks").value = String(f.autoK); f.cur = null; st.autoBy = true; await putBack(f.autoRes); renderAutoState(); return; }
  f.cur = o.screens; st.autoBy = false; st.why = "screen count";
  if (o.inks) { $("nInks").value = String(o.inks.length); st.inks = o.inks.map(i => ({ ...i })); await run(false); }
  else { $("nInks").value = String(o.k); st.inks = st.inks.filter(i => i.locked && !i.chosen); await run(true); }
  if (st.fewer === f && f.cur === o.screens) o.got = mixKey(st.inks);
  renderAutoState(); renderFewer();
}
/** Auto's print-order step (pipeline.orderPlan): an ink that fades out at the stack limit is tried later in the order
    on a small copy; the best move, if it beats dark-first there by ORDER_GAIN on press and in the Print view, is
    separated at full size and kept only if both beat dark-first by ORDER_GAIN again (the small copy can blur away a
    band the full-size Print view shows: the 18 grey ramp test image).
    Returns { start, tries, kept } (kept: null when dark-first stays), or null when stopped or failed. */
const viewError = r => call({ type: "reproof", probe: true, ...sepParams(st.prev), mode: st.mode, inks: r.inks, cov: r.cov, printView: true }).then(x => x.viewMean);
async function autoOrder(tok, say) {
  const res0 = st.res, inks0 = st.inks.slice(), before = res0.stats.robustMean;
  st.autoRunning = true; $("auto").disabled = true; say(0);
  let p = null; try { p = await pooled(sepParams(st.prev), [ORDER_SIZE], orderPlan({ mode: st.mode }, inks0), say, () => tok !== st.autoTok); } catch (e) { console.error(e); }
  if (tok !== st.autoTok) return null; st.autoRunning = false; $("auto").disabled = false;
  // nothing to try at full size: the separation on screen stays, and so does its notice
  if (!p || !p.best) { setStatus(`Updated in ${(res0.ms / 1000).toFixed(1)} s`, "ok"); return p ? { ...p, kept: null } : null; }
  st.inks = p.best.inks.map(i => ({ ...i })); st.why = "print order"; await run(false, false, true); if (tok !== st.autoTok) return null;
  const after = st.res ? st.res.stats.robustMean : Infinity;
  let v0 = NaN, v1 = NaN; if (st.res && after <= before * (1 - ORDER_GAIN)) { try { [v0, v1] = [await viewError(res0), await viewError(st.res)]; } catch (e) { console.error(e); } }
  if (tok !== st.autoTok) return null;
  if (after <= before * (1 - ORDER_GAIN) && v1 <= v0 * (1 - ORDER_GAIN) && st.res.inks.map(i => i.name).join("|") === p.best.inks.map(i => i.name).join("|")) {
    setStatus(`Updated for the new print order in ${(st.res.ms / 1000).toFixed(1)} s`, "ok"); st.why = "";
    return { ...p, kept: { name: p.best.name, after: p.best.after, before, after2: after, view: [v0, v1] } };
  }
  st.inks = inks0; st.why = ""; await putBack(res0); return { ...p, kept: null, full: after, view: [v0, v1] };
}
/** "Why Auto chose this": [+] on the right of the "Updated" notice opens Auto's reasoning in the notice: how it decides, every
    option it tried and its scores (the winner marked), the tonal smoothness it tried, and what it set in Advanced. */
function renderAutoWhy() {
  const w = st.autoWhy, tog = $("awTog"), on = !!(st.autoBy && w); tog.hidden = !on; $("awBody").hidden = !on || !st.whyOpen; if (!on) return;
  tog.setAttribute("aria-expanded", String(st.whyOpen)); tog.textContent = st.whyOpen ? "[−]" : "[+]";
  if (!st.whyOpen) return;
  const b = w.best, lpi = +$("lpi").value, mesh = meshFor(lpi), press = $("press").value;
  const rows = w.rows.slice().sort((x, y) => x.mode === y.mode ? x.screens - y.screens : x.mode === "spot" ? -1 : 1);
  const SHORT = { sim: "Photo", spot: "Flat", index: "Pixel" };
  const tbl = `<table class="awtbl"><thead><tr><th>Type</th><th>Colors</th><th>Model ΔE</th><th>Aligned</th><th>Score</th></tr></thead><tbody>${rows.map(x => { const win = x.mode === b.mode && x.screens === b.screens && x.robust === b.robust;
    return `<tr${win ? ' class="win"' : ""}><td>${win ? "✓ " : ""}${SHORT[x.mode]}</td><td>${x.inks}</td><td>${x.robust.toFixed(2)}</td><td>${x.mean.toFixed(2)}</td><td>${x.score.toFixed(2)}</td></tr>`; }).join("")}</tbody></table>
    <p class="small">Colors: color screens (the underbase is extra). Model ΔE: a model number, with the screens moving on press. Aligned: with perfect registration. Score: model ΔE + 0.3 per screen; lowest wins.</p>`;
  const sm = b.smoothTries ? `<p><b>Tonal smoothness:</b> ${b.smoothTries.map(t => `${Math.round(t.sm * 100)}% → ${t.s.toFixed(2)}`).join(", ")} on model ΔE. Auto keeps 10% unless another is clearly better (by more than 0.02): it picked ${Math.round((b.smooth ?? 0.1) * 100)}%.</p>` : "";
  $("awBody").innerHTML = `<p><b>Picked:</b> ${MODE_NAME[b.mode]}, ${b.k} color screen${b.k > 1 ? "s" : ""}${b.smooth != null ? `, tonal smoothness ${Math.round(b.smooth * 100)}%` : ""}. ${esc(w.why)}</p>
    <p><b>How Auto decides:</b> it separates a small copy of the art in each way below and scores the print with press movement (ΔE00, 0 is exact, lower is better). Each screen costs 0.3 in the score, so a screen is added only when it improves the print by more than that. ${st.methodPicked ? `You picked ${MODE_NAME[b.mode]}, so Auto tries only ${MODE_NAME[b.mode]} and picks the screen count and settings for it.` : w.flat && w.flat.flat ? `The art looks flat (${w.flat.K} colors cover almost all of it), so solid screens win when they are within 1.0 of the best halftone score: they are cleaner and easier to print.` : "The art has gradients or many colors, so only halftone separations are tried."}</p>
    ${tbl}${sm}
    ${w.order && w.order.start != null ? `<p><b>Print order:</b> inks print dark to light. Where an ink fades out in an area with a full stack of ink, it can end in an edge, because it prints first. Auto tries such an ink later in the order on a small copy and keeps the new order only if the score with press movement and the Print view are both ${Math.round(ORDER_GAIN * 100)}% better there and at full size. ${w.order.fades.length ? `Fades tested: ${w.order.fades.map(x => esc(x.name)).join(", ")}. Dark to light: ${w.order.start.toFixed(2)}; ${w.order.tries.map(t => `${esc(t.name)} after ${esc(t.after)}: ${t.s.toFixed(2)}`).join("; ")}.` : "No ink fades out in a full stack."} ${w.order.kept ? `Kept: ${esc(w.order.kept.name)} after ${esc(w.order.kept.after)}.` : "The order stays dark to light."}</p>` : ""}
    ${b.search ? `<p><b>Ink mix search:</b> from the ${b.search.pool.length} shelf inks that cover the art best (${esc(b.search.pool.join(", "))}), Auto tested ${b.search.evals} mixes (add, remove or swap one ink at a time) and kept the best: ${b.search.startStars.toFixed(2)} → ${b.search.stars.toFixed(2)} stars, ${b.search.startScreens} → ${b.search.screens} screens. A mix with one more screen must improve the press score by more than ${SCREEN_COST} ΔE, and by more than ${2 * SCREEN_COST} past ${USUAL_SCREENS} screens (underbase included), the usual most a shop prints.</p>` : ""}
    <p><b>Advanced, set by Auto:</b> smallest dot ${$("minDot").value}% (what ${mesh} mesh holds at ${lpi} LPI) · trap ${$("trap").value} mm (${press} press) · ink opacity ${Math.round(+$("opacity").value * 100)}% (${st.calib && st.calib.opacity != null ? "from your calibration" : "typical plastisol, not calibrated"}) · inks from ${$("palSrc").value === "art" ? "the artwork (mixed to match)" : "your ink library"}. Everything else is the standard value.</p>`;
}
$("awTog").addEventListener("click", () => { st.whyOpen = !st.whyOpen; renderAutoWhy(); });
async function cleanIfSpot(r, src) {
  try { return await J.cleanSpot(settings(), jobCtx(), r, src, m => call({ type: "reproof", ...m })); }
  catch (e) { $("prepStatus").textContent = "Spot edge cleanup unavailable: " + e.message; return r; }
}
/** trial: a separation Auto may still drop (the accent try): it does not say "Updated", Auto is still at work.
    quick: Auto's first picture, which its result replaces (see separate). */
async function run(repick = true, fromAuto = false, trial = false, quick = false) {
  if (!st.prev || st.busy) return;
  if (st.imp) return reproofImport();
  // a separation started by hand while Auto refines wins: that Auto stops (its trials are dropped)
  if (st.autoRunning && !fromAuto) { st.autoTok++; st.autoRunning = false; $("auto").disabled = false; }
  st.busy = true; $("run").disabled = true; busyOn("Separating…"); setStatus("Separating…");
  try {
    const keep = repick ? st.inks.filter(i => i.locked) : st.inks;
    // An added ink (halftones, shelf inks) is followed by the mix search and the print-order check, and either can
    // replace this separation. Until the last one, only inks and coverage are worked out; the one that is kept is
    // then scored and drawn (the same result as scoring each).
    const defer = repick && st.mode === "sim" && $("palSrc").value === "library" && keep.some(k => k.chosen);
    let r = await separate(st.prev, repick, keep, true, defer, quick);
    r = await cleanIfSpot(r, st.prev);
    // Inks the user chose (Add ink) go where they print best, not where the lightness sort puts them: each is tried at
    // every place in the print order on a small copy and the lowest press ΔE wins (kite + Orange: 6.82 → 2.52).
    st.placed = null;
    // an added ink: search the whole mix around it (add / remove / swap shelf inks for the best rating), then place it
    if (repick && r.inks.some(k => k.chosen) && st.mode === "sim" && $("palSrc").value === "library") {
      busyOn("Testing ink mixes around your ink…"); setStatus("Testing ink mixes around your ink…");
      try { const chosen = r.inks.filter(k => k.chosen), sp = { ...sepParams(st.prev), mode: st.mode, locked: chosen }, sr = await pooled(sp, [160], searchPlan(sp, r.inks));
        st.searched = { stars: sr.stars, startStars: sr.startStars, evals: sr.evals };
        const inks = sr.inks.map(k => chosen.find(c => c.name === k.name) || { ...k, locked: false });
        if (inks.map(k => k.name).join("|") !== r.inks.map(k => k.name).join("|")) { r = await separate(st.prev, false, inks, true, defer, quick); r = await cleanIfSpot(r, st.prev); }
      } finally { busyOff(); } }
    if (repick && r.inks.some(k => k.chosen)) {
      busyOn("Finding the best print order…"); setStatus("Finding the best print order…");
      try { const keys = r.inks.filter(k => k.chosen).map(k => k.name), p = await call({ type: "placement", ...sepParams(st.prev), mode: st.mode, inks: r.inks, keys });
        st.placed = { keys, tries: p.tries, inks: p.inks.map(k => k.name) };
        if (p.inks.map(k => k.name).join("|") !== r.inks.map(k => k.name).join("|")) { r = await separate(st.prev, false, p.inks, true, false, quick); r = await cleanIfSpot(r, st.prev); }
      } finally { busyOff(); } }
    r = await finishDeferred(r); r.lock = ovp() === "lock"; // made with interlocked screens (switching in or out separates again)
    st.res = r; st.inks = r.inks; st.insp.cx = st.insp.cy = null; st.probe = null; st.hidden.clear(); st.hidRes = null; showStats(); renderOrder(); renderTargets(); renderSummaries(); draw();
    renderAccent();
    if (trial) setStatus(`Auto is refining… trying a ${st.why}`); else { setStatus(`Updated${st.why ? " for the new " + st.why : ""} in ${(r.ms / 1000).toFixed(1)} s`, "ok"); st.why = ""; }
    if (st.placed) { const pl = st.placed, notes = pl.keys.map(k => { const t = pl.tries.filter(x => x.name === k); if (t.length < 2) return ""; const b = t.reduce((a, x) => x.s < a.s ? x : a), w = t.reduce((a, x) => x.s > a.s ? x : a);
        return w.s - b.s < 0.1 ? `${k} prints about the same in any place in the print order; it goes ${b.pos === 1 ? "first" : "as color screen " + b.pos}.`
          : `${k} prints ${b.pos === 1 ? "first" : "as color screen " + b.pos}: the best place in the print order (press ΔE ${b.s.toFixed(1)}; worst place ${w.s.toFixed(1)}).`; }).filter(Boolean);
      $("dropNote").textContent = notes.join(" "); $("dropNote").hidden = !notes.length; }
  } catch (e) { console.error(e); setStatus("Separation failed: " + e.message, "bad"); }
  finally { st.busy = false; $("run").disabled = false; busyOff(); noteState(); }
}
/* A colour the art needs (a red stripe, a green stem) that no screen in this budget can print without harming the rest:
   the engine measured one more screen for it. The screen count is yours (a screen costs money), so it is offered, not
   added. One tap adds the ink, held to its own hue, plus one screen.
   Where it shows: the dashed [+] at the left end of the screens row (in place of the "Screens" label) says a screen is
   suggested; pushing it opens one row for each suggestion above the screens row (st.sugOpen), with the ink's color, the
   reason and the add button. */
/* Line work in a colour no ink matches prints as its nearest ink, solid (clean, but that ink's colour). One more screen
   in its own colour prints it flat and exact; offered, not added (a screen costs money). */
function renderLineNote() {
  const sg = st.res && st.res.lineSuggest, el = $("lineNote"), show = !!sg && st.mode === "sim" && !methodKey() && $("solidDetail").checked;
  el.hidden = !show || !st.sugOpen; if (!show) return "";
  $("lineSw").style.background = rgb2hex(lab2rgb(sg.lab));
  const pct = sg.area * 100, area = pct >= 1 ? `${Math.round(pct)}%` : `${pct.toFixed(1)}%`;
  $("lineText").textContent = `${sg.name} line work (${area} of the art) has no ink, so it prints as solid ${sg.asInk}. A ${sg.name} screen prints it flat in its own color: its color error goes from ${sg.before.toFixed(0)} to under 4.`;
  const b = $("lineAdd"); b.textContent = `Add a ${sg.name} screen`; b.disabled = +$("nInks").value >= 12;
  // the inks you have stay as they are: this is one screen added to them, not a new pick
  // (it goes before a highlight white, which keeps printing last)
  b.onclick = () => { const ink = { name: sg.name, lab: sg.lab.slice(), source: "line", locked: true, chosen: true }, hl = st.inks.findIndex(i => i.lab[0] > 92);
    st.inks = hl < 0 ? st.inks.concat([ink]) : [...st.inks.slice(0, hl), ink, ...st.inks.slice(hl)];
    $("nInks").value = String(Math.min(12, st.inks.length)); st.why = `${sg.name} screen`; st.sugOpen = false; run(false); };
  return sg.name;
}
function renderAccent() {
  const sg = st.res && st.res.accentSuggest, el = $("accentNote"), show = !!sg && st.mode === "sim" && !methodKey();
  const names = [show ? sg.name : "", renderLineNote()].filter(Boolean), tog = $("sugTog");
  if (!names.length) st.sugOpen = false; // nothing suggested: the rows start closed the next time something is
  $("scrLab").hidden = !!names.length; tog.hidden = !names.length;
  tog.setAttribute("aria-expanded", String(st.sugOpen)); tog.title = `Suggested screen: ${names.join(", ")}`; tog.setAttribute("aria-label", tog.title);
  el.hidden = !show || !st.sugOpen; if (!show) return;
  $("accentSw").style.background = rgb2hex(lab2rgb(sg.lab));
  const pct = sg.area * 100, area = pct >= 1 ? `${Math.round(pct)}%` : `${pct.toFixed(1)}%`;
  $("accentText").textContent = `${st.autoBy && st.inks.some(i => i.source === "accent") ? "Optional: " : ""}${sg.name} (${area} of the art) has no ink. One more screen prints it: its color error goes from ${sg.accentBefore.toFixed(0)} to ${sg.accentAfter.toFixed(0)}.`;
  const b = $("accentAdd"); b.textContent = `Add a ${sg.name} screen`; b.disabled = +$("nInks").value >= 12;
  b.onclick = () => { st.inks = st.inks.filter(i => i.locked).concat([{ name: sg.name, lab: sg.lab.slice(), source: "accent", locked: true, chosen: true }]);
    $("nInks").value = String(Math.min(12, +$("nInks").value + 1)); st.why = `${sg.name} screen`; st.sugOpen = false; run(true); };
}
$("sugTog").addEventListener("click", () => { st.sugOpen = !st.sugOpen; renderAccent(); });
function showStats() {
  const s = st.res.stats, N = st.inks.length;
  $("sScreens").textContent = N + (st.res.ub ? 1 : 0); $("sMean").textContent = s.mean.toFixed(1); $("sMean").title = `95th percentile ${s.p95.toFixed(1)} · median ${s.median.toFixed(1)}`;
  $("sDrift").textContent = s.robustMean.toFixed(1); $("sDrift").title = `95th percentile ${s.robustP95.toFixed(1)}`;
  $("sNeutral").textContent = s.neutralMean.toFixed(1); $("sNeutral").title = `Neutral median ${s.neutralMedian.toFixed(1)} · 95th ${s.neutralP95.toFixed(1)}`;
  const dn = $("dropNote"), notes = [];
  if (st.res.dropped && st.res.dropped.length) notes.push(`Separation Table removed ${st.res.dropped.join(", ")}. It printed almost no ink.`);
  if (s.stackP99 > stackLim() + 0.05) notes.push(`In some areas, the ink is ${Math.round(s.stackP99 * 100)}%. Your limit is ${$("stackLimit").value}%. These areas can feel heavy and need more flash time.`);
  dn.hidden = !notes.length; dn.textContent = notes.join(" ");
  const w2 = s.cmcWithin2, pct = Math.round(w2 * 100), cls = w2 >= 0.85 ? "ok" : w2 >= 0.6 ? "warn" : "bad", word = w2 >= 0.85 ? "Press ready" : w2 >= 0.6 ? "Review" : "Add inks";
  $("sCmc").innerHTML = `${pct}% <span class="pill ${cls}">${word}</span>`;
  if (!st.calib) $("sCmc").title = "Measured against an uncalibrated print model. Calibrate to make this a press number.";
  // Result box in ASD-STE100: a headline, then short labeled lines. Judged on the press-drift (robust) score.
  const r = s.robustMean, vw = $("verdictWord"), press = $("press").value, rows = [];
  const level = r < 2 ? ["Very close match", "ok"] : r < 4 ? ["Small differences", "warn"] : ["Large differences", "bad"];
  vw.textContent = level[0]; $("verdict").className = "verdict " + level[1];
  rows.push(["Score", `${r.toFixed(1)} with press movement. ${s.mean.toFixed(1)} with perfect alignment. 0 is exact.`]);
  const costs = st.res.costs || [], cheap = costs.map((c, i) => [c, i]).filter(([c, i]) => c < 0.25 && !(st.inks[i] && st.inks[i].locked)).sort((a, b) => a[0] - b[0])[0];
  if (cheap && N > 2) rows.push(["Fix", `Remove the ${st.inks[cheap[1]].name} screen. The print stays almost the same. Push − next to Color screens.`]);
  else if (r >= 4 && r - s.mean > 2) { rows.push(["Cause", `The screens move on the ${press} press. The inks are correct.`]);
    rows.push(["Fix", `Align the screens tightly${press === "manual" ? ", or use an automatic press" : ""}. More screens do not help.`]); }
  else if (r >= 4 && st.mode === "sim" && N >= 8) { rows.push(["Cause", "The art has many flat areas."]); rows.push(["Fix", "Select Flat colors, or push Auto settings."]); }
  else if (r >= 4 && N < 12) { rows.push(["Cause", "The inks cannot make all the colors in the art."]); rows.push(["Fix", "Add one screen. Push + next to Color screens."]); }
  else if (r < 2) rows.push(["Next", "Download the films."]);
  else rows.push(["Next", "Turn on Show differences. If the bright areas are important, add one screen."]);
  if (!st.calib) rows.push(["Note", "Typical plastisol values. For exact values, calibrate your press in Shop setup."]);
  $("verdictText").innerHTML = `<dl class="vrows">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`;
  renderRating();
}

/* ───────────── Views ───────────── */
const NOTES = {
  orig: "Your artwork on the garment color.",
  sim: "This is the print that these screens make on the garment.",
  split: "Left of the line: your artwork. Right: the dots on the films, every screen in print order, each ink at full strength (as Photoshop shows spot channels). Drag the line to compare.",
  chan: "This is the separation for one screen. Black is ink. Click a swatch to see a different screen.",
  stack: "Stack: how much color ink lands on each spot (the base not counted). Blue is light, green to yellow nears your ink limit, red is over it: heavy ink that needs more flash and feels thick.",
  film: "Print: the real films that go to the RIP, dot by dot. All shows every screen's dots on the garment in print order, each ink at full strength. Tap a color card in Separation to see one film: black is ink.",
};
function draw() {
  if (st.pressOn && st.res && st.pressRes !== st.res) { st.pressRes = st.res; pressStep(st.pressK || 0); return; }
  const v0 = st.view; $("zoomBox").hidden = v0 !== "film" || !st.res; paintBackdrop(); renderScreens(); renderSummaries();
  const p = st.prev; if (!p) { const cv = $("view0"); cv.width = 600; cv.height = 600; cv.getContext("2d").clearRect(0, 0, 600, 600); $("viewNote").textContent = ""; return; }
  // Print with the Compare or Show differences toggles on draws the split or the difference map
  const v = v0 === "sim" ? (st.compare ? "split" : "sim") : v0;
  $("viewNote").textContent = (NOTES[v] || "") + (st.hidden.size && v0 === "sim" ? " Some screens are hidden: the preview shows the print without them." : "") + (st.calib || v === "orig" || v === "split" || v === "film" ? "" : " The model is not calibrated yet.") + (st.mark && (v === "orig" || v === "sim") ? ` Marked: ${st.mark.what}, in the red box. Tap Hide on the check to clear it.` : "");
  if (st.pressOn && v === "sim") $("viewNote").textContent = `Press: the print on the garment after screen ${st.pressK || 1}, with the screens printed so far. ◀ and ▶ step through the screens.`;
  if (v === "film" && !st.res) { const cv = $("view0"); cv.classList.remove("zoomed"); cv.style.width = ""; cv.style.transform = ""; drawFlat("orig"); return; }
  if (v === "film") { $("viewNote").textContent += st.mode === "index" ? " These films have no halftone dots. Each square is solid ink or no ink. The eye mixes the squares." : st.mode === "spot" ? " These films are solid shapes. They have no halftone dots." : ""; drawInspect(); return; }
  const cv = $("view0"); cv.classList.remove("zoomed"); cv.style.width = ""; cv.style.imageRendering = ""; cv.style.transform = "";
  // Compare: the art left of the line, the real film dots right of it (no print model). The films are drawn once per
  // separation and size; dragging the line only redraws the art side.
  if (v === "split" && st.res) { if (cmpFresh()) composeCompare(); else drawInspect(true); return; }
  drawFlat(v);
}
/** The Compare films are current: same separation, hidden screens and box size. */
function cmpKey() { const b = $("view0").parentElement; return `${Math.max(200, b.clientWidth)}x${Math.max(200, b.clientHeight)}|${[...st.hidden].sort().join(",")}|${window.devicePixelRatio || 1}`; }
function cmpFresh() { const f = st.cmpFilm; return !!f && f.res === st.res && f.key === cmpKey(); }
function composeCompare() {
  const f = st.cmpFilm, p = st.prev, cv = $("view0"); if (!f || !p) return;
  cv.width = f.img.width; cv.height = f.img.height; const g = cv.getContext("2d"); g.putImageData(f.img, 0, 0);
  if (!st.artCv || st.artCv.src !== p || st.artCv.gar !== $("garment").value) { const a = document.createElement("canvas"); a.width = p.W; a.height = p.H; const ag = a.getContext("2d"), id = ag.createImageData(p.W, p.H), d = id.data, gar = hex2rgb($("garment").value);
    for (let q = 0; q < p.W * p.H; q++) { const al = p.alpha[q] / 255; for (let c = 0; c < 3; c++) d[q * 4 + c] = p.px[q * 3 + c] * al + gar[c] * (1 - al); d[q * 4 + 3] = 255; }
    ag.putImageData(id, 0, 0); st.artCv = { cv: a, src: p, gar: $("garment").value }; }
  // the film box covers film pixels [x0, x0 + w) × [y0, y0 + h): the same part of the art goes on the left of the line
  const sx = Math.round(cv.width * st.splitX), ax = f.x0 / f.Wp * p.W, ay = f.y0 / f.Hp * p.H, aw = f.w / f.Wp * p.W, ah = f.h / f.Hp * p.H;
  g.imageSmoothingEnabled = true; g.drawImage(st.artCv.cv, ax, ay, aw * st.splitX, ah, 0, 0, sx, cv.height);
  const s = Math.max(1, cv.width / 600); g.fillStyle = "#94a3d6"; g.fillRect(sx - s, 0, 3 * s, cv.height); g.fillStyle = "#ffffff"; g.fillRect(sx - 9 * s, (cv.height >> 1) - 15 * s, 18 * s, 30 * s); g.strokeStyle = "#001089"; g.lineWidth = s; g.strokeRect(sx - 9 * s, (cv.height >> 1) - 15 * s, 18 * s, 30 * s);
  cv.style.transform = ""; cv.style.imageRendering = "auto"; cv.style.width = f.cssW;
}
function drawFlat(v, cv = $("view0")) {
  const p = st.prev;
  cv.width = p.W; cv.height = p.H; const g = cv.getContext("2d"), id = g.createImageData(p.W, p.H), d = id.data, P = p.W * p.H, N = st.inks.length, gar = hex2rgb($("garment").value);
  if (v === "orig" || v === "split" || !st.res) for (let q = 0; q < P; q++) { const a = p.alpha[q] / 255; for (let c = 0; c < 3; c++) d[q * 4 + c] = p.px[q * 3 + c] * a + gar[c] * (1 - a); d[q * 4 + 3] = 255; }
  const sx = Math.round(p.W * st.splitX);
  if (st.res && (v === "sim" || v === "split")) { const s = (st.hidRes || st.res).img; for (let y = 0; y < p.H; y++) for (let x = v === "split" ? sx : 0; x < p.W; x++) { const q = y * p.W + x; d[q * 4] = s[q * 4]; d[q * 4 + 1] = s[q * 4 + 1]; d[q * 4 + 2] = s[q * 4 + 2]; d[q * 4 + 3] = 255; } }
  if (v === "stack") { const m = st.res && st.res.stackMap, lim = +stackLimitPct(); if (m && m.length === P) for (let q = 0; q < P; q++) { if (p.alpha[q] < 128) { for (let c = 0; c < 3; c++) d[q * 4 + c] = gar[c]; d[q * 4 + 3] = 255; continue; }
      const c = stackColor(m[q] * 2, lim); d[q * 4] = c[0]; d[q * 4 + 1] = c[1]; d[q * 4 + 2] = c[2]; d[q * 4 + 3] = 255; } }
  if (st.res && v === "chan") { const ci = st.chan; for (let q = 0; q < P; q++) { const a = ci === N ? (st.res.ub ? st.res.ub[q] : 0) : st.res.cov[q * N + ci]; d[q * 4] = d[q * 4 + 1] = d[q * 4 + 2] = 255 * (1 - a); d[q * 4 + 3] = 255; } }
  if (st.sel && (v === "orig" || v === "sim")) for (let q = 0; q < P; q++) if (st.sel[q]) { d[q * 4] = d[q * 4] * 0.5 + 74; d[q * 4 + 1] = d[q * 4 + 1] * 0.5 + 82; d[q * 4 + 2] = d[q * 4 + 2] * 0.5 + 107; }
  // Show where (a pre-print check): the marked pixels as they are, the rest washed out, and a box around them
  const mk = st.mark && (v === "orig" || v === "sim") && st.mark.mask.length === P ? st.mark : null;
  if (mk) for (let q = 0; q < P; q++) if (!mk.mask[q]) for (let c = 0; c < 3; c++) d[q * 4 + c] = d[q * 4 + c] * 0.3 + 178;
  g.putImageData(id, 0, 0);
  if (mk) { const b = maskBox(mk.mask, p.W, p.H), s = Math.max(1, p.W / 400); if (b) { const x0 = Math.max(2 * s, b.x * p.W - 3 * s), y0 = Math.max(2 * s, b.y * p.H - 3 * s), r = [x0, y0, Math.min(p.W - 2 * s, (b.x + b.w) * p.W + 3 * s) - x0, Math.min(p.H - 2 * s, (b.y + b.h) * p.H + 3 * s) - y0]; // kept inside the picture
    g.lineWidth = 4 * s; g.strokeStyle = "#ffffff"; g.strokeRect(...r); g.lineWidth = 2 * s; g.strokeStyle = "#a60315"; g.strokeRect(...r); } }
  if (v === "split") { g.fillStyle = "#94a3d6"; g.fillRect(sx - 1, 0, 3, p.H); g.fillStyle = "#ffffff"; g.fillRect(sx - 9, (p.H >> 1) - 15, 18, 30); g.strokeStyle = "#001089"; g.strokeRect(sx - 9, (p.H >> 1) - 15, 18, 30); }
}
// The film list for a given ink set. Export passes the inks it actually separated (it may drop empty screens).
function plates(inks = st.inks, hasUB = !!(st.res && st.res.ub)) {
  // the shop's name and double hit for each screen (st.prod, by ink name) ride on the plate into every export
  return platesFor(inks.map(k => ({ ...k, ...(st.prod.get(k.name) || {}) })), hasUB, { screening: $("screening").value, angle: +$("angle").value, lpi: +$("lpi").value, library: st.library, calib: st.calib, mesh: st.shop.mesh, ub: st.prod.get(UB_KEY), ...(methodKey() && { method: methodKey() }) });
}
/** st.prod key of the underbase (no ink has an empty-character name). */
const UB_KEY = "\u0000underbase";
const mirrored = () => $("mirror").value === "mirror";
// Choke is set in millimetres (printers quote 0.17–0.34 mm) and converted to film pixels at the film DPI.
const chokePx = dpi => J.chokePx(settings(), dpi);
/** The Print view shows the dots at the size they print: the films are made smaller by the dot-gain compensation and
    the press spreads them back, so drawing the films as they are (as this view did before 2026-11-13) showed every
    mid-tone too light, with base and shirt between the dots that the press closes. */
function printDot() { return { ...dotOpts(), gain: 0 }; }
function dotOpts() { return J.dotOf(settings()); }
/** The mesh color screens print on: the shop's own (Shop setup) or the one that follows the LPI. */
const colorMesh = lpi => st.shop.mesh.color || meshFor(lpi);
function filmGeom() { const dpi = +$("dpi").value, Wp = Math.round(+$("outW").value * dpi); return { dpi, Wp, Hp: Math.round(Wp * st.prev.H / st.prev.W) }; }
/** Center (0–1) of the busiest window of a plate: midtone dots, or for solid screens an even mix of ink and open film. */
function busiestCenter(sels, fw, fh) {
  const p = st.prev, N = st.inks.length; let bx = 0.5, by = 0.5, bs = -1; const hw = Math.min(0.5, fw / 2), hh = Math.min(0.5, fh / 2);
  for (let cy = hh; cy <= 1 - hh + 1e-9; cy += Math.max(0.02, hh / 2)) for (let cx = hw; cx <= 1 - hw + 1e-9; cx += Math.max(0.02, hw / 2)) {
    let sc = 0; for (const sel of sels) { const arr = sel.ub ? st.res.ub : st.res.cov; let s1 = 0, sum = 0;
      for (let k = 0; k < 49; k++) { const x = Math.min(p.W - 1, Math.max(0, Math.round((cx + ((k % 7) / 6 - 0.5) * 2 * hw) * p.W))), y = Math.min(p.H - 1, Math.max(0, Math.round((cy + (((k / 7) | 0) / 6 - 0.5) * 2 * hh) * p.H))); const a = sel.ub ? arr[y * p.W + x] : arr[(y * p.W + x) * N + sel.idx]; s1 += a * (1 - a); sum += a; }
      const m = sum / 49; sc += s1 + 49 * m * (1 - m) * 0.5; }
    if (sc > bs) { bs = sc; bx = cx; by = cy; }
  }
  return [bx, by];
}
/* Inspect: the real films at true resolution, zoomed and dragged anywhere. "All" stacks every screen's dots in print
   order on the garment, so you see the print the way a loupe would; a single swatch shows that film, black is ink. */
/* Zoom is continuous from 50% to 800% on a log slider (equal steps feel the same at every zoom); Fit shows the whole design. */
/* At Fit the design keeps a margin inside the workspace (--fitpad, bench.css). */
const fitPad = () => 2 * (parseFloat(getComputedStyle($("square")).getPropertyValue("--fitpad")) || 0);
const ZMAX = 8, zFit = () => { const { Wp, Hp } = filmGeom(), m = fitPad(), bw = Math.max(200, $("view0").parentElement.clientWidth - m), bh = Math.max(200, $("view0").parentElement.clientHeight - m); return Math.min(1, bw / Wp, bh / Hp); }, zClamp = z => Math.max(zFit(), Math.min(ZMAX, z));
function inspGeom() {
  // the inspect window is the image box, capped at 60% of the window height so the zoom buttons and swatches stay in view
  const { dpi, Wp, Hp } = filmGeom(), bw = Math.max(200, $("view0").parentElement.clientWidth), bh = Math.max(200, $("view0").parentElement.clientHeight);
  const z = st.insp.z === "fit" ? 1 : st.insp.z, w = Math.min(Wp, Math.round(bw / z)), h = Math.min(Hp, Math.round(bh / z)); return { dpi, Wp, Hp, box: bw, z, w, h };
}
async function drawInspect(cmp = false) {
  const cv = $("view0"); if (!cmp) renderZoomBar();
  if (!st.res) return;
  const fit = cmp || st.insp.z === "fit", z = fit ? zFit() : /** @type {number} */ (st.insp.z);
  cv.classList.toggle("zoomed", !fit);
  const tok = ++st.insp.tok, { dpi, Wp, Hp } = filmGeom(), box = /** @type {HTMLElement} */ (cv.parentElement);
  const bw = Math.max(200, box.clientWidth), bh = Math.max(200, box.clientHeight), w = Math.min(Wp, Math.round(bw / z)), h = Math.min(Hp, Math.round(bh / z));
  const pl = plates(), sel = pl.find(p => !p.ub && p.idx === st.chan) || pl.find(p => p.ub && st.chan === st.inks.length) || pl[0];
  // Compare always shows the whole design and leaves Print's zoom position alone
  if (!cmp && st.insp.cx == null) [st.insp.cx, st.insp.cy] = z >= 0.5 ? busiestCenter(st.insp.all ? pl.filter(p => !p.ub) : [sel], w / Wp, h / Hp) : [0.5, 0.5];
  const cx = cmp ? 0.5 : st.insp.cx, cy = cmp ? 0.5 : st.insp.cy;
  const x0 = Math.max(0, Math.min(Wp - w, Math.round(cx * Wp - w / 2))), y0 = Math.max(0, Math.min(Hp - h, Math.round(cy * Hp - h / 2)));
  if (!cmp) { st.insp.cx = (x0 + w / 2) / Wp; st.insp.cy = (y0 + h / 2) / Hp; st.insp.view = { x0, y0, w, h, Wp, Hp }; }
  // Always the separation, never the smooth preview. From 100% up: the real film, pixel for pixel. Under 100% the dots are
  // smaller than a screen pixel, so the film is drawn at about 1.5 times the screen's real pixels (capped so Fit stays quick)
  // and then averaged down: the dots stay visible on phone and retina screens, without the false moiré of plain shrinking.
  // Under 100% every screen pixel averages a fixed block of the drawn film, pinned to the design (not to the view), so
  // panning shows the same pixels for the same spot: the picture never reshuffles while you move around.
  const dpr = Math.min(3, window.devicePixelRatio || 1), q = z * dpr, ow = Math.max(1, Math.round(w * q)), oh = Math.max(1, Math.round(h * q));
  let k = z >= 1 ? 1 : Math.min(1, 1.5 * q); if (w * k * h * k > 3e6) k = Math.sqrt(3e6 / (w * h));
  const dpiR = dpi * k, WpR = Math.max(1, Math.round(Wp * k)), HpR = Math.max(1, Math.round(Hp * k)), sx = k / q, Xa = Math.floor(x0 * q), Ya = Math.floor(y0 * q);
  const c = z >= 1 ? { x0, y0, w, h } : { x0: Math.min(WpR - 1, Math.floor(Xa * sx)), y0: Math.min(HpR - 1, Math.floor(Ya * sx)), w: 0, h: 0 };
  if (z < 1) { c.w = Math.max(1, Math.min(WpR, Math.ceil((Xa + ow) * sx)) - c.x0); c.h = Math.max(1, Math.min(HpR, Math.ceil((Ya + oh) * sx)) - c.y0); }
  // Every view shows the dots exactly as they are on the films (made smaller for dot gain), never a guess at the press:
  // a single screen is one film; All and Compare lay the films down in print order.
  const all = cmp || st.insp.all, want = all ? pl.filter(p => !st.hidden.has(p.ub ? st.inks.length : p.idx)) : [sel];
  if (!want.length) { const gar = hex2rgb($("garment").value), c2 = cv.getContext("2d"); cv.width = Math.max(1, Math.round(w * z)); cv.height = Math.max(1, Math.round(h * z)); c2.fillStyle = `rgb(${gar.join(",")})`; c2.fillRect(0, 0, cv.width, cv.height); cv.style.width = cv.width + "px"; return; }
  // a redraw for a new size of the view (the band shrinking while the page scrolls) keeps the picture on screen until
  // the new one is ready: no busy cover, so scrolling never flashes a blank square
  const quiet = st.insp.quiet; st.insp.quiet = false;
  if (!quiet) busyOn("Drawing the dots…"); let films;
  try { films = await call({ type: "plates", plates: want, trapMm: +$("trap").value, widthIn: +$("outW").value, Wp: WpR, Hp: HpR, crop: c, dpi: dpiR, lpi: +$("lpi").value, screening: $("screening").value === "fm" ? "fm" : "am", overprint: ovp(), rho: st.calib && st.calib.overlap != null ? st.calib.overlap : PRESS[$("press").value].rho, rhos: PRESS[$("press").value].rhos, stackLimit: stackLim(), dot: printDot(), choke: chokePx(dpiR), indexDpi: +$("indexDpi").value }); } finally { if (!quiet) busyOff(); }
  if (tok !== st.insp.tok || (cmp ? !(st.view === "sim" && st.compare) : st.view !== "film")) return;
  const id = new ImageData(c.w, c.h), d = id.data, n = c.w * c.h;
  if (all) {
    // no ink model: where a film has ink, that ink's color covers what is under it (print order), like spot channels at 100%
    const gar = hex2rgb($("garment").value), cols = want.map(p => lab2rgb(p.lab));
    for (let q = 0; q < n; q++) { let col = gar;
      for (let j = 0; j < want.length; j++) if (films[j].bits[q]) col = cols[j];
      d[q * 4] = col[0]; d[q * 4 + 1] = col[1]; d[q * 4 + 2] = col[2]; d[q * 4 + 3] = 255; }
  } else for (let q = 0; q < n; q++) { const v = films[0].bits[q] ? 0 : 255; d[q * 4] = d[q * 4 + 1] = d[q * 4 + 2] = v; d[q * 4 + 3] = 255; }
  if (cmp) { // keep the film picture for the line to move over; the zoomed-out average is what the eye sees at this size
    const img = z >= 1 ? id : null; if (img) { st.cmpFilm = { res: st.res, key: cmpKey(), img, x0, y0, w, h, Wp, Hp, cssW: Math.round(c.w * z) + "px" }; composeCompare(); return; } }
  if (z >= 1) { cv.width = c.w; cv.height = c.h; cv.getContext("2d").putImageData(id, 0, 0); cv.style.transform = ""; cv.style.width = Math.round(c.w * z) + "px"; cv.style.imageRendering = "pixelated"; }
  else {
    // average each output pixel's block of rendered film pixels (the tone and the dot pattern the eye sees at this size)
    const out = new ImageData(ow, oh), o = out.data, blk = (i, o0, len) => Math.min(len - 1, Math.max(0, Math.floor(i * sx) - o0));
    for (let y = 0; y < oh; y++) { const ya = blk(Ya + y, c.y0, c.h), yb = Math.max(ya + 1, Math.min(c.h, Math.floor((Ya + y + 1) * sx) - c.y0));
      for (let x = 0; x < ow; x++) { const xa = blk(Xa + x, c.x0, c.w), xb = Math.max(xa + 1, Math.min(c.w, Math.floor((Xa + x + 1) * sx) - c.x0)); let r = 0, gg = 0, bb = 0, m = 0;
        for (let yy = ya; yy < yb; yy++) for (let xx = xa; xx < xb; xx++) { const q = (yy * c.w + xx) * 4; r += d[q]; gg += d[q + 1]; bb += d[q + 2]; m++; }
        const q = (y * ow + x) * 4; o[q] = r / m; o[q + 1] = gg / m; o[q + 2] = bb / m; o[q + 3] = 255; } }
    if (cmp) { st.cmpFilm = { res: st.res, key: cmpKey(), img: out, x0, y0, w, h, Wp, Hp, cssW: Math.round(ow / dpr) + "px" }; composeCompare(); return; }
    cv.width = ow; cv.height = oh; cv.getContext("2d").putImageData(out, 0, 0); cv.style.transform = ""; cv.style.imageRendering = "auto"; cv.style.width = Math.round(ow / dpr) + "px";
  }
  if (st.probe) { const g2 = cv.getContext("2d"), s2 = cv.width / (z >= 1 ? c.w : ow) * (z >= 1 ? 1 : q), X = (st.probe.fx * Wp - x0) * s2, Y = (st.probe.fy * Hp - y0) * s2, R = 9 * cv.width / Math.max(1, parseFloat(cv.style.width) || cv.width);
    if (X >= 0 && Y >= 0 && X < cv.width && Y < cv.height) { g2.lineWidth = 3 * R / 9; g2.strokeStyle = "#ffffff"; g2.beginPath(); g2.arc(X, Y, R, 0, 7); g2.stroke(); g2.lineWidth = 1.5 * R / 9; g2.strokeStyle = "#001089"; g2.beginPath(); g2.arc(X, Y, R, 0, 7); g2.stroke(); } }
  $("inspWhere").textContent = fit ? "Full design, dot by dot · click an area to see it at 100%" : `${(w / dpi).toFixed(2)} × ${(h / dpi).toFixed(2)} in of film at ${dpi} dpi${z < 1 ? " (drawn smaller)" : ""} · drag to move · pinch or Ctrl + scroll to zoom`;
}
function renderZoomBar() {
  const fit = st.insp.z === "fit", z = fit ? zFit() : /** @type {number} */ (st.insp.z), sl = $("zoomSlider");
  sl.min = String(Math.log2(zFit()).toFixed(3)); sl.value = String(Math.log2(z));
  const lbl = fit ? "Fit" : `${Math.round(z * 100)}%`; $("zoomPct").textContent = lbl;
  $("zStep").setAttribute("aria-label", `Fit. Zoom is ${lbl}; this tap goes to ${zNext() === "fit" ? "Fit" : Math.round(/** @type {number} */ (zNext()) * 100) + "%"}.`);
}

/* ───────────── Screens: the color cards (renderScreens) ───────────── */
function renderOrder() {
  const lpi = +$("lpi").value, scr = $("screening").value, mesh = colorMesh(lpi), pl = plates();
  preflight(pl);
  $("meshNote").textContent = scr === "fm" ? "Index prints square pixels side by side: no angles, best on 230 mesh and up." :
    st.mode !== "sim" ? `Solid screens need no halftone angle. Spot solids usually print on 110 to 230 mesh: coarser for big solids, finer for fine detail. Index needs 230 and up.` : `${st.shop.mesh.color ? `Mesh for colors is set in Shop setup: ${mesh}.` : `Mesh is picked from your LPI (${lpi} LPI: ${mesh} for colors).`} ${scr === "same" ? `All screens print at ${$("angle").value}°, the standard for simulated process.` : "Rotated angles can cause moiré past four screens: proof on press first."}`;
}

/** The plain data the pre-print checks read (checks.js): the controls, the art and the separation's image. */
function checkJob(pl = plates()) {
  const a = artIn(); return { ...J.checkJob(settings(), jobCtx(), st.art && a ? { ...a, W: st.art.W } : null, st.prev, pl, st.sample), sizes: st.sizes, mesh: colorMesh(+$("lpi").value) };
}
const SEV = { error: "! Error", warning: "! Warning", note: "Note" };
/** Wires the "?" on each check that has a help entry (help.initHelp sets it). */
let attachHelp = (/** @type {any} */ _root) => {};
/** Checks before films are made (checks.js), errors first: problems printers otherwise find only after burning screens.
 *  A check about one part of the art has Show where: it marks those pixels on the art. */
function preflight(pl) {
  const job = checkJob(pl), out = preflightChecks(job, st.res), refs = out.flatMap(c => [c.region, ...(c.colors || []).map(g => g.region)]).filter(Boolean).map(r => r.mask);
  if (st.mark && (st.mark.res !== st.res || !refs.includes(st.mark.ref))) { st.mark = null; if (st.view === "orig" || st.view === "sim") draw(); }
  else if (st.mark && st.mark.lim !== regionKey(job)) { st.mark.mask = regionMask(st.mark.ref, job, st.res) || st.mark.mask; st.mark.lim = regionKey(job); draw(); }
  const show = (r, what, label = "Show where") => r ? `<button type="button" class="ckshow" data-region="${esc(r.mask)}" data-what="${esc(what)}" aria-pressed="${!!(st.mark && st.mark.ref === r.mask)}">${st.mark && st.mark.ref === r.mask ? "Hide" : label}</button>` : "";
  const sw = c => c.colors ? `<ul class="gamut">${c.colors.map(g => `<li><span class="chip" style="background:${g.hex}"></span><b>${esc(g.name)}</b> ${g.hex} · ${g.area < 0.01 ? "under 1" : Math.round(g.area * 100)}% of the art · prints off by ${g.de.toFixed(0)} ΔE${g.near ? ` (closest ink ${esc(g.near.name)}, ΔE ${g.near.de.toFixed(0)})` : ""}${g.region ? " " + show(g.region, g.name, "Show") : ""}</li>`).join("")}</ul>` : "";
  const el = $("preflight"); el.className = "checks " + (out.some(c => c.severity === "error") ? "bad" : out.some(c => c.severity === "warning") ? "warn" : out.length ? "note" : "ok");
  el.innerHTML = out.map(c => `<div class="ck ${c.severity}" data-check="${esc(c.id)}"><b${c.help ? ` data-help="${esc(c.help)}"` : ""}>${SEV[c.severity]} · ${esc(c.title)}</b><p>${esc(lenText(c.detail))}</p><p class="cknum">Found ${esc(lenText(c.measured))} · Limit ${esc(lenText(c.limit))}</p>${sw(c)}${c.fix.length || c.region ? `<div class="row">${c.fix.map((f, j) => `<button type="button" data-fix="${esc(f.action)}"${j ? "" : ' class="pri"'}>${esc(lenText(f.label))}</button>`).join("")}${show(c.region, c.title)}</div>` : ""}</div>`).join("");
  attachHelp(el); st.checksFailed = out.length; el.hidden = !out.length; renderRating();
}
/** Show where: mark a check's pixels on the art (the Art view, or the print preview when it is open); a second tap clears. */
function showRegion(ref, what = "") {
  if (st.mark && st.mark.ref === ref) st.mark = null;
  else { const job = checkJob(), mask = regionMask(ref, job, st.res); if (!mask) return; st.mark = { ref, mask, res: st.res, what, lim: regionKey(job) };
    if (st.view !== "orig" && !(st.view === "sim" && !st.compare)) setView("orig", true);
    if (phone()) $("square").scrollIntoView({ block: "nearest", behavior: "smooth" }); }
  renderOrder(); draw();
}
/** Adds a mixed ink (locked, like Add ink) for each colour the gamut check named, one more screen each (12 at most). */
function addGamutMixes() {
  const g = st.res && st.res.gamut; if (!g || !g.length) return;
  const add = g.slice(0, Math.max(0, 12 - (+$("nInks").value || 6))).map(c => { const nm = colorName(c.rgb); return { name: `${nm[0].toUpperCase() + nm.slice(1)} mix`, lab: c.lab.slice(), source: "art", locked: true, chosen: true }; });
  if (!add.length) return;
  st.inks.push(...add); $("nInks").value = String(Math.min(12, +$("nInks").value + add.length));
  st.why = add.length > 1 ? `${add.length} mixed inks` : `added ${add[0].name}`; markManual("inks"); run(true);
}

/* ───────────── Ink library ───────────── */
function renderLibrary() {
  const lib = st.library, { kind, estimate } = libraryKind(lib);
  $("libPill").textContent = `${lib.length} inks · ${kind}`; $("libPill").className = "pill " + (kind === "measured" ? "ok" : "warn");
  $("libNote").textContent = kind === "measured" ? `Separations choose from these ${lib.length} measured inks.`
    : kind === "estimate" ? `${estimate === lib.length ? "These" : `${estimate} of these`} inks are ADN estimates of the maker's colors, not measurements. Import your own drawdown readings so separations use the inks on your shelf.`
    : "These are generic, unmeasured shades. Import your own drawdown readings so separations use the inks on your shelf.";
}
$("libImport").addEventListener("click", () => $("libFile").click());
$("libFile").addEventListener("change", async e => { const f = e.target.files[0]; if (!f) return; try { st.library = parseInkCSV(await f.text()); store.set("library", st.library); renderLibrary(); run(true); } catch (err) { $("libNote").textContent = err.message; } e.target.value = ""; });
$("libExport").addEventListener("click", () => saveFile("ink-library.csv", new Blob([inksToCSV(st.library)], { type: "text/csv" })));
/* ───────────── Platen, film and screen sizes (Shop setup) ───────────── */
const SZ_ID = { platen: "szPlaten", film: "szFilm", screen: "szScreen" };
function renderSizes() {
  for (const k of SIZE_KINDS) { const sel = /** @type {HTMLSelectElement} */ ($(SZ_ID[k])), z = st.sizes[k];
    if (!sel.options.length) sel.innerHTML = SIZE_PRESETS[k].map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join("") + '<option value="custom">Custom</option>';
    sel.value = z.id; $(SZ_ID[k] + "Custom").hidden = z.id !== "custom"; /** @type {HTMLInputElement} */ ($(SZ_ID[k] + "W")).value = String(z.w); /** @type {HTMLInputElement} */ ($(SZ_ID[k] + "H")).value = String(z.h); }
}
/** Reads the size controls; a valid set is saved and the checks run again, an invalid one says what is wrong. */
function sizesChanged() {
  /** @type {any} */ const set = {};
  for (const k of SIZE_KINDS) { const id = $(SZ_ID[k]).value; set[k] = id === "custom" ? { id, w: +$(SZ_ID[k] + "W").value, h: +$(SZ_ID[k] + "H").value } : { id }; $(SZ_ID[k] + "Custom").hidden = id !== "custom"; }
  try { st.sizes = cleanSizes(set); store.set("sizes", sizeSetting(st.sizes)); $("sizeNote").textContent = ""; } catch (err) { $("sizeNote").textContent = err.message; return; }
  if (st.res) renderOrder(); renderProfiles(true);
}
for (const k of SIZE_KINDS) { $(SZ_ID[k]).addEventListener("change", () => { const z = st.sizes[k];
    if ($(SZ_ID[k]).value === "custom" && z.id !== "custom") { /** @type {HTMLInputElement} */ ($(SZ_ID[k] + "W")).value = String(z.w); /** @type {HTMLInputElement} */ ($(SZ_ID[k] + "H")).value = String(z.h); }
    sizesChanged(); });
  for (const d of ["W", "H"]) $(SZ_ID[k] + d).addEventListener("change", sizesChanged); }
renderSizes();
$("libPreset").addEventListener("change", e => { const k = e.target.value; if (!k) return; st.library = PRESETS[k].inks(); store.set("library", k === "generic" ? null : st.library); e.target.value = ""; renderLibrary(); run(true); });

/* ───────────── Shop and press profiles ─────────────
   Shop setup keeps one profile per press: its mesh, LPI, angle, film DPI, dot gain, smallest and largest dot, dot shape, film mirror,
   press type, press time numbers and calibration. Use profile puts them all into the job; the pill says when the job no longer matches it.
   Saved under sepbench.profiles, which the ADN page also keeps in the signed-in account (base/separationShop.ts). */
const MESH_IDS = /** @type {["base" | "color" | "white", string][]} */ ([["base", "meshBase"], ["color", "meshColor"], ["white", "meshWhite"]]);
const PROFILE_IDS = ["press", "lpi", "angle", "dpi", "gain", "minDot", "maxDot", "dotShape", "mirror", "setupMin", "perHour"];
/** Step 4's format checkboxes (a profile keeps them) and the check limit fields. */
const FORMAT_IDS = { pdf: "fPDF", tif: "fTIF", png: "fPNG", eps: "fEPS", svg: "fSVG", psd: "fPSD", psdPreview: "fPSDprev", dcs: "fDCS" }, LIMIT_IDS = Object.keys(CHECK_LIMITS);
const BUILTINS = builtinProfiles();
const allProfiles = () => [...st.shop.list, ...BUILTINS];
function saveShop() { store.set("profiles", st.shop); }
/** The job's settings as a profile. */
function currentProfile(name) {
  return cleanProfile({ name, press: $("press").value, lpi: +$("lpi").value, angle: +$("angle").value, dpi: +$("dpi").value, gain: +$("gain").value, minDot: +$("minDot").value,
    maxDot: +$("maxDot").value, dotShape: $("dotShape").value, mirror: $("mirror").value, setupMin: +$("setupMin").value, perHour: +$("perHour").value, mesh: { ...st.shop.mesh }, calib: st.calib,
    formats: Object.fromEntries(FORMAT_KEYS.map(k => [k, !!$(FORMAT_IDS[k]).checked])), sizes: sizeSetting(st.sizes), limits: Object.fromEntries(LIMIT_IDS.map(k => [k, +$(k).value])) });
}
/** The job matches a profile: every value the profile keeps (a profile saved before formats or limits were kept is
 *  compared on what it has; a built-in has no calibration, so the job's does not count against it). */
const sameSettings = (a, b) => { const keep = Object.keys(b).filter(k => !["name", "builtin", "source", "tested", ...(b.builtin ? ["calib"] : [])].includes(k));
  return JSON.stringify(keep.map(k => a[k])) === JSON.stringify(keep.map(k => b[k])); };
const profSel = () => allProfiles().find(p => p.name === $("profSel").value) || null;
function profNote(t, cls = "") { $("profNote").textContent = t; $("profNote").className = "note" + (cls ? " " + cls : ""); }
let delArm = /** @type {any} */ (null);
function disarmDelete() { if (delArm) clearTimeout(delArm.t); delArm = null; $("profDelete").textContent = "Delete"; }
function renderProfiles(keepNote = false) {
  const sh = st.shop, sel = $("profSel"), want = sel.value, all = allProfiles(), cur = all.find(p => p.name === sh.active) || null, opt = p => `<option value="${esc(p.name)}">${esc(p.name)}</option>`;
  sel.innerHTML = (sh.list.length ? `<optgroup label="Your profiles">${sh.list.map(opt).join("")}</optgroup>` : "") + `<optgroup label="Built in (not press-tested)">${BUILTINS.map(opt).join("")}</optgroup>`;
  sel.value = all.some(p => p.name === want) ? want : cur ? cur.name : all[0].name;
  const picked = profSel(), mine = !!picked && !picked.builtin;
  for (const id of ["profUpdate", "profRename", "profDelete"]) $(id).disabled = !mine; $("profExport").disabled = !sh.list.length;
  $("profSrc").hidden = !(picked && picked.builtin); $("profSrc").textContent = picked && picked.builtin ? `Built in, not press-tested. Sources: ${picked.source}` : "";
  const dsel = $("profDefault"), dwant = sh.defaultProfile && all.some(p => p.name === sh.defaultProfile) ? sh.defaultProfile : "";
  dsel.innerHTML = `<option value="">Standard settings</option>` + all.map(opt).join(""); dsel.value = dwant;
  let changed = false; if (cur) { try { changed = !sameSettings(currentProfile(cur.name), cur); } catch { changed = true; } }
  $("profPill").textContent = cur ? (changed ? `${cur.name}: changed` : `In use: ${cur.name}`) : sh.list.length ? "None in use" : "No profiles";
  $("profPill").className = "pill " + (cur && !changed ? "ok" : "warn");
  const lpi = +$("lpi").value;
  for (const [k, id] of MESH_IDS) { const el = $(id);
    el.innerHTML = `<option value="">Follow LPI (${meshFor(lpi, k === "base")})</option>` + STOCK_MESH.map(m => `<option value="${m}">${m}</option>`).join("");
    el.value = sh.mesh[k] == null ? "" : String(sh.mesh[k]); }
  if (!keepNote) profNote(!sh.list.length && !cur ? "No profiles of your own yet. Use a built-in one, or set the press, LPI and film settings for one press, type a name, then push Save as new."
    : cur && changed ? `The job settings differ from ${cur.name}. Push Save changes to keep them in the profile, or Use profile to go back to it.`
    : "Choose a profile and push Use profile. Its settings replace the job's press, film and mesh settings and the calibration.");
}
function applyProfile(p) {
  for (const [id, v] of /** @type {[string, any][]} */ ([["press", p.press], ["lpi", p.lpi], ["angle", p.angle], ["dpi", p.dpi], ["gain", p.gain], ["minDot", p.minDot], ["maxDot", p.maxDot], ["dotShape", p.dotShape], ["mirror", p.mirror], ["setupMin", p.setupMin], ["perHour", p.perHour]])) {
    setV(id, v); if (ADV[2].includes(id)) st.src[id] = "manual"; }
  if (p.formats) for (const k of FORMAT_KEYS) $(FORMAT_IDS[k]).checked = !!p.formats[k];
  for (const k of LIMIT_IDS) setV(k, (p.limits || {})[k] ?? CHECK_LIMITS[k][0]);
  if (p.sizes) { st.sizes = cleanSizes(p.sizes); store.set("sizes", sizeSetting(st.sizes)); renderSizes(); $("sizeNote").textContent = ""; }
  st.shop.mesh = { ...p.mesh }; st.shop.active = p.name; saveShop();
  if (!p.builtin) { st.calib = p.calib || null; store.set("calib", st.calib); renderCalib(); }
  st.autoBy = false; renderAutoState(); renderSummaries(); renderProfiles(true);
  profNote(`Using ${p.name}.${p.builtin ? " Built in: starting values from published sources, not press-tested. Your calibration stays." : p.calib ? " Its calibration is in use." : " It has no calibration, so the print model is not calibrated."}`, "ok");
  if (st.res) { st.why = `profile ${p.name}`; run(false); }
}
$("profLoad").addEventListener("click", () => { disarmDelete(); const p = profSel(); if (p) applyProfile(p); });
$("profSave").addEventListener("click", () => {
  disarmDelete(); const name = $("profName").value.trim();
  if (!name) { profNote("Type a name for the profile first.", "bad"); $("profName").focus(); return; }
  if (allProfiles().some(p => p.name === name)) { profNote(`There is already a profile named ${name}. Push Save changes to update it, or type another name.`, "bad"); return; }
  let prof; try { prof = currentProfile(name); } catch (e) { profNote(e.message, "bad"); return; }
  st.shop.list = [...st.shop.list, prof]; st.shop.active = name; saveShop(); $("profName").value = "";
  renderProfiles(true); $("profSel").value = name; renderProfiles(true); profNote(`Saved ${name}.`, "ok");
});
$("profUpdate").addEventListener("click", () => {
  disarmDelete(); const p = profSel(); if (!p) return;
  let prof; try { prof = currentProfile(p.name); } catch (e) { profNote(e.message, "bad"); return; }
  st.shop.list = st.shop.list.map(q => q === p ? prof : q); st.shop.active = p.name; saveShop(); renderProfiles(true); profNote(`Saved the job settings in ${p.name}.`, "ok");
});
$("profRename").addEventListener("click", () => {
  disarmDelete(); const p = profSel(), name = $("profName").value.trim(); if (!p) return;
  if (!name) { profNote(`Type the new name for ${p.name} in the name box, then push Rename.`, "bad"); $("profName").focus(); return; }
  if (name !== p.name && allProfiles().some(q => q.name === name)) { profNote(`There is already a profile named ${name}. Type another name.`, "bad"); return; }
  st.shop.list = st.shop.list.map(q => q === p ? { ...q, name } : q); if (st.shop.active === p.name) st.shop.active = name; if (st.shop.defaultProfile === p.name) st.shop.defaultProfile = name; saveShop();
  $("profName").value = ""; renderProfiles(true); $("profSel").value = name; renderProfiles(true); profNote(`Renamed ${p.name} to ${name}.`, "ok");
});
$("profDelete").addEventListener("click", () => {
  const p = profSel(); if (!p) return;
  if (!delArm || delArm.name !== p.name) { disarmDelete(); delArm = { name: p.name, t: setTimeout(disarmDelete, 6000) }; $("profDelete").textContent = "Push again to delete"; profNote(`Push Delete again to delete ${p.name}. You cannot undo this. Export JSON first to keep a copy.`, "warn"); return; }
  disarmDelete(); st.shop.list = st.shop.list.filter(q => q !== p); if (st.shop.active === p.name) st.shop.active = null; if (st.shop.defaultProfile === p.name) st.shop.defaultProfile = null; saveShop(); renderProfiles(true); profNote(`Deleted ${p.name}.`, "ok");
});
$("profSel").addEventListener("change", () => { disarmDelete(); renderProfiles(); });
$("profExport").addEventListener("click", async () => { disarmDelete();
  try { await saveFile("separation-table-profiles.json", new Blob([profilesToJSON(st.shop.list)], { type: "application/json" })); profNote(`Exported ${st.shop.list.length} profile${st.shop.list.length === 1 ? "" : "s"} as separation-table-profiles.json.`, "ok"); }
  catch (e) { profNote(e.message || String(e), "bad"); } });
$("profImport").addEventListener("click", () => { disarmDelete(); $("profFile").click(); });
$("profFile").addEventListener("change", async e => { const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  try { const add = profilesFromJSON(await f.text()), before = st.shop.list.length; st.shop.list = mergeProfiles(st.shop.list, add); saveShop(); renderProfiles(true); $("profSel").value = st.shop.list[before].name; renderProfiles(true);
    const renamed = st.shop.list.slice(before).filter((p, i) => p.name !== add[i].name).length;
    profNote(`Imported ${add.length} profile${add.length === 1 ? "" : "s"} from ${f.name}.${renamed ? ` ${renamed} had a name already in use and got a number.` : ""} Push Use profile to load one.`, "ok"); }
  catch (err) { profNote(err.message || String(err), "bad"); } });
for (const [k, id] of MESH_IDS) $(id).addEventListener("change", () => {
  st.shop.mesh = { ...st.shop.mesh, [k]: $(id).value ? +$(id).value : null }; saveShop(); followAuto(); renderProfiles();
  if (st.res) renderOrder(); if (st.view === "film") draw(); });
PROFILE_IDS.forEach(id => $(id).addEventListener("change", () => renderProfiles()));
[...Object.values(FORMAT_IDS), ...LIMIT_IDS].forEach(id => $(id).addEventListener("change", () => renderProfiles()));
// check limits are job settings: the checks read them at once
LIMIT_IDS.forEach(id => $(id).addEventListener("change", () => { const e = $(id), [, lo, hi] = CHECK_LIMITS[id], v = +e.value; if (!Number.isFinite(v) || e.value === "") e.value = String(CHECK_LIMITS[id][0]); else e.value = String(Math.max(lo, Math.min(hi, v))); if (st.res) renderOrder(); }));
/* The profile a new job starts with (none: the standard settings). */
$("profDefault").addEventListener("change", () => { st.shop.defaultProfile = $("profDefault").value || null; saveShop();
  profNote(st.shop.defaultProfile ? `New jobs start with ${st.shop.defaultProfile}.` : "New jobs start with the standard settings.", "ok"); });

/* ───────────── Calibration ───────────── */
function renderCalib() {
  const c = st.calib; if (!c) $("calNote").textContent = "Readings CSV: ink,tint,L,a,b, tints 0 to 100 in steps of 10. Tint 0 is the bare substrate the ink sits on."; $("calPill").textContent = c ? `Calibrated · n ${c.n}` : "Not calibrated"; $("calPill").className = "pill " + (c ? "ok" : "warn");
  if (c) $("calNote").textContent = `Fitted to ${Object.keys(c.inks).length} inks: Yule–Nielsen n = ${c.n}, mean fit error ΔE00 ${c.residual}.` +
    (c.opacity != null ? ` Ink opacity on the bare shirt ${Math.round(c.opacity * 100)}%.` : "") + (c.overlap != null ? ` Same-angle dot overlap ${c.overlap} (0 stacked, 1 random).` : "") + (c.overlapByOffset ? ` Overlap vs shift: ${c.overlapByOffset.map(o => `${o.mm} mm → ${o.rho}`).join(", ")}.` : "") +
    " Inks with readings use their measured solid color and dot-gain curve.";
  if (c && c.opacity != null) { $("opacity").value = String(c.opacity); $("opacityV").textContent = Math.round(c.opacity * 100) + "% (measured)"; }
}
$("calImport").addEventListener("click", () => $("calFile").click());
$("calFile").addEventListener("change", async e => { const f = e.target.files[0]; if (!f) return; try { st.calib = fitCalibration(parseWedgeCSV(await f.text())); store.set("calib", st.calib); renderCalib(); renderProfiles(); run(false); } catch (err) { $("calNote").textContent = err.message; } e.target.value = ""; });
$("calClear").addEventListener("click", () => { st.calib = null; store.set("calib", null); renderCalib(); renderProfiles(); $("calNote").textContent = "Readings CSV: ink,tint,L,a,b, tints 0 to 100 in steps of 10. Tint 0 is the bare substrate the ink sits on."; run(false); });
$("calChart").addEventListener("click", async () => {
  if (!st.inks.length) return; const btn = $("calChart"); btn.disabled = true;
  try {
    // columns 0–10: tints on base · 11: solid on the bare shirt · 12: 50% on the bare shirt · 13: 50% + next ink 50% on base
    const N = st.inks.length, C = 14, PS = 24, W = C * PS, H = N * PS, P = W * H, cov = new Float32Array(P * N), dark = needsUB(), ub = dark ? new Float32Array(P) : null;
    for (let r = 0; r < N; r++) for (let c = 0; c < C; c++) for (let y = 0; y < PS; y++) for (let x = 0; x < PS; x++) {
      const p = (r * PS + y) * W + c * PS + x, gutter = x < 2 || y < 2; if (gutter) continue;
      if (c <= 10) cov[p * N + r] = c / 10; else if (c === 11) cov[p * N + r] = 1; else if (c === 12) cov[p * N + r] = 0.5;
      else if (r + 1 < N) { cov[p * N + r] = 0.5; cov[p * N + r + 1] = 0.5; }
      if (ub && c !== 11 && c !== 12) ub[p] = 1;
    }
    const dpi = +$("dpi").value, Wp = Math.round(C * dpi), Hp = Math.round(N * dpi);
    const pl = plates().map(p => ({ ...p, curve: null }));
    const bits = await call({ type: "plates", cov, ub, W, H, N, mode: "sim", plates: pl, Wp, Hp, dpi, lpi: +$("lpi").value, screening: "am", overprint: "same", dot: { gain: 0, minDot: 0, maxDot: 1, shape: $("dotShape").value }, choke: 0 });
    const { composeFilm, toPDF, toPNG, zipLib } = await import("./output.js"); const JSZip = await zipLib(), zip = new JSZip(), films = [];
    for (let j = 0; j < pl.length; j++) { const f = composeFilm(bits[j].bits, bits[j].w, bits[j].h, dpi, `CALIBRATION ${pl[j].order}. ${pl[j].name.toUpperCase()} ${$("lpi").value} LPI ${pl[j].angle}° · PATCHES 0–100% LEFT TO RIGHT, ONE ROW PER INK; LAST 3 PATCHES: SOLID ON BARE SHIRT, 50% ON BARE SHIRT, 50% WITH NEXT INK`); films.push({ ...f, png: await toPNG(f.canvas) }); }
    zip.file("calibration-films.pdf", await toPDF(films, dpi));
    const tmpl = ["_shirt,0,,,"].concat(st.inks.flatMap((k, i) => TINTS.map(t => `${k.name},${t},,,`).concat(dark ? [`${k.name},bare100,,,`, `${k.name},bare50,,,`] : [], i + 1 < N ? [`${k.name},ov:${st.inks[i + 1].name},,,`, `${k.name},ov:${st.inks[i + 1].name}@0.1,,,`, `${k.name},ov:${st.inks[i + 1].name}@0.25,,,`] : [])));
    zip.file("readings-template.csv", "ink,tint,L,a,b\n" + tmpl.join("\n") + "\n");
    zip.file("README.txt", "Print each film on its own screen, in this order, on the garment you will run. Row r of the chart is ink r. Measure each 1-inch patch (D65/10°, specular included) after full cure and fill readings-template.csv. Tint 0 is the bare substrate the ink sits on (underbase on dark garments). Import the CSV under Calibration.\n\nRegistration test: print the last column (50% overlap patches) three times, once in register and twice with the next ink's screen moved 0.1 mm and 0.25 mm on the press's micro-registration. Record them as ov:<Ink>, ov:<Ink>@0.1 and ov:<Ink>@0.25. Separation Table learns how this press and ink set respond to misregistration.\n");
    await saveFile("calibration-chart.zip", await zip.generateAsync({ type: "blob", compression: "DEFLATE" }));
  } catch (e) { $("calNote").textContent = "Chart export failed: " + e.message; } finally { btn.disabled = false; }
});

/* ───────────── Color targets (no Pantone data; values come from the user) ───────────── */
function renderTargets() {
  const tb = $("targets").querySelector("tbody"); tb.innerHTML = "";
  st.targets.forEach((t, i) => {
    const mt = matchTarget(t, st.library, calibratedLab), best = mt.ink, bc = mt.cmc, d00 = mt.de00, pass = mt.pass;
    const tr = document.createElement("tr");
    tr.innerHTML = `<td><span class="chip" style="background:${rgb2hex(lab2rgb(t.lab))}"></span><input class="lbl" type="text" aria-label="Requested color"></td>
      <td><input type="number" step="0.1" aria-label="L" value="${t.lab[0]}"></td><td><input type="number" step="0.1" aria-label="a" value="${t.lab[1]}"></td><td><input type="number" step="0.1" aria-label="b" value="${t.lab[2]}"></td>
      <td><select aria-label="Tolerance"><option value="1">Brand exact ≤ 1.0</option><option value="2">General ≤ 2.0</option><option value="3.5">Bulk ≤ 3.5</option></select></td>
      <td><span class="chip" style="background:${best ? rgb2hex(lab2rgb(calibratedLab(best))) : "transparent"}"></span><span class="nm"></span></td>
      <td>${bc.toFixed(2)} <span class="pill ${pass ? "ok" : "bad"}">${pass ? "Pass" : "Mix"}</span></td><td>${d00.toFixed(2)}</td>
      <td><button type="button" data-a="use">Use as ink</button> <button type="button" data-a="del" aria-label="Remove target">×</button></td>`;
    /** @type {HTMLInputElement} */ (tr.querySelector(".lbl")).value = t.label; tr.querySelector(".nm").textContent = best ? best.name : "–"; tr.querySelector("select").value = String(t.tier);
    tr.querySelector(".lbl").addEventListener("change", e => { t.label = e.target.value; saveTargets(); });
    tr.querySelectorAll("input[type=number]").forEach((inp, k) => inp.addEventListener("change", e => { t.lab[k] = +e.target.value; saveTargets(); renderTargets(); }));
    tr.querySelector("select").addEventListener("change", e => { t.tier = +/** @type {HTMLSelectElement} */ (e.target).value; saveTargets(); renderTargets(); });
    tr.querySelector("[data-a=use]").addEventListener("click", () => { st.inks.push({ name: t.label || "Target", lab: t.lab.slice(), source: "target", locked: true }); run(false); });
    tr.querySelector("[data-a=del]").addEventListener("click", () => { st.targets.splice(i, 1); saveTargets(); renderTargets(); });
    tb.appendChild(tr);
  });
}
function saveTargets() { store.set("targets", st.targets); }
$("addTarget").addEventListener("click", () => { st.targets.push({ label: "", lab: [50, 0, 0], tier: 2 }); saveTargets(); renderTargets(); });

/* ───────────── Art prep tools ───────────── */
function prepMsg(t, cls) { const e = $("prepStatus"); e.textContent = t; e.className = "small " + (cls || ""); if (busyN && !cls) $("busyText").textContent = $("mrBusyText").textContent = t; }
async function prep(btn, label, fn) {
  if (st.busy) return; st.busy = true; btn.disabled = true; busyOn(label + "…"); prepMsg(label + "…");
  try { await fn(); prepMsg(label + " done.", "ok"); } catch (e) { console.error(e); prepMsg(`${label} is unavailable here: ${e.message}`, "bad"); }
  finally { st.busy = false; btn.disabled = false; busyOff(); }
}
$("bgRemove").addEventListener("click", () => prep($("bgRemove"), "Removing background", async () => {
  const { removeBackground } = await import("./ai.js"); const a = st.art, alpha = await removeBackground(a.rgba, a.W, a.H), out = new Uint8ClampedArray(a.rgba);
  for (let i = 0; i < a.W * a.H; i++) out[i * 4 + 3] = Math.min(out[i * 4 + 3], alpha[i]); setArt(out, a.W, a.H); st.busy = false; await run(true);
}));
$("upscale").addEventListener("click", () => prep($("upscale"), "Upscaling", async () => {
  const { upscale2x } = await import("./ai.js"); let a = st.art;
  // CPU-only super-resolution is slow (about a minute per 640 px image); upscale small art, which is where it helps.
  if (Math.max(a.W, a.H) > 640) { const d = downsample(a, 640); a = { rgba: d.rgba, W: d.W, H: d.H }; }
  const r = await upscale2x(a.rgba, a.W, a.H, f => prepMsg(`Upscaling… ${Math.round(f * 100)}%`)); setArt(r.rgba, r.W, r.H); if (st.artFile) { st.artFile = { ...st.artFile, W: r.W, H: r.H, info: st.artFile.info + " Upscaled 2×." }; renderArtCard(); } st.busy = false; await run(false);
}));
$("denoise").addEventListener("click", () => prep($("denoise"), "Reducing noise", async () => {
  const { denoise } = await import("./cvtools.js"); const a = st.art; setArt(await denoise(a.rgba, a.W, a.H, 1), a.W, a.H); st.busy = false; await run(false);
}));
$("undoArt").addEventListener("click", () => { const prev = st.history.pop(); if (!prev) return; st.art = null; setArt(prev.rgba, prev.W, prev.H, false); run(false); });
$("selectMode").addEventListener("click", () => {
  st.selecting = !st.selecting; $("selectMode").setAttribute("aria-pressed", st.selecting); $("selActs").hidden = !st.selecting; $("view0").classList.toggle("picking", st.selecting);
  if (st.selecting && st.view !== "orig" && st.view !== "sim") setView("orig");
});
$("view0").addEventListener("click", async e => {
  if (!st.selecting || st.busy) return; const cv = $("view0"), r = cv.getBoundingClientRect(), p = st.prev;
  const x = (e.clientX - r.left) / r.width * p.W, y = (e.clientY - r.top) / r.height * p.H;
  st.selPoints.push({ x, y, label: e.shiftKey ? 0 : 1 });
  await prep($("selectMode"), "Selecting", async () => {
    const ai = await import("./ai.js");
    if (st.selPoints.length === 1 || !st._encoded) { prepMsg("Reading the image for selection (first click only)…"); await ai.samEncode(p.rgba, p.W, p.H); st._encoded = true; }
    st.sel = await ai.samSegment(st.selPoints); draw();
  });
});
function applySelection(keep) {
  if (!st.sel) return; const a = st.art, p = st.prev, out = new Uint8ClampedArray(a.rgba);
  for (let y = 0; y < a.H; y++) for (let x = 0; x < a.W; x++) { const q = Math.min(p.H - 1, (y * p.H / a.H) | 0) * p.W + Math.min(p.W - 1, (x * p.W / a.W) | 0), inSel = st.sel[q] === 1; if (keep ? !inSel : inSel) out[(y * a.W + x) * 4 + 3] = 0; }
  st._encoded = false; setArt(out, a.W, a.H); run(false);
}
$("selKnock").addEventListener("click", () => applySelection(false));
$("selKeep").addEventListener("click", () => applySelection(true));
$("selClear").addEventListener("click", () => { st.sel = null; st.selPoints = []; draw(); });

/* ───────────── Export ───────────── */
async function saveFile(name, blob) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}
async function exportJob(toFolder) {
  const btn = $("export"), es = $("expStatus");
  // a setting change may still be re-separating: wait for it instead of ignoring the click
  if (st.busy) { es.textContent = "Waiting for the separation to update…"; es.className = "small statusline"; while (st.busy) await new Promise(r => setTimeout(r, 150)); }
  if (!st.res) return; st.busy = true; btn.disabled = true;
  try {
    const out = await import("./output.js"); const JSZip = await out.zipLib(), zip = new JSZip(), s = settings(), ctx = jobCtx();
    const work = st.art.W > st.prev.W ? downsample(artIn(), WORK_MAX, false) : st.prev, geom = J.filmGeometry(s, work.W, work.H), { dpi, Wp, Hp } = geom;
    if (Wp * Hp > 120e6) throw new Error("A film would be over 120 megapixels. Lower the DPI or print width.");
    es.textContent = `Separating at ${work.W}×${work.H}…`;
    let r = st.imp ? importedAt(work) : await cleanIfSpot(await separate(work, false, st.inks, false), work);
    const pl = plates(r.inks, !!r.ub), planErrs = checkPlan(pl, r); if (planErrs.length) throw new Error("Film plan is inconsistent: " + planErrs.join("; "));
    es.textContent = "Rendering films…";
    const bits = await call({ type: "plates", ...J.filmRequest(s, ctx, r, work, pl, geom) }, [], j => { es.textContent = `Rendered ${j + 1}/${pl.length} films…`; });
    const trace = s.formats.svg && st.mode === "spot" ? await import("./vector.js") : null;
    const rgbaPNG = (rgba, W, H) => { const c = document.createElement("canvas"); c.width = W; c.height = H; c.getContext("2d").putImageData(new ImageData(rgba, W, H), 0, 0); return out.toPNG(c); };
    await J.writeJob({ s, ctx, work, r, pl, bits, prev: st.prev, proof: st.res.img || null, art: artIn(), zip, slug: slugJob(), trace,
      imported: st.imp ? { from: st.imp.name, kind: st.imp.mode, rescreened: true } : null, profile: jobProfile(),
      platform: { composeFilm: out.composeFilm, toPNG: f => out.toPNG(f.canvas), rgbaPNG }, say: t => { es.textContent = t; return new Promise(res => setTimeout(res, 0)); } });
    if (toFolder) {
      es.textContent = "Writing into the folder…"; let n = 0;
      for (const [path, f] of Object.entries(zip.files)) { if (f.dir) continue; const parts = path.split("/"); let dir = toFolder; for (const d of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(d, { create: true });
        const fh = await dir.getFileHandle(parts[parts.length - 1], { create: true }), w = await fh.createWritable(); await w.write(await f.async("blob")); await w.close(); n++; }
      es.textContent = `Wrote ${n} files into the folder.`; es.className = "small statusline ok"; st.exported = true; renderSummaries();
    } else {
      es.textContent = "Packing…"; const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
      await saveFile("separations.zip", blob); tellPage("separation:export", blob, `${slugJob()}.zip`); es.textContent = `Saved ${pl.length} films, ${(blob.size / 1e6).toFixed(1)} MB.`; es.className = "small statusline ok"; st.exported = true; renderSummaries();
    }
  } catch (e) { console.error(e); es.textContent = e && e.name === "AbortError" ? "You did not select a folder." : (e.message || String(e)); es.className = "small statusline bad"; }
  finally { st.busy = false; btn.disabled = false; }
}
const slugJob = () => J.jobSlug(settings());

/* ───────────── Report a problem ─────────────
   A plain-text report to copy: the page version, the browser, the screen, the job's settings and the local error log.
   Never the art, its file name or the films. */
function problemReport() {
  const ids = ["garment", "outW", "lpi", "press", "dpi", "screening", "angle", "gain", "minDot", "maxDot", "stackLimit", "choke", "trap", "ubMode", "nInks", "palSrc", "shirts", "mirror", "setupMin", "perHour"];
  const settings = { method: st.method, mode: st.mode, auto: !!st.autoBy, screens: st.res ? plates().length : 0, rating: st.res ? $("rStars").textContent : null, imported_films: !!st.imp, calibrated: !!st.calib,
    ...Object.fromEntries(ids.filter(id => $(id)).map(id => [id, getV(id)])) };
  const version = document.querySelector('meta[name="sep-version"]')?.getAttribute("content") || /** @type {any} */ (window).SEP_VERSION || "not stamped";
  return ["Separation Table problem report", `Version: ${version}`, `Page: ${location.pathname}`, `Browser: ${navigator.userAgent}`, `Screen: ${innerWidth} x ${innerHeight} px, pixel ratio ${devicePixelRatio}, ${navigator.hardwareConcurrency || "?"} cores`,
    "What happened (type it here):", "", "Settings:", JSON.stringify(settings, null, 2), "Errors on this device (newest last):", ...(store.get("errors", []).map(e => `${e.at}  ${e.msg}${e.where ? "  @ " + e.where : ""}`)),
    ...(TIMING ? ["Timing:", ...timings.slice(-30).map(t => `${t.job} ${t.ms} ms`)] : []), "The art and the films are not in this report."].join("\n");
}
function renderReport(note) { const n = store.get("errors", []).length; $("reportNote").textContent = note || (n ? `${n} error${n === 1 ? "" : "s"} kept on this device. Copy the report and send it with a short note of what you did.` : "No errors kept on this device. Copy the report and send it with a short note of what you did."); $("reportClear").disabled = !n; }
$("reportCopy").addEventListener("click", async () => { const t = problemReport(), box = /** @type {HTMLTextAreaElement} */ ($("reportText")); box.value = t; box.hidden = false;
  try { await navigator.clipboard.writeText(t); renderReport("Copied. Paste it into your message. It holds the settings and the errors, not the art."); } catch { box.select(); renderReport("Select the text below and copy it. It holds the settings and the errors, not the art."); }
  store.set("errorsSeen", store.get("errors", []).length); });
$("reportClear").addEventListener("click", () => { store.set("errors", []); store.set("errorsSeen", 0); $("reportText").hidden = true; renderReport("The error log is empty."); });
$("shopOpen").addEventListener("click", () => renderReport());
/* Theme: light, dark, or the device's scheme (the start). index.html sets it before the first paint; this is the switch
   under Shop setup. The pick is kept in the browser. */
{ const root = document.documentElement, mq = matchMedia("(prefers-color-scheme: dark)"), seg = $("themeSeg");
  const set = t => { root.dataset.theme = t; root.dataset.scheme = t === "device" ? (mq.matches ? "dark" : "light") : t; for (const b of seg.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.v === t)); };
  seg.addEventListener("click", e => { const b = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest("button[data-v]")); if (b) { store.set("theme", b.dataset.v); set(/** @type {string} */ (b.dataset.v)); } });
  mq.addEventListener("change", () => set(root.dataset.theme || "device")); set(root.dataset.theme || "device"); }
// an error last time: offer the report once, in the status line
{ const n = store.get("errors", []).length; if (n > store.get("errorsSeen", 0)) { window.setTimeout(() => { if (!st.res && LATER) setStatus("Separation Table had an error last time. Shop setup > Report a problem copies a report for it."); }, 0); store.set("errorsSeen", n); } }

/* ───────────── Press time estimate ─────────────
   Setup minutes per screen and prints per hour are the shop's numbers for each press type, kept in this browser
   (sepbench.presstime). plan.pressTime does the sum; the line under the fields, the job sheet and separation.json show it. */
const ptStore = () => ({ ...PRESS_TIME, ...store.get("presstime", {}) });
function loadPressTime() { const v = ptStore()[$("press").value] || PRESS_TIME.manual; $("setupMin").value = String(v.setupMin); $("perHour").value = String(v.perHour); }
function savePressTime() { const all = ptStore(), su = +$("setupMin").value, ph = +$("perHour").value;
  if (!(su >= 0) || !(ph > 0)) return; all[$("press").value] = { setupMin: su, perHour: ph }; store.set("presstime", all); }
function pressTimeNow(pl = st.res ? plates() : []) { return pressTime({ plates: pl, shirts: +$("shirts").value || 100, press: $("press").value, setupMin: +$("setupMin").value, perHour: +$("perHour").value }); }
function renderPressTime() {
  const e = $("ptLine"), su = +$("setupMin").value, ph = +$("perHour").value;
  if ($("setupMin").value === "" || !(su >= 0) || !(ph > 0)) { e.textContent = "Type the setup minutes for each screen and the prints for each hour to see the press time."; e.className = "small bad"; return; }
  if (!st.res) { e.textContent = "The press time shows when the art is separated."; e.className = "small"; return; }
  e.textContent = pressTimeText(pressTimeNow()).replace(/ x /, " × "); e.className = "small";
}
loadPressTime();
$("press").addEventListener("change", () => { loadPressTime(); renderPressTime(); });
for (const id of ["setupMin", "perHour"]) $(id).addEventListener("input", () => { savePressTime(); renderPressTime(); });
$("shirts").addEventListener("input", renderPressTime);
$("mirror").addEventListener("change", () => { renderSummaries(); });

/* ───────────── Re-proof separated films ─────────────
   A Photoshop file with a spot channel per screen, or one TIFF film per screen (filmimport.js), becomes the job's
   screens: the preview, the rating, the screen list and the exports come from the films, not from a new separation.
   Coverage is kept at the preview size (the proof) and at the work size (the exports screen them again). Settings
   changes re-proof the same films; Separate, Auto, the screen count or a print method makes new screens from the art. */
function impNote(t, cls) { const e = $("impNote"); e.textContent = t; e.className = "small " + (cls || ""); }
function dropImport() { if (!st.imp) return; st.imp = null; $("impClose").hidden = true; impNote("A Photoshop file with one spot channel for each screen, or one TIFF film for each screen."); }
/** The imported screens at the export's working size: the separation the films and the Photoshop file are made from. */
function importedAt(work) {
  const im = st.imp, N = st.inks.length, P = work.W * work.H, at = work.W === st.prev.W ? "prev" : "work";
  if (at === "work" && (im.workW !== work.W || im.workH !== work.H)) throw new Error("The imported films do not match the art size. Open the films again.");
  const val = c => at === "prev" ? c.prev : Float32Array.from(c.work, v => v / 255);
  const cov = new Float32Array(P * N), covPct = st.inks.map(() => 0), vis = shownOf(st.inks.map(k => val(im.ch[k.imp])), P);
  st.inks.forEach((k, i) => { const c = vis[i]; for (let q = 0; q < P; q++) { cov[q * N + i] = c[q]; covPct[i] += c[q]; } covPct[i] /= P; });
  const ub = im.ub != null && st.res.ub ? val(im.ch[im.ub]) : null; let ubPct = 0; if (ub) { for (let q = 0; q < P; q++) ubPct += ub[q]; ubPct /= P; }
  return { inks: st.inks, cov, ub, covPct, ubPct, stats: st.res.stats, spotIdx: null, noBase: null, solid: null };
}
/** The part of each imported film's dots that shows on the print, under the job's screening and press overlap. */
const shownOf = (planes, P) => printedToVisible(planes, P, ovp(), ovp() === "same" ? (st.calib && st.calib.overlap != null ? st.calib.overlap : PRESS[$("press").value].rho) : 0);
async function reproofImport() {
  const im = st.imp, N = st.inks.length, P = st.prev.W * st.prev.H;
  st.busy = true; $("run").disabled = true; busyOn("Re-proofing the films…"); setStatus("Re-proofing the films…");
  try {
    const cov = new Float32Array(P * N), vis = shownOf(st.inks.map(k => im.ch[k.imp].prev), P); vis.forEach((c, i) => { for (let q = 0; q < P; q++) cov[q * N + i] = c[q]; });
    const ubIn = im.ub != null ? im.ch[im.ub].prev : null, t0 = performance.now();
    // the films are what they are: no film limits again, no new base, plain halftone overprint
    const ev = await call({ type: "reproof", ...sepParams(st.prev), mode: "sim", screening: "am", film: { minDot: 0, maxDot: 1, lpi: 0, widthIn: +$("outW").value }, cov, inks: st.inks, underbase: !!ubIn, ubIn });
    await call({ type: "restore", cov, ub: ev.ub, W: st.prev.W, H: st.prev.H, mode: st.mode, inks: st.inks, solid: null });
    st.res = { ...ev, inks: st.inks, cov, spotIdx: null, noBase: null, dropped: [], costs: null, gamut: null, lab: st.prev.lab, solid: null, imported: true, ms: performance.now() - t0 };
    st.insp.cx = st.insp.cy = null; st.probe = null; st.hidden.clear(); st.hidRes = null; showStats(); renderOrder(); renderTargets(); renderSummaries(); draw();
    setStatus(`Updated: re-proofed ${N + (ubIn ? 1 : 0)} imported films in ${((performance.now() - t0) / 1000).toFixed(1)} s`, "ok"); st.why = "";
  } catch (e) { console.error(e); setStatus("Re-proof failed: " + e.message, "bad"); }
  finally { st.busy = false; $("run").disabled = false; busyOff(); }
}
/** A file the import cannot use: said in the note, not logged as an error of the page. */
const refuse = (m, user = true) => Object.assign(new Error(m), { user });
async function importFilms(list) {
  const files = [...list]; if (!files.length) return;
  try {
    while (st.busy) await new Promise(r => setTimeout(r, 150));
    const F = await import("./filmimport.js"), { mirrorX } = await import("./output.js");
    const psd = files.filter(f => /\.psd$/i.test(f.name)), tifs = files.filter(f => /\.tiff?$/i.test(f.name)), json = files.find(f => /\.json$/i.test(f.name));
    if (!psd.length && !tifs.length) throw refuse("Choose a Photoshop file (.psd), or the TIFF films (.tif), one for each screen.");
    if (psd.length > 1 || (psd.length && tifs.length)) throw refuse("Choose one Photoshop file, or a set of TIFF films. Not both.");
    impNote("Reading the films…");
    let spec = null; if (json) { try { spec = JSON.parse(await json.text()); } catch { throw refuse(`${json.name} is not JSON.`); } }
    /** @type {any} */ let set;
    if (psd.length) { set = F.readPSD(await psd[0].arrayBuffer()); set.name = psd[0].name; }
    else {
      const parts = [];
      for (const f of tifs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) { try { parts.push({ f, t: F.readTIFF(await f.arrayBuffer()) }); } catch (e) { throw refuse(`${f.name}: ${e.message}`, e.user); } }
      const [a] = parts, bad = parts.find(x => x.t.W !== a.t.W || x.t.H !== a.t.H);
      if (bad) throw refuse(`${bad.f.name} is ${bad.t.W} × ${bad.t.H} px and ${a.f.name} is ${a.t.W} × ${a.t.H} px. All the films must be the same size.`);
      set = { W: a.t.W, H: a.t.H, dpi: a.t.dpi, rgba: null, mode: "tiff", name: parts.length === 1 ? a.f.name : `${parts.length} TIFF films`,
        channels: parts.map(({ f, t }) => { const stem = f.name.replace(/\.tiff?$/i, ""), nm = F.stripOrder(stem); return { name: nm, file: stem, lab: null, ink: t.ink, ub: F.isBaseName(nm), hits: 1 }; }) };
    }
    // each screen's color: the job's separation.json, else the Photoshop channel color, else a library ink of that name
    F.colorChannels(set, spec, st.library, calibratedLab);
    // the art: the Photoshop file's own composite (RGB mode) when no art is open
    if (!st.art && set.rgba) { st.artFile = { name: set.name, W: set.W, H: set.H, info: "The art is the Photoshop file's composite." }; st.sample = false; setArt(set.rgba, set.W, set.H, false); }
    if (!st.art) throw refuse("Open the art first: the rating compares the films with the art. A Photoshop file in RGB mode carries its art.");
    // TIFF films may carry the 0.5 in margin with marks and the label; a Photoshop file is the art's size
    const area = F.artArea(set.W, set.H, set.mode === "tiff" ? set.dpi : null, st.art.W / st.art.H, { widthIn: spec && spec.print && +spec.print.width_in || 0, planes: set.channels.map(c => c.ink) });
    if (!area) throw refuse(`The films are ${set.W} × ${set.H} px and the art is ${st.art.W} × ${st.art.H} px. Their shapes do not match: open the art these films were made from.`);
    // films at true size set the print width
    if (set.dpi) { const w = /** @type {HTMLInputElement} */ ($("outW")), win = Math.round(area.w / set.dpi * 100) / 100; if (win >= +w.min && win <= +w.max) { w.value = String(win); syncH(); renderArtCard(); } }
    impNote("Descreening the films…"); await new Promise(r => setTimeout(r, 0));
    const ws = Math.min(1, WORK_MAX / Math.max(st.art.W, st.art.H)), workW = Math.round(st.art.W * ws), workH = Math.round(st.art.H * ws), lpi = +$("lpi").value || 45, wIn = +$("outW").value || 11;
    // halftone films carry the dot gain compensation: the press puts the gain back (the job's dot gain at 50%)
    const gain = +$("gain").value / 100;
    const ch = F.channelCoverage(set, area, { prevW: st.prev.W, prevH: st.prev.H, workW, workH, lpi, widthIn: wIn, gain });
    // mirrored films (emulsion down) are read the right way round: both ways are proofed against the art and the
    // closer one is kept (a symmetric design proofs the same both ways and stays as read)
    const proofErr = async planes => { const P = st.prev.W * st.prev.H, inks = ch.filter(c => !c.ub);
      const vis = shownOf(ch.map((c, j) => planes[j]).filter((_, j) => !ch[j].ub), P), cov = new Float32Array(P * inks.length); vis.forEach((c, i) => { for (let q = 0; q < P; q++) cov[q * inks.length + i] = c[q]; });
      const ubIn = ch.findIndex(c => c.ub) >= 0 ? planes[ch.findIndex(c => c.ub)] : null;
      const r = await call({ type: "reproof", probe: true, ...sepParams(st.prev), mode: "sim", screening: "am", film: { minDot: 0, maxDot: 1, lpi: 0, widthIn: +$("outW").value }, cov, inks: inks.map(c => ({ name: c.name, lab: c.lab })), underbase: !!ubIn, ubIn });
      return r.stats.mean; };
    impNote("Checking which way the films read…");
    const asRead = await proofErr(ch.map(c => c.prev)), flipped = await proofErr(ch.map(c => mirrorX(c.prev, st.prev.W, st.prev.H))), flip = flipped < asRead - 0.5;
    if (flip) for (const c of ch) { c.prev = mirrorX(c.prev, st.prev.W, st.prev.H); if (c.work) c.work = mirrorX(c.work, workW, workH); }
    // the films become the job: Auto off, their order is the print order, their names and hits are kept
    // what Close the films goes back to: Auto (if it was on) and the screen count
    const before = st.imp ? st.imp.before : { autoBy: st.autoBy || st.autoRunning, nInks: $("nInks").value, method: st.method, res: st.res, inks: st.inks.slice(), salience: st.salience, src: { ...st.src }, outW: $("outW").value };
    st.imp = { name: set.name, mode: set.mode, ch, ub: ch.findIndex(c => c.ub), workW, workH, before }; if (st.imp.ub < 0) st.imp.ub = null;
    st.prod.clear(); st.openRows.clear(); st.chipInfo = null; st.insp.all = true; st.autoBy = false; if (st.autoRunning) { st.autoTok++; st.autoRunning = false; $("auto").disabled = false; }
    if (st.method !== "sim" || st.mode !== "sim") { setMethod("sim", false); document.querySelectorAll("#mode button").forEach(b => b.setAttribute("aria-pressed", String(/** @type {any} */ (b).dataset.v === "sim"))); }
    st.inks = ch.map((c, j) => ({ c, j })).filter(x => !x.c.ub).map(({ c, j }) => ({ name: c.name, lab: c.lab.slice(), source: "imported", locked: true, imp: j }));
    for (const c of ch) if (c.hits === 2 || c.set) st.prod.set(c.ub ? UB_KEY : c.name, { ...(c.hits === 2 && { hits: 2, flashBetween: c.flashBetween }), ...c.set });
    $("nInks").value = String(st.inks.length); $("impClose").hidden = false;
    await reproofImport();
    impNote(`Re-proofed ${set.name}: ${st.inks.length} color screen${st.inks.length === 1 ? "" : "s"}${st.imp.ub != null ? " and an underbase" : ""}${area.x ? ", 0.5 in film margin trimmed" : ""}${flip ? ", mirrored films read the right way round" : ""}. Push Separate to make new screens from the art.`, "ok");
    if (st.step < 3) setStep(3);
  } catch (e) { if (!e.user) console.error(e); impNote(e.message || String(e), "bad"); }
}
$("impOpen").addEventListener("click", () => $("impFile").click());
$("impFile").addEventListener("change", e => { const t = /** @type {HTMLInputElement} */ (e.target); importFilms(t.files || []); t.value = ""; });
// Close the films: the separation that was there before the import comes back as it was (Auto, screen count, inks)
$("impClose").addEventListener("click", async () => { const b = st.imp && st.imp.before; dropImport(); st.why = "art";
  if (b && b.res) { $("nInks").value = b.nInks; if (b.method !== st.method) setMethod(b.method, false); st.salience = b.salience; st.src = b.src; st.autoBy = b.autoBy; $("outW").value = b.outW; syncH(); renderArtCard();
    await putBack({ ...b.res, inks: b.inks }); renderSummaries(); return; }
  st.inks = []; run(true); });
$("export").addEventListener("click", () => exportJob(null));
$("exportFolder").addEventListener("click", async () => { const pick = /** @type {any} */ (window).showDirectoryPicker; if (!pick) return; try { const dir = await pick({ mode: "readwrite" }); await exportJob(dir); } catch (e) { $("expStatus").textContent = "You did not select a folder."; } });
if (!(/** @type {any} */ (window).showDirectoryPicker)) $("exportFolder").hidden = true;

/* ───────────── Wiring ───────────── */
function seg(id, fn) { const el = $(id); el.addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return; el.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", x === b)); fn(b.dataset.v); }); }
/** Views: Art, Compare (the art and the print with a line between), Print (the real films, dot by dot).
    Opening Print opens step 3: its color cards choose which film you see. */
function setView(v, keepMark = false) {
  if (!keepMark && st.mark) { st.mark = null; if (st.res) renderOrder(); }
  // Press: the print as it builds on the press, screen by screen; leaving it shows every screen again
  if (!LATER && (v === "press" || v === "stack")) v = "film"; // a view with no tab: Print
  const press = v === "press"; if (press) v = "sim";
  if (st.pressOn && !press) { st.pressOn = false; st.hidden.clear(); st.hidRes = null; }
  st.pressOn = press; $("pressBar").hidden = !press;
  if (v === "cmp") { st.compare = true; v = "sim"; } else st.compare = false;
  if (v === "film" && st.res && st.step !== 3 && st.view !== "film") setStep(3);
  st.view = v; paintBackdrop(); const on = press ? "press" : st.compare ? "cmp" : v; document.body.dataset.view = on;
  $("view").querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", String(x.dataset.v === on))); if (press) pressStep(st.pressK || 0); else draw();
}
const MODE_HELP = { sim: "Halftone dots mix a few inks into many colors. Use it for photos, gradients and painted art.",
  spot: "Each color prints as one solid screen. Use it for logos, text and flat drawings.",
  index: "Small solid squares print side by side. The look is bold and grainy. It is easy to print on a manual press." };
const TONE_HELP = ["One ink at 45°, the least visible angle. On a dark shirt it prints as one white screen with no base.",
  "Two inks from the art at standard angles: the darker at 45°, the lighter at 75°, so the dots do not make moiré.",
  "Three inks from the art at standard angles: 45°, 75° and 15°, darkest first."];
function methodHelp() {
  if (st.method === "tone") return TONE_HELP[st.tone - 1];
  if (st.method === "cmyk") return "Four process inks (cyan, magenta, yellow, black) at standard angles: C 15°, M 75°, Y 0°, K 45°, yellow at 108% of the line count. Total ink stays under 240%." +
    (garmentLab()[0] < 55 ? " CMYK is a light-shirt method: on a dark shirt it needs the underbase and the colors print duller. Simulated process prints brighter here." : "");
  return MODE_HELP[st.mode];
}
/** Pick a print method. byHand: the user chose it (Auto off, re-separate); Auto passes false and runs itself. */
function setMethod(v, byHand) {
  const was = methodKey(), fixed = v === "cmyk" || v === "tone";
  // CMYK and 1–3 colors set the screen count; leaving them gives back the count you had before
  if (fixed && !was) st.freeK = +$("nInks").value || 6; else if (!fixed && was && st.freeK) $("nInks").value = String(st.freeK);
  st.method = v; st.mode = v === "spot" || v === "index" ? v : "sim"; $("tonePick").hidden = v !== "tone";
  for (const id of ["nInks", "inkMinus", "inkPlus"]) /** @type {HTMLInputElement} */ ($(id)).disabled = fixed;
  if (v === "tone") $("nInks").value = String(st.tone); else if (v === "cmyk") $("nInks").value = "4";
  $("modeHelp").textContent = methodHelp();
  if (!byHand) return;
  if (st.imp) dropImport();
  st.methodPicked = true; st.why = "print method";
  // a method brings its own inks (process inks, or the art's best 1–3): inks from another method do not carry over
  const fresh = !!(was || methodKey()); if (fresh) st.inks = [];
  // on Auto, a new method gets Auto's best settings for it; off Auto, the current settings are kept
  if (st.autoBy || st.autoRunning) { st.inks = st.inks.filter(i => i.locked && !i.chosen); autoSettings(true); return; }
  run(fresh);
}
seg("mode", v => setMethod(v, true));
$("screening").addEventListener("input", syncLockNote);
// interlocked screens solve each spot with at most two inks, so going into or out of them separates again
$("screening").addEventListener("change", () => { syncLockNote();
  if (st.res && st.mode === "sim" && !!st.res.lock !== (ovp() === "lock")) { st.why = "screening"; run(false); } });
$("tonePick").addEventListener("click", e => { const b = /** @type {HTMLElement} */ (e.target).closest("button"); if (!b) return;
  st.tone = +(b.dataset.n || 2); $("tonePick").querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
  $("nInks").value = String(st.tone); $("modeHelp").textContent = methodHelp(); st.why = "colors"; st.methodPicked = true; st.inks = []; if (st.autoBy || st.autoRunning) autoSettings(true); else run(true); });
seg("view", v => setView(v));
/** The zoom button's next step: Fit → 100% → 200% → 400% → Fit (from a slider zoom: the next step up). */
const ZSTEPS = [1, 2, 4];
function zNext() { const z = st.insp.z; if (z === "fit") return 1; return ZSTEPS.find(s => s > /** @type {number} */ (z) + 1e-3) ?? "fit"; }
$("z100").addEventListener("click", () => { if (st.insp.z === "fit") st.insp.cx = st.insp.cy = null; st.insp.z = zClamp(1); draw(); zoomTip(true); });
// FIT only fits; zooming in is a single tap on the image (one step at the spot you tap)
$("zStep").addEventListener("click", () => { st.insp.z = "fit"; draw(); zoomTip(true); });
// the slider keeps the center of the current view in place; it re-renders the films shortly after you stop moving it
/** While the slider moves, its percent floats above the handle (above the finger), then fades. */
let tipT = 0;
function zoomTip(show = true) { const sl = /** @type {HTMLInputElement} */ ($("zoomSlider")), tip = $("zoomPct"), f = (+sl.value - +sl.min) / ((+sl.max - +sl.min) || 1), th = 24;
  tip.style.left = `${th / 2 + f * (sl.clientWidth - th)}px`; clearTimeout(tipT); tip.classList.toggle("on", show); if (show) tipT = window.setTimeout(() => tip.classList.remove("on"), 1400); }
["pointerdown", "input", "focus"].forEach(ev => $("zoomSlider").addEventListener(ev, () => zoomTip(true)));
// Touch screens: the slider row reads the finger itself (the slider takes no touches, bench.css), so a scroll that
// starts on it never zooms: a sideways drag moves the zoom, a tap jumps to that spot, an up/down drag only scrolls the
// page (touch-action pan-y). A native slider jumps to the finger the moment it comes down, even when it goes on to scroll.
{ const sl = /** @type {HTMLInputElement} */ ($("zoomSlider")), row = /** @type {HTMLElement} */ (sl.parentElement);
  let g = /** @type {{ id: number, x: number, y: number, top: number, mode: string } | null} */ (null);
  const setAt = x => { const r = sl.getBoundingClientRect(), th = 24, f = Math.max(0, Math.min(1, (x - r.left - th / 2) / Math.max(1, r.width - th)));
    sl.value = String(+sl.min + f * (+sl.max - +sl.min)); sl.dispatchEvent(new Event("input", { bubbles: true })); };
  // the native slider takes no pointer at all (bench.css): device detection missed phones in some browsers and the
  // slider jumped to the finger. A mouse or pen drags the row like the slider did; the keyboard still moves the slider.
  row.addEventListener("pointerdown", e => {
    if (e.pointerType !== "touch") { if (e.button !== 0) return;
      g = { id: e.pointerId, x: e.clientX, y: e.clientY, top: row.getBoundingClientRect().top, mode: "h" }; row.setPointerCapture(e.pointerId); setAt(e.clientX); return; }
    g = { id: e.pointerId, x: e.clientX, y: e.clientY, top: row.getBoundingClientRect().top, mode: "" }; });
  row.addEventListener("pointermove", e => { if (!g || e.pointerId !== g.id) return; const dx = e.clientX - g.x, dy = e.clientY - g.y;
    if (!g.mode && Math.hypot(dx, dy) > 8) { g.mode = Math.abs(dx) > Math.abs(dy) ? "h" : "v"; if (g.mode === "h") row.setPointerCapture(e.pointerId); }
    if (g.mode === "h") setAt(e.clientX); });
  // a tap is a finger that did not travel and a row that did not move: a scroll can take over before the first move
  // arrives, and some browsers then end it with pointerup at the starting point (that read as a tap and jumped the zoom)
  row.addEventListener("pointerup", e => { if (!g || e.pointerId !== g.id) return; if (!g.mode && Math.hypot(e.clientX - g.x, e.clientY - g.y) <= 8 && Math.abs(row.getBoundingClientRect().top - g.top) <= 8) setAt(e.clientX); if (g.mode !== "v") sl.dispatchEvent(new Event("change", { bubbles: true })); g = null; });
  row.addEventListener("pointercancel", () => { g = null; }); }
{ let t = 0; $("zoomSlider").addEventListener("input", e => { const v = +e.target.value, atFit = v <= +e.target.min + 0.02, z = atFit ? zFit() : zClamp(2 ** v);
  if (st.insp.z === "fit" && !atFit) st.insp.cx = st.insp.cy = null; st.insp.z = atFit ? "fit" : z; $("zoomPct").textContent = atFit ? "Fit" : `${Math.round(z * 100)}%`; clearTimeout(t); t = setTimeout(draw, 90); }); }
/** Zoom Inspect one or more levels in (steps > 0) or out, keeping the film point under (u, v) of the image in place. */
/** A tap zooms in a quarter of the slider's range (Fit to 800%) at the tapped spot; from 800% it goes back to Fit. */
function zoomQuarter(u, v) {
  const vw = st.insp.view; if (st.insp.z === "fit" || !vw) setProbe(u, v); else setProbe((vw.x0 + u * vw.w) / vw.Wp, (vw.y0 + v * vw.h) / vw.Hp);
  const lo = Math.log2(zFit()), hi = Math.log2(ZMAX), cur = st.insp.z === "fit" ? lo : Math.log2(/** @type {number} */ (st.insp.z));
  if (cur >= hi - 1e-3) { st.insp.z = "fit"; draw(); } else zoomAt(Math.min(hi, cur + (hi - lo) / 4) - cur, u, v);
  zoomTip(true);
}
/** Point readout: the tapped spot of the design (0..1). Each color card then shows that screen's film % there: the dot
    size the film carries (after overprint compensation and the stack limit), and the base before its choke. */
function setProbe(fx, fy) {
  if (!st.res || !st.prev) return; const W = st.prev.W, H = st.prev.H;
  st.probe = { fx, fy, q: Math.min(H - 1, Math.floor(fy * H)) * W + Math.min(W - 1, Math.floor(fx * W)) };
}
let probeFilm = /** @type {{ res: any, key: string, printed: Float32Array } | null} */ (null);
/** Film % per screen index (inks, then the base at N) at the probe, or null. */
function probeValues() {
  const r = st.res, pr = st.probe; if (!r || !pr || !st.prev) return null;
  const N = st.inks.length, P = st.prev.W * st.prev.H, fm = $("screening").value === "fm", key = [ovp(), stackLim(), $("press").value, fm].join("|");
  if (!probeFilm || probeFilm.res !== r || probeFilm.key !== key || !probeFilm.printed) {
    if (!pipe) { import("./pipeline.js").then(m => { pipe = m; renderScreens(); }); return null; }
    probeFilm = { res: r, key, printed: pipe.printedFrom(r.cov, N, P, st.mode, fm ? "fm" : "am", ovp(), st.calib && st.calib.overlap != null ? st.calib.overlap : PRESS[$("press").value].rho, r.ub, stackLim()) };
  }
  const out = []; for (let i = 0; i < N; i++) out.push(probeFilm.printed[pr.q * N + i]); out.push(r.ub ? r.ub[pr.q] : 0); return out;
}
let pipe = /** @type {any} */ (null);
function zoomAt(steps, u, v) {
  // steps: +1 doubles the zoom, −1 halves it; below 50% goes to Fit. The film point under (u, v) stays in place.
  const z0 = st.insp.z, fit = z0 === "fit", z1 = fit ? (steps > 0 ? zFit() * 2 ** steps : null) : /** @type {number} */ (z0) * 2 ** steps;
  let fx, fy;
  if (fit || !st.insp.view) { fx = u; fy = v; }
  else { const vw = st.insp.view; fx = (vw.x0 + u * vw.w) / vw.Wp; fy = (vw.y0 + v * vw.h) / vw.Hp; }
  if (z1 === null || z1 <= zFit() + 1e-9) { st.insp.z = "fit"; draw(); return; }
  st.insp.z = zClamp(z1); const g = inspGeom();
  st.insp.cx = fx + (0.5 - u) * g.w / g.Wp; st.insp.cy = fy + (0.5 - v) * g.h / g.Hp; draw();
}
// Inspect: drag to move (the image follows the pointer, then the films re-render there); in Fit, tap a spot to inspect it.
// In Fit a finger on the image scrolls the page (touch-action pan-y, bench.css): it zooms on a tap only (moved under 8 px,
// released within 400 ms), not when the finger comes down, so a scroll that starts on the image never zooms it.
{ const cv = $("view0"); let drag = null, fitTap = /** @type {{ x: number, y: number, t: number } | null} */ (null);
  cv.addEventListener("pointerdown", e => { fitTap = null; if (st.view !== "film") return; if (st.insp.z === "fit") { fitTap = { x: e.clientX, y: e.clientY, t: e.timeStamp }; return; }
    drag = { x: e.clientX, y: e.clientY, id: e.pointerId }; cv.setPointerCapture(e.pointerId); e.preventDefault(); });
  cv.addEventListener("pointerup", e => { const t = fitTap; fitTap = null; if (!t || st.view !== "film" || st.insp.z !== "fit" || Math.hypot(e.clientX - t.x, e.clientY - t.y) > 8 || e.timeStamp - t.t > 400) return;
    const r = cv.getBoundingClientRect(); zoomQuarter((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height); });
  cv.addEventListener("pointercancel", () => { fitTap = null; });
  cv.addEventListener("pointermove", e => { if (!drag) return; cv.style.transform = `translate(${e.clientX - drag.x}px, ${e.clientY - drag.y}px)`; });
  const end = e => { if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag = null;
    // a tap (no drag) zooms in one step at that spot: 100% → 200% → 400% → 800%, then back to Fit
    if (Math.abs(dx) + Math.abs(dy) < 3) { cv.style.transform = ""; if (!pinch) { zoomQuarter(...rel(e.clientX, e.clientY)); } return; }
    const { Wp, Hp, z } = inspGeom(); st.insp.cx -= dx / z / Wp; st.insp.cy -= dy / z / Hp; draw(); };
  cv.addEventListener("pointerup", end); cv.addEventListener("pointercancel", end);
  const rel = (x, y) => { const r = cv.getBoundingClientRect(); return [Math.max(0, Math.min(1, (x - r.left) / r.width)), Math.max(0, Math.min(1, (y - r.top) / r.height))]; };
  // trackpad pinch and Ctrl/⌘ + wheel zoom at the pointer; a plain wheel still scrolls the page
  let wheelAcc = 0, wheelT = 0;
  cv.addEventListener("wheel", e => { if (st.view !== "film" || !(e.ctrlKey || e.metaKey)) return; e.preventDefault(); wheelAcc += e.deltaY;
    clearTimeout(wheelT); wheelT = setTimeout(() => { const st2 = wheelAcc < 0 ? 1 : -1; wheelAcc = 0; zoomAt(st2, ...rel(e.clientX, e.clientY)); }, 120); }, { passive: false });
  // double-click or double-tap zooms in at that point
  // two-finger pinch on touch screens: the image scales live, then snaps to the nearest zoom level around the pinch center
  const touches = new Map(); let pinch = null;
  cv.addEventListener("pointerdown", e => { if (st.view !== "film" || e.pointerType !== "touch") return; touches.set(e.pointerId, [e.clientX, e.clientY]);
    if (touches.size === 2) { const [a1, b1] = [...touches.values()]; pinch = { d: Math.hypot(a1[0] - b1[0], a1[1] - b1[1]), m: [(a1[0] + b1[0]) / 2, (a1[1] + b1[1]) / 2], k: 1 }; drag = null; } });
  cv.addEventListener("pointermove", e => { if (!touches.has(e.pointerId)) return; touches.set(e.pointerId, [e.clientX, e.clientY]);
    if (pinch && touches.size === 2) { const [a1, b1] = [...touches.values()]; pinch.k = Math.hypot(a1[0] - b1[0], a1[1] - b1[1]) / Math.max(1, pinch.d); cv.style.transform = `scale(${pinch.k})`; } });
  const tEnd = e => { touches.delete(e.pointerId); if (pinch && touches.size < 2) { const k = pinch.k, m = pinch.m; pinch = null; cv.style.transform = ""; const steps = Math.round(Math.log2(k)); if (steps) zoomAt(steps, ...rel(m[0], m[1])); } };
  cv.addEventListener("pointerup", tEnd); cv.addEventListener("pointercancel", tEnd); }
$("run").addEventListener("click", () => { $("autoNote").hidden = true; if (st.imp) { dropImport(); st.inks = []; } run(!(st.autoBy && st.inks.length)); });
$("auto").addEventListener("click", () => { if (st.imp) { dropImport(); st.inks = []; } autoSettings(); });
// Simple controls: shirt chips, screen stepper, art-type help
/** The preview backdrop takes the garment color in the views that show the print; films stay on neutral gray. */
/** The workspace backdrop is the garment color, except behind a single film (black ink on white film). */
function paintBackdrop() { const v = st.view, onGarment = !(v === "film" && st.res && !st.insp.all); /** @type {HTMLElement} */ (document.querySelector(".canvasbox")).style.background = onGarment ? $("garment").value : ""; }
function markShirt() { paintBackdrop(); const v = $("garment").value.toLowerCase(); document.querySelectorAll("#shirtChips button").forEach(/** @param {any} b */ b => b.setAttribute("aria-pressed", String(b.dataset.hex === v))); }
/** Step 2 (garment, size, LPI, press) comes before step 3: while the job is on Auto, a change there runs Auto again so
    the art type, screens and Advanced settings are chosen for the new garment or press. Off Auto it just separates again. */
function step2Changed(why, repick) { st.why = why; $("modeHelp").textContent = methodHelp(); if ((st.autoBy || st.autoRunning) && st.res) autoSettings(true); else run(repick); }
document.querySelectorAll("#shirtChips button").forEach(/** @param {any} b */ b => b.addEventListener("click", () => { $("garment").value = b.dataset.hex; markShirt(); renderArtCard(); step2Changed("garment color", true); }));
$("garment").addEventListener("input", () => { markShirt(); renderArtCard(); }); markShirt();
$("outW").addEventListener("input", renderArtCard);
const stepInks = d => { if (st.imp) { dropImport(); st.inks = []; } const el = $("nInks"), v = Math.max(1, Math.min(12, (+el.value || 6) + d)); if (v !== +el.value) { el.value = String(v); st.autoBy = false; run(true); } };
$("inkMinus").addEventListener("click", () => stepInks(-1)); $("inkPlus").addEventListener("click", () => stepInks(1));
$("garment").addEventListener("change", () => step2Changed("garment color", true));
for (const [id, fmt] of /** @type {[string, (v: number) => string][]} */ ([["smooth", v => Math.round(v * 100) + "%"], ["rare", v => (v * 100).toFixed(2) + "%"]])) { const upd = () => $(id + "V").textContent = fmt(+$(id).value); upd(); $(id).addEventListener("input", upd); }
$("smooth").addEventListener("change", () => run(false)); $("rare").addEventListener("change", () => run(true));
["nInks", "palSrc", "forceWhite"].forEach(id => $(id).addEventListener("change", () => { if (id !== "forceWhite") st.autoBy = false; run(true); }));
["ubMode", "ubStrength", "cleanSpot", "solidDetail", "opacity", "trap"].forEach(id => $(id).addEventListener("change", () => run(false)));
{ const upd = () => $("opacityV").textContent = Math.round(+$("opacity").value * 100) + "%"; upd(); $("opacity").addEventListener("input", upd); }
["screening", "angle", "dotShape", "dpi", "gain", "choke", "indexDpi", "stackLimit"].forEach(id => $(id).addEventListener("change", () => { if (st.res) renderOrder(); if (st.view === "film") draw(); }));
// These change what the films can print (smallest and largest dot, detail per halftone cell), so the proof and score update.
/** @type {[string, string][]} */ ([["lpi", "LPI"], ["outW", "print width"]]).forEach(([id, why]) => $(id).addEventListener("change", () => step2Changed(why, false)));
/** @type {[string, string][]} */ ([["minDot", "smallest dot"], ["scatter", "small-dot setting"], ["maxDot", "largest dot"]]).forEach(([id, why]) => $(id).addEventListener("change", () => { st.why = why; run(false); }));
const drop = $("drop");
// the drop area and the art card are <label for="file">: a tap opens the file picker natively (iPhone Safari can ignore a
// script click on a hidden file input). Enter / Space do the same from the keyboard.
drop.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("file").click(); } });
$("file").addEventListener("change", e => { loadFile(e.target.files[0]); e.target.value = ""; });
// the art card in step 1 ("Replace") opens the file picker too: once art is loaded it is the only upload control
$("fileCard").addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("file").click(); } });
drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("on"); }); drop.addEventListener("dragleave", () => drop.classList.remove("on"));
drop.addEventListener("drop", e => { e.preventDefault(); drop.classList.remove("on"); loadFile(e.dataTransfer.files[0]); });

// Press changes how far screens drift, which the separation compensates for, so it re-separates.
$("press").addEventListener("change", () => step2Changed("press", false));
/* ───────────── Adjust the art ─────────────
   Sliders move as you drag (the value shows at once); the separation runs when you let go. */
const ADJ_UI = /** @type {[keyof typeof ADJ0, string, (v: number) => string][]} */ ([["bright", "adjBright", v => (v > 0 ? "+" : "") + v], ["contrast", "adjContrast", v => (v > 0 ? "+" : "") + v],
  ["sat", "adjSat", v => (v > 0 ? "+" : "") + v], ["vib", "adjVib", v => (v > 0 ? "+" : "") + v], ["black", "adjBlack", v => String(v)], ["white", "adjWhite", v => String(v)],
  ["hue", "adjHue", v => (v > 0 ? "+" : "") + v + "°"], ["sharpen", "adjSharpen", v => String(v)]]);
function renderAdjust() {
  for (const [k, id, fmt] of ADJ_UI) { const e = /** @type {HTMLInputElement} */ ($(id)); e.value = String(st.adj[k]); $(id + "V").textContent = fmt(st.adj[k]); e.closest(".field")?.classList.toggle("moved", st.adj[k] !== ADJ0[k]); }
  const n = isNeutral(st.adj), b = $("adjBefore"); b.disabled = n && !st.adjOff; b.setAttribute("aria-pressed", String(st.adjOff)); b.textContent = st.adjOff ? "Show after" : "Show before";
  /** @type {HTMLButtonElement} */ ($("adjReset")).disabled = n;
  $("adjNote").textContent = st.adjOff ? "Before: the separation reads the art without your adjustments." : n ? "The separation reads the art as it is. Your file does not change." : "The separation reads the adjusted art: every screen, the underbase and the films. Your file does not change.";
}
for (const [k, id, fmt] of ADJ_UI) { const e = /** @type {HTMLInputElement} */ ($(id));
  e.addEventListener("input", () => { $(id + "V").textContent = fmt(+e.value); });
  e.addEventListener("change", () => { let v = +e.value;
    if (k === "black") v = Math.min(v, st.adj.white - 10); if (k === "white") v = Math.max(v, st.adj.black + 10);
    st.adj = { ...st.adj, [k]: v }; st.adjOff = false; artAdjusted(); });
  e.addEventListener("dblclick", () => { st.adj = { ...st.adj, [k]: ADJ0[k] }; artAdjusted(); }); }
$("adjBefore").addEventListener("click", () => { st.adjOff = !st.adjOff; artAdjusted(); });
$("adjReset").addEventListener("click", () => { st.adj = { ...ADJ0 }; st.adjOff = false; artAdjusted(); });
renderAdjust();
// Help: "?" notes in place, plus a searchable panel. Escape and the backdrop close it.
attachHelp = initHelp(); $("helpVersion").textContent = `Separation Table version ${VERSION}`;
{ const d = $("helpPanel"); $("helpOpen").addEventListener("click", () => { d.showModal(); $("helpQ").focus(); }); $("helpClose").addEventListener("click", () => d.close());
  d.addEventListener("click", e => { if (e.target === d) d.close(); }); }
/* ───────────── Auto and Default for the finer settings ─────────────
   Each finer setting remembers where its value came from (st.src): Auto, Default (the standard value) or Manual (you
   changed it). Its row in Advanced shows that as a mark: green where Auto chose the value from the job, dark where you
   set it (push the mark to give that value back to Auto), empty for a standard value. Auto (Color screens, and the
   line at the top of Advanced) is green only while the whole job is on Auto; changing any setting by hand turns it off.
   Pushing Separate with nothing changed keeps Auto. */
const ADV = { 2: ["dpi", "screening", "angle", "dotShape", "gain", "minDot", "scatter", "maxDot", "stackLimit", "indexDpi"], 3: ["palSrc", "smooth", "rare", "forceWhite", "cleanSpot", "solidDetail", "ubMode", "ubStrength", "choke", "trap", "opacity"] };
const getV = id => $(id).type === "checkbox" ? $(id).checked : $(id).value;
const setV = (id, v) => { const e = $(id); if (e.type === "checkbox") e.checked = !!v; else e.value = String(v); e.dispatchEvent(new Event("input")); };
const DEF = Object.fromEntries([...ADV[2], ...ADV[3]].map(id => [id, getV(id)]));
/** What Auto sets: the standard values, plus what it can choose from the job: the smallest dot the mesh holds (from the
    LPI), trap from the press, ink opacity from your calibration, and from the art the ink source and tonal smoothness. */
function autoVals(best) { return { ...DEF, ...autoChosen(best) }; }
/** Only the values Auto chooses from the job, by control id. Every other setting gets its standard value from Auto. */
function autoChosen(best) {
  // trap 0.4 mm on a manual press: the misregistration test closed ~92% of gaps at 0.1-0.3 mm drift
  const ID = { inkSource: "palSrc" };
  return Object.fromEntries(Object.entries(J.autoChoices(settings(), best, st.calib, st.shop.mesh.color)).map(([k, x]) => [ID[k] || k, String(x)]));
}
/** best: Auto's pick for this job, or null. Its mode and smoothness are kept (st.autoBest) so one value can go back to Auto later. */
function applyAuto(best) { st.autoBest = best ? { mode: best.mode, smooth: best.smooth } : null; const v = autoVals(best); st.salience = best ? best.salience ?? 1 : 1; for (const id of [...ADV[2], ...ADV[3]]) { setV(id, v[id]); st.src[id] = "auto"; } }
/** One setting back to Auto: the value Auto chooses for this job now (its last pick, the LPI, press, fabric and
    calibration). The change event makes the page read the value as it does a typed one; the source is then Auto again. */
function giveBack(id) { setV(id, autoVals(st.autoBest)[id]); $(id).dispatchEvent(new Event("change")); st.src[id] = "auto"; renderAutoState(); $(id).focus(); }
/** A setting changed by hand: it is Manual now, and the job is off Auto. */
function markManual(id) { st.src[id] = "manual"; st.autoBy = false; if (st.autoRunning) { st.autoTok++; st.autoRunning = false; $("auto").disabled = false; setStatus("Updated. Auto stopped: your setting is kept."); } renderAutoState(); }
const PM_TITLE = { auto: "Auto chose this value", hand: "You set this value. Push to give it back to Auto.", std: "Standard value" };
function renderAutoState() {
  const on = !!st.autoBy, ids = [...ADV[2], ...ADV[3]], chosen = autoChosen(st.autoBest), hand = ids.filter(id => st.src[id] === "manual").length;
  for (const b of [$("auto"), $("advAuto")]) { b.classList.toggle("on", on); b.textContent = on ? "✓ Auto" : "Auto"; }
  $("auto").setAttribute("aria-pressed", String(on));
  $("advHand").textContent = hand ? `${hand} set by hand` : on ? "all values from Auto" : "no value set by hand";
  for (const id of ids) {
    const m = /** @type {HTMLElement} */ (document.querySelector(`[data-pm="${id}"]`)), k = st.src[id] === "manual" ? "hand" : st.src[id] === "auto" && id in chosen ? "auto" : "std"; if (m.dataset.k === k) continue;
    // the dark mark is a button (it gives the value back to Auto); the other two only show the source
    const n = document.createElement(k === "hand" ? "button" : "i"); n.className = "pm" + (k === "std" ? "" : " " + k); n.dataset.pm = id; n.dataset.k = k; n.title = PM_TITLE[k];
    if (k === "hand") { /** @type {HTMLButtonElement} */ (n).type = "button"; n.setAttribute("aria-label", `${m.parentElement.querySelector(".pl").firstChild.textContent}: set by hand. Give back to Auto`); }
    m.replaceWith(n);
  }
  renderAdvSums();
}
$("paneSide").addEventListener("click", e => { const m = /** @type {HTMLElement} */ (e.target).closest("button.pm"); if (m) giveBack(/** @type {HTMLElement} */ (m).dataset.pm); });
/** The line a closed group shows: its current values. */
const ADV_SUM = {
  press: () => `${getV("lpi")} LPI · ${$("press").selectedOptions[0].text}`,
  halftone: () => `${{ same: "AM one angle", lock: "AM interlocked", rotated: "AM rotated", fm: "Index" }[getV("screening")]} · ${getV("angle")}° · ${getV("dpi")} dpi`,
  dots: () => `gain ${getV("gain")} · min ${getV("minDot")} · max ${getV("maxDot")} · stack ${getV("stackLimit")}`,
  inks: () => `${getV("palSrc") === "art" ? "Artwork" : "Ink library"} · smooth ${$("smoothV").textContent} · rare ${$("rareV").textContent}`,
  white: () => `Underbase ${getV("ubMode")} · ${getV("ubStrength")}% · choke ${getV("choke")}`,
  edges: () => `trap ${getV("trap")} mm · ${getV("cleanSpot") ? "clean" : "clean off"} · ${getV("solidDetail") ? "solid" : "solid off"}`,
  shirt: () => `ink opacity ${$("opacityV").textContent}`,
};
function renderAdvSums() { document.querySelectorAll("[data-sum]").forEach(/** @param {any} e */ e => { e.textContent = ADV_SUM[e.dataset.sum](); }); }
for (const id of ["lpi", "press", ...ADV[2], ...ADV[3]]) for (const ev of ["input", "change"]) $(id).addEventListener(ev, renderAdvSums);
for (const id of [...ADV[2], ...ADV[3]]) $(id).addEventListener("change", () => markManual(id));
// LPI and press feed Auto's choices: while a setting is on Auto it follows them (before the re-separation reads it)
const followAuto = () => { const v = autoVals(null); for (const id of ["minDot", "trap"]) if (st.src[id] === "auto" && getV(id) !== v[id]) setV(id, v[id]); };
$("lpi").addEventListener("input", followAuto); $("press").addEventListener("change", followAuto, true);
document.querySelectorAll("[data-auto]").forEach(b => b.addEventListener("click", () => autoSettings()));
document.querySelectorAll("[data-def]").forEach(/** @param {any} b */ b => b.addEventListener("click", () => {
  const g = +b.dataset.def; for (const id of ADV[g]) { setV(id, DEF[id]); st.src[id] = "default"; } if (g === 3) st.salience = 1;
  st.autoBy = false; renderAutoState(); st.why = "default settings"; run(g === 3);
}));
renderAutoState();
/* ───────────── v3 layout: steps left, workspace middle, finer settings right ───────────── */
const STEPS = { 1: "Artwork", 2: "Garment / press", 3: "Separation", 4: "Export" };
const phone = () => window.matchMedia("(max-width: 960px)").matches;
/** Steps are always rows. One is open at a time; any can open. Opening one scrolls it to the top
    (on phones, just under the pinned image) and shows its finer settings on the right. */
function stepDone(n) { return n === 1 ? !!st.art : n === 2 || n === 3 ? !!st.res : !!st.exported; }
/** The four step rows. On phones a closed step is one line with [+]; the open step has [−], which folds it (st.fold). */
function renderStepRows() {
  for (let k = 1; k <= 4; k++) {
    const open = k === st.step && !st.fold, done = stepDone(k) && !open, el = $(`step${k}`);
    $(`step${k}Body`).hidden = !open; $(`step${k}Btn`).setAttribute("aria-expanded", String(open)); el.classList.toggle("open", open); el.classList.toggle("done", done);
    $(`step${k}Badge`).textContent = done ? "✓" : String(k);
    $(`sth${k}`).textContent = done ? `${k} ${STEPS[k]}` : STEPS[k];
    $(`step${k}Act`).textContent = open ? "[−]" : "[+]";
  }
}
function setStep(n, scroll = true) {
  st.step = n; st.fold = false; renderStepRows();
  document.querySelectorAll(".sidesec").forEach(/** @param {any} d */ d => d.hidden = !d.dataset.for.split(" ").includes(String(n)));
  $("sideTitle").textContent = STEPS[n];
  placeSide(); renderNav(); if (st.res) renderScreens();
  const el = $(`step${n}`); if (!scroll) return;
  if (phone()) { const doc = el.getBoundingClientRect().top + window.scrollY, max = document.documentElement.scrollHeight - window.innerHeight;
    // Scroll only as far as the step needs: the least scroll that shows the whole step above the Back / Next bar (no
    // scroll at all if it already fits). A step taller than the space stops with its title just under the pinned
    // workspace (on a screen too short to pin it, at the top). The page is not padded to reach that spot.
    const navH = $("mNav").getBoundingClientRect().height, pinned = document.body.classList.contains("nopin") ? 0 : pinnedH();
    const yTop = Math.max(0, Math.floor(doc - pinned - 9)), yFit = Math.max(0, Math.ceil(doc + el.getBoundingClientRect().height - (window.innerHeight - navH) + 9));
    window.scrollTo({ top: Math.min(yFit, yTop, Math.max(0, max)), behavior: "smooth" }); }
  else { const pane = $("paneSteps"); pane.scrollTo({ top: el.offsetTop - pane.offsetTop - 12, behavior: "smooth" }); }
}
// The whole header opens a closed step and folds an open one. The help mark stops the click.
[1, 2, 3, 4].forEach(n => $(`step${n}`).querySelector(".sthead").addEventListener("click", e => {
  if (/** @type {Element} */ (e.target).closest(".q, .hw")) return;
  if (n === st.step && !st.fold) { st.fold = true; renderStepRows(); return; }
  setStep(n);
}));
document.querySelectorAll("[data-next]").forEach(/** @param {any} b */ b => b.addEventListener("click", () => setStep(+b.dataset.next)));
/** On phones the finer settings sit inside the open step (screens inside Separation); on desktop they are the right panel. */
/** On phones the finer settings fold into one "Advanced [+]" row inside the open step; the choice is kept from step to step. */
const advTog = document.createElement("button");
advTog.type = "button"; advTog.className = "advtog"; advTog.id = "advTog"; advTog.setAttribute("aria-controls", "paneSide");
function renderAdv() { advTog.setAttribute("aria-expanded", String(st.advOpen)); advTog.innerHTML = `<span>Advanced</span><b aria-hidden="true">${st.advOpen ? "[−]" : "[+]"}</b>`; $("paneSide").classList.toggle("advopen", st.advOpen); }
advTog.addEventListener("click", () => { st.advOpen = !st.advOpen; renderAdv(); });
function placeSide() {
  const side = $("paneSide"), body = $(`step${st.step || 1}Body`);
  if (phone()) { const nx = body.querySelector(".next"); if (side.parentElement !== body || (nx && side.nextSibling !== nx)) body.insertBefore(side, nx); if (advTog.nextSibling !== side) body.insertBefore(advTog, side); }
  else { if (side.parentElement !== document.querySelector(".v3")) document.querySelector(".v3").appendChild(side); advTog.remove(); }
  // the theme switch is one element: in the title row on a phone, at the foot of the step column on a desktop
  const seg = $("themeSeg"), home = !phone() ? null : document.body.classList.contains("inheader") ? $("shopPanel").querySelector("section") : $("mShop"), box = home ? home.parentElement : document.querySelector(".stepfoot");
  if (seg.parentElement !== box) /** @type {Element} */ (box).insertBefore(seg, home);
  renderAdv();
}
window.matchMedia("(max-width: 960px)").addEventListener("change", () => { placeSide(); renderNav(); if (st.step) renderStepRows(); }); window.addEventListener("resize", () => renderNav());
// phones: the workspace pins at the top of the screen (bench.css) while the rows and the steps scroll under it.
/* Framed in an ADN page (the tool page, the wall), the frame is as tall as the table and the page scrolls, not the
   table, so the table's own scroll never moves. The page's scroll is read instead: y is how far the page has scrolled
   past the frame's top (under the site header and the program header, [data-tool-header]); vh is the height left
   to see. --pin carries y to the sticky offsets in bench.css, so the art pins under the page's headers. */
const frameEl = (() => { try { return window.parent !== window ? window.frameElement : null; } catch { return null; } })();
function parentPin() {
  if (!frameEl) return null;
  try { const P = window.parent, d = P.document, fr = frameEl.getBoundingClientRect();
    const hdr = parseFloat(P.getComputedStyle(d.documentElement).getPropertyValue("--adn-hdr-h")) || 0; let top = hdr, held = hdr;
    d.querySelectorAll("[data-tool-header]").forEach(e => { const r = e.getBoundingClientRect(); if (r.height) { top = Math.max(top, r.bottom); held += r.height; } });
    // vh: the height under the pinned headers once they are held (not while the site header scrolls away), so the
    // art keeps one size while the page scrolls
    return { y: Math.max(0, Math.round(top - fr.top)), vh: Math.max(240, P.innerHeight - held) }; } catch { return null; }
}
/** Phone: the height that stays pinned at the top of the screen, the job tabs and the workspace under them. */
const pinnedH = () => $("tabBar").getBoundingClientRect().height + $("square").getBoundingClientRect().height;
const sq = { timer: 0 };
function syncSq() {
  const r = document.documentElement.style, pp = parentPin(); r.setProperty("--pin", `${pp ? pp.y : 0}px`);
  if (!phone()) { document.body.classList.remove("nopin"); deskFit(); return; }
  // a screen so short (landscape) that the pinned workspace would leave the steps under 160 px: it scrolls away
  const vh = pp ? pp.vh : window.innerHeight, navH = pp ? 0 : $("mNav").getBoundingClientRect().height;
  document.body.classList.toggle("nopin", vh - navH - pinnedH() < 160);
}
/** Desktop: the workspace column is as tall as the window (framed in an ADN page: the height under the page's headers)
    and the workspace takes what the rows under it leave (bench.css, workspace frame). Framed in a page that cannot be
    read there is no height to take: the workspace is a square. */
function deskFit() {
  const pp = parentPin(), h = pp ? pp.vh : window.parent !== window ? 0 : window.innerHeight, r = document.documentElement.style;
  if (h) r.setProperty("--wsh", `${h}px`); else r.removeProperty("--wsh");
}
// Print draws the films at the workspace's size: draw them again once a new size has settled
new ResizeObserver(() => { if (st.view !== "film" || !st.res) return; clearTimeout(sq.timer); sq.timer = window.setTimeout(draw, 150); }).observe($("square"));
window.addEventListener("resize", syncSq); window.addEventListener("scroll", syncSq, { passive: true }); syncSq();
// framed: the page's scroll (any scroller in it) and size move the pinned art
if (frameEl) try { window.parent.document.addEventListener("scroll", syncSq, { passive: true, capture: true }); window.parent.addEventListener("resize", syncSq); } catch { /* other origin */ }
// phones: number fields open the number pad
document.querySelectorAll("input[type=number]").forEach(/** @param {any} i */ i => { i.inputMode = "decimal"; });
// the rating row opens its details under it, in the flow of the rows
function setROpen(o) { st.rOpen = o; $("rating").classList.toggle("open", o); $("dRate").setAttribute("aria-expanded", String(o)); /** @type {HTMLElement} */ ($("dRate").querySelector(".mrarr")).textContent = o ? "▴" : "▾"; }
$("dRate").addEventListener("click", () => setROpen(!st.rOpen));
new ResizeObserver(() => document.documentElement.style.setProperty("--navh", `${$("mNav").getBoundingClientRect().height}px`)).observe($("mNav"));
$("sideClose").addEventListener("click", () => { document.querySelector(".v3").classList.add("noside"); $("sideOpen").hidden = false; });
$("sideOpen").addEventListener("click", () => { document.querySelector(".v3").classList.remove("noside"); $("sideOpen").hidden = true; });
/** Phone bottom bar: Back and Next; on Export, Next is Download films. */
function renderNav() {
  const n = st.step || 1; $("mBack").disabled = n === 1;
  $("mProg").querySelectorAll("i").forEach((b, j) => { b.className = j + 1 === n ? "cur" : stepDone(j + 1) ? "done" : ""; });
  $("mProg").setAttribute("aria-valuenow", String([1, 2, 3, 4].filter(stepDone).length)); $("mProg").setAttribute("aria-label", `Step ${n} of 4`);
  const nx = $("mNext"); nx.textContent = n < 4 ? `Next: ${STEPS[n + 1]} →` : "Download films ↓"; nx.disabled = n === 1 && !st.art;
  // narrow phones: the step name does not fit beside Back
  if (phone() && nx.scrollWidth > nx.clientWidth + 1) nx.textContent = n < 4 ? "Next →" : "Download ↓";
  nx.setAttribute("aria-label", n < 4 ? `Next: ${STEPS[n + 1]}` : "Download films");
}
$("mBack").addEventListener("click", () => setStep(Math.max(1, (st.step || 1) - 1)));
$("mNext").addEventListener("click", () => { const n = st.step || 1; if (n < 4) setStep(n + 1); else $("export").click(); });

$("preflight").addEventListener("click", e => { const r = /** @type {any} */ (e.target).closest("[data-region]"); if (r) { showRegion(r.dataset.region, r.dataset.what); return; }
  const b = /** @type {any} */ (e.target).closest("[data-fix]"); if (!b) return; const k = b.dataset.fix;
  if (k === "upscale") $("upscale").click(); else if (k === "bg") $("bgRemove").click(); else if (k === "mixes") addGamutMixes();
  else if (k === "sizes") { $("shopOpen").click(); window.setTimeout(() => $("hSizes").scrollIntoView({ block: "start" }), 50); }
  else if (k === "palArt") { $("palSrc").value = "art"; $("palSrc").dispatchEvent(new Event("change")); }
  else { const i = k.indexOf(":"), FIX_ID = { w: "outW", lpi: "lpi", choke: "choke", solid: "solidDetail" }, id = FIX_ID[k.slice(0, i)], v = k.slice(i + 1); if (!id) return;
    if ($(id).type === "checkbox") $(id).checked = v === "on"; else $(id).value = v; $(id).dispatchEvent(new Event("input")); $(id).dispatchEvent(new Event("change")); } });

function garmentName() { const v = $("garment").value.toLowerCase(), b = /** @type {any} */ (document.querySelector(`#shirtChips button[data-hex="${v}"]`)); return b ? b.getAttribute("aria-label") : `Custom ${v}`; }
function renderSummaries() {
  const f = st.artFile, ppi = f ? Math.round(f.W / Math.max(1, +$("outW").value || 11)) : 0;
  $("step1Sum").textContent = f ? `${f.name} · ${ppi} ppi` : "Drop your art in the workspace";
  $("step2Sum").textContent = `${garmentName()} · ${lenText(`${$("outW").value}${st.art ? ` × ${$("outH").value}` : ""} in`)} · ${FABRICS[$("fabric").value].name} · ${$("lpi").value} LPI · ${$("press").value === "manual" ? "Manual" : "Automatic"}`;
  const N = st.inks.length, ub = st.res && st.res.ub;
  // Auto is green with a check while its choices (art type, screen count, ink source) are in use; changing one of them ends it
  renderAutoState(); $("autoNote").hidden = true; renderAutoWhy(); renderFewer();
  $("step3Sum").textContent = st.res ? `${methodName()} · ${N} screen${N === 1 ? "" : "s"}${ub ? " + base" : ""}${st.autoBy ? " · by Auto" : ""}` : "Auto runs when you add art";
  $("step4Sum").textContent = st.res ? `${plates().length} films · ${$("shirts").value} prints${mirrored() ? " · mirrored" : ""}` : "Films, mix sheet, Photoshop file";
  renderPressTime();
  // the print size in the corner of the workspace: step 2's width and height, not a control
  $("sizeBadge").hidden = !st.art; $("sizeBadge").textContent = st.art ? lenText(`${(+$("outW").value).toFixed(1)} × ${(+$("outH").value).toFixed(1)} in`) : "";
  if (st.step) { renderStepRows(); renderNav(); }
  $("teeName").textContent = garmentName();
}
["garment", "outW", "lpi", "press", "shirts"].forEach(id => $(id).addEventListener("change", renderSummaries));
/** Width and height are linked by the art's shape: change one and the other follows. −/+ buttons step each field. */
function syncH() { const a = st.art, h = /** @type {HTMLInputElement} */ ($("outH")); if (!a) { h.value = ""; h.disabled = true; return; } h.disabled = false; h.value = String(Math.round(+$("outW").value * a.H / a.W * 100) / 100); }
$("outW").addEventListener("input", syncH);
$("outH").addEventListener("change", () => { const a = st.art, h = +$("outH").value; if (!a || !(h > 0)) return syncH(); const w = /** @type {HTMLInputElement} */ ($("outW"));
  w.value = String(Math.max(+w.min, Math.min(+w.max, Math.round(h * a.W / a.H * 100) / 100))); w.dispatchEvent(new Event("input")); w.dispatchEvent(new Event("change")); });
document.querySelectorAll(".stp").forEach(/** @param {any} b */ b => b.addEventListener("click", () => { const i = /** @type {HTMLInputElement} */ ($(b.dataset.for)); if (i.disabled) return;
  const d = +b.dataset.d, step = Math.abs(d), v = Math.round(((+i.value || 0) + d) / step) * step;
  i.value = String(Math.max(+i.min, Math.min(+i.max, Math.round(v * 100) / 100))); i.dispatchEvent(new Event("input")); i.dispatchEvent(new Event("change")); }));
document.querySelectorAll("#shirtChips button").forEach(b => b.addEventListener("click", renderSummaries));

/** Print rating: stars from the measured scores (plan.printRating), the numbers behind it, and what lowers it most. */
function renderRating() {
  // the rating row: the facts (on press, aligned, in tolerance) on a desktop, one short line on a phone
  const line = (num, pct, de, chk, label, facts = "") => { $("drNum").textContent = num; $("drFill").style.width = pct; $("drFacts").innerHTML = facts; $("mrDe").textContent = de;
    const c = $("drChk"); c.textContent = chk; c.className = "mrchk" + (/✓/.test(chk) ? " ok" : /!/.test(chk) ? " bad" : "");
    $("dRate").setAttribute("aria-label", `${label}${de ? `, ${de.replace(/^· /, "")}` : ""}. Push for details.`); renderNav(); };
  if (!st.res) { $("rStars").textContent = "–"; $("rFacts").innerHTML = ""; $("rWhy").textContent = st.art ? "Separating…" : "No art yet. The rating shows here after the separation."; line("–", "0%", st.art ? "Separating…" : "No rating yet", "", "No print rating yet"); return; }
  const s = st.res.stats, failed = st.checksFailed || 0, R = printRating({ onPress: s.robustMean, aligned: s.mean, inTol: s.cmcWithin2, failedChecks: failed });
  $("rStars").textContent = R.stars.toFixed(1);
  $("rating").className = "rating " + (R.stars >= 4 ? "ok" : R.stars >= 3 ? "warn" : "bad") + (st.rOpen ? " open" : "");
  // every quality number is a model number until the press run: the phone chip says so beside
  // the stars; the desktop row has no width to spare at 1280 px (its facts fill it), so its first fact is named "Model"
  // (the on-press number) and the open panel writes "Model, on press" in full
  line(R.stars.toFixed(1), `${R.stars / 5 * 100}%`, `· model · ${s.robustMean.toFixed(1)} ΔE on press`, failed ? `! ${failed} CHECK${failed > 1 ? "S" : ""}` : "✓ CHECKS", `Print rating ${R.stars.toFixed(1)} of 5, a model number. ${failed ? `${failed} check${failed > 1 ? "s" : ""} to do` : "All checks pass"}`,
    [["Model", `${s.robustMean.toFixed(1)} ΔE`], ["Aligned", `${s.mean.toFixed(1)} ΔE`], ["In tol.", `${Math.round(s.cmcWithin2 * 100)}%`]].map(([k, v]) => `<span><span class="lab">${k}</span><b>${esc(v)}</b></span>`).join(""));
  const f = [["Model, on press", `${s.robustMean.toFixed(1)} ΔE`, `base ${R.base.toFixed(2)}★`], ["Aligned", `${s.mean.toFixed(1)} ΔE`, `${R.alignedStars.toFixed(1)}★ if aligned`], ["In tolerance", `${Math.round(s.cmcWithin2 * 100)}%`, `${R.tol.toFixed(2)}★`], ["Checks", failed ? `${failed} to do` : "✓ all pass", `${R.checks.toFixed(1)}★`]];
  $("rFacts").innerHTML = f.map(([k, v, d]) => `<span><span class="lab">${k}</span><b>${esc(v)}</b><small>${esc(d)}</small></span>`).join("");
  const N = st.inks.length, press = $("press").value, drift = R.alignedStars - R.base;
  const costs = st.res.costs || [], cheap = costs.map((c, i) => [c, i]).filter(([c, i]) => c < 0.25 && !(st.inks[i] && st.inks[i].locked)).sort((a, b) => a[0] - b[0])[0];
  let why;
  if (failed) why = `Lowered most by: ${failed} check${failed > 1 ? "s" : ""} to do (${R.checks.toFixed(1)} stars). See below.`;
  else if (drift >= 0.5) why = `Lowered most by: screens moving on a ${press} press (−${drift.toFixed(1)} stars: ${R.alignedStars.toFixed(1)} when aligned). More screens do not help. Tight registration${press === "manual" ? " or an automatic press" : ""} does.`;
  else if (cheap && N > 2) why = `You can remove the ${st.inks[cheap[1]].name} screen. The print stays almost the same.`;
  else if (R.stars < 3 && N < 12) why = "The inks cannot make all the colors in the art. Add one screen.";
  else if (R.stars >= 4) why = "Ready to print. Download the films in step 4.";
  else why = "Examine Compare. If the areas that are different are important, add one screen.";
  $("rWhy").textContent = why + (st.calib ? "" : " Typical plastisol values until you calibrate your press (Shop setup).");
}

/** The color rows: one per screen in print order, filled with its ink, the text printed on the color. [+] opens a row's
    details (coverage, mesh, angle, cost to remove, grams to mix, ink, Lab, hex, smallest dot); [−] folds it. Each shows the
    order, coverage, mesh and angle, Lab, what removing it costs, and the ink to mix. Flash and cure are printed on the films. Tap a card to see its film in Print; drag the ⠿ grip (or use the arrow keys on it) to change the order. */
function renderScreens() {
  const box = $("scrList"); $("cardsBox").hidden = !st.res; if (!st.res) { box.innerHTML = ""; box.dataset.html = ""; $("scrRow").hidden = $("chipInfo").hidden = true; renderAccent(); return; }
  const pl = plates(), N = st.inks.length, costs = st.res.costs || [], sel = st.view === "film" && !st.insp.all;
  const area = +$("outW").value * (+$("outW").value * st.prev.H / st.prev.W), shirts = Math.max(1, +$("shirts").value || 100);
  const how = p => st.mode === "spot" ? "solid" : $("screening").value === "fm" || st.mode === "index" ? "index" : `${p.angle}°`;
  const pv = st.view === "film" ? probeValues() : null;
  const html = pl.map((p, j) => {
    const i = p.ub ? N : p.idx, k = st.inks[p.idx], cov = p.ub ? st.res.ubPct : st.res.covPct[p.idx], hid = st.hidden.has(i), hex = rgb2hex(lab2rgb(p.lab)), light = p.lab[0] > 62;
    const g = inkGrams({ areaIn2: area, coverage: cov, shirts, kind: p.ub ? "base" : p.lab[0] > 92 ? "white" : "color", hits: p.hits === 2 ? 2 : 1, screens: screensFor(p, $("press").value) });
    const code = p.ub ? "" : [k && k.system, k && k.code].filter(Boolean).join(" ");
    const open = st.openRows.has(i);
    const name = `${p.name}${!p.ub && p.lab[0] > 92 && j === pl.length - 1 ? " · HL" : ""}`, chosen = !p.ub && k && k.chosen;
    const lock = p.ub ? "" : `<button type="button" class="ibtn" data-lock="${i}" aria-pressed="${!!(k && k.locked)}" aria-label="${k && k.locked ? "Unlock" : "Lock"} ${esc(p.name)}" title="Lock: keep this ink when you push Separate"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="11" width="14" height="10"/><path d="${k && k.locked ? "M8 11V7a4 4 0 0 1 8 0v4" : "M8 11V7a4 4 0 0 1 7.5-2"}"/></svg></button>`;
    return `<div class="scard${hid ? " hid" : ""}${sel && st.chan === i ? " cur" : ""}${light ? " lt" : ""}" role="listitem" data-card="${i}"${p.ub ? "" : ` data-ink="${p.idx}"`} style="--ink:${hex}">
      <div class="srow1"><button type="button" class="cpick" data-pick="${i}" title="Show the film for ${esc(p.name)}"><span class="so">${p.order}</span><span class="sbody"><span class="sn">${esc(name)}${chosen ? '<i class="chosen">Chosen</i>' : ""}</span><span class="sl">${(cov * 100).toFixed(1)}% · ${p.mesh} mesh · ${how(p)}${pv ? `<b class="here"> · here ${Math.round(pv[i] * 100)}%</b>` : ""}</span></span></button>
      <span class="sact">${p.ub ? '<span class="ibtn ghost"></span>' : `<button type="button" class="ibtn" data-del="${p.idx}" aria-label="Delete ${esc(p.name)}" title="Delete this screen"${N < 2 ? " disabled" : ""}>×</button>`}${lock || '<span class="ibtn ghost"></span>'}<button type="button" class="sexp" data-exp="${i}" aria-expanded="${open}" aria-label="${open ? "Less" : "More"} about ${esc(p.name)}">${open ? "[−]" : "[+]"}</button>${p.ub ? '<span class="grip ghost"></span>' : `<button type="button" class="grip" data-grip="${p.idx}" aria-label="Move ${esc(p.name)}: drag, or use the arrow keys" title="Drag to change the print order">⠿</button>`}</span></div>
      ${open ? `<dl class="sdet">${[["Coverage", `${(cov * 100).toFixed(1)}%`], ["Mesh", String(p.mesh)], ["Angle", how(p)], ["If removed", p.ub ? "base" : costs[p.idx] != null ? `+${Math.max(0, costs[p.idx]).toFixed(1)} ΔE` : "–"], ["Mix", `${g} g`], ["Ink", code || (p.ub ? "White base" : "Mix to match")], ["Lab D65", p.lab.map(v => Math.round(v)).join(" · ")], ["Hex", hex.toUpperCase()], ["Smallest dot", `${Math.round((p.minDot || 0) * 100)}%`]].map(([a, b]) => `<div><dt>${a}</dt><dd>${esc(b)}</dd></div>`).join("")}</dl>${prodRow(p, i)}` : ""}</div>`; }).join("");
  // rebuild only when something changed: replacing the buttons mid-click would lose the click
  if (box.dataset.html !== html) { box.innerHTML = html; box.dataset.html = html; attachHelp(box); }
  // the screens row, the last row under the workspace: the same screens as color squares. Tap one to see its film and,
  // in the row under the squares, its name, coverage and mesh (again: all the films, the row closes); drag to reorder
  const bar = $("chipBar"), info = $("chipInfo"), ip = st.chipInfo == null ? null : pl.find(p => prodKey(p.ub ? N : p.idx) === st.chipInfo); $("scrRow").hidden = false;
  info.hidden = !ip;
  if (ip) { const html = `<i style="background:${rgb2hex(lab2rgb(ip.lab))}"></i><b>${ip.order} · ${esc(ip.name)}</b><span>${((ip.ub ? st.res.ubPct : st.res.covPct[ip.idx]) * 100).toFixed(1)}% · ${ip.mesh} mesh</span>`; if (info.dataset.html !== html) { info.innerHTML = html; info.dataset.html = html; } }
  const chips = pl.map(p => { const i = p.ub ? N : p.idx, lt = p.lab[0] > 62;
    return `<button type="button" class="chip${lt ? " lt" : ""}${sel && st.chan === i ? " cur" : ""}" role="listitem" aria-pressed="${p === ip}" data-chip="${i}"${p.ub ? "" : ` data-ink="${p.idx}"`} style="--ink:${rgb2hex(lab2rgb(p.lab))}" title="${esc(p.name)}${p.ub ? "" : " · drag to change the order"}" aria-label="${p.order}. ${esc(p.name)}">${p.order}</button>`; }).join("");
  if (bar.dataset.html !== chips) { bar.innerHTML = chips; bar.dataset.html = chips; }
  if (st.refocus != null) { const g = /** @type {HTMLElement} */ (box.querySelector(`[data-grip="${st.refocus}"]`)); st.refocus = null; if (g) g.focus(); }
  const hidNames = pl.filter(p => st.hidden.has(p.ub ? N : p.idx)).map(p => p.name);
  $("scrNote").textContent = hidNames.length ? `Hidden in the print: ${hidNames.join(", ")}.` : pv ? "Here: the film % of each screen at the spot you tapped in Print (the base before its choke). Tap another spot to move it." : "Tap a row to see its details and only its film; tap it again to see all the films. Drag ⠿ to change the print order.";
}
/** The open card's production settings: the screen's name on its film and how many times it prints (double hit). */
function prodRow(p, i) {
  const own = p.ub ? "Underbase" : st.inks[p.idx].name, hv = p.hits === 2 ? (p.flashBetween ? "2f" : "2") : "1";
  return `<div class="sprod"><div class="pf"><span class="pl" data-help="rename">Name</span><input type="text" data-rename="${i}" value="${esc(p.name)}" placeholder="${esc(own)}" maxlength="${NAME_MAX}" enterkeyhint="done" autocomplete="off" aria-label="Name of screen ${p.order} on its film"></div>
    <div class="pf"><span class="pl" data-help="hits">Prints</span><select data-hits="${i}" aria-label="How many times screen ${p.order} prints">${[["1", "Once"], ["2", "Twice"], ["2f", "Twice, flash between"]].map(([v, t]) => `<option value="${v}"${v === hv ? " selected" : ""}>${t}</option>`).join("")}</select></div>${p.ub || st.inks.length < 2 ? "" : `
    <div class="pf"><span class="pl" data-help="merge">Merge</span><select data-merge="${i}" aria-label="Merge screen ${p.order} into another screen"><option value="">Keep this screen</option>${st.inks.map((k, j) => j === p.idx ? "" : `<option value="${j}">Into ${esc(k.name)}</option>`).join("")}</select></div>`}</div>`;
}
/** st.prod key for card i (the underbase card is N). */
const prodKey = i => i === st.inks.length ? UB_KEY : st.inks[i] && st.inks[i].name;
/** Name a screen (blank: the ink's own name again) or set its hits. Neither changes the separation, only the exports. */
function setProd(i, patch) {
  const key = prodKey(i); if (!key) return; const v = { ...(st.prod.get(key) || {}), ...patch };
  if ("label" in patch) { v.label = cleanName(patch.label); if (!v.label || v.label === (i === st.inks.length ? "Underbase" : key)) delete v.label; }
  // a screen's own mesh, LPI and angle (from a separation.json that set_screen made) keep the entry
  if (!v.label && (v.hits || 1) === 1 && v.mesh == null && v.lpi == null && v.angle == null) st.prod.delete(key); else st.prod.set(key, v);
  renderScreens(); renderSummaries();
}
$("scrList").addEventListener("change", e => {
  const t = /** @type {any} */ (e.target);
  if (t.dataset.rename != null) setProd(+t.dataset.rename, { label: t.value });
  else if (t.dataset.hits != null) setProd(+t.dataset.hits, { hits: t.value === "1" ? 1 : 2, flashBetween: t.value === "2f" });
  else if (t.dataset.merge != null && t.value !== "") mergeInk(+t.dataset.merge, +t.value);
});
$("scrList").addEventListener("keydown", e => { const t = /** @type {any} */ (e.target); if (t.dataset && t.dataset.rename != null && e.key === "Enter") { e.preventDefault(); t.blur(); }
  if (t.dataset && t.dataset.rename != null && e.key === "Escape") { t.value = t.defaultValue; t.blur(); } });
/** Open a screen and show only its film in Print; the same screen again folds it and shows all the films. */
function focusScreen(i, info = false) {
  if (st.openRows.has(i)) { st.openRows.clear(); st.insp.all = true; } else { st.openRows = new Set([i]); st.chan = i; st.insp.all = false; }
  st.chipInfo = info && st.openRows.has(i) ? prodKey(i) || null : null; // a screen square also opens its information row
  if (st.view !== "film") setView("film"); else draw();
}
/** Merge a screen into another: its ink goes, the other is kept (locked) and takes its colors in the new separation. */
function mergeInk(from, into) {
  const a = st.inks[from], b = st.inks[into]; if (!a || !b || from === into) return;
  st.inks = J.mergeInks(st.inks, from, into); st.openRows.clear(); st.insp.all = true; $("nInks").value = String(st.inks.length);
  st.why = `${a.name} merged into ${b.name}`; markManual("inks"); run(false);
}
/** Delete a screen (its ink) and separate again without it. */
function deleteInk(idx) {
  if (st.inks.length < 2 || !st.inks[idx]) return; const [k] = st.inks.splice(idx, 1);
  st.openRows.clear(); st.insp.all = true; $("nInks").value = String(Math.max(1, +$("nInks").value - 1)); st.why = `${k.name} removed`; markManual("inks"); run(false);
}
/** Move ink `from` to position `to` in the print order (the underbase always prints first) and separate again in that order. */
function moveInk(from, to) {
  to = Math.max(0, Math.min(st.inks.length - 1, to)); if (from === to) return false;
  const [k] = st.inks.splice(from, 1); st.inks.splice(to, 0, k); st.why = "print order"; markManual("order"); run(false); return true;
}
$("scrList").addEventListener("click", async e => {
  const t = /** @type {HTMLElement} */ (e.target); if (t.closest("[data-grip]") || t.closest(".sprod")) return;
  const lock = /** @type {HTMLElement} */ (t.closest("[data-lock]")), card = /** @type {HTMLElement} */ (t.closest("[data-card]"));
  if (lock) { const k = st.inks[+lock.dataset.lock]; if (k) { k.locked = !k.locked; renderScreens(); } return; }
  const del = /** @type {HTMLElement} */ (t.closest("[data-del]")); if (del) { deleteInk(+del.dataset.del); return; }
  if (!card) return;
  // a row opens and Print shows only its film; clicking the open row folds it and Print shows all the films again
  focusScreen(+card.dataset.card);
});
// keyboard: arrow keys on a grip move that screen earlier or later
$("scrList").addEventListener("keydown", e => {
  const g = /** @type {any} */ (e.target).closest && /** @type {any} */ (e.target).closest("[data-grip]"); if (!g) return;
  const d = e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : 0; if (!d) return;
  e.preventDefault(); const from = +g.dataset.grip; st.refocus = Math.max(0, Math.min(st.inks.length - 1, from + d)); if (!moveInk(from, from + d)) st.refocus = null;
});
// drag: the card lifts under the finger and a dashed slot shows where it will land; dropping reorders and re-separates
{ const box = $("scrList"); /** @type {any} */ let dr = null;
  box.addEventListener("pointerdown", e => {
    const g = /** @type {any} */ (e.target).closest && /** @type {any} */ (e.target).closest("[data-grip]"); if (!g || st.busy) return;
    const card = /** @type {HTMLElement} */ (g.closest("[data-card]")), r = card.getBoundingClientRect(); e.preventDefault();
    const slot = document.createElement("div"); slot.className = "scard slot"; slot.textContent = "Drop here"; slot.style.minHeight = `${r.height}px`;
    card.parentElement.insertBefore(slot, card); card.classList.add("lift"); Object.assign(card.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    dr = { card, slot, from: +g.dataset.grip, x: e.clientX, y: e.clientY, l: r.left, t: r.top, id: e.pointerId, moved: false }; box.setPointerCapture(e.pointerId);
  });
  box.addEventListener("pointermove", e => {
    if (!dr || e.pointerId !== dr.id) return; dr.moved = true; dr.card.style.left = `${dr.l + e.clientX - dr.x}px`; dr.card.style.top = `${dr.t + e.clientY - dr.y}px`;
    // the slot goes before the first ink card that comes after the pointer in reading order
    const cards = [...box.querySelectorAll("[data-ink]")].filter(c => c !== dr.card); let before = null;
    for (const c of cards) { const r = c.getBoundingClientRect(); if (e.clientY < r.top + r.height / 2) { before = c; break; } }
    if (before) { if (dr.slot.nextSibling !== before) box.insertBefore(dr.slot, before); } else if (box.lastElementChild !== dr.slot) box.appendChild(dr.slot);
  });
  const end = e => {
    if (!dr || e.pointerId !== dr.id) return; const d = dr; dr = null;
    const to = [...box.children].filter(c => c === d.slot || (c.hasAttribute("data-ink") && c !== d.card)).indexOf(d.slot);
    d.card.classList.remove("lift"); ["left", "top", "width", "height"].forEach(k => d.card.style.removeProperty(k)); d.slot.remove();
    if (!moveInk(d.from, to)) { box.dataset.html = ""; renderScreens(); }
  };
  box.addEventListener("pointerup", end); box.addEventListener("pointercancel", end); }
// color squares: a tap shows that film (again: all films); drag a square to change the print order; arrow keys move it
{ const bar = $("chipBar"); /** @type {any} */ let d = null;
  // the row scrolls sideways when the screens do not fit. Touch: a swipe scrolls it, a short hold (300 ms) then a move drags
  // the square. Mouse: press and move drags; the wheel or trackpad scrolls.
  bar.addEventListener("pointerdown", e => { const c = /** @type {any} */ (e.target).closest && /** @type {any} */ (e.target).closest("[data-chip]"); if (!c || st.busy) return;
    const touch = e.pointerType === "touch";
    d = /** @type {any} */ ({ c, x: e.clientX, y: e.clientY, id: e.pointerId, drag: false, armed: !touch, timer: 0 });
    if (touch) d.timer = window.setTimeout(() => { if (d && d.c === c) { d.armed = true; bar.setPointerCapture(e.pointerId); c.classList.add("armed"); } }, 300);
    else bar.setPointerCapture(e.pointerId); });
  // once a held square is armed, the finger moves the square, not the row
  bar.addEventListener("touchmove", e => { if (d && d.armed) e.preventDefault(); }, { passive: false });
  bar.addEventListener("pointermove", e => { if (!d || e.pointerId !== d.id) return;
    if (!d.armed) { if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 8) { clearTimeout(d.timer); d = null; } return; } // a swipe: let the row scroll
    if (!d.drag) { if (!d.c.hasAttribute("data-ink") || Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6) return;
      const r = d.c.getBoundingClientRect(); d.drag = true; d.l = r.left; d.t = r.top; d.slot = document.createElement("span"); d.slot.className = "chip slot";
      bar.insertBefore(d.slot, d.c); d.c.classList.add("lift"); Object.assign(d.c.style, { left: `${r.left}px`, top: `${r.top}px` }); }
    d.c.style.left = `${d.l + e.clientX - d.x}px`; d.c.style.top = `${d.t + e.clientY - d.y}px`;
    let before = null; for (const c of bar.querySelectorAll("[data-ink]")) { if (c === d.c) continue; const r = c.getBoundingClientRect(); if (e.clientY < r.top || (e.clientY <= r.bottom && e.clientX < r.left + r.width / 2)) { before = c; break; } }
    if (before) { if (d.slot.nextSibling !== before) bar.insertBefore(d.slot, before); } else if (bar.lastElementChild !== d.slot) bar.appendChild(d.slot); });
  const end = e => { if (!d || e.pointerId !== d.id) return; const x = d; d = null; clearTimeout(x.timer); x.c.classList.remove("armed");
    if (!x.drag) { if (e.type === "pointerup") focusScreen(+x.c.dataset.chip, true); return; }
    const to = [...bar.children].filter(c => c === x.slot || (c.hasAttribute("data-ink") && c !== x.c)).indexOf(x.slot);
    x.c.classList.remove("lift"); x.c.style.removeProperty("left"); x.c.style.removeProperty("top"); x.slot.remove();
    if (!moveInk(+x.c.dataset.ink, to)) { bar.dataset.html = ""; renderScreens(); } };
  bar.addEventListener("pointerup", end); bar.addEventListener("pointercancel", end);
  bar.addEventListener("click", e => { const c = /** @type {any} */ (e.target).closest && /** @type {any} */ (e.target).closest("[data-chip]"); if (c && e.detail === 0) focusScreen(+c.dataset.chip, true); });
  bar.addEventListener("keydown", e => { const c = /** @type {any} */ (e.target).closest && /** @type {any} */ (e.target).closest("[data-ink]"); if (!c) return;
    const k = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : 0; if (!k) return; e.preventDefault(); moveInk(+c.dataset.ink, +c.dataset.ink + k); }); }
/* ───────────── Add ink: from my inks (the shop's library), from colors the art is missing, or a custom color ─────────────
   Added inks are locked ("Chosen"): Separate and Auto keep them and choose the other screens around them. */
const ai = { tab: "art", sel: /** @type {any[]} */ ([]) };
const inkKey = i => `${i.name}|${i.lab.map(v => Math.round(v)).join(",")}`;
const lightHex = hex => { const [r, g, b] = hex2rgb(hex); return 0.3 * r + 0.59 * g + 0.11 * b > 150; };
function nearestLib(lab) { let best = null, bd = Infinity; for (const i of st.library) { const d = de2000(...lab, ...calibratedLab(i)); if (d < bd) { bd = d; best = i; } } return best ? { ink: best, de: bd } : null; }
/** The art's colors the current screens do not print well: pixels off by more than 8 ΔE00, grouped by color (similar
    groups merged), listed by how much of the art they cover, biggest first. */
function missingColors() {
  if (!st.res || !st.res.de || !st.prev) return [];
  const p = st.prev, P = p.W * p.H, e = st.res.de, g = new Map(), minN = Math.max(12, P * 0.00005);
  for (let q = 0; q < P; q++) { if (p.alpha[q] < 128 || e[q] < 8) continue; const L = p.lab[q * 3], a = p.lab[q * 3 + 1], b = p.lab[q * 3 + 2], key = `${Math.floor(L / 8)},${Math.floor(a / 10)},${Math.floor(b / 10)}`;
    let o = g.get(key); if (!o) { o = { n: 0, L: 0, a: 0, b: 0, e: 0 }; g.set(key, o); } o.n++; o.L += L; o.a += a; o.b += b; o.e += e[q]; }
  // merge groups that look alike (within 12 ΔE00), biggest first, so each real color shows once with its whole area
  const cl = [];
  for (const o of [...g.values()].sort((x, y) => y.n - x.n)) { const lab = [o.L / o.n, o.a / o.n, o.b / o.n], c = cl.find(c => de2000(...c.lab, ...lab) < 12);
    if (c) { const t = c.n + o.n; c.lab = c.lab.map((v, i) => (v * c.n + lab[i] * o.n) / t); c.e += o.e; c.n = t; } else cl.push({ lab, n: o.n, e: o.e }); }
  return cl.filter(o => o.n >= minN).map(o => ({ lab: o.lab, area: o.n / P, miss: o.e / o.n, n: o.n }))
    .sort((x, y) => y.n - x.n).slice(0, 8).map(m => ({ ...m, near: nearestLib(m.lab) }));
}
function aiRender() {
  document.querySelectorAll("#aiTabs button").forEach(/** @param {any} b */ b => b.setAttribute("aria-pressed", String(b.dataset.t === ai.tab)));
  $("aiLib").hidden = ai.tab !== "lib"; $("aiArt").hidden = ai.tab !== "art"; $("aiCustom").hidden = ai.tab !== "custom";
  const used = new Set(st.inks.map(inkKey)), selK = new Set(ai.sel.map(inkKey)), q = String($("aiQ").value || "").trim().toLowerCase();
  if (ai.tab === "lib") $("aiGrid").innerHTML = st.library.map((i, j) => ({ i, j })).filter(({ i }) => !q || `${i.name} ${i.system || ""} ${i.code || ""}`.toLowerCase().includes(q)).map(({ i, j }) => {
    const hex = rgb2hex(lab2rgb(calibratedLab(i))), on = selK.has(inkKey(i)), u = used.has(inkKey(i));
    return `<button type="button" class="aiink${on ? " sel" : ""}${u ? " used" : ""}" data-lib="${j}" style="background:${hex};color:${lightHex(hex) ? "#2a2a2d" : "#ffffff"}" aria-pressed="${on}"${u ? ' title="Already a screen"' : ""}>${on ? '<i class="ck">✓</i>' : ""}<b>${esc(i.name)}</b>${i.code ? `<span>${esc([i.system, i.code].filter(Boolean).join(" "))}</span>` : ""}</button>`; }).join("") || '<p class="small">No ink matches. Edit my inks to add yours.</p>';
  if (ai.tab === "art") { const m = missingColors(); ai.miss = m;
    $("aiMiss").innerHTML = m.length ? m.map((c, j) => { const hex = rgb2hex(lab2rgb(c.lab)), use = c.near && c.near.de <= 8, on = selK.has(inkKey(aiFromMiss(c)));
      return `<div class="aimrow"><span class="aisw" style="background:${hex}"></span><span class="aimt"><b>${hex.toUpperCase()}</b><span>${c.area < 0.001 ? "under 0.1" : (c.area * 100).toFixed(1)}% of the art · now off by ${c.miss.toFixed(0)} ΔE · ${use ? `closest ink: ${esc(c.near.ink.name)} (ΔE ${c.near.de.toFixed(1)})` : `no close ink: added as a mix${c.near ? ` (closest ${esc(c.near.ink.name)}, ΔE ${c.near.de.toFixed(0)})` : ""}`}</span></span><button type="button" class="aimadd" data-miss="${j}" aria-pressed="${on}">${on ? "✓ Added" : "Add"}</button></div>`; }).join("")
      : '<p class="small">The screens already print every color in the art within 8 ΔE. Nothing is missing.</p>'; }
  if (ai.tab === "custom") { const hex = $("aiColor").value, lab = rgb2lab(...hex2rgb(hex)), n = nearestLib(lab); $("aiNear").textContent = n ? `Closest ink on your shelf: ${n.ink.name} (ΔE ${n.de.toFixed(1)}). The custom color is added as a mix to match.` : ""; }
  const n = ai.sel.length; $("aiAdd").disabled = !n; $("aiAdd").textContent = n ? `Add ${n} ink${n > 1 ? "s" : ""} · Separate` : "Add";
}
/** A missing color becomes the closest shelf ink when it is within 8 ΔE, otherwise a mix of the art's color. */
function aiFromMiss(c) { return c.near && c.near.de <= 8 ? { ...c.near.ink, lab: calibratedLab(c.near.ink) } : { name: `Mix ${rgb2hex(lab2rgb(c.lab)).toUpperCase()}`, lab: c.lab.map(v => +v.toFixed(2)), source: "art" }; }
function aiToggle(ink) { const k = inkKey(ink), i = ai.sel.findIndex(x => inkKey(x) === k); if (i >= 0) ai.sel.splice(i, 1); else ai.sel.push(ink); aiRender(); }
$("addInk").addEventListener("click", () => { ai.sel = []; ai.tab = "art"; $("aiQ").value = ""; aiRender(); /** @type {HTMLDialogElement} */ ($("addInkDlg")).showModal(); });
$("aiTabs").addEventListener("click", e => { const b = /** @type {any} */ (e.target).closest("[data-t]"); if (!b) return; ai.tab = b.dataset.t;
  if (ai.tab === "custom") { ai.sel = ai.sel.filter(x => !x.custom); const hex = $("aiColor").value; ai.sel.push({ name: `Custom ${hex.toUpperCase()}`, lab: rgb2lab(...hex2rgb(hex)), source: "target", custom: true }); } aiRender(); });
$("aiQ").addEventListener("input", aiRender);
$("aiGrid").addEventListener("click", e => { const b = /** @type {any} */ (e.target).closest("[data-lib]"); if (!b) return; const i = st.library[+b.dataset.lib]; aiToggle({ ...i, lab: calibratedLab(i) }); });
$("aiMiss").addEventListener("click", e => { const b = /** @type {any} */ (e.target).closest("[data-miss]"); if (!b || !ai.miss) return; aiToggle(aiFromMiss(ai.miss[+b.dataset.miss])); });
$("aiColor").addEventListener("input", () => { const hex = $("aiColor").value; ai.sel = ai.sel.filter(x => !x.custom); ai.sel.push({ name: `Custom ${hex.toUpperCase()}`, lab: rgb2lab(...hex2rgb(hex)), source: "target", custom: true }); aiRender(); });
$("aiEdit").addEventListener("click", () => { /** @type {HTMLDialogElement} */ ($("addInkDlg")).close(); $("shopOpen").click(); window.setTimeout(() => { const h = $("hLib"); if (h) h.scrollIntoView({ block: "start" }); }, 50); });
$("aiAdd").addEventListener("click", () => {
  const add = ai.sel.map(i => { const { custom, ...k } = i; return { ...k, locked: true, chosen: true }; }); if (!add.length) return;
  st.inks.push(...add);
  $("nInks").value = String(Math.min(12, +$("nInks").value + add.length)); /** @type {HTMLDialogElement} */ ($("addInkDlg")).close();
  st.why = add.length > 1 ? `${add.length} added inks` : `added ${add[0].name}`; markManual("inks"); run(true);
});
/** Proof of the print with the hidden screens left out, so you can see what each screen adds. */
async function reproofHidden() {
  if (!st.hidden.size || !st.res) { st.hidRes = null; return; }
  const N = st.inks.length, cov = Float32Array.from(st.res.cov); for (const i of st.hidden) if (i < N) for (let q = i; q < cov.length; q += N) cov[q] = 0;
  const ubIn = st.imp && st.imp.ub != null && !st.hidden.has(N) ? st.imp.ch[st.imp.ub].prev : null;
  st.hidRes = await call({ type: "reproof", probe: true, ...sepParams(st.prev), ...(st.imp && { film: { minDot: 0, maxDot: 1, lpi: 0, widthIn: +$("outW").value }, screening: "am", ubIn }), mode: st.mode, cov, noBase: st.res.noBase, inks: st.inks, underbase: st.imp ? !!ubIn : needsUB() && !st.hidden.has(N) });
}

// Print toggles: Compare draws the art left of a line you drag, Show differences draws the difference map
{ const cv = $("view0"); let on = false, raf = 0;
  const moveSplit = x => { const r = cv.getBoundingClientRect(); st.splitX = Math.max(0.02, Math.min(0.98, (x - r.left) / r.width)); cancelAnimationFrame(raf); raf = requestAnimationFrame(draw); };
  cv.addEventListener("pointerdown", e => { if (st.view !== "sim" || !st.compare) return; on = true; cv.setPointerCapture(e.pointerId); moveSplit(e.clientX); });
  cv.addEventListener("pointermove", e => { if (on) moveSplit(e.clientX); });
  cv.addEventListener("pointerup", () => { on = false; }); }

// Drop art anywhere on the page
document.addEventListener("dragover", e => e.preventDefault());
document.addEventListener("drop", e => { if (/** @type {any} */ (e.target).closest && /** @type {any} */ (e.target).closest("#drop")) return; e.preventDefault(); if (e.dataTransfer && e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]); });

// Keys for pros: 1 2 3 views, F fit, + − zoom, C compare (not while typing in a field)
document.addEventListener("keydown", e => {
  const t = /** @type {any} */ (e.target); if (e.metaKey || e.ctrlKey || e.altKey || (t && (t.closest("input, select, textarea") || t.isContentEditable)) || document.querySelector("dialog[open]")) return;
  const k = e.key.toLowerCase();
  if (k === "1") setView("orig"); else if (k === "2") setView("cmp"); else if (k === "3") setView("film");
  else if (k === "f" && st.view === "film") { st.insp.z = "fit"; draw(); }
  else if ((k === "+" || k === "=") && st.view === "film") zoomAt(1, 0.5, 0.5); else if ((k === "-" || k === "_") && st.view === "film") zoomAt(-1, 0.5, 0.5);
  else if (k === "c") setView(st.compare ? "film" : "cmp");
  else return;
  e.preventDefault();
});
renderLibrary(); renderCalib(); renderTargets(); renderProfiles();
function loadSample() { dropImport(); st.prod.clear(); const s = sampleArt(); st.sample = true; st.adj = { ...ADJ0 }; st.adjOff = false; renderAdjust(); st.artFile = { name: "Sample design", W: 1200, H: 1200, info: "Drop your art in the workspace to replace it." }; setArt(s.rgba, s.W, s.H, false); setStep(2); autoSettings(true); }
// Shop setup panel (ink library, calibration, color targets)
$("shopOpen").addEventListener("click", () => { const d = $("shopPanel"); if (!d.open) d.showModal(); });
document.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", () => $(/** @type {any} */ (b).dataset.close).close()));
$("shopPanel").addEventListener("click", e => { if (e.target === $("shopPanel")) $("shopPanel").close(); });
$("trySample").addEventListener("click", loadSample);
// the same, inside the drop box: on the first screen of a phone (step 1's link is under the Back/Next bar there). It
// sits in the drop box's label, so the tap must not also open the file picker.
$("dropSample").addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); loadSample(); });
$("mShop").addEventListener("click", () => $("shopOpen").click());
// Framed in an ADN tool page, the page header has the Help button (?) and the About page; the table hides its own
// help button and links About from the help panel.
if (window.parent !== window) {
  document.body.classList.add("framed");
  window.addEventListener("scroll", () => { if (window.scrollY) window.scrollTo(0, 0); }, { passive: true }); // the page scrolls, not the frame (iOS bounces frames)
  // On the tool's full page (not the wall) the page's program header carries the title and the setup gear.
  try { if (!window.parent.location.pathname.endsWith("/wall")) document.body.classList.add("inheader"); placeSide(); } catch { /* other origin */ }
  $("helpAbout").hidden = false;
  $("helpAbout").querySelector("a").addEventListener("click", e => { e.preventDefault(); $("helpPanel").close(); window.parent.location.hash = "about"; });
}
/* ───────────── Ink stack map ───────────── */
const stackLimitPct = () => J.stackLimit(settings()) * 100;
/** A stack (percent of colour ink) as a heat colour: blue under half the limit, through green to yellow at the limit,
 *  red over it. */
function stackColor(pct, lim) {
  if (pct < 1) return [40, 44, 52]; const t = pct / lim;
  if (t > 1 + STACK_ALLOW * 100 / lim) return [220, 38, 38];
  const k = Math.min(1, t), stops = [[37, 99, 235], [16, 185, 129], [250, 204, 21]], f = k * 2, i = Math.min(1, Math.floor(f)), u = f - i;
  return stops[i].map((c, j) => Math.round(c + (stops[i + 1][j] - c) * u));
}

/* ───────────── Press step-through ─────────────
   The print as it builds on the press: screen 1 alone, then 1 and 2, and so on, with the flash and the cure where the
   job has them. It hides the screens not printed yet and proofs the rest (the same proof as hiding screens by hand). */
async function pressStep(k) {
  if (!st.res) { $("psText").textContent = "Separate the art first: then step through the screens."; $("psPrev").disabled = $("psNext").disabled = true; draw(); return; }
  const pl = plates(), n = pl.length, N = st.inks.length; k = Math.max(1, Math.min(n, k || n)); st.pressK = k; st.pressRes = st.res;
  st.hidden = new Set(pl.filter(p => p.order > k).map(p => p.ub ? N : p.idx));
  const p = pl[k - 1], twice = p.hits === 2 ? (p.flashBetween ? ", twice with a flash between" : ", twice") : "", after = k === n ? "then cure" : p.ub ? "then flash" : "wet on wet";
  $("psText").textContent = `Screen ${k} of ${n}: ${p.name}${twice}, ${after}`; $("psPrev").disabled = k <= 1; $("psNext").disabled = k >= n;
  await reproofHidden(); if (st.pressOn) draw();
}
$("psPrev").addEventListener("click", () => pressStep((st.pressK || 1) - 1)); $("psNext").addEventListener("click", () => pressStep((st.pressK || 1) + 1));

/* ───────────── Garment fabric ─────────────
   The fabric sets what it has a published value for (fleece: the choke) unless you set that by hand, and names the
   base ink, cure and flash on the job sheet and in separation.json (plan.FABRICS, with sources in help and NOTICE). */
function renderFabric() { $("fabricNote").textContent = fabricText($("fabric").value); }
$("fabric").addEventListener("change", () => {
  // the choke follows the fabric (fleece 0.35 mm) unless you set it by hand; Auto's choices include it (job.autoChoices)
  if (st.src.choke !== "manual") setV("choke", autoVals(null).choke);
  renderFabric(); renderSummaries(); if (st.res) renderOrder(); if (st.view === "film") draw();
});
renderFabric();
/** The profile the job is on, for separation.json and the job sheet. */
function jobProfile() { const p = allProfiles().find(q => q.name === st.shop.active); if (!p) return null; let changed = true; try { changed = !sameSettings(currentProfile(p.name), p); } catch { }
  return { name: p.name, changed, ...(p.builtin && { builtin: true, source: p.source }) }; }

/* ───────────── Units ─────────────
   Print size in inches or centimetres. The job keeps inches (separation.json, the films, the CLI); in cm the page
   shows a centimetre width and height and writes every length it shows in cm. Kept under sepbench.units. */
st.units = LATER && store.get("units", "in") === "cm" ? "cm" : "in"; // no Units control without ?later=1: inches
const CM = 2.54, r2 = v => Math.round(v * 100) / 100;
/** A text with inch lengths ("11 in", "16 × 18 in") written in the page's units. */
function lenText(t) {
  if (st.units !== "cm") return t;
  const cm = x => `${+(x * 2.54).toFixed(1)}`;
  return String(t).replace(/(\d+(?:\.\d+)?) × (\d+(?:\.\d+)?) in\b/g, (_, a, b) => `${cm(+a)} × ${cm(+b)} cm`).replace(/(\d+(?:\.\d+)?) in\b/g, (_, a) => `${cm(+a)} cm`);
}
function syncCm() { $("outWcm").value = String(r2(+$("outW").value * CM)); const h = $("outH"); $("outHcm").value = h.value ? String(r2(+h.value * CM)) : ""; $("outHcm").disabled = h.disabled; }
function renderUnits() {
  const cm = st.units === "cm"; $("units").value = st.units; $("whIn").hidden = cm; $("whCm").hidden = !cm; syncCm();
  renderSummaries(); renderArtCard(); if (st.res) renderOrder();
}
$("units").addEventListener("change", () => { st.units = $("units").value === "cm" ? "cm" : "in"; store.set("units", st.units); renderUnits(); });
["outW", "outH"].forEach(id => $(id).addEventListener("input", syncCm));
/** @type {[string, string][]} */ ([["outWcm", "outW"], ["outHcm", "outH"]]).forEach(([c, i]) => $(c).addEventListener("change", () => {
  const v = +$(c).value; if (!(v > 0)) { syncCm(); return; } const e = /** @type {HTMLInputElement} */ ($(i)); e.value = String(Math.max(+e.min, Math.min(+e.max, r2(v / CM))));
  e.dispatchEvent(new Event("input")); e.dispatchEvent(new Event("change")); syncCm(); }));

/* ───────────── Test films ───────────── */
$("tfParam").addEventListener("change", () => { $("tfValues").value = J.TEST_STEPS[$("tfParam").value].values.join(", "); $("tfNote").textContent = "One film, one row of tint patches for each value. The other settings come from the job."; $("tfNote").className = "note small"; });
$("tfMake").addEventListener("click", async () => {
  const note = (t, c = "") => { $("tfNote").textContent = t; $("tfNote").className = "note small" + (c ? " " + c : ""); }, param = $("tfParam").value;
  let vals; try { vals = J.testValues(param, $("tfValues").value); } catch (e) { note(e.message, "bad"); return; }
  $("tfMake").disabled = true; note("Making the test film…");
  try { const out = await import("./output.js"), f = await J.writeTestFilm(settings(), param, vals, { composeFilm: out.composeFilm, toPNG: x => out.toPNG(x.canvas) });
    await saveFile(`test-film-${param.toLowerCase()}.pdf`, f.pdf); note(`Saved test-film-${param.toLowerCase()}.pdf: ${vals.length} rows (${vals.join(", ")}). Print it, then pick the row that holds best and set it in the job.`, "ok"); }
  catch (e) { note(e.message || String(e), "bad"); } finally { $("tfMake").disabled = false; }
});

/* ───────────── Job state: undo, the jobs kept, job tabs ─────────────
   A job's state is its settings (job.SETTINGS, as settings() reads them), the print method, the inks and screen
   names, the art adjustments and where each setting came from. Every settled change (a control, an ink, a separation)
   adds one undo step. One tab is one job. The open job is the page; each other job waits as a record (its state and its
   art as a PNG) in memory, with its own undo steps. The records are also kept in this browser (IndexedDB "sepbench",
   store "jobs"; the art is left out when the browser has no room, and the job then says so), and the tab order and the
   open tab in localStorage (sepbench.tabs, sepbench.job), so every tab comes back after a reload. */
const SET_ID = { garment: "garment", widthIn: "outW", dpi: "dpi", lpi: "lpi", angle: "angle", dot: "dotShape", screening: "screening", press: "press", gain: "gain", minDot: "minDot", maxDot: "maxDot",
  scatter: "scatter", choke: "choke", trap: "trap", indexDpi: "indexDpi", stackLimit: "stackLimit", inkSource: "palSrc", forceWhite: "forceWhite", underbase: "ubMode", ubStrength: "ubStrength",
  opacity: "opacity", smooth: "smooth", rare: "rare", cleanSpot: "cleanSpot", solidDetail: "solidDetail", shirts: "shirts", mirror: "mirror", setupMin: "setupMin", perHour: "perHour", fabric: "fabric",
  minPpi: "minPpi", offCentreIn: "offCentreIn", manualMaxLpi: "manualMaxLpi", smallScreenPct: "smallScreenPct" };
function jobState() {
  return { v: 1, s: settings(), method: st.method, tone: st.tone, inks: st.inks.map(i => ({ ...i })), prod: [...st.prod], adj: { ...st.adj }, adjOff: st.adjOff, src: { ...st.src }, autoBy: !!st.autoBy, autoBest: st.autoBest, salience: st.salience, profile: st.shop.active };
}
/** Put a saved state into the controls and the job; rerun: separate again with its inks. */
async function applyJobState(j, rerun = true) {
  const { s } = J.cleanSettings(j.s);
  st.tone = j.tone || 2; setMethod(j.method || "sim", false);
  document.querySelectorAll("#mode button").forEach(/** @param {any} b */ b => b.setAttribute("aria-pressed", String(b.dataset.v === (j.method || "sim"))));
  for (const [k, id] of Object.entries(SET_ID)) if (s[k] != null && $(id)) setV(id, s[k]);
  for (const k of FORMAT_KEYS) $(FORMAT_IDS[k]).checked = !!s.formats[k];
  if (!methodKey()) $("nInks").value = String(s.screens === "auto" ? 6 : s.screens);
  st.inks = (j.inks || []).map(i => ({ ...i })); st.prod = new Map(j.prod || []); st.adj = { ...ADJ0, ...(j.adj || {}) }; st.adjOff = !!j.adjOff; st.src = { ...(j.src || {}) };
  st.autoBy = !!j.autoBy; st.autoBest = j.autoBest || null; st.salience = j.salience ?? 1; if (j.profile !== undefined) { st.shop.active = j.profile; saveShop(); }
  renderAdjust(); renderFabric(); renderAutoState(); renderProfiles(); renderSummaries(); syncH(); syncCm(); markShirt();
  if (rerun && st.art) { st.artAdj = null; st.prev = downsample(artIn(), PREV_MAX); renderArtCard(); st.why = "undo"; await run(false); }
}
const undo = { past: /** @type {string[]} */ ([]), future: /** @type {string[]} */ ([]), applying: false, t: 0 };
function renderUndo() { $("undo").disabled = undo.past.length < 2; $("redo").disabled = !undo.future.length; }
/** Records the job's state when it settled (after a change, when no separation is running), as one undo step. */
function noteState() { clearTimeout(undo.t); undo.t = window.setTimeout(() => { if (undo.applying || st.busy || st.autoRunning) noteState(); else recordState(); }, 400); }
function recordState() {
  const j = JSON.stringify(jobState()); if (undo.past[undo.past.length - 1] === j) return;
  undo.past.push(j); if (undo.past.length > 50) undo.past.shift(); undo.future = []; renderUndo(); saveJob(); }
/** Undo: the current state goes on the redo list and the one before it comes back. Redo: the reverse. */
async function stepUndo(back) {
  if (changing || (back ? undo.past.length < 2 : !undo.future.length)) return;
  if (back) undo.future.push(/** @type {string} */ (undo.past.pop())); else undo.past.push(/** @type {string} */ (undo.future.pop()));
  undo.applying = true; try { await applyJobState(JSON.parse(undo.past[undo.past.length - 1])); setStatus(back ? "Undone. Redo puts the change back." : "Redone.", "ok"); }
  finally { undo.applying = false; renderUndo(); saveJob(); }
}
$("undo").addEventListener("click", () => stepUndo(true)); $("redo").addEventListener("click", () => stepUndo(false));
document.addEventListener("keydown", e => { const t = /** @type {any} */ (e.target); if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z" || (t && t.closest && t.closest("input[type=text], textarea")) || document.querySelector("dialog[open]")) return;
  e.preventDefault(); stepUndo(!e.shiftKey); });
// a settled change anywhere in the job: the steps, the finer settings, step 4 and the shop's check limits
["paneSteps", "paneSide", "shopPanel"].forEach(id => $(id).addEventListener("change", e => { const t = /** @type {any} */ (e.target); if (t && t.id && !["profSel", "profDefault", "units", "tfParam", "profName", "tfValues"].includes(t.id)) noteState(); }));
$("paneSteps").addEventListener("click", () => noteState());

/* the jobs, in IndexedDB */
const TAB_MAX = 12, CLOSE_UNDO_MS = 10000, LIMIT_NOTE = `${TAB_MAX} jobs are open. Close a job to open a new one.`;
const DB = { db: /** @type {Promise<IDBDatabase> | null} */ (null), failed: false, noRoom: false };
function jobsDB() { return DB.db ??= new Promise((res, rej) => { const r = indexedDB.open("sepbench", 1); r.onupgradeneeded = () => r.result.createObjectStore("jobs", { keyPath: "id" }); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
async function jobsDo(mode, fn) { const db = await jobsDB(); return new Promise((res, rej) => { const tx = db.transaction("jobs", mode), q = fn(tx.objectStore("jobs")); tx.oncomplete = () => res(q && q.result); tx.onerror = tx.onabort = () => rej(tx.error || new Error("The browser did not save the job.")); }); }
/** The browser does not keep jobs (a private window, storage full or blocked): the tabs work from memory, and the page says so once. */
function storeFailed() { if (DB.failed) return; DB.failed = true; jobNote("This browser cannot save jobs (a private window, or its storage is full or blocked). The tabs work until you close the page. Download the films before you close it."); }
/** The status line under the tabs. brief: it goes after 10 seconds. The "Job closed. Undo" part is apart (closeJob). */
let noteT = 0;
function jobNote(t, brief = false) { clearTimeout(noteT); $("jobMsg").textContent = t; $("jobNote").hidden = !t && $("jobClosed").hidden; if (t && brief) noteT = window.setTimeout(() => jobNote(""), CLOSE_UNDO_MS); }

/* Job tabs: tabs is the order on the strip; rec is the job's record while it is not the open job (null: a new job) */
/** undo: its undo steps. auto: what Auto said about it (why, the fewer-screens list), and its open step, while the page is open.
 *  @type {{ id: string, name: string, rec: any, undo?: { past: string[], future: string[] }, auto?: { why: any, fewer: any, note: string, step: number, picked: boolean } }[]} */
let tabs = [];
/** The tab closed last, while Undo can bring it back: its place, and the "New job" tab that took the place of the last tab. */
let closed = /** @type {{ tab: typeof tabs[0], i: number, filler: string, t: number } | null} */ (null);
const tabOf = id => tabs.find(t => t.id === id);
const newId = () => { let id = `job-${Date.now()}`; while (tabOf(id) || (closed && closed.tab.id === id)) id += "0"; return id; };
const jobName = () => st.artFile ? st.artFile.name : "New job";
/** A tab shows its place and the art's file name without the extension. */
const tabLabel = name => String(name).replace(/\.[A-Za-z0-9]{1,5}$/, "");
function saveTabs() { store.set("tabs", tabs.map(t => ({ id: t.id, name: t.name }))); store.set("job", st.jobId); }
/** The open tab at the last draw of the strip, and its width. */
let tabOn = { id: "", w: 0 };
function renderTabs() {
  const cur = tabOf(st.jobId), box = $("tabs"); if (!cur) return;
  if (cur.name !== jobName()) { cur.name = jobName(); saveTabs(); }
  const full = tabs.length >= TAB_MAX;
  box.innerHTML = tabs.map((t, i) => { const n = esc(tabLabel(t.name)), on = t === cur;
    return `<div class="tab${on ? " on" : ""}" role="tab" aria-selected="${on}" data-id="${esc(t.id)}"><button type="button" class="tname" title="${n}">${i + 1} · ${n}</button><button type="button" class="tclose" aria-label="Close ${n}">×</button></div>`; }).join("")
    + `<button type="button" class="tabnew" id="tabNew" aria-label="New job"${full ? ` title="${LIMIT_NOTE}" disabled` : ""}>+</button>`;
  // the open tab stays in view, clear of the + that stays at the right end; on a phone 36 px of the next tab stay in
  // view too, so the strip shows that it scrolls
  const on = /** @type {HTMLElement} */ (box.querySelector(".on")), a = box.getBoundingClientRect(), b = on.getBoundingClientRect();
  const clear = 45 + (phone() && on.nextElementSibling !== $("tabNew") ? 36 : 0);
  if (b.left < a.left) box.scrollLeft -= a.left - b.left; else if (b.right > a.right - clear) box.scrollLeft += b.right - a.right + clear;
  // a phone's open tab is as wide as its name (bench.css). When another tab opens, the two widths change in 0.2 s.
  if (tabOn.id && tabOn.id !== cur.id && phone() && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    const was = [...box.querySelectorAll(".tab")].find(e => /** @type {HTMLElement} */ (e).dataset.id === tabOn.id), opt = { duration: 200, easing: "ease" };
    if (b.width > 121) on.animate([{ width: "120px" }, { width: b.width + "px" }], opt);
    if (was && tabOn.w > 121) was.animate([{ width: tabOn.w + "px" }, { width: "120px" }], opt);
  }
  tabOn = { id: cur.id, w: b.width };
}
/** What the job's tab shows: the view, the zoom and its place, the Compare line, the open screen and the open step. */
const viewState = () => ({ v: document.body.dataset.view || "film", z: st.insp.z, cx: st.insp.cx, cy: st.insp.cy, splitX: st.splitX, rows: [...st.openRows], chan: st.chan, chip: st.chipInfo, step: st.step });
/** Put a tab's view back, after its job is separated again. Press goes back as Print. */
function applyView(w) {
  Object.assign(st.insp, { z: w.z, cx: w.cx, cy: w.cy }); st.splitX = w.splitX;
  st.openRows = new Set(w.rows.filter(i => i <= st.inks.length)); st.insp.all = !st.openRows.size;
  if (st.openRows.size) { st.chan = w.chan; st.chipInfo = w.chip; }
  setView(w.v === "press" ? "film" : w.v, true); if (w.step && w.step !== st.step) setStep(w.step, false);
}
/** The open job as a record: its state, its view, and its art as a PNG (encoded again only when the art changed). */
async function jobRecord(auto = autoLive()) {
  const a = st.art, keep = !!a && !st.sample;
  const rec = { id: st.jobId, name: jobName(), state: jobState(), view: viewState(), at: Date.now(), artFile: keep && st.artFile ? { ...st.artFile } : null, sample: !!st.sample, auto, art: /** @type {Blob | null} */ (null), artMissing: false };
  if (keep && st.savedArt !== a) { const c = document.createElement("canvas"); c.width = a.W; c.height = a.H; c.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(a.rgba), a.W, a.H), 0, 0);
    rec.art = await new Promise(r => c.toBlob(r, "image/png")); if (st.art === a) { st.savedBlob = rec.art; st.savedArt = a; } }
  else if (keep) rec.art = st.savedBlob || null;
  rec.artMissing = keep && !rec.art; return rec;
}
/** Keep a record in this browser. No room for the art: the record without it. No storage at all: the page says so once. */
async function keepRecord(rec) {
  try { await jobsDo("readwrite", o => o.put(rec)); }
  catch { try { await jobsDo("readwrite", o => o.put({ ...rec, art: null, artMissing: rec.artMissing || !!rec.art }));
      if (rec.art && !DB.noRoom) { DB.noRoom = true; jobNote("This browser has no room to keep the art. The settings are kept: drop the art again after a reload."); } }
    catch { storeFailed(); } }
}
let saveT = 0, saveN = 0;
/** Save the open job (state and art): its tab's record, and the copy in this browser. A save that a newer save
    overtook while its art was encoded is dropped. */
function saveJob(now = false, auto = /** @type {boolean | undefined} */ (undefined)) { clearTimeout(saveT); const go = async () => {
  if (!st.art && !st.res && undo.past.length < 2) return;
  const n = ++saveN, t = tabOf(st.jobId), rec = await jobRecord(auto ?? autoLive()); if (n !== saveN) return;
  if (t) t.rec = rec; await keepRecord(rec); };
  if (now) return go(); saveT = window.setTimeout(go, 300); return Promise.resolve(); }
/** The page as a new job has it: no art, no separation, the standard settings. The shop's settings stay. */
async function clearJob() {
  Object.assign(st, JOB0()); Object.assign(st.insp, { z: "fit", cx: null, cy: null, all: true, quiet: false, view: null }); st.insp.tok++;
  restorePristine(); await applyJobState(BLANK, false);
  setView("film"); setStep(1, false); syncH(); renderSummaries(); renderUnits();
}
/** Leave the open job: its Auto stops, a separation in progress ends first (its result belongs to this job), then the
    job is kept as its tab's record with its undo steps. A job left while Auto worked runs Auto again when it opens. */
async function leaveJob() {
  const t = tabOf(st.jobId), auto = autoLive();
  if (auto || st.autoRunning) { st.autoTok++; st.autoRunning = false; $("auto").disabled = false; }
  adjTok++;
  while (st.busy || busyN) await new Promise(r => setTimeout(r, 60));
  clearTimeout(undo.t); if (!auto) recordState();
  await saveJob(true, auto); if (t) { t.undo = { past: undo.past, future: undo.future }; t.auto = { why: st.autoWhy, fewer: st.fewer, note: $("autoNote").textContent, step: st.step, picked: st.methodPicked }; }
}
/** Open a tab's job in the page: its settings, inks and art, or a new job with the default profile.
    start: the page's first job (the note says what came back). */
async function openTab(t, start = false) {
  st.jobId = t.id; saveTabs(); const rec = t.rec; if (!start) jobNote("");
  undo.applying = true;
  try {
    await clearJob(); renderTabs();
    if (!rec) { const d = st.shop.defaultProfile && allProfiles().find(p => p.name === st.shop.defaultProfile); if (d) { applyProfile(d); profNote(`New job: started with ${d.name}.`, "ok"); } }
    else {
      if (rec.sample) { const a = sampleArt(); st.sample = true; st.artFile = { name: "Sample design", W: 1200, H: 1200, info: "Drop your art in the workspace to replace it." }; setArt(a.rgba, a.W, a.H, false); setStep(3, start); }
      else if (rec.art) { const bmp = await createImageBitmap(rec.art), sc = Math.min(1, WORK_MAX / Math.max(bmp.width, bmp.height)), W = Math.round(bmp.width * sc), H = Math.round(bmp.height * sc);
        const c = document.createElement("canvas"); c.width = W; c.height = H; const g = c.getContext("2d"); g.drawImage(bmp, 0, 0, W, H);
        st.artFile = rec.artFile || { name: rec.name, W: bmp.width, H: bmp.height, info: "" }; st.sample = false; setArt(g.getImageData(0, 0, W, H).data, W, H, false); st.savedArt = st.art; st.savedBlob = rec.art; setStep(3, start); }
      await applyJobState(rec.state, false); const a = t.auto; if (a) st.methodPicked = a.picked;
      if (st.art) { st.artAdj = null; st.prev = downsample(artIn(), PREV_MAX); renderArtCard(); st.why = "restored job"; if (rec.auto) autoSettings(true); else await run(!st.inks.length); }
      if (a && st.res && !rec.auto) { st.autoWhy = a.why; st.fewer = a.fewer && { ...a.fewer, prev: st.prev }; /* the same art, drawn again */ $("autoNote").textContent = a.note; if (a.step) setStep(a.step, false); renderSummaries(); }
      if (rec.view && st.res && !rec.auto) applyView(rec.view);
      if (rec.artMissing) jobNote(`Restored ${rec.name}: the settings only. The art was not kept: drop it again.`); else if (start) jobNote(`Restored ${rec.name} as you left it.`, true);
    }
  } catch (e) { jobNote(`The job could not be restored (${e.message}). It starts new.`); logError(e.message, "openTab"); }
  finally { undo.applying = false; }
  // the tab's own undo steps; the last one is the job as it is now
  const now = JSON.stringify(jobState()), u = t.undo;
  undo.past = u && u.past.length ? [...u.past.slice(0, -1), now] : [now]; undo.future = u ? u.future : []; renderUndo(); renderTabs();
}
/* One job change at a time: a click on the strip while one is in progress does nothing (start-up is the first). The
   page takes no input until the change is done, so nothing can start a separation for one job and end it in the next. */
let changing = true;
async function changeJob(fn) {
  if (changing) return; changing = true; const box = $("tabs"), had = box.contains(document.activeElement), parts = [document.querySelector(".v3"), document.querySelector(".mhead"), $("mNav")];
  box.setAttribute("aria-busy", "true"); for (const e of parts) /** @type {Element} */ (e).toggleAttribute("inert", true);
  try { await fn(); } catch (e) { console.error(e); }
  finally { changing = false; box.removeAttribute("aria-busy"); for (const e of parts) /** @type {Element} */ (e).toggleAttribute("inert", false);
    if (had) /** @type {HTMLElement} */ (box.querySelector(".on .tname")).focus(); }
}
const openJob = id => { const t = tabOf(id); return t && id !== st.jobId ? changeJob(async () => { await leaveJob(); await openTab(t); }) : Promise.resolve(); };
const newJob = () => changeJob(async () => {
  if (tabs.length >= TAB_MAX) return;
  await leaveJob(); const t = { id: newId(), name: "New job", rec: null }; tabs.push(t); await openTab(t);
  if (tabs.length >= TAB_MAX) jobNote(LIMIT_NOTE);
});
/** The job closed last goes for good: from this browser too. */
function forgetClosed() {
  if (!closed) return; clearTimeout(closed.t); const id = closed.tab.id; closed = null;
  jobsDo("readwrite", o => o.delete(id)).catch(() => { }); store.set("closed", null);
  $("jobClosed").hidden = true; $("jobNote").hidden = !$("jobMsg").textContent;
}
/** X on a tab: the job closes at once. For 10 seconds, or until the next close, Undo brings it back; its record stays
    in this browser that long. The tab before it opens (the mock's rule); the last tab leaves one new job. */
const closeJob = id => changeJob(async () => {
  const i = tabs.findIndex(t => t.id === id), t = tabs[i], open = id === st.jobId; if (!t) return;
  if (open) await leaveJob();
  forgetClosed(); tabs.splice(i, 1); let filler = "";
  if (!tabs.length) { filler = newId(); tabs.push({ id: filler, name: "New job", rec: null }); }
  closed = { tab: t, i, filler, t: 0 }; store.set("closed", t.id);
  if (open) await openTab(tabs[Math.max(0, i - 1)]); else { saveTabs(); renderTabs(); }
  $("jobClosed").hidden = false; $("jobNote").hidden = false;
  // the 10 seconds start when the line shows, not while the next job is separated again
  if (closed && closed.tab === t) closed.t = window.setTimeout(forgetClosed, CLOSE_UNDO_MS);
});
/** Undo on the "Job closed" line: the job is back in its place, open, with its art, settings and undo steps. */
const undoClose = () => changeJob(async () => {
  const c = closed; if (!c) return;
  if (tabs.length >= TAB_MAX && !c.filler) { jobNote(LIMIT_NOTE); return; }
  await leaveJob(); clearTimeout(c.t); closed = null; store.set("closed", null); $("jobClosed").hidden = true;
  // the new job that took the last tab's place goes again, unless it was used
  const f = c.filler && tabOf(c.filler); if (f && !f.rec) tabs.splice(tabs.indexOf(f), 1);
  tabs.splice(Math.min(c.i, tabs.length), 0, c.tab); await openTab(c.tab);
});
$("jobUndo").addEventListener("click", undoClose);
$("tabs").addEventListener("click", e => {
  const b = /** @type {HTMLElement} */ (e.target).closest("button"), tab = b && /** @type {HTMLElement | null} */ (b.closest(".tab")); if (!b) return;
  if (!tab) newJob(); else if (b.classList.contains("tclose")) closeJob(tab.dataset.id); else openJob(tab.dataset.id);
});
// keys on the strip: the arrows move between the tabs, Delete closes the tab
$("tabs").addEventListener("keydown", e => {
  const tab = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest(".tab")); if (!tab) return;
  if (e.key === "Delete") { e.preventDefault(); closeJob(tab.dataset.id); return; }
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  const names = /** @type {HTMLElement[]} */ ([...$("tabs").querySelectorAll(".tname")]), n = names[names.indexOf(/** @type {HTMLElement} */ (tab.querySelector(".tname"))) + (e.key === "ArrowRight" ? 1 : -1)];
  if (n) { e.preventDefault(); n.focus(); }
});
/** At start: every tab is back in its order (jobs stored before there were tabs: after them, oldest first), and the
    job that was open opens. A job closed just before the page was left goes for good. */
async function startJobs() {
  /** @type {any[]} */ let all = []; try { all = await jobsDo("readonly", o => o.getAll()); } catch { storeFailed(); }
  const gone = store.get("closed", null); if (gone) { all = all.filter(j => j.id !== gone); jobsDo("readwrite", o => o.delete(gone)).catch(() => { }); store.set("closed", null); }
  const byId = new Map(all.map(j => [j.id, j])), list = store.get("tabs", null), open = store.get("job", null);
  tabs = (Array.isArray(list) ? list : []).filter(t => t && typeof t.id === "string" && t.id !== gone).map(t => ({ id: t.id, name: byId.has(t.id) ? byId.get(t.id).name : "New job", rec: byId.get(t.id) || null }));
  for (const j of all.sort((a, b) => a.at - b.at)) if (!tabOf(j.id)) tabs.push({ id: j.id, name: j.name || "New job", rec: j });
  if (!tabOf(open) && (!tabs.length || (typeof open === "string" && open !== gone))) tabs.push({ id: typeof open === "string" && open !== gone ? open : newId(), name: "New job", rec: null });
  try { await openTab(tabOf(open) || tabs[0], true); } finally { changing = false; }
}
/** ?screen=N: open screen N of the restored job (print order, 1 = first) and show only its film in Print. */
function openUrlScreen() {
  const q = urlParam("screen"); if (q == null) return;
  const pl = st.res ? plates() : [], n = Number(q), p = Number.isInteger(n) ? pl.find(x => x.order === n) : null;
  if (p) { focusScreen(p.ub ? st.inks.length : p.idx); return; }
  jobNote(pl.length ? `?screen=${q}: this job has screens 1 to ${pl.length}.` : `?screen=${q}: this job has no screens yet. Separate the art first.`);
}
document.body.dataset.view = st.view; setStep(1, false); syncH(); renderSummaries(); renderUnits(); draw();
/* A new job, for clearJob. BLANK: its state, the page's controls as they start, before any job is put into them.
   PRISTINE: the job's part of the page as it starts (the workspace, the steps, Advanced, the phone's bottom bar): each
   element's attributes, a field's value, and the text of an element that holds no other element. Putting these back
   shows in a tab what a new page shows. Not in it: the tab strip and its status line, the theme switch, and whether
   Advanced is open (the page's, not the job's). */
const { profile: _shopProfile, ...BLANK } = jobState();
const PRISTINE = /** @type {any[]} */ (Array.from(document.querySelectorAll("#paneStage *, #paneSteps *, #paneSide *, #mNav *")))
  .filter(e => !e.closest("#tabBar, #jobNote, #themeSeg, #sideOpen, #sideClose"))
  .map(e => ({ e, at: [...e.attributes].map(a => [a.name, a.value]), text: e.children.length ? null : e.textContent, v: "value" in e && e.type !== "file" ? e.value : null, c: !!e.checked }));
function restorePristine() {
  for (const { e, at, text, v, c } of PRISTINE) { if (!e.isConnected) continue;
    for (const a of [...e.attributes]) if (!at.some(([n]) => n === a.name)) e.removeAttribute(a.name);
    for (const [n, x] of at) if (e.getAttribute(n) !== x || e.tagName === "CANVAS") e.setAttribute(n, x); // a canvas is cleared by its size
    if (text != null && (e.children.length || e.textContent !== text)) e.textContent = text;
    if (v != null && e.value !== v) e.value = v; if ("checked" in e) e.checked = c; }
}
// the start-up guard in index.html stops waiting once the last job is back (or a new job has its default profile)
startJobs().then(openUrlScreen).catch(e => logError(e.message, "startJobs")).finally(() => { /** @type {any} */ (window).sepReady = true; });

// tests/cli-parity.cjs draws the sample design with this, to compare the sep CLI with the page on the same art
export { sampleArt };
