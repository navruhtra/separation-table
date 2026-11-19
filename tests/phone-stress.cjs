// Phone layout stress test: every phone size, every scroll position (8 px steps), with and without art, in Print and
// Compare, with the rating open, light and dark. Checks the pinned workspace, content stability, the fold, and overlaps.
//   npm start (in another shell), then: node tests/phone-stress.cjs [http://127.0.0.1:8369/]
// The layout under test (bench.css, phone block): title row; the job tabs, 33 px high, and under them the workspace,
// 300 px high (192 px on a screen 620 px high or less), both pinned at the top of the screen while the page scrolls (on a screen too short to leave 160 px
// under them, they scroll away: body.nopin); the
// rows (view switch, rating with its details in the flow, zoom, screens); the steps; Back and Next fixed at the bottom.
const { chromium } = require("playwright"), fs = require("fs"), path = require("path");
const URL = process.argv[2] || "http://127.0.0.1:8369/", STEP = 8, TAB = 33;
const SIZES = [[320, 568, "iPhone SE 1"], [360, 640, "small Android"], [375, 667, "iPhone SE 2/3"], [390, 844, "iPhone 12-14"], [393, 852, "iPhone 15/16"], [412, 915, "Pixel / Galaxy"], [430, 932, "iPhone Pro Max"], [768, 1024, "iPad mini portrait"], [667, 375, "iPhone SE landscape"], [844, 390, "iPhone landscape"]];
(async () => {
  const b = await chromium.launch(); let fails = 0, checks = 0; const rows = [];
  const bad = (msg) => { fails++; if (fails <= 60) console.log("FAIL " + msg); };
  const shots = path.join(__dirname, "../.cache/shots"); fs.mkdirSync(shots, { recursive: true });
  for (const [W, H, name] of SIZES.filter(([w, h]) => !process.env.ONLY || process.env.ONLY.split(",").includes(`${w}x${h}`))) for (const scheme of W === 390 ? ["light", "dark"] : ["light"]) {
    const WS = H <= 620 ? 192 : 300; // the workspace is lower on a short screen (bench.css)
    const ctx = await b.newContext({ viewport: { width: W, height: H }, hasTouch: true, colorScheme: scheme }), pg = await ctx.newPage();
    const errs = []; pg.on("pageerror", e => errs.push(e.message)); pg.on("console", m => m.type() === "error" && errs.push(m.text()));
    await pg.goto(URL); await pg.waitForTimeout(400);
    const geo = () => pg.evaluate(() => {
      const R = id => { const e = document.getElementById(id); if (!e || e.offsetParent === null && getComputedStyle(e).position !== "fixed") return null; const r = e.getBoundingClientRect(); return { t: r.top, b: r.bottom, l: r.left, r: r.right, h: r.height }; };
      const steps = document.getElementById("paneSteps").getBoundingClientRect(), rate = document.getElementById("rating");
      return { y: scrollY, vh: innerHeight, vw: innerWidth, sw: document.documentElement.scrollWidth, max: document.documentElement.scrollHeight - innerHeight,
        head: document.querySelector(".mhead").getBoundingClientRect().height, tab: R("tabBar"), sq: R("square"), vb: R("viewBar"), rate: R("dRate"), data: rate.classList.contains("open") ? R("rData") : null, zoom: R("zoomBox"), scr: R("scrRow"),
        nav: R("mNav"), prog: R("mProg"), back: R("mBack"), next: R("mNext"), nextFits: (n => n.scrollWidth <= n.clientWidth + 1)(document.getElementById("mNext")),
        squash: (c => { const r = c.getBoundingClientRect(); if (!c.width || !r.width || getComputedStyle(c).objectFit === "contain") return 0; return Math.abs((r.width / r.height) / (c.width / c.height) - 1); })(document.getElementById("view0")),
        stepsDoc: steps.top + scrollY, stepsTop: steps.top, nopin: document.body.classList.contains("nopin") };
    });
    // the free area: below the workspace (while it is on screen), above the Back/Next bar
    const FREE = `(() => { const s = document.getElementById("square").getBoundingClientRect(); return { top: Math.max(0, s.bottom), nav: document.getElementById("mNav").getBoundingClientRect().top }; })()`;
    // Reach a control the way a person does: scroll down from the top until it sits in the free area and nothing
    // covers its centre. Returns false if no scroll position works.
    const reach = (sel) => pg.evaluate(async ([sel, FREE]) => {
      const el = document.querySelector(sel); if (!el) return false; const raf = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      scrollTo(0, 0); await raf(); const max = document.documentElement.scrollHeight - innerHeight;
      for (let y = 0; y <= max + 24; y += 24) { scrollTo(0, Math.min(y, max)); await raf();
        const r = el.getBoundingClientRect(), f = (0, eval)(FREE);
        if (r.top >= f.top - 0.5 && r.bottom <= f.nav + 0.5 && r.height > 0) { const hit = document.elementFromPoint(r.left + Math.min(r.width / 2, 20), r.top + r.height / 2); if (hit && (hit === el || el.contains(hit) || hit.closest("label") === el.closest("label"))) return true; } }
      return false; }, [sel, FREE]);
    const tap = async (sel) => { if (!(await reach(sel))) { bad(`${name} ${W}×${H}: cannot scroll ${sel} into the free area`); await pg.evaluate(s => document.querySelector(s).click(), sel); return; }
      const bx = await pg.locator(sel).boundingBox(); await pg.mouse.click(bx.x + Math.min(bx.width / 2, 20), bx.y + bx.height / 2); };
    // every control in the open step can be reached: one sweep down the page marks each control that, at some scroll
    // position, sits in the free area with nothing covering it
    const reachAll = async (label) => { const res = await pg.evaluate(async (FREE) => {
        const raf = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        const els = [...document.querySelectorAll(".sstep.open .stbody button, .sstep.open .stbody input:not([type=hidden]), .sstep.open .stbody select, .sstep.open .stbody summary")].filter(e => e.getClientRects().length && getComputedStyle(e).visibility !== "hidden" && !(e.parentElement && e.parentElement.closest("details:not([open])") && !(e.closest("summary") && e.closest("summary").parentElement === e.parentElement.closest("details:not([open])"))));
        const ok = new Set(); scrollTo(0, 0); await raf(); const max = document.documentElement.scrollHeight - innerHeight;
        for (let y = 0; y <= max + 16; y += 16) { scrollTo(0, Math.min(y, max)); await raf(); const f = (0, eval)(FREE);
          els.forEach((el, i) => { if (ok.has(i)) return; const r = el.getBoundingClientRect(); if (r.top >= f.top - 0.5 && r.bottom <= f.nav + 0.5) { const hit = document.elementFromPoint(r.left + Math.min(r.width / 2, 20), r.top + r.height / 2); if (hit && (hit === el || el.contains(hit) || (hit.closest("label") && hit.closest("label") === el.closest("label")))) ok.add(i); } }); }
        return { n: els.length, miss: els.map((e, i) => ok.has(i) ? null : `${e.tagName.toLowerCase()}#${e.id || "?"} "${(e.textContent || e.getAttribute("aria-label") || e.name || "").trim().slice(0, 24)}" h=${Math.round(e.getBoundingClientRect().height)}`).filter(Boolean) }; }, FREE);
      checks += res.n; res.miss.forEach(m => bad(`${name} ${W}×${H} ${label}: cannot reach ${m}`));
      rows.push({ size: `${W}×${H} ${name}`, scheme, state: `${label}: controls reached`, maxScroll: "", "room at top": `${res.n - res.miss.length}/${res.n}` }); };
    // the same with Advanced open (then folded again)
    const reachAdv = async (label) => { await reachAll(label); if (!(await pg.isVisible("#advTog"))) return; await pg.evaluate(() => document.getElementById("advTog").click()); await reachAll(label + " + Advanced"); await pg.evaluate(() => document.getElementById("advTog").click()); };
    const sweep = async (label, up = false) => {
      await pg.evaluate(() => scrollTo(0, 0)); await pg.waitForTimeout(120);
      let g = await geo(), minFree = 1e9, topFree = 0, deep = null; const max = g.max, doc0 = g.stepsDoc, sq0 = g.sq.t;
      if (up) { for (let y = 0; y <= max; y += 40) { await pg.evaluate(y => scrollTo(0, y), y); await pg.evaluate(() => new Promise(r => requestAnimationFrame(r))); } }
      const ys = []; for (let y = 0; y <= max + STEP; y += STEP) ys.push(Math.min(y, max)); if (up) ys.reverse();
      for (const y of ys) {
        await pg.evaluate(y => scrollTo(0, y), y); await pg.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
        g = await geo(); checks++; const at = `${name} ${W}×${H} ${scheme} ${label} y=${g.y}`;
        if (g.sw > g.vw + 0.5) bad(`${at}: page scrolls sideways (${g.sw} > ${g.vw})`);
        // the workspace: 300 px, in its place in the page until it reaches the top of the screen, then pinned there
        if (Math.abs(g.sq.h - WS) > 0.5 || g.sq.l !== 0 || Math.abs(g.sq.r - g.vw) > 0.5) bad(`${at}: the workspace is not ${WS} px high across the screen (${g.sq.h} high, ${g.sq.l}..${g.sq.r})`);
        // the job tabs: 33 px, directly above the workspace, pinned at the top of the screen
        if (Math.abs(g.tab.h - TAB) > 0.5 || Math.abs(g.tab.b - g.sq.t) > 0.5 || g.tab.l !== 0 || Math.abs(g.tab.r - g.vw) > 0.5) bad(`${at}: the job tabs are not ${TAB} px high, across the screen, directly above the workspace (${g.tab.h} high, ${g.tab.t}..${g.tab.b}, workspace at ${g.sq.t})`);
        const want = g.nopin ? sq0 - g.y : Math.max(TAB, sq0 - g.y); if (Math.abs(g.sq.t - want) > 1) bad(`${at}: the workspace is at ${g.sq.t}, not ${want} (${g.nopin ? "not pinned" : "pinned"})`);
        // the rows keep their order under the workspace's place in the page; nothing overlaps
        if (Math.abs(g.vb.t + g.y - (sq0 + WS)) > 1) bad(`${at}: the view row is not under the workspace's place (${g.vb.t + g.y} vs ${sq0 + WS})`);
        const order = [g.vb, g.rate, g.data, g.zoom, g.scr].filter(Boolean); for (let i = 1; i < order.length; i++) if (order[i].t < order[i - 1].b - 0.5) bad(`${at}: rows overlap (${order[i].t} < ${order[i - 1].b})`);
        if (g.stepsTop < order[order.length - 1].b - 0.5) bad(`${at}: the steps start over the rows (${g.stepsTop} < ${order[order.length - 1].b})`);
        if (g.data && Math.abs(g.data.t - g.rate.b) > 1) bad(`${at}: the rating details are not under the rating row (${g.data.t} vs ${g.rate.b})`);
        if (!g.nav || Math.abs(g.nav.b - g.vh) > 1 || !g.prog || g.prog.h < 3) bad(`${at}: Back/Next bar or progress marks not at the bottom`);
        if (!g.back || !g.next || g.prog.b > g.back.t + 0.5 || g.back.r > g.next.l + 0.5 || g.next.r > g.vw + 0.5 || g.next.b > g.vh + 0.5 || g.back.h < 45 || g.next.h < 45) bad(`${at}: the bottom bar does not fit: Back ${g.back && g.back.r}, Next ${g.next && g.next.l}..${g.next && g.next.r}`);
        if (!g.nextFits) bad(`${at}: the Next label is cut off`);
        if (g.squash > 0.02) bad(`${at}: the image is squashed (${(g.squash * 100).toFixed(0)}% out of shape)`);
        if (Math.abs(g.stepsDoc - doc0) > 1) bad(`${at}: content jumped (${doc0} → ${g.stepsDoc})`);
        // the fold: the workspace, once pinned at the top, leaves at least 160 px for the rows and steps
        const free = g.vh - Math.max(0, g.sq.b) - g.nav.h; if (!g.nopin && g.sq.t < TAB + 0.5 && free < 160 - 1) bad(`${at}: only ${free} px under the pinned workspace`);
        if (g.y === 0) topFree = free; minFree = Math.min(minFree, free); deep = { free, y: g.y, nopin: g.nopin };
      }
      rows.push({ size: `${W}×${H} ${name}`, scheme, state: label, maxScroll: max, "room at top": Math.round(topFree), "room scrolled": Math.round(deep.free), "workspace pinned": !deep.nopin });
      return deep;
    };
    // 1. empty page; the title row has the title, the theme switch and the gear
    { const g = await geo(); checks++; if (g.head !== 57 || Math.abs(g.tab.t - 57) > 0.5 || Math.abs(g.sq.t - 57 - TAB) > 0.5) bad(`${name} ${W}×${H}: the title row is not 57 px with the job tabs and the workspace under it (${g.head}, tabs at ${g.tab.t}, workspace at ${g.sq.t})`);
      const fit = await pg.evaluate(() => { const words = document.createRange(); words.selectNodeContents(document.querySelector(".mhead b")); const b = words.getBoundingClientRect(), s = document.getElementById("themeSeg").getBoundingClientRect(), m = document.getElementById("mShop").getBoundingClientRect(); return b.right <= s.left + 0.5 && s.right <= m.left + 0.5 && m.right <= innerWidth && document.getElementById("themeSeg").parentElement.classList.contains("mhead"); });
      if (!fit) bad(`${name} ${W}×${H}: the title, the theme switch and the gear do not fit the title row`);
      if (g.nopin !== (H - g.nav.h - TAB - WS < 160)) bad(`${name} ${W}×${H}: pinning is wrong for this height (nopin ${g.nopin})`); }
    await sweep("empty");
    // the case from the field: no art, step 4 open, scroll to the bottom and back up
    await pg.evaluate(() => document.getElementById("step3Btn").click()); await pg.waitForTimeout(1100); await pg.click("#mNext"); await pg.waitForTimeout(1100); await sweep("empty · step 4, scrolling up", true);
    await pg.evaluate(() => document.getElementById("step1Btn").click()); await pg.waitForTimeout(1100);
    await reachAdv("step 1, empty");
    // 2. sample loaded (step 2 open)
    await tap("#trySample");
    await pg.waitForFunction(() => /Updated|failed/.test(document.getElementById("status").textContent), null, { timeout: 240000 }); await pg.waitForTimeout(1200);
    await sweep("art · Print"); await reachAdv("step 2");
    await sweep("art · Print, scrolling up", true);
    // 3. steps: Next/Back puts each step's title under the pinned workspace and above the bar
    await pg.evaluate(() => scrollTo(0, 0)); await pg.waitForTimeout(150);
    for (const [btn, n] of /** @type {[string, number][]} */ ([["#mNext", 3], ["#mNext", 4], ["#mBack", 3], ["#mBack", 2], ["#mBack", 1]])) {
      await pg.click(btn); await pg.waitForTimeout(1100);
      if (btn === "#mNext") { await reachAdv(`step ${n}`); await pg.evaluate(() => scrollTo(0, 0)); await pg.evaluate(n => document.getElementById(`step${n - 1}Btn`).click(), n); await pg.waitForTimeout(1100); await pg.click("#mNext"); await pg.waitForTimeout(1100); }
      const g = await geo(), r = await pg.evaluate(n => { const b = document.getElementById(`step${n}`).getBoundingClientRect(); return { t: b.top, h: b.height }; }, n); checks++;
      const lowest = Math.max(g.sq.b, 0), navTop = g.nav.t;
      if (r.t < lowest - 1 || r.t + 40 > navTop || (!g.nopin && Math.abs(g.sq.h - WS) > 0.5)) bad(`${name} ${W}×${H}: ${btn} to step ${n}: step top at ${r.t.toFixed(0)} (workspace ends at ${lowest.toFixed(0)}, bar at ${navTop.toFixed(0)})`);
      // a step that fits between the pinned workspace and the bar is shown whole
      if (!g.nopin && r.h <= navTop - WS - 18 && r.t + r.h > navTop + 1) bad(`${name} ${W}×${H}: ${btn} to step ${n}: the step (${Math.round(r.h)} px) could fit above the bar but ends at ${Math.round(r.t + r.h)} (bar at ${Math.round(navTop)})`);
    }
    // 4. Compare, then 5. rating open (its details in the flow)
    await pg.evaluate(() => { scrollTo(0, 0); /** @type {HTMLElement} */ (document.querySelector("#view button[data-v=cmp]")).click(); }); await pg.waitForTimeout(1500); await sweep("art · Compare");
    await pg.evaluate(() => { scrollTo(0, 0); /** @type {HTMLElement} */ (document.querySelector("#view button[data-v=film]")).click(); document.getElementById("dRate").click(); }); await pg.waitForTimeout(600);
    { const g = await geo(); checks++; if (!g.data || g.data.h < 30) bad(`${name} ${W}×${H}: the rating details did not open`); }
    await sweep("art · rating open");
    if (errs.length) bad(`${name} ${W}×${H}: console errors: ${errs.join(" | ")}`);
    await pg.screenshot({ path: path.join(shots, `stress-${W}x${H}-${scheme}.png`) }); await ctx.close();
  }
  console.table(rows); console.log(`${checks} checks, ${fails} failed`); await b.close(); process.exit(fails ? 1 : 0);
})();
