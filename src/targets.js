// @ts-check
// Creator color targets checked against the producer's ink library with color.js (reference ΔE implementations).
// No Pantone data: the Lab values come from the user. Pure, tested in check.mjs.
import { deltaE2000, deltaECMC, Lab } from "./vendor/color-fn.js";

// Values are passed in color.js's own Lab space, so no illuminant conversion happens: ΔE is computed on the numbers given.
const cj = l => ({ space: Lab, coords: /** @type {[number, number, number]} */ (l.slice(0, 3)), alpha: 1 });

/** Tolerance tiers in ΔE CMC(2:1), the textile convention (ISO 105-J03). */
export const TIERS = [{ value: 1, label: "Brand exact ≤ 1.0" }, { value: 2, label: "General ≤ 2.0" }, { value: 3.5, label: "Bulk ≤ 3.5" }];

/**
 * Closest shelf ink to a target, by ΔE CMC(2:1) with the target as reference.
 * @param {{ lab: number[], tier: number }} target
 * @param {{ name: string, lab: number[] }[]} library
 * @param {(ink: { name: string, lab: number[] }) => number[]} [labOf] calibrated Lab for an ink (default: its own Lab)
 */
export function matchTarget(target, library, labOf = i => i.lab) {
  let best = null, cmc = Infinity;
  for (const ink of library) { const d = deltaECMC(cj(target.lab), cj(labOf(ink))); if (d < cmc) { cmc = d; best = ink; } }
  const de00 = best ? deltaE2000(cj(target.lab), cj(labOf(best))) : NaN;
  return { ink: best, cmc, de00, pass: cmc <= target.tier };
}
