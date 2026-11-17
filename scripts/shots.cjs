// README and review shots of the Separation Table at phone (390 px) and desktop (1280 px) width.
//   npm start (in another shell), then: node scripts/shots.cjs [http://127.0.0.1:8369/] [out-dir]
// Each shot loads the sample design, opens the place it shows and saves <name>-390.png and <name>-1280.png.
// Optional: SHOTS=name,name to take only some; a separated Photoshop file in SHOTS_PSD for the re-proof shot.
const { chromium, devices } = require("playwright"), fs = require("fs"), path = require("path");
const url = process.argv[2] || "http://127.0.0.1:8369/", out = path.resolve(process.argv[3] || "shots");
const only = (process.env.SHOTS || "").split(",").filter(Boolean), psd = process.env.SHOTS_PSD || "";
const done = async pg => { await pg.waitForTimeout(250); await pg.waitForFunction(() => /Updated|failed/.test(document.getElementById("status").textContent), null, { timeout: 240000 });
  await pg.waitForFunction(() => document.getElementById("busyMask").hidden, null, { timeout: 240000 }); await pg.waitForTimeout(400); };
const openStep = async (pg, n) => { if (await pg.isHidden(`#step${n}Body`)) await pg.click(`#step${n}Btn`); await pg.waitForTimeout(300); };
/** Scroll an element into view and shoot the viewport (phones) or the element's panel (desktop). */
const at = async (pg, sel) => { await pg.locator(sel).first().scrollIntoViewIfNeeded(); await pg.waitForFunction(() => document.getElementById("busyMask").hidden && !/…/.test(document.getElementById("busyText").textContent || "") || document.getElementById("busyMask").hidden, null, { timeout: 240000 }); await pg.waitForTimeout(1500); };
const SHOTS = {
  print: async pg => { await openStep(pg, 3); await at(pg, "#view0"); },
  card: async pg => { await openStep(pg, 3); const c = "#scrList .scard:nth-child(2)"; if (await pg.isHidden(`${c} .sprod`)) await pg.click(`${c} .sexp`);
    await pg.fill(`${c} [data-rename]`, "Customer Red"); await pg.press(`${c} [data-rename]`, "Enter"); await pg.selectOption(`${c} [data-hits]`, "2f"); await at(pg, `${c} .sprod`); },
  export: async pg => { await openStep(pg, 4); await pg.selectOption("#mirror", "mirror"); await at(pg, "#ptLine"); },
  reproof: async pg => { await openStep(pg, 1); if (psd) { await pg.setInputFiles("#impFile", psd); await pg.waitForFunction(() => /\b(ok|bad)\b/.test(document.getElementById("impNote").className), null, { timeout: 240000 }); await done(pg); await openStep(pg, 1); } await at(pg, "#impBox"); },
  report: async pg => { await pg.evaluate(() => document.getElementById("shopOpen").click()); await pg.click("#reportCopy"); await pg.waitForTimeout(300); await at(pg, "#reportBox"); },
};
(async () => {
  fs.mkdirSync(out, { recursive: true }); const b = await chromium.launch();
  for (const [w, ctxOpts] of [[390, { ...devices["iPhone 13"], viewport: { width: 390, height: 844 } }], [1280, { viewport: { width: 1280, height: 900 } }]]) {
    const ctx = await b.newContext({ ...ctxOpts, acceptDownloads: true }), pg = await ctx.newPage(); await ctx.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => { });
    await pg.goto(url); await pg.waitForTimeout(600); await pg.click(w === 390 ? "#dropSample" : "#trySample"); await done(pg);
    for (const [name, go] of Object.entries(SHOTS)) { if (only.length && !only.includes(name)) continue;
      await go(pg); const f = path.join(out, `${name}-${w}.png`); await pg.screenshot({ path: f }); console.log(f);
      if (await pg.evaluate(() => !!document.querySelector("dialog[open]"))) await pg.keyboard.press("Escape"); }
    await ctx.close(); }
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
