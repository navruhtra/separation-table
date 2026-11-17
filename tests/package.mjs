// The npm package: `npm pack` makes a tarball that installs and runs sep on its own, with no repo around it.
//   node tests/package.mjs        (needs vendor/: npm run setup). Nothing is published.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { encodePNG } from "../src/cli/platform.mjs";

const HERE = join(dirname(fileURLToPath(import.meta.url)), ".."), TMP = mkdtempSync(join(tmpdir(), "sep-pack-"));
let fails = 0; const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails++; };
const run = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: 300000 });
const pack = run("npm", ["pack", "--json", "--pack-destination", TMP], HERE), info = pack.status === 0 ? JSON.parse(pack.stdout)[0] : null;
ok(!!info, `npm pack makes the tarball (${info ? `${info.filename}, ${(info.size / 1e6).toFixed(1)} MB, ${info.entryCount} files` : pack.stderr.trim().slice(0, 200)})`);
if (info) {
  ok(!info.files.some(f => /^src\/(app|ai|help)\.js$|^tests\/|^src\/models\/|opencv|ort-wasm/.test(f.path)), "the tarball holds the engine and CLI only: no page, tests, models or browser-only libraries");
  const app = join(TMP, "app"), r = run("npm", ["install", "--no-audit", "--no-fund", "--prefix", app, join(TMP, info.filename)], TMP);
  ok(r.status === 0, `the tarball installs (${r.status === 0 ? "ok" : r.stderr.trim().slice(0, 200)})`);
  const bin = join(app, "node_modules", ".bin", "sep"), v = run(bin, ["version"], TMP); ok(v.status === 0 && /^sep \d+\.\d+\.\d+/.test(v.stdout), `the installed sep runs (${v.stdout.trim()})`);
  const W = 120, d = new Uint8ClampedArray(W * W * 4); for (let q = 0; q < W * W; q++) { const x = q % W, y = (q - x) / W, inD = Math.hypot(x - 60, y - 60) < 40; d.set(inD ? [30, 90, 200, 255] : [0, 0, 0, 0], q * 4); }
  writeFileSync(join(TMP, "a.png"), encodePNG(d, W, W));
  const c = run(bin, ["convert", "a.png", "--shirt", "white", "--width", "1", "--dpi", "150", "--screens", "1", "-o", "a.zip", "--quiet"], TMP);
  ok(c.status === 0 && existsSync(join(TMP, "a.zip")), `the installed sep converts art to a job ZIP${c.status ? `: ${c.stderr.trim().slice(0, 200)}` : ""}`);
  const m = spawnSync(bin, ["mcp"], { cwd: TMP, input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n", encoding: "utf8", timeout: 60000 });
  ok(m.status === 0 && JSON.parse(m.stdout.trim().split("\n")[0]).result.tools.length >= 32, "the installed sep mcp lists its tools");
}
rmSync(TMP, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : "all passed"); process.exit(fails ? 1 : 0);
