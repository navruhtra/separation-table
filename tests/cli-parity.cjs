// The sep CLI's job ZIP against the page's step 4 download, file by file, for the sample design at fixed settings.
//   npm start (or PORT=... node scripts/server.cjs) in another shell, then: node tests/cli-parity.cjs [http://127.0.0.1:8369/]
// The sample is drawn by the page's own sampleArt() and saved by the browser at the page's 900 px preview size, so the
// page and the CLI read the same pixels (no resampling on either side). Expected differences, each checked here:
//   - ZIP entry dates and separation.json "created": the time of each export.
//   - PDF /CreationDate and /ModDate: pdf-lib stamps the time of each export.
//   - Film margin text: the page draws labels with the browser's Helvetica, the CLI with its own block font. The
//     halftone image area must match bit for bit; only margin pixels may differ, and films.pdf (which embeds the films)
//     differs by the same pixels.
//   - proof.png: the page writes it with the browser's canvas encoder, the CLI with its own, so the bytes differ.
//     The decoded pixels must match: same size, no channel off by more than 2 except at most 0.1% of the pixels.
const { chromium } = require("playwright"), fs = require("fs"), path = require("path"), os = require("os"), { spawnSync } = require("child_process");
const JSZip = require(path.join(__dirname, "../.cache/node_modules/jszip")), { PDFDocument } = require(path.join(__dirname, "../.cache/node_modules/pdf-lib"));
(async () => {
  const url = process.argv[2] || "http://127.0.0.1:8369/", tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sep-parity-")), fixture = path.join(tmp, "sample-900.png");
  let fails = 0; const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails++; };
  // progress: each stage is printed as it starts, so a hang shows where it stopped; a whole run over 12 min fails
  let stage = "start"; const t0 = Date.now(), step = s => { stage = s; console.log(`[parity ${((Date.now() - t0) / 1000).toFixed(0)} s] ${s}`); };
  setTimeout(() => { console.log(`FAIL parity stopped for 12 min at: ${stage}`); process.exit(1); }, 12 * 60000).unref();
  step("launch Chromium");
  const b = await chromium.launch(), pg = await b.newPage({ viewport: { width: 1440, height: 1200 }, acceptDownloads: true }), errors = [];
  pg.on("pageerror", e => errors.push(e.message)); pg.on("console", m => { if (m.type() === "error") console.log("[page error] " + m.text()); });
  await pg.addInitScript(() => { try { localStorage.setItem("sepbench.targets", "[]"); } catch {} }); // no example colour target in either job
  step(`open ${url}`); await pg.goto(url); step("wait for sepReady"); await pg.waitForFunction(() => window.sepReady, null, { timeout: 30000 });
  step("draw the sample at preview size");
  // the sample at preview size, as the browser's own PNG
  const b64 = await pg.evaluate(async () => { const { sampleArt } = await import("./app.js"), a = sampleArt(), c = document.createElement("canvas"); c.width = a.W; c.height = a.H;
    c.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(a.rgba), a.W, a.H), 0, 0);
    const d = document.createElement("canvas"); d.width = d.height = 900; const g = d.getContext("2d"); g.imageSmoothingQuality = "high"; g.drawImage(c, 0, 0, 900, 900);
    const blob = await new Promise(r => d.toBlob(r, "image/png")), buf = new Uint8Array(await blob.arrayBuffer()); let s = ""; for (const v of buf) s += String.fromCharCode(v); return btoa(s); });
  fs.writeFileSync(fixture, Buffer.from(b64, "base64"));
  const idle = async () => { await pg.waitForTimeout(400); await pg.waitForFunction(() => { const s = document.getElementById("status").textContent; return /Updated|failed/.test(s) && !/refining/.test(s) && !document.getElementById("auto").disabled && document.getElementById("busyMask").hidden; }, null, { timeout: 300000 }); };
  step("load the sample and separate"); await pg.setInputFiles("#file", fixture); await idle();
  step("fixed settings, 6 screens");
  // fixed settings: every finer setting back to its default, the garment black, Simulated process, 6 color screens
  await pg.evaluate(() => { for (const g of ["2", "3"]) document.querySelector(`[data-def="${g}"]`).click(); }); await idle();
  await pg.evaluate(() => { const n = document.getElementById("nInks"); n.value = "6"; n.dispatchEvent(new Event("change")); }); await idle();
  if (await pg.evaluate(() => !document.getElementById("step4Body") || document.getElementById("step4Body").hidden)) await pg.click("#step4Btn");
  step("export (download)"); const [dl] = await Promise.all([pg.waitForEvent("download", { timeout: 300000 }), pg.click("#export")]);
  fs.copyFileSync(await dl.path(), path.join(tmp, "page.zip")); const pageZip = await JSZip.loadAsync(fs.readFileSync(path.join(tmp, "page.zip"))); await b.close();
  ok(!errors.length, `no page errors${errors.length ? ": " + errors.join("; ") : ""}`);
  const pageSpec = JSON.parse(await pageZip.file("separation.json").async("string"));
  ok(pageSpec.separation === "sim" && pageSpec.screens.filter(s => s.name !== "Underbase").length === 6, `the page exported Simulated process with 6 color screens (${pageSpec.screens.map(s => s.name).join(", ")})`);

  step("sep convert"); const cliZipPath = path.join(tmp, "cli.zip"), r = spawnSync(process.execPath, ["--no-warnings", path.join(__dirname, "../src/cli/sep.mjs"), "convert", fixture, "--shirt", "black", "--mode", "sim", "--screens", "6", "-o", cliZipPath, "--quiet"], { encoding: "utf8", timeout: 600000 });
  ok(r.status === 0, `sep convert ran${r.status ? ": " + r.stderr : ""}`); if (r.status) process.exit(1);
  step("compare"); const cliZip = await JSZip.loadAsync(fs.readFileSync(cliZipPath)), files = z => Object.keys(z.files).filter(n => !z.files[n].dir).sort();
  ok(JSON.stringify(files(pageZip)) === JSON.stringify(files(cliZip)), `same file list (${files(cliZip).length} files)`);
  const tiffBits = buf => { const dv = new DataView(buf.buffer, buf.byteOffset), n = dv.getUint16(8, true), tag = t => { for (let i = 0; i < n; i++) { const o = 10 + i * 12; if (dv.getUint16(o, true) === t) return dv.getUint16(o + 2, true) === 3 ? dv.getUint16(o + 8, true) : dv.getUint32(o + 8, true); } };
    const w = tag(256), h = tag(257), off = tag(273), rb = Math.ceil(w / 8), out = new Uint8Array(rb * h); let i = off, o = 0;
    while (o < out.length) { const c = buf[i++]; if (c < 128) { out.set(buf.subarray(i, i + c + 1), o); i += c + 1; o += c + 1; } else if (c > 128) { out.fill(buf[i++], o, o + 257 - c); o += 257 - c; } }
    return { w, h, rb, out }; };
  const dpi = pageSpec.print.dpi, mx = Math.round(dpi * 0.5), report = [];
  for (const name of files(cliZip)) {
    const a = await pageZip.file(name)?.async("nodebuffer"), c = await cliZip.file(name).async("nodebuffer"); if (!a) continue;
    if (a.equals(c)) { report.push(`${name}: byte-equal`); continue; }
    if (name === "separation.json") { const strip = s => { const j = JSON.parse(s); delete j.created; return JSON.stringify(j); };
      const same = strip(a.toString()) === strip(c.toString()); ok(same, `separation.json equal except "created"`); report.push(`${name}: ${same ? "equal except created" : "DIFFERS"}`); continue; }
    if (name.endsWith(".pdf") && name !== "films.pdf") { // dates sit in a compressed object stream: re-save both with the dates fixed
      const norm = async buf => { const d = await PDFDocument.load(buf, { updateMetadata: false }); d.setCreationDate(new Date(0)); d.setModificationDate(new Date(0)); return Buffer.from(await d.save({ useObjectStreams: false })); };
      const same = (await norm(a)).equals(await norm(c)); ok(same, `${name} equal except its dates`); report.push(`${name}: ${same ? "equal except /CreationDate /ModDate" : "DIFFERS"}`); continue; }
    if (name.startsWith("tiff/")) { const A = tiffBits(a), C = tiffBits(c); let inImage = 0, margin = 0;
      for (let y = 0; y < A.h; y++) for (let x = 0; x < A.w; x++) { const bit = v => (v.out[y * v.rb + (x >> 3)] >> (7 - (x & 7))) & 1; if (bit(A) !== bit(C)) { if (x >= mx && x < A.w - mx && y >= mx && y < A.h - mx) inImage++; else margin++; } }
      ok(A.w === C.w && A.h === C.h && inImage === 0, `${name}: halftone area bit-equal; ${margin} margin pixels differ (label font)`); report.push(`${name}: image area bit-equal, ${margin} margin pixels differ (${(margin / (A.w * A.h) * 100).toFixed(3)}%)`); continue; }
    if (name.endsWith(".png")) { const { decodePNG } = await import("../src/cli/platform.mjs"), A = decodePNG(a), C = decodePNG(c); let off = 0, max = 0;
      if (A.W === C.W && A.H === C.H) for (let q = 0; q < A.W * A.H; q++) { let m = 0; for (let k = 0; k < 4; k++) m = Math.max(m, Math.abs(A.rgba[q * 4 + k] - C.rgba[q * 4 + k])); max = Math.max(max, m); if (m > 2) off++; }
      const same = A.W === C.W && A.H === C.H && off <= A.W * A.H * 0.001;
      ok(same, `${name}: pixels match (${A.W} × ${A.H}; largest channel difference ${max}, ${off} pixels over 2)`); report.push(`${name}: ${same ? `pixels match, bytes differ (encoder); largest channel difference ${max}` : "DIFFERS"}`); continue; }
    if (name === "films.pdf") { report.push(`${name}: differs (embeds the films, whose margin labels differ; ${a.length} vs ${c.length} bytes)`); continue; }
    ok(false, `${name} differs`); report.push(`${name}: DIFFERS (${a.length} vs ${c.length} bytes)`);
  }
  console.log("\n" + report.join("\n"));
  fs.writeFileSync(path.join(tmp, "report.txt"), report.join("\n") + "\n"); console.log(`\nfiles kept in ${tmp}`);
  console.log(fails ? `${fails} FAILED` : "all passed"); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
