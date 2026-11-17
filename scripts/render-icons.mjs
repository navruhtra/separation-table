// The brand icons: each PNG and favicon.ico rendered from its SVG in src/assets/brand, with the browser the tests
// use (Playwright's Chromium), so the committed files are the SVGs' output and never edited by hand.
//   node scripts/render-icons.mjs          write the PNGs and favicon.ico
//   node scripts/render-icons.mjs --check  write nothing; fail if a committed file's pixels differ from the render
// favicon.svg is the small-size mark (3 x 3 dots): 16, 32 and 48 px and the .ico that holds them. icon.svg (5 x 5
// dots) makes the home-screen icon and the 512 px icon. social-1200x630.png is a layout with type, not one SVG's
// render: it stays as committed. Playwright comes from the repository (or NODE_PATH, as in the CI workflow).
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodePNG } from "../src/cli/platform.mjs";

const BRAND = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "assets", "brand");
/** [file, source SVG, size in px] */
const PNGS = [["favicon-16.png", "favicon.svg", 16], ["favicon-32.png", "favicon.svg", 32], ["favicon-48.png", "favicon.svg", 48],
  ["apple-touch-icon-180.png", "icon.svg", 180], ["icon-512.png", "icon.svg", 512]];
const ICO = ["favicon-16.png", "favicon-32.png", "favicon-48.png"];

/** A Windows icon file holding PNG images (Windows Vista and later, every current browser). */
function toICO(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  let off = head.length;
  pngs.forEach(({ png, size }, i) => { const o = 6 + 16 * i; head[o] = size >= 256 ? 0 : size; head[o + 1] = size >= 256 ? 0 : size;
    head.writeUInt16LE(1, o + 4); head.writeUInt16LE(32, o + 6); head.writeUInt32LE(png.length, o + 8); head.writeUInt32LE(off, o + 12); off += png.length; });
  return Buffer.concat([head, ...pngs.map(p => p.png)]);
}
/** The PNG images in an icon file, with the size each entry gives. */
function fromICO(buf) {
  const n = buf.readUInt16LE(4); return Array.from({ length: n }, (_, i) => { const o = 6 + 16 * i, size = buf[o] || 256;
    return { size, png: buf.subarray(buf.readUInt32LE(o + 12), buf.readUInt32LE(o + 12) + buf.readUInt32LE(o + 8)) }; });
}
/** The same pixels (RGBA, every channel equal), whatever the PNG encoder wrote. */
function samePixels(a, b) { const x = decodePNG(a), y = decodePNG(b); return x.W === y.W && x.H === y.H && Buffer.from(x.rgba).equals(Buffer.from(y.rgba)); }

const { chromium } = createRequire(import.meta.url)("playwright");
const browser = await chromium.launch(), page = await browser.newPage(), out = new Map();
try {
  for (const [file, src, size] of PNGS) {
    // the SVG at the icon's size, alone on the page; the screenshot is its pixels
    const svg = readFileSync(join(BRAND, src), "utf8").replace(/^<svg([^>]*?) width="\d+" height="\d+"/, `<svg$1 width="${size}" height="${size}"`);
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<!doctype html><html><body style="margin:0">${svg}</body></html>`);
    out.set(file, await page.screenshot({ clip: { x: 0, y: 0, width: size, height: size } }));
  }
} finally { await browser.close(); }
const ico = toICO(ICO.map(f => ({ png: out.get(f), size: decodePNG(out.get(f)).W })));

if (process.argv.includes("--check")) {
  const bad = [];
  for (const [file, png] of out) { let now; try { now = readFileSync(join(BRAND, file)); } catch { bad.push(`${file} is missing`); continue; }
    if (!samePixels(now, png)) bad.push(`${file} differs from its SVG's render`); }
  const icoNow = fromICO(readFileSync(join(BRAND, "favicon.ico"))), icoWant = fromICO(ico);
  if (icoNow.length !== icoWant.length || icoNow.some((e, i) => e.size !== icoWant[i].size || !samePixels(e.png, icoWant[i].png))) bad.push(`favicon.ico is not the ${ICO.join(", ")} renders`);
  for (const l of bad) console.log("FAIL", l);
  console.log(bad.length ? `${bad.length} FAILED: run node scripts/render-icons.mjs` : `src/assets/brand: ${out.size} PNGs and favicon.ico match their SVGs`);
  process.exit(bad.length ? 1 : 0);
}
for (const [file, png] of out) writeFileSync(join(BRAND, file), png);
writeFileSync(join(BRAND, "favicon.ico"), ico);
console.log(`Rendered ${[...out.keys(), "favicon.ico"].join(", ")} in src/assets/brand.`);
