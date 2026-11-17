// Mutation testing: plant one known bug at a time in src/engine.js and check that the test suite catches it.
// A surviving mutant is a hole in the tests.   node tests/mutate.mjs
// Each mutant runs in its own complete copy of the source under .cache/mutants/, judged by tests/check.mjs and then
// tests/fuzz.mjs 25 369. The unchanged copy is judged first: if it does not pass, a mutant that fails proves nothing,
// so the run stops there. A pattern that is not in src/engine.js exactly once also stops the run: the bug it stood for
// would otherwise go unplanted and uncounted.
// Exit 0: every planted bug caught. Exit 1: a planted bug survived. Exit 2: the run itself is not valid.
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, symlinkSync, existsSync, readdirSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), ".."), work = join(root, ".cache/mutants");
const MUTANTS = [
  ["simplex projection threshold", "for (let j = 0; j < M; j++) { const xj = Math.max(0, x[j] - th); x[j] = xj;", "for (let j = 0; j < M; j++) { const xj = Math.max(0, x[j] + th); x[j] = xj;"],
  ["CIEDE2000 hue term", "const dH = 2 * Math.sqrt(CC) * Math.sin(dh * Math.PI / 360)", "const dH = 2 * Math.sqrt(C1p + C2p) * Math.sin(dh * Math.PI / 360)"],
  ["CMC lightness weight", "return Math.sqrt((dL / (l * SL)) ** 2", "return Math.sqrt((dL / SL) ** 2"],
  ["same-angle compensation", "out[k] = ramp > 0 ? (v[k] > 0 ? Math.min(1, v[k] + (v[k] < ramp ? M * v[k] / ramp : M)) : 0)", "out[k] = ramp > 0 ? (v[k] > 0 ? Math.min(1, v[k]) : 0)"],
  ["underbase cap under colour", "ub[p] = Math.min(1, s) * f;", "ub[p] = f;"],
  ["base chroma boost sign", "tlab[0] + (opt.kC ?? BASE_KC) * C) * strength;", "tlab[0] - (opt.kC ?? BASE_KC) * C) * strength;"],
  ["AM dot area", "if (a < 0.5) return fu * fu + fv * fv < a / Math.PI;", "if (a < 0.5) return fu * fu + fv * fv < a / 3;"],
  ["white gating off", "pen[j] = 0.6 * smoothstep(hwC, hwC + 20, C)", "pen[j] = 0 * smoothstep(hwC, hwC + 20, C)"],
  ["min filter becomes max", "const v = a[y * W + xx]; if (v < m) m = v;", "const v = a[y * W + xx]; if (v > m) m = v;"],
  ["Yule–Nielsen exponent", "export function mixFromLab(lab, n) { return lab2lin(...lab).map(v => Math.pow(Math.max(0, v), 1 / n)); }", "export function mixFromLab(lab, n) { return lab2lin(...lab).map(v => Math.pow(Math.max(0, v), n)); }"],
  ["index diffusion weight", "cur[(x + 2) * M + j] += e * 7 / 16;", "cur[(x + 2) * M + j] += e * 1 / 16;"],
  ["robust light-shirt fix reverted", "lightNoBase = !ub && garmentLab[0] >= 55,", "lightNoBase = false,"],
  ["thin-line choke fallback", ": nearSurvivor[i] > 0.5 ? thin[i] : 0;", ": nearSurvivor[i] > 0.5 ? 0 : 0;"],
  ["dot gain inverse sign", "return ((1 + k) - Math.sqrt(Math.max(0, disc))) / (2 * k);", "return ((1 + k) + Math.sqrt(Math.max(0, disc))) / (2 * k);"],
  ["neutral white base ignored", "if (ub) { const u = ub[p]; c0 = c0 * (1 - u) + wb[0] * u;", "if (false) { const u = ub[p]; c0 = c0 * (1 - u) + wb[0] * u;"],
];
const CHECKS = [["tests/check.mjs"], ["tests/fuzz.mjs", "25", "369"]];
const invalid = msg => { console.log(`\nmutation run NOT VALID: ${msg}`); process.exit(2); };

const src = readFileSync(join(root, "src/engine.js"), "utf8");
const stale = MUTANTS.filter(([, from, to]) => src.split(from).length !== 2 || from === to);
for (const [name, from] of stale) console.log(`BROKEN  ${name} (pattern found ${src.split(from).length - 1} times in src/engine.js, need exactly 1)`);
if (stale.length) invalid(`${stale.length} of ${MUTANTS.length} patterns do not match src/engine.js; repair them in tests/mutate.mjs`);
if (!existsSync(join(root, "src/vendor"))) invalid("src/vendor is missing; run node scripts/fetch-vendor.mjs first");

// A complete copy of the tool: every root file, src/, tests/ and scripts/. The fetched libraries and models are linked, not copied.
const FETCHED = ["vendor", "models"];
function copyTree(dir) {
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(root)) if (statSync(join(root, f)).isFile()) cpSync(join(root, f), join(dir, f));
  for (const d of ["tests", "scripts"]) cpSync(join(root, d), join(dir, d), { recursive: true });
  cpSync(join(root, "src"), join(dir, "src"), { recursive: true, filter: s => !FETCHED.some(f => s === join(root, "src", f)) });
  for (const f of FETCHED) if (existsSync(join(root, "src", f))) symlinkSync(join(root, "src", f), join(dir, "src", f));
}
// Runs the checks in dir and resolves { pass, by }: by is the first FAIL line, or how the process ended.
// With stopAtFail the run is ended at its first FAIL line; a passing run always goes to the end.
async function judge(dir, stopAtFail) {
  for (const args of CHECKS) {
    const r = await new Promise(res => {
      const p = spawn("node", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] }); let out = "", err = "", by = null;
      const limit = setTimeout(() => { by = "timed out after 10 min"; p.kill("SIGKILL"); }, 600000);
      p.stdout.on("data", d => { out += d; if (by) return; const m = out.match(/^FAIL.*\n/m); if (m) { by = m[0].trim(); if (stopAtFail) p.kill("SIGKILL"); } });
      p.stderr.on("data", d => { err += d; });
      p.on("close", code => { clearTimeout(limit);
        res(code === 0 && !by ? { pass: true } : { pass: false, by: `${args[0]}: ${by || err.trim().split("\n").find(l => /error/i.test(l)) || `exit ${code}`}` }); });
    });
    if (!r.pass) return r;
  }
  return { pass: true };
}

const t0 = Date.now(), secs = () => ((Date.now() - t0) / 1000).toFixed(0);
rmSync(work, { recursive: true, force: true });
copyTree(join(work, "pristine"));
const clean = await judge(join(work, "pristine"), false);
if (!clean.pass) invalid(`the unchanged source fails in the work folder, so no mutant can be judged (${clean.by})`);
console.log(`ok      unchanged source passes ${CHECKS.map(a => a[0]).join(" and ")} in the work folder (${secs()} s)`);

const results = new Array(MUTANTS.length); let next = 0;
await Promise.all(Array.from({ length: Math.min(MUTANTS.length, Math.max(1, availableParallelism() - 1)) }, async () => {
  for (let i = next++; i < MUTANTS.length; i = next++) {
    const [, from, to] = MUTANTS[i], dir = join(work, String(i)); copyTree(dir);
    writeFileSync(join(dir, "src/engine.js"), src.replace(from, () => to));
    results[i] = await judge(dir, true); rmSync(dir, { recursive: true, force: true });
  }
}));
const survivors = [];
MUTANTS.forEach(([name], i) => { const r = results[i]; if (r.pass) survivors.push(name); console.log(r.pass ? `SURVIVED  ${name}` : `killed  ${name}  [${r.by.slice(0, 140)}]`); });
rmSync(work, { recursive: true, force: true });
console.log(`\nmutation score: ${MUTANTS.length - survivors.length}/${MUTANTS.length} planted bugs caught` + (survivors.length ? `; tests miss: ${survivors.join("; ")}` : "") + ` (${secs()} s)`);
process.exit(survivors.length ? 1 : 0);
