// The Separation Table benchmark: run the engine on its two yardsticks (vector truth, bench) and compare with the stored baseline, so an
// engine change is judged against numbers already measured instead of re-running the old engine. See BENCHMARK.md.
//
//   node benchmark/run.mjs                       this checkout's engine, all yardsticks, compared with baseline.json
//   node benchmark/run.mjs --only truth          one yardstick (truth, bench)
//   node benchmark/run.mjs --commit <sha>        another version's engine (extracted from git), e.g. an old one
//   node benchmark/run.mjs --update --label "..." --note "..."
//                                                make this run the new baseline, add it to history.json, rewrite BENCHMARK.md
//   node benchmark/run.mjs --history --commit <sha> --label "..."
//                                                add a past version to history.json only (baseline unchanged)
//   node benchmark/run.mjs --doc --only none       rewrite BENCHMARK.md's numbers from baseline.json and history.json
//   node benchmark/run.mjs --history --record .cache/benchmark/results/<label>.json
//                                                file a run saved earlier (runs can go in parallel, then be filed in order)
// Exit code: 0 within tolerance, 2 a yardstick got worse beyond tolerance, 1 an error.
// Run it with nothing else on the machine: the times are only comparable then.
import { execFileSync, spawnSync } from "node:child_process";
import { cpus, loadavg } from "node:os";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)), BENCH = resolve(HERE, ".."), CACHE = join(BENCH, ".cache/benchmark");
const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; }, has = k => process.argv.includes(k);
const ONLY = arg("--record") ? [] : (arg("--only") || "truth,bench").split(","), BASE = join(HERE, "baseline.json"), HIST = join(HERE, "history.json");
const baseline = existsSync(BASE) ? JSON.parse(readFileSync(BASE, "utf8")) : null;
const git = (...a) => execFileSync("git", a, { cwd: BENCH, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
mkdirSync(join(CACHE, "results"), { recursive: true });

/** Where a version keeps its engine: src/ in the current layout, the folder itself in versions from before it. */
const codeOf = dir => existsSync(join(dir, "src", "engine.js")) ? join(dir, "src") : dir;
/** A version's bench folder from git, with this checkout's vendor/ and decoded images (both not in git or shared). */
function extract(sha) {
  const full = git("rev-parse", sha), dir = join(CACHE, `engine-${full.slice(0, 12)}`);
  if (!existsSync(join(codeOf(dir), "engine.js"))) {
    mkdirSync(dir, { recursive: true });
    const top = git("rev-parse", "--show-toplevel"), rel = BENCH.slice(top.length + 1); // "" when this folder is the repository root
    execFileSync("sh", ["-c", `git archive ${full} ${rel} | tar -x --strip-components=${rel ? rel.split("/").length : 0} -C "${dir}"`], { cwd: top });
    for (const d of ["vendor", "models"]) { execFileSync("rm", ["-rf", join(codeOf(dir), d)]); if (existsSync(join(BENCH, "src", d))) symlinkSync(join(BENCH, "src", d), join(codeOf(dir), d)); }
    mkdirSync(join(dir, ".cache"), { recursive: true }); symlinkSync(join(BENCH, ".cache/img"), join(dir, ".cache/img"));
  }
  return { dir, commit: full };
}
const PREP = !has("--no-prep"); // --no-prep: images already decoded (parallel runs must not rewrite them under each other)
if (PREP) run("python3", [join(BENCH, "scripts/prep-images.py")]); // the bench images (.cache/img), shared with extracted versions
let head = "uncommitted", dirty = false; // outside a git checkout, or before the first commit, the run is labelled "uncommitted"
try { head = git("rev-parse", "HEAD"); dirty = git("status", "--porcelain", "--", ".").split("\n").filter(l => /\.(js|mjs)$/.test(l) && !/benchmark\//.test(l)).length > 0; } catch { /* no commit yet */ }
const eng = arg("--commit") ? extract(arg("--commit")) : { dir: arg("--engine") ? resolve(arg("--engine")) : BENCH, commit: head + (dirty ? "+changes" : "") };
console.error(`engine ${eng.commit.slice(0, 12)} (${eng.dir}); load ${loadavg()[0].toFixed(2)} on ${cpus().length} cores`);
if (loadavg()[0] > 1) console.error("warning: the machine is busy; times will not be comparable");

function run(cmd, args, opts = {}) { const r = spawnSync(cmd, args, { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", maxBuffer: 1 << 28, ...opts }); if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.status})`); return r.stdout; }
if (PREP) run("python3", [join(HERE, "prep.py")]);
const mean = (rows, k) => { const v = rows.map(r => r[k]).filter(x => x != null && !Number.isNaN(x)); return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(3) : null; };
const sum = (rows, k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
const LABEL = arg("--label") || eng.commit.slice(0, 12), WORK = join(CACHE, `work-${LABEL.replace(/[^\w.-]+/g, "_")}`); mkdirSync(WORK, { recursive: true });
let res = { label: LABEL, note: arg("--note") || "", commit: eng.commit, date: new Date().toISOString().slice(0, 10), node: process.version, cpu: cpus()[0].model, load: +loadavg()[0].toFixed(2) };

if (ONLY.includes("truth")) {
  const f = join(WORK, "truth-print.rgb"); run("node", [join(HERE, "truth/print.mjs"), codeOf(eng.dir), f]);
  res.truth = { ...JSON.parse(run("python3", [join(HERE, "truth/score.py"), f])), separationS: +(JSON.parse(readFileSync(f + ".json", "utf8")).ms / 1000).toFixed(1) };
}
if (ONLY.includes("bench")) {
  const f = join(WORK, "bench.json"); run("node", [codeOf(eng.dir) === eng.dir ? "bench-test.mjs" : "tests/bench-test.mjs", "--json", f], { cwd: eng.dir });
  const rows = JSON.parse(readFileSync(f, "utf8")).filter(r => !r.ver || String(r.ver).startsWith("v2"));
  const K = ["robust", "robustP95", "adnMean", "adnP95", "neutralMean", "filtered", "thin", "rough", "steps", "screens", "stack"];
  res.bench = { summary: { cases: rows.length, ...Object.fromEntries(K.map(k => [k, mean(rows, k)])), separationS: +(sum(rows, "ms") / 1000).toFixed(1) },
    cases: Object.fromEntries(rows.map(r => [`${r.image} ${r.palette}`, { robust: r.robust, adnMean: r.adnMean, steps: r.steps, screens: r.screens, inks: r.inks }])) };
}
// --record <results.json>: file a saved run (e.g. one run in parallel with others) instead of running again
if (arg("--record")) res = JSON.parse(readFileSync(arg("--record"), "utf8"));
else writeFileSync(join(CACHE, "results", `${LABEL.replace(/[^\w.-]+/g, "_")}.json`), JSON.stringify(res, null, 1));

/* Compare with the baseline. Lower is better everywhere. Tolerances: what counts as a real change (the engine is
   deterministic, so any change in a number is real; these say which ones matter). abs = absolute, rel = share. */
const TOL = {
  "truth.close.edges": { abs: 0.10 }, "truth.close.edgeOff": { abs: 1.0 }, "truth.arm.edges": { abs: 0.05 }, "truth.arm.solid": { abs: 0.05 }, "truth.arm.glow": { abs: 0.05 },
  "truth.offset": { abs: 0.05 }, "truth.specks": { rel: 0.10 }, "truth.separationS": { rel: 0.15, speed: true },
  "bench.robust": { abs: 0.02 }, "bench.robustP95": { abs: 0.10 }, "bench.adnMean": { abs: 0.02 }, "bench.adnP95": { abs: 0.10 }, "bench.neutralMean": { abs: 0.05 },
  "bench.filtered": { abs: 0.02 }, "bench.thin": { abs: 0.10 }, "bench.steps": { rel: 0.03 }, "bench.screens": { abs: 0.25, info: true }, "bench.separationS": { rel: 0.10, speed: true },
};
const get = (o, path) => path.split(".").reduce((a, k) => a == null ? null : a[k] ?? a.summary?.[k], o);
const rowsOut = [], fails = [], warns = [];
for (const [path, t] of Object.entries(TOL)) {
  const now = get(res, path); if (now == null) continue; const was = baseline ? get(baseline, path) : null;
  let verdict = "", d = was == null ? null : now - was;
  if (d != null) { const lim = t.abs ?? Math.abs(was) * t.rel; verdict = d > lim ? (t.speed ? "slower" : t.info ? "more" : "WORSE") : d < -lim ? (t.speed ? "faster" : t.info ? "fewer" : "better") : "same";
    if (verdict === "WORSE") fails.push(path); if (verdict === "slower") warns.push(path); }
  rowsOut.push(`| ${path} | ${was ?? "—"} | ${now} | ${d == null ? "—" : (d > 0 ? "+" : "") + d.toFixed(3)} | ${verdict} |`); }
console.log(`\n### ${res.label}: engine ${res.commit.slice(0, 12)} vs baseline ${baseline ? `"${baseline.label}" (${baseline.commit.slice(0, 12)}, ${baseline.date})` : "(none yet)"}\n`);
console.log("| measure | baseline | now | change | verdict |\n|---|---|---|---|---|\n" + rowsOut.join("\n"));
if (fails.length) console.log(`\nWorse beyond tolerance: ${fails.join(", ")}`); if (warns.length) console.log(`Slower: ${warns.join(", ")} (only meaningful on an idle machine)`);


/* Baseline and history. history.json keeps one summary row per recorded version, oldest first; BENCHMARK.md shows them. */
const short = r => ({ label: r.label, note: r.note, commit: r.commit.slice(0, 12), date: r.date, truth: r.truth && { closeEdges: r.truth.close.edges, armEdges: r.truth.arm.edges, armSolid: r.truth.arm.solid, armGlow: r.truth.arm.glow, offset: r.truth.offset, specks: r.truth.specks }, bench: r.bench?.summary });
if (has("--update") || has("--history")) {
  const hist = existsSync(HIST) ? JSON.parse(readFileSync(HIST, "utf8")) : []; hist.push(short(res)); writeFileSync(HIST, JSON.stringify(hist, null, 1) + "\n");
  if (has("--update")) { if (!(res.truth && res.bench)) throw new Error("--update needs both yardsticks"); writeFileSync(BASE, JSON.stringify(res, null, 1) + "\n"); }
  if (has("--update") || baseline) writeDoc(has("--update") ? res : baseline, hist); console.error(`recorded ${has("--update") ? "baseline and " : ""}history; BENCHMARK.md rewritten`);
}
// --doc: rewrite the generated part of BENCHMARK.md from the stored baseline and history only (no run is recorded)
if (has("--doc") && baseline) writeDoc(baseline, existsSync(HIST) ? JSON.parse(readFileSync(HIST, "utf8")) : []);
process.exit(fails.length ? 2 : 0);

/** Rewrite the generated part of BENCHMARK.md (between the markers) from the baseline and the history. */
function writeDoc(b, hist) {
  const doc = join(BENCH, "BENCHMARK.md"), txt = readFileSync(doc, "utf8"), A = "<!-- benchmark:generated:start -->", Z = "<!-- benchmark:generated:end -->";
  const f = (v, d = 3) => v == null ? "—" : typeof v === "number" ? v.toFixed(d) : v;
  const L = [A, "", `**Baseline:** ${b.label} · commit \`${b.commit.slice(0, 12)}\` · ${b.date} · ${b.cpu}, Node ${b.node}${b.note ? ` · ${b.note}` : ""}`, ""];
  const t = b.truth, c = b.bench.summary;
  L.push("| Yardstick | Measure | Baseline |", "|---|---|---|",
    `| Vector truth | Edges, close / arm's length | ${f(t.close.edges)} / ${f(t.arm.edges)} |`, `| | Solid areas, arm's length | ${f(t.arm.solid)} |`, `| | Soft glow, arm's length | ${f(t.arm.glow)} |`,
    `| | Edge pixels off by >10, close | ${f(t.close.edgeOff, 1)}% |`, `| | Light-shape edge offset | ${f(t.offset, 2)} px |`, `| | Stray specks | ${t.specks} |`,
    `| Bench (${c.cases} cases) | On-press (robust) | ${f(c.robust)} |`, `| | On-press, worst 5% | ${f(c.robustP95)} |`, `| | Colour (adnMean) | ${f(c.adnMean)} |`,
    `| | Neutral | ${f(c.neutralMean)} |`, `| | Filtered | ${f(c.filtered)} |`, `| | Fine detail lost (thin) | ${f(c.thin)} |`, `| | Steps | ${f(c.steps)} |`, `| | Separation time, all cases | ${f(c.separationS, 1)} s |`, "");
  L.push("**Bench cases (baseline):**", "", "| Case | Screens | Inks | On-press (robust) | Colour (adnMean) | Steps |", "|---|---|---|---|---|---|");
  for (const [k, v] of Object.entries(b.bench.cases)) L.push(`| ${k} | ${v.screens} | ${v.inks} | ${f(v.robust)} | ${f(v.adnMean)} | ${f(v.steps)} |`);
  L.push("", "**History** (each version run with today's tools and settings):", "",
    "| Version | Commit | Date | Truth edges (arm) | Glow (arm) | Bench robust | Bench steps | Note |", "|---|---|---|---|---|---|---|---|");
  for (const h of hist) L.push(`| ${h.label} | \`${h.commit}\` | ${h.date} | ${f(h.truth?.armEdges)} | ${f(h.truth?.armGlow)} | ${f(h.bench?.robust)} | ${f(h.bench?.steps)} | ${h.note || ""} |`);
  L.push("", Z);
  const i = txt.indexOf(A), j = txt.indexOf(Z); writeFileSync(doc, i < 0 ? txt + "\n" + L.join("\n") + "\n" : txt.slice(0, i) + L.join("\n") + txt.slice(j + Z.length));
}
