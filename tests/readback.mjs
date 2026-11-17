// Read back every file the job ZIP holds, through our own readers: each writer's output is parsed back and compared
// with what went in (pixels, sizes, resolution, names, order). check.mjs runs readbackChecks; tests/outside-readers.mjs
// writes the same files and has other programs open them (Ghostscript, a TIFF reader, psd-tools).
//   node tests/readback.mjs [<dir>]   run the checks; with <dir>, also write the files there and expect.json
import { runInThisContext } from "node:vm";
import { deflateSync, inflateSync, crc32 } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// output.js loads pdf-lib with a script tag in the page; here the same vendor file runs as a CommonJS module
// (this folder's package.json says "type": "module", so require() would read the UMD file as an ES module)
const umd = f => { const exports = {}; runInThisContext(`(function (exports, module) {${readFileSync(new URL(f, import.meta.url), "utf8")}\n})`)(exports, { exports }); return exports; };
globalThis.self ??= globalThis; globalThis.PDFLib ??= umd("../src/vendor/pdf-lib.min.js");
const out = await import("../src/output.js"), { VERSION } = await import("../src/version.js"), P = await import("../src/plan.js");

/* ───────────── a small job: three screens with known pixels ───────────── */
const W = 125, H = 75, DPI = 300; // odd width: the 1-bit rows end in a part byte; whole points (30 × 18 pt), so a renderer's page is the film
const PLATES = [
  { order: 1, name: "Underbase", ub: true, lab: [95, 0, 2], rgb: [244, 244, 240], mesh: 156 },
  { order: 2, name: "Sim Red", idx: 0, lab: [48, 66, 46], rgb: [208, 42, 48], mesh: 230, angle: 22.5 },
  { order: 3, name: "Navy", idx: 1, lab: [22, 6, -32], rgb: [28, 42, 74], mesh: 230, angle: 22.5 },
];
const bitsOf = k => Uint8Array.from({ length: W * H }, (_, i) => { const x = i % W, y = (i / W) | 0; return k === 0 ? +((x - 62) ** 2 + (y - 37) ** 2 < 1000) : k === 1 ? +((x + y * 3) % 7 < 3) : +(x < y * 1.5); });
const toneOf = k => Uint8Array.from({ length: W * H }, (_, i) => Math.round(255 * ((i % W) / (W - 1) + k * 0.1) % 256));

/** A grayscale PNG (filter 0 rows, zlib): what composeFilm's canvas gives the PDF in the page. */
function grayPNG(px, w, h) {
  const chunk = (type, data) => { const t = Buffer.from(type, "latin1"), len = Buffer.alloc(4), crc = Buffer.alloc(4); len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0;
  const raw = Buffer.alloc((w + 1) * h); for (let y = 0; y < h; y++) raw.set(px.subarray(y * w, (y + 1) * w), y * (w + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const blobBytes = async b => new Uint8Array(await b.arrayBuffer());

/** Every file of the job, as the page names them in the ZIP, plus what each one must read back as. */
export async function buildExports() {
  const files = {}, films = [];
  const channels = PLATES.map((p, k) => ({ name: `${p.order}. ${p.name}`, rgb: p.rgb, solidity: 100, data: toneOf(k) }));
  for (const [k, p] of PLATES.entries()) {
    const bits = bitsOf(k), slug = P.plateSlug(p);
    files[`tiff/${slug}.tif`] = await blobBytes(out.toTIFF(bits, W, H, DPI));
    files[`eps/${slug}.eps`] = await blobBytes(out.toEPS(bits, W, H, DPI, `${p.order}. ${p.name}`));
    const gray = Uint8Array.from(bits, b => b ? 0 : 255), png = grayPNG(gray, W, H);
    files[`png/${slug}.png`] = new Uint8Array(png); films.push({ png: new Blob([png]), w: W, h: H });
  }
  files["films.pdf"] = await blobBytes(await out.toPDF(films, DPI));
  files["separations.psd"] = await blobBytes(out.toPSD({ W, H, dpi: DPI, channels }));
  const rgba = Uint8ClampedArray.from({ length: W * H * 4 }, (_, i) => i % 4 === 3 ? 255 : (i * 7) % 256);
  files["separations-preview-rgb.psd"] = await blobBytes(out.toPSD({ W, H, dpi: DPI, rgba, channels }));
  if (out.toDCS) files["separations-dcs.eps"] = await blobBytes(out.toDCS({ W, H, dpi: DPI, channels }).blob);
  const art = new Blob([grayPNG(toneOf(0), W, H)]), screens = PLATES.map(p => ({ order: p.order, name: p.name, film: "45 LPI 22.5 deg", hex: "#D02A30", rgb: p.rgb, mesh: p.mesh, coverage: 0.25, flash: p.order === 1, cure: p.order === 3 }));
  files["job-sheet.pdf"] = await blobBytes(await out.toJobSheet({ job: { title: "readback · 100 shirts", line: "Simulated process · garment #111111" }, screens, print: "Films 300 DPI", art, proof: art }));
  const rows = PLATES.map(p => ({ order: p.order, name: p.name, code: "", system: "", lab: p.lab, coverage: 25, grams: 120, requested: null, mesh: p.mesh, hex: "#D02A30", rgb: p.rgb, stock: [] }));
  files["mix-sheet.pdf"] = await blobBytes(await out.toMixSheet({ rows, job: { title: "readback · 100 shirts", line: "Garment #111111", shirts: 100, areaIn2: 120 } }));
  const spec = P.specFor({ plates: PLATES, result: { stats: { mean: 1.23456 }, covPct: [0.2, 0.3], ubPct: 0.5 }, mode: "sim", method: "Simulated process", garment: { hex: "#111111", lab: [6.1, 0, 0] },
    print: { width_in: W / DPI, dpi: DPI, lpi: 45, screening: "same" }, model: { yule_nielsen_n: 1.7, calibrated: false }, targets: [] });
  files["separation.json"] = new TextEncoder().encode(JSON.stringify(spec, null, 2));
  return { files, W, H, dpi: DPI, plates: PLATES, bits: PLATES.map((_, k) => bitsOf(k)), tones: PLATES.map((_, k) => toneOf(k)), channels, version: VERSION };
}

/* ───────────── our readers ───────────── */
const unpackBits = (src, o, n) => { const row = new Uint8Array(n); let i = 0; while (i < n) { const c = src[o++]; if (c < 128) { for (let k = 0; k <= c; k++) row[i++] = src[o++]; } else if (c > 128) { const v = src[o++]; for (let k = 0; k < 257 - c; k++) row[i++] = v; } } return { row, o }; };
const bitRows = (bytes, w, h, rowAt) => { const bits = new Uint8Array(w * h); for (let y = 0; y < h; y++) { const r = rowAt(y); for (let x = 0; x < w; x++) bits[y * w + x] = (r[x >> 3] >> (7 - (x & 7))) & 1; } return bits; };

/** Baseline TIFF, one strip, PackBits: size, resolution, photometric and the pixels. */
export function readTIFF(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength), le = dv.getUint16(0) === 0x4949, u16 = o => dv.getUint16(o, le), u32 = o => dv.getUint32(o, le);
  if (u16(2) !== 42) throw new Error("not a TIFF"); const ifd = u32(4), tags = {};
  for (let i = 0; i < u16(ifd); i++) { const o = ifd + 2 + i * 12, type = u16(o + 2); tags[u16(o)] = type === 3 ? u16(o + 8) : u32(o + 8); }
  const w = tags[256], h = tags[257], rat = o => u32(o) / u32(o + 4), rb = Math.ceil(w / 8); let o = tags[273];
  const bits = bitRows(b, w, h, () => { const r = unpackBits(b, o, rb); o = r.o; return r.row; });
  return { w, h, bitsPerSample: tags[258], compression: tags[259], photometric: tags[262], xdpi: rat(tags[282]), ydpi: rat(tags[283]), unit: tags[296], bits };
}
/** EPS with one hex imagemask: bounding box in points and the pixels. */
export function readEPS(b) {
  const t = new TextDecoder("latin1").decode(b), bb = t.match(/%%HiResBoundingBox: 0 0 ([\d.]+) ([\d.]+)/), m = t.match(/(\d+) (\d+) true \[/);
  const w = +m[1], h = +m[2], rb = Math.ceil(w / 8), lines = t.slice(t.indexOf("imagemask\n") + 10).split("\n");
  return { w, h, wpt: +bb[1], hpt: +bb[2], dsc: t.startsWith("%!PS-Adobe-3.0 EPSF-3.0\n") && t.trimEnd().endsWith("%%EOF"), bits: bitRows(b, w, h, y => Uint8Array.from(lines[y].match(/../g), x => parseInt(x, 16))) };
}
/** Photoshop file: mode, size, resolution, channel names, colours and the RLE pixel data of each channel. */
export function readPSD(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength), u16 = o => dv.getUint16(o), u32 = o => dv.getUint32(o);
  if (new TextDecoder().decode(b.subarray(0, 4)) !== "8BPS" || u16(4) !== 1) throw new Error("not a PSD");
  const nCh = u16(12), H = u32(14), W = u32(18), depth = u16(22), mode = u16(24); let o = 26 + 4 + u32(26);
  const resEnd = o + 4 + u32(o), res = {}; o += 4;
  while (o < resEnd) { const id = u16(o + 4), nameLen = b[o + 6], p = o + 6 + ((nameLen + 2) & ~1), len = u32(p); res[id] = b.subarray(p + 4, p + 4 + len); o = p + 4 + len + (len & 1); }
  o = resEnd; o += 4 + u32(o); const comp = u16(o); o += 2;
  const counts = Array.from({ length: nCh * H }, (_, i) => u16(o + i * 2)); o += nCh * H * 2;
  const planes = []; for (let c = 0; c < nCh; c++) { const pl = new Uint8Array(W * H); for (let y = 0; y < H; y++) { pl.set(unpackBits(b, o, W).row, y * W); o += counts[c * H + y]; } planes.push(pl); }
  const r1005 = res[1005], dpi = r1005 ? new DataView(r1005.buffer, r1005.byteOffset).getUint32(0) / 65536 : null;
  const names = []; if (res[1045]) { const r = res[1045], d = new DataView(r.buffer, r.byteOffset, r.byteLength); for (let p = 0; p < r.length;) { const n = d.getUint32(p); p += 4; names.push(String.fromCharCode(...Array.from({ length: n }, (_, k) => d.getUint16(p + k * 2)))); p += n * 2; } }
  const colors = []; if (res[1077]) { const r = res[1077], d = new DataView(r.buffer, r.byteOffset, r.byteLength); for (let p = 4; p + 13 <= r.length; p += 13) colors.push([2, 4, 6].map(k => Math.round(d.getUint16(p + k) / 257))); }
  return { W, H, depth, mode, comp, nCh, dpi, names, colors, planes, end: o === b.length };
}
/** PDF text, from every (inflated) content stream: the literal and hex strings each Tj shows. */
export function pdfText(b) {
  const s = Buffer.from(b), parts = []; let i = 0;
  while ((i = s.indexOf("stream", i)) >= 0) {
    let a = i + 6; if (s[a] === 13) a++; if (s[a] === 10) a++; const e = s.indexOf("endstream", a); if (e < 0) break;
    let body = s.subarray(a, e); try { body = inflateSync(body); } catch { /* not Flate */ } parts.push(body.toString("latin1")); i = e + 9;
  }
  return parts.join("\n").match(/<[0-9A-Fa-f]+>\s*Tj|\((?:\\.|[^\\)])*\)\s*Tj/g)?.map(t => t[0] === "<" ? Buffer.from(t.slice(1, t.indexOf(">")), "hex").toString("latin1") : t.slice(1, t.lastIndexOf(")"))).join("\n") || "";
}

/* ───────────── the checks ───────────── */
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
export async function readbackChecks(ok) {
  const x = await buildExports(), f = x.files, slugs = x.plates.map(P.plateSlug);
  slugs.forEach((s, k) => {
    const t = readTIFF(f[`tiff/${s}.tif`]);
    ok(t.w === x.W && t.h === x.H && t.bitsPerSample === 1 && t.compression === 32773 && t.photometric === 0 && t.xdpi === x.dpi && t.ydpi === x.dpi && t.unit === 2 && same(t.bits, x.bits[k]), `readback: tiff/${s}.tif is 1-bit PackBits at ${x.dpi} DPI with the film's pixels`);
    const e = readEPS(f[`eps/${s}.eps`]);
    ok(e.dsc && e.w === x.W && e.h === x.H && Math.abs(e.wpt - x.W / x.dpi * 72) < 0.01 && Math.abs(e.hpt - x.H / x.dpi * 72) < 0.01 && same(e.bits, x.bits[k]), `readback: eps/${s}.eps is a DSC EPS at true size with the film's pixels`);
  });
  const { PDFDocument } = globalThis.PDFLib, films = await PDFDocument.load(f["films.pdf"]), pages = films.getPages();
  ok(pages.length === x.plates.length && pages.every(p => Math.abs(p.getWidth() - x.W / x.dpi * 72) < 0.01 && Math.abs(p.getHeight() - x.H / x.dpi * 72) < 0.01) && films.getTitle() === "Screen print films",
    `readback: films.pdf opens with one true-size page per film (${pages.length})`);
  for (const [name, mode, comps] of [["separations.psd", 7, 0], ["separations-preview-rgb.psd", 3, 3]]) {
    const p = readPSD(f[name]);
    ok(p.mode === mode && p.depth === 8 && p.comp === 1 && p.W === x.W && p.H === x.H && p.dpi === x.dpi && p.nCh === comps + x.plates.length && p.end
      && same(p.names, x.channels.map(c => c.name)) && p.colors.every((c, i) => same(c, x.channels[i].rgb)) && x.tones.every((t, i) => same(p.planes[comps + i], t)),
      `readback: ${name} opens as ${mode === 7 ? "Multichannel" : "RGB"} with the spot channels in print order, their names, colours and pixels`);
  }
  if (f["separations-dcs.eps"]) {
    const d = f["separations-dcs.eps"], t = new TextDecoder("latin1").decode(d), pf = [...t.matchAll(/%%PlateFile: \((.*?)\) EPS #(\d+) (\d+)/g)];
    ok(t.startsWith("%!PS-Adobe-3.0 EPSF-3.0\n") && same(pf.map(m => m[1]), x.channels.map(c => c.name)) && pf.every(m => t.startsWith("%!PS-Adobe-3.0 EPSF-3.0\n", +m[2]) && +m[2] + +m[3] <= d.length),
      "readback: the DCS 2.0 file names each screen in print order and each %%PlateFile offset starts its EPS section");
  }
  for (const [name, head] of [["job-sheet.pdf", "JOB SHEET"], ["mix-sheet.pdf", "INK MIX SHEET"]]) {
    const doc = await PDFDocument.load(f[name]), text = pdfText(f[name]), p0 = doc.getPages()[0];
    ok(p0.getWidth() === 792 && p0.getHeight() === 612 && text.includes(head) && x.plates.every(p => text.includes(p.name)) && (name !== "job-sheet.pdf" || text.includes(`Separation Table ${x.version}`)),
      `readback: ${name} opens (US Letter landscape), says ${head} and names every screen${name === "job-sheet.pdf" ? ` and version ${x.version}` : ""}`);
  }
  const spec = JSON.parse(new TextDecoder().decode(f["separation.json"]));
  ok(spec.version === x.version && same(spec.screens.map(s => s.order), [1, 2, 3]) && same(spec.screens.map(s => s.file), slugs) && slugs.every(s => f[`tiff/${s}.tif`]) && spec.fidelity.mean === 1.235,
    "readback: separation.json parses, carries the version, and names each film file in print order");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let fails = 0; await readbackChecks((c, m) => { console.log(c ? "ok  " : "FAIL", m); if (!c) fails++; });
  const dir = process.argv[2];
  if (dir) {
    // the files, and expect.json: what each must read back as, for tests/outside-readers.py
    const x = await buildExports(), b64 = a => Buffer.from(a).toString("base64");
    for (const [n, b] of Object.entries(x.files)) { mkdirSync(join(dir, n, ".."), { recursive: true }); writeFileSync(join(dir, n), b); }
    writeFileSync(join(dir, "expect.json"), JSON.stringify({ W: x.W, H: x.H, dpi: x.dpi, version: x.version, films: x.plates.map((p, k) => ({ slug: P.plateSlug(p), bits: b64(x.bits[k]) })),
      channels: x.channels.map((c, k) => ({ name: c.name, rgb: c.rgb, tone: b64(x.tones[k]) })), screens: x.plates.map(p => p.name), dcs: !!x.files["separations-dcs.eps"] }));
    console.log(`wrote ${Object.keys(x.files).length} files and expect.json to ${dir}`);
  }
  console.log(fails ? `${fails} FAILED` : "all passed"); process.exit(fails ? 1 : 0);
}
