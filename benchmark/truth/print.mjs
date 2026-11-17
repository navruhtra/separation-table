// Benchmark, vector truth: separate the 900 px input (drawn from a vector original, truth/make.py), render every film at
// 400 dpi with the engine's own film renderer, and lay the films on a black shirt: the print as it comes off the press,
// dots at their printed size. score.py compares it with the original. usage: node print.mjs <engine dir> <out.rgb>
// Fixed inks (the test is the films, not the ink choice), the app's film defaults; dot gain 0 because the print is not
// given press gain (films with gain compensation would print light here).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const [ED, OUT] = process.argv.slice(2), T = join(dirname(fileURLToPath(import.meta.url)), "../../.cache/benchmark/truth");
const E = await import(`${ED}/engine.js`), Pp = await import(`${ED}/pipeline.js`), { genericLibrary } = await import(`${ED}/inks.js`);
const W = 900, H = 600, P = W * H, raw = readFileSync(`${T}/input.rgba`), px = new Uint8ClampedArray(P * 3), alpha = new Uint8Array(P);
for (let j = 0; j < P; j++) { px[j * 3] = raw[j * 4]; px[j * 3 + 1] = raw[j * 4 + 1]; px[j * 3 + 2] = raw[j * 4 + 2]; alpha[j] = raw[j * 4 + 3]; }
const library = genericLibrary(), film = { minDot: 0.06, maxDot: 0.92, scatter: true, lpi: 45, widthIn: 11 }, STACK = 2.4, DPI = 400;
const inks = ["Purple", "Royal", "Teal", "Scarlet", "Pink", "Golden Yellow", "Flesh", "White"].map(nm => ({ ...library.find(x => x.name === nm), locked: true }));
const t0 = performance.now();
const r = Pp.runSeparation({ px, alpha, lab: Pp.labOf(px, P), W, H, mode: "sim", garmentLab: E.rgb2lab(17, 17, 17), n: 1.7, smooth: 0.1, rareFrac: 0.0005, underbase: true, ubStrength: 1,
  library, forceWhite: "auto", screening: "am", overprint: "same", rho: 0.6, rhos: [0, 0.5, 1], film, driftMm: 0.2, trapMm: 0.4, solidDetail: true, stackLimit: STACK, inks, repick: false });
const ms = performance.now() - t0, N = r.inks.length;
const printed = Pp.printedFrom(r.cov, N, P, "sim", "am", "same", 0.6, r.ub, STACK), Wp = 4400, Hp = Math.round(H * Wp / W);
const full = r.inks.map(k => E.lab2rgb(k.lab)), white = E.lab2rgb([96, 0, 1.5]), img = new Uint8ClampedArray(Wp * Hp * 3);
for (let q = 0; q < Wp * Hp; q++) img.set([17, 17, 17], q * 3);
const choke = Math.round(0.2 / 25.4 * DPI); // the app's 0.2 mm underbase choke
[{ ub: true, idx: -1 }, ...r.inks.map((k, i) => ({ idx: i }))].forEach(pl => {
  const bits = E.renderPlate({ plate: pl, printed, ub: r.ub, W, H, N, Wp, Hp, dpi: DPI, lpi: film.lpi, angle: 22.5, screening: "am", mode: "sim", dot: { gain: 0, minDot: film.minDot, maxDot: film.maxDot, scatter: true }, choke, solid: r.solid || null });
  const col = pl.ub ? white : full[pl.idx]; for (let q = 0; q < Wp * Hp; q++) if (bits[q]) img.set(col, q * 3); });
writeFileSync(OUT, img); console.error(`truth print: ${r.inks.map(k => k.name).join("/")}, separation ${Math.round(ms)} ms`);
writeFileSync(OUT + ".json", JSON.stringify({ ms: Math.round(ms) }));
