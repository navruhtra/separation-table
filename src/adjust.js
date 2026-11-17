// @ts-check
/* Adjust the art: the art the separation reads, not the file. Every screen, the underbase and the films come from the
   adjusted art; the file and the Fix-the-art history stay as they were, so Reset or Before/After gives the art back.
   Order, as a separator works in Photoshop before separating: levels (black and white point), brightness (midtones
   only, so solid white and solid black stay solid), contrast (an S-curve with no clipping, so gradients keep every
   step), then hue, saturation and vibrance in LCh (perceptual: a hue keeps its lightness), then sharpen. */
import { rgb2lab, lab2rgb } from "./engine.js";

/** @typedef {{ bright: number, contrast: number, sat: number, vib: number, black: number, white: number, hue: number, sharpen: number }} Adjust */
/** @type {Adjust} */
export const ADJ0 = Object.freeze({ bright: 0, contrast: 0, sat: 0, vib: 0, black: 0, white: 255, hue: 0, sharpen: 0 });
/** @param {Adjust} a */
export const isNeutral = a => Object.keys(ADJ0).every(k => a[k] === ADJ0[k]);

/** The tone curve for one channel value 0–255 (levels, brightness, contrast): a 256-entry table. @param {Adjust} a */
export function toneCurve(a) {
  const lut = new Uint8ClampedArray(256), bp = Math.min(a.black, a.white - 1), wp = Math.max(a.white, bp + 1);
  const g = Math.pow(2, -a.bright / 50); // brightness +100 → gamma 0.25 on the midtones; ends stay put
  const k = Math.pow(2, a.contrast / 50); // contrast +100 → S-curve of power 4 around the middle; −100 flattens
  for (let v = 0; v < 256; v++) {
    let t = Math.min(1, Math.max(0, (v - bp) / (wp - bp)));
    t = Math.pow(t, g);
    t = t < 0.5 ? 0.5 * Math.pow(2 * t, k) : 1 - 0.5 * Math.pow(2 - 2 * t, k);
    lut[v] = Math.round(t * 255);
  }
  return lut;
}

/** One pixel's color move in LCh. sat ±100 scales chroma (−100 = gray); vibrance lifts dull colors more than strong
    ones (and skin, near hue 50°, less); hue turns every color by that many degrees. Returns [r, g, b]. */
export function colorMove(r, g, b, a) {
  const [L, A, B] = rgb2lab(r, g, b);
  let C = Math.hypot(A, B), h = Math.atan2(B, A);
  C *= 1 + a.sat / 100;
  if (a.vib) { const dull = Math.max(0, 1 - C / 80), skin = Math.exp(-(((h * 180 / Math.PI - 50 + 540) % 360 - 180) ** 2) / 800); C *= 1 + (a.vib / 100) * dull * (1 - 0.6 * skin); }
  h += a.hue * Math.PI / 180;
  return lab2rgb([L, C * Math.cos(h), C * Math.sin(h)]);
}

/** Adjusted copy of RGBA art. Alpha is kept; fully transparent pixels are not touched. @param {Adjust} a */
export function adjustArt(rgba, W, H, a) {
  const out = new Uint8ClampedArray(rgba), P = W * H, lut = toneCurve(a), color = a.sat || a.vib || a.hue;
  for (let p = 0, o = 0; p < P; p++, o += 4) {
    if (!out[o + 3]) continue;
    let r = lut[out[o]], g = lut[out[o + 1]], b = lut[out[o + 2]];
    if (color) [r, g, b] = colorMove(r, g, b, a);
    out[o] = r; out[o + 1] = g; out[o + 2] = b;
  }
  if (a.sharpen > 0) sharpen(out, W, H, a.sharpen / 100 * 1.5, Math.max(1, Math.round(Math.max(W, H) / 1200)));
  return out;
}

/** Unsharp mask in place: a box blur of radius r (two passes ≈ Gaussian), out += amount × (out − blur). Edges and
    fine lines get crisper on the film; flat areas and gradients do not change (their blur equals themselves). */
export function sharpen(px, W, H, amount, r = 1) {
  const blur = new Float32Array(W * H * 3), tmp = new Float32Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let c = 0; c < 3; c++) {
    let s = 0, n = 0; for (let d = -r; d <= r; d++) { const xx = x + d; if (xx >= 0 && xx < W) { s += px[(y * W + xx) * 4 + c]; n++; } }
    tmp[(y * W + x) * 3 + c] = s / n; }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let c = 0; c < 3; c++) {
    let s = 0, n = 0; for (let d = -r; d <= r; d++) { const yy = y + d; if (yy >= 0 && yy < H) { s += tmp[(yy * W + x) * 3 + c]; n++; } }
    blur[(y * W + x) * 3 + c] = s / n; }
  for (let p = 0; p < W * H; p++) { if (!px[p * 4 + 3]) continue; for (let c = 0; c < 3; c++) { const v = px[p * 4 + c]; px[p * 4 + c] = v + amount * (v - blur[p * 3 + c]); } }
}
