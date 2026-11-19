# How Separation Table separates

| Step | Method |
|---|---|
| Print model | Yule–Nielsen modified mixing in linear reflectance, n = 1.7 until calibrated |
| Palette, default | Subset of the producer's ink library chosen by greedy selection plus swaps to minimize reconstruction error |
| Palette, from art | Convex-hull vertices of the art's colors in mix space, thinned by farthest-point sampling and backward elimination (after Tan, Echevarria and Gingold 2018). No clustering or centroids. |
| Coverage | Per color, coverage on the simplex (inks + garment) by FISTA least squares with a locality penalty, solved on a 17³ grid and interpolated per pixel |
| Spot / index | Nearest ink in Lab with OpenCV open/close cleanup / vector Floyd–Steinberg in mix space |
| Underbase | Weighted by ink lightness, choked at film resolution |
| Overprint | One angle (default): concentric dots, a_k = v_k + max(later). Rotated: Demichel, a_k = v_k / (1 − Σ later v) |
| Halftone | Area-exact dot: round (default), or ellipse, square or line from the ISO 32000-1 Table 128 spot functions, rank-scaled to the tone; inverse dot gain or the fitted per-ink curve; min/max dot; under the min dot whole smallest dots scatter over the cells (none under 1.5 per 64 cells), over the max dot whole smallest holes |
| Fidelity | CIEDE2000 and ΔE CMC(2:1) between art and modeled print |

## Releases

The version lives in `src/version.js` and nowhere else by hand.
`node scripts/release.mjs check` (CI, every pull request) checks
package.json, the top CHANGELOG entry, `releases/<version>.md`
and the Status block agree. `node scripts/release.mjs draft`
drafts the next entry from merged pull request titles. [RELEASE.md](RELEASE.md)
has the steps.

## Pantone

No PANTONE® data. Requested colors are stored as typed, with
Lab from the creator's own licensed reference or a measured
standard, and matched only against your ink library.

## Third-party code, models and data

Libraries and models are downloaded by `npm run setup` at pinned
versions and are not committed. [NOTICE](../NOTICE) lists each one with its license
and source, the ink data, and the published methods the engine
implements. TIFF (1-bit PackBits), EPS (Level 2 imagemask), Photoshop
and DCS 2.0 writers are our own; DCS 2.0 follows Quark's Desktop Color
Separation Specification 2.0 with Adobe DSC 3.0 comments, and tests/check.mjs
reads it back (and renders it with Ghostscript where installed).
GPL/AGPL projects (Potrace, libimagequant, ArgyllCMS) and Mixbox
(non-commercial) are deliberately excluded.
