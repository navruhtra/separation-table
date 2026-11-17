// @ts-check
// Read separated films back in: a Photoshop file with one channel per screen, or a set of TIFF films, one
// per screen. Pure (no DOM), so check.mjs reads back what output.js writes.
// Every reader returns ink as a Uint8Array per screen: 255 = full ink (black on the film), 0 = none.
import { rgb2lab } from "./engine.js";
import { PROCESS_INKS } from "./pipeline.js";
import { FILM_MARGIN_IN } from "./sizes.js";
import { cleanScreenSet } from "./plan.js";

/** @typedef {{ name: string, lab: number[] | null, ink: Uint8Array, ub: boolean, process?: string, hits?: number, flashBetween?: boolean }} FilmChannel */
/** @typedef {{ W: number, H: number, dpi: number | null, channels: FilmChannel[], rgba: Uint8ClampedArray | null, mode: string }} FilmSet */

/** A base screen by its name: "Underbase", "1. Underbase", "White base", "Base", "UB". */
export const isBaseName = n => /under\s*-?\s*base|^(?:white\s+)?base$|^ub$/i.test(stripOrder(n));
/** "03. Royal" or "03-royal" → "Royal" / "royal". */
export const stripOrder = n => String(n).replace(/\.(tiff?|psd)$/i, "").replace(/^\s*\d+\s*[.\-_ ]\s*/, "").trim();

const fail = m => { throw Object.assign(new Error(m), { user: true }); }; // a file it cannot use, not a fault of the page

/* ───────────── Photoshop (PSD) ─────────────
   Header, color mode data, image resources (resolution 1005, channel names 1006 / 1045, channel colors 1077 or
   1007), layers (skipped), then the merged image: raw or PackBits, 8 or 16 bits. The composite of an RGB file is the
   art; the four plates of a CMYK file and one of a Grayscale file are inks; Multichannel channels are all inks;
   extra channels are inks when Photoshop marks them as spot (alpha channels are skipped). */
const MODES = { 1: "grayscale", 3: "rgb", 4: "cmyk", 7: "multichannel" };
/** @param {ArrayBuffer | Uint8Array} buf @returns {FilmSet} */
export function readPSD(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (u8.length < 26 || String.fromCharCode(...u8.subarray(0, 4)) !== "8BPS") fail("This file is not a Photoshop file.");
  const ver = dv.getUint16(4); if (ver === 2) fail("This is a large-document Photoshop file (PSB). Save it as a PSD.");
  const nCh = dv.getUint16(12), H = dv.getUint32(14), W = dv.getUint32(18), depth = dv.getUint16(22), modeN = dv.getUint16(24), mode = MODES[modeN];
  if (!mode) fail("Open the file in Photoshop and choose Image > Mode > Multichannel, RGB, CMYK or Grayscale, then save it again.");
  if (depth !== 8 && depth !== 16) fail(`The file has ${depth}-bit channels. Save it with 8 or 16 bits per channel.`);
  if (!W || !H || W * H > 120e6) fail("The image size in the file is not usable.");
  let o = 26; o += 4 + dv.getUint32(o); // color mode data
  const resEnd = o + 4 + dv.getUint32(o); o += 4;
  let dpi = null, names = /** @type {string[]} */ ([]), uni = /** @type {string[]} */ ([]), disp = /** @type {{ lab: number[] | null, kind: number }[]} */ ([]);
  while (o + 12 <= resEnd) {
    if (String.fromCharCode(...u8.subarray(o, o + 4)) !== "8BIM") break;
    const id = dv.getUint16(o + 4), nl = u8[o + 6], nameLen = (nl + 1) % 2 ? nl + 2 : nl + 1; let p = o + 6 + nameLen;
    const size = dv.getUint32(p); p += 4; const d = u8.subarray(p, p + size), dd = new DataView(d.buffer, d.byteOffset, d.byteLength);
    if (id === 1005 && size >= 4) dpi = dd.getUint32(0) / 65536;
    if (id === 1006) { let q = 0; while (q < size) { const n = d[q]; names.push(String.fromCharCode(...d.subarray(q + 1, q + 1 + n))); q += 1 + n; } }
    if (id === 1045) { let q = 0; while (q + 4 <= size) { const n = dd.getUint32(q); q += 4; let s = ""; for (let k = 0; k < n && q + 1 < size; k++, q += 2) s += String.fromCharCode(dd.getUint16(q)); uni.push(s.replace(/\u0000+$/, "")); } }
    if (id === 1077 || (id === 1007 && !disp.length)) { const step = id === 1077 ? 13 : 14; for (let q = id === 1077 ? 4 : 0; q + 13 <= size; q += step) disp.push({ lab: colorOf(dd, q), kind: d[q + 12] }); }
    o = p + size + (size % 2);
  }
  o = resEnd; o += 4 + dv.getUint32(o); // layer and mask information
  const comp = dv.getUint16(o); o += 2; if (comp !== 0 && comp !== 1) fail("The merged image in the file is ZIP compressed. Save it again with Maximize compatibility on.");
  const bpr = W * depth / 8, planes = [];
  if (comp === 1) {
    const cnt = []; for (let i = 0; i < nCh * H; i++) { cnt.push(dv.getUint16(o)); o += 2; }
    for (let c = 0; c < nCh; c++) { const pl = new Uint8Array(bpr * H); for (let y = 0; y < H; y++) { const n = cnt[c * H + y]; unpackBits(u8, o, n, pl, y * bpr, bpr); o += n; } planes.push(pl); }
  } else for (let c = 0; c < nCh; c++) { planes.push(u8.slice(o, o + bpr * H)); o += bpr * H; }
  if (o > u8.length) fail("The file ends too soon. It may be damaged.");
  const eight = depth === 8 ? planes : planes.map(p => { const out = new Uint8Array(W * H); for (let i = 0; i < out.length; i++) out[i] = p[i * 2]; return out; });
  const comps = { grayscale: 1, rgb: 3, cmyk: 4, multichannel: 0 }[mode];
  // channel tone: black (0) = full ink, so ink = 255 - value, for the process plates and the spot channels alike
  const inkOf = p => { const out = new Uint8Array(W * H); for (let i = 0; i < out.length; i++) out[i] = 255 - p[i]; return out; };
  /** @type {FilmChannel[]} */ const channels = [];
  if (mode === "cmyk") PROCESS_INKS.forEach((k, i) => channels.push({ name: k.name, lab: k.lab, ink: inkOf(eight[i]), ub: false, process: k.process }));
  if (mode === "grayscale") channels.push({ name: "Black", lab: [16, 0, 0], ink: inkOf(eight[0]), ub: false });
  for (let c = comps, x = 0; c < nCh; c++, x++) {
    const di = disp[x], name = (uni[x] || names[x] || `Channel ${c + 1}`).trim();
    // RGB, CMYK and Grayscale files keep selections as alpha channels: only spot channels are screens
    if (mode !== "multichannel" && di && di.kind !== 2) continue;
    // " 2x" or " 2x flash" at the end of a channel name: a double hit (Separation Table writes it so)
    const dh = name.match(/\s2x( flash)?$/i), base = dh ? name.slice(0, dh.index) : name;
    channels.push({ name: stripOrder(base) || base, lab: di ? di.lab : null, ink: inkOf(eight[c]), ub: isBaseName(base), hits: dh ? 2 : 1, flashBetween: !!(dh && dh[1]) });
  }
  if (!channels.length) fail("The file has no spot channels. Each screen must be a spot channel (Channels panel > New Spot Channel).");
  let rgba = null;
  if (mode === "rgb") { rgba = new Uint8ClampedArray(W * H * 4); for (let i = 0; i < W * H; i++) { rgba[i * 4] = eight[0][i]; rgba[i * 4 + 1] = eight[1][i]; rgba[i * 4 + 2] = eight[2][i]; rgba[i * 4 + 3] = 255; } }
  return { W, H, dpi, channels, rgba, mode };
}
/** Photoshop color structure (color space + four 16-bit values) as CIELAB, or null for a space it cannot read. */
function colorOf(dd, q) {
  const sp = dd.getUint16(q), v = [0, 1, 2, 3].map(k => dd.getUint16(q + 2 + k * 2));
  if (sp === 0) return rgb2lab(v[0] / 257, v[1] / 257, v[2] / 257);
  if (sp === 7) return [v[0] / 100, dd.getInt16(q + 4) / 100, dd.getInt16(q + 6) / 100];
  if (sp === 8) return [v[0] / 100, 0, 0];
  if (sp === 2) { const [c, m, y, k] = v.map(x => 1 - x / 65535); return rgb2lab(255 * (1 - c) * (1 - k), 255 * (1 - m) * (1 - k), 255 * (1 - y) * (1 - k)); } // Photoshop stores CMYK inverted
  return null;
}
function unpackBits(src, o, n, dst, d, len) {
  const end = o + n; let w = 0;
  while (o < end && w < len) { const h = src[o++]; if (h < 128) { const c = h + 1; for (let k = 0; k < c && w < len; k++) dst[d + w++] = src[o++]; } else if (h > 128) { const c = 257 - h, v = src[o++]; for (let k = 0; k < c && w < len; k++) dst[d + w++] = v; } }
}

/* ───────────── TIFF ─────────────
   One film or plate per file: 1-bit (bilevel) or 8-bit gray, uncompressed, PackBits or LZW (with or without the
   horizontal predictor), Intel or Motorola byte order, in strips. Black is ink. */
/** @param {ArrayBuffer | Uint8Array} buf @returns {{ W: number, H: number, dpi: number | null, ink: Uint8Array }} */
export function readTIFF(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (u8.length < 8) fail("This file is not a TIFF file.");
  const le = dv.getUint16(0) === 0x4949; if (!le && dv.getUint16(0) !== 0x4d4d) fail("This file is not a TIFF file.");
  if (dv.getUint16(2, le) !== 42) fail("This TIFF file is a BigTIFF. Save it as a standard TIFF.");
  const ifd = dv.getUint32(4, le), n = dv.getUint16(ifd, le), T = /** @type {Record<number, number[]>} */ ({});
  const size = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 16: 8 };
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12, tag = dv.getUint16(e, le), type = dv.getUint16(e + 2, le), cnt = dv.getUint32(e + 4, le), sz = (size[type] || 1) * cnt;
    const at = sz <= 4 ? e + 8 : dv.getUint32(e + 8, le), vals = [];
    for (let k = 0; k < Math.min(cnt, 1e6); k++) vals.push(type === 3 ? dv.getUint16(at + k * 2, le) : type === 4 ? dv.getUint32(at + k * 4, le) : type === 5 ? dv.getUint32(at + k * 8, le) / (dv.getUint32(at + k * 8 + 4, le) || 1) : u8[at + k]);
    T[tag] = vals;
  }
  const W = T[256]?.[0], H = T[257]?.[0], bps = T[258]?.[0] ?? 1, comp = T[259]?.[0] ?? 1, photo = T[262]?.[0] ?? 0, spp = T[277]?.[0] ?? 1, pred = T[317]?.[0] ?? 1;
  if (!W || !H) fail("The TIFF file has no image size.");
  if (spp !== 1 || (bps !== 1 && bps !== 8) || photo > 1) fail("The TIFF is not a film: save each screen as a 1-bit (Bitmap) or 8-bit Grayscale TIFF.");
  if (comp !== 1 && comp !== 5 && comp !== 32773) fail("The TIFF uses a compression Separation Table cannot read. Save it with no compression, LZW or PackBits.");
  const offs = T[273] || [], cnts = T[279] || [], rps = T[278]?.[0] ?? H, rb = Math.ceil(W * bps / 8), raw = new Uint8Array(rb * H);
  for (let s = 0, row = 0; s < offs.length && row < H; s++) {
    const rows = Math.min(rps, H - row), want = rows * rb, src = u8.subarray(offs[s], offs[s] + cnts[s]);
    if (comp === 1) raw.set(src.subarray(0, want), row * rb);
    else if (comp === 32773) { let o = 0, w = 0; const dst = raw.subarray(row * rb, row * rb + want); while (o < src.length && w < want) { const h = src[o++]; if (h < 128) { for (let k = 0; k <= h && w < want; k++) dst[w++] = src[o++]; } else if (h > 128) { const v = src[o++]; for (let k = 0; k < 257 - h && w < want; k++) dst[w++] = v; } } }
    else raw.set(lzw(src, want), row * rb);
    if (pred === 2 && bps === 8) for (let y = row; y < row + rows; y++) for (let x = 1; x < W; x++) raw[y * rb + x] = (raw[y * rb + x] + raw[y * rb + x - 1]) & 255;
    row += rows;
  }
  const ink = new Uint8Array(W * H);
  // WhiteIsZero (0): a set bit or a high value is black; BlackIsZero (1): the other way round
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = bps === 1 ? ((raw[y * rb + (x >> 3)] >> (7 - (x & 7))) & 1) * 255 : raw[y * rb + x];
    ink[y * W + x] = photo === 0 ? v : 255 - v;
  }
  const unit = T[296]?.[0] ?? 2, xr = T[282]?.[0];
  return { W, H, dpi: xr ? (unit === 3 ? xr * 2.54 : unit === 1 ? null : xr) : null, ink };
}
/** TIFF LZW (MSB first, early change). */
function lzw(src, want) {
  const out = new Uint8Array(want); let w = 0, bit = 0, width = 9, dict = /** @type {Uint8Array[]} */ ([]), prev = null;
  const reset = () => { dict = []; for (let i = 0; i < 256; i++) dict.push(Uint8Array.of(i)); dict.push(new Uint8Array(0), new Uint8Array(0)); width = 9; prev = null; };
  reset();
  while (w < want) {
    if ((bit + width) > src.length * 8) break;
    let code = 0; for (let k = 0; k < width; k++) { code = (code << 1) | ((src[(bit + k) >> 3] >> (7 - ((bit + k) & 7))) & 1); } bit += width;
    if (code === 257) break; if (code === 256) { reset(); continue; }
    let entry; if (code < dict.length) { entry = dict[code]; if (prev) { const e = new Uint8Array(prev.length + 1); e.set(prev); e[prev.length] = entry[0]; dict.push(e); } }
    else if (prev) { entry = new Uint8Array(prev.length + 1); entry.set(prev); entry[prev.length] = prev[0]; dict.push(entry); } else break;
    for (let k = 0; k < entry.length && w < want; k++) out[w++] = entry[k];
    prev = entry; if (dict.length + 1 >= (1 << width) && width < 12) width++;
  }
  return out;
}

/* ───────────── From films to coverage ─────────────
   A film is larger than the art: Separation Table films carry a 0.5 in margin with marks and the label. The trim
   (none or 0.5 in) is the one whose shape matches the art best; it must be within 2% of the art's shape. */
/** The area of the film that is the art, or null. When both shapes match (a square design), the job's print width
 *  (separation.json) decides; without it the margin is trimmed when it is almost empty, as marks and a label are.
 *  @param {{ widthIn?: number, planes?: Uint8Array[] }} o
 *  @returns {{ x: number, y: number, w: number, h: number } | null} */
export function artArea(W, H, dpi, aspect, o = {}, tol = 0.02) {
  const opts = [{ x: 0, y: 0, w: W, h: H }];
  if (dpi) { const m = Math.round(dpi * FILM_MARGIN_IN); if (W > 4 * m && H > 4 * m) opts.push({ x: m, y: m, w: W - 2 * m, h: H - 2 * m }); }
  const err = a => Math.abs(Math.log((a.w / a.h) / aspect)), fit = opts.filter(a => err(a) <= tol);
  if (fit.length < 2) return fit[0] || null;
  if (o.widthIn && dpi) return fit.reduce((a, b) => Math.abs(b.w / dpi - o.widthIn) < Math.abs(a.w / dpi - o.widthIn) ? b : a);
  const m = fit[1].x; let ink = 0, n = 0;
  for (const pl of o.planes || []) for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) if (x < m || x >= W - m || y < m || y >= H - m) { ink += pl[y * W + x]; n++; }
  return n && ink / (n * 255) < 0.03 ? fit[1] : fit[0];
}
/** Area-average one ink plane (part x,y,w,h of a W-wide image) down to tw × th, as 0..1. Halftone dots average to their
 *  dot area once a target pixel spans a halftone cell; blur (in target pixels) finishes that for finer grids. */
export function inkToCov(ink, W, area, tw, th, blur = 0) {
  const out = new Float32Array(tw * th), sx = area.w / tw, sy = area.h / th;
  for (let ty = 0; ty < th; ty++) { const y0 = area.y + Math.floor(ty * sy), y1 = Math.max(y0 + 1, area.y + Math.floor((ty + 1) * sy));
    for (let tx = 0; tx < tw; tx++) { const x0 = area.x + Math.floor(tx * sx), x1 = Math.max(x0 + 1, area.x + Math.floor((tx + 1) * sx)); let s = 0;
      for (let y = y0; y < y1; y++) { const r = y * W; for (let x = x0; x < x1; x++) s += ink[r + x]; }
      out[ty * tw + tx] = s / ((y1 - y0) * (x1 - x0) * 255); } }
  if (blur > 0) { const r = Math.round(blur), tmp = new Float32Array(out.length);
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) { let s = 0, c = 0; for (let k = -r; k <= r; k++) { const xx = x + k; if (xx >= 0 && xx < tw) { s += out[y * tw + xx]; c++; } } tmp[y * tw + x] = s / c; }
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) { let s = 0, c = 0; for (let k = -r; k <= r; k++) { const yy = y + k; if (yy >= 0 && yy < th) { s += tmp[yy * tw + x]; c++; } } out[y * tw + x] = s / c; } }
  return out;
}
/** True when a plane holds only full ink and no ink (a 1-bit film, or a solid spot plate). */
export function isBilevel(ink) { for (let i = 0; i < ink.length; i += 7) if (ink[i] !== 0 && ink[i] !== 255) return false; return true; }
/** Films hold printed dots: a dot printed early is partly hidden under the dots printed after it. The proof needs the
 *  part of each ink that shows. One angle ("same"): concentric dots, so a later dot hides an earlier one up to its own
 *  size; rotated screens ("rotated"): dots fall at random, so each later ink hides its share; interlocked ("lock") and
 *  "none" print side by side. rho blends one angle toward random, as the press setting does. The inverse of
 *  engine.visibleToPrinted without its ramps and limits. planes: printed area 0..1 per ink, in print order. */
export function printedToVisible(planes, P, model = "same", rho = 0) {
  const N = planes.length, out = planes.map(() => new Float32Array(P));
  for (let q = 0; q < P; q++) {
    let M = 0, free = 1;
    for (let k = N - 1; k >= 0; k--) { const p = planes[k][q];
      const same = Math.max(0, p - M), rot = p * free;
      out[k][q] = model === "lock" || model === "none" ? p : model === "rotated" ? rot : (1 - rho) * same + rho * rot;
      if (p > M) M = p; free *= 1 - p; }
  }
  return out;
}
/** The press's dot gain on a film's dot area: G at 50%, the curve engine.invGain undoes (a + 4G·a·(1 − a)). In place. */
export function withGain(cov, G) { if (G > 0) for (let i = 0; i < cov.length; i++) { const a = cov[i]; cov[i] = Math.min(1, a + 4 * G * a * (1 - a)); } return cov; }

/* ───────────── A film set becomes the job's screens ─────────────
   The page's Re-proof films (app.js importFilms) and the sep CLI and MCP server (cli/session.mjs) both call these. */
/** A name for matching: lower case, letters and digits only. */
export const normName = n => String(n || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
/** An Error the person can act on (the page shows it in its note, not as a page error). */
const refuse = m => Object.assign(new Error(m), { user: true });
/** Each film's colour, in place: the job's separation.json screen, else the Photoshop channel colour, else a library
 *  ink of that name (labOf gives its colour, calibrated on the page); a base takes the base white. Throws a refusal
 *  for a film without a colour, more than one base, or only a base.
 *  @param {FilmSet} set @param {any} spec @param {{ name: string, lab: number[] }[]} library */
export function colorChannels(set, spec, library, labOf = i => i.lab) {
  for (const c of /** @type {any[]} */ (set.channels)) {
    const sc = spec && Array.isArray(spec.screens) ? spec.screens.find(x => x.file === c.file || normName(x.name) === normName(c.name)) : null;
    if (sc && Array.isArray(sc.lab)) { c.lab = sc.lab; c.name = sc.name; c.ub = !!sc.underbase || isBaseName(sc.name); c.hits = sc.hits === 2 ? 2 : c.hits; c.flashBetween = !!sc.flash_between_hits;
      // the screen's own mesh, LPI and angle (set_screen) stay with it
      if (sc.screen_settings != null) { try { const own = cleanScreenSet(sc.screen_settings, sc.name); if (own) c.set = own; } catch (e) { throw refuse(`separation.json: ${e.message}`); } } }
    if (!c.lab) { const k = library.find(i => normName(i.name) === normName(c.name)); if (k) c.lab = labOf(k); }
    if (!c.lab && c.ub) c.lab = [96, 0, 1.5];
  }
  const unknown = set.channels.filter(c => !c.lab);
  if (unknown.length) throw refuse(`No color for ${unknown.map(c => c.name).join(", ")}. Add separation.json from the same job, or name each film after an ink in your library, for example 03-Royal Blue.tif.`);
  if (set.channels.filter(c => c.ub).length > 1) throw refuse("The films have more than one underbase. Keep one base screen.");
  if (!set.channels.some(c => !c.ub)) throw refuse("The films have only an underbase. Add the color screens.");
  return set;
}
/** Each film descreened to coverage (0..1) at the preview size, and at the work size as bytes (null when the work
 *  size is the preview's). Halftone films carry the dot gain compensation: the press puts the gain back (gain: the
 *  job's dot gain at 50%, 0.22 = 22%). */
export function channelCoverage(set, area, { prevW, prevH, workW, workH, lpi, widthIn, gain }) {
  return set.channels.map(c => { const two = isBilevel(c.ink), cell = px => two ? px / (widthIn * (c.set && c.set.lpi || lpi)) / 2 : 0, g = two && !c.ub ? gain : 0;
    const prev = withGain(inkToCov(c.ink, set.W, area, prevW, prevH, cell(prevW)), g), work = workW === prevW ? null : Uint8Array.from(withGain(inkToCov(c.ink, set.W, area, workW, workH, cell(workW)), g), v => Math.round(v * 255));
    return { name: c.name, lab: c.lab, ub: c.ub, prev, work, hits: c.hits || 1, flashBetween: !!c.flashBetween, ...(c.set && { set: c.set }) }; });
}
