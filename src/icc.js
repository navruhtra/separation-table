// @ts-check
// Embedded ICC profiles: read them from PNG/JPEG/WebP and convert pixels to sRGB with Little CMS (lcms-wasm).
let lcmsP = null;
async function lcms() {
  if (!lcmsP) lcmsP = import("./vendor/lcms.js").then(async mod => {
    const L = await mod.instantiate({ locateFile: () => new URL("./vendor/lcms.wasm", import.meta.url).href });
    return { L, mod };
  });
  return lcmsP;
}
async function inflate(bytes) {
  const ds = new DecompressionStream("deflate");
  const out = await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer();
  return new Uint8Array(out);
}
export async function extractICC(buf) {
  const b = new Uint8Array(buf), dv = new DataView(buf);
  if (b[0] === 0x89 && b[1] === 0x50) { // PNG
    let p = 8;
    while (p + 8 < b.length) {
      const len = dv.getUint32(p), type = String.fromCharCode(...b.subarray(p + 4, p + 8));
      if (type === "iCCP") { const d = b.subarray(p + 8, p + 8 + len); let z = 0; while (d[z] !== 0) z++; return inflate(d.subarray(z + 2)); }
      if (type === "IDAT" || type === "IEND") break;
      p += 12 + len;
    }
    return null;
  }
  if (b[0] === 0xff && b[1] === 0xd8) { // JPEG APP2 ICC_PROFILE, possibly split across segments
    let p = 2; const parts = [];
    while (p + 4 < b.length && b[p] === 0xff) {
      const mk = b[p + 1], len = dv.getUint16(p + 2);
      if (mk === 0xe2 && String.fromCharCode(...b.subarray(p + 4, p + 15)) === "ICC_PROFILE") parts.push({ seq: b[p + 16], data: b.subarray(p + 18, p + 2 + len) });
      if (mk === 0xda) break;
      p += 2 + len;
    }
    if (!parts.length) return null;
    parts.sort((a, c) => a.seq - c.seq); const tot = parts.reduce((s, q) => s + q.data.length, 0), out = new Uint8Array(tot); let o = 0;
    for (const q of parts) { out.set(q.data, o); o += q.data.length; } return out;
  }
  if (String.fromCharCode(...b.subarray(0, 4)) === "RIFF" && String.fromCharCode(...b.subarray(8, 12)) === "WEBP") {
    let p = 12;
    while (p + 8 < b.length) { const type = String.fromCharCode(...b.subarray(p, p + 4)), len = dv.getUint32(p + 4, true); if (type === "ICCP") return b.slice(p + 8, p + 8 + len); p += 8 + len + (len & 1); }
  }
  return null;
}
/* Convert RGBA pixels (already decoded with colorSpaceConversion:"none") from the embedded profile to sRGB in place. */
export async function convertToSRGB(rgba, icc, intent = "relative") {
  const { L, mod } = await lcms();
  const src = L.cmsOpenProfileFromMem(icc, icc.length);
  if (!src) throw new Error("The embedded color profile could not be read.");
  const name = L.cmsGetProfileInfoASCII(src, mod.cmsInfoDescription, "en", "US") || "Embedded profile";
  const space = L.cmsGetColorSpaceASCII(src);
  if (!/RGB/i.test(space)) { L.cmsCloseProfile(src); return { name, space, converted: false, reason: `${space.trim()} profiles are not converted; the browser's own conversion is used.` }; }
  const dst = L.cmsCreate_sRGBProfile();
  const fmt = mod.TYPE_RGB_8, flags = mod.cmsFLAGS_BLACKPOINTCOMPENSATION;
  const tr = L.cmsCreateTransform(src, fmt, dst, fmt, intent === "perceptual" ? mod.INTENT_PERCEPTUAL : mod.INTENT_RELATIVE_COLORIMETRIC, flags);
  L.cmsCloseProfile(src); L.cmsCloseProfile(dst);
  if (!tr) throw new Error("No color transform could be built for this profile.");
  const P = rgba.length / 4, rgb = new Uint8Array(P * 3);
  for (let i = 0; i < P; i++) { rgb[i * 3] = rgba[i * 4]; rgb[i * 3 + 1] = rgba[i * 4 + 1]; rgb[i * 3 + 2] = rgba[i * 4 + 2]; }
  const out = L.cmsDoTransform(tr, rgb, P); L.cmsDeleteTransform(tr);
  for (let i = 0; i < P; i++) { rgba[i * 4] = out[i * 3]; rgba[i * 4 + 1] = out[i * 3 + 1]; rgba[i * 4 + 2] = out[i * 3 + 2]; }
  return { name, space, converted: true };
}
