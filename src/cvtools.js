// @ts-check
// OpenCV.js (Apache-2.0): edge-preserving noise removal for art, morphological cleanup for spot plates.
let cvP = null;
export function loadCV() {
  if (!cvP) cvP = new Promise((res, rej) => {
    const s = document.createElement("script"); s.src = new URL("./vendor/opencv.js", import.meta.url).href; s.async = true;
    const timer = setTimeout(() => rej(new Error("OpenCV took too long to start.")), 60000);
    // The Emscripten module is a thenable that resolves to itself; strip .then before resolving or the promise never settles.
    const finish = m => { clearTimeout(timer); if (m && typeof m.then === "function") { try { delete m.then; } catch { m.then = undefined; } } self.cv = m; res(m); };
    s.onload = () => {
      const c = self.cv;
      if (!c) { clearTimeout(timer); return rej(new Error("OpenCV did not load.")); }
      if (c instanceof Promise) c.then(finish);
      else if (c.Mat && c.getBuildInformation) finish(c);
      else if (typeof c.then === "function") c.then(finish);
      else c.onRuntimeInitialized = () => finish(c);
    };
    s.onerror = () => rej(new Error("OpenCV could not be loaded here."));
    document.head.appendChild(s);
  });
  return cvP;
}
/* Bilateral filter: flattens JPEG noise and halftone screens in scanned art without softening edges. */
export async function denoise(rgba, W, H, strength = 1) {
  const cv = await loadCV();
  const src = cv.matFromImageData(new ImageData(new Uint8ClampedArray(rgba), W, H)), rgb = new cv.Mat(), out = new cv.Mat();
  cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
  const d = Math.round(5 + 4 * strength); cv.bilateralFilter(rgb, out, d, 30 + 40 * strength, 5 + 5 * strength, cv.BORDER_DEFAULT);
  const res = new Uint8ClampedArray(rgba);
  for (let i = 0, j = 0; i < W * H; i++, j += 3) { res[i * 4] = out.data[j]; res[i * 4 + 1] = out.data[j + 1]; res[i * 4 + 2] = out.data[j + 2]; }
  src.delete(); rgb.delete(); out.delete();
  return res;
}
/* Spot plates: remove specks and fill pinholes by SIZE, not by shape. A connected patch of one label (an ink, or the bare
   garment = label N) smaller than `area` pixels is given to the label that surrounds it most. Unlike a morphological
   open/close, this never erodes a thin line or fine type: a 1 px rule is one long component, so it stays. (The old
   3×3 open deleted every stroke under 3 px: on the fine-detail test 39% of thin-feature pixels came out wrong.)
   Pure JS, 4-connected like the reference test; radius keeps the old call shape: area = 8·radius². */
export async function cleanSpot(idx, N, W, H, radius = 1) { return cleanSpotSync(idx, N, W, H, 8 * radius * radius); }
/** @param {Uint8Array} idx @param {number} N @param {number} W @param {number} H @param {number} area */
export function cleanSpotSync(idx, N, W, H, area = 8) {
  const P = W * H, out = new Uint8Array(idx), comp = new Int32Array(P).fill(-1), stack = new Int32Array(P), cnt = new Int32Array(N + 1);
  const small = [];
  for (let s = 0, c = 0; s < P; s++) {
    if (comp[s] >= 0) continue;
    const v = idx[s]; let top = 0, n = 0; stack[top++] = s; comp[s] = c; const px = [];
    while (top) {
      const p = stack[--top]; n++; if (n <= area) px.push(p);
      const x = p % W;
      if (x > 0 && comp[p - 1] < 0 && idx[p - 1] === v) { comp[p - 1] = c; stack[top++] = p - 1; }
      if (x < W - 1 && comp[p + 1] < 0 && idx[p + 1] === v) { comp[p + 1] = c; stack[top++] = p + 1; }
      if (p >= W && comp[p - W] < 0 && idx[p - W] === v) { comp[p - W] = c; stack[top++] = p - W; }
      if (p < P - W && comp[p + W] < 0 && idx[p + W] === v) { comp[p + W] = c; stack[top++] = p + W; }
    }
    if (n <= area) small.push({ c, px });
    c++;
  }
  for (const { c, px } of small) {
    cnt.fill(0); let any = false;
    for (const p of px) {
      const x = p % W;
      for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, p - W, p + W]) if (q >= 0 && q < P && comp[q] !== c) { cnt[out[q]]++; any = true; }
    }
    if (!any) continue; // the whole image is this one patch
    let best = 0; for (let i = 1; i <= N; i++) if (cnt[i] > cnt[best]) best = i;
    for (const p of px) out[p] = best;
  }
  return out;
}
