// Browser end-to-end check: page loads, each separation type runs, export ZIP has the expected films, no console errors.
//   npm start (in another shell), then: node tests/e2e.cjs [http://127.0.0.1:8369/] [--part K]
// --part K (1 to 4) runs one of four parts of about equal length; CI runs the four at the same time. No flag: everything.
const { chromium } = require("playwright"), fs = require("fs"), path = require("path"), os = require("os");
const JSZip = require(path.join(__dirname, "../.cache/node_modules/jszip"));
(async () => {
  // later: the page with the groups marked data-later shown (?later=1). The checks that drive one of them (profiles, DCS, dot
  // shape, press time, re-proof, report, units, test films, Press and Stack views) run on it; the page a
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
  ok(/^Cream line work .* prints as solid White/.test(await pg.textContent("#lineText")) && /Add a Cream screen/.test(await pg.textContent("#lineAdd")) && await pg.isVisible("#sugTog") && await pg.isHidden("#lineNote"), "the sample's cream line work is offered its own screen: [+] in the screens row, its row closed");
  ok(!(await pg.isHidden("#step2Body")) && await pg.textContent("#step1Badge") === "✓" && await pg.textContent("#sth1") === "1 Artwork" && await pg.isHidden("#drop"), "step 1 is done (✓, number in the title) and step 2 opens");
  ok(/^\d\.\d$/.test(await pg.textContent("#rStars")) && /ΔE/.test(await pg.textContent("#rFacts")), `print rating shown: ${await pg.textContent("#rStars")} stars`);
  ok(/^· model · \d+\.\d ΔE on press$/.test(await pg.textContent("#mrDe")) && /a model number/.test(await pg.getAttribute("#dRate", "aria-label") || ""), "the rating says the score is a model number (the short line of the phone row, the row's label)");
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
  // theme: the switch under Shop setup sets the scheme, and the browser keeps the pick
  { await pg.click("#themeSeg [data-v=dark]");
    ok(await pg.evaluate(() => document.documentElement.dataset.scheme === "dark" && getComputedStyle(document.body).backgroundColor === "rgb(42, 42, 45)" && JSON.parse(localStorage.getItem("sepbench.theme")) === "dark"), "theme: Dark sets the charcoal page and is kept in the browser");
    await pg.click("#themeSeg [data-v=light]");
    ok(await pg.evaluate(() => document.documentElement.dataset.scheme === "light" && getComputedStyle(document.body).backgroundColor === "rgb(248, 234, 199)"), "theme: Light sets the manila page");
    await pg.click("#themeSeg [data-v=device]");
    ok(await pg.evaluate(() => document.documentElement.dataset.theme === "device" && document.querySelector("#themeSeg [data-v=device]").getAttribute("aria-pressed") === "true"), "theme: Device follows the device again"); }
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
  ok(await pg.evaluate(() => !!document.querySelector('#paneSide .pstate [data-auto]') && !!document.querySelector('[data-def="3"]') && !!document.querySelector('[data-def="2"]') && !document.querySelector(".autodef, .atag") && !document.getElementById("fine") && !document.getElementById("selCard") && !document.getElementById("inks") && !document.getElementById("chanBox") && !document.getElementById("order")), "Advanced is settings only, with Back to Auto at the top and Default at the bottom of the step (no Fine-tune, no ink list, no screen card, no chip row, no press table)");
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
  await pg.click('#view button[data-v=cmp]'); await pg.waitForTimeout(300); ok(!(await pg.$("#diffT, .difftog")) && await pg.getAttribute('#view button[data-v=cmp]', "aria-pressed") === "true", "the page has no Differences switch; Compare is a view tab");
  await pg.click("h1");
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
  ok(await pg.evaluate(() => [document.getElementById("auto"), document.getElementById("advAuto")].every(b => b.textContent === "✓ Auto" && b.classList.contains("on"))), "after Auto, Auto is green on Color screens and in the line at the top of Advanced");
  // Advanced rows: the mark in front of a setting says who set its value
  { await openStep(3);
    const marks = () => pg.evaluate(() => Object.fromEntries([...document.querySelectorAll("#paneSide [data-pm]")].map(m => [m.dataset.pm, m.dataset.k])));
    const m0 = await marks(), green = Object.keys(m0).filter(k => m0[k] === "auto"), line = () => pg.textContent("#advHand");
    ok(["minDot", "trap", "smooth"].every(k => m0[k] === "auto") && green.every(k => ["minDot", "trap", "smooth", "palSrc", "opacity", "choke"].includes(k)) && Object.values(m0).every(k => k !== "hand") && m0.gain === "std" && await line() === "all values from Auto"
      && await pg.evaluate(() => getComputedStyle(document.querySelector('[data-pm="trap"]')).backgroundColor === getComputedStyle(document.getElementById("advAuto")).color && getComputedStyle(document.querySelector('[data-pm="gain"]')).backgroundColor === "rgba(0, 0, 0, 0)"),
      `after Auto the settings Auto chose have the green mark (${green.join(", ")}), the standard ones an empty mark, and the line says all values are from Auto`);
    ok(await pg.evaluate(() => [...document.querySelectorAll("#paneSide .pgrp")].map(d => d.open).join() === "true,true,false,true,true,false,false" && document.querySelector("#press option[value=automatic]").textContent === "Automatic" && !document.querySelector('[data-pm="lpi"], [data-pm="press"]')),
      "the groups Dot limits, Edges and Shirt start closed; the Press option reads Automatic; LPI and Press have no mark");
    const sum = k => pg.textContent(`#paneSide [data-sum="${k}"]`), set = (id, v) => pg.evaluate(([id, v]) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event("input")); e.dispatchEvent(new Event("change")); }, [id, v]);
    const trap0 = await pg.inputValue("#trap"), s0 = await sum("edges");
    ok(s0 === `trap ${trap0} mm · clean · solid` && await pg.isVisible('#paneSide [data-sum="edges"]') && await pg.isHidden("#trap") && await pg.isHidden('#paneSide [data-sum="inks"]'), `a closed group shows its values in one line (${s0}); an open group shows its rows`);
    await set("trap", "0.15"); await done();
    ok(await sum("edges") === "trap 0.15 mm · clean · solid" && (await marks()).trap === "hand" && await line() === "1 set by hand" && await pg.textContent("#advAuto") === "Auto" && await pg.textContent("#auto") === "Auto"
      && await pg.evaluate(() => { const m = document.querySelector('[data-pm="trap"]'); return m.tagName === "BUTTON" && getComputedStyle(m).backgroundColor === getComputedStyle(document.body).color; }),
      "a value changed by hand gets the dark mark, the line says 1 set by hand, and the closed group's line shows the new value");
    await pg.evaluate(() => { document.querySelector('[data-pm="trap"]').closest("details").open = true; }); await pg.click('button[data-pm="trap"]'); await done();
    ok(await pg.inputValue("#trap") === trap0 && (await marks()).trap === "auto" && await line() === "no value set by hand" && await sum("edges") === s0, `pushing the dark mark gives that value back to Auto (trap ${trap0} mm) with the green mark`);
    await set("trap", "0.15"); await set("gain", "30"); await done(); ok(await line() === "2 set by hand", "two values set by hand are counted");
    await pg.click("#paneSide .pstate [data-auto]"); await pg.waitForFunction(() => document.getElementById("auto").textContent === "✓ Auto", null, { timeout: 180000 }); await done();
    const m1 = await marks();
    ok(Object.values(m1).every(k => k !== "hand") && m1.trap === "auto" && await pg.inputValue("#trap") === trap0 && await pg.inputValue("#gain") === "22" && await line() === "all values from Auto" && await pg.textContent("#advAuto") === "✓ Auto", "Back to Auto clears every dark mark and runs Auto again"); }
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
  ok(await pg.evaluate(() => { const b = document.querySelector('[data-def="3"]'), ids = ["palSrc", "smooth", "rare", "forceWhite", "cleanSpot", "solidDetail", "ubMode", "ubStrength", "choke", "trap", "opacity"];
    return !b.nextElementSibling && b.closest(".sidesec").dataset.for === "3" && ids.every(i => document.querySelector(`[data-pm="${i}"]`).dataset.k === "std") && document.getElementById("smooth").value === "0.1" && document.getElementById("trap").value === "0.4"
      && [document.getElementById("auto"), document.getElementById("advAuto")].every(b => b.textContent === "Auto") && document.getElementById("advHand").textContent === "no value set by hand"; }), "Default, at the bottom of the step's Advanced settings, sets the step's standard values (empty marks) and turns Auto off");
  await pg.evaluate(() => document.querySelector("#paneSide .pstate [data-auto]").click()); await pg.waitForTimeout(500); await done(); await pg.waitForTimeout(300);
  ok(await pg.textContent("#auto") === "✓ Auto" && await pg.evaluate(() => !document.querySelector("#paneSide .pm.hand[data-pm]") && document.querySelector('[data-pm="trap"]').dataset.k === "auto"), "Back to Auto in Advanced runs Auto again");
  await pg.evaluate(() => { const s = document.getElementById("rare"); s.value = "0.002"; s.dispatchEvent(new Event("input")); s.dispatchEvent(new Event("change")); }); await done();
  ok(await pg.textContent("#auto") === "Auto" && await pg.evaluate(() => document.querySelector('[data-pm="rare"]').dataset.k === "hand" && document.getElementById("advHand").textContent === "1 set by hand"), "changing an Advanced setting marks it set by hand and turns Auto off");
  await pg.click("#run"); await done(); ok(await pg.textContent("#auto") === "Auto", "Separate keeps the manual setting");
  await pg.evaluate(() => document.querySelector("#paneSide .pstate [data-auto]").click()); await pg.waitForTimeout(500); await done(); await pg.waitForTimeout(300);
  await pg.click("#helpOpen"); await pg.fill("#helpQ", "mesh"); const hits = await pg.evaluate(() => [...document.querySelectorAll("#helpList .hitem")].filter(d => !d.hidden).length);
  ok(hits >= 2 && await pg.isVisible("#helpPanel"), `help search for "mesh" finds ${hits} answers`);
  { const href = await pg.evaluate(() => /** @type {HTMLAnchorElement} */ (document.getElementById("helpChanges")).href), r = await pg.request.get(href), body = await r.text();
    ok(r.ok() && /^# Changelog/.test(body) && /Separation Table version \d+\.\d+\.\d+/.test(await pg.textContent("#helpVersion")), "Help: the version, and Changelog opens the changelog"); }
  await pg.fill("#helpQ", "zzqx"); ok(await pg.isVisible("#helpNone"), "help search says when nothing matches");
  await pg.fill("#helpQ", ""); await pg.keyboard.press("Escape"); ok(!(await pg.isVisible("#helpPanel")), "Escape closes help");
  ok(await pg.evaluate(() => { const p = document.getElementById("preflight"), c = p.querySelectorAll(".ck").length, t = document.getElementById("drChk").textContent; return c ? !p.hidden && /(Error|Warning|Note) ·/.test(p.textContent) && t === `! ${c} CHECK${c > 1 ? "S" : ""}` : p.hidden && t === "✓ CHECKS"; }), "the pre-print checks show as cards, and the rating line counts them");
  };
  // separation types, print methods, Inspect
  // the screens row (last row under the workspace): label or [+], the suggestion row above it, the information row under it
  const screensRow = async () => { await sample();
    const box = (p, id) => p.evaluate(id => { const r = document.getElementById(id).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, w: r.width, h: r.height }; }, id);
    const chipN = () => pg.$$eval("#chipBar .chip", e => e.length);
    ok(await pg.isHidden("#step3Body") && await pg.isVisible("#scrRow") && await chipN() === await pg.$$eval("#scrList .scard", e => e.length), "screens row: shown with step 3 closed, one square for each screen");
    { const c = await box(pg, "chipBar"), z = await box(pg, "zoomBox"), sq = await pg.$eval("#chipBar .chip", e => { const r = e.getBoundingClientRect(), n = e.nextElementSibling.getBoundingClientRect(); return [r.width, r.height, n.left - r.right]; });
      ok(c.top >= z.bottom && sq.join() === "36,36,3", `screens row: under the zoom row, squares 36 px with 3 px gaps (${sq.join(" ")})`); }
    ok(await pg.isVisible("#sugTog") && await pg.isHidden("#scrLab") && await pg.getAttribute("#sugTog", "aria-expanded") === "false" && await pg.getAttribute("#sugTog", "title") === "Suggested screen: Cream" && await pg.isHidden("#lineNote") && await pg.isHidden("#accentNote"),
      "screens row: a suggested screen shows the dashed [+] in place of the label, its row closed");
    await pg.click("#sugTog");
    { const n = await box(pg, "lineNote"), r = await box(pg, "scrRow"), sw = await pg.$eval("#lineSw", e => getComputedStyle(e).backgroundColor), dash = await pg.$eval("#lineNote", e => getComputedStyle(e).borderTopStyle);
      ok(await pg.isVisible("#lineNote") && n.bottom <= r.top && await pg.getAttribute("#sugTog", "aria-expanded") === "true" && dash === "dashed" && /^rgb\(/.test(sw) && sw !== "rgba(0, 0, 0, 0)" && /^Cream line work \([\d.]+% of the art\) has no ink, so it prints as solid White\. A Cream screen prints it flat in its own color: its color error goes from \d+ to under 4\.$/.test(await pg.textContent("#lineText")) && await pg.isEnabled("#lineAdd"),
        `screens row: [+] opens the dashed suggestion row above the row, with the ink's color, the reason and the add button (${sw})`); }
    await pg.click("#sugTog"); ok(await pg.isHidden("#lineNote") && await pg.getAttribute("#sugTog", "aria-expanded") === "false", "screens row: [+] again closes the suggestion row");
    // a square: its film, and the information row under the squares
    await pg.click("#chipBar .chip >> nth=1"); await pg.waitForTimeout(300);
    { const i = await box(pg, "chipInfo"), r = await box(pg, "scrRow"), t = await pg.evaluate(() => [...document.getElementById("chipInfo").children].map(e => e.textContent)), card = await pg.evaluate(() => { const c = document.querySelectorAll("#scrList .scard")[1]; return [c.querySelector(".so").textContent + " · " + c.querySelector(".sn").firstChild.textContent, c.querySelector(".sl").textContent.split(" · ").slice(0, 2).join(" · ")]; });
      ok(await pg.isVisible("#chipInfo") && i.top >= r.bottom - 0.5 && Math.abs(i.w - r.w) < 1 && t[1] === card[0] && t[2] === card[1] && /^2 · \S/.test(t[1]) && /^\d+\.\d% · \d+ mesh$/.test(t[2]) && !(await pg.$("#chipInfo input, #chipInfo button, #chipInfo select")),
        `screens row: a square opens the information row under the row, full width: ${t[1]}, ${t[2]} (as its card in step 3; nothing to edit)`);
      ok(await pg.evaluate(() => { const c = document.querySelectorAll("#chipBar .chip")[1]; return c.getAttribute("aria-pressed") === "true" && c.classList.contains("cur") && document.body.dataset.view === "film"; }), "screens row: the pushed square is marked and Print shows its film, as before"); }
    await pg.click("#chipBar .chip >> nth=1"); await pg.waitForTimeout(300);
    ok(await pg.isHidden("#chipInfo") && await pg.evaluate(() => !document.querySelector('#chipBar .chip[aria-pressed="true"], #chipBar .chip.cur')), "screens row: the same square again closes the information row and shows all the films");
    // add the suggested screen: one more square, the [+] goes, the label is back
    { const n0 = await chipN(); await pg.click("#sugTog"); await pg.click("#lineAdd"); await done(); await pg.waitForFunction(() => !document.getElementById("run").disabled && document.getElementById("busyMask").hidden, null, { timeout: 180000 });
      ok(await chipN() === n0 + 1 && /Cream/.test(await cardNames()) && await pg.isHidden("#sugTog") && await pg.isHidden("#lineNote") && await pg.isVisible("#scrLab") && await pg.textContent("#scrLab") === "Screens",
        `screens row: the add button adds one screen (${n0} to ${await chipN()}); nothing suggested, so the row closes and the label Screens is back`); }
    // phone: suggestion row, screens row, information row, in that order; 45 px squares, 6 px gaps, the row scrolls sideways
    { const ctx = await b.newContext({ viewport: { width: 390, height: 844 } }), ph = await ctx.newPage(); ph.on("pageerror", e => errors.push(e.message));
      await ph.goto(url); await ph.waitForTimeout(500); await ph.evaluate(() => document.getElementById("trySample").click());
      await ph.waitForFunction(() => document.getElementById("auto").textContent === "✓ Auto" && !document.getElementById("run").disabled && /Updated/.test(document.getElementById("status").textContent), null, { timeout: 180000 });
      await ph.evaluate(() => { document.getElementById("sugTog").click(); const c = /** @type {HTMLElement} */ (document.querySelectorAll("#chipBar .chip")[0]); c.click(); }); await ph.waitForTimeout(400);
      const n = await box(ph, "lineNote"), r = await box(ph, "scrRow"), i = await box(ph, "chipInfo"), g = await ph.evaluate(() => { const row = document.getElementById("scrRow"), c = document.querySelector("#chipBar .chip"), a = c.getBoundingClientRect(), z = c.nextElementSibling.getBoundingClientRect(), t = document.getElementById("sugTog").getBoundingClientRect(), add = document.getElementById("lineAdd").getBoundingClientRect();
        return { sq: [a.width, a.height, z.left - a.right].join(), tog: [t.width, t.height].join(), add: add.height, scrolls: row.scrollWidth > row.clientWidth, doc: document.documentElement.scrollWidth <= innerWidth }; });
      ok(n.h > 0 && i.h > 0 && n.bottom <= r.top && r.bottom <= i.top + 0.5 && n.left >= 0 && n.right <= 390 && i.right <= 390, `phone screens row: suggestion row, screens row, information row, in that order (tops ${Math.round(n.top)}, ${Math.round(r.top)}, ${Math.round(i.top)})`);
      ok(g.sq === "45,45,6" && g.tog === "45,45" && g.add === 45 && g.scrolls && g.doc, `phone screens row: 45 px squares with 6 px gaps, 45 px [+] and add button; the row scrolls sideways, the page does not (${g.sq})`);
      await ctx.close(); }
  };
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
  await pg.evaluate(() => /** @type {HTMLElement} */ (document.querySelector("#paneSide .pstate [data-auto]")).click());
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
  // workspace frame (desktop, 1440 wide): "+ Add ink" is a dashed row above the ink rows; the Advanced header
  { const was = await pg.evaluate(() => { const o = document.querySelector(".sstep.open"); return o ? +o.dataset.step : 0; }); await openStep(3); await pg.waitForTimeout(300);
    const g = await pg.evaluate(() => { const r = e => e.getBoundingClientRect(), a = document.getElementById("addInk"), c = document.querySelector("#scrList .scard"), cs = getComputedStyle(a);
      return { a: r(a), c: r(c), dashed: cs.borderTopStyle, label: document.querySelector("#cardsBox .panelab").firstChild.textContent, h2: document.querySelector("#paneSide .advhd h2").textContent, sub: document.getElementById("sideTitle").textContent, hd: r(document.querySelector("#paneSide .advhd")), x: r(document.getElementById("sideClose")), side: r(document.getElementById("paneSide")) }; });
    ok(g.a.bottom <= g.c.top && Math.abs(g.a.width - g.c.width) < 1 && Math.abs(g.a.height - g.c.height) < 1 && g.dashed === "dashed" && g.label === "Print order", `desktop: "+ Add ink" is a dashed row above the ink rows, the size of one (${Math.round(g.a.width)} × ${Math.round(g.a.height)}), under "${g.label}"`);
    ok(g.h2 === "Advanced Settings" && g.sub === "Separation" && Math.abs(g.hd.left - g.side.left) <= 1 && Math.abs(g.hd.right - g.side.right) <= 1 && g.x.right <= g.hd.right && g.x.left > g.hd.left + g.hd.width / 2, `desktop: the Advanced header reads "${g.h2}" with "${g.sub}" under it and the close button at the right`);
    if (was && was !== 3) await openStep(was); }
  await pg.setViewportSize({ width: 1280, height: 720 }); await pg.evaluate(() => scrollTo(0, 0)); await pg.waitForTimeout(600);
  { const g = await pg.evaluate(() => { const r = id => document.getElementById(id).getBoundingClientRect(); return { rate: r("dRate"), sq: r("square"), vb: r("viewBar"), view: r("view"), pane: r("paneStage"), badge: r("sizeBadge"), vh: innerHeight, rows: [1, 2, 3, 4].map(n => r(`step${n}`)).filter((x, i) => !document.getElementById(`step${i + 1}`).classList.contains("open")).map(x => Math.round(x.height)), w: r("outW").top, hh: r("outH").top, sc: parseFloat(getComputedStyle(document.getElementById("nInks").parentElement).width) }; });
    ok(g.rate.bottom <= g.vh && g.rate.top >= g.sq.bottom - 1 && g.rate.height <= 40, `desktop 1280×720: the rating row sits under the image and inside the window (ends at ${Math.round(g.rate.bottom)} of ${g.vh})`);
    ok(g.view.top >= g.sq.bottom - 1 && g.vb.bottom <= g.rate.top + 1 && g.vb.width <= 640, `desktop: the view switch is below the workspace and above the rating row (workspace ends at ${Math.round(g.sq.bottom)}, switch starts at ${Math.round(g.view.top)})`);
    ok(Math.abs(g.sq.left - g.pane.left) < 1 && Math.abs(g.sq.right - g.pane.right) < 1 && Math.abs(g.sq.top - g.pane.top - 30) < 1 && g.sq.height >= 300, `desktop: the workspace fills the centre column under the 30 px job tabs and above the rows (${Math.round(g.sq.width)} × ${Math.round(g.sq.height)})`);
    ok(g.badge.width > 0 && g.badge.left - g.sq.left <= 12 && g.sq.bottom - g.badge.bottom <= 12 && g.badge.left >= g.sq.left, "desktop: the print size badge is in the bottom left corner of the workspace");
    ok(g.rows.every(h => h <= 40), `desktop: closed steps are one line (${g.rows.join("/")} px)`);
    ok(Math.abs(g.w - g.hh) < 2 && g.sc <= 140, `W and H share a row; Color screens is narrow (${Math.round(g.sc)} px)`); }
  // workspace PR 5: no Differences switch, the view row across the full row, the rating details in the
  // flow, the one-line rating row at 1024 px, the Advanced rail
  { const R = () => pg.evaluate(() => { const r = id => { const b = document.getElementById(id).getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, width: b.width, height: b.height }; }, vis = e => e.getClientRects().length > 0;
      return { sq: r("square"), vb: r("viewBar"), view: r("view"), rate: r("dRate"), rating: r("rating"), data: r("rData"), zoom: r("zoomBox"), scr: r("scrRow"), rail: r("sideOpen"), side: vis(document.getElementById("paneSide")), vh: innerHeight, sw: document.documentElement.scrollWidth, vw: innerWidth,
        views: [...document.querySelectorAll("#view button")].filter(vis).map(b => b.getBoundingClientRect()).map(b => [b.left, b.right, b.top]), stars: vis(document.querySelector("#dRate .stars")), facts: [...document.querySelectorAll("#drFacts > span")].filter(vis).length, noDiff: !document.querySelector("#diffT, .difftog"), inBar: !!document.querySelector("#viewBar .hw") }; });
    const corner = g => g.noDiff && !g.inBar, across = (g, n) => g.views.length === n && Math.abs(g.views[0][0] - g.vb.left) < 1.5 && Math.abs(g.views[n - 1][1] - g.vb.right) < 1.5 && g.views.every(v => Math.abs(v[2] - g.views[0][2]) < 1);
    await pg.setViewportSize({ width: 1440, height: 900 }); await pg.evaluate(() => scrollTo(0, 0)); await pg.waitForTimeout(600);
    const was = await pg.evaluate(() => { const o = /** @type {HTMLElement | null} */ (document.querySelector(".sstep.open")); return o ? +o.dataset.step : 0; }), a = await R();
    ok(corner(a), "desktop 1440: the page has no Differences switch");
    ok(across(a, 5) && Math.abs(a.vb.width - 640) < 1, `desktop 1440: the view row is the view switch alone, across the full 640 px row (${Math.round(a.view.width)} px)`);
    await pg.click('#view button[data-v=film]'); await pg.waitForTimeout(300); const a1 = await R();
    await pg.click("#dRate"); await pg.waitForTimeout(400); const o = await R();
    ok(await pg.isVisible("#rFacts") && await pg.getAttribute("#dRate", "aria-expanded") === "true" && o.data.height > 30 && Math.abs(o.data.top - o.rate.bottom) < 2 && o.view.top >= o.sq.bottom - 1 && o.view.bottom <= o.rate.top + 1 && o.view.bottom <= o.vh && await pg.evaluate(() => { const b = document.getElementById("view").getBoundingClientRect(), e = document.elementFromPoint(b.left + 20, b.top + b.height / 2); return !!e && !!e.closest("#view"); })
      && Math.abs((o.zoom.top - o.rate.bottom) - (a1.zoom.top - a1.rate.bottom) - o.data.height) < 2 && o.scr.top >= o.data.bottom && o.scr.bottom <= o.vh + 1 && o.sq.height >= 300,
      `desktop 1440: the rating details open in the flow under the row: the view switch stays in view and the rows under it move down (details ${Math.round(o.data.height)} px, zoom row ${Math.round(a1.zoom.top)} → ${Math.round(o.zoom.top)})`);
    await pg.click("#dRate"); ok(await pg.isHidden("#rFacts") && await pg.getAttribute("#dRate", "aria-expanded") === "false", "a second push on the rating row folds the details");
    await pg.setViewportSize({ width: 1024, height: 800 }); await pg.waitForTimeout(600); const n = await R();
    ok(n.side && n.rate.height <= 37 && !n.stars && n.facts === 1 && n.sw <= n.vw, `desktop 1024 with Advanced open: the rating row is one line (${Math.round(n.rate.height)} px), without the stars, with the first fact only`);
    await pg.click("#sideClose"); await pg.waitForTimeout(500); const c = await R();
    ok(!c.side && c.rail.width === 36 && c.rail.height === 120 && Math.abs(c.rail.right - c.sq.right) < 1 && Math.abs((c.rail.top + c.rail.bottom) / 2 - (c.sq.top + c.sq.bottom) / 2) < 1.5 && await pg.evaluate(() => getComputedStyle(document.getElementById("sideOpen")).writingMode === "vertical-rl" && document.getElementById("sideOpen").parentElement.id === "square")
      && c.stars && c.facts === 3, `Advanced closed: a vertical Advanced rail button sits at the right edge of the workspace, in the middle (${c.rail.width} × ${c.rail.height}); the rating row has its stars and facts again`);
    await pg.click("#sideOpen"); await pg.waitForTimeout(400); ok(await pg.isVisible("#paneSide") && await pg.isHidden("#sideOpen"), "the rail opens Advanced again and goes");
    if (was) await openStep(was); // the Print view opened step 3
    await pg.setViewportSize({ width: 1280, height: 720 }); await pg.waitForTimeout(400); }
  { const w0 = +(await pg.inputValue("#outW")), h0 = +(await pg.inputValue("#outH")); await pg.evaluate(() => document.querySelector('.stp[data-for=outW][data-d="0.5"]').click()); const w1 = +(await pg.inputValue("#outW")), h1 = +(await pg.inputValue("#outH"));
    ok(w1 === w0 + 0.5 && Math.abs(h1 / w1 - h0 / w0) < 0.01, `W + steps half an inch and H follows the art's shape (${w0}×${h0} → ${w1}×${h1})`);
    const bt = await pg.textContent("#sizeBadge"); ok(bt === `${w1.toFixed(1)} × ${h1.toFixed(1)} in`, `the size badge follows the Width and Height fields (${bt})`);
    await pg.evaluate(() => document.querySelector('.stp[data-for=outW][data-d="-0.5"]').click()); await pg.waitForTimeout(300); }
  await pg.setViewportSize({ width: 390, height: 900 }); ok(await pg.evaluate(() => document.documentElement.scrollWidth <= 390), "no horizontal scroll at phone width");
  await pg.waitForTimeout(400);
  ok(await pg.evaluate(() => getComputedStyle(document.getElementById("square")).position === "sticky"), "phone: the workspace is pinned");
  // workspace PR 5: the phone layout
  { await pg.evaluate(() => scrollTo(0, 0)); await pg.waitForTimeout(500);
    const G = () => pg.evaluate(() => { const r = e => { const b = (typeof e === "string" ? document.getElementById(e) : e).getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, width: b.width, height: b.height }; }, vis = e => e.getClientRects().length > 0, cs = getComputedStyle(document.body);
      const words = e => { const g = document.createRange(); g.selectNodeContents(e); return g; };
      return { head: r(document.querySelector(".mhead")), title: r(words(document.querySelector(".mhead b"))), seg: r("themeSeg"), gear: r("mShop"), sq: r("square"), vb: r("viewBar"), view: r("view"), rate: r("dRate"), data: r("rData"), zoom: r("zoomBox"), scr: r("scrRow"), steps: r("paneSteps"), s1: r("step1"), nav: r("mNav"), back: r("mBack"), next: r("mNext"), prog: r("mProg"), badge: r("sizeBadge"), 
        views: [...document.querySelectorAll("#view button")].filter(vis).map(b => b.getBoundingClientRect()).map(b => [b.left, b.right, b.top, b.height]), segs: document.querySelectorAll("#themeSeg, .tseg").length, segIn: document.getElementById("themeSeg").parentElement.className, segBtn: [...document.querySelectorAll("#themeSeg button")].map(b => b.getBoundingClientRect().height), margin: cs.marginLeft, y: scrollY, vh: innerHeight, vw: innerWidth, sw: document.documentElement.scrollWidth, railGone: !vis(document.getElementById("sideOpen")), footGone: !vis(document.querySelector(".stepfoot")) }; });
    const g = await G(), inRow = e => e.top >= g.head.top && e.bottom <= g.head.bottom;
    ok(g.head.top === 0 && g.head.height === 57 && inRow(g.title) && inRow(g.seg) && inRow(g.gear) && Math.abs(g.title.left - 12) < 0.5 && g.title.right <= g.seg.left && g.seg.right <= g.gear.left && Math.abs(g.gear.right - (g.vw - 12)) < 1 && g.gear.width === 45 && g.gear.height === 45 && g.segBtn.every(h => h === 45),
      `phone: the title row has the title, the theme switch and the setup gear (${g.head.height} px; switch and gear 45 px high)`);
    ok(g.sq.top >= g.head.bottom - 0.5 && g.sq.left === 0 && g.sq.width === g.vw && g.sq.height === 300 && g.vb.top >= g.sq.bottom - 0.5 && g.rate.top >= g.vb.bottom - 0.5 && g.zoom.top >= g.rate.bottom - 0.5 && g.scr.top >= g.zoom.bottom - 0.5 && g.steps.top >= g.scr.bottom - 0.5 && g.s1.top > g.scr.bottom,
      `phone: title row, workspace (300 px), view switch, rating, zoom, screens, then the steps (tops ${[g.head, g.sq, g.vb, g.rate, g.zoom, g.scr, g.steps].map(e => Math.round(e.top)).join(", ")})`);
    ok(g.margin === "0px" && g.view.left === 12 && Math.abs(g.view.right - (g.vw - 12)) < 0.5 && g.rate.left === 12 && g.s1.left === 12 && Math.abs(g.s1.right - (g.vw - 12)) < 0.5 && g.sw <= g.vw, `phone: the rows start 12 px from the edge of the screen and the page has no margin (row ${Math.round(g.view.width)} px of ${g.vw})`);
    ok(g.views.length === 5 && Math.abs(g.views[0][0] - 12) < 1.5 && Math.abs(g.views[4][1] - (g.vw - 12)) < 1.5 && g.views.every(v => v[2] === g.views[0][2] && v[3] === 45) && g.view.height === 45, "phone: the view row is the view switch alone, across the full row, 45 px high");
    ok(g.badge.width > 0 && Math.abs(g.badge.left - 9) < 1 && Math.abs(g.sq.bottom - g.badge.bottom - 10) < 1.5, `phone: the print size badge is in the bottom left corner of the workspace (${await pg.textContent("#sizeBadge")})`);
    ok(g.segs === 1 && /mhead/.test(g.segIn) && g.railGone && g.footGone, "phone: one theme switch, in the title row; the foot of the step column and the Advanced rail do not show");
    ok(Math.abs(g.nav.bottom - g.vh) < 1 && g.prog.height === 3 && g.prog.top >= g.nav.top && g.back.height === 45 && g.next.height === 45 && g.back.left === 12 && g.back.right <= g.next.left && Math.abs(g.next.right - (g.vw - 12)) < 1, "phone: Back and Next are fixed at the bottom with the progress marks (45 px buttons)");
    await pg.click("#themeSeg [data-v=dark]"); const dk = await pg.evaluate(() => [document.documentElement.dataset.scheme, getComputedStyle(document.body).backgroundColor, document.querySelector("#themeSeg [data-v=dark]").getAttribute("aria-pressed")].join());
    await pg.click("#themeSeg [data-v=light]"); const lt = await pg.evaluate(() => [document.documentElement.dataset.scheme, getComputedStyle(document.body).backgroundColor].join());
    await pg.click("#themeSeg [data-v=device]");
    ok(dk === "dark,rgb(42, 42, 45),true" && lt === "light,rgb(248, 234, 199)", `phone: the theme switch in the title row works (${dk})`);
    await pg.click("#mShop"); await pg.waitForTimeout(300); ok(await pg.evaluate(() => document.getElementById("shopPanel").open) && await pg.isVisible("#hShop"), "phone: the gear opens Shop setup");
    await pg.click('#shopPanel [data-close="shopPanel"]'); await pg.waitForTimeout(200);
    // the rating details open in the flow
    const view0 = await pg.getAttribute('#view button[data-v=film]', "aria-pressed"); await pg.click("#dRate"); await pg.waitForTimeout(400); const o = await G();
    ok(await pg.isVisible("#rFacts") && await pg.getAttribute("#dRate", "aria-expanded") === "true" && o.data.height > 30 && Math.abs(o.data.top - o.rate.bottom) < 2 && o.view.top === g.view.top && o.view.bottom <= o.rate.top + 0.5 && await pg.evaluate(() => { const b = document.getElementById("view").getBoundingClientRect(), e = document.elementFromPoint(b.left + 20, b.top + b.height / 2); return !!e && !!e.closest("#view"); })
      && Math.abs((o.zoom.top - g.zoom.top) - (o.data.bottom - o.rate.bottom)) < 8 && Math.abs((o.steps.top - g.steps.top) - (o.zoom.top - g.zoom.top)) < 1 && view0 === "true",
      `phone: the rating row opens the numbers and checks in the flow under it: the view switch stays, the rows under it move down ${Math.round(o.zoom.top - g.zoom.top)} px`);
    await pg.click("#dRate"); ok(await pg.isHidden("#rFacts") && await pg.getAttribute("#dRate", "aria-expanded") === "false", "phone: a second push folds the details");
    // pinned while the page scrolls
    await pg.evaluate(() => scrollTo(0, 400)); await pg.waitForTimeout(400); const p = await G();
    ok(p.y === 400 && Math.abs(p.sq.top - 33) < 0.5 && await pg.evaluate(() => { const t = document.getElementById("tabBar").getBoundingClientRect(); return t.top === 0 && t.height === 33; }) && p.sq.height === 300 && Math.abs(p.s1.top - (g.s1.top - 400)) < 1 && p.head.bottom <= 0 && Math.abs(p.nav.bottom - p.vh) < 1, `phone: the job tabs and the workspace under them stay pinned at the top while the page scrolls (page at ${p.y}, workspace top ${Math.round(p.sq.top)}, step 1 top ${Math.round(p.s1.top)})`);
    await pg.setViewportSize({ width: 320, height: 568 }); await pg.waitForTimeout(500); await pg.evaluate(() => scrollTo(0, 0)); await pg.waitForTimeout(300); const s = await G();
    ok(s.sw <= 320 && s.gear.right <= 320 && s.title.right <= s.seg.left && s.next.right <= 320 && s.sq.height === 192, `no sideways scroll at 320 px: the title's words, the theme switch, the gear, the workspace (192 px high on a short phone) and the bar fit (page ${s.sw} px wide; title ends at ${Math.round(s.title.right)}, switch starts at ${Math.round(s.seg.left)})`);
    await pg.setViewportSize({ width: 390, height: 900 }); await pg.waitForTimeout(500); await pg.evaluate(() => scrollTo(0, 0)); await pg.waitForTimeout(300); }
  ok(await pg.isVisible("#mNav"), "phone: the Back/Next bar shows");
  { const at = await pg.evaluate(() => ({ side: document.getElementById("paneSide").parentElement.id, open: [1, 2, 3, 4].filter(n => !document.getElementById(`step${n}Body`).hidden).map(n => `step${n}Body`) }));
    ok(at.open.includes(at.side), `phone: Advanced sits inside the open step (${at.side}; open: ${at.open.join(", ")})`); }
  await pg.click("#mNext"); await pg.waitForTimeout(600); ok(!(await pg.isHidden("#step3Body")) && await pg.evaluate(() => document.getElementById("paneSide").parentElement.id === "step3Body" && !!document.querySelector("#step3Body #scrList")), "phone: Next opens Separation, with the screens inside it");
  await pg.waitForTimeout(600);
  { const g = await pg.evaluate(() => { const r = id => document.getElementById(id).getBoundingClientRect(); return { sq: r("square"), vb: r("viewBar"), nav: r("mNav"), chip: r("dRate"), row: r("step1"), s4: r("step4"), s3top: r("step3").top, steps: r("paneSteps").top, back: r("mBack"), next: r("mNext"), prog: [...document.querySelectorAll("#mProg i")].map(i => i.className).join(","), views: [...document.querySelectorAll("#view button")].map(b => b.textContent).join("|"), chk: document.getElementById("drChk").textContent, vw: innerWidth }; });
    ok(Math.abs(g.sq.top - 33) < 0.5 && g.sq.height === 300 && g.s3top >= g.sq.bottom - 1 && g.s3top + 54 <= g.nav.top, `phone: Next opens the step under the pinned workspace; the workspace stays on screen (workspace ends at ${Math.round(g.sq.bottom)}, step 3 at ${Math.round(g.s3top)})`);
    ok(g.chip.top >= g.vb.bottom - 0.5 && g.chip.height === 45 && g.chip.bottom <= g.steps && g.back.right <= g.next.left && g.next.right <= g.vw && /CHECK/.test(g.chk), `phone: the rating is one row under the view switch, above the steps (${g.chk}, ${g.chip.height} px)`);
    ok(g.row.height === 53 && g.s4.height === 53, `phone: closed steps are one line with a 51 px touch row (${g.row.height} px)`);
    ok(g.views === "Art|Compare|Print|Press|Stack" && /cur/.test(g.prog.split(",")[2]), `phone: views Art, Compare, Print, Press, Stack; the step strip marks step 3 (${g.prog})`); }
  ok(await pg.isVisible("#advTog") && await pg.isHidden("#palSrc") && await pg.isVisible("#scrList") && /Advanced\s*\[\+\]/.test(await pg.textContent("#advTog")), "phone: the color cards are in the step; the settings are folded into Advanced [+]");
  await pg.evaluate(() => document.getElementById("advTog").click()); ok(await pg.isVisible("#palSrc") && await pg.isVisible("#paneSide .pstate [data-auto]") && await pg.isVisible('[data-def="3"]') && /\[−\]/.test(await pg.textContent("#advTog")) && await pg.getAttribute("#advTog", "aria-expanded") === "true", "phone: Advanced opens them with Back to Auto and Default, and shows [−]");
  { const g = await pg.evaluate(() => { const cs = (e, p) => getComputedStyle(e)[p], t = document.getElementById("advTog"), probe = document.createElement("i"); probe.style.cssText = "background:var(--pri-bg);color:var(--pri-fg)"; document.body.appendChild(probe);
      document.querySelectorAll("#paneSide details.pgrp").forEach(d => { d.open = true; });
      const vis = s => [...document.querySelectorAll(s)].filter(e => e.getClientRects().length), h = e => Math.round(e.getBoundingClientRect().height);
      const out = { tog: cs(t, "backgroundColor") === cs(probe, "backgroundColor") && cs(t, "color") === cs(probe, "color"), togH: h(t), rows: Math.min(...vis("#paneSide .prow").map(h)), n: vis("#paneSide .prow").length,
        ctl: Math.min(...vis("#paneSide .prow .pc input[type=number], #paneSide .prow .pc select, #paneSide .prow .pc .stp, #paneSide .pstate button, #paneSide .pgrp summary, #paneSide .pdef").map(h)), over: document.documentElement.scrollWidth > innerWidth };
      probe.remove(); return out; });
    ok(g.tog && g.togH >= 45 && g.n === 11 && g.rows >= 51 && g.ctl >= 45 && !g.over, `phone: the Advanced button has the contrast colors (${g.togH} px); the ${g.n} rows are at least ${g.rows} px high with controls of at least ${g.ctl} px; nothing is wider than the screen`); }
  await pg.evaluate(() => document.getElementById("advTog").click()); ok(await pg.isHidden("#palSrc"), "phone: Advanced [−] folds them again");
  await pg.evaluate(() => document.getElementById("step3Btn").click()); await pg.waitForTimeout(300);
  ok(await pg.isHidden("#step3Body") && await pg.textContent("#step3Act") === "[+]" && await pg.evaluate(() => document.getElementById("step3").getBoundingClientRect().height === 53), "phone: [−] folds the open step to one line with [+]");
  await pg.evaluate(() => document.getElementById("step3Btn").click()); await pg.waitForTimeout(300);
  ok(!(await pg.isHidden("#step3Body")) && await pg.textContent("#step3Act") === "[−]", "phone: [+] opens it again with [−]");
  { const g = await pg.evaluate(() => { const r = e => e.getBoundingClientRect(), a = document.getElementById("addInk"), cs = [...document.querySelectorAll("#scrList .scard")]; return { a: r(a), last: r(cs[cs.length - 1]), badge: document.getElementById("sizeBadge").getClientRects().length }; });
    ok(g.a.height >= 54 && g.a.top >= g.last.bottom && Math.abs(g.a.width - g.last.width) < 1, `phone 390: "+ Add ink" is a row below the ink rows (${Math.round(g.a.width)} × ${Math.round(g.a.height)})`);
    ok(g.badge === 1, "phone: the size badge shows"); }
  { const q = await pg.evaluate(() => { const b = document.querySelector(".sstep.open .sthead button.q"), r = b.getBoundingClientRect(), cs = getComputedStyle(b), af = getComputedStyle(b, "::after"); return { w: r.width, h: r.height, fs: cs.fontSize, touch: r.width - 2 * parseFloat(af.left) }; });
    ok(q.w === 15 && q.h === 15 && q.fs === "9px" && q.touch === 45, `the ? help button is the mini one (${q.w} px box, ${q.fs} type) with a ${q.touch} px touch area on a phone`); }
  ok(await pg.evaluate(() => { const ends = [1, 2, 3, 4].map(n => { const r = document.createRange(); r.selectNodeContents(document.getElementById(`step${n}Act`)); return Math.round(r.getBoundingClientRect().right); }); const q = document.querySelector(".sstep.open .sthead > .hw button.q"), t = document.querySelector(".sstep.open .sttitle"); return new Set(ends).size === 1 && !!q && q.getBoundingClientRect().left - t.getBoundingClientRect().right < 24; }), "phone: [+] / [−] keep one place at the right edge; ? sits right after the open step's title");
  ok(await pg.evaluate(() => getComputedStyle(document.querySelector("#shirtChips button")).borderTopWidth === "1px" && document.getElementById("teeName").textContent.length > 0), "phone: each garment color sits in a square, and the chosen color is named in the label");
  { const t = await pg.evaluate(() => { const vis = e => e.getClientRects().length > 0, h = e => e.getBoundingClientRect().height; return Math.min(...[...document.querySelectorAll(".sstep.open .stbody button:not(.q):not(.pm), .sstep.open .stbody select, .sstep.open .stbody input[type=number], #view button, #zoomSteps button, #mNav button, .mhead button, #scrRow button")].filter(vis).map(h)); });
    ok(t >= 45, `phone: every button, select and number field of the open step, the rows and the bars is at least 45 px high (${t} px; the mini ? has its own check)`); }
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
    // the drag starts with the title row scrolled away: the zoom slider is then above the Back / Next bar
    const y0 = await ph.evaluate(() => document.querySelector(".mhead").getBoundingClientRect().height);
    const drag = async (dx, dy) => { await ph.evaluate(y => scrollTo(0, y), y0); await ph.waitForTimeout(300);
      const p = await ph.evaluate(() => { const x = document.getElementById("zoomSlider").getBoundingClientRect(); return [x.left + x.width * 0.3, x.top + x.height / 2]; });
      // what the finger lands on, the zoom and Auto's state before the drag (a CI-only failure: name the cause)
      const pre = await ph.evaluate(([x, y]) => { const h = document.elementFromPoint(x, y); return { hit: h ? (h.id || h.className || h.tagName) : "none", zoom: document.getElementById("zoomPct").textContent, busy: !document.getElementById("busyMask").hidden, status: document.getElementById("status").textContent.slice(0, 40) }; }, p);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: p[0], y: p[1] }] });
      for (let i = 1; i <= 12; i++) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: p[0] + dx * i / 12, y: p[1] + dy * i / 12 }] }); await ph.waitForTimeout(16); }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await ph.waitForTimeout(500);
      return { ...(await ph.evaluate(() => ({ zoom: document.getElementById("zoomPct").textContent, y: scrollY }))), pre }; };
    const up = await drag(0, -180), side = await drag(140, 0);
    ok(up.zoom === "Fit" && up.y > 100, `iPhone SE: an up-drag that starts on the zoom slider scrolls the page and leaves the zoom at Fit (${up.zoom}, scrolled ${up.y} px; before: ${JSON.stringify(up.pre)})`);
    ok(side.zoom !== "Fit" && side.y === y0, `iPhone SE: a sideways drag on the zoom slider zooms (${side.zoom})`);
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
    const tabNames = () => p3.$$eval("#tabs .tab .tname", e => e.map(x => x.textContent).join(" | ")), tabsIdle = async () => { await p3.waitForFunction(() => !document.getElementById("tabs").hasAttribute("aria-busy"), null, { timeout: 120000 }); await p3.waitForTimeout(500); };
    ok(await p3.isVisible("#tabBar") && await p3.isDisabled("#undo") && await tabNames() === "1 · New job" && await wide(), "job tabs: one new job, Undo off, fits 390 px");
    await shot("#tabBar", "job-tabs-390.png");
    await p3.click("#dropSample"); await settled();
    ok(await tabNames() === "1 · Sample design", "job tabs: the job takes the art's name");
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
    await p3.evaluate(() => scrollTo(0, 0)); await p3.click("#dRate"); await p3.waitForTimeout(500); await shot('#preflight [data-check="base-halo"]', "check-base-halo-390.png");
    await p3.click('#preflight [data-check="base-halo"] [data-fix]'); await p3.waitForTimeout(600);
    ok(await val("choke") === "0.2" && !(await halo()), "base halo: the fix sets the choke to the drift and the warning goes");
    if (await p3.getAttribute("#dRate", "aria-expanded") === "true") await p3.evaluate(() => document.getElementById("dRate").click());
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
    ok(/Restored Sample design/.test(await p3.textContent("#jobMsg")) && await val("lpi") === "55" && await val("fabric") === "fleece" && await p3.textContent("#artName") === "Sample design", "restore: after a reload the job is back (art, 55 LPI, fleece)");
    await shot("#jobNote", "restored-390.png");
    // ?screen=N opens that screen's film in Print; a screen the job does not have says which it has
    await p3.goto(later + "&screen=2"); await ready(); await settled();
    { const g = await p3.evaluate(() => ({ view: document.body.dataset.view, cur: [...document.querySelectorAll("#scrList .scard.cur .so")].map(e => e.textContent).join(","), n: document.querySelectorAll("#scrList .scard").length }));
      ok(g.view === "film" && g.cur === "2", `?screen=2 opens screen 2's film in Print (view ${g.view}, open ${g.cur || "none"})`);
      await p3.goto(later + "&screen=99"); await ready(); await settled();
      ok(new RegExp(`^\\?screen=99: this job has screens 1 to ${g.n}\\.$`).test(await p3.textContent("#jobMsg")), "?screen=99: the job note names the screens the job has"); }
    await p3.goto(later); await ready(); await settled();
    await p3.click("#tabNew"); await tabsIdle();
    ok(await tabNames() === "1 · Sample design | 2 · New job" && await p3.isVisible("#drop") && await val("lpi") === "55" && await val("press") === "automatic", "several jobs: + opens an empty second job with the default profile (55 LPI, automatic)");
    await p3.click("#tabs .tab:nth-child(1) .tname"); await tabsIdle(); await settled();
    ok(await p3.textContent("#artName") === "Sample design" && await val("fabric") === "fleece", "several jobs: the first tab opens its job with its art and settings");
    await shot("#tabBar", "job-tabs-two-390.png");
    await p3.click("#tabs .tab:nth-child(1) .tclose"); await tabsIdle();
    ok(await tabNames() === "1 · New job" && await p3.isVisible("#drop"), "several jobs: X closes the job and opens the one left");
    await ctx.close(); };
  // Job tabs (workspace PR 6): one tab is one job; names, new, switch, close and Undo, the 12-tab limit, the tabs back
  // after a reload and after the browser was closed, a job stored before there were tabs, undo steps for each tab, a
  // separation in progress when the tab changes, a browser that keeps nothing, and the strip on a phone.
  const tabKit = () => {
    const page = async (opt = {}, init = null) => { const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, ...opt }); if (init) await ctx.addInitScript(init); const p = await ctx.newPage();
      p.on("pageerror", e => errors.push(e.message)); p.on("console", m => { if (m.type() === "error") errors.push(m.text()); }); return p; };
    const ready = p => p.waitForFunction(() => window.sepReady, null, { timeout: 120000 });
    // idle: no job change and no separation in progress; auto: Auto finished on the open job
    const idle = async p => { await p.waitForFunction(() => !document.getElementById("tabs").hasAttribute("aria-busy") && document.getElementById("busyMask").hidden && !document.getElementById("run").disabled && !document.getElementById("auto").disabled && !/^(Auto is refining|Separating|Reading)/.test(document.getElementById("status").textContent), null, { timeout: 180000 }); await p.waitForTimeout(700); };
    const auto = async p => { await p.waitForFunction(() => document.getElementById("auto").textContent === "✓ Auto" && !document.getElementById("run").disabled && /Updated/.test(document.getElementById("status").textContent), null, { timeout: 180000 }); await idle(p); };
    const names = p => p.$$eval("#tabs .tab .tname", e => e.map(x => x.textContent).join(" | "));
    const onTab = p => p.$$eval("#tabs .tab", e => e.findIndex(x => x.classList.contains("on") && x.getAttribute("aria-selected") === "true") + 1);
    const tab = async (p, n) => { await p.click(`#tabs .tab:nth-child(${n}) .tname`); await idle(p); };
    const plus = async p => { await p.click("#tabNew"); await idle(p); };
    const val = (p, id) => p.evaluate(i => document.getElementById(i).value, id), set = (p, id, v) => p.evaluate(([i, x]) => { const e = document.getElementById(i); e.value = String(x); e.dispatchEvent(new Event("input", { bubbles: true })); e.dispatchEvent(new Event("change", { bubbles: true })); }, [id, v]);
    const cards = p => p.$$eval("#scrList .scard .sn", e => e.map(x => x.textContent).join("/"));
    const job = async p => ({ art: await p.evaluate(() => document.getElementById("fileCard").hidden ? "" : document.getElementById("artName").textContent), cards: await cards(p), stars: await p.textContent("#rStars"), sum: await p.textContent("#step3Sum"), lpi: await val(p, "lpi"), fabric: await val(p, "fabric") });
    const same = (x, y) => JSON.stringify(x) === JSON.stringify(y), was = (x, y) => same(x, y) ? "" : ` (was ${JSON.stringify(y)}, is ${JSON.stringify(x)})`;
    const empty = async p => await p.isVisible("#drop") && await p.textContent("#rStars") === "–" && await p.isHidden("#scrRow") && await cards(p) === "" && await p.textContent("#step3Sum") === "Auto runs when you add art";
    const stored = p => p.evaluate(() => new Promise(res => { const r = indexedDB.open("sepbench", 1); r.onsuccess = () => { const q = r.result.transaction("jobs").objectStore("jobs").getAll(); q.onsuccess = () => res(q.result.map(j => ({ id: j.id, name: j.name, art: !!j.art, sample: !!j.sample }))); }; r.onerror = () => res(null); }));
    // every element of the job's part of the page: what a person sees and what a control holds
    const dom = p => p.evaluate(() => { const out = {};
      for (const e of document.querySelectorAll("#paneStage *, #paneSteps *, #paneSide *, #mNav *")) { if (e.closest("#tabBar, #jobNote")) continue;
        let k = "", x = e; while (x && !x.id) { k = "/" + x.tagName + [...x.parentElement.children].indexOf(x) + k; x = x.parentElement; }
        out[(x ? x.id : "") + k] = JSON.stringify([[...e.attributes].map(a => a.name + "=" + a.value).sort(), e.children.length ? e.children.length : e.textContent, e.value, e.checked, e.disabled]); }
      return out; });
    const png = fs.readFileSync(path.join(__dirname, "../test-images", fs.readdirSync(path.join(__dirname, "../test-images")).find(f => /^06.*\.png$/.test(f)))), LONG = "Summer-festival-poster-final-v12-print-ready";

    return { page, ready, idle, auto, names, onTab, tab, plus, val, set, cards, job, empty, stored, dom, png, LONG, same, was }; };
  const tabs = async () => { const { page, ready, idle, auto, names, onTab, tab, plus, val, set, job, empty, stored, dom, png, LONG, same, was } = tabKit();
    // names, the strip's place, a new tab
    let p = await page(); await p.goto(url); await ready(p); const fresh = await dom(p);
    ok(await names(p) === "1 · New job" && await onTab(p) === 1 && await p.getAttribute("#tabs", "role") === "tablist" && await p.isDisabled("#undo") && await p.isDisabled("#redo"), "tabs: a new page has one tab, 1 · New job, open, in a tablist; the Undo and Redo arrows are off");
    { const g = await p.evaluate(() => { const r = id => document.getElementById(id).getBoundingClientRect(), t = r("tabBar"), u = r("undo"), re = r("redo"), sq = r("square"); const a = id => document.getElementById(id);
        return { h: t.height, in: t.left >= r("paneSteps").right - 1 && t.right <= r("paneSide").left + 1, above: Math.abs(t.bottom - sq.top) < 1, ends: Math.abs(re.right - t.right) < 1 && Math.abs(u.right - re.left) < 1, ur: [u.width, re.width].join(), labels: [a("undo").title, a("undo").getAttribute("aria-label"), a("redo").title, a("redo").getAttribute("aria-label")].join(), old: !!document.getElementById("jobBar") || !!document.getElementById("jobSel") || !!document.getElementById("jobNew") || !!document.getElementById("jobClose"), later: !!a("tabBar").closest("[data-later]") }; });
      ok(g.h === 30 && g.in && g.above && !g.later, `tabs: the strip is 30 px high, in the centre column, directly above the workspace, shown without ?later=1 (${g.h} px)`);
      ok(g.ends && g.ur === "30,30" && g.labels === "Undo,Undo,Redo,Redo" && !g.old, "tabs: Undo and Redo are two arrow buttons at the right end of the strip; the old job list and its Undo / Redo row are gone"); }
    await p.click("#trySample"); await auto(p);
    ok(await names(p) === "1 · Sample design", `tabs: the tab takes the art's name (${await names(p)})`);
    await set(p, "fabric", "fleece"); await idle(p); const a1 = await job(p);
    await plus(p);
    ok(await names(p) === "1 · Sample design | 2 · New job" && await onTab(p) === 2 && await empty(p), "tabs: + opens a new empty job in tab 2, 2 · New job");
    { const now = await dom(p), bad = Object.keys({ ...fresh, ...now }).filter(k => fresh[k] !== now[k]);
      ok(bad.length === 0, `tabs: the new tab shows what a new page shows, element by element${bad.length ? " (differs: " + bad.slice(0, 6).join(" ") + ")" : ""}`); }
    // a long file name: without its extension, cut with an ellipsis, whole in the title
    await p.setInputFiles("#file", { name: LONG + ".png", mimeType: "image/png", buffer: png }); await auto(p); await set(p, "lpi", 55); await idle(p);
    { const t = await p.$eval("#tabs .tab.on .tname", e => ({ text: e.textContent, title: e.title, cut: e.scrollWidth > e.clientWidth, ov: getComputedStyle(e).textOverflow, close: e.nextElementSibling.getAttribute("aria-label") }));
      ok(t.text === `2 · ${LONG}` && t.title === LONG && t.cut && t.ov === "ellipsis" && t.close === `Close ${LONG}`, `tabs: a long file name shows without its extension, cut with an ellipsis, whole in the title (${t.title})`); }
    const a2 = await job(p);
    // switching keeps each job
    await tab(p, 1); const b1 = await job(p);
    ok(await onTab(p) === 1 && same(b1, a1) && b1.art === "Sample design" && b1.fabric === "fleece" && b1.lpi === "45", `tabs: tab 1 opens with its art, settings and result as it was left (${b1.sum}, ${b1.stars} stars)${was(b1, a1)}`);
    await tab(p, 2); const b2 = await job(p);
    ok(await onTab(p) === 2 && same(b2, a2) && b2.art === LONG + ".png" && b2.lpi === "55" && b2.fabric === "cotton", `tabs: tab 2 opens with its own art, settings and result (${b2.sum}, ${b2.stars} stars)${was(b2, a2)}`);
    // undo and redo act on the open tab; each tab keeps its own steps
    await tab(p, 1); ok(!(await p.isDisabled("#undo")) && await p.isDisabled("#redo"), "tabs: back on tab 1, its undo steps are still there");
    await p.click("#undo"); await idle(p); ok(await val(p, "fabric") === "cotton" && !(await p.isDisabled("#redo")), "tabs: the Undo arrow takes back tab 1's last change (fleece)");
    await tab(p, 2); ok(await val(p, "lpi") === "55" && await p.isDisabled("#redo"), "tabs: tab 2 has no redo step from tab 1");
    await p.click("#undo"); await idle(p); ok(await val(p, "lpi") === "45", "tabs: Undo on tab 2 takes back tab 2's change (55 LPI)");
    await tab(p, 1); ok(await val(p, "fabric") === "cotton" && !(await p.isDisabled("#redo")), "tabs: tab 1 kept its redo step while tab 2 was open");
    await p.click("#redo"); await idle(p); ok(await val(p, "fabric") === "fleece", "tabs: the Redo arrow puts tab 1's fleece back");
    await tab(p, 2); await p.click("#redo"); await idle(p); ok(await val(p, "lpi") === "55", "tabs: Redo on tab 2 puts its 55 LPI back");
    // keys: the arrows move between the tabs
    await p.focus("#tabs .tab:nth-child(1) .tname"); await p.keyboard.press("ArrowRight");
    ok(await p.evaluate(() => document.activeElement === document.querySelector("#tabs .tab:nth-child(2) .tname")), "tabs: the right arrow key moves from tab 1 to tab 2");
    // close and Undo
    await p.click("#tabs .tab:nth-child(2) .tclose"); await idle(p);
    { const n = await p.evaluate(() => ({ text: document.getElementById("jobNote").innerText.trim(), live: document.getElementById("jobNote").getAttribute("aria-live"), role: document.getElementById("jobNote").getAttribute("role"), dialog: !!document.querySelector("dialog[open]") }));
      ok(await names(p) === "1 · Sample design" && await onTab(p) === 1 && n.text === "Job closed. Undo" && n.live === "polite" && n.role === "status" && !n.dialog, `tabs: X closes the job at once, with no dialog; the status line says "${n.text}"`); }
    ok((await stored(p)).some(j => j.name === LONG + ".png" && j.art), "tabs: while Undo is offered, the closed job and its art are still in the browser's store");
    await p.click("#jobUndo"); await idle(p); const c2 = await job(p);
    ok(await names(p) === `1 · Sample design | 2 · ${LONG}` && await onTab(p) === 2 && JSON.stringify(c2) === JSON.stringify(a2) && await p.isHidden("#jobNote"), "tabs: Undo brings the closed job back in its place with its art, settings and result");
    // the next close ends the first Undo; after 10 seconds the line goes and the job leaves the store
    await plus(p); await p.click("#tabs .tab:nth-child(3) .tclose"); await idle(p); await p.click("#tabs .tab:nth-child(2) .tclose"); await idle(p);
    ok(await names(p) === "1 · Sample design" && await p.isVisible("#jobUndo"), "tabs: a second close offers Undo for that job");
    await p.waitForTimeout(11000);
    { const s = await stored(p); ok(await p.isHidden("#jobNote") && s.length === 1 && s[0].sample, `tabs: after 10 seconds the line is gone and the closed job is deleted from the store (${s.length} job kept)`); }
    // closing the last tab leaves one new job; Delete closes a tab
    await p.focus("#tabs .tab:nth-child(1) .tname"); await p.keyboard.press("Delete"); await idle(p);
    ok(await names(p) === "1 · New job" && await empty(p), "tabs: closing the last tab (Delete key) leaves one tab, 1 · New job, empty");
    await p.click("#jobUndo"); await idle(p);
    ok(await names(p) === "1 · Sample design" && (await job(p)).fabric === "fleece", "tabs: Undo after the last tab was closed brings the job back as the only tab");
    // the limit: 12 tabs
    for (let i = 0; i < 11; i++) await plus(p);
    ok((await p.$$eval("#tabs .tab", t => t.length)) === 12 && await p.isDisabled("#tabNew") && /^12 jobs are open\. Close a job/.test(await p.textContent("#jobMsg")) && !(await p.evaluate(() => !!document.querySelector("dialog[open]"))), `tabs: at 12 tabs + is disabled and the status line says to close a job ("${await p.textContent("#jobMsg")}")`);
    await p.click("#tabs .tab:nth-child(12) .tclose"); await idle(p); ok(!(await p.isDisabled("#tabNew")) && (await p.$$eval("#tabs .tab", t => t.length)) === 11, "tabs: after a close, + works again");
    await p.context().close();

    // a separation in progress when the tab changes stays with its own job
    p = await page(); await p.goto(url); await ready(p);
    await p.click("#trySample"); await p.click("#tabNew");
    await p.waitForFunction(() => document.querySelectorAll("#tabs .tab").length === 2 && !document.getElementById("tabs").hasAttribute("aria-busy"), null, { timeout: 120000 });
    ok(await onTab(p) === 2 && await empty(p), "tabs: Auto started on tab 1, then + at once: tab 2 opens empty");
    await p.waitForTimeout(9000); ok(await empty(p) && await p.textContent("#auto") === "Auto", "tabs: nine seconds later tab 2 is still empty: tab 1's Auto wrote nothing into it");
    await tab(p, 1); await auto(p); const s1 = await job(p);
    await plus(p); await p.click("#trySample"); await auto(p); const s3 = await job(p);
    ok(s1.art === "Sample design" && s1.cards !== "" && JSON.stringify(s1) === JSON.stringify(s3), `tabs: back on tab 1, Auto ran again and its result is the one an Auto that was not stopped gives (${s1.sum}, ${s1.stars} stars)`);
    await tab(p, 2); ok(await empty(p), "tabs: tab 2 is empty after all of it");
    // all the tabs come back after a reload: order, the open tab, art and settings
    await p.setInputFiles("#file", { name: LONG + ".png", mimeType: "image/png", buffer: png }); await auto(p); await set(p, "lpi", 55); await idle(p); const r2 = await job(p);
    await p.waitForTimeout(900); await p.reload(); await ready(p); await idle(p);
    ok(await names(p) === `1 · Sample design | 2 · ${LONG} | 3 · Sample design` && await onTab(p) === 2 && JSON.stringify(await job(p)) === JSON.stringify(r2), "tabs: after a reload the three tabs are back in their order, tab 2 open with its art, 55 LPI and result");
    await tab(p, 3); ok(JSON.stringify(await job(p)) === JSON.stringify(s3), "tabs: after the reload tab 3 opens with its art, settings and result");
    await plus(p); ok(await val(p, "lpi") === "45" && await empty(p), "tabs: a new tab after the reload starts with the standard settings (45 LPI), not the last job's");
    // a job stored before there were tabs (no tab list, no auto field; the list was in the order of the last save)
    await p.click("#tabs .tab:nth-child(4) .tclose"); await idle(p);
    await p.evaluate(() => new Promise(res => { const r = indexedDB.open("sepbench", 1); r.onsuccess = () => { const tx = r.result.transaction("jobs", "readwrite"), o = tx.objectStore("jobs"), q = o.getAll();
      q.onsuccess = () => { for (const j of q.result) { delete j.auto; o.put(j); } const s = q.result.find(j => j.sample); localStorage.setItem("sepbench.job", JSON.stringify(s.id)); localStorage.removeItem("sepbench.tabs"); localStorage.removeItem("sepbench.closed"); }; tx.oncomplete = () => res(1); }; }));
    await p.reload(); await ready(p); await idle(p);
    { const n = await names(p), j = await job(p);
      ok(n.split(" | ").length === 3 && n.includes(`· ${LONG}`) && /Sample design/.test(await p.textContent("#tabs .tab.on .tname")) && j.art === "Sample design" && j.cards === s3.cards && /Restored Sample design/.test(await p.textContent("#jobMsg")), `tabs: jobs stored before there were tabs load as tabs, the open one open with its art and result (${n})`); }
    await p.context().close(); };
  // Job tabs, second part: the browser closed and opened again, a browser that keeps no jobs, the strip on a phone
  const tabsKept = async () => { const { page, ready, idle, auto, names, onTab, tab, plus, set, job, empty } = tabKit(); let p;
    // the tabs come back after the browser was closed (a profile folder on disk)
    { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sepbench-tabs-")), launch = () => chromium.launchPersistentContext(dir, { viewport: { width: 1280, height: 900 } });
      let ctx = await launch(); p = ctx.pages()[0] || await ctx.newPage(); p.on("pageerror", e => errors.push(e.message));
      await p.goto(url); await ready(p); await p.click("#trySample"); await auto(p); await set(p, "fabric", "fleece"); await idle(p); const k1 = await job(p);
      await plus(p); await plus(p); await tab(p, 2); await p.waitForTimeout(900); await ctx.close();
      ctx = await launch(); p = ctx.pages()[0] || await ctx.newPage(); p.on("pageerror", e => errors.push(e.message)); await p.goto(url); await ready(p); await idle(p);
      ok(await names(p) === "1 · Sample design | 2 · New job | 3 · New job" && await onTab(p) === 2 && await empty(p), "tabs: after the browser was closed and opened again, the three tabs are back and tab 2 is open");
      await tab(p, 1); ok(JSON.stringify(await job(p)) === JSON.stringify(k1), "tabs: after the browser was closed, tab 1 opens with its art, fleece and result");
      await ctx.close(); fs.rmSync(dir, { recursive: true, force: true }); }

    // a browser that keeps no jobs: the tabs work from memory, and the page says so once
    p = await page({}, () => { IDBFactory.prototype.open = function () { throw new DOMException("The operation is insecure.", "SecurityError"); }; });
    await p.goto(url); await ready(p);
    ok(/cannot save jobs/.test(await p.textContent("#jobMsg")) && await p.isVisible("#jobNote") && await names(p) === "1 · New job", `tabs: when the browser's store cannot open, the page starts and the status line says jobs cannot be saved ("${(await p.textContent("#jobMsg")).slice(0, 60)}…")`);
    await p.click("#trySample"); await auto(p); const m1 = await job(p); await plus(p);
    ok(await empty(p) && await p.textContent("#jobMsg") === "", "tabs: with no store, + opens a new tab; the note is not said again");
    await tab(p, 1); ok(JSON.stringify(await job(p)) === JSON.stringify(m1) && m1.cards !== "", "tabs: with no store, tab 1 comes back from memory with its art and result");
    await p.click("#tabs .tab:nth-child(1) .tclose"); await idle(p); await p.click("#jobUndo"); await idle(p);
    ok(await names(p) === "1 · Sample design | 2 · New job" && JSON.stringify(await job(p)) === JSON.stringify(m1) && await p.textContent("#jobMsg") === "", "tabs: with no store, close and Undo work from memory");
    await p.context().close();

    // phone, 390 px: the strip pins above the workspace, the tabs slide inside it, the page does not move sideways
    p = await page({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }); await p.goto(url); await ready(p);
    await p.click("#dropSample"); await auto(p); for (let i = 0; i < 11; i++) await plus(p); await tab(p, 1); await p.evaluate(() => scrollTo(0, 700)); await p.waitForTimeout(400);
    { const g = await p.evaluate(() => { const r = e => e.getBoundingClientRect(), bar = r(document.getElementById("tabBar")), sq = r(document.getElementById("square")), tabs = document.getElementById("tabs"), x = document.querySelector("#tabs .tclose"), plusB = document.getElementById("tabNew"), u = document.getElementById("undo");
        const hit = e => { const a = getComputedStyle(e, "::after"); return r(e).height - parseFloat(a.top) - parseFloat(a.bottom); };
        return { y: scrollY, bar: [bar.top, bar.height].join(), sq: sq.top, wide: document.documentElement.scrollWidth <= innerWidth, slide: tabs.scrollWidth > tabs.clientWidth + 100, tabW: r(document.querySelector("#tabs .tab:nth-child(2)")).width, onW: r(document.querySelector("#tabs .tab.on")).width, peek: r(plusB).left - r(document.querySelector("#tabs .tab.on")).right, hit: [hit(x), hit(plusB), hit(u)].join(), plusIn: r(plusB).right <= r(tabs).right + 1 && r(plusB).left >= r(tabs).left, font: getComputedStyle(document.querySelector("#tabs .tname")).fontSize }; });
      ok(g.y > 300 && g.bar === "0,33" && g.sq === 33, `tabs, phone: with the page scrolled the strip stays at the top, 33 px high, and the workspace stays under it (strip ${g.bar}, workspace at ${g.sq})`);
      ok(g.wide && g.slide && g.tabW === 120 && g.plusIn, `tabs, phone: 12 tabs slide inside the strip (each ${g.tabW} px), + stays in view, the page does not scroll sideways`);
      ok(g.onW > 120 && g.peek >= 36, `tabs, phone: the open tab is as wide as its name (${Math.round(g.onW)} px), ${Math.round(g.peek)} px of the next tab stay in view`);
      ok(g.hit === "45,45,45" && g.font === "15px", `tabs, phone: the tab X, + and the arrows are 45 px high to the touch (${g.hit})`); }
    // a tab keeps its view and its zoom while another job is open
    await p.evaluate(() => scrollTo(0, 0)); await p.click("#z100"); await p.waitForTimeout(300); await p.click('#view button[data-v="cmp"]'); await tab(p, 2); await tab(p, 1);
    { const v = await p.evaluate(() => document.body.dataset.view); await p.click('#view button[data-v="film"]'); await p.waitForTimeout(400); const z = await p.getAttribute("#zStep", "aria-label");
      ok(v === "cmp" && /Zoom is 100%/.test(z), `tabs: a job opens again with its view and zoom (view ${v}; ${z})`); await p.click("#zStep"); await p.waitForTimeout(300); }
    await p.evaluate(() => { document.getElementById("tabs").scrollLeft = 5000; }); await p.tap("#tabs .tab:nth-child(12) .tname"); await idle(p);
    ok(await onTab(p) === 12 && await empty(p), "tabs, phone: a tap on the last tab, slid into view, opens it");
    await p.tap("#tabs .tab:nth-child(12) .tclose"); await idle(p);
    { const g = await p.evaluate(() => { const n = document.getElementById("jobNote").getBoundingClientRect(), u = document.getElementById("jobUndo"), ur = u.getBoundingClientRect(), a = getComputedStyle(u, "::after"); return { top: n.top, under: Math.abs(n.top - document.getElementById("tabBar").getBoundingClientRect().bottom) < 1, vis: n.height > 0, hit: ur.height - parseFloat(a.top) - parseFloat(a.bottom) }; });
      ok(g.vis && g.under && g.hit >= 45 && (await p.$$eval("#tabs .tab", t => t.length)) === 11, `tabs, phone: the "Job closed. Undo" line shows under the pinned strip (at ${g.top} px), Undo ${g.hit} px high to the touch`); }
    await p.context().close();
    // a short phone (iPhone SE, 320 x 568): Fit and the zoom slider are above the Back / Next bar with the page at the top
    p = await page({ viewport: { width: 320, height: 568 }, hasTouch: true, isMobile: true }); await p.goto(url); await ready(p);
    await p.click("#dropSample"); await auto(p); await p.evaluate(() => scrollTo(0, 0)); await p.waitForTimeout(400);
    { const g = await p.evaluate(() => { const r = id => document.getElementById(id).getBoundingClientRect(), c = document.getElementById("view0").getBoundingClientRect(), s = r("square"); return { z: r("zoomSlider").bottom, fit: r("zStep").bottom, nav: r("mNav").top, sq: s.height, art: c.width > 60 && c.height > 60 && c.top >= s.top - 1 && c.bottom <= s.bottom + 1 }; });
      ok(g.z > 0 && g.z <= g.nav && g.fit <= g.nav && g.art, `phone, 320 x 568: Fit and the zoom slider show above the bottom bar, the art fits the ${g.sq} px workspace (slider to ${Math.round(g.z)}, bar at ${Math.round(g.nav)})`); }
    await p.context().close();
    // phone, in an ADN tool page (the page header has the title and the gear): the theme switch is in Shop setup, the
    // table has no title row. On the wall (no page header for the table) the title row stays.
    for (const [where, inHeader] of [["tool-page", true], ["wall", false]]) {
      p = await page({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
      await p.route(url + where, r => r.fulfill({ contentType: "text/html", body: `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0"><iframe src="${url}" style="border:0;width:100%;height:800px"></iframe></body>` }));
      await p.goto(url + where); const f = p.frames().find(x => x.url() === url); await f.waitForFunction(() => window.sepReady, null, { timeout: 120000 });
      const g = await f.evaluate(() => { const seg = document.getElementById("themeSeg"), sec = document.querySelector("#shopPanel section"); return { cls: document.body.className, box: seg.parentElement.id || seg.parentElement.className, first: !!(seg.compareDocumentPosition(sec) & 4), head: getComputedStyle(document.querySelector(".mhead")).display, n: document.querySelectorAll(".tseg").length }; });
      if (inHeader) { await f.evaluate(() => document.getElementById("shopOpen").click()); await p.waitForTimeout(400); await f.click("#themeSeg [data-v=dark]");
        const dk = await f.evaluate(() => [document.documentElement.dataset.scheme, Math.round(document.querySelector("#themeSeg button").getBoundingClientRect().height)].join());
        ok(g.box === "shopPanel" && g.first && g.head === "none" && g.n === 1 && dk === "dark,45", `phone, ADN tool page: no title row; the one theme switch is first in Shop setup and works (in ${g.box}, title row ${g.head}, ${dk})`); }
      else ok(/framed/.test(g.cls) && !/inheader/.test(g.cls) && /mhead/.test(g.box) && g.head !== "none", `phone, ADN wall: the title row keeps the theme switch (in ${g.box})`);
      await p.context().close();
    }
  };
  // v1 surface: the groups marked data-later are not shown and cannot be reached; ?later=1 shows them
  const v1Surface = async () => { const IDS = ["impOpen", "setupMin", "perHour", "ptLine", "fDCS", "dotShape", "profSel", "profSave", "profSrc", "minPpi", "units", "tfMake", "reportCopy"];
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 } }), v1 = await ctx.newPage(); v1.on("pageerror", e => errors.push(e.message));
    // shown: the control has a box on the page, or its data-later group is displayed (its step or panel may be closed)
    const look = () => v1.evaluate(ids => { for (const d of document.querySelectorAll("dialog")) if (!d.open) d.showModal(); for (const e of document.querySelectorAll(".stbody")) /** @type {HTMLElement} */ (e).hidden = false;
      const shown = ids.filter(i => { const e = document.getElementById(i); return e.getClientRects().length > 0 || getComputedStyle(e.closest("[data-later]")).display !== "none"; });
      const r = { shown, tabs: [...document.querySelectorAll("#view button")].filter(x => x.getClientRects().length).map(x => x.textContent).join(" "), help: !!document.querySelector('#helpList .hitem[data-k="reproof"]'), helpTabs: [...document.querySelectorAll('#helpList .hitem[data-k="jobs"], #helpList .hitem[data-k="undo"]')].map(d => d.textContent).join(" "), helpViews: !!document.querySelector('#helpList .hitem[data-k="pressSteps"]'),
        shop: [...document.querySelectorAll("#shopPanel h2")].filter(h => h.getClientRects().length).map(h => h.textContent.replace(/\?$/, "")).join(" | ") };
      for (const d of document.querySelectorAll("dialog")) d.close(); return r; }, IDS);
    await v1.goto(url); await v1.waitForFunction(() => window.sepReady, null, { timeout: 120000 });
    await v1.evaluate(() => localStorage.setItem("sepbench.units", '"cm"')); await v1.reload(); await v1.waitForFunction(() => window.sepReady, null, { timeout: 120000 });
    ok(await v1.evaluate(() => !document.getElementById("whIn").hidden && document.getElementById("whCm").hidden), "v1 surface: with no Units control the print size is in inches, also when this browser kept centimetres");
    await v1.evaluate(() => localStorage.removeItem("sepbench.units"));
    const jb = await v1.evaluate(() => { const r = document.getElementById("tabBar").getBoundingClientRect(), in1 = id => { const x = document.getElementById(id).getBoundingClientRect(); return x.height > 0 && x.top >= r.top && x.bottom <= r.bottom; };
      return { h: Math.round(r.height), top: Math.round(r.top - document.querySelector(".mhead").getBoundingClientRect().bottom), ur: in1("undo") && in1("redo"), tabs: document.querySelectorAll("#tabs .tab").length, q: document.querySelectorAll("#tabBar .q").length, later: !!document.getElementById("tabBar").closest("[data-later]") }; });
    ok(jb.ur && jb.h === 33 && jb.top === 0 && jb.tabs === 1 && jb.q === 0 && !jb.later, `v1 surface: on a phone the job tabs are a 33 px strip under the title row, with the Undo and Redo arrows in it (${jb.h} px high)`);
    for (const w of [390, 1024, 1280, 1440]) { await v1.setViewportSize({ width: w, height: 900 }); await v1.waitForTimeout(300);
      const t = await v1.evaluate(() => [...document.querySelectorAll("#view button")].filter(x => x.getClientRects().length).map(x => { const s = document.createElement("span"); s.textContent = x.textContent; s.style.whiteSpace = "nowrap"; x.textContent = ""; x.appendChild(s); const fits = s.getBoundingClientRect().width <= x.clientWidth; x.textContent = s.textContent; return [x.textContent, fits]; }));
      const row = await v1.evaluate(() => { const bar = document.getElementById("viewBar"), cs = getComputedStyle(bar), r = bar.getBoundingClientRect(), bs = [...document.querySelectorAll("#view button")].filter(x => x.getClientRects().length).map(x => x.getBoundingClientRect()), d = document.querySelector(".difftog, #diffT"), q = document.getElementById("square").getBoundingClientRect();
        return { l: bs[0].left - (r.left + parseFloat(cs.paddingLeft)), r: r.right - parseFloat(cs.paddingRight) - bs[bs.length - 1].right, even: Math.max(...bs.map(x => x.width)) - Math.min(...bs.map(x => x.width)), w: r.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight), alone: bar.querySelectorAll(".hw, .q").length === 0, gone: !d }; });
      ok(t.map(x => x[0]).join(" ") === "Art Compare Print" && t.every(x => x[1]) && row.alone && Math.abs(row.l) <= 1.5 && Math.abs(row.r) <= 1.5 && row.even <= 2 && (w < 961 ? Math.abs(row.w - (w - 24)) < 1 : row.w <= 640), `v1 surface: three view tabs, each with its whole word, across the full row at ${w} px (${t.map(x => x[0]).join(" ")}, row ${Math.round(row.w)} px)`);
      ok(row.gone, `v1 surface: the page has no Differences switch, at ${w} px`); }
    await v1.setViewportSize({ width: 390, height: 844 });
    await v1.evaluate(() => /** @type {HTMLElement} */ (document.querySelector('#view button[data-v="press"]')).click());
    ok(await v1.evaluate(() => document.body.dataset.view) === "film" && await v1.isHidden("#pressBar"), "v1 surface: a view with no tab opens Print");
    const a = await look();
    ok(a.shown.length === 0 && !a.help && !a.helpViews, `v1 surface: the later controls are not shown, and Help does not explain them${a.shown.length ? " (shown: " + a.shown.join(" ") + ")" : ""}`);
    ok(/Job tabs/.test(a.helpTabs) && /Push \+ to start a new job/.test(a.helpTabs) && /two arrows at the right end of the tab strip/.test(a.helpTabs) && !/Choose a job in the list/.test(a.helpTabs), "v1 surface: Help explains the job tabs and the Undo and Redo arrows, and no job list");
    ok(a.shop === "Shop setup | Ink library | Calibration | Platen, film and screen | Color targets" && await v1.evaluate(() => ["meshBase", "szPlaten", "mirror", "fabric", "undo", "tabs"].every(i => !document.getElementById(i).closest("[data-later]"))), `v1 surface: Shop setup begins with the ink library and the calibration (${a.shop}); mesh, sizes, mirror and fabric stay`);
    await v1.goto(later); await v1.waitForFunction(() => window.sepReady, null, { timeout: 120000 });
    const c = await look();
    ok(c.shown.length === IDS.length && c.tabs === "Art Compare Print Press Stack" && c.help && c.helpViews && /Shop and press profiles/.test(c.shop) && /Report a problem/.test(c.shop), `?later=1 shows them: ${c.shown.length} of ${IDS.length} controls, tabs ${c.tabs}`);
    await ctx.close(); };
  // the sections in the order they run, each with its part
  for (const [k, run] of /** @type {[number, () => Promise<void>][]} */ ([[1, basics], [3, screensRow], [2, inspect], [3, exportAndShop], [4, fewerNote], [2, phoneSE], [4, jobs], [4, tabs], [2, tabsKept], [4, v1Surface]])) if (!part || part === k) await run();
  ok(errors.length === 0, `no console errors${errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""}`);
  await b.close(); console.log(fails ? `${fails} FAILED` : part ? `part ${part} passed` : "all passed"); process.exit(fails ? 1 : 0);
})();
