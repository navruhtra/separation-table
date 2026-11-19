# How Separation Table compares

Each row is a feature read in a public source. "Ours" is this
code.

- [SS] Spot Process Separation Studio User Guide, 2018 (an
  older version; NXT may differ):
  https://solutionsforscreenprinters.com/wp-content/uploads/2018/11/2018-user-guide-sim-process.pdf
- [US] UltraSeps v2 features page: https://ultraseps.com/?p=81
- [AR] AccuRIP Emerald guide:
  https://solutionsforscreenprinters.com/emerald-guide

| Feature (source) | Ours | Where / why |
|---|---|---|
| Sim-process separation engine [SS][US] | yes | mode sim |
| Custom ink sets from ink-maker data [SS] | yes | CSV import |
| Change print order, see the effect [SS] | yes | drag the cards |
| Ink view and film view [SS] | yes | Print, Inspect |
| Composite color proof [US] | yes | Print view |
| Spot color from a picked color [US] | yes | Add ink |
| CMYK process [US] | yes | method CMYK |
| File check before separating [US] | yes | checks |
| JPEG repair [US] | yes | Reduce noise |
| Register marks, corner and center [US] | yes | films |
| Pre-screened films, no RIP needed [US][AR] | yes | TIFF, PDF, EPS |
| Line screen and angle, 22.5° [AR] | yes | LPI, angle |
| Proof before films print [AR] | yes | proof.png |
| Several sim-process modules [US] | partial | one engine |
| Index with halftone base [US] | partial | solid base |
| Garment sets from maker data [SS] | partial | shirt chips |
| Merge channels to cut screens [SS] | yes | Merge on a screen card |
| Multi-layer densitometer [SS] | partial | point readout |
| Low-resolution enhance [US] | partial | Upscale 2× |
| Mesh calculator from LPI [AR] | partial | fixed factor |
| Measured press-run fidelity | not yet | model numbers |
| Discharge underbase [US] | not yet | |
| Halftone dot shape choice [AR] | not shown yet | in the code: round, ellipse, square, line (ISO 32000-1 spot functions); the page prints round |
| N-up films on one sheet [AR] | not yet | |
| Print films straight to an inkjet [AR] | not yet | a RIP is still needed |
| DCS 2.0 EPS, all channels in one file [SS][AR][PS] | not shown yet | in the code; checked with Ghostscript, not yet in AccuRIP |
| Saved shop or press profile | not shown yet | in the code; the page keeps mesh, sizes, ink library and calibration for the shop |

### Against a separation made by hand in Photoshop

| By hand in Photoshop | Ours |
|---|---|
| A spot channel per ink, named and colored | yes (PSD) |
| Underbase built and choked by hand | yes, automatic |
| Print order set in the Channels panel | yes, Auto |
| Halftone each channel (Bitmap mode) | yes, 1-bit films |
| Register marks and a test strip on each film | yes |
| Preview by stacking channel colors on screen | yes, ink model |
| A number for how close the print is to the art | yes, ΔE00 |
| Same job again from saved steps (actions) | not yet |
| Retouch one channel by hand in the tool | not yet: open the PSD |
