# Changelog

What changed in the Separation Table, in plain words, newest first.
Versions follow semantic versioning; the number lives in version.js.

## 0.1.0 (2026-11-13)

First numbered version. It holds every change since the tool went live
on 2026-11-05. Before 0.1.0 the tool had no version number, so the
entries below are grouped by the day each change merged (Pacific time).

Left out: changes to the whole ADN site (menus, tool page header and
footer, search) and internal-only changes.

- Phone: a job tab keeps its view and zoom, and the open tab shows
  its name. The rating row is higher. On a short phone the zoom
  slider shows without a scroll. On the ADN tool page the theme
  switch is in Shop setup
- The two help lines in the empty art box are smaller
- The Differences switch is removed from the workspace. Compare
  shows the art and the print side by side
- New look and layout. New colors, with a light and a dark theme. A
  workspace in the centre: the art on the garment color, with the rows
  under it. A screens row with a suggested screen when the art needs
  one. Advanced Settings as rows that show what Auto chose. A phone
  layout with the workspace pinned at the top. Job tabs above the
  workspace: one tab for each job, up to 12, all kept after a reload,
  with Undo and Redo at the end of the tab strip
- Version number shown in Help, written into separation.json and printed
  on the job sheet. MIT license, NOTICE, this changelog, and a README
  status section built from the test output.
- The ZIP holds proof.png, the Print view as a picture; the version
  also shows under About on the tool page
- Release notes per version, third-party notices built from the
  pinned libraries, and a SHA-256 for every file the page serves

[Full release notes](releases/0.1.0.md)

### 2026-11-16

- The page shows the first-release set of controls: three views (Art,
  Compare, Print), Undo and Redo, Shop setup that starts with the ink
  library and the calibration
- The rating says its ΔE is a model number; Auto's table and
  the desktop facts row now say so too
- Films right reading or mirrored; name a screen; double hit
- Fabric; Undo and Redo; the last job comes back after a reload; merge
  a screen into another
- Platen, film and screen sizes, with size checks
- Checks have a severity and Show where

Present in the code, not shown yet (`?later=1` shows them): several
open jobs, Press and Stack views, shop and press profiles, check
limits, units, test films, Report a problem, the press time estimate,
the DCS 2.0 file, dot shapes other than round, re-proof of separated
films, the MCP server. The `sep` command-line tool is experimental.

### 2026-11-13

- On a phone: the drop box fits its content; sample link on one line
- Faster separations, same results
- On a phone: sample link on the first screen; zoom slider only takes sideways drags
- Zoom bubble above the slider, navy with a grey edge
- No speck holes where the largest dot is near solid
- On a phone: only the image pins; view row and rating scroll with the steps
- Smooth ink map (no recipe jumps), on by default
- A drag on the table scrolls the ADN page again
- Out-of-gamut check names colours; mesh follows LPI
- A finger on the image scrolls the page; Fit zooms on a tap only
- The pinned art holds steady while a phone scrolls fast
- On the ADN page, the table never scrolls inside its frame
- Hidden dots grow with the ink (no dark islands from trace inks)
- The art stays pinned again on the ADN page
- On the ADN page, the Back/Next bar ends the page flow
- Line work no ink matches prints solid, and a screen in its colour is offered
- Press notes on the job sheet; index preflight checks
- Solid shapes print true to size, keep tint colours, hairlines go solid
- Pick refill inks by on-press score; refill any empty sim ink
- Refill the empty highlight-white screen
- Spot jobs pick library inks by solid-ink error
- Stack limit counts colour ink only, 240% default, range 240-280%
- Hard edges stay hard (line work, solid shapes, flat sub-pixel edges)
- Point readout on the color cards

### 2026-11-12

- Ink stack limit 320% by default (was 280%)
- Rate index on the blended print
- Index shades (same ink with and without base)
- Job sheet in the download
- Print view at printed dot size; base trimmed to the ink on it
- The page says 'this device', not 'this computer'
- Smooth ink recipes; Auto stops choosing interlocked for now
- Full page acts like a wall program
- Interlocked screening (two inks per spot, side by side)
- Five how-to guide pages
- Stack-aware solve (fixes the sunset's pale band)
- Adjust the art sliders; honest film scoring; scatter small dots
- FILES keeps each job on this device
- Keep Auto's inks when it tries an accent screen (sunset banding fix)
- About tab next to Program

### 2026-11-11

- Its own page under the service tag tree, on the work side
- The added-ink flow scores only the separation it keeps
- Auto's trials skip work they never show (same results, faster)
- Auto about 3× faster, with a picture after 1–2 seconds
- No blank space on the wall; Compare shows the real film dots
- Spot and Index print dark inks on dark shirts without base
- Auto keeps the print method you pick and tunes it

### 2026-11-10

- Sim keeps accent colours, and adds a screen when they need one

### 2026-11-09

- Photoshop export as Multichannel, spot channels only
- Print method picker, CMYK and 1–3 ink tone methods
- Stop the Separation Table scroll fight
- Spot v2 on by default; phone side-scroll fixed; all tests pass in CI
- Highlight white Auto/On/Off, trap that survives to the film, Grading leftovers removed

### 2026-11-08

- Clean Separation Table controls
- Keep the empty drop area light
- Keep Separation Table in light colors
- Widen the Separation Table drop box inset
- Inset the Separation Table drop box
- Show Separation Table at its own height
- Let Separation Table fill the wall
- Show the ADN header on Separation Table
- Fit Separation Table under the ADN header
- Open Separation Table inside the wall

### 2026-11-06

- Auto ink-mix search; Add ink from the art first; added inks placed by calculation; Grading removed
- Grading (ROYGBIV) in Advanced; page stops at the content; zoom row under the image
- + Add ink (my inks, missing colors, color picker); pinned image band
- Quarter-step tap zoom, color squares, delete a screen, Auto reasoning on the notice
- Row tap focuses its film; tap-to-zoom; step 2 changes rerun Auto
- Numbers in the rating, compact notice, FIT/100% zoom, LPI and Press in Advanced
- Native upload taps, and show start-up errors on the page

### 2026-11-05

- Tapping the art card opens the file picker
- Color rows, Art/Compare/Print, Auto/Default in Advanced, steady Inspect
- Fix fine-line loss in spot cleanup, rotated-angle moiré, cure label
- Launch at /separation-table
