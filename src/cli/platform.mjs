// Node side of the job: what the page does with a canvas or a script tag, done with the standard library.
// PNG read and write (zlib), the film margin (registration marks, test strip, label) drawn straight into 1-bit pixels,
// a box-filter resample, and the vendored JSZip and pdf-lib loaded from the same files the page loads.
import { readFileSync } from "node:fs";
import { inflateSync, deflateSync, crc32 } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { rgb2lab, dotOn, screenAxes } from "../engine.js";
import { FILM_MARGIN_IN } from "../sizes.js";
import { mirrorX } from "../output.js";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export { VERSION } from "../version.js"; // one version for the page, the CLI and separation.json

/* ───────────── Vendored libraries ───────────── */
/** Load the UMD builds in vendor/ (npm run setup) as the page's script tags would, onto globalThis. */
export function loadVendor() {
  /** @type {any} */ const g = globalThis; g.self ??= g;
  for (const [file, name] of [["jszip.min.js", "JSZip"], ["pdf-lib.min.js", "PDFLib"]]) {
    if (g[name]) continue; let src;
    try { src = readFileSync(join(ROOT, "vendor", file), "utf8"); } catch { throw new Error(`vendor/${file} is missing. Run: npm run setup`); }
    const mod = { exports: {} }; new Function("module", "exports", "define", src)(mod, mod.exports, undefined); g[name] = mod.exports;
  }
}

/* ───────────── PNG ───────────── */
const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
/** Decode a PNG to straight (not premultiplied) 8-bit RGBA. Returns { rgba, W, H, icc } (icc: an iCCP chunk is present). */
export function decodePNG(buf) {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error("not a PNG file");
  let o = 8, W = 0, H = 0, depth = 0, type = 0, interlace = 0, pal = null, trns = null, icc = false; const idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o), t = buf.toString("latin1", o + 4, o + 8), d = buf.subarray(o + 8, o + 8 + len); o += 12 + len;
    if (t === "IHDR") { W = d.readUInt32BE(0); H = d.readUInt32BE(4); depth = d[8]; type = d[9]; interlace = d[12]; }
    else if (t === "PLTE") pal = d; else if (t === "tRNS") trns = d; else if (t === "IDAT") idat.push(d); else if (t === "iCCP") icc = true; else if (t === "IEND") break;
  }
  if (interlace) throw new Error("interlaced PNG is not supported; save it without interlacing");
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type]; if (!ch) throw new Error(`PNG color type ${type} is not supported`);
  const bpp = Math.max(1, (ch * depth) >> 3), stride = (W * ch * depth + 7) >> 3, raw = inflateSync(Buffer.concat(idat)), px = Buffer.alloc(stride * H);
  for (let y = 0; y < H; y++) { const f = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), row = px.subarray(y * stride, (y + 1) * stride), up = y ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) { const a = i >= bpp ? row[i - bpp] : 0, b = up ? up[i] : 0, c = up && i >= bpp ? up[i - bpp] : 0;
      let v = src[i]; if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1; else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      row[i] = v & 255; } }
  const rgba = new Uint8ClampedArray(W * H * 4), max = (1 << depth) - 1;
  const sample = (y, k) => depth === 16 ? px[y * stride + k * 2] : depth === 8 ? px[y * stride + k] : (px[y * stride + ((k * depth) >> 3)] >> (8 - depth - ((k * depth) & 7))) & max;
  const to8 = v => depth === 16 ? v : depth === 8 ? v : Math.round(v * 255 / max), key = trns && type !== 3 ? (type === 0 ? [trns.readUInt16BE(0)] : [trns.readUInt16BE(0), trns.readUInt16BE(2), trns.readUInt16BE(4)]) : null;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const q = (y * W + x) * 4, s = k => sample(y, x * ch + k);
    if (type === 3) { const i = s(0); rgba[q] = pal[i * 3]; rgba[q + 1] = pal[i * 3 + 1]; rgba[q + 2] = pal[i * 3 + 2]; rgba[q + 3] = trns && i < trns.length ? trns[i] : 255; continue; }
    const g = type === 0 || type === 4, c = g ? [s(0), s(0), s(0)] : [s(0), s(1), s(2)], al = type === 4 ? s(1) : type === 6 ? s(3) : max;
    const raw16 = depth === 16 ? (k => (px[y * stride + (x * ch + k) * 2] << 8) | px[y * stride + (x * ch + k) * 2 + 1]) : null;
    const isKey = key && (g ? (raw16 ? raw16(0) : s(0)) === key[0] : [0, 1, 2].every(k => (raw16 ? raw16(k) : s(k)) === key[k]));
    rgba[q] = to8(c[0]); rgba[q + 1] = to8(c[1]); rgba[q + 2] = to8(c[2]); rgba[q + 3] = isKey ? 0 : to8(al); }
  return { rgba, W, H, icc };
}
function chunk(type, data) { const t = Buffer.from(type, "latin1"), len = Buffer.alloc(4), crc = Buffer.alloc(4); len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0); return [len, t, data, crc]; }
/** 8-bit RGBA PNG (the layout canvas.toBlob writes, so pdf-lib embeds the same pixels the same way). */
export function encodePNG(rgba, W, H) {
  const raw = Buffer.alloc((W * 4 + 1) * H); for (let y = 0; y < H; y++) { raw[y * (W * 4 + 1)] = 0; Buffer.from(rgba.buffer, rgba.byteOffset + y * W * 4, W * 4).copy(raw, y * (W * 4 + 1) + 1); }
  const ih = Buffer.alloc(13); ih.writeUInt32BE(W, 0); ih.writeUInt32BE(H, 4); ih[8] = 8; ih[9] = 6;
  return Buffer.concat([SIG, ...chunk("IHDR", ih), ...chunk("IDAT", deflateSync(raw, { level: 6 })), ...chunk("IEND", Buffer.alloc(0))]);
}
const pngBlob = (rgba, W, H) => new Blob([encodePNG(rgba, W, H)], { type: "image/png" });
/** A 1-bit film (1 = ink) as a PNG, black ink on white. */
export function bitsPNG(bits, w, h) { const d = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < w * h; i++) { const v = bits[i] ? 0 : 255; d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255; } return encodePNG(d, w, h); }

/* ───────────── Art ───────────── */
/** Read art from a file: PNG with the standard library; JPEG and WebP only if sharp is installed. */
export async function readArt(path) {
  const buf = readFileSync(path);
  if (buf.subarray(0, 8).equals(SIG)) { const r = decodePNG(buf); return { ...r, info: r.icc ? "Embedded color profile not converted (the CLI reads the pixels as sRGB)." : "No color profile. Used as sRGB." }; }
  let sharp; try { sharp = (await import("sharp")).default; } catch { throw new Error(`${path}: only PNG is read without the optional sharp package (JPEG and WebP need it)`); }
  const { data, info } = await sharp(buf).toColorspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { rgba: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), W: info.width, H: info.height, icc: false, info: "Read with sharp, converted to sRGB." };
}
/** Box-filter resample to fit max px (alpha-weighted), then the arrays the engine reads (the page's downsample). */
export function downsample(art, max) {
  const s = Math.min(1, max / Math.max(art.W, art.H)), W = Math.max(1, Math.round(art.W * s)), H = Math.max(1, Math.round(art.H * s));
  let rgba = art.rgba;
  if (s < 1) { rgba = new Uint8ClampedArray(W * H * 4); const fx = art.W / W, fy = art.H / H;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const xa = x * fx, xb = xa + fx, ya = y * fy, yb = ya + fy; let r = 0, g = 0, b = 0, a = 0, wt = 0;
      for (let yy = Math.floor(ya); yy < Math.ceil(yb); yy++) { const wy = Math.min(yb, yy + 1) - Math.max(ya, yy);
        for (let xx = Math.floor(xa); xx < Math.ceil(xb); xx++) { const w = (Math.min(xb, xx + 1) - Math.max(xa, xx)) * wy, q = (yy * art.W + xx) * 4, al = art.rgba[q + 3] * w;
          r += art.rgba[q] * al; g += art.rgba[q + 1] * al; b += art.rgba[q + 2] * al; a += al; wt += w; } }
      const q = (y * W + x) * 4; if (a > 0) { rgba[q] = r / a; rgba[q + 1] = g / a; rgba[q + 2] = b / a; } rgba[q + 3] = a / wt; } }
  const P = W * H, px = new Uint8ClampedArray(P * 3), alpha = new Uint8Array(P), lab = new Float32Array(P * 3);
  for (let j = 0; j < P; j++) { px[j * 3] = rgba[j * 4]; px[j * 3 + 1] = rgba[j * 4 + 1]; px[j * 3 + 2] = rgba[j * 4 + 2]; alpha[j] = rgba[j * 4 + 3]; lab.set(rgb2lab(px[j * 3], px[j * 3 + 1], px[j * 3 + 2]), j * 3); }
  return { px, alpha, lab, W, H, rgba: new Uint8ClampedArray(rgba) };
}

/* ───────────── Film margin, 1-bit ─────────────
   The page draws the margin on a canvas (output.composeFilm); this draws the same layout into the bits: white margin,
   four registration marks, the test strip (the same dotOn dots and screen angle) and the label. Text is a 5 × 7 block font, so the label
   glyphs differ from the page's Helvetica; everything else lands on the same pixels to within anti-aliasing. */
const FONT = { "0": [14, 17, 19, 21, 25, 17, 14], "1": [4, 12, 4, 4, 4, 4, 14], "2": [14, 17, 1, 2, 4, 8, 31], "3": [31, 2, 4, 2, 1, 17, 14], "4": [2, 6, 10, 18, 31, 2, 2], "5": [31, 16, 30, 1, 1, 17, 14],
  "6": [6, 8, 16, 30, 17, 17, 14], "7": [31, 1, 2, 4, 8, 8, 8], "8": [14, 17, 17, 14, 17, 17, 14], "9": [14, 17, 17, 15, 1, 2, 12], A: [14, 17, 17, 17, 31, 17, 17], B: [30, 17, 17, 30, 17, 17, 30],
  C: [14, 17, 16, 16, 16, 17, 14], D: [28, 18, 17, 17, 17, 18, 28], E: [31, 16, 16, 30, 16, 16, 31], F: [31, 16, 16, 30, 16, 16, 16], G: [14, 17, 16, 23, 17, 17, 15], H: [17, 17, 17, 31, 17, 17, 17],
  I: [14, 4, 4, 4, 4, 4, 14], J: [7, 2, 2, 2, 2, 18, 12], K: [17, 18, 20, 24, 20, 18, 17], L: [16, 16, 16, 16, 16, 16, 31], M: [17, 27, 21, 21, 17, 17, 17], N: [17, 17, 25, 21, 19, 17, 17],
  O: [14, 17, 17, 17, 17, 17, 14], P: [30, 17, 17, 30, 16, 16, 16], Q: [14, 17, 17, 17, 21, 18, 13], R: [30, 17, 17, 30, 20, 18, 17], S: [15, 16, 16, 14, 1, 1, 30], T: [31, 4, 4, 4, 4, 4, 4],
  U: [17, 17, 17, 17, 17, 17, 14], V: [17, 17, 17, 17, 17, 10, 4], W: [17, 17, 17, 21, 21, 21, 10], X: [17, 17, 10, 4, 10, 17, 17], Y: [17, 17, 17, 10, 4, 4, 4], Z: [31, 1, 2, 4, 8, 16, 31],
  ".": [0, 0, 0, 0, 0, 12, 12], ",": [0, 0, 0, 0, 12, 4, 8], "/": [0, 1, 2, 4, 8, 16, 0], "%": [24, 25, 2, 4, 8, 19, 3], "-": [0, 0, 0, 31, 0, 0, 0], "+": [0, 4, 4, 31, 4, 4, 0], ":": [0, 12, 12, 0, 12, 12, 0],
  "(": [2, 4, 8, 8, 8, 4, 2], ")": [8, 4, 2, 2, 2, 4, 8], "°": [12, 18, 18, 12, 0, 0, 0], "#": [10, 10, 31, 10, 31, 10, 10], "&": [12, 18, 20, 8, 21, 18, 13], "'": [12, 4, 8, 0, 0, 0, 0],
  "?": [14, 17, 1, 2, 4, 0, 4], "_": [0, 0, 0, 0, 0, 0, 31], "=": [0, 0, 31, 0, 31, 0, 0], "·": [0, 0, 0, 12, 12, 0, 0], " ": [0, 0, 0, 0, 0, 0, 0] };
/** Draw text with its baseline at y, cap height 0.72 × size px, squeezed to maxW if given. */
function drawText(set, text, x, y, size, maxW = Infinity) {
  const sy = size * 0.72 / 7; let sx = sy; const n = [...text].length; if (n * 6 * sx > maxW) sx = maxW / (n * 6);
  [...text.toUpperCase()].forEach((c, i) => { const g = FONT[c] || FONT["?"];
    for (let r = 0; r < 7; r++) for (let k = 0; k < 5; k++) if (g[r] & (16 >> k)) set(x + (i * 6 + k) * sx, y - (7 - r) * sy, sx, sy); });
}
export function composeFilmBits(bits, w, h, dpi, label, strip = null, mirror = false) {
  const mx = Math.round(dpi * FILM_MARGIN_IN), W = w + mx * 2, H = h + mx * 2, out = new Uint8Array(W * H);
  for (let y = 0; y < h; y++) out.set(bits.subarray(y * w, (y + 1) * w), (y + mx) * W + mx);
  // a filled rectangle in pixel-centre terms: the pixels whose centres fall inside
  const fill = (x, y, rw, rh) => { for (let yy = Math.max(0, Math.ceil(y - 0.5)); yy < Math.min(H, Math.ceil(y + rh - 0.5)); yy++) for (let xx = Math.max(0, Math.ceil(x - 0.5)); xx < Math.min(W, Math.ceil(x + rw - 0.5)); xx++) out[yy * W + xx] = 1; };
  const lw = Math.max(1, dpi / 150), r = dpi * 0.12;
  const mark = (cx, cy) => { for (let yy = Math.floor(cy - r - lw); yy <= Math.ceil(cy + r + lw); yy++) for (let xx = Math.floor(cx - r - lw); xx <= Math.ceil(cx + r + lw); xx++) {
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue; const d = Math.hypot(xx + 0.5 - cx, yy + 0.5 - cy); if (Math.abs(d - r) <= lw / 2) out[yy * W + xx] = 1; }
    fill(cx - r * 1.6, cy - lw / 2, r * 3.2, lw); fill(cx - lw / 2, cy - r * 1.6, lw, r * 3.2); };
  mark(W / 2, mx / 2); mark(W / 2, H - mx / 2); mark(mx / 2, H / 2); mark(W - mx / 2, H / 2);
  if (strip && strip.lpi) {
    const steps = [100, 95, 90, 75, 50, 25, 10, 5], avail = W / 2 - mx - dpi * 0.25, sw = Math.max(4, Math.min(Math.round(dpi * 0.3), Math.floor(avail / steps.length))), sh = Math.round(mx * 0.35), y0 = H - Math.round(mx * 0.45), x0 = mx;
    const { cs, sn } = screenAxes(strip.angle || 0), cell = dpi / strip.lpi;
    for (let k = 0; k < steps.length; k++) for (let yy = 0; yy < sh; yy++) for (let xx = 0; xx < sw; xx++) { const X = x0 + k * sw + xx, Y = y0 + yy; out[Y * W + X] = dotOn(strip.shape, X, Y, steps[k] / 100, cell, cs, sn) ? 1 : 0; }
    const fs = Math.max(6, Math.round(Math.min(dpi * 0.06, sw * 0.3)));
    steps.forEach((t, k) => drawText(fill, `${t}%`, x0 + k * sw + 2, y0 - 4, fs));
  }
  drawText(fill, label, mx, mx * 0.8, Math.round(dpi * 0.11), Math.max(dpi * 0.5, W / 2 - mx - dpi * 0.25));
  // mirrored (emulsion down): the whole film flips left to right, as output.composeFilm does on the page
  return { bits: mirror ? mirrorX(out, W, H) : out, w: W, h: H };
}
/** The platform object job.writeJob takes. */
export const nodePlatform = { composeFilm: composeFilmBits, toPNG: f => new Blob([bitsPNG(f.bits, f.w, f.h)], { type: "image/png" }), rgbaPNG: async (rgba, W, H) => pngBlob(rgba, W, H) };
