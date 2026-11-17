// @ts-check
// Platen, film and screen sizes: the three things a print must fit. Standard sizes plus a custom size for each, set
// once in Shop setup. Pure (no DOM). A shop profile keeps them as `sizes` (cleanSizes checks a profile's copy).

/** @typedef {"platen" | "film" | "screen"} SizeKind */
/** @typedef {{ id: string, name: string, w: number, h: number }} SizePreset  inches; w across the shirt, h along it */
/** @typedef {{ id: string, w?: number, h?: number }} SizeChoice  a preset id, or "custom" with w and h */
/** @typedef {Record<SizeKind, SizeChoice>} SizeSetting */
/** @typedef {Record<SizeKind, SizePreset>} Sizes */

/* Platens: screenprinting.com aluminum platen line (youth 14 × 16, standard 16 × 18, standard 16 × 22, large 18 × 20,
   leg and sleeve 4 × 22). Film: common inkjet film sheets. Screens: the image area a frame can print, which is
   smaller than the frame: the squeegee runs 1 in past the art on each side and needs room at the frame. 20 × 24 is the
   most-used frame (screenprinting.com); 23 × 31 is the usual automatic-press frame. The image areas are typical values,
   not a maker's specification: a shop with other frames sets a custom size. */
/** @type {Record<SizeKind, SizePreset[]>} */
export const SIZE_PRESETS = {
  platen: [
    { id: "youth", name: "Youth 14 × 16 in", w: 14, h: 16 },
    { id: "standard", name: "Standard 16 × 18 in", w: 16, h: 18 },
    { id: "standard-long", name: "Standard long 16 × 22 in", w: 16, h: 22 },
    { id: "large", name: "Large 18 × 20 in", w: 18, h: 20 },
    { id: "sleeve", name: "Sleeve and leg 4 × 22 in", w: 4, h: 22 },
  ],
  film: [
    { id: "letter", name: "Letter 8.5 × 11 in", w: 8.5, h: 11 },
    { id: "tabloid", name: "Tabloid 11 × 17 in", w: 11, h: 17 },
    { id: "super-b", name: "Super B 13 × 19 in", w: 13, h: 19 },
    { id: "c-size", name: "17 × 22 in", w: 17, h: 22 },
  ],
  screen: [
    { id: "20x24", name: "20 × 24 in frame (prints 14 × 16 in)", w: 14, h: 16 },
    { id: "23x31", name: "23 × 31 in frame (prints 16 × 20 in)", w: 16, h: 20 },
  ],
};
export const SIZE_KINDS = /** @type {SizeKind[]} */ (["platen", "film", "screen"]);
export const SIZE_NAME = { platen: "platen", film: "film sheet", screen: "screen image area" };
/** @type {SizeSetting} */
export const DEFAULT_SIZES = { platen: { id: "standard" }, film: { id: "super-b" }, screen: { id: "20x24" } };
/** Custom sizes, inches. */
export const SIZE_MIN = 1, SIZE_MAX = 40;
/** Each film has this margin on every side for its registration marks and test strip (output.composeFilm). */
export const FILM_MARGIN_IN = 0.5;

/** A checked size setting with every size resolved, or an Error that says in plain words what is wrong.
 *  A missing kind takes the default. @returns {Sizes} */
export function cleanSizes(s) {
  if (s != null && typeof s !== "object") throw new Error("Sizes is not an object.");
  /** @type {any} */ const out = {};
  for (const k of SIZE_KINDS) {
    const c = (s && s[k]) || DEFAULT_SIZES[k];
    if (c.id === "custom") { const w = Number(c.w), h = Number(c.h);
      for (const d of ["width", "height"]) { const v = d === "width" ? w : h;
        if (!Number.isFinite(v) || v < SIZE_MIN || v > SIZE_MAX) throw new Error(`Custom ${SIZE_NAME[k]}: ${d} must be a number from ${SIZE_MIN} to ${SIZE_MAX} in.`); }
      out[k] = { id: "custom", name: `Custom ${w} × ${h} in`, w, h }; continue; }
    const p = SIZE_PRESETS[k].find(q => q.id === c.id); if (!p) throw new Error(`${SIZE_NAME[k][0].toUpperCase() + SIZE_NAME[k].slice(1)} "${c.id}" is not a standard size. Use one of ${SIZE_PRESETS[k].map(q => q.id).join(", ")} or custom.`);
    out[k] = { ...p };
  }
  return out;
}
/** The setting to store for resolved sizes (preset ids, or custom with w and h). @returns {SizeSetting} */
export function sizeSetting(sizes) { const o = /** @type {any} */ ({}); for (const k of SIZE_KINDS) { const z = sizes[k]; o[k] = z.id === "custom" ? { id: "custom", w: z.w, h: z.h } : { id: z.id }; } return o; }
