// Phone layout stress test: every phone size, every scroll position (8 px steps), with and without art, in Print and
// Inspect, with the rating open, light and dark. Checks the pinned stack, content stability, the fold, and overlaps.
//   npm start (in another shell), then: node tests/phone-stress.cjs [http://127.0.0.1:8369/]
const { chromium } = require("playwright");
const URL = process.argv[2] || "http://127.0.0.1:8369/", STEP = 8;
const SIZES = [[320, 568, "iPhone SE 1"], [360, 640, "small Android"], [375, 667, "iPhone SE 2/3"], [390, 844, "iPhone 12-14"], [393, 852, "iPhone 15/16"], [412, 915, "Pixel / Galaxy"], [430, 932, "iPhone Pro Max"], [768, 1024, "iPad mini portrait"], [667, 375, "iPhone SE landscape"], [844, 390, "iPhone landscape"]];
(async () => {
  const b = await chromium.launch(); let fails = 0, checks = 0; const rows = [];
  const bad = (msg) => { fails++; if (fails <= 60) console.log("FAIL " + msg); };
  for (const [W, H, name] of SIZES.filter(([w, h]) => !process.env.ONLY || process.env.ONLY.split(",").includes(`${w}x${h}`))) for (const scheme of W === 390 ? ["light", "dark"] : ["light"]) {
    const ctx = await b.newContext({ viewport: { width: W, height: H }, hasTouch: true, colorScheme: scheme }), pg = await ctx.newPage();
    const errs = []; pg.on("pageerror", e => errs.push(e.message)); pg.on("console", m => m.type() === "error" && errs.push(m.text()));
    await pg.goto(URL); await pg.waitForTimeout(400);
    const geo = () => pg.evaluate(() => {
      const R = id => { const e = document.getElementById(id); if (!e || e.offsetParent === null && getComputedStyle(e).position !== "fixed") return null; const r = e.getBoundingClientRect(); return { t: r.top, b: r.bottom, l: r.left, r: r.right, h: r.height }; };
      const steps = document.getElementById("paneSteps").getBoundingClientRect();
      return { y: scrollY, vh: innerHeight, vw: innerWidth, sw: document.documentElement.scrollWidth, max: document.documentElement.scrollHeight - innerHeight,
        sq: R("square"), vb: R("viewBar"), rt: R("viewBar"), nav: R("mNav"), prog: R("mProg"), chip: R("mRate"), back: R("mBack"), next: R("mNext"), nextFits: (n => n.scrollWidth <= n.clientWidth + 1)(document.getElementById("mNext")), squash: (c => { const r = c.getBoundingClientRect(); if (!c.width || !r.width || getComputedStyle(c).objectFit === "contain") return 0; return Math.abs((r.width / r.height) / (c.width / c.height) - 1); })(document.getElementById("view0")), sheet: R("rating"),
        zoom: R("zoomBox"), where: R("inspWhere"), chan: R("chanBox"), stepsDoc: steps.top + scrollY, stepsTop: steps.top, artoff: document.body.classList.contains("artoff"),
        full: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--sqfull")) || 0 };
    });
    // Reach a control the way a person does: scroll down from the top until it sits in the free area (below the stack,
    // above the Back/Next bar) and nothing covers its centre. Returns false if no scroll position works.
    const reach = (sel) => pg.evaluate(async (sel) => {
      const el = document.querySelector(sel); if (!el) return false; const raf = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      scrollTo(0, 0); await raf(); const max = document.documentElement.scrollHeight - innerHeight;
      for (let y = 0; y <= max + 24; y += 24) { scrollTo(0, Math.min(y, max)); await raf();
        const r = el.getBoundingClientRect(), stack = document.getElementById("viewBar").getBoundingClientRect().bottom, nav = document.getElementById("mNav").getBoundingClientRect().top;
        if (r.top >= Math.max(0, stack) - 0.5 && r.bottom <= nav + 0.5 && r.height > 0) { const hit = document.elementFromPoint(r.left + Math.min(r.width / 2, 20), r.top + r.height / 2); if (hit && (hit === el || el.contains(hit) || hit.closest("label") === el.closest("label"))) return true; } }
      return false; }, sel);
    const tap = async (sel) => { if (!(await reach(sel))) { bad(`${name} ${W}×${H}: cannot scroll ${sel} into the free area`); await pg.evaluate(s => document.querySelector(s).click(), sel); return; }
      const bx = await pg.locator(sel).boundingBox(); await pg.mouse.click(bx.x + Math.min(bx.width / 2, 20), bx.y + bx.height / 2); };
    // every control in the open step can be reached: one sweep down the page marks each control that, at some scroll
    // position, sits in the free area with nothing covering it
    const reachAll = async (label) => { const res = await pg.evaluate(async () => {
        const raf = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        const els = [...document.querySelectorAll(".sstep.open .stbody button, .sstep.open .stbody input:not([type=hidden]), .sstep.open .stbody select, .sstep.open .stbody summary")].filter(e => e.getClientRects().length && getComputedStyle(e).visibility !== "hidden" && !(e.parentElement && e.parentElement.closest("details:not([open])") && !(e.closest("summary") && e.closest("summary").parentElement === e.parentElement.closest("details:not([open])"))));
        const ok = new Set(); scrollTo(0, 0); await raf(); const max = document.documentElement.scrollHeight - innerHeight;
        for (let y = 0; y <= max + 16; y += 16) { scrollTo(0, Math.min(y, max)); await raf(); const stack = Math.max(0, document.getElementById("viewBar").getBoundingClientRect().bottom), nav = document.getElementById("mNav").getBoundingClientRect().top;
          els.forEach((el, i) => { if (ok.has(i)) return; const r = el.getBoundingClientRect(); if (r.top >= stack - 0.5 && r.bottom <= nav + 0.5) { const hit = document.elementFromPoint(r.left + Math.min(r.width / 2, 20), r.top + r.height / 2); if (hit && (hit === el || el.contains(hit) || (hit.closest("label") && hit.closest("label") === el.closest("label")))) ok.add(i); } }); }
        return { n: els.length, miss: els.map((e, i) => ok.has(i) ? null : `${e.tagName.toLowerCase()}#${e.id || "?"} "${(e.textContent || e.getAttribute("aria-label") || e.name || "").trim().slice(0, 24)}" h=${Math.round(e.getBoundingClientRect().height)}`).filter(Boolean) }; });
      checks += res.n; res.miss.forEach(m => bad(`${name} ${W}×${H} ${label}: cannot reach ${m}`));
      rows.push({ size: `${W}×${H} ${name}`, scheme, state: `${label}: controls reached`, maxScroll: "", "room at top": `${res.n - res.miss.length}/${res.n}` }); };
    // the same with Advanced open (then folded again)
    const reachAdv = async (label) => { await reachAll(label); if (!(await pg.isVisible("#advTog"))) return; await pg.evaluate(() => document.getElementById("advTog").click()); await reachAll(label + " + Advanced"); await pg.evaluate(() => document.getElementById("advTog").click()); };
    const sweep = async (label, up = false) => {
      await pg.evaluate(() => scrollTo(0, 0)); await pg.waitForTimeout(120);
      let g = await geo(), doc0 = g.stepsDoc, minFree = 1e9, topFree = 0, deep = null; const max = g.max;
      if (up) { for (let y = 0; y <= max; y += 40) { await pg.evaluate(y => scrollTo(0, y), y); await pg.evaluate(() => new Promise(r => requestAnimationFrame(r))); } }
      const ys = []; for (let y = 0; y <= max + STEP; y += STEP) ys.push(Math.min(y, max)); if (up) ys.reverse();
      for (const y of ys) {
        await pg.evaluate(y => scrollTo(0, y), y); await pg.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
        g = await geo(); checks++; const at = `${name} ${W}×${H} ${scheme} ${label} y=${g.y}`;
        if (g.sw > g.vw + 0.5) bad(`${at}: page scrolls sideways (${g.sw} > ${g.vw})`);
        if (Math.abs(g.vb.t - g.sq.b) > 1) bad(`${at}: view row is not on the image (${g.vb.t} vs ${g.sq.b})`);
        if (!g.chip || Math.abs(g.chip.t - g.nav.t) > 1.5 || g.chip.b > g.back.t + 0.5 || g.back.r > g.next.l + 0.5 || g.next.r > g.vw + 0.5 || g.next.b > g.vh + 0.5) bad(`${at}: the bottom bar does not fit: rating ${g.chip && g.chip.t}..${g.chip && g.chip.b}, Back ${g.back && g.back.r}, Next ${g.next && g.next.l}..${g.next && g.next.r}`);
        if (!g.nextFits) bad(`${at}: the Next label is cut off`);
        if (g.squash > 0.02) bad(`${at}: the image is squashed (${(g.squash * 100).toFixed(0)}% out of shape)`);
        if (Math.abs(g.stepsDoc - doc0) > 1) bad(`${at}: content jumped (${doc0} → ${g.stepsDoc})`);
        if (g.sq.h > g.full + 1 || g.sq.h < Math.min(222, g.full) - 1) bad(`${at}: image height ${g.sq.h} outside band..full (${g.full})`);
        if (g.full > g.vh * 0.55 + 1) bad(`${at}: full image ${g.full} is more than 55% of the height`);
        if (!g.nav || Math.abs(g.nav.b - g.vh) > 1 || !g.prog || g.prog.h < 3) bad(`${at}: Back/Next bar or step strip not at the bottom`);
        if (g.where && g.chan && g.where.b > g.chan.t + 0.5) bad(`${at}: Inspect hint sits under the swatches (${g.where.b} > ${g.chan.t})`);
        // up or down, the stack sits on the content, or is fully off: it never slides over the steps
        const next = Math.min(...[g.zoom, g.chan].filter(Boolean).map(e => e.t), g.stepsTop);
        if (!(Math.abs(g.rt.b - next) <= 1.5 || g.rt.b <= 0.5 || next > g.rt.b)) bad(`${at}: content under the stack (${next} < ${g.rt.b})`);
        const free = g.vh - Math.max(0, g.rt.b) - (g.nav ? g.nav.h : 0); if (g.y === 0) topFree = free; minFree = Math.min(minFree, free); deep = { free, artoff: g.artoff, y: g.y };
      }
      rows.push({ size: `${W}×${H} ${name}`, scheme, state: label, maxScroll: max, "room at top": Math.round(topFree), "room scrolled": Math.round(deep.free), "art scrolled off": deep.artoff });
      return deep;
    };
    // 1. empty page
    const d0 = await sweep("empty"); if (!d0.artoff && W < 960) { /* no art: the rating line has no picture */ }
    { const g = await geo(); if (g.rt.b > 1) bad(`${name} ${W}×${H} empty: the image does not scroll off at the bottom of the page (view row ends at ${g.rt.b})`); }
    // 2. sample loaded (step 2 open)
    // the case from the field: no art, step 4 open, scroll to the bottom and back up
    await pg.evaluate(() => document.getElementById("step3Btn").click()); await pg.waitForTimeout(1100); await pg.click("#mNext"); await pg.waitForTimeout(1100); await sweep("empty · step 4, scrolling up", true);
    await pg.evaluate(() => document.getElementById("step1Btn").click()); await pg.waitForTimeout(1100);
    await reachAdv("step 1, empty");
    await tap("#trySample");
    await pg.waitForFunction(() => /Updated|failed/.test(document.getElementById("status").textContent), null, { timeout: 240000 }); await pg.waitForTimeout(1200);
    await sweep("art · Print"); await reachAdv("step 2");
    await pg.evaluate(() => scrollTo(0, document.documentElement.scrollHeight)); await pg.waitForTimeout(200);
    { const g = await geo(); if (!g.artoff) bad(`${name} ${W}×${H}: scrolled to the bottom, the art is not off screen`); }
    await sweep("art · Print, scrolling up", true);
    await pg.evaluate(() => scrollTo(0, document.documentElement.scrollHeight)); await pg.waitForTimeout(150);
    // 3. steps: Next/Back puts each step's title just under the stack
    await pg.evaluate(() => scrollTo(0, 0)); await pg.waitForTimeout(150);
    for (const [btn, n] of [["#mNext", 3], ["#mNext", 4], ["#mBack", 3], ["#mBack", 2], ["#mBack", 1]]) {
      await pg.click(btn); await pg.waitForTimeout(1100); if (btn === "#mNext" && n === 3) { await reachAdv("step 3"); await pg.evaluate(() => scrollTo(0, 0)); await pg.evaluate(() => document.getElementById("step2Btn").click()); await pg.waitForTimeout(1100); await pg.click("#mNext"); await pg.waitForTimeout(1100); } if (n === 4 && btn === "#mNext") { await reachAdv("step 4"); await pg.evaluate(() => scrollTo(0, 0)); await pg.evaluate(() => document.getElementById("step3Btn").click()); await pg.waitForTimeout(1100); await pg.click("#mNext"); await pg.waitForTimeout(1100); } const g = await geo(), t = await pg.evaluate(n => document.getElementById(`step${n}`).getBoundingClientRect().top, n); checks++;
      const lowest = Math.max(g.rt.b, 0), navTop = g.nav ? g.nav.t : g.vh; const keep = g.vh - (g.nav ? g.nav.h : 0) - (Math.min(222, g.full) + g.vb.b - g.vb.t) >= 160; if (t < lowest - 1 || t + 40 > navTop || (keep && (g.sq.t < -1 || g.sq.h < Math.min(222, g.full) - 1))) bad(`${name} ${W}×${H}: ${btn} to step ${n}: step top at ${t.toFixed(0)} (stack ends at ${lowest.toFixed(0)}, bar at ${navTop.toFixed(0)}); image ${g.sq.t.toFixed(0)}+${g.sq.h.toFixed(0)}`);
      { const sh = await pg.evaluate(n => document.getElementById(`step${n}`).getBoundingClientRect().height, n), room = navTop - (Math.min(222, g.full) + (g.vb.b - g.vb.t)) - 18, b2 = t + sh; checks++;
        if (keep && sh <= room && b2 > navTop + 1 && g.sq.h > Math.min(222, g.full) + 1) bad(`${name} ${W}×${H}: ${btn} to step ${n}: the step (${Math.round(sh)} px) could fit above the bar but ends at ${Math.round(b2)} (bar at ${Math.round(navTop)})`); }
    }
    // 4. Inspect, then 5. rating open
    await pg.evaluate(() => scrollTo(0, 0)); await pg.click('#view button[data-v=film]'); await pg.waitForTimeout(1500); await sweep("art · Inspect");
    await pg.evaluate(() => scrollTo(0, 0)); await pg.click('#view button[data-v=sim]'); await pg.click("#mRate"); await pg.waitForTimeout(300); await sweep("art · rating open");
    { const g = await geo(); const open = await pg.evaluate(() => { const r = document.getElementById("rating").getBoundingClientRect(); return { t: r.top, b: r.bottom, h: r.height }; }); checks++;
      if (open.t < 0 || open.b > g.vh - (g.nav ? g.nav.h : 0) + 1) bad(`${name} ${W}×${H}: the open rating runs under the Back/Next bar (${open.b} > ${g.vh - g.nav.h})`); }
    if (errs.length) bad(`${name} ${W}×${H}: console errors: ${errs.join(" | ")}`);
    await pg.screenshot({ path: `.cache/shots/stress-${W}x${H}-${scheme}.png` }); await ctx.close();
  }
  console.table(rows); console.log(`${checks} checks, ${fails} failed`); await b.close(); process.exit(fails ? 1 : 0);
})();
