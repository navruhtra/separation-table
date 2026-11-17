// @ts-check
// Film files: PNG, PDF (pdf-lib), 1-bit TIFF and EPS (written here), packed in a ZIP (JSZip).
import { dotOn, screenAxes } from "./engine.js";
import { VERSION } from "./version.js";
import { FILM_MARGIN_IN } from "./sizes.js";
function loadScript(src, global) {
  if (self[global]) return Promise.resolve(self[global]);
  return new Promise((res, rej) => { const s = document.createElement("script"); s.src = new URL(src, import.meta.url).href; s.onload = () => res(self[global]); s.onerror = () => rej(new Error(`${src} could not be loaded.`)); document.head.appendChild(s); });
}
export const zipLib = () => loadScript("./vendor/jszip.min.js", "JSZip");
export const pdfLib = () => loadScript("./vendor/pdf-lib.min.js", "PDFLib");

/** Mirror an image left to right (stride values per pixel: 1 for a plate or channel, 4 for RGBA). A new array. */
export function mirrorX(src, w, h, stride = 1) {
  const out = new /** @type {any} */ (src.constructor)(src.length);
  for (let y = 0; y < h; y++) { const r = y * w; for (let x = 0; x < w; x++) { const a = (r + x) * stride, b = (r + w - 1 - x) * stride; for (let k = 0; k < stride; k++) out[b + k] = src[a + k]; } }
  return out;
}
/* Compose a film: plate bits + margin, registration marks and a label. Returns {canvas, bits, w, h} where bits is the finished 1-bit film.
   mirror: the whole film is flipped left to right (art, marks, test strip and label), the way a RIP mirrors a page for
   emulsion-down output; the label then reads the right way through the film. */
export function composeFilm(bits, w, h, dpi, label, strip = null, mirror = false) {
  const mx = Math.round(dpi * FILM_MARGIN_IN), W = w + mx * 2, H = h + mx * 2, c = document.createElement("canvas"); c.width = W; c.height = H;
  const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, W, H);
  const id = g.getImageData(mx, mx, w, h), d = id.data;
  for (let i = 0; i < w * h; i++) { const v = bits[i] ? 0 : 255; d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255; }
  g.putImageData(id, mx, mx);
  g.strokeStyle = "#000"; g.lineWidth = Math.max(1, dpi / 150);
  const rm = (cx, cy) => { const r = dpi * 0.12; g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.moveTo(cx - r * 1.6, cy); g.lineTo(cx + r * 1.6, cy); g.moveTo(cx, cy - r * 1.6); g.lineTo(cx, cy + r * 1.6); g.stroke(); };
  rm(W / 2, mx / 2); rm(W / 2, H - mx / 2); rm(mx / 2, H / 2); rm(W - mx / 2, H / 2);
  // test strip in the bottom margin: solid, then 5–95% halftone steps at the film's own LPI and angle, so the shop can
  // check film density (Dmax) and which dots expose and hold before burning the screen
  if (strip && strip.lpi) {
    // stop short of the centred bottom registration mark (radius × 1.6 ≈ 0.19 × dpi)
    const steps = [100, 95, 90, 75, 50, 25, 10, 5], avail = W / 2 - mx - dpi * 0.25, sw = Math.max(4, Math.min(Math.round(dpi * 0.3), Math.floor(avail / steps.length))), sh = Math.round(mx * 0.35), y0 = H - Math.round(mx * 0.45), x0 = mx;
    const { cs, sn } = screenAxes(strip.angle || 0), cell = dpi / strip.lpi, sd = g.getImageData(x0, y0, sw * steps.length, sh);
    for (let k = 0; k < steps.length; k++) for (let yy = 0; yy < sh; yy++) for (let xx = 0; xx < sw; xx++) {
      const X = x0 + k * sw + xx, Y = y0 + yy, on = dotOn(strip.shape, X, Y, steps[k] / 100, cell, cs, sn), q = (yy * sw * steps.length + k * sw + xx) * 4;
      const v = on ? 0 : 255; sd.data[q] = sd.data[q + 1] = sd.data[q + 2] = v; sd.data[q + 3] = 255;
    }
    g.putImageData(sd, x0, y0); g.fillStyle = "#000"; g.font = `${Math.max(6, Math.round(Math.min(dpi * 0.06, sw * 0.3)))}px Helvetica Neue, Arial, sans-serif`;
    steps.forEach((t, k) => g.fillText(`${t}%`, x0 + k * sw + 2, y0 - 4));
  }
  g.fillStyle = "#000"; g.font = `700 ${Math.round(dpi * 0.11)}px Helvetica Neue, Arial, sans-serif`; g.fillText(label, mx, mx * 0.8, Math.max(dpi * 0.5, W / 2 - mx - dpi * 0.25)); // stop short of the top registration mark
  let cv = c;
  if (mirror) { cv = document.createElement("canvas"); cv.width = W; cv.height = H; const m = cv.getContext("2d"); m.translate(W, 0); m.scale(-1, 1); m.drawImage(c, 0, 0); }
  const all = cv.getContext("2d").getImageData(0, 0, W, H).data, out = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) out[i] = all[i * 4] < 128 ? 1 : 0;
  return { canvas: cv, bits: out, w: W, h: H };
}
export const toPNG = canvas => new Promise(r => canvas.toBlob(b => r(b), "image/png"));

export async function toPDF(films, dpi) {
  const { PDFDocument } = await pdfLib(), doc = await PDFDocument.create();
  for (const f of films) {
    const img = await doc.embedPng(await f.png.arrayBuffer()), wp = f.w / dpi * 72, hp = f.h / dpi * 72;
    const page = doc.addPage([wp, hp]); page.drawImage(img, { x: 0, y: 0, width: wp, height: hp });
  }
  doc.setTitle("Screen print films"); doc.setCreator("ADN Separation Table");
  return new Blob([await doc.save()], { type: "application/pdf" });
}

function packBits(row) {
  const out = []; let i = 0;
  while (i < row.length) {
    let j = i + 1; while (j < row.length && j - i < 128 && row[j] === row[i]) j++;
    if (j - i >= 3) { out.push(257 - (j - i), row[i]); i = j; continue; }
    j = i; while (j < row.length && j - i < 128 && !(j + 2 < row.length && row[j] === row[j + 1] && row[j] === row[j + 2])) j++;
    out.push(j - i - 1); for (let k = i; k < j; k++) out.push(row[k]); i = j;
  }
  return out;
}
/* Photoshop file for a RIP or for printing separations from Photoshop: one named spot channel per screen in print
   order (Photoshop's Channels panel shows the ink color and solidity). Channel tone is the film's dot area before any
   RIP curve: black = 100% ink. RLE (PackBits) compressed, resolution set to print size.
   Without rgba (the production file) it is a Multichannel document holding only the spot channels: no RGB/CMYK
   composite that a RIP or Photoshop's Print Separations could output as extra plates. With rgba it is an RGB document
   with the art as the composite plus the same spot channels (a preview for hand finishing, not for the press).
   channels: [{ name, rgb:[r,g,b], solidity 0–100, data: Uint8Array(W*H) with 0 = full ink, 255 = none }]
   screens (Multichannel only, optional): [{ lpi, angle, shape }] per channel, written as Photoshop's halftone screens
   (resource 1012) so Photoshop's Print and a RIP that reads them use the films' ruling, angle and dot shape. */
export function toPSD({ W, H, dpi, rgba = null, channels, screens = null }) {
  const parts = [], u8 = a => parts.push(Uint8Array.from(a));
  const be16 = v => [(v >> 8) & 255, v & 255], be32 = v => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  const ascii = s => [...s].map(c => c.charCodeAt(0) & 255);
  if (!channels.length) throw new Error("toPSD: no channels");
  const nComp = rgba ? 3 : 0, nCh = nComp + channels.length;
  u8([...ascii("8BPS"), ...be16(1), 0, 0, 0, 0, 0, 0, ...be16(nCh), ...be32(H), ...be32(W), ...be16(8), ...be16(rgba ? 3 : 7)]); // header: RGB (3) or Multichannel (7)
  u8(be32(0)); // color mode data
  // image resources
  const res = [];
  const resource = (id, data) => { const d = data.length % 2 ? [...data, 0] : data; res.push(...ascii("8BIM"), ...be16(id), 0, 0, ...be32(data.length), ...d); };
  const fixed = v => be32(Math.round(v * 65536));
  resource(1005, [...fixed(dpi), ...be16(1), ...be16(1), ...fixed(dpi), ...be16(1), ...be16(1)]); // ppi, inches
  const latin = s => s.replace(/[^\x20-\x7e]/g, "?").slice(0, 63);
  resource(1006, channels.flatMap(c => { const t = ascii(latin(c.name)); return [t.length, ...t]; }));
  resource(1045, channels.flatMap(c => { const cps = [...c.name].map(ch => ch.charCodeAt(0)); return [...be32(cps.length), ...cps.flatMap(be16)]; }));
  // Halftone screen parameter structure, 18 bytes each (Adobe Photoshop File Formats Specification, "Halftone screens
  // file format"): frequency 16.16 fixed, units (1 = lines per inch), angle 16.16 fixed, shape code, 4 bytes 0, use
  // accurate screens, use printer's default screens. One per channel, in channel order (the layout psd-tools reads).
  if (screens && !rgba) resource(1012, screens.flatMap(sc => [...fixed(sc.lpi), ...be16(1), ...be32(Math.round(sc.angle * 65536) | 0), ...be16(PSD_SHAPE[sc.shape] ?? 0), 0, 0, 0, 0, 0, 0]));
  resource(1077, [...be32(1), ...channels.flatMap(c => [...be16(0), ...c.rgb.flatMap(v => be16(Math.round(Math.max(0, Math.min(255, v)) * 257))), ...be16(0), ...be16(Math.round(c.solidity ?? 100)), 2])]);
  u8([...be32(res.length), ...res]);
  u8(be32(0)); // no layers: Photoshop opens the merged image and the channels
  // image data, RLE
  const rows = [], counts = [];
  const planes = (rgba ? [0, 1, 2] : []).map(k => { const pl = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) { const a = rgba[i * 4 + 3] / 255; pl[i] = Math.round(rgba[i * 4 + k] * a + 255 * (1 - a)); } return pl; }).concat(channels.map(c => c.data));
  for (const pl of planes) for (let y = 0; y < H; y++) { const r = packBits(pl.subarray(y * W, (y + 1) * W)); rows.push(Uint8Array.from(r)); counts.push(r.length); }
  u8(be16(1)); u8(counts.flatMap(be16)); for (const r of rows) parts.push(r);
  return new Blob(parts, { type: "image/vnd.adobe.photoshop" });
}

/* Photoshop's shape codes (same specification): 0 Round, 1 Ellipse, 2 Line, 3 Square. */
const PSD_SHAPE = { round: 0, ellipse: 1, line: 2, square: 3 };
/* PostScript spot functions for setscreen, verbatim from ISO 32000-1:2008 Table 128 (Round, Ellipse, Square, Line). */
export const PS_SPOT = {
  round: "{ abs exch abs 2 copy add 1 le { dup mul exch dup mul add 1 exch sub } { 1 sub dup mul exch 1 sub dup mul add 1 sub } ifelse }",
  ellipse: "{ abs exch abs 2 copy 3 mul exch 4 mul add 3 sub dup 0 lt { pop dup mul exch 0.75 div dup mul add 4 div 1 exch sub } { dup 1 gt { pop 1 exch sub dup mul exch 1 exch sub 0.75 div dup mul add 4 div 1 sub } { 0.5 exch sub exch pop exch pop } ifelse } ifelse }",
  square: "{ abs exch abs 2 copy lt { exch } if pop neg }",
  line: "{ exch pop abs neg }",
};
/** PostScript RunLengthDecode data (PLRM 3rd ed. 3.13.3): the same byte runs as TIFF PackBits, then the EOD byte 128. */
function runLength(bytes, rowLen) {
  const out = []; for (let o = 0; o < bytes.length; o += rowLen) for (const v of packBits(bytes.subarray(o, Math.min(bytes.length, o + rowLen)))) out.push(v);
  out.push(128); return Uint8Array.from(out);
}
/* DSC text: printable ASCII, and no parentheses or backslash inside a (name). */
const dscName = s => String(s).replace(/[^\x20-\x7e]/g, "?").replace(/[()\\]/g, "").slice(0, 200);
/** Desktop Color Separation 2.0, single file (Quark, "Desktop Color Separation Specification 2.0", 1993, rev. 1995):
 *  the format Photoshop saves as "Photoshop DCS 2.0" and RIPs such as AccuRIP read. One EPS holds a composite preview for
 *  proofing, then one EPS section per screen in print order. The header names each screen as a custom color with its
 *  RGB and CMYK approximation (DSC 3.0, %%RGBCustomColor / %%CMYKCustomColor) and gives its section's byte offset and
 *  length (%%PlateFile: (name) EPS #offset size). Channel tone is the same as the Photoshop file: black = 100% ink,
 *  before dot-gain compensation, so the RIP's curve applies as usual. With screens, each section sets its own halftone
 *  (setscreen: ruling, angle and spot function), the dot shape the films use; without, the RIP's screen applies.
 *  channels: as toPSD, plus optional lpi, angle, shape. background: garment sRGB for the composite.
 *  Returns { blob, plates: [{ name, offset, size }] }. */
export function toDCS({ W, H, dpi, channels, background = [255, 255, 255], title = "Separations", screens = true }) {
  if (!channels.length) throw new Error("toDCS: no channels");
  const enc = new TextEncoder(), wp = W / dpi * 72, hp = H / dpi * 72, bb = `%%BoundingBox: 0 0 ${Math.ceil(wp)} ${Math.ceil(hp)}\n%%HiResBoundingBox: 0 0 ${wp.toFixed(3)} ${hp.toFixed(3)}\n`;
  const names = channels.map(c => dscName(c.name)), f3 = v => (Math.round(v * 1000) / 1000).toString();
  // one EPS section: header, an image read straight from the file (RunLengthDecode), and flushfile so the interpreter
  // resumes after the data's end marker. %%BeginData counts the "exec" line too (DSC 3.0, %%BeginData).
  const section = (head, setup, colorSpace, comps, data) => {
    const rl = runLength(data, W * comps), call = "exec\n";
    const pre = enc.encode(`%!PS-Adobe-3.0 EPSF-3.0\n%%Creator: ADN Separation Table\n${bb}${head}%%LanguageLevel: 2\n%%DocumentData: Binary\n%%EndComments\n` +
      `10 dict begin\ngsave\n${setup}${wp.toFixed(3)} ${hp.toFixed(3)} scale\n/${colorSpace} setcolorspace\n/adnData currentfile /RunLengthDecode filter def\n` +
      `{ << /ImageType 1 /Width ${W} /Height ${H} /BitsPerComponent 8 /Decode [${Array(comps).fill("0 1").join(" ")}] /ImageMatrix [${W} 0 0 -${H} 0 ${H}] /DataSource adnData >> image adnData flushfile }\n` +
      `%%BeginData: ${call.length + rl.length} Binary Bytes\n${call}`);
    const post = enc.encode("\n%%EndData\ngrestore\nend\nshowpage\n%%Trailer\n");
    const out = new Uint8Array(pre.length + rl.length + post.length); out.set(pre, 0); out.set(rl, pre.length); out.set(post, pre.length + rl.length); return out;
  };
  // composite: each screen's ink laid over the garment in print order by its tone (no ink model), like Print > All
  const P = W * H, comp = new Uint8Array(P * 3);
  for (let q = 0; q < P; q++) { let r = background[0], g = background[1], b = background[2];
    for (const c of channels) { const a = 1 - c.data[q] / 255; if (a <= 0) continue; r += (c.rgb[0] - r) * a; g += (c.rgb[1] - g) * a; b += (c.rgb[2] - b) * a; }
    comp[q * 3] = Math.round(r); comp[q * 3 + 1] = Math.round(g); comp[q * 3 + 2] = Math.round(b); }
  const plates = channels.map((c, i) => {
    const sc = screens && c.lpi ? `${f3(c.lpi)} ${f3(c.angle || 0)} ${PS_SPOT[c.shape] || PS_SPOT.round} setscreen\n` : "";
    return section(`%%Title: (${names[i]})\n`, sc, "DeviceGray", 1, c.data);
  });
  const colorLines = channels.map((c, i) => { const [r, g, b] = c.rgb.map(v => Math.max(0, Math.min(255, v)) / 255), k = 1 - Math.max(r, g, b), d = 1 - k || 1;
    return `%%RGBCustomColor: ${f3(r)} ${f3(g)} ${f3(b)} (${names[i]})\n%%CMYKCustomColor: ${f3((1 - r - k) / d)} ${f3((1 - g - k) / d)} ${f3((1 - b - k) / d)} ${f3(k)} (${names[i]})\n`; }).join("");
  // header comments stay under 255 characters a line (spec, Common problems 9): one name a line, continued with %%+
  const custom = "%%DocumentCustomColors: " + names.map(n => `(${n})`).join("\n%%+ ") + "\n";
  const head = offs => `%%Title: (${dscName(title)})\n${custom}${colorLines}` + names.map((n, i) => `%%PlateFile: (${n}) EPS #${offs[i]} ${plates[i].length}\n`).join("");
  // the main section's length depends on the offsets written in it: repeat until the digits stop changing
  let offs = plates.map(() => 0), main = section(head(offs), "", "DeviceRGB", 3, comp);
  for (let k = 0; k < 4; k++) { const next = []; let o = main.length; for (const p of plates) { next.push(o); o += p.length; }
    if (next.every((v, i) => v === offs[i])) break; offs = next; main = section(head(offs), "", "DeviceRGB", 3, comp); }
  return { blob: new Blob([main, ...plates], { type: "application/postscript" }), plates: names.map((name, i) => ({ name, offset: offs[i], size: plates[i].length })) };
}

/* Bilevel TIFF, PackBits, WhiteIsZero (1 = ink = black), resolution tagged so RIPs place it at true size. */
export function toTIFF(bits, w, h, dpi) {
  const rb = Math.ceil(w / 8), data = [];
  for (let y = 0; y < h; y++) { const row = new Uint8Array(rb); for (let x = 0; x < w; x++) if (bits[y * w + x]) row[x >> 3] |= 0x80 >> (x & 7); for (const v of packBits(row)) data.push(v); }
  const tags = [[256, 4, 1, w], [257, 4, 1, h], [258, 3, 1, 1], [259, 3, 1, 32773], [262, 3, 1, 0], [273, 4, 1, 0], [277, 3, 1, 1], [278, 4, 1, h], [279, 4, 1, data.length], [282, 5, 1, 0], [283, 5, 1, 0], [296, 3, 1, 2]];
  const ifdOff = 8, ifdLen = 2 + tags.length * 12 + 4, ratOff = ifdOff + ifdLen, dataOff = ratOff + 16;
  const buf = new ArrayBuffer(dataOff + data.length), dv = new DataView(buf), u8 = new Uint8Array(buf);
  dv.setUint16(0, 0x4949); dv.setUint16(2, 42, true); dv.setUint32(4, ifdOff, true); dv.setUint16(ifdOff, tags.length, true);
  tags.forEach(([tag, type, count, val], i) => {
    const o = ifdOff + 2 + i * 12; dv.setUint16(o, tag, true); dv.setUint16(o + 2, type, true); dv.setUint32(o + 4, count, true);
    if (tag === 273) val = dataOff; if (tag === 282) val = ratOff; if (tag === 283) val = ratOff + 8;
    if (type === 3) dv.setUint16(o + 8, val, true); else dv.setUint32(o + 8, val, true);
  });
  dv.setUint32(ifdOff + 2 + tags.length * 12, 0, true);
  dv.setUint32(ratOff, dpi, true); dv.setUint32(ratOff + 4, 1, true); dv.setUint32(ratOff + 8, dpi, true); dv.setUint32(ratOff + 12, 1, true);
  u8.set(data, dataOff);
  return new Blob([buf], { type: "image/tiff" });
}
/* EPS (PostScript Level 2) with a 1-bit imagemask at true size. */
export function toEPS(bits, w, h, dpi, title) {
  const wp = w / dpi * 72, hp = h / dpi * 72, rb = Math.ceil(w / 8), hex = "0123456789abcdef", parts = [];
  parts.push(`%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 ${Math.ceil(wp)} ${Math.ceil(hp)}\n%%HiResBoundingBox: 0 0 ${wp.toFixed(3)} ${hp.toFixed(3)}\n%%Title: ${title}\n%%Creator: ADN Separation Table\n%%LanguageLevel: 2\n%%EndComments\n`);
  parts.push(`gsave\n0 setgray\n${wp.toFixed(3)} ${hp.toFixed(3)} scale\n/rowstr ${rb} string def\n${w} ${h} true [${w} 0 0 -${h} 0 ${h}]\n{currentfile rowstr readhexstring pop} imagemask\n`);
  for (let y = 0; y < h; y++) { let line = ""; for (let b = 0; b < rb; b++) { let v = 0; for (let k = 0; k < 8; k++) { const x = b * 8 + k; if (x < w && bits[y * w + x]) v |= 0x80 >> k; } line += hex[v >> 4] + hex[v & 15]; } parts.push(line + "\n"); }
  parts.push("grestore\n%%EOF\n");
  return new Blob(parts, { type: "application/postscript" });
}

/* Mix sheet (PDF): one row per screen with the target color to match in the producer's own Pantone guide or Pantone
   Connect, the ink to mix, an estimated batch weight, and blanks for the matched code, the formula and the drawdown
   check. No Pantone data is used or suggested here. */
/* PDF standard fonts are WinAnsi: replace the few non-ASCII characters the sheets use. */
const ascii = t => String(t).replace(/[^\x20-\x7e]/g, c => ({ "\u0394": "d", "\u00b0": " deg", "\u2013": "-", "\u2014": "-", "\u00d7": "x", "\u00b7": "|", "\u2264": "<=", "\u2265": ">=" })[c] || "?");

/** Job sheet for the press and the customer: the art beside the print preview, every screen in print order with its
 *  film, mesh, coverage and what follows it (flash, cure), the press settings, and lines to sign the approval.
 *  screens: separation.json screens plus hex and rgb; art and print: PNG blobs of the same size. */
export async function toJobSheet({ job, screens, print, art, proof }) {
  const { PDFDocument, StandardFonts, rgb } = await pdfLib(), doc = await PDFDocument.create(), font = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let page = doc.addPage([792, 612]), y = 572;
  const ink = rgb(0, 0.06, 0.54), grey = rgb(0.6, 0.6, 0.6);
  const text = (t, x, yy, size = 9, f = font) => page.drawText(ascii(t), { x, y: yy, size, font: f, color: ink });
  text("JOB SHEET", 36, y, 16, bold); text(job.title, 150, y + 2, 10); y -= 18;
  text(job.line, 36, y, 9); y -= 16;
  // art and print preview side by side, same size, so the customer approves what the screens print
  const imgs = [["Art", art], ["Print preview (model)", proof]].filter(([, b]) => b);
  if (imgs.length) {
    const emb = await Promise.all(imgs.map(async ([, b]) => doc.embedPng(await b.arrayBuffer()))), boxW = 340, boxH = 220;
    const s = Math.min(boxW / emb[0].width, boxH / emb[0].height), w = emb[0].width * s, h = emb[0].height * s;
    emb.forEach((im, i) => { const x = 36 + i * (boxW + 40); page.drawImage(im, { x, y: y - h, width: w, height: h }); page.drawRectangle({ x, y: y - h, width: w, height: h, borderColor: grey, borderWidth: 0.5 }); text(imgs[i][0], x, y - h - 11, 8, bold); });
    y -= h + 30;
  }
  const cols = [36, 62, 104, 300, 430, 480, 540];
  ["#", "Ink", "", "Film", "Mesh", "Coverage", "Then"].forEach((t, i) => text(t, cols[i], y, 7.5, bold)); y -= 5;
  page.drawLine({ start: { x: 36, y }, end: { x: 756, y }, thickness: 0.5, color: grey }); y -= 16;
  for (const sc of screens) {
    if (y < 120) { page = doc.addPage([792, 612]); y = 560; }
    const [R, G, B] = sc.rgb.map(v => v / 255);
    text(String(sc.order), cols[0], y, 10, bold);
    page.drawRectangle({ x: cols[1], y: y - 4, width: 30, height: 14, color: rgb(R, G, B), borderColor: grey, borderWidth: 0.5 });
    text(sc.name, cols[2], y, 9, bold); text(sc.hex, cols[2] + 130, y, 8);
    text(sc.film, cols[3], y, 9); text(String(sc.mesh || "-"), cols[4], y, 9); text(`${(sc.coverage * 100).toFixed(1)}%`, cols[5], y, 9);
    const then = [sc.hits === 2 ? (sc.flash_between_hits ? "Print 2x, flash between" : "Print 2x") : "", sc.cure ? "Cure" : sc.flash ? "Flash" : ""].filter(Boolean).join(", then ");
    text(then || "-", cols[6], y, 9, then ? bold : font);
    y -= 20;
  }
  y -= 4; text(print, 36, y, 8); y -= 13;
  for (const l of job.notes || []) { text(l, 36, y, 8); y -= 13; }
  y -= 13;
  // approval: the customer signs the preview, the printer signs the press check against it
  [["Customer approval", 36], ["Press check", 420]].forEach(([t, x]) => { text(`${t}:`, +x, y, 9, bold);
    page.drawLine({ start: { x: +x + 100, y: y - 2 }, end: { x: +x + 250, y: y - 2 }, thickness: 0.5, color: grey }); text("Date:", +x + 258, y, 9);
    page.drawLine({ start: { x: +x + 286, y: y - 2 }, end: { x: +x + 336, y: y - 2 }, thickness: 0.5, color: grey }); });
  // press habits from the research (Texsource XpZ_i5CY36c 02:39, Ryonet qzmRK3NmI9c 36:41): judge after warm-up pulls, one stroke
  text("Before you judge the print: pull 4 to 5 test prints so the screens warm up. Push the squeegee, do not pull, with the same stroke on every print.", 36, Math.max(y - 20, 43), 8);
  text("The preview is a model of the print, not a press proof. Colors are approximate until the press is calibrated.", 36, Math.max(y - 34, 29), 7.5);
  text(`Separation Table ${VERSION}`, 660, 29, 7.5);
  return new Blob([await doc.save()], { type: "application/pdf" });
}

export async function toMixSheet({ rows, job }) {
  const { PDFDocument, StandardFonts, rgb } = await pdfLib(), doc = await PDFDocument.create(), font = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let page = doc.addPage([792, 612]), y = 572;
  const text = (t, x, yy, size = 9, f = font) => page.drawText(ascii(t), { x, y: yy, size, font: f, color: rgb(0, 0.06, 0.54) });
  text("INK MIX SHEET", 36, y, 16, bold); text(ascii(job.title), 200, y + 2, 10); y -= 18;
  text(ascii(job.line), 36, y, 9); y -= 14;
  text("How to use: match each target swatch in your own PANTONE(R) guide or Pantone Connect, get the formula from your ink maker's mixing system, mix the batch, print a drawdown on this shirt and check it before the run.", 36, y, 7.5); y -= 18;
  const cols = [36, 62, 110, 250, 330, 380, 430, 490, 590, 690];
  ["#", "Swatch", "Ink (code)", "Target hex / Lab", "Coverage", "Mesh", "Mix (g)", "Creator asked for", "Matched code / formula", "Drawdown OK"].forEach((h, i) => text(h, cols[i], y, 7.5, bold)); y -= 6;
  page.drawLine({ start: { x: 36, y }, end: { x: 756, y }, thickness: 0.5, color: rgb(0.6, 0.6, 0.6) }); y -= 30;
  for (const r of rows) {
    if (y < 60) { page = doc.addPage([792, 612]); y = 560; }
    const [R, G, B] = r.rgb.map(v => v / 255);
    text(String(r.order), cols[0], y + 8, 10, bold);
    page.drawRectangle({ x: cols[1], y: y - 2, width: 38, height: 26, color: rgb(R, G, B), borderColor: rgb(0.6, 0.6, 0.6), borderWidth: 0.5 });
    text(r.name, cols[2], y + 12, 9, bold); text([[r.system, r.code].filter(Boolean).join(" ") || "-", r.hits === 2 ? "2 hits" : ""].filter(Boolean).join(" | "), cols[2], y + 1, 7.5);
    text(r.hex, cols[3], y + 12, 9); text(`L ${r.lab[0]}  a ${r.lab[1]}  b ${r.lab[2]}`, cols[3], y + 1, 7.5);
    text(`${r.coverage}%`, cols[4], y + 8); text(String(r.mesh || "-"), cols[5], y + 8); text(String(r.grams), cols[6], y + 8, 10, bold);
    text(r.requested || "-", cols[7], y + 8, 8);
    (r.stock || []).slice(0, 2).forEach((k, i) => text(`${i ? "or" : "Start:"} ${k.system} ${k.code} ${k.name}`.slice(0, 40) + ` ~${k.de}`, cols[8], y + 19 - i * 8, 6.5));
    page.drawLine({ start: { x: cols[8], y: y + 2 }, end: { x: cols[9] - 8, y: y + 2 }, thickness: 0.5, color: rgb(0.6, 0.6, 0.6) });
    page.drawRectangle({ x: cols[9], y: y + 2, width: 10, height: 10, borderColor: rgb(0.6, 0.6, 0.6), borderWidth: 0.5 });
    y -= 36;
  }
  y -= 4; text(`Batch weights assume ${job.shirts} shirts at ${job.areaIn2.toFixed(0)} sq in print area and typical plastisol deposits; weigh a test batch and adjust.`, 36, Math.max(y, 40), 7.5);
  text("Ink colors are approximate until measured. PANTONE(R) is a trademark of Pantone LLC; this sheet contains no Pantone data.", 36, Math.max(y - 11, 29), 7.5);
  // Page 2: how to mix to the target with the tools a shop already has
  page = doc.addPage([792, 612]); y = 572;
  text("HOW TO MIX EACH SCREEN TO ITS TARGET", 36, y, 14, bold); y -= 24;
  const steps = [
    ["1. Find the target.", "If the creator named a color code (column 'Creator asked for'), open it in your own PANTONE(R) Solid Coated guide or Pantone Connect. Otherwise match the swatch, hex and Lab on this sheet. Judge against a physical reference under daylight, not a monitor: screens and office printers shift color."],
    ["2. Get a formula from your ink maker.", "Wilflex Epic PC or Rio: Avient IMS mixing software. Rutland M3: M2007 Ink Mixing Software. Union Mixopake: formulas free after registering on Union's website. International Coatings UltraMix 7500: formulation calculator at iccultramix.com. A formula only works with that brand's own mixing bases."],
    ["3. No formula? Start from the nearest stock ink.", "'Start:' under each screen is the closest ready-mixed ink (Rio = Wilflex Epic Rio, FN = FN-INK) by estimated color (~ is the estimated difference in delta E 2000; under 2 is close, over 5 needs adjusting). Adjust in small weighed steps: add the darker or stronger color into the lighter one, never the other way round, and note every gram."],
    ["4. Weigh the batch.", "Use a gram scale and the Mix (g) column. It covers this run plus about 15% waste and enough to flood the screen. Mix a small test batch first for critical colors."],
    ["5. Pull a drawdown on the real garment.", "Same garment, same mesh, over the underbase if the garment is dark. Flash and fully cure: plastisol can shift a little in color when cured. Compare to the target in daylight (D65) and under store light if you can, because two colors can match in one light and not another."],
    ["6. Approve and record.", "Write the final formula under 'Matched code / formula', tick 'Drawdown OK', and keep the cured swatch with the job for reorders. Many brands accept a delta E CMC(2:1) of about 1 to 2 for garment color; measure with a spectrophotometer when the customer specifies one."],
  ];
  const wrap = (t, max) => { const out = []; let line = ""; for (const w of ascii(t).split(" ")) { if ((line + " " + w).trim().length > max) { out.push(line.trim()); line = w; } else line += " " + w; } if (line.trim()) out.push(line.trim()); return out; };
  for (const [h, t] of steps) { text(h, 36, y, 10, bold); y -= 13; for (const l of wrap(t, 140)) { text(l, 48, y, 9); y -= 12; } y -= 9; }
  text("Ink catalog colors and nearest-ink suggestions are ADN estimates, not maker data. Brand names are trademarks of their owners; ADN is not affiliated with them.", 36, Math.max(y, 40), 7.5);
  return new Blob([await doc.save()], { type: "application/pdf" });
}
