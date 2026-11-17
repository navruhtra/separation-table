// @ts-check
// Art prep models, run in the browser with ONNX Runtime Web (CPU/WASM). Nothing is uploaded.
//   Background removal: U²-Netp (rembg release, Apache-2.0)
//   2× upscale:        Swin2SR lightweight x2 (Xenova ONNX export of mv-lab Swin2SR)
//   Click to select:   SlimSAM-77 (Xenova ONNX export, Apache-2.0)
let ortP = null;
async function ort() {
  if (!ortP) ortP = import("./vendor/ort.wasm.min.mjs").then(o => {
    o.env.wasm.wasmPaths = new URL("./vendor/", import.meta.url).href;
    o.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
    return o;
  });
  return ortP;
}
const sessions = {};
async function session(name) {
  if (!sessions[name]) sessions[name] = (async () => {
    const o = await ort(), url = new URL(`./models/${name}.onnx`, import.meta.url).href;
    const r = await fetch(url).catch(() => null);
    if (!r || !r.ok) throw new Error("the AI models are not included in this hosted copy. Run the tool from its source (npm run setup, npm start) to use them");
    return o.InferenceSession.create(new Uint8Array(await r.arrayBuffer()), { executionProviders: ["wasm"] });
  })();
  sessions[name].catch(() => { delete sessions[name]; });
  return sessions[name];
}
const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];
function toCanvas(w, h) { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; }

/* Background removal → alpha Uint8Array(W*H) */
export async function removeBackground(rgba, W, H) {
  const o = await ort(), s = await session("u2netp"), S = 320;
  const src = toCanvas(W, H); src.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(rgba), W, H), 0, 0);
  const c = toCanvas(S, S), g = c.getContext("2d"); g.drawImage(src, 0, 0, S, S);
  const d = g.getImageData(0, 0, S, S).data; let mx = 0; for (let i = 0; i < d.length; i += 4) mx = Math.max(mx, d[i], d[i + 1], d[i + 2]); mx = mx || 255;
  const x = new Float32Array(3 * S * S);
  for (let i = 0; i < S * S; i++) for (let ch = 0; ch < 3; ch++) x[ch * S * S + i] = (d[i * 4 + ch] / mx - MEAN[ch]) / STD[ch];
  const out = await s.run({ [s.inputNames[0]]: new o.Tensor("float32", x, [1, 3, S, S]) });
  const m = out[s.outputNames[0]].data; let lo = Infinity, hi = -Infinity; for (const v of m) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const mc = toCanvas(S, S), mg = mc.getContext("2d"), md = mg.createImageData(S, S);
  for (let i = 0; i < S * S; i++) { const v = Math.round(255 * (m[i] - lo) / Math.max(1e-6, hi - lo)); md.data[i * 4] = md.data[i * 4 + 1] = md.data[i * 4 + 2] = v; md.data[i * 4 + 3] = 255; }
  mg.putImageData(md, 0, 0);
  const big = toCanvas(W, H), bg = big.getContext("2d"); bg.imageSmoothingQuality = "high"; bg.drawImage(mc, 0, 0, W, H);
  const bd = bg.getImageData(0, 0, W, H).data, alpha = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) { const v = bd[i * 4]; alpha[i] = v > 200 ? 255 : v < 40 ? 0 : Math.round((v - 40) * 255 / 160); }
  return alpha;
}

/* 2× super-resolution, tiled. The caller caps input at 640 px on the long side to keep CPU time reasonable. */
export async function upscale2x(rgba, W, H, onProgress) {
  const o = await ort(), s = await session("sr_x2"), T = 96, PAD = 8;
  const out = new Uint8ClampedArray(W * 2 * H * 2 * 4);
  const tiles = []; for (let y = 0; y < H; y += T) for (let x = 0; x < W; x += T) tiles.push([x, y]);
  let done = 0;
  for (const [tx, ty] of tiles) {
    const x0 = Math.max(0, tx - PAD), y0 = Math.max(0, ty - PAD), x1 = Math.min(W, tx + T + PAD), y1 = Math.min(H, ty + T + PAD);
    let w = x1 - x0, h = y1 - y0; const pw = Math.ceil(w / 8) * 8, ph = Math.ceil(h / 8) * 8;
    const x = new Float32Array(3 * pw * ph);
    for (let yy = 0; yy < ph; yy++) for (let xx = 0; xx < pw; xx++) {
      const sx = x0 + Math.min(xx, w - 1), sy = y0 + Math.min(yy, h - 1), p = (sy * W + sx) * 4;
      for (let ch = 0; ch < 3; ch++) x[ch * pw * ph + yy * pw + xx] = rgba[p + ch] / 255;
    }
    const r = await s.run({ pixel_values: new o.Tensor("float32", x, [1, 3, ph, pw]) });
    const y = r.reconstruction.data, oh = ph * 2, ow = pw * 2;
    for (let yy = (ty - y0) * 2; yy < (Math.min(H, ty + T) - y0) * 2; yy++) for (let xx = (tx - x0) * 2; xx < (Math.min(W, tx + T) - x0) * 2; xx++) {
      const dx = x0 * 2 + xx, dy = y0 * 2 + yy, q = (dy * W * 2 + dx) * 4;
      for (let ch = 0; ch < 3; ch++) out[q + ch] = Math.round(255 * Math.min(1, Math.max(0, y[ch * oh * ow + yy * ow + xx])));
      out[q + 3] = rgba[(((dy >> 1) * W) + (dx >> 1)) * 4 + 3];
    }
    onProgress && onProgress(++done / tiles.length);
  }
  return { rgba: out, W: W * 2, H: H * 2 };
}

/* Click-to-select. encode() once per image, then segment() per set of clicks → mask Uint8Array(W*H) */
let emb = null;
export async function samEncode(rgba, W, H) {
  const o = await ort(), s = await session("sam_encoder"), S = 1024, sc = S / Math.max(W, H);
  const rw = Math.round(W * sc), rh = Math.round(H * sc);
  const src = toCanvas(W, H); src.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(rgba), W, H), 0, 0);
  const c = toCanvas(rw, rh), g = c.getContext("2d"); g.drawImage(src, 0, 0, rw, rh); const d = g.getImageData(0, 0, rw, rh).data;
  const x = new Float32Array(3 * S * S);
  for (let yy = 0; yy < rh; yy++) for (let xx = 0; xx < rw; xx++) { const p = (yy * rw + xx) * 4; for (let ch = 0; ch < 3; ch++) x[ch * S * S + yy * S + xx] = (d[p + ch] / 255 - MEAN[ch]) / STD[ch]; }
  const r = await s.run({ pixel_values: new o.Tensor("float32", x, [1, 3, S, S]) });
  emb = { e: r.image_embeddings, pe: r.image_positional_embeddings, sc, rw, rh, W, H };
}
export async function samSegment(points) {
  if (!emb) throw new Error("Encode the image first.");
  const o = await ort(), s = await session("sam_decoder");
  const pts = new Float32Array(points.length * 2), lab = new BigInt64Array(points.length);
  points.forEach((p, i) => { pts[i * 2] = p.x * emb.sc; pts[i * 2 + 1] = p.y * emb.sc; lab[i] = BigInt(p.label); });
  const r = await s.run({ input_points: new o.Tensor("float32", pts, [1, 1, points.length, 2]), input_labels: new o.Tensor("int64", lab, [1, 1, points.length]), image_embeddings: emb.e, image_positional_embeddings: emb.pe });
  const iou = r.iou_scores.data; let bi = 0; for (let i = 1; i < iou.length; i++) if (iou[i] > iou[bi]) bi = i;
  const m = r.pred_masks.data, MS = 256, off = bi * MS * MS;
  // low-res logits live in the padded 1024² frame; upsample bilinearly to the image
  const mask = new Uint8Array(emb.W * emb.H), f = MS / 1024;
  for (let y = 0; y < emb.H; y++) for (let x = 0; x < emb.W; x++) {
    const u = Math.min(MS - 1.001, Math.max(0, x * emb.sc * f - 0.5)), v = Math.min(MS - 1.001, Math.max(0, y * emb.sc * f - 0.5)), x0 = u | 0, y0 = v | 0, fx = u - x0, fy = v - y0;
    const at = (a, b) => m[off + b * MS + a];
    const val = at(x0, y0) * (1 - fx) * (1 - fy) + at(x0 + 1, y0) * fx * (1 - fy) + at(x0, y0 + 1) * (1 - fx) * fy + at(x0 + 1, y0 + 1) * fx * fy;
    mask[y * emb.W + x] = val > 0 ? 1 : 0;
  }
  return mask;
}
export function samReset() { emb = null; }
