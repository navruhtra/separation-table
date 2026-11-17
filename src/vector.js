// @ts-check
// VTracer (MIT): turn spot plates into vector paths for sharp, resolution-free films.
let vtP = null, wasmBytes = null;
/** Node (the sep CLI) has no fetch for file URLs: it hands over the wasm file's bytes before the first trace. */
export function useWasmBytes(bytes) { wasmBytes = bytes; }
async function vt() {
  if (!vtP) vtP = import("./vendor/vtracer.js").then(async m => { await m.default({ module_or_path: wasmBytes || new URL("./vendor/vtracer.wasm", import.meta.url) }); return m; });
  return vtP;
}
const CFG = { binary: true, mode: "spline", hierarchical: "stacked", cornerThreshold: 60, lengthThreshold: 4, maxIterations: 10, spliceThreshold: 45, filterSpeckle: 4, colorPrecision: 6, layerDifference: 16, pathPrecision: 2 };
/* mask: Uint8Array(W*H) 1 = ink. Returns the inner <path …/> markup of the traced plate. */
export async function traceMask(mask, W, H) {
  const m = await vt(), px = new Uint8Array(W * H * 4);
  for (let p = 0; p < W * H; p++) { const v = mask[p] ? 0 : 255; px[p * 4] = px[p * 4 + 1] = px[p * 4 + 2] = v; px[p * 4 + 3] = 255; }
  const svg = m.to_svg(px, W, H, CFG);
  return (svg.match(/<path[^>]*\/>/g) || []).join("\n");
}
export function wrapSVG(paths, W, H, widthIn, fill = "#000") {
  const hIn = widthIn * H / W;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${widthIn}in" height="${hIn.toFixed(4)}in" viewBox="0 0 ${W} ${H}">\n<g fill="${fill}">\n${paths.replace(/fill="#000000"/g, "")}\n</g>\n</svg>\n`;
}
