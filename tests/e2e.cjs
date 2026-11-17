// Browser end-to-end check: page loads, each separation type runs, export ZIP has the expected films, no console errors.
//   npm start (in another shell), then: node tests/e2e.cjs [http://127.0.0.1:8369/] [--part K]
// --part K (1 to 4) runs one of four parts of about equal length; CI runs the four at the same time. No flag: everything.
const { chromium } = require("playwright"), fs = require("fs"), path = require("path"), os = require("os");
const JSZip = require(path.join(__dirname, "../.cache/node_modules/jszip"));
(async () => {
  // later: the page with the groups marked data-later shown (?later=1). The checks that drive one of them (profiles, DCS, dot
  // shape, press time, re-proof, report, units, test films, job list, Press and Stack views) run on it; the page a
  // person gets is checked without it (the phone pages below, and "v1 surface" at the end).
  const argv = process.argv.slice(2), pi = argv.indexOf("--part"), part = pi < 0 ? 0 : +argv.splice(pi, 2)[1];
  if (![0, 1, 2, 3, 4].includes(part)) { console.error("--part takes 1, 2, 3 or 4"); process.exit(2); }
  const url = argv[0] || "http://127.0.0.1:8369/", later = url + "?later=1", b = await chromium.launch(); let pg;
  const errors = [];
  let fails = 0; const ok = (c, msg) => { console.log((c ? "ok   " : "FAIL ") + msg); if (!c) fails++; };
  const done = async () => { await pg.waitForTimeout(250); await pg.waitForFunction(() => /Updated|failed/.test(document.getElementById("status").textContent), null, { timeout: 180000 }); return pg.textContent("#status"); };
  const openStep = async n => { if (await pg.isHidden(`#step${n}Body`)) await pg.click(`#step${n}Btn`); };
  const cardNames = () => pg.$$eval("#scrList .scard .sn", e => e.map(x => x.textContent).join("/"));
  // each stretch of the main sequence starts on its own fresh page: open() is the empty page, sample() adds the sample
  // design, separated, with Auto done
  const open = async () => { if (pg) await pg.close(); pg = await b.newPage({ viewport: { width: 1440, height: 1200 }, acceptDownloads: true });
    pg.on("pageerror", e => errors.push(e.message)); pg.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await pg.goto(later); await pg.waitForTimeout(500); };
  const autoDone = () => pg.waitForFunction(() => document.getElementById("auto").textContent === "✓ Auto" && !document.getElementById("run").disabled && /Updated/.test(document.getElementById("status").textContent), null, { timeout: 180000 });
  const sample = async () => { await open(); await pg.click("#trySample"); await autoDone(); };
  // the first run: steps, cards, Auto, Default and manual, help
  const basics = async () => { await open();
  ok(await pg.isVisible("#drop") && !(await pg.isHidden("#step1Body")) && /No art yet/.test(await pg.textContent("#rWhy")), "starts empty: the workspace is the drop area, step 1 is open, no rating yet");
  ok(await pg.evaluate(() => [1, 2, 3, 4].map(n => document.getElementById(`sth${n}`).textContent).join(" | ")) === "Artwork | Garment / press | Separation | Export", "four step rows, each number shown once (in the badge)");
  await pg.click("#trySample"); ok(/Updated/.test(await done()), "the sample design separates");
  ok(!/cannot reach/.test(await pg.textContent("#preflight")), "the sample design is inside the shelf's gamut: no out-of-gamut check");
  { const ids = await pg.evaluate(() => [...document.querySelectorAll("#preflight .ck")].map(c => /** @type {HTMLElement} */ (c).dataset.check));
    ok(!ids.some(i => /^(too-large|off-centre|fine-line|reverse-gap)/.test(i)), `the sample design fits the standard platen, film and screen, is centred, and has no thin lines or closing gaps (${ids.join(" ") || "no checks"})`); }
  ok(/^Cream line work .* prints as solid White/.test(await pg.textContent("#lineText")) && /Add a Cream screen/.test(await pg.textContent("#lineAdd")), "the sample's cream line work is offered its own screen");
  ok(!(await pg.isHidden("#step2Body")) && await pg.textContent("#step1Badge") === "✓" && await pg.textContent("#sth1") === "1 Artwork" && await pg.isHidden("#drop"), "step 1 is done (✓, number in the title) and step 2 opens");
  ok(/^\d\.\d$/.test(await pg.textContent("#rStars")) && /ΔE/.test(await pg.textContent("#rFacts")), `print rating shown: ${await pg.textContent("#rStars")} stars`);
  ok(/^· model · \d+\.\d ΔE on press$/.test(await pg.textContent("#mrDe")) && /a model number/.test(await pg.getAttribute("#dRate", "aria-label") || ""), "the rating says the score is a model number (phone chip text, desktop row label)");
  ok(/Black · 11 × [\d.]+ in · 100% cotton · 45 LPI · Manual/.test(await pg.textContent("#step2Sum")), `steps carry a summary (${await pg.textContent("#step2Sum")})`);
  ok(/Very close match|Small differences|Large differences/.test(await pg.textContent("#verdictWord")), `plain-language verdict shown: "${(await pg.textContent("#verdictWord")).trim()}"`);
  // simple flow: shirt chip and screen stepper re-separate
  await pg.click('#shirtChips button[data-hex="#ffffff"]');
  { let shown = ""; try { await pg.waitForFunction(() => !document.getElementById("busyMask").hidden, null, { timeout: 5000 }); shown = await pg.textContent("#busyText"); } catch {}
    const logo = await pg.evaluate(() => { const i = document.querySelector("#busyLogo img, #busyLogo video"); return !!i && (i.tagName === "VIDEO" || i.naturalWidth > 0); });
    ok(/Separating|Auto/.test(shown) && logo, `a loading mask with the ADN logo covers the image while it separates ("${shown}")`); }
  ok(/Updated/.test(await done()), "white shirt chip separates");
  // a step 2 change re-runs Auto, so a second pass may follow the first: wait for the mask to clear
  ok(await pg.waitForFunction(() => document.getElementById("busyMask").hidden, null, { timeout: 180000 }).then(() => true, () => false), "the loading mask goes away when the separation is done");
  ok(await pg.evaluate(() => document.getElementById("garment").value) === "#ffffff", "chip sets the shirt color");
  ok(await pg.evaluate(() => getComputedStyle(document.querySelector(".canvasbox")).backgroundColor) === "rgb(255, 255, 255)", "preview backdrop follows the garment color");
  await openStep(3);
  ok(await pg.textContent("#auto") === "✓ Auto" && await pg.getAttribute("#auto", "aria-pressed") === "true" && await pg.evaluate(() => { const a = document.getElementById("auto").getBoundingClientRect(), n = document.getElementById("nInks").getBoundingClientRect(), r = document.getElementById("run").getBoundingClientRect(), b = document.getElementById("step3Body").getBoundingClientRect(); return Math.abs(a.top - n.top) < 4 && r.top > a.bottom && r.width > b.width * 0.85; }), "Auto sits beside Color screens and shows ✓ Auto while its choices are in use; Separate is full width under them");
  { const n0 = +(await pg.inputValue("#nInks")); await pg.click("#inkMinus"); ok(/Updated/.test(await done()) && +(await pg.inputValue("#nInks")) === n0 - 1, `screen stepper lowers the count (${n0} → ${n0 - 1}) and separates`); }
  ok(await pg.textContent("#auto") === "Auto" && await pg.getAttribute("#auto", "aria-pressed") === "false", "changing the screen count turns Auto off");
  await openStep(2); await pg.click('#shirtChips button[data-hex="#111111"]'); await done(); await openStep(3); await pg.click("#inkPlus"); await done();
  // layout rules: no ? next to an action button; the result box is labeled lines; the art card shows what is loaded
  ok(await pg.evaluate(() => [...document.querySelectorAll("button.q")].every(q => !q.closest("button:not(.q)") && !(q.previousElementSibling && q.previousElementSibling.matches("button:not(.q)")))), "no ? button sits next to an action button");
  ok(await pg.evaluate(() => [...document.querySelectorAll("#verdictText dt")].map(d => d.textContent)).then(k => k[0] === "Score" && k.length >= 3), "result box shows labeled lines starting with Score");
  ok(await pg.textContent("#artName") === "Sample design" && await pg.isHidden("#drop"), "the art card names the sample design and the drop area is gone");
  // help: every data-help element has a "?" button; it opens a note in place, and the panel search finds answers
  const nq = await pg.evaluate(() => [document.querySelectorAll("[data-help]").length, document.querySelectorAll("button.q").length]);
  ok(nq[0] > 30 && nq[0] === nq[1], `every marked control has a ? button (${nq[1]})`);
  await openStep(2); await pg.click('[data-help="lpi"] .q'); ok(await pg.isVisible("#tipPop") && /lines per inch/i.test(await pg.textContent("#tipPop")), "? next to LPI opens a tooltip");
  ok(await pg.evaluate(() => { const r = document.getElementById("tipPop").getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; }), "tooltip stays on screen");
  await pg.click("h1"); ok(!(await pg.isVisible("#tipPop")), "clicking elsewhere closes it");
  await openStep(3); await pg.click('[data-help="palSrc"] .q'); ok(await pg.isVisible("#tipPop"), "? on an Advanced setting opens its note");
  await pg.keyboard.press("Escape"); ok(!(await pg.isVisible("#tipPop")), "Escape closes the tooltip");
  ok(await pg.evaluate(() => !!document.querySelector('[data-auto="3"]') && !!document.querySelector('[data-def="3"]') && !!document.querySelector('[data-auto="2"]') && !document.getElementById("fine") && !document.getElementById("selCard") && !document.getElementById("inks") && !document.getElementById("chanBox") && !document.getElementById("order")), "Advanced is settings only, with Auto and Default (no Fine-tune, no ink list, no screen card, no chip row, no press table)");
  // the color cards: one per screen, filled with its ink; a card opens its film in Print; the eye hides a screen; lock; drag
  const rows = await pg.$$eval("#scrList .scard", r => r.length);
  ok(rows >= 3 && rows === await pg.evaluate(() => document.querySelectorAll("#scrList [data-pick]").length) && await pg.evaluate(() => { const c = document.querySelector("#scrList .scard:nth-child(2)"); return getComputedStyle(c).backgroundColor !== "rgb(255, 255, 255)" && /THEN|MESH|%/i.test(c.textContent); }), `${rows} color cards, filled with their ink, with the text on the color`);
  ok(await pg.evaluate(() => !/wet|then flash|then cure/i.test(document.getElementById("scrList").textContent)), "the cards carry no flash / cure / wet on wet labels (flash and cure go on the films)");
  await pg.click("#scrList .scard:nth-child(2) .cpick"); await pg.waitForTimeout(800);
  ok(await pg.getAttribute('#view button[data-v=film]', "aria-pressed") === "true" && await pg.evaluate(() => document.querySelector("#scrList .scard:nth-child(2)").classList.contains("cur")), "tapping a card opens its film in Print");
  await pg.click("#scrList .scard:nth-child(2) .cpick"); await pg.waitForTimeout(800);
  ok(await pg.evaluate(() => !document.querySelector("#scrList .scard.cur")), "tapping the open card again folds it and Print shows all the films");
  await pg.click("#scrList .scard:nth-child(2) [data-lock]"); ok(await pg.getAttribute("#scrList .scard:nth-child(2) [data-lock]", "aria-pressed") === "true", "the lock keeps an ink");
  await pg.click("#scrList .scard:nth-child(2) [data-lock]");
  { const n0 = await cardNames(), g = await pg.locator("#scrList .scard:nth-child(2) .grip").boundingBox(), t = await pg.locator("#scrList .scard:nth-child(5)").boundingBox();
    await pg.mouse.move(g.x + g.width / 2, g.y + g.height / 2); await pg.mouse.down(); await pg.mouse.move(t.x + t.width * 0.75, t.y + t.height / 2, { steps: 8 });
    const slot = await pg.evaluate(() => !!document.querySelector("#scrList .slot") && !!document.querySelector("#scrList .lift")); await pg.mouse.up(); await done(); const n1 = await cardNames();
    const a = n0.split("/"), b2 = n1.split("/");
    ok(slot && b2[0] === a[0] && b2[1] === a[2] && b2.indexOf(a[1]) > 1, `dragging a card by its grip moves it later in the print order (${n0} → ${n1})`);
    await pg.focus(`#scrList .scard:nth-child(${b2.indexOf(a[1]) + 1}) .grip`); await pg.keyboard.press("ArrowUp"); await done(); const n2 = await cardNames();
    ok(n2.split("/").indexOf(a[1]) === b2.indexOf(a[1]) - 1, `the arrow keys on a grip move it too (${n2})`);
    ok(await pg.textContent("#auto") === "Auto", "changing the print order turns Auto off"); }
  // Print toggles and keys
  await pg.click('#view button[data-v=cmp]'); await pg.waitForTimeout(300); ok(/Drag the line/.test(await pg.textContent("#viewNote")), "Compare with art shows the before/after line");
  { const bx = await pg.locator("#view0").boundingBox(); await pg.mouse.click(bx.x + bx.width * 0.25, bx.y + bx.height / 2); }
  await pg.check("#diffT"); await pg.waitForTimeout(300); ok(/Bright areas/.test(await pg.textContent("#viewNote")) && await pg.getAttribute('#view button[data-v=cmp]', "aria-pressed") === "true", "Differences draws the difference map in Compare");
  await pg.uncheck("#diffT"); await pg.click("h1");
  await pg.keyboard.press("3"); ok(await pg.getAttribute('#view button[data-v=film]', "aria-pressed") === "true" && !(await pg.isHidden("#step3Body")), "key 3 opens Print (the films), and step 3 with its cards");
  await pg.keyboard.press("2"); ok(await pg.getAttribute('#view button[data-v=cmp]', "aria-pressed") === "true", "key 2 opens Compare");
  ok(await pg.evaluate(() => [...document.querySelectorAll("#view button")].map(b => b.textContent).join("|")) === "Art|Compare|Print|Press|Stack", "views are Art, Compare, Print, Press, Stack");
  // Auto: picks art type and screen count, says why
  // the reasoning sits behind [+] on the Updated notice
  await pg.click("#auto"); await pg.waitForFunction(() => !document.getElementById("awTog").hidden, null, { timeout: 180000 }); await done();
  { const note = await pg.textContent("#autoNote"), n = (note.match(/(\d+) screens?\./) || [])[1], k = await pg.inputValue("#nInks");
    ok(n === k, `Auto's note states the screen count it set (${n} in the note, ${k} set)${/Then Auto added screen/.test(note) ? ", including an accent screen it added" : ""}`); }
  const autoMode = await pg.evaluate(() => document.querySelector("#mode button[aria-pressed=true]").dataset.v);
  await pg.click("#awTog"); await pg.waitForTimeout(300);
  const autoTxt = await pg.evaluate(() => { const b = document.getElementById("awBody"); return b.hidden ? "" : b.textContent; });
  ok(["sim", "spot"].includes(autoMode) && /✓/.test(autoTxt) && await pg.getAttribute("#awTog", "aria-expanded") === "true", `Auto picks the art type (${autoMode}) and [+] on the notice shows its reasoning`);
  await pg.click("#awTog");
  ok(await pg.evaluate(() => [document.getElementById("auto"), ...document.querySelectorAll("[data-auto]")].every(b => b.textContent === "✓ Auto" && b.classList.contains("on"))), "after Auto every Auto button is green (Color screens, step 2 and step 3)");
  // Fewer screens: Auto's note lists what fewer screens rate (from its own trials), one tap each, and a tap back to Auto
  { await openStep(3);
    const info = await pg.evaluate(() => { const n = document.getElementById("fewerNote"), b = [...document.querySelectorAll("#fewerBtns button")];
      return { shown: !n.hidden, text: document.getElementById("fewerText").textContent, btns: b.map(x => x.getAttribute("aria-label") || x.textContent), screens: +document.getElementById("sScreens").textContent }; });
    ok(info.shown && info.btns.length >= 1 && info.btns.every(t => /^\d+ screens, \d\.\d stars · error \d+\.\d$/.test(t)) && new RegExp(`Auto('s| picked) ${info.screens} screens`).test(info.text) && info.btns.every(t => +t.split(" ")[0] < info.screens),
      `Auto's note lists fewer screens with their rating (${info.btns.join(", ")}; Auto ${info.screens})`);
    const want = +info.btns[0].split(" ")[0]; await pg.click("#fewerBtns button >> nth=0"); await done();
    const after = await pg.evaluate(() => ({ screens: +document.getElementById("sScreens").textContent, k: +document.getElementById("nInks").value, auto: document.getElementById("auto").textContent, shown: !document.getElementById("fewerNote").hidden,
      pressed: document.querySelector("#fewerBtns button[aria-pressed=true]")?.dataset.screens, back: [...document.querySelectorAll("#fewerBtns button")].some(b => b.dataset.screens === "auto"), text: document.getElementById("fewerText").textContent }));
    ok(after.screens <= want && after.auto === "Auto" && after.shown && after.pressed === String(want) && after.back && /You picked/.test(after.text), `one tap separates with ${want} screens (${after.screens} printed, ${after.k} colors), Auto turns off and the note offers Auto's ${info.screens} back`);
    await pg.click('#fewerBtns button[data-screens="auto"]'); await pg.waitForFunction(() => document.getElementById("auto").textContent === "✓ Auto", null, { timeout: 60000 }).catch(() => {}); await done();
    ok(await pg.evaluate(() => +document.getElementById("sScreens").textContent) === info.screens && await pg.textContent("#auto") === "✓ Auto" && !(await pg.isHidden("#fewerNote")) && !(await pg.evaluate(() => !!document.querySelector("#fewerBtns button[aria-pressed=true]"))), "Auto's pick comes back in one tap and Auto is on again");
    await pg.click("#inkPlus"); await done(); ok(await pg.isHidden("#fewerNote"), "a screen count set with the stepper hides the list (its ratings were for Auto's inks)");
    await pg.click("#inkMinus"); await done(); }
  // Default and manual: Default sets the standard values; changing a setting by hand turns every Auto off
  await openStep(3); await pg.evaluate(() => document.querySelector('[data-def="3"]').click()); await done();
  ok(await pg.evaluate(() => document.querySelectorAll(".atag.default").length >= 5 && [document.getElementById("auto"), ...document.querySelectorAll("[data-auto]")].every(b => b.textContent === "Auto")), "Default sets the standard values, tags them Default, and turns Auto off");
  await pg.evaluate(() => document.querySelector('[data-auto="3"]').click()); await pg.waitForTimeout(500); await done(); await pg.waitForTimeout(300);
  ok(await pg.textContent("#auto") === "✓ Auto" && await pg.evaluate(() => !document.querySelector(".atag.default, .atag.manual")), "the Auto button in Advanced runs Auto again");
  await pg.evaluate(() => { const s = document.getElementById("rare"); s.value = "0.002"; s.dispatchEvent(new Event("input")); s.dispatchEvent(new Event("change")); }); await done();
  ok(await pg.textContent("#auto") === "Auto" && await pg.evaluate(() => document.querySelector("label[for=rare] .atag").textContent === "Manual"), "changing an Advanced setting tags it Manual and turns every Auto off");
  await pg.click("#run"); await done(); ok(await pg.textContent("#auto") === "Auto", "Separate keeps the manual setting");
  await pg.evaluate(() => document.querySelector('[data-auto="2"]').click()); await pg.waitForTimeout(500); await done(); await pg.waitForTimeout(300);
  await pg.click("#helpOpen"); await pg.fill("#helpQ", "mesh"); const hits = await pg.evaluate(() => [...document.querySelectorAll("#helpList .hitem")].filter(d => !d.hidden).length);
  ok(hits >= 2 && await pg.isVisible("#helpPanel"), `help search for "mesh" finds ${hits} answers`);
  { const href = await pg.evaluate(() => /** @type {HTMLAnchorElement} */ (document.getElementById("helpChanges")).href), r = await pg.request.get(href), body = await r.text();
    ok(r.ok() && /^# Changelog/.test(body) && /Separation Table version \d+\.\d+\.\d+/.test(await pg.textContent("#helpVersion")), "Help: the version, and Changelog opens the changelog"); }
  await pg.fill("#helpQ", "zzqx"); ok(await pg.isVisible("#helpNone"), "help search says when nothing matches");
  await pg.fill("#helpQ", ""); await pg.keyboard.press("Escape"); ok(!(await pg.isVisible("#helpPanel")), "Escape closes help");
  ok(await pg.evaluate(() => { const p = document.getElementById("preflight"), c = p.querySelectorAll(".ck").length, t = document.getElementById("mrChk").textContent; return c ? !p.hidden && /(Error|Warning|Note) ·/.test(p.textContent) && t === `! ${c} CHECK${c > 1 ? "S" : ""}` : p.hidden && t === "✓ CHECKS"; }), "the pre-print checks show as cards, and the rating line counts them");
  };
  // separation types, print methods, Inspect
  const inspect = async () => { await sample();
  await openStep(3); await pg.evaluate(() => document.querySelectorAll(".pane details").forEach(d => { d.open = true; })); // fine-tune controls
  for (const mode of ["spot", "index", "sim"]) { await pg.click(`#mode button[data-v=${mode}]`); ok(/Updated/.test(await done()), `${mode} separation runs`); }
  // Print method: CMYK and 1–3 colors set their own inks, screen count and standard angles
  { const cards = () => pg.$$eval("#scrList .scard", c => c.map(x => ({ n: x.querySelector(".sn").textContent.trim(), l: x.querySelector(".sl").textContent }))), k0 = await pg.inputValue("#nInks");
    await pg.click("#mode button[data-v=cmyk]"); await done(); let c = await cards();
    ok(c.filter(x => /^Process /.test(x.n)).length === 4 && ["Yellow", "Magenta", "Cyan", "Black"].every((k, i) => c.filter(x => /^Process /.test(x.n))[i].n.includes(k)) && await pg.isDisabled("#nInks"),
      `CMYK: four process screens in Y, M, C, K order, screen count locked (${c.map(x => x.n).join(" / ")})`);
    ok(["Yellow 0°", "Magenta 75°", "Cyan 15°", "Black 45°"].every(t => { const [k, a] = t.split(" "); const x = c.find(y => y.n.includes(k)); return x && x.l.includes(a); }), `CMYK screens carry the standard angles (${c.filter(x => /^Process /.test(x.n)).map(x => x.n.replace("Process ", "") + " " + (x.l.match(/\d+(\.\d+)?°/) || [""])[0]).join(", ")})`);
    await pg.click("#mode button[data-v=tone]"); await done(); c = await cards();
    ok(await pg.isVisible("#tonePick") && c.filter(x => !/underbase/i.test(x.n)).length === 2 && c.filter(x => !/underbase/i.test(x.n)).every(x => /45°|75°/.test(x.l)), `Duotone: two inks at 45° and 75° (${c.map(x => x.n + " " + (x.l.match(/\d+°/) || [""])[0]).join(", ")})`);
    await pg.click('#tonePick button[data-n="1"]'); await done(); c = await cards();
    const dark = await pg.evaluate(() => document.getElementById("garment").value.toLowerCase() === "#111111");
    ok(c.length === 1 && (!dark || /white/i.test(c[0].n)), `Grayscale: one screen${dark ? ", white on the black shirt, no underbase" : ""} (${c.map(x => x.n).join(", ")})`);
    await pg.click("#mode button[data-v=sim]"); await done(); ok(!(await pg.isDisabled("#nInks")) && await pg.isHidden("#tonePick") && await pg.inputValue("#nInks") === k0, `back to Simulated process: the screen count is free again and back to ${k0}`); }
  // Inspect: real films under zoom; single screens show ink and open film on every separation type, All shows the print
  const inkFrac = () => pg.evaluate(() => { const c = document.getElementById("view0"), d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let k = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 128 && d[i + 1] < 128 && d[i + 2] < 128) k++; return k / (d.length / 4); });
  // a redraw can outlast a fixed wait on a loaded machine: then wait for the busy cover (shown after 200 ms) to go
  const settle = async () => { await pg.waitForTimeout(1800); await pg.waitForFunction(() => document.getElementById("busyMask").hidden, null, { timeout: 120000 }); await pg.waitForTimeout(200); };
  const setZoom = z => pg.evaluate(z => { const s = document.getElementById("zoomSlider"); s.value = String(Math.log2(z)); s.dispatchEvent(new Event("input", { bubbles: true })); }, z);
  await pg.click('#view button[data-v=film]'); await settle(); ok(await pg.textContent("#zoomPct") === "Fit", "Inspect opens at Fit");
  for (const mode of ["index", "spot", "sim"]) { await pg.click(`#mode button[data-v=${mode}]`); await done(); await pg.click('#view button[data-v=film]'); await setZoom(1);
    if (!(await pg.evaluate(() => document.querySelector("#scrList .scard:nth-child(3)").classList.contains("cur")))) await pg.click("#scrList .scard:nth-child(3) .cpick"); await settle(); const ink = await inkFrac();
    ok(ink > 0.03 && ink < 0.97, `Inspect ${mode}: one screen's film shows ink and open film (${(ink * 100).toFixed(0)}% ink)`); }
  await pg.click("#scrList .scard:nth-child(3) .cpick"); await settle(); // tap the open card again: all films
  const colorful = await pg.evaluate(() => { const c = document.getElementById("view0"), d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data, seen = new Set(); for (let i = 0; i < d.length; i += 16) seen.add((d[i] >> 5) * 64 + (d[i + 1] >> 5) * 8 + (d[i + 2] >> 5)); return seen.size; });
  // at 100% one patch can hold a single ink (dots of one color on the shirt): no ink model mixes them into new colors
  ok(colorful >= 2, `Inspect All at 100% shows ink dots on the garment (${colorful} color groups)`);
  await pg.click("#zStep"); await settle();
  const colorfulFit = await pg.evaluate(() => { const c = document.getElementById("view0"), d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data, seen = new Set(); for (let i = 0; i < d.length; i += 16) seen.add((d[i] >> 5) * 64 + (d[i + 1] >> 5) * 8 + (d[i + 2] >> 5)); return seen.size; });
  ok(colorfulFit >= 4, `Inspect All at Fit stacks every screen's dots in color (${colorfulFit} color groups)`);
  await setZoom(1); await settle();
  const before = await pg.textContent("#inspWhere"), cvBox = await pg.locator("#view0").boundingBox();
  await pg.mouse.move(cvBox.x + 200, cvBox.y + 200); await pg.mouse.down(); await pg.mouse.move(cvBox.x + 80, cvBox.y + 120, { steps: 5 }); await pg.mouse.up(); await settle();
  ok(await pg.evaluate(() => document.getElementById("view0").style.transform === ""), "dragging moves the inspected area and re-renders it");
  { // under 100% the same spot of the design must draw the same pixels after a pan (the picture must not reshuffle)
    const grab = () => pg.evaluate(() => { const c = document.getElementById("view0"); return { w: c.width, h: c.height, d: Array.from(c.getContext("2d").getImageData(0, 0, c.width, c.height).data) }; });
    // the drag must start on the picture: a long side panel (an open note, open details) can scroll it off the top
    await setZoom(0.45); await settle(); await pg.locator("#view0").scrollIntoViewIfNeeded(); const A = await grab(), bx = await pg.locator("#view0").boundingBox();
    await pg.mouse.move(bx.x + 300, bx.y + 250); await pg.mouse.down(); await pg.mouse.move(bx.x + 230, bx.y + 205, { steps: 4 }); await pg.mouse.up(); await settle(); const B = await grab();
    // a coarse pass first (every 4th point of the full pass's grid, so it is a subset): an offset the full pass can
    // accept (99.99% the same) has under 0.2% misses here, so one with over 1% is dropped early. The full pass on
    // every offset took 6 of the run's 19 minutes.
    const cap = Math.ceil(A.h / 12) * Math.ceil(A.w / 12) * 0.01 + 1;
    let best = null; for (let dy = -120; dy <= 120; dy++) for (let dx = -160; dx <= 160; dx++) { if (!dx && !dy) continue; let same = 0, n = 0, miss = 0;
      scan: for (let y = Math.max(0, -dy); y < Math.min(A.h, B.h - dy); y += 12) for (let x = Math.max(0, -dx); x < Math.min(A.w, B.w - dx); x += 12) { const i = (y * A.w + x) * 4, j = ((y + dy) * B.w + x + dx) * 4;
        if ((A.d[i] !== B.d[j] || A.d[i + 1] !== B.d[j + 1] || A.d[i + 2] !== B.d[j + 2]) && ++miss > cap) break scan; }
      if (miss > cap) continue;
      for (let y = Math.max(0, -dy); y < Math.min(A.h, B.h - dy); y += 3) for (let x = Math.max(0, -dx); x < Math.min(A.w, B.w - dx); x += 3) { const i = (y * A.w + x) * 4, j = ((y + dy) * B.w + x + dx) * 4; n++; if (A.d[i] === B.d[j] && A.d[i + 1] === B.d[j + 1] && A.d[i + 2] === B.d[j + 2]) same++; }
      if (n > 2000 && (!best || same / n > best.f)) best = { dx, dy, f: same / n }; }
    ok(best && best.f >= 0.9999, `Inspect panning under 100% keeps the same pixels for the same spot (best match ${best ? (best.f * 100).toFixed(1) + "% at " + best.dx + "," + best.dy : "none"})`);
    await setZoom(1); await settle(); }
  { await pg.locator("#view0").scrollIntoViewIfNeeded(); const bx = await pg.locator("#view0").boundingBox(); await pg.mouse.move(bx.x + bx.width / 2, bx.y + bx.height / 2); await pg.keyboard.down("Control"); await pg.mouse.wheel(0, -200); await pg.keyboard.up("Control"); await pg.waitForTimeout(300); await settle();
    ok(await pg.textContent("#zoomPct") === "200%", "Ctrl + scroll doubles the zoom at the pointer");
  }
  await setZoom(4); await settle(); ok(await pg.textContent("#zoomPct") === "400%" && /in of film/.test(await pg.textContent("#inspWhere")), "the slider sets 400% and the percent shows on its right");
  await setZoom(0.75); await settle(); ok(await pg.textContent("#zoomPct") === "75%", "the slider zooms to values between the old steps (75%)");
  await setZoom(8); await settle(); ok(await pg.textContent("#zoomPct") === "800%", "the slider reaches 800%");
  ok(await pg.evaluate(() => [...document.querySelectorAll("#zoomSteps button")].map(b => b.textContent.trim()).join("|") === "Fit|100%" && document.getElementById("zoomSlider").getBoundingClientRect().width > document.getElementById("zoomSteps").getBoundingClientRect().width * 0.5), "the zoom line is FIT, the slider (most of it) and 100%");
  { const sl = await pg.locator("#zoomSlider").boundingBox(); await pg.mouse.move(sl.x + sl.width * 0.3, sl.y + sl.height / 2); await pg.mouse.down(); await pg.mouse.move(sl.x + sl.width * 0.5, sl.y + sl.height / 2, { steps: 5 });
    const tip = await pg.evaluate(() => { const t = document.getElementById("zoomPct"), r = t.getBoundingClientRect(), s = document.getElementById("zoomSlider").getBoundingClientRect(); return { on: t.classList.contains("on") && getComputedStyle(t).opacity !== "0", above: r.bottom <= s.top, txt: t.textContent }; });
    await pg.mouse.up(); await settle(); ok(tip.on && tip.above && /%$/.test(tip.txt), `dragging shows the percent in a bubble above the slider (${tip.txt})`); }
  // under 100% Inspect still shows the dots (the separation), not the smooth print preview: neighbouring pixels differ much more
  const texture = () => pg.evaluate(() => { const c = document.getElementById("view0"), g = c.getContext("2d"), s = Math.min(120, c.width >> 1, c.height >> 1), d = g.getImageData((c.width - s) >> 1, (c.height - s) >> 1, s, s).data; let t = 0, n = 0;
    for (let y = 0; y < s; y++) for (let x = 1; x < s; x++) { const q = (y * s + x) * 4, p = q - 4; t += Math.abs(d[q] - d[p]) + Math.abs(d[q + 1] - d[p + 1]) + Math.abs(d[q + 2] - d[p + 2]); n++; } return t / n; });
  await setZoom(0.3); await settle(); const tex30 = await texture();
  await pg.click('#view button[data-v=orig]'); await pg.waitForTimeout(400); const texPrint = await texture(); await pg.click('#view button[data-v=film]'); await settle(); await setZoom(0.3); await settle();
  ok(await pg.textContent("#zoomPct") === "30%" && /drawn smaller/.test(await pg.textContent("#inspWhere")) && tex30 > texPrint * 1.5, `under 50% Print still shows the dots, not smooth art (texture ${tex30.toFixed(1)} vs Art ${texPrint.toFixed(1)})`);
  await pg.click("#z100"); await settle(); ok(await pg.textContent("#zoomPct") === "100%", "100% goes to 100%");
  await pg.click("#zStep"); await settle(); ok(await pg.textContent("#zoomPct") === "Fit" && /Full design/.test(await pg.textContent("#inspWhere")), "FIT only fits");
  { const bx = await pg.locator("#view0").boundingBox(); await pg.mouse.click(bx.x + bx.width / 2, bx.y + bx.height / 2); await settle(); const z1 = await pg.textContent("#zoomPct");
    ok(/^\d+%$/.test(z1), `a tap on the image at Fit zooms in a quarter of the range (Fit → ${z1})`); await pg.click("#zStep"); await settle(); }
  ok(await pg.evaluate(() => { const c = document.getElementById("view0").getBoundingClientRect(), b = document.querySelector(".canvasbox").getBoundingClientRect(); return c.width <= b.width + 1 && c.height <= b.height + 1; }), "Fit fits inside the image box");
  ok(await pg.evaluate(() => document.getElementById("zoomBox").getBoundingClientRect().top >= document.querySelector(".canvasbox").getBoundingClientRect().bottom - 1), "zoom controls sit under the image");
  await pg.click('#view button[data-v=cmp]');
  const tiles = await pg.evaluate(() => [sScreens.textContent, sMean.textContent, sNeutral.textContent].map(Number));
  ok(tiles.every(v => Number.isFinite(v)), `stat tiles are numbers (${tiles.join(", ")})`);
  };
  // export, shop production, re-proof, problem report, timing log, calibration, profiles, sizes, then uploads, Adjust,
  // layout and out of gamut. One stretch: the later checks need the test calibration made here. They also need
  // Simulated process picked by hand (Auto then keeps it for the art uploaded later), as the stretch before leaves it.
  const exportAndShop = async () => { await sample(); await openStep(3); await pg.evaluate(() => document.querySelectorAll(".pane details").forEach(d => { d.open = true; }));
    await pg.click("#mode button[data-v=sim]"); await pg.waitForTimeout(500); await autoDone();
  await openStep(2); await pg.fill("#dpi", "200"); await pg.fill("#outW", "6");
  { const y1 = (await pg.locator("#step4Btn").boundingBox()).y; await pg.locator("#outW").blur(); await pg.waitForTimeout(100); const y2 = (await pg.locator("#step4Btn").boundingBox()).y;
    ok(Math.abs(y1 - y2) < 1, `the step rows stay in place while the separation updates (moved ${Math.round(y2 - y1)} px)`); }
  await done(); await openStep(4); ok(await pg.isVisible("#export"), "step 4 holds the download");
  const [dl] = await Promise.all([pg.waitForEvent("download", { timeout: 240000 }), pg.click("#export")]);
  const file = path.join(os.tmpdir(), "sepbench-e2e.zip"); await dl.saveAs(file);
  const zip = await JSZip.loadAsync(fs.readFileSync(file)), names = Object.keys(zip.files);
  const spec = JSON.parse(await zip.file("separation.json").async("string"));
  const tifs = names.filter(n => n.startsWith("tiff/") && n.endsWith(".tif"));
  ok(names.includes("films.pdf"), "export has films.pdf");
  ok(spec.garment.fabric === "cotton" && /320 °F/.test(spec.garment.fabric_notes), "separation.json names the fabric (cotton) and its cure");
  ok(tifs.length === spec.screens.length, `one TIFF per screen (${tifs.length} for ${spec.screens.length})`);
  ok(spec.screens.every((s, i) => s.order === i + 1 && tifs.some(t => t.includes(String(s.order).padStart(2, "0")))), "film order matches separation.json");
  ok(names.includes("mix-sheet.pdf") && Array.isArray(spec.mix) && spec.mix.length === spec.screens.length && spec.mix.every(m => m.grams > 0), `mix sheet: ${spec.mix ? spec.mix.length : 0} screens with batch weights`);
  { const js = zip.file("job-sheet.pdf"), b = js ? await js.async("nodebuffer") : null;
    ok(!!b && b.slice(0, 5).toString() === "%PDF-" && b.length > 2000, `job sheet: ${b ? b.length : 0} bytes`);
    if (b) fs.writeFileSync(path.join(os.tmpdir(), "sepbench-job.pdf"), b); }
  if (zip.file("mix-sheet.pdf")) fs.writeFileSync(path.join(os.tmpdir(), "sepbench-mix.pdf"), await zip.file("mix-sheet.pdf").async("nodebuffer"));
  const psdName = names.find(n => n.endsWith(".psd") && !n.includes("-preview")), psd = psdName ? await zip.file(psdName).async("nodebuffer") : null;
  ok(psd && psd.toString("latin1", 0, 4) === "8BPS" && psd.readUInt16BE(24) === 7 && psd.readUInt16BE(12) === spec.screens.length, `Photoshop file is Multichannel with ${psd ? psd.readUInt16BE(12) : 0} spot channels for ${spec.screens.length} screens and no composite`);
  if (psd) fs.writeFileSync(path.join(os.tmpdir(), "sepbench-e2e.psd"), psd);
  { const p = zip.file("proof.png") ? await zip.file("proof.png").async("nodebuffer") : null;
    ok(!!p && p.readUInt32BE(0) === 0x89504e47 && p.readUInt32BE(16) > 0 && p.readUInt32BE(20) > 0, `proof.png (the Print view) is in the ZIP: ${p ? `${p.readUInt32BE(16)}×${p.readUInt32BE(20)} px` : "missing"}`); }
  // simulated RIP hot folder: Write to folder into a folder the test watches. Every file of the ZIP lands, written whole,
  // and the films land in print order (a RIP watching the folder takes them as they arrive)
  { await pg.evaluate(() => {
      const log = window.__hotFolder = [], dir = at => ({
        getDirectoryHandle: async n => dir(`${at}${n}/`),
        getFileHandle: async n => ({ createWritable: async () => { let size = -1; return { write: async b => { size = b.size; }, close: async () => { log.push({ path: at + n, size }); } }; } }) });
      window.showDirectoryPicker = async () => dir(""); document.getElementById("exportFolder").hidden = false; });
    await pg.click("#exportFolder");
    await pg.waitForFunction(() => /Wrote \d+ files|did not|over|inconsistent/.test(document.getElementById("expStatus").textContent), null, { timeout: 240000 });
    const hot = await pg.evaluate(() => window.__hotFolder), landed = hot.map(h => h.path), films = landed.filter(n => n.startsWith("tiff/"));
    ok(/Wrote \d+ files/.test(await pg.textContent("#expStatus")) && landed.length === names.filter(n => !zip.files[n].dir).length && names.every(n => zip.files[n].dir || landed.includes(n)) && hot.every(h => h.size > 0),
      `hot folder: all ${landed.length} files of the download land, each written whole`);
    ok(films.length === spec.screens.length && films.every((f, i) => f === `tiff/${spec.screens[i].file}.tif`), `hot folder: the films land in print order (${films.map(f => f.slice(5, 7)).join(" ")})`); }
  ok(spec.print.dot_shape === "round" && !names.some(n => n.endsWith("-dcs2.eps")), "default export: round dots, no DCS file unless asked");
  // dot shape and DCS 2.0: Ellipse changes the films (same tone), and the DCS file holds every screen in print order
  { const tif0 = await zip.file(tifs[tifs.length - 1]).async("nodebuffer");
    await pg.evaluate(() => { const s = /** @type {HTMLSelectElement} */ (document.getElementById("dotShape")); s.value = "ellipse"; s.dispatchEvent(new Event("change", { bubbles: true })); });
    await pg.check("#fDCS");
    const [dl2] = await Promise.all([pg.waitForEvent("download", { timeout: 240000 }), pg.click("#export")]);
    const f2 = path.join(os.tmpdir(), "sepbench-e2e-ellipse.zip"); await dl2.saveAs(f2);
    const z2 = await JSZip.loadAsync(fs.readFileSync(f2)), n2 = Object.keys(z2.files), spec2 = JSON.parse(await z2.file("separation.json").async("string"));
    const tif1 = await z2.file(tifs[tifs.length - 1]).async("nodebuffer");
    ok(spec2.print.dot_shape === "ellipse" && tif1.length > 100 && !tif0.equals(tif1), `Ellipse dot shape changes the films (${tifs[tifs.length - 1]}: ${tif0.length} → ${tif1.length} bytes)`);
    const dcsName = n2.find(n => n.endsWith("-dcs2.eps")), dcs = dcsName ? await z2.file(dcsName).async("nodebuffer") : null, head = dcs ? dcs.toString("latin1", 0, 4000) : "";
    const pfs = [...head.matchAll(/^%%PlateFile: \((.*)\) EPS #(\d+) (\d+)$/gm)];
    ok(!!dcs && head.startsWith("%!PS-Adobe-3.0 EPSF-3.0") && pfs.length === spec2.screens.length && pfs.every((m, i) => m[1].startsWith(`${i + 1}. `) && dcs.toString("latin1", +m[2], +m[2] + 23) === "%!PS-Adobe-3.0 EPSF-3.0")
      && +pfs[pfs.length - 1][2] + +pfs[pfs.length - 1][3] === dcs.length, `export has a DCS 2.0 file with ${pfs.length} plates for ${spec2.screens.length} screens, each at its offset`);
    if (dcs) fs.writeFileSync(path.join(os.tmpdir(), "sepbench-e2e-dcs2.eps"), dcs);
    const psd2 = await z2.file(n2.find(n => n.endsWith(".psd") && !n.includes("-preview"))).async("nodebuffer");
    ok(psd2.includes(Buffer.from([0x38, 0x42, 0x49, 0x4d, 0x03, 0xf4])), "Photoshop file carries the halftone screens (resource 1012) for the Ellipse dot");
    await pg.uncheck("#fDCS");
    await pg.evaluate(() => { const s = /** @type {HTMLSelectElement} */ (document.getElementById("dotShape")); s.value = "round"; s.dispatchEvent(new Event("change", { bubbles: true })); }); }
  // Shop production (ZigZag parity): rename a screen, double hit, film mirror, press time; every export carries them
  { const F = await import(path.join(__dirname, "../src/filmimport.js")), stars0 = +(await pg.textContent("#rStars"));
    await openStep(3); const c2 = "#scrList .scard:nth-child(2)", c3 = "#scrList .scard:nth-child(3)", c1 = "#scrList .scard:nth-child(1)";
    await pg.click(`${c2} .sexp`); await pg.waitForTimeout(300);
    ok(await pg.isVisible(`${c2} [data-rename]`) && await pg.isVisible(`${c2} [data-hits]`) && await pg.evaluate(c => document.querySelectorAll(c + " .sprod button.q").length === 3, c2), "an open screen card has Name, Prints and Merge, each with its ?");
    const own2 = await pg.getAttribute(`${c2} [data-rename]`, "placeholder");
    await pg.fill(`${c2} [data-rename]`, "Customer Red"); await pg.press(`${c2} [data-rename]`, "Enter"); await pg.waitForTimeout(200);
    ok(/^Customer Red/.test(await pg.textContent(`${c2} .sn`)) && await pg.getAttribute(`${c2} [data-rename]`, "placeholder") === own2, `rename: the screen takes the shop's name, the ink keeps its own (${own2})`);
    await pg.selectOption(`${c2} [data-hits]`, "2f"); await pg.waitForTimeout(200);
    ok(await pg.inputValue(`${c2} [data-hits]`) === "2f", "double hit: Twice, flash between is set on the screen");
    await pg.click(`${c3} .sexp`); await pg.waitForTimeout(200); const own3 = await pg.getAttribute(`${c3} [data-rename]`, "placeholder");
    await pg.fill(`${c3} [data-rename]`, "Temp"); await pg.press(`${c3} [data-rename]`, "Enter"); await pg.waitForTimeout(200);
    await pg.fill(`${c3} [data-rename]`, ""); await pg.press(`${c3} [data-rename]`, "Enter"); await pg.waitForTimeout(200);
    ok((await pg.textContent(`${c3} .sn`)).startsWith(own3), "rename: a cleared name goes back to the ink's name");
    await pg.click(`${c1} .sexp`); await pg.waitForTimeout(200); await pg.selectOption(`${c1} [data-hits]`, "2"); await pg.waitForTimeout(200);
    await openStep(4); const pt0 = await pg.textContent("#ptLine");
    ok(/^Press time, estimate: about .* for \d+ prints\. Setup \d+ screens? × \d+(\.\d+)? min .* Run at \d+ an hour .* strokes, \d+ flash/.test(pt0), `press time shows as an estimate: ${pt0}`);
    await pg.fill("#setupMin", "20"); ok(/× 20 min/.test(await pg.textContent("#ptLine")), "press time follows the setup minutes typed");
    await pg.fill("#setupMin", ""); ok(/Type the setup minutes/.test(await pg.textContent("#ptLine")), "press time: an empty field says what to type");
    await pg.fill("#setupMin", "20"); await openStep(2); await pg.selectOption("#press", "automatic"); await done().catch(() => {});
    const autoSu = await pg.inputValue("#setupMin"); await pg.selectOption("#press", "manual"); await done().catch(() => {}); await openStep(4);
    ok(autoSu !== "20" && await pg.inputValue("#setupMin") === "20", `press time: each press type keeps its own numbers (automatic ${autoSu}, manual 20)`);
    await pg.selectOption("#mirror", "mirror"); ok(/mirrored/.test(await pg.textContent("#step4Sum")), "film mirror: step 4 says the films are mirrored");
    const [dl2] = await Promise.all([pg.waitForEvent("download", { timeout: 240000 }), pg.click("#export")]); const file2 = path.join(os.tmpdir(), "sepbench-e2e-prod.zip"); await dl2.saveAs(file2);
    const z2 = await JSZip.loadAsync(fs.readFileSync(file2)), n2 = Object.keys(z2.files), s2 = JSON.parse(await z2.file("separation.json").async("string"));
    ok(s2.print.mirror === true && s2.screens[1].name === "Customer Red" && s2.screens[1].ink === own2 && s2.screens[1].hits === 2 && s2.screens[1].flash_between_hits && s2.screens[0].hits === 2 && !s2.screens[0].flash_between_hits && s2.flashes_per_print === 2,
      "separation.json carries the mirror, the new name with its ink, the double hits and the flashes per print");
    ok(s2.press_time && s2.press_time.estimate && s2.press_time.setup_min_per_screen === 20 && s2.press_time.strokes === s2.screens.length + 2, `separation.json carries the press time estimate (${s2.press_time && s2.press_time.total_min} min)`);
    ok(n2.includes("tiff/02-customer-red.tif") && s2.mix[1].hits === 2 && s2.mix[1].grams > spec.mix[1].grams, `films and mix sheet use the new name; the double hit mixes more ink (${spec.mix[1].grams} → ${s2.mix[1].grams} g)`);
    const third = n => n.find(x => x.startsWith("tiff/03-"));
    const ta = F.readTIFF(await zip.file(third(names)).async("uint8array")), tb = F.readTIFF(await z2.file(third(n2)).async("uint8array")), mx = Math.round(ta.dpi * 0.5);
    let same = ta.W === tb.W && ta.H === tb.H; for (let y = mx; same && y < ta.H - mx; y += 3) for (let x = 0; x < ta.W; x++) if (ta.ink[y * ta.W + x] !== tb.ink[y * ta.W + ta.W - 1 - x]) { same = false; break; }
    ok(same, "film mirror: a TIFF film is the same film flipped left to right");
    const p2n = n2.find(x => x.endsWith(".psd") && !x.includes("-preview")), pa = F.readPSD(psd), pb = F.readPSD(await z2.file(p2n).async("uint8array"));
    let psame = pa.W === pb.W; for (let y = 0; psame && y < pa.H; y += 5) for (let x = 0; x < pa.W; x++) if (pa.channels[2].ink[y * pa.W + x] !== pb.channels[2].ink[y * pa.W + pa.W - 1 - x]) { psame = false; break; }
    ok(psame && pb.channels[1].name === "Customer Red" && pb.channels[1].hits === 2 && pb.channels[1].flashBetween && pb.channels[0].hits === 2, "Photoshop file: channels mirrored, the new name and the double hits (2x, 2x flash) in the channel names");
    fs.writeFileSync(path.join(os.tmpdir(), "sepbench-e2e-prod.psd"), await z2.file(p2n).async("nodebuffer"));
    // re-proof: the mirrored Photoshop file just made, then the first export's TIFF films with its separation.json
    await openStep(1); await pg.setInputFiles("#impFile", path.join(os.tmpdir(), "sepbench-e2e-prod.psd")); await pg.waitForFunction(() => /\b(ok|bad)\b/.test(document.getElementById("impNote").className), null, { timeout: 120000 }); await done();
    const stars1 = +(await pg.textContent("#rStars")), note1 = await pg.textContent("#impNote");
    ok(/^Re-proofed .*psd: \d+ color screens and an underbase, mirrored films read the right way round/.test(note1) && await pg.evaluate(() => !document.getElementById("impClose").hidden), `re-proof: the Photoshop file is read, the mirror found (${note1})`);
    ok(Math.abs(stars1 - stars0) <= 0.5, `re-proof: our own films rate about as the separation did (${stars0} → ${stars1})`);
    ok(/^Customer Red/.test(await pg.textContent(c2 + " .sn")) && (await cardNames()).split("/").length === s2.screens.length, "re-proof: the screens are the films, with their names, in print order");
    const tdir = path.join(os.tmpdir(), "sepbench-tiffs"); fs.rmSync(tdir, { recursive: true, force: true }); fs.mkdirSync(tdir);
    for (const n of [...tifs, "separation.json"]) fs.writeFileSync(path.join(tdir, path.basename(n)), await zip.file(n).async("nodebuffer"));
    await openStep(1); await pg.setInputFiles("#impFile", fs.readdirSync(tdir).map(n => path.join(tdir, n))); await pg.waitForFunction(() => /TIFF films/.test(document.getElementById("impNote").textContent) || /\bbad\b/.test(document.getElementById("impNote").className), null, { timeout: 120000 }); await done();
    const note2 = await pg.textContent("#impNote");
    ok(new RegExp(`^Re-proofed ${tifs.length} TIFF films: .*0\\.5 in film margin trimmed`).test(note2) && /^\d\.\d$/.test(await pg.textContent("#rStars")), `re-proof: the TIFF films and separation.json are read, the film margin trimmed (${note2}; ${await pg.textContent("#rStars")} stars)`);
    await pg.setInputFiles("#impFile", path.join(tdir, "separation.json")); await pg.waitForTimeout(300);
    ok(/Choose a Photoshop file/.test(await pg.textContent("#impNote")) && /bad/.test(await pg.getAttribute("#impNote", "class")), "re-proof: a file that is not films is refused with a plain message");
    await openStep(1); await pg.click("#impClose"); await done();
    ok(await pg.isHidden("#impClose") && /^A Photoshop file/.test(await pg.textContent("#impNote")), "Close the films: the art is separated again");
    await openStep(4); await pg.selectOption("#mirror", "right"); }
  // Report a problem: a local error log and a copyable report with the settings, never the art
  { await pg.evaluate(() => { localStorage.setItem("sepbench.errors", JSON.stringify([{ at: "2026-11-14T00:00:00Z", msg: "test error", where: "app.js:1" }])); });
    await pg.click("#shopOpen"); await pg.waitForTimeout(200);
    ok(/1 error kept/.test(await pg.textContent("#reportNote")) && !(await pg.isDisabled("#reportClear")), "Shop setup shows the errors kept on this device");
    await pg.click("#reportCopy"); await pg.waitForTimeout(300); const rep = await pg.inputValue("#reportText"), art = await pg.textContent("#artName");
    ok(/^Separation Table problem report/.test(rep) && /Settings:/.test(rep) && /"lpi"/.test(rep) && /test error/.test(rep) && !rep.includes(art) && await pg.isVisible("#reportText"), "Copy a problem report: version, browser, settings and errors, without the art or its name");
    await pg.click("#reportClear"); ok(/empty/.test(await pg.textContent("#reportNote")) && await pg.isDisabled("#reportClear") && await pg.evaluate(() => localStorage.getItem("sepbench.errors")) === "[]", "Clear the error log empties it");
    await pg.click('[data-close="shopPanel"]'); }
  // Timing log: ?timing=1 logs each worker job with its time
  { const tp = await b.newPage(), lines = []; tp.on("console", m => { if (/^\[timing\]/.test(m.text())) lines.push(m.text()); });
    await tp.goto(url + "?timing=1"); await tp.waitForTimeout(500); await tp.click("#trySample");
    await tp.waitForFunction(() => /Updated|failed/.test(document.getElementById("status").textContent), null, { timeout: 180000 });
    const n = await tp.evaluate(() => (/** @type {any} */ (window).sepTiming || []).length);
    ok(n > 0 && lines.some(l => /\[timing\] separate \d+ ms/.test(l)), `?timing=1 logs each worker job with its time (${n} jobs, e.g. ${lines[0]})`);
    const off = await b.newPage(); await off.goto(url); await off.waitForTimeout(300); ok(await off.evaluate(() => !(/** @type {any} */ (window).sepTiming)), "without ?timing=1 nothing is timed");
    await tp.close(); await off.close(); }
  // calibration round trip: chart ZIP has the physics patches; filled readings import and set the measured opacity
  await openStep(3); ok(await pg.textContent("#step4Badge") === "✓", "step 4 shows ✓ after the download"); await pg.click("#shopOpen"); ok(await pg.isVisible("#shopPanel") && await pg.isVisible("#libPreset"), "Shop setup holds the ink library and calibration");
  const [cdl] = await Promise.all([pg.waitForEvent("download", { timeout: 240000 }), pg.click("#calChart")]);
  const cfile = path.join(os.tmpdir(), "sepbench-cal.zip"); await cdl.saveAs(cfile);
  const czip = await JSZip.loadAsync(fs.readFileSync(cfile)), tmpl = await czip.file("readings-template.csv").async("string");
  ok(czip.file("calibration-films.pdf") && /,bare100,/.test(tmpl) && /,ov:/.test(tmpl) && /^_shirt,0/m.test(tmpl), "calibration chart has bare-shirt and overlap patches in its template");
  const filled = tmpl.split("\n").map(l => { const c = l.split(","); if (c.length < 5 || c[0] === "ink") return l; const t = c[1];
    const L = c[0] === "_shirt" ? 6 : t === "bare100" ? 32 : t === "bare50" ? 20 : t.startsWith("ov:") ? 48 : 95 - 0.45 * +t; return `${c[0]},${t},${L.toFixed(1)},${(+t || 40) / 6},${(+t || 40) / 8}`; }).join("\n");
  const rfile = path.join(os.tmpdir(), "sepbench-readings.csv"); fs.writeFileSync(rfile, filled);
  await pg.setInputFiles("#calFile", rfile); await done();
  const calTxt = await pg.textContent("#calNote"), pill = await pg.textContent("#calPill");
  ok(/Calibrated/.test(pill) && /opacity on the bare shirt/.test(calTxt) && /overlap/.test(calTxt), `readings import: ${pill.trim()}`);
  // shop and press profiles: save, change, use, rename, export, delete (two pushes), import, mesh
  { ok(await pg.textContent("#profPill") === "No profiles" && await pg.isDisabled("#profUpdate") && await pg.isDisabled("#profDelete") && await pg.isDisabled("#profExport") && /No profiles of your own yet/.test(await pg.textContent("#profNote")), "profiles start with only the built-ins, a hint, and the buttons that need your own profile off");
    await pg.click("#profSave"); ok(/Type a name/.test(await pg.textContent("#profNote")), "Save as new without a name asks for one");
    await pg.fill("#profName", "Auto press"); await pg.click("#profSave");
    ok(await pg.textContent("#profPill") === "In use: Auto press" && /Saved Auto press/.test(await pg.textContent("#profNote")), "a profile saves the job settings and is in use");
    // change the LPI where a person does (step 2), then come back to Shop setup
    await pg.click('[data-close="shopPanel"]'); await openStep(2);
    const lpi0 = await pg.inputValue("#lpi"); await pg.click('.stp[data-for="lpi"][data-d="5"]'); await done();
    await pg.click("#shopOpen");
    ok(await pg.textContent("#profPill") === "Auto press: changed" && /differ from Auto press/.test(await pg.textContent("#profNote")), "changing a setting shows that the job no longer matches the profile");
    await pg.click("#profLoad"); await done();
    ok(await pg.inputValue("#lpi") === lpi0 && await pg.textContent("#profPill") === "In use: Auto press" && /calibration is in use/.test(await pg.textContent("#profNote")), `Use profile puts the LPI back (${lpi0}) with its calibration`);
    // the profile keeps the shop's platen, film and screen sizes too
    const pz0 = await pg.inputValue("#szPlaten"), pz1 = pz0 === "youth" ? "large" : "youth";
    await pg.evaluate(v => { const e = document.getElementById("szPlaten"); e.value = v; e.dispatchEvent(new Event("change")); }, pz1);
    ok(await pg.textContent("#profPill") === "Auto press: changed", "changing the platen size shows that the job no longer matches the profile");
    await pg.click("#profLoad"); await done(); ok(await pg.inputValue("#szPlaten") === pz0 && await pg.textContent("#profPill") === "In use: Auto press", `Use profile puts the platen back (${pz0})`);
    await pg.fill("#profName", "Press 2"); await pg.click("#profRename"); ok(await pg.textContent("#profPill") === "In use: Press 2", "rename keeps it in use under the new name");
    const [pdl] = await Promise.all([pg.waitForEvent("download"), pg.click("#profExport")]), pf = path.join(os.tmpdir(), "sepbench-profiles.json"); await pdl.saveAs(pf);
    const pj = JSON.parse(fs.readFileSync(pf, "utf8"));
    ok(pj.format === "adn-separation-table-profiles" && pj.profiles.length === 1 && pj.profiles[0].name === "Press 2" && pj.profiles[0].calib && pj.profiles[0].lpi === +lpi0 && pj.profiles[0].sizes && pj.profiles[0].sizes.platen.id === pz0, "Export JSON writes the profile with its settings, sizes and calibration");
    await pg.click("#profDelete"); ok(await pg.textContent("#profDelete") === "Push again to delete" && await pg.textContent("#profPill") === "In use: Press 2", "the first Delete push only asks to confirm");
    await pg.click("#profDelete"); ok(await pg.textContent("#profPill") === "No profiles", "the second Delete push deletes it");
    const noteHas = re => pg.waitForFunction(r => new RegExp(r).test(document.getElementById("profNote").textContent), re, { timeout: 10000 }).catch(() => {});
    await pg.setInputFiles("#profFile", pf); await noteHas("Imported"); ok(/Imported 1 profile/.test(await pg.textContent("#profNote")) && await pg.inputValue("#profSel") === "Press 2", "Import JSON brings it back");
    const bad = path.join(os.tmpdir(), "sepbench-bad.json"); fs.writeFileSync(bad, '{"hello":1}'); await pg.setInputFiles("#profFile", bad); await noteHas("not a Separation");
    ok(/not a Separation Table profiles file/.test(await pg.textContent("#profNote")), "a wrong JSON file is refused with a plain message");
    ok(await pg.evaluate(() => JSON.parse(localStorage.getItem("sepbench.profiles")).list.length) === 1, "profiles are kept in the browser (sepbench.profiles, which the ADN page syncs to the account)");
    await pg.selectOption("#meshColor", "305"); ok(/set in Shop setup: 305/.test(await pg.textContent("#meshNote")), "the colors mesh from Shop setup is what the screens use");
    await pg.selectOption("#meshColor", ""); }
  // Shop setup sizes: a platen smaller than the print is an error with a fix that makes the print fit
  { await pg.selectOption("#szPlaten", "custom"); await pg.fill("#szPlatenW", "3"); await pg.fill("#szPlatenH", "3"); await pg.dispatchEvent("#szPlatenH", "change"); await pg.waitForTimeout(300);
    const c = await pg.evaluate(() => { const k = document.querySelector('#preflight [data-check="too-large-platen"]'); return k && { sev: k.className, text: k.textContent, fix: /** @type {HTMLElement} */ (k.querySelector("[data-fix]"))?.dataset.fix, q: !!k.querySelector("b > button.q") }; });
    ok(c && /error/.test(c.sev) && /Print larger than the platen/.test(c.text) && /Custom 3 × 3 in/.test(c.text) && /^w:/.test(c.fix) && c.q, `a 3 × 3 in platen makes the 6 in sample an error, with ${c && c.fix} and a ? help button`);
    ok(JSON.parse(await pg.evaluate(() => localStorage.getItem("sepbench.sizes"))).platen.w === 3, "the custom platen is saved for the next visit");
    await pg.fill("#szPlatenW", "0"); await pg.dispatchEvent("#szPlatenW", "change");
    ok(/width must be a number from 1 to 40 in/.test(await pg.textContent("#sizeNote")), "a custom width of 0 says what is wrong");
    await pg.selectOption("#szPlaten", "standard"); await pg.waitForTimeout(300);
    ok(!(await pg.$('#preflight [data-check="too-large-platen"]')) && await pg.textContent("#sizeNote") === "", "back on the standard platen the error goes"); }
  await pg.click('[data-close="shopPanel"]');
  // sample art is transparent around the design, so the garment shows; a solid background box gets a warning
  ok(!/solid .* background/.test(await pg.textContent("#preflight")), "sample art has no background box");
  { const W = 300, H = 300, raw = Buffer.alloc((W * 4 + 1) * H); for (let y = 0; y < H; y++) { raw[y * (W * 4 + 1)] = 0; for (let x = 0; x < W; x++) { const o = y * (W * 4 + 1) + 1 + x * 4, inner = x > 100 && x < 200 && y > 100 && y < 200; raw[o] = inner ? 20 : 220; raw[o + 1] = inner ? 60 : 40; raw[o + 2] = inner ? 200 : 40; raw[o + 3] = 255; } }
    const zlib = require("zlib"), crc = b => { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } c = 0xffffffff; for (const x of b) c = t[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const chunk = (ty, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(ty), d]), c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
    const ih = Buffer.alloc(13); ih.writeUInt32BE(W, 0); ih.writeUInt32BE(H, 4); ih[8] = 8; ih[9] = 6;
    const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ih), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
    const f = path.join(os.tmpdir(), "sepbench-boxed.png"); fs.writeFileSync(f, png); await pg.setInputFiles("#file", f); await done(); await pg.waitForTimeout(300);
    ok(/solid #[0-9a-f]{6} background/.test(await pg.textContent("#preflight")), "art with a solid background box gets a preflight warning");
    await pg.waitForFunction(() => !document.getElementById("awTog").hidden, null, { timeout: 180000 }); await done();
    { const sev = await pg.evaluate(() => [...document.querySelectorAll("#preflight .ck")].map(c => c.className.split(" ")[1]));
      ok(sev[0] === "error" && sev.join() === [...sev].sort((a, b) => ["error", "warning", "note"].indexOf(a) - ["error", "warning", "note"].indexOf(b)).join() && await pg.evaluate(() => document.querySelector("#preflight .ck").dataset.check) === "solid-background" && await pg.evaluate(() => document.getElementById("preflight").classList.contains("bad")),
        `the solid background is an error and errors come first (${sev})`);
      const px = () => pg.evaluate(() => { const c = /** @type {HTMLCanvasElement} */ (document.getElementById("view0")), g = c.getContext("2d"), at = (fx, fy) => [...g.getImageData(Math.floor(c.width * fx), Math.floor(c.height * fy), 1, 1).data].slice(0, 3); return { bg: at(0.15, 0.5), art: at(0.5, 0.5) }; });
      await pg.evaluate(() => /** @type {HTMLElement} */ (document.querySelector('#preflight [data-check="solid-background"] .ckshow')).click()); await pg.waitForTimeout(300);
      const on = await pg.evaluate(() => { const b = document.querySelector('#preflight [data-check="solid-background"] .ckshow'); return { view: document.body.dataset.view, pressed: b.getAttribute("aria-pressed"), text: b.textContent, note: document.getElementById("viewNote").textContent }; }), p1 = await px();
      ok(on.view === "orig" && on.pressed === "true" && on.text === "Hide" && /Marked: Solid background/.test(on.note) && p1.bg[0] > 200 && p1.bg[1] < 70 && p1.art[0] > 150 && p1.art[1] > 150,
        `Show where opens the art with the background marked and the design washed out (bg ${p1.bg}, design ${p1.art})`);
      await pg.evaluate(() => /** @type {HTMLElement} */ (document.querySelector('#preflight [data-check="solid-background"] .ckshow')).click()); await pg.waitForTimeout(300);
      const off = await pg.evaluate(() => { const b = document.querySelector('#preflight [data-check="solid-background"] .ckshow'); return { pressed: b.getAttribute("aria-pressed"), text: b.textContent, note: document.getElementById("viewNote").textContent }; }), p2 = await px();
      ok(off.pressed === "false" && off.text === "Show where" && !/Marked/.test(off.note) && p2.art[2] > 150 && p2.art[0] < 80, `a second tap clears the mark (design ${p2.art})`); }
    ok(await pg.textContent("#artName") === "sepbench-boxed.png" && /300 × 300 px/.test(await pg.textContent("#artSize")), `the art card shows the uploaded file (${await pg.textContent("#artSize")})`);
    ok(!(await pg.isHidden("#step2Body")) && /by Auto/.test(await pg.textContent("#step3Sum")), `after an upload step 2 opens and Auto runs (${await pg.textContent("#step3Sum")})`); }
  // Interlocked screens by hand: the separation runs again (two inks per spot), the note explains them, the films draw
  { const idle = () => pg.waitForFunction(() => !document.getElementById("run").disabled && /Updated/.test(document.getElementById("status").textContent), null, { timeout: 180000 });
    await idle(); await openStep(2); if (await pg.isHidden("#screening")) await pg.click("#advTog").catch(() => {});
    await pg.evaluate(() => { const s = document.getElementById("screening"); s.value = "lock"; s.dispatchEvent(new Event("input")); s.dispatchEvent(new Event("change")); });
    await pg.waitForTimeout(400); await idle();
    const lk = await pg.evaluate(() => { const r = [...document.querySelectorAll("#scrList .scard")].length; return { note: !document.getElementById("lockNote").hidden, status: document.getElementById("status").textContent, cards: r }; });
    ok(lk.note && /screening/.test(lk.status) && lk.cards > 0, `interlocked screens by hand separate again and show their note (${lk.status})`);
    await pg.evaluate(() => { const s = document.getElementById("screening"); s.value = "same"; s.dispatchEvent(new Event("input")); s.dispatchEvent(new Event("change")); });
    await pg.waitForTimeout(400); await idle(); ok(await pg.evaluate(() => document.getElementById("lockNote").hidden), "back to one angle hides the note");
    await pg.evaluate(() => document.getElementById("auto").click()); await pg.waitForFunction(() => document.getElementById("auto").textContent === "✓ Auto", null, { timeout: 180000 }); }
  // Adjust the art: a slider changes the art the separation reads (the art card follows), Reset gives the art back
  { const idle = () => pg.waitForFunction(() => document.getElementById("auto").textContent === "✓ Auto" && !document.getElementById("run").disabled && /Updated/.test(document.getElementById("status").textContent), null, { timeout: 180000 });
    const thumb = () => pg.evaluate(() => { const c = /** @type {HTMLCanvasElement} */ (document.getElementById("artThumb")); return c.toDataURL(); });
    await idle(); const t0 = await thumb();
    await pg.evaluate(() => { const e = /** @type {HTMLInputElement} */ (document.getElementById("adjSat")); e.value = "60"; e.dispatchEvent(new Event("input")); e.dispatchEvent(new Event("change")); });
    await pg.waitForTimeout(500); await idle(); const t1 = await thumb();
    ok(t1 !== t0 && await pg.textContent("#adjSatV") === "+60" && /adjusted art/.test(await pg.textContent("#adjNote")) && !(await pg.isDisabled("#adjReset")), "a Saturation change makes the separation read the adjusted art");
    await pg.evaluate(() => document.getElementById("adjReset").click()); await pg.waitForTimeout(500); await idle();
    ok(await thumb() === t0 && await pg.isDisabled("#adjReset") && await pg.textContent("#adjSatV") === "0", "Reset gives the art back as it was"); }
  // desktop, small laptop: the rating row under the image stays in the window; step rows are one line; Width / LPI / Press share a row
  // Auto shows a picture at once and refines in the background; a change by hand while it works stops it and is kept
  await pg.evaluate(() => /** @type {HTMLElement} */ (document.querySelector('[data-auto="2"]')).click());
  await pg.waitForFunction(() => /refining/.test(document.getElementById("status").textContent), null, { timeout: 60000 });
  ok(await pg.evaluate(() => document.querySelectorAll("#scrList .scard").length > 0 && document.getElementById("auto").textContent === "Auto"), "while Auto refines, the separation stays on screen and Auto is not marked done yet");
  { const k0 = +(await pg.inputValue("#nInks")); await pg.evaluate(() => document.getElementById("inkPlus").click()); await done(); await pg.waitForTimeout(6000);
    ok(await pg.textContent("#auto") === "Auto" && +(await pg.inputValue("#nInks")) === k0 + 1 && /Updated/.test(await pg.textContent("#status")), `a screen added by hand while Auto refines stops Auto and is kept (${k0} → ${await pg.inputValue("#nInks")})`); }
  // Auto keeps a print method you pick and finds the best settings inside it; changing a setting by hand turns Auto off
  if (await pg.textContent("#auto") !== "✓ Auto") { await pg.evaluate(() => document.getElementById("auto").click()); await pg.waitForFunction(() => document.getElementById("auto").textContent === "✓ Auto", null, { timeout: 180000 }); await done(); }
  await pg.evaluate(() => document.querySelectorAll(".pane details").forEach(d => { d.open = true; }));
  await pg.evaluate(() => document.querySelector("#mode button[data-v=spot]").click()); await pg.waitForFunction(() => /best settings for Spot colors/.test(document.getElementById("autoNote").textContent), null, { timeout: 180000 }); await done();
  ok(await pg.getAttribute("#mode button[data-v=spot]", "aria-pressed") === "true" && await pg.textContent("#auto") === "✓ Auto", "on Auto, picking Spot colors keeps Spot and Auto tunes it");
  await pg.evaluate(() => document.getElementById("inkPlus").click()); await done(); ok(await pg.textContent("#auto") === "Auto", "changing the screen count by hand turns Auto off");
  await pg.setViewportSize({ width: 1280, height: 720 }); await pg.evaluate(() => scrollTo(0, 0)); await pg.waitForTimeout(600);
  { const g = await pg.evaluate(() => { const r = id => document.getElementById(id).getBoundingClientRect(); return { rate: r("dRate"), sq: r("square"), vh: innerHeight, rows: [1, 2, 3, 4].map(n => r(`step${n}`)).filter((x, i) => !document.getElementById(`step${i + 1}`).classList.contains("open")).map(x => Math.round(x.height)), w: r("outW").top, hh: r("outH").top, sc: parseFloat(getComputedStyle(document.getElementById("nInks").parentElement).width) }; });
    ok(g.rate.bottom <= g.vh && g.rate.top >= g.sq.bottom - 1 && g.rate.height <= 40, `desktop 1280×720: the rating row sits under the image and inside the window (ends at ${Math.round(g.rate.bottom)} of ${g.vh})`);
    ok(g.rows.every(h => h <= 40), `desktop: closed steps are one line (${g.rows.join("/")} px)`);
    ok(Math.abs(g.w - g.hh) < 2 && g.sc <= 140, `W and H share a row; Color screens is narrow (${Math.round(g.sc)} px)`); }
  { const w0 = +(await pg.inputValue("#outW")), h0 = +(await pg.inputValue("#outH")); await pg.evaluate(() => document.querySelector('.stp[data-for=outW][data-d="0.5"]').click()); const w1 = +(await pg.inputValue("#outW")), h1 = +(await pg.inputValue("#outH"));
    ok(w1 === w0 + 0.5 && Math.abs(h1 / w1 - h0 / w0) < 0.01, `W + steps half an inch and H follows the art's shape (${w0}×${h0} → ${w1}×${h1})`);
    await pg.evaluate(() => document.querySelector('.stp[data-for=outW][data-d="-0.5"]').click()); await pg.waitForTimeout(300); }
  await pg.setViewportSize({ width: 390, height: 900 }); ok(await pg.evaluate(() => document.documentElement.scrollWidth <= 390), "no horizontal scroll at phone width");
  await pg.waitForTimeout(400);
  ok(await pg.evaluate(() => getComputedStyle(document.getElementById("square")).position === "sticky"), "phone: the image is pinned");
  ok(await pg.isVisible("#mNav"), "phone: the Back/Next bar shows");
  { const at = await pg.evaluate(() => ({ side: document.getElementById("paneSide").parentElement.id, open: [1, 2, 3, 4].filter(n => !document.getElementById(`step${n}Body`).hidden).map(n => `step${n}Body`) }));
    ok(at.open.includes(at.side), `phone: Advanced sits inside the open step (${at.side}; open: ${at.open.join(", ")})`); }
  await pg.click("#mNext"); await pg.waitForTimeout(600); ok(!(await pg.isHidden("#step3Body")) && await pg.evaluate(() => document.getElementById("paneSide").parentElement.id === "step3Body" && !!document.querySelector("#step3Body #scrList")), "phone: Next opens Separation, with the screens inside it");
  await pg.waitForTimeout(600);
  { const g = await pg.evaluate(() => { const r = id => document.getElementById(id).getBoundingClientRect(); return { off: document.body.classList.contains("artoff"), vb: r("viewBar"), nav: r("mNav"), chip: r("mRate"), row: r("step1"), s4: r("step4"), s3top: r("step3").top, back: r("mBack"), next: r("mNext"), prog: [...document.querySelectorAll("#mProg i")].map(i => i.className).join(","), views: [...document.querySelectorAll("#view button")].map(b => b.textContent).join("|"), chk: document.getElementById("mrChk").textContent, vw: innerWidth }; });
    ok(!g.off && Math.round(g.vb.bottom) >= 222 && g.s3top >= g.vb.bottom - 1 && g.s3top + 46 <= g.nav.top, `phone: Next opens the step under the image band; the image stays on screen (view row ends at ${Math.round(g.vb.bottom)}, step 3 at ${Math.round(g.s3top)})`);
    ok(g.chip.top >= g.vb.top && g.chip.bottom <= g.vb.bottom + 0.5 && g.chip.height <= 29 && g.chip.top < g.s3top && g.back.right <= g.next.left && g.next.right <= g.vw && /CHECK/.test(g.chk), `phone: the rating is a slim row under the image and the view buttons (${g.chk}, ${g.chip.height} px)`);
    ok(g.row.height <= 36 && g.s4.height <= 36, `phone: closed steps are one line (${g.row.height} px)`);
    ok(g.views === "Art|Compare|Print|Press|Stack" && /cur/.test(g.prog.split(",")[2]), `phone: views Art, Compare, Print, Press, Stack; the step strip marks step 3 (${g.prog})`); }
  ok(await pg.isVisible("#advTog") && await pg.isHidden("#hTune") && await pg.isVisible("#scrList") && /Advanced\s*\[\+\]/.test(await pg.textContent("#advTog")), "phone: the color cards are in the step; the settings are folded into Advanced [+]");
  await pg.evaluate(() => document.getElementById("advTog").click()); ok(await pg.isVisible("#hTune") && await pg.isVisible('[data-auto="3"]') && /\[−\]/.test(await pg.textContent("#advTog")) && await pg.getAttribute("#advTog", "aria-expanded") === "true", "phone: Advanced opens them with Auto and Default, and shows [−]");
  await pg.evaluate(() => document.getElementById("advTog").click()); ok(await pg.isHidden("#hTune"), "phone: Advanced [−] folds them again");
  await pg.evaluate(() => document.getElementById("step3Btn").click()); await pg.waitForTimeout(300);
  ok(await pg.isHidden("#step3Body") && await pg.textContent("#step3Act") === "[+]" && await pg.evaluate(() => document.getElementById("step3").getBoundingClientRect().height <= 36), "phone: [−] folds the open step to one line with [+]");
  await pg.evaluate(() => document.getElementById("step3Btn").click()); await pg.waitForTimeout(300);
  ok(!(await pg.isHidden("#step3Body")) && await pg.textContent("#step3Act") === "[−]", "phone: [+] opens it again with [−]");
  ok(await pg.evaluate(() => { const ends = [1, 2, 3, 4].map(n => { const r = document.createRange(); r.selectNodeContents(document.getElementById(`step${n}Act`)); return Math.round(r.getBoundingClientRect().right); }); const q = document.querySelector(".sstep.open .sthead > .hw button.q"), t = document.querySelector(".sstep.open .sttitle"); return new Set(ends).size === 1 && !!q && q.getBoundingClientRect().left - t.getBoundingClientRect().right < 24; }), "phone: [+] / [−] keep one place at the right edge; ? sits right after the open step's title");
  ok(await pg.evaluate(() => getComputedStyle(document.querySelector("#shirtChips button")).borderTopWidth === "1px" && document.getElementById("teeName").textContent.length > 0), "phone: each garment color sits in a square, and the chosen color is named in the label");
  await pg.click("#mRate"); ok(await pg.isVisible("#rFacts") && await pg.getAttribute("#mRate", "aria-expanded") === "true" && await pg.evaluate(() => Math.abs(document.getElementById("rating").getBoundingClientRect().top - document.getElementById("mRate").getBoundingClientRect().bottom) < 2), "phone: the rating row opens the numbers and checks as a sheet under it");
  await pg.click("#rClose"); ok(await pg.isHidden("#rFacts") && await pg.getAttribute("#mRate", "aria-expanded") === "false", "phone: Close folds the sheet");
  await pg.click("#square"); await pg.waitForTimeout(400); ok(await pg.evaluate(() => !document.body.classList.contains("band") && document.getElementById("square").getBoundingClientRect().height > 300), "phone: tapping the band shows the full square");
  // point readout in Print (desktop size, last so it cannot change the state of the checks above)
  { await pg.setViewportSize({ width: 1280, height: 900 }); await pg.waitForTimeout(500); await pg.click('#view button[data-v="film"]'); await pg.waitForTimeout(1200); await pg.click("#zStep"); await pg.waitForTimeout(800);
    const bx = await pg.locator("#view0").boundingBox(); await pg.mouse.click(bx.x + bx.width * 0.45, bx.y + bx.height * 0.35); await pg.waitForTimeout(1500);
    const here = await pg.$$eval("#scrList .here", els => els.map(e => e.textContent));
    ok(here.length > 0 && here.every(t => /here \d+%/.test(t)), `a tap in Print shows each screen's film % there on the cards (${here.length} cards)`);
  }
  // out of gamut: the hue wheel on black names the colours the shelf cannot mix; a mixed ink each fixes them
  { const idle = () => pg.waitForFunction(() => document.getElementById("auto").textContent === "✓ Auto" && !document.getElementById("run").disabled && /Updated/.test(document.getElementById("status").textContent), null, { timeout: 240000 });
    const idleAny = () => pg.waitForFunction(() => !document.getElementById("run").disabled && /Updated/.test(document.getElementById("status").textContent), null, { timeout: 240000 });
    await pg.setInputFiles("#file", path.join(__dirname, "../test-images/04-hue-wheel-black.png")); await pg.waitForTimeout(800); await idle();
    if (await pg.inputValue("#garment") !== "#111111") { await openStep(2); await pg.click('#shirtChips button[data-hex="#111111"]'); await pg.waitForTimeout(800); await idle(); }
    const card = () => pg.evaluate(() => { const c = [...document.querySelectorAll("#preflight .ck")].find(x => /cannot reach/.test(x.textContent)); return c ? { text: c.textContent, html: c.innerHTML, sw: c.querySelectorAll("ul.gamut li .chip").length, mix: c.querySelector('[data-fix="mixes"]') ? c.querySelector('[data-fix="mixes"]').textContent : "" } : null; });
    const g0 = await card();
    ok(!!g0 && g0.sw >= 1 && /% of the art · prints off by \d+ ΔE/.test(g0.text) && /<b>[A-Z][a-z]+( [a-z]+)*<\/b> #[0-9A-F]{6}/.test(g0.html) && /Add \d mixed inks|Add a mixed ink/.test(g0.mix), `hue wheel on black: the out-of-gamut check names ${g0 ? g0.sw : 0} colours with swatches and ΔE and offers mixed inks${g0 ? "" : " (no card)"}: ${g0 ? g0.text.slice(0, 300) + " | " + g0.mix : await pg.evaluate(() => [document.getElementById("status").textContent, document.getElementById("palSrc").value, document.getElementById("garment").value, document.getElementById("nInks").value, document.getElementById("preflight").textContent.slice(0, 300)].join(" | "))}`);
    { const sh = await pg.evaluate(() => { const c = document.querySelector('#preflight [data-check="out-of-gamut"]'); if (!c) return null; const b = /** @type {HTMLElement} */ (c.querySelector("ul.gamut .ckshow")); const n = c.querySelectorAll("ul.gamut .ckshow").length; b.click(); return { n, ref: b.dataset.region }; });
      await pg.waitForTimeout(400);
      const st1 = await pg.evaluate(() => ({ view: document.body.dataset.view, pressed: document.querySelector('#preflight [data-check="out-of-gamut"] ul.gamut .ckshow').getAttribute("aria-pressed"), note: document.getElementById("viewNote").textContent }));
      ok(!!sh && sh.n === (g0 ? g0.sw : -1) && sh.ref === "gamut:0" && st1.view === "orig" && st1.pressed === "true" && /Marked: [A-Z]/.test(st1.note), `each out-of-gamut colour has Show, which marks it on the art (${sh ? sh.n : 0} buttons; ${st1.note.slice(-80)})`);
      await pg.click('#view button[data-v="film"]'); await pg.waitForTimeout(600);
      ok(await pg.evaluate(() => !/Marked/.test(document.getElementById("viewNote").textContent) && !document.querySelector('#preflight .ckshow[aria-pressed="true"]')), "changing the view clears the mark"); }
    const n0 = +(await pg.inputValue("#nInks"));
    await pg.evaluate(() => /** @type {HTMLElement} */ (document.querySelector('#preflight [data-fix="mixes"]')).click()); await pg.waitForTimeout(800); await idleAny();
    const g1 = await card(), n1 = +(await pg.inputValue("#nInks")), mixes = await pg.$$eval("#scrList .scard .sn", e => e.filter(x => / mix/.test(x.textContent)).length);
    ok(n1 > n0 && mixes >= Math.min(g0 ? g0.sw : 1, 12 - n0) && (!g1 || g1.sw < g0.sw), `Add mixed inks adds ${n1 - n0} mixed screens (${n0} → ${n1}) and the check shrinks (${g0 ? g0.sw : 0} → ${g1 ? g1.sw : 0} colours)`);
    // mesh follows the LPI: 45 → 230, 55 → 280 on the colour screens, in the note and on the cards
    const meshAt = async lpi => { await pg.evaluate(v => { const e = /** @type {HTMLInputElement} */ (document.getElementById("lpi")); e.value = String(v); e.dispatchEvent(new Event("input")); e.dispatchEvent(new Event("change")); }, lpi);
      await pg.waitForTimeout(800); await idleAny();
      return pg.evaluate(() => ({ note: document.getElementById("meshNote").textContent, cards: [...document.querySelectorAll("#scrList .scard")].map(c => (c.textContent.match(/(\d+) mesh/) || [])[1]).filter(Boolean) })); };
    const m45 = await meshAt(45), m55 = await meshAt(55);
    ok((!/LPI/.test(m45.note) || /45 LPI: 230 for colors/.test(m45.note)) && m45.cards.includes("230") && !m45.cards.includes("280"), `mesh at 45 LPI: 230 for colours (${m45.cards.join("/")}; note: ${m45.note})`);
    ok((!/LPI/.test(m55.note) || /55 LPI: 280 for colors/.test(m55.note)) && m55.cards.includes("280"), `mesh at 55 LPI: 280 for colours (${m55.cards.join("/")})`); }
  };
  // The fewer-screens note at phone and computer width, on a fresh page (switching this page's width earlier moves the
  // side panel and upsets the Inspect checks above): it fits, no sideways scroll, nothing clipped. SHOTS=dir saves pictures.
  const fewerNote = async () => { const shots = process.env.SHOTS, p2 = await b.newPage({ viewport: { width: 390, height: 900 } }); p2.on("pageerror", e => errors.push(e.message));
    await p2.goto(url); await p2.waitForTimeout(500); await p2.click("#trySample");
    await p2.waitForFunction(() => !document.getElementById("fewerNote").hidden && document.getElementById("busyMask").hidden && /Updated/.test(document.getElementById("status").textContent), null, { timeout: 300000 });
    if (await p2.isHidden("#step3Body")) await p2.click("#step3Btn");
    const fits = async (w, name) => { await p2.setViewportSize({ width: w, height: 900 }); await p2.waitForTimeout(500); await p2.locator("#fewerNote").scrollIntoViewIfNeeded();
      const fit = await p2.evaluate(() => { const n = document.getElementById("fewerNote"), r = n.getBoundingClientRect(); return document.documentElement.scrollWidth <= innerWidth && r.right <= innerWidth + 0.5 && [...n.querySelectorAll("button")].every(b => b.getBoundingClientRect().right <= r.right + 0.5 && b.scrollWidth <= b.clientWidth + 1); });
      if (shots) await p2.locator("#notice").screenshot({ path: path.join(shots, name) }); return fit; };
    ok(await fits(390, "fewer-note-390.png") && await fits(1280, "fewer-note-1280.png"), "the fewer-screens note fits at 390 and 1280 px (no sideways scroll, no clipped button)");
    await p2.click("#fewerBtns button >> nth=0"); await p2.waitForFunction(() => !!document.querySelector('#fewerBtns button[data-screens="auto"]') && document.getElementById("busyMask").hidden, null, { timeout: 180000 });
    ok(await fits(390, "fewer-note-picked-390.png") && await fits(1280, "fewer-note-picked-1280.png"), "after a tap the note (your count marked, Auto's count to go back) fits at 390 and 1280 px");
    await p2.close(); };
  // A touch phone the size of an iPhone SE: the sample link is on the first screen, and the zoom slider row only takes
  // sideways drags (an up/down drag that starts on it scrolls the page and leaves the zoom alone)
  const phoneSE = async () => { const { devices } = require("playwright"), ctx = await b.newContext({ ...devices["iPhone SE"] }), ph = await ctx.newPage(), cdp = await ctx.newCDPSession(ph);
    await ph.goto(url); await ph.waitForTimeout(800);
    const first = await ph.evaluate(() => { const x = document.getElementById("dropSample").getBoundingClientRect(), bar = document.getElementById("mNav").getBoundingClientRect(), hit = document.elementFromPoint(x.left + x.width / 2, x.top + x.height / 2); const d = document.getElementById("drop").getBoundingClientRect(), rg = document.createRange(); rg.selectNodeContents(document.getElementById("dropSample")); const lines = new Set([...rg.getClientRects()].map(r => Math.round(r.top))).size; return { bottom: x.bottom, bar: bar.top, hit: hit && hit.id, x: x.left + x.width / 2, y: x.top + x.height / 2, inBox: x.top >= d.top && x.bottom <= d.bottom && x.left >= d.left && x.right <= d.right, oneLine: lines === 1, lines, centered: Math.abs((rg.getBoundingClientRect().left + rg.getBoundingClientRect().right) / 2 - (d.left + d.right) / 2) <= 2 }; });
    let picker = false; ph.on("filechooser", () => { picker = true; });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: first.x, y: first.y }] }); await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await ph.waitForFunction(() => /Updated|failed/.test(document.getElementById("status").textContent), null, { timeout: 180000 }); await ph.waitForTimeout(1500);
    ok(first.hit === "dropSample" && first.inBox && first.oneLine && first.centered && first.bottom <= first.bar && !picker && await ph.textContent("#artName") === "Sample design", `iPhone SE: "Try the sample design" is one centered line inside the drop box on the first screen, above Back/Next, and a tap loads the sample without opening the file picker`);
    const drag = async (dx, dy) => { await ph.evaluate(() => scrollTo(0, 0)); await ph.waitForTimeout(300);
      const p = await ph.evaluate(() => { const x = document.getElementById("zoomSlider").getBoundingClientRect(); return [x.left + x.width * 0.3, x.top + x.height / 2]; });
      // what the finger lands on, the zoom and Auto's state before the drag (a CI-only failure: name the cause)
      const pre = await ph.evaluate(([x, y]) => { const h = document.elementFromPoint(x, y); return { hit: h ? (h.id || h.className || h.tagName) : "none", zoom: document.getElementById("zoomPct").textContent, busy: !document.getElementById("busyMask").hidden, status: document.getElementById("status").textContent.slice(0, 40) }; }, p);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: p[0], y: p[1] }] });
      for (let i = 1; i <= 12; i++) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: p[0] + dx * i / 12, y: p[1] + dy * i / 12 }] }); await ph.waitForTimeout(16); }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await ph.waitForTimeout(500);
      return { ...(await ph.evaluate(() => ({ zoom: document.getElementById("zoomPct").textContent, y: scrollY }))), pre }; };
    const up = await drag(0, -180), side = await drag(140, 0);
    ok(up.zoom === "Fit" && up.y > 100, `iPhone SE: an up-drag that starts on the zoom slider scrolls the page and leaves the zoom at Fit (${up.zoom}, scrolled ${up.y} px; before: ${JSON.stringify(up.pre)})`);
    ok(side.zoom !== "Fit" && side.y === 0, `iPhone SE: a sideways drag on the zoom slider zooms (${side.zoom})`);
    await ctx.close(); };
  // Product parity (390 px): jobs, undo, fabric, units, built-in and default profiles, check limits, base halo, test
  // films, press steps, stack map, restore after reload, several jobs. SHOTS=dir keeps a picture of each new control.
  const jobs = async () => { const shots = process.env.SHOTS, ctx = await b.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true }), p3 = await ctx.newPage();
    p3.on("pageerror", e => errors.push(e.message)); p3.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    const shot = async (sel, name) => { if (shots) await p3.locator(sel).screenshot({ path: path.join(shots, name) }); };
    const ready = async () => { await p3.waitForFunction(() => window.sepReady, null, { timeout: 120000 }); };
    const settled = async () => { await p3.waitForTimeout(300); await p3.waitForFunction(() => /Updated|failed|Undone|Redone/.test(document.getElementById("status").textContent) && document.getElementById("busyMask").hidden, null, { timeout: 180000 }); await p3.waitForTimeout(900); };
    const val = id => p3.evaluate(i => document.getElementById(i).value, id), set = (id, v) => p3.evaluate(([i, x]) => { const e = document.getElementById(i); if (e.type === "checkbox") e.checked = x; else e.value = String(x); e.dispatchEvent(new Event("input", { bubbles: true })); e.dispatchEvent(new Event("change", { bubbles: true })); }, [id, v]);
    const wide = () => p3.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    const step = async n => { if (await p3.isHidden(`#step${n}Body`)) await p3.click(`#step${n}Btn`); };
    await p3.goto(later); await ready();
    ok(await p3.isVisible("#jobBar") && await p3.isDisabled("#undo") && (await p3.$$eval("#jobSel option", o => o.length)) === 1 && await wide(), "jobs bar: one new job, Undo off, fits 390 px");
    await shot("#jobBar", "jobs-bar-390.png");
    await p3.click("#dropSample"); await settled();
    ok(/Sample design/.test(await p3.textContent("#jobSel")), "jobs bar: the job takes the art's name once it is kept");
    await step(2); await p3.selectOption("#fabric", "fleece"); await p3.waitForTimeout(700);
    ok(await val("choke") === "0.35" && /0\.35 mm/.test(await p3.textContent("#fabricNote")) && /Fleece/.test(await p3.textContent("#step2Sum")), "fabric: fleece sets a 0.35 mm choke and names the base, flash and choke");
    await shot("#step2Body", "fabric-390.png");
    ok(!(await p3.isDisabled("#undo")), "undo: a change makes Undo available");
    await p3.click("#undo"); await settled();
    ok(await val("fabric") === "cotton" && await val("choke") === "0.2" && !(await p3.isDisabled("#redo")), "undo: Undo puts the fabric and the choke back; Redo is on");
    await p3.click("#redo"); await settled(); ok(await val("fabric") === "fleece" && await val("choke") === "0.35", "undo: Redo puts the fleece back");
    await set("choke", 0.1); await p3.waitForTimeout(800);
    const halo = () => p3.$('#preflight [data-check="base-halo"]');
    ok(!!(await halo()) && /Choke 0\.2 mm/.test(await p3.textContent('#preflight [data-check="base-halo"]')), "base halo: a 0.1 mm choke on a manual press is a warning with Choke 0.2 mm");
    await p3.click("#mRate"); await p3.waitForTimeout(500); await shot('#preflight [data-check="base-halo"]', "check-base-halo-390.png");
    await p3.click('#preflight [data-check="base-halo"] [data-fix]'); await p3.waitForTimeout(600);
    ok(await val("choke") === "0.2" && !(await halo()), "base halo: the fix sets the choke to the drift and the warning goes");
    if (await p3.isVisible("#rClose")) await p3.click("#rClose");
    // merge one screen into another, then Undo
    { await step(3); const cards = () => p3.$$eval("#scrList .scard", c => c.length), n0 = await cards(), c2 = "#scrList .scard:nth-child(3)";
      await p3.click(`${c2} .sexp`); await p3.waitForTimeout(300); await shot(`${c2}`, "merge-card-390.png");
      const into = await p3.$eval(`${c2} [data-merge] option:nth-child(2)`, o => o.textContent);
      await p3.selectOption(`${c2} [data-merge]`, { index: 1 }); await settled();
      ok(await cards() === n0 - 1, `merge: ${into} leaves one screen fewer (${n0} to ${await cards()})`);
      await p3.click("#undo"); await settled(); ok(await cards() === n0, "merge: Undo brings the screen back"); }
    // Shop setup: units, built-in profiles, default profile, check limits, test films
    await p3.click("#mShop"); await p3.waitForTimeout(300);
    await p3.selectOption("#units", "cm"); await p3.waitForTimeout(300);
    await p3.click('[data-close="shopPanel"]'); await step(2);
    ok(await p3.isVisible("#outWcm") && await val("outWcm") === "27.94" && /27\.9 × /.test(await p3.textContent("#step2Sum")), "units: in cm, the width shows 27.94 cm and the summary is in cm");
    await shot("#whCm", "units-cm-390.png");
    await set("outWcm", 20); await settled(); ok(await val("outW") === "7.87", `units: 20 cm wide is a 7.87 in print (${await val("outW")})`);
    await p3.click("#mShop"); await p3.waitForTimeout(300); await p3.selectOption("#units", "in"); await p3.waitForTimeout(200);
    await shot('section[aria-labelledby="hUnits"]', "units-390.png");
    const opts = await p3.$$eval("#profSel option", o => o.map(x => x.textContent));
    ok(opts.includes("Manual press, 45 LPI") && opts.includes("Automatic press, 55 LPI") && opts.includes("Automatic press, 65 LPI"), "profiles: three built-in press profiles in the list");
    await p3.selectOption("#profSel", "Automatic press, 55 LPI"); await p3.waitForTimeout(200);
    ok(await p3.isVisible("#profSrc") && /not press-tested/.test(await p3.textContent("#profSrc")) && /UltraSeps/.test(await p3.textContent("#profSrc")) && await p3.isDisabled("#profDelete"), "profiles: a built-in names its sources, is not press-tested, and cannot be deleted");
    await p3.click("#profLoad"); await settled();
    ok(await val("lpi") === "55" && await val("press") === "automatic" && await val("meshColor") === "305", "profiles: Use profile sets 55 LPI, the automatic press and 305 mesh");
    await p3.selectOption("#profDefault", "Automatic press, 55 LPI"); await p3.waitForTimeout(200);
    await shot('section[aria-labelledby="hProf"]', "profiles-builtin-default-390.png");
    await set("press", "manual"); await settled(); await set("manualMaxLpi", 50); await p3.waitForTimeout(800);
    ok(/50 LPI on a manual press/.test(await p3.textContent("#preflight")), "check limits: a 50 LPI limit for a manual press flags 55 LPI");
    await set("manualMaxLpi", 55); await p3.waitForTimeout(400); ok(!/LPI too high/.test(await p3.textContent("#preflight")), "check limits: back at 55, no LPI warning");
    await p3.selectOption("#tfParam", "minDot"); ok(await val("tfValues") === "2, 4, 6, 8, 10", "test films: each setting has its standard steps");
    const [tf] = await Promise.all([p3.waitForEvent("download", { timeout: 60000 }), p3.click("#tfMake")]); const tfp = await tf.path(), tfb = fs.readFileSync(tfp);
    ok(tf.suggestedFilename() === "test-film-mindot.pdf" && tfb.slice(0, 5).toString() === "%PDF-" && tfb.length > 2000 && /5 rows/.test(await p3.textContent("#tfNote")), `test films: a one-page PDF with 5 rows (${tfb.length} bytes)`);
    await set("tfValues", "4"); await p3.click("#tfMake"); await p3.waitForTimeout(200); ok(/List 2 to 8 values/.test(await p3.textContent("#tfNote")), "test films: one value is refused in plain words");
    await set("tfParam", "lpi"); await shot('section[aria-labelledby="hTest"]', "test-films-390.png");
    await shot('section[aria-labelledby="hProf"] .two', "check-limits-390.png");
    await p3.click('[data-close="shopPanel"]');
    // press steps and the stack map
    await p3.click('#view button[data-v="press"]'); await p3.waitForTimeout(1500);
    const n = await p3.evaluate(() => document.querySelectorAll("#chipBar .chip").length || 0), t1 = await p3.textContent("#psText");
    ok(await p3.isVisible("#pressBar") && /^Screen (\d+) of \1: .*then cure$/.test(t1) && await p3.isDisabled("#psNext"), `press steps: opens on the last screen, then cure (${t1})`);
    await p3.click("#psPrev"); await p3.waitForTimeout(1200); const t2 = await p3.textContent("#psText");
    ok(/^Screen \d+ of \d+/.test(t2) && t2 !== t1 && await p3.evaluate(() => /^Press: the print on the garment after screen \d+/.test(document.getElementById("viewNote").textContent)), `press steps: ◀ shows the print one screen earlier (${t2})`);
    await p3.evaluate(() => { const p = document.getElementById("psPrev"); for (let i = 0; i < 20; i++) p.click(); }); await p3.waitForTimeout(1500);
    ok(/^Screen 1 of \d+: Underbase, then flash$/.test(await p3.textContent("#psText")), `press steps: screen 1 is the underbase, then flash (${await p3.textContent("#psText")})`);
    await p3.waitForFunction(() => document.getElementById("busyMask").hidden, null, { timeout: 60000 }); await shot("#pressBar", "press-steps-390.png"); await shot("#square", "press-steps-print-390.png");
    await p3.click('#view button[data-v="film"]'); await p3.waitForTimeout(500); ok(await p3.isHidden("#pressBar"), "press steps: Print shows every screen again");
    await p3.click('#view button[data-v="stack"]'); await p3.waitForTimeout(500); await p3.waitForFunction(() => document.getElementById("busyMask").hidden, null, { timeout: 60000 });
    ok(/^Stack:/.test(await p3.textContent("#viewNote")) && await wide(), "stack map: the Stack view explains its colors and fits 390 px");
    await shot("#square", "stack-map-390.png"); await shot("#viewBar", "view-bar-390.png");
    // the job comes back after a reload, as it was
    await p3.waitForTimeout(1200); await p3.reload(); await ready(); await settled();
    ok(/Restored Sample design/.test(await p3.textContent("#jobNote")) && await val("lpi") === "55" && await val("fabric") === "fleece" && await p3.textContent("#artName") === "Sample design", "restore: after a reload the job is back (art, 55 LPI, fleece)");
    await shot("#jobNote", "restored-390.png");
    // ?screen=N opens that screen's film in Print; a screen the job does not have says which it has
    await p3.goto(later + "&screen=2"); await ready(); await settled();
    { const g = await p3.evaluate(() => ({ view: document.body.dataset.view, cur: [...document.querySelectorAll("#scrList .scard.cur .so")].map(e => e.textContent).join(","), n: document.querySelectorAll("#scrList .scard").length }));
      ok(g.view === "film" && g.cur === "2", `?screen=2 opens screen 2's film in Print (view ${g.view}, open ${g.cur || "none"})`);
      await p3.goto(later + "&screen=99"); await ready(); await settled();
      ok(new RegExp(`^\\?screen=99: this job has screens 1 to ${g.n}\\.$`).test(await p3.textContent("#jobNote")), "?screen=99: the job note names the screens the job has"); }
    await p3.goto(later); await ready(); await settled();
    await p3.click("#jobNew"); await p3.waitForLoadState("load"); await ready(); await p3.waitForTimeout(500);
    ok((await p3.$$eval("#jobSel option", o => o.length)) === 2 && await p3.isVisible("#drop") && await val("lpi") === "55" && await val("press") === "automatic", "several jobs: New opens an empty second job with the default profile (55 LPI, automatic)");
    await p3.selectOption("#jobSel", { index: 0 }); await p3.waitForLoadState("load"); await ready(); await settled();
    ok(await p3.textContent("#artName") === "Sample design" && await val("fabric") === "fleece", "several jobs: choosing the first job opens it with its art and settings");
    await shot("#jobBar", "jobs-two-390.png");
    await p3.click("#jobClose"); await p3.waitForLoadState("load"); await ready(); await p3.waitForTimeout(500);
    ok((await p3.$$eval("#jobSel option", o => o.length)) === 1 && await p3.isVisible("#drop"), "several jobs: Close removes the job and opens the one left");
    await ctx.close(); };
  // v1 surface: the groups marked data-later are not shown and cannot be reached; ?later=1 shows them
  const v1Surface = async () => { const IDS = ["jobSel", "jobNew", "jobClose", "impOpen", "setupMin", "perHour", "ptLine", "fDCS", "dotShape", "profSel", "profSave", "profSrc", "minPpi", "units", "tfMake", "reportCopy"];
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 } }), v1 = await ctx.newPage(); v1.on("pageerror", e => errors.push(e.message));
    // shown: the control has a box on the page, or its data-later group is displayed (its step or panel may be closed)
    const look = () => v1.evaluate(ids => { for (const d of document.querySelectorAll("dialog")) if (!d.open) d.showModal(); for (const e of document.querySelectorAll(".stbody")) /** @type {HTMLElement} */ (e).hidden = false;
      const shown = ids.filter(i => { const e = document.getElementById(i); return e.getClientRects().length > 0 || getComputedStyle(e.closest("[data-later]")).display !== "none"; });
      const r = { shown, tabs: [...document.querySelectorAll("#view button")].filter(x => x.getClientRects().length).map(x => x.textContent).join(" "), help: !!document.querySelector('#helpList .hitem[data-k="jobs"]'), helpViews: !!document.querySelector('#helpList .hitem[data-k="pressSteps"]'),
        shop: [...document.querySelectorAll("#shopPanel h2")].filter(h => h.getClientRects().length).map(h => h.textContent.replace(/\?$/, "")).join(" | ") };
      for (const d of document.querySelectorAll("dialog")) d.close(); return r; }, IDS);
    await v1.goto(url); await v1.waitForFunction(() => window.sepReady, null, { timeout: 120000 });
    await v1.evaluate(() => localStorage.setItem("sepbench.units", '"cm"')); await v1.reload(); await v1.waitForFunction(() => window.sepReady, null, { timeout: 120000 });
    ok(await v1.evaluate(() => !document.getElementById("whIn").hidden && document.getElementById("whCm").hidden), "v1 surface: with no Units control the print size is in inches, also when this browser kept centimetres");
    await v1.evaluate(() => localStorage.removeItem("sepbench.units"));
    const jb = await v1.evaluate(() => { const r = document.getElementById("jobBar").getBoundingClientRect(); return { h: Math.round(r.height), undo: document.getElementById("undo").getClientRects().length > 0 && document.getElementById("redo").getClientRects().length > 0, q: document.querySelectorAll("#jobBar button.q").length - [...document.querySelectorAll("#jobBar button.q")].filter(x => !x.getClientRects().length).length }; });
    ok(jb.undo && jb.h <= 40 && jb.q === 1, `v1 surface: on a phone Undo and Redo sit in one row with their one ? (${jb.h} px high)`);
    for (const w of [390, 1024, 1280]) { await v1.setViewportSize({ width: w, height: 900 }); await v1.waitForTimeout(300);
      const t = await v1.evaluate(() => [...document.querySelectorAll("#view button")].filter(x => x.getClientRects().length).map(x => { const s = document.createElement("span"); s.textContent = x.textContent; s.style.whiteSpace = "nowrap"; x.textContent = ""; x.appendChild(s); const fits = s.getBoundingClientRect().width <= x.clientWidth; x.textContent = s.textContent; return [x.textContent, fits]; }));
      ok(t.map(x => x[0]).join(" ") === "Art Compare Print" && t.every(x => x[1]), `v1 surface: three view tabs, each with its whole word, at ${w} px (${t.map(x => x[0]).join(" ")})`); }
    await v1.setViewportSize({ width: 390, height: 844 });
    await v1.evaluate(() => /** @type {HTMLElement} */ (document.querySelector('#view button[data-v="press"]')).click());
    ok(await v1.evaluate(() => document.body.dataset.view) === "film" && await v1.isHidden("#pressBar"), "v1 surface: a view with no tab opens Print");
    const a = await look();
    ok(a.shown.length === 0 && !a.help && !a.helpViews, `v1 surface: the later controls are not shown, and Help does not explain them${a.shown.length ? " (shown: " + a.shown.join(" ") + ")" : ""}`);
    ok(a.shop === "Shop setup | Ink library | Calibration | Platen, film and screen | Color targets" && await v1.evaluate(() => ["meshBase", "szPlaten", "mirror", "fabric", "undo"].every(i => !document.getElementById(i).closest("[data-later]"))), `v1 surface: Shop setup begins with the ink library and the calibration (${a.shop}); mesh, sizes, mirror and fabric stay`);
    await v1.goto(later); await v1.waitForFunction(() => window.sepReady, null, { timeout: 120000 });
    const c = await look();
    ok(c.shown.length === IDS.length && c.tabs === "Art Compare Print Press Stack" && c.help && c.helpViews && /Shop and press profiles/.test(c.shop) && /Report a problem/.test(c.shop), `?later=1 shows them: ${c.shown.length} of ${IDS.length} controls, tabs ${c.tabs}`);
    await ctx.close(); };
  // the sections in the order they run, each with its part
  for (const [k, run] of /** @type {[number, () => Promise<void>][]} */ ([[1, basics], [2, inspect], [3, exportAndShop], [4, fewerNote], [2, phoneSE], [4, jobs], [4, v1Surface]])) if (!part || part === k) await run();
  ok(errors.length === 0, `no console errors${errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""}`);
  await b.close(); console.log(fails ? `${fails} FAILED` : part ? `part ${part} passed` : "all passed"); process.exit(fails ? 1 : 0);
})();
