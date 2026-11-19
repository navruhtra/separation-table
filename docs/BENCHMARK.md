# Separation Table benchmark

The standing record of how the separation engine performs. A change to the engine is measured once and compared with
the numbers stored here.

- **Run it** on every change to the engine (`src/engine.js`, `src/pipeline.js`, `src/plan.js`, `src/inks.js`) before the pull request,
  and paste its table into the pull request.
- **Record a new baseline** after an engine change is merged.
- **Never invent or estimate a number:** every number below came out of `benchmark/run.mjs`.

This is the part of the benchmark that runs on images in this repository. The project's earlier benchmark also ran on
photographs and on other vendors' sample art. Those images are not ours to publish, so those yardsticks and their
numbers are not here.

## Run it

```bash
npm run benchmark                    # this checkout's engine vs the baseline
npm run benchmark -- --only truth    # one yardstick: truth, bench
```

- **Machine:** run it with nothing else on the machine, or the times mean nothing.
- **Output:** a table of every measure (baseline, now, change, verdict).
- **Exit code:** 0 when nothing is worse beyond its tolerance, 2 when something is.
- **Saved results:** each run is written to `.cache/benchmark/results/<label>.json`.

**Needs:**
- Node 22.
- Python 3 with numpy, scipy and Pillow.
- `src/vendor/` (`npm run setup`).

## What it measures

Lower is better on every number. Colour differences are CIELAB / ΔE00 (about 1 is just noticeable).

| Yardstick | What it is | What it catches |
|---|---|---|
| **Vector truth** (`benchmark/truth/`) | A design drawn from vector shapes at film size (`truth/make.py`): type, hairlines, rings, a soft glow on a fade. Shrunk to 900 px as the input, separated with fixed inks, every film rendered at 400 dpi and laid on a black shirt, then compared with the drawing at a close look and at arm's length. | The films themselves: edges, line weight, solid areas, soft gradients, stray dots. |
| **Bench** (`tests/bench-test.mjs`) | The regression set: 18 synthetic images and 12 museum photographs × library and art inks, fixed ink counts, print order picked as in the app. | Graphic art, line work, gradients, neutrals. The same cases as `npm run gate`. |

**Measures:**
- **Truth edges, solid, glow:** distance to the vector original inside each region. **Edge pixels off by >10** is the
  share of edge pixels clearly wrong. **Offset** is how far light shapes' edges moved (1.6 px = 0.1 mm). **Specks** are
  stray light dots outside the shapes.
- **Bench:**
  - robust and robust P95 are on-press error: the print scored across dot overlap 0, 0.5 and 1;
  - adnMean is colour: the planned colours in register;
  - neutral is greys;
  - filtered is colour as the eye blends it;
  - thin is fine detail lost;
  - steps are visible steps in fades.
- **Times** are warnings only. Bench time is the separations only.

The bench scores with the engine's own `evaluate`, as `npm run gate` does.

## Tolerances

The engine is deterministic, so any change in a number is a real change. A change counts as **WORSE** past these
limits; times are only flagged as **slower**.

| Yardstick | Measure | Tolerance |
|---|---|---|
| Truth | Edges at arm's length, solid, glow | +0.05 |
| Truth | Edges close | +0.10 |
| Truth | Edge pixels off | +1 point |
| Truth | Offset | +0.05 px |
| Truth | Specks | +10% |
| Bench | robust, adnMean, filtered | +0.02 |
| Bench | robust P95, adnP95, thin | +0.10 |
| Bench | neutral | +0.05 |
| Bench | steps | +3% |
| Times | Bench | +10% |
| Times | Truth separation | +15% |

A change can be worse on one measure and still be right. If so, say what got worse and why in the pull request.
Screens are reported, not judged: one more screen can be the right call.

## Record a new baseline (after a merge)

```bash
npm run benchmark -- --update --label "name" --note "what changed"
```

- This makes the run the baseline (`benchmark/baseline.json`) and adds a row to `benchmark/history.json`.
- It also rewrites the numbers section of this file. Commit those three files.

To add a past or unmerged version to the history without touching the baseline:

```bash
node benchmark/run.mjs --history --commit <sha> --label "name"
```

## Traps (each of these produced a wrong number once)

- **The bench's "steps" is per pixel.** It counts neighbour pixels where the print jumps more than the art, so it
  also counts dither grain. Compare steps only between versions that both dither.
- **Test the app's settings.** A benchmark that runs other settings than the app's defaults measures another tool.
- **Time alone.** Versions timed side by side on one machine read slower than they are.
- **Compare variants as code copies, not environment switches.**
- **Re-run a surprising number** from a clean checkout before believing it. The engine is deterministic: the same
  commit gives the same numbers on the same Node version, and only the times move. Node versions can differ in the
  third decimal.

## Test images

- **Bench:** `test-images/`. 04 to 18 are drawn by `scripts/make-test-images.py`; 01 to 03 are ADN synthetic test images
  (see NOTICE).
- **Vector truth:** `benchmark/truth/truth.png` and `benchmark/truth/input.png` were made by `benchmark/truth/make.py`. The PNGs are stored because
  the drawing depends on the installed font.

## Limits

- **Simulation only.** No real shirt has been printed from these films yet; every number is a model of the press.
- **Synthetic art only.** No photograph is in this benchmark. Results on photographs are not shown here.
- **Small art.** Images are at most 900 px, the size the app previews at. Full-size jobs have more pixels per halftone
  cell.
- **Bench scoring.** The bench uses each version's own scoring, so a change to the scoring moves the yardstick.

## Results

<!-- benchmark:generated:start -->

**Baseline:** 0.1.0 · commit `uncommitted` · 2026-11-17 · Intel(R) Xeon(R) W-1270P CPU @ 3.80GHz, Node v22.23.2 · first public tree; synthetic images only

| Yardstick | Measure | Baseline |
|---|---|---|
| Vector truth | Edges, close / arm's length | 5.213 / 2.825 |
| | Solid areas, arm's length | 1.835 |
| | Soft glow, arm's length | 9.094 |
| | Edge pixels off by >10, close | 21.6% |
| | Light-shape edge offset | 1.08 px |
| | Stray specks | 6801 |
| Bench (36 cases) | On-press (robust) | 2.597 |
| | On-press, worst 5% | 7.631 |
| | Colour (adnMean) | 2.093 |
| | Neutral | 5.055 |
| | Filtered | 2.088 |
| | Fine detail lost (thin) | 3.925 |
| | Steps | 7.011 |
| | Separation time, all cases | 132.9 s |

**Bench cases (baseline):**

| Case | Screens | Inks | On-press (robust) | Colour (adnMean) | Steps |
|---|---|---|---|---|---|
| 01-sunset-sim-process library | 7 | Purple/Teal/Pink/Scarlet/Golden Yellow/White | 1.250 | 0.800 | 5.880 |
| 01-sunset-sim-process art | 7 | Navy mix/Royal/Scarlet/Magenta mix/Lemon Yellow mix/White | 1.170 | 1.120 | 5.490 |
| 02-spot-logo-transparent library | 3 | Royal/Red/Golden Yellow | 3.500 | 3.500 | 0.840 |
| 02-spot-logo-transparent art | 3 | Royal/Red/Golden Yellow | 0.280 | 0.280 | 0.930 |
| 03-portrait-skin-tones library | 6 | Royal/Kelly Green/Orange/Flesh/White | 3.180 | 1.760 | 19.580 |
| 03-portrait-skin-tones art | 7 | Brown mix/Maroon mix/Royal mix/Orange mix/Tan mix/Flesh | 2.450 | 2.120 | 11.550 |
| 04-hue-wheel-black library | 8 | Royal/Magenta/Scarlet/Turquoise/Light Blue/Lime/Lemon Yellow | 9.490 | 9.210 | 2.170 |
| 04-hue-wheel-black art | 7 | Royal mix/Scarlet mix/Lime mix/Pink mix/Turquoise mix/White | 4.690 | 3.330 | 1.340 |
| 05-neutral-ramps-black library | 4 | Grey/Tan/White | 1.360 | 0.720 | 18.070 |
| 05-neutral-ramps-black art | 6 | Black mix/Tan mix/White mix/White mix/White | 1.650 | 0.770 | 18.730 |
| 06-fine-detail-spot-white library | 4 | Black/Royal/Red/Kelly Green | 3.480 | 3.480 | 2.330 |
| 06-fine-detail-spot-white art | 4 | Black/Royal/Red/Kelly Green | 0.270 | 0.270 | 1.240 |
| 07-pastels-navy library | 7 | Magenta/Pink/Lime/Light Blue/Lemon Yellow/White | 2.030 | 1.750 | 6.790 |
| 07-pastels-navy art | 6 | Light Blue mix/Pink mix/White mix/White mix/White | 1.640 | 1.510 | 3.350 |
| 08-earth-tones-sand library | 5 | Black/Brown/Magenta/Kelly Green/Golden Yellow | 2.530 | 1.210 | 18.850 |
| 08-earth-tones-sand art | 5 | Brown/Forest mix/Tan mix/Tan/Tan mix | 0.580 | 0.550 | 5.050 |
| 09-neon-black library | 6 | Magenta/Turquoise/Pink/Lemon Yellow/White | 6.550 | 6.030 | 6.670 |
| 09-neon-black art | 6 | Maroon mix/Pink mix/Turquoise mix/Lime mix/Lemon Yellow | 1.080 | 0.450 | 5.570 |
| 10-vintage-3color-heather library | 4 | Navy/Red/White | 7.150 | 7.150 | 0.800 |
| 10-vintage-3color-heather art | 4 | Navy mix/Red/White mix | 0.000 | 0.000 | 0.000 |
| 11-skin-grain-black library | 5 | Brown/Orange/Flesh/White | 0.960 | 0.900 | 5.600 |
| 11-skin-grain-black art | 5 | Brown/Brown mix/Tan mix/Flesh | 0.850 | 0.820 | 2.510 |
| 12-knockout-red library | 3 | Black/White | 0.480 | 0.480 | 0.000 |
| 12-knockout-red art | 3 | Black/White | 0.000 | 0.000 | 0.000 |
| 13-sky-gradient-black library | 6 | Royal/Orange/Lime/Flesh/Lemon Yellow | 2.330 | 0.640 | 10.210 |
| 13-sky-gradient-black art | 6 | Navy/Navy mix/Brown mix/Tan mix/Flesh mix | 1.620 | 1.610 | 9.250 |
| 14-index-blend-black library | 7 | Royal/Scarlet/Kelly Green/Light Blue/Golden Yellow/White | 2.680 | 2.680 | 22.550 |
| 14-index-blend-black art | 7 | Navy mix/Turquoise mix/Scarlet/Flesh mix/White mix/White | 0.600 | 0.600 | 10.180 |
| 15-photo-white library | 6 | Black/Kelly Green/Turquoise/Orange/Golden Yellow/Magenta | 6.970 | 6.340 | 2.890 |
| 15-photo-white art | 6 | Forest mix/Orange/Light Blue mix/Golden Yellow/Pink mix/Lime mix | 4.400 | 3.770 | 2.070 |
| 16-ink-ramps-black library | 7 | Royal/Scarlet/Kelly Green/Lime/Golden Yellow/White | 4.470 | 1.580 | 11.540 |
| 16-ink-ramps-black art | 7 | Royal/Red/Kelly Green/Orange/Golden Yellow mix/White | 3.380 | 0.990 | 11.210 |
| 17-ink-to-ink-black library | 7 | Royal/Orange/Light Blue/Red/Lime/White | 3.600 | 3.020 | 5.410 |
| 17-ink-to-ink-black art | 7 | Royal/Maroon mix/Kelly Green/Orange/Golden Yellow mix/White | 2.750 | 2.480 | 5.600 |
| 18-fade-to-shirt-white library | 5 | Black/Scarlet/Kelly Green/Royal/Golden Yellow | 1.750 | 1.390 | 9.240 |
| 18-fade-to-shirt-white art | 5 | Royal/Kelly Green/Golden Yellow/Red/White mix | 2.320 | 2.030 | 8.900 |

**History** (each version run with today's tools and settings):

| Version | Commit | Date | Truth edges (arm) | Glow (arm) | Bench robust | Bench steps | Note |
|---|---|---|---|---|---|---|---|
| 0.1.0 | `uncommitted` | 2026-11-17 | 2.825 | 9.094 | 2.597 | 7.011 | first public tree; synthetic images only |

<!-- benchmark:generated:end -->
