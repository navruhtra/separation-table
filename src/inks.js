// @ts-check
// Ink library: generic stock shades until the producer imports measured drawdowns.
import { rgb2lab, hex2rgb, mixFromLab, mixToLab } from "./engine.js";

// Approximate sRGB of common plastisol shades. Generic and unmeasured: replace with your own drawdowns.
const GENERIC = [["White", "#f4f4f0"], ["Lemon Yellow", "#f6e01a"], ["Golden Yellow", "#f7b500"], ["Orange", "#f26b1d"], ["Scarlet", "#d8262f"], ["Red", "#b81d2c"],
  ["Maroon", "#6d1a2b"], ["Pink", "#ef6fa6"], ["Magenta", "#c5157a"], ["Purple", "#5a2a82"], ["Royal", "#1f3f9c"], ["Navy", "#1b2547"], ["Light Blue", "#6fb2e3"],
  ["Turquoise", "#00a3b4"], ["Kelly Green", "#00924a"], ["Forest", "#24452e"], ["Lime", "#9ccb3b"], ["Brown", "#5b3a22"], ["Tan", "#c8a77c"], ["Grey", "#8b8d8e"],
  ["Black", "#151515"], ["Flesh", "#e8b896"], ["Teal", "#0f6d6a"], ["Violet", "#7b4fa0"]];
export const genericLibrary = () => GENERIC.map(([name, hex]) => ({ name, lab: rgb2lab(...hex2rgb(hex)), source: "generic", system: "", code: "" }));

/* The de facto simulated-process kit: the default channel set Separation Studio NXT ships (base white, red, blue, gold,
   purple, green, turquoise, gray, top white), which shops fill from their stock plastisol line. No ink maker publishes
   Lab values for stock inks (2026 research), so these are ADN's own approximations of typical cured plastisol on
   white base: generic names, not any vendor's data. Measure your own drawdowns to replace them. */
const SIM_KIT = [["Sim White", "#f4f4f0"], ["Sim Red", "#d02a30"], ["Sim Gold", "#f4ae00"], ["Sim Blue", "#1f43a3"], ["Sim Turquoise", "#0aa1b5"],
  ["Sim Green", "#0a8f45"], ["Sim Purple", "#5b2c86"], ["Sim Gray", "#8a8c8d"]];
const SKIN_ADDONS = [["Sim Flesh", "#e6b392"], ["Sim Tan", "#c4a074"], ["Sim Brown", "#5c3a24"]];
const lib = (rows, source) => rows.map(([name, hex]) => ({ name, lab: rgb2lab(...hex2rgb(hex)), source, system: "", code: "" }));
/* Brand catalogs: product names and codes as the makers list them (facts), with colors that are ADN's own estimates,
   not the makers' data. Wilflex: ADN's visual estimates (Wilflex publishes no color values). FN-INK: each product is
   ADN's generic shade of the same color name (GENERIC above), or an equal mix of two of them computed in the print
   model's mixing space; no FN-INK published values are used. Every one is an estimate, replaced by press-run readings
   (measure drawdowns, import name,L,a,b). Product names are trademarks of their owners; ADN is not affiliated with
   Avient, Wilflex or FN-INK. */
const WILFLEX_RIO = [["White", "", "#f5f5f1"], ["Lemon Yellow", "80550", "#f7e31c"], ["Yellow", "80108", "#fdd400"], ["Light Gold", "80100", "#fbbd1a"], ["Gold", "80000", "#f6a800"],
  ["Dolphin Orange", "30400", "#f26a21"], ["Bright Orange", "30200", "#f5821f"], ["Scarlet", "40000", "#d71f33"], ["National Red", "43000", "#c8102e"], ["Drake Red", "42270", "#b5122f"],
  ["Dallas Scarlet", "42000", "#c4122f"], ["Maroon", "45400", "#6a1e2c"], ["Brandywine", "47600", "#7a2434"], ["Russell Purple", "50400", "#4f2683"], ["Aqua", "75300", "#00a3ad"],
  ["Contact Blue", "60650", "#2f8fd8"], ["Light Royal", "62100", "#1f5bb5"], ["Royal", "67050", "#1d3f95"], ["Bears Navy", "66100", "#1e2a45"], ["Navy", "60000", "#1b2540"],
  ["Black Diamond", "19000", "#141414"], ["Kelly Green", "70550", "#00873e"], ["Dark Green", "74550", "#1f4b33"], ["Russell Gray", "13300", "#8d8f91"], ["Dark Gray", "14600", "#55585b"],
  ["Tan", "12600", "#c9a77c"], ["Electric Yellow", "90010", "#f2f20a"], ["Electric Orange", "90310", "#ff7a1a"], ["Electric Red", "90610", "#ff3b4a"], ["Electric Pink", "90410", "#ff4fa3"],
  ["Electric Purple", "90810", "#9b4dff"], ["Electric Blue", "90110", "#1f9dff"], ["Electric Green", "90210", "#5cf23a"]];
// FN-INK product name -> ADN generic shade(s) it is estimated from.
const FN_INK = [["White", "White"], ["Lemon Yellow", "Lemon Yellow"], ["Golden Yellow", "Golden Yellow"], ["Orange", "Orange"], ["Bright Red", "Scarlet"],
  ["Ruby Red", "Red", "Maroon"], ["Fuchsia", "Pink", "Magenta"], ["Magenta", "Magenta"], ["Violet", "Violet"], ["Royal Blue", "Royal"],
  ["Light Royal Blue", "Royal", "Light Blue"], ["Light Blue", "Light Blue"], ["Navy Blue", "Navy"], ["Kelly Green", "Kelly Green"], ["Black", "Black"]];
const MIX_N = 1.7; // the print model's Yule-Nielsen n before calibration (app.js ymodel)
const genericLab = name => { const g = GENERIC.find(r => r[0] === name); if (!g) throw new Error(`no generic shade ${name}`); return rgb2lab(...hex2rgb(g[1])); };
/** ADN estimate of a named ink from one generic shade, or an equal mix of two in mixing space. */
export function estimateFromGeneric(names) {
  if (names.length === 1) return genericLab(names[0]);
  const ms = names.map(n => mixFromLab(genericLab(n), MIX_N));
  return mixToLab([0, 1, 2].map(c => ms.reduce((t, m) => t + m[c], 0) / ms.length), MIX_N);
}
const brand = (rows, system, source) => rows.map(r => ({ name: r[0], lab: rgb2lab(...hex2rgb(r.length === 3 ? r[2] : r[1])), source, system, code: r.length === 3 ? r[1] : "", approx: true }));
const estimated = (rows, system, source) => rows.map(([name, ...from]) => ({ name, lab: estimateFromGeneric(from), source, system, code: "", approx: true }));
export const PRESETS = {
  wilflexRio: { label: "Wilflex Epic Rio ready-for-use (33, approximate colors)", inks: () => brand(WILFLEX_RIO, "Wilflex Epic Rio", "catalog") },
  fnInk: { label: "FN-INK stock colors (15, ADN estimates)", inks: () => estimated(FN_INK, "FN-INK", "catalog") },
  simkit: { label: "Standard sim-process kit (8 inks)", inks: () => lib(SIM_KIT, "kit") },
  simkitSkin: { label: "Sim-process kit + skin tones (11 inks)", inks: () => lib(SIM_KIT.concat(SKIN_ADDONS), "kit") },
  generic: { label: "Generic stock shades (24 inks)", inks: genericLibrary },
};

/* CSV: name,L,a,b[,system,code]  or  name,#hex[,system,code]. Header row optional. */
/** What the ink library holds, for its pill: "estimate" when any ink is an ADN estimate of a maker's color (the brand
    catalogs, approx), else "measured" when any ink was read from a drawdown (a CSV import: source "measured" or
    "measured-hex"), else "generic". The kits are hand-set shades, not readings, so they count as generic. */
export function libraryKind(lib) {
  const estimate = lib.filter(i => i.approx).length, measured = lib.filter(i => /^measured/.test(i.source || "") && !i.approx).length;
  return { kind: estimate ? "estimate" : measured ? "measured" : "generic", estimate, measured };
}
export function parseInkCSV(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim(); if (!t || t.startsWith("#")) continue;
    const c = t.split(/[,;\t]/).map(s => s.trim());
    if (/^#?[0-9a-f]{6}$/i.test(c[1] || "")) { const h = c[1].startsWith("#") ? c[1] : "#" + c[1]; out.push({ name: c[0], lab: rgb2lab(...hex2rgb(h)), source: "measured-hex", system: c[2] || "", code: c[3] || "" }); continue; }
    if (c.length >= 4 && !isNaN(+c[1]) && !isNaN(+c[2]) && !isNaN(+c[3])) { out.push({ name: c[0], lab: [+c[1], +c[2], +c[3]], source: "measured", system: c[4] || "", code: c[5] || "" }); continue; }
    if (out.length === 0 && isNaN(+c[1])) continue; // header
    throw new Error(`Could not read "${t}". Use name,L,a,b or name,#hex.`);
  }
  if (!out.length) throw new Error("No inks found in that file.");
  return out;
}
export function inksToCSV(lib) { return "name,L,a,b,system,code\n" + lib.map(i => [i.name, ...i.lab.map(v => v.toFixed(2)), i.system || "", i.code || ""].join(",")).join("\n"); }
