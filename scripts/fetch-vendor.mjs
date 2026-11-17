// Download the pinned open-source libraries and AI models into src/vendor/ and src/models/ (both git-ignored).
// The pins are in vendor-pins.mjs; every file is then checked against src/vendor.sha256 (notices.mjs).
//   node scripts/fetch-vendor.mjs [--no-models]
import { execSync } from "node:child_process";
import { mkdirSync, copyFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGES, MODELS, npmSpec } from "./vendor-pins.mjs";
import { verifyVendor } from "./notices.mjs";
const root = join(dirname(fileURLToPath(import.meta.url)), ".."), src = join(root, "src"), cache = join(root, ".cache"), vendor = join(src, "vendor"), models = join(src, "models");
for (const d of [cache, vendor, models]) mkdirSync(d, { recursive: true });
execSync(`npm install --no-save --no-package-lock --prefix "${cache}" ${PACKAGES.map(npmSpec).join(" ")}`, { stdio: "inherit" });
const nm = join(cache, "node_modules");
for (const p of PACKAGES) for (const [from, to] of Object.entries(p.files || {})) copyFileSync(join(nm, p.pkg, from), join(vendor, to));
// quickhull3d: one ESM file; the metafile records which packages went into it (THIRD-PARTY-NOTICES.md lists them)
writeFileSync(join(cache, "qh-entry.js"), "export {default as quickhull} from 'quickhull3d';\n");
execSync(`"${join(nm, ".bin/esbuild")}" "${join(cache, "qh-entry.js")}" --bundle --format=esm --minify --metafile="${join(cache, "quickhull.meta.json")}" --outfile="${join(vendor, "quickhull.js")}"`, { stdio: "inherit", cwd: cache });
const noModels = process.argv.includes("--no-models");
if (!noModels) for (const m of MODELS) {
  const out = join(models, m.file); if (!m.url || existsSync(out)) continue;
  console.log("model", m.file); const r = await fetch(m.url); if (!r.ok) throw new Error(`${m.file}: HTTP ${r.status}`);
  writeFileSync(out, Buffer.from(await r.arrayBuffer()));
}
// sr_x2.onnx (2x upscale) is not downloaded: export-sr-model.py builds it from the Apache-2.0 Swin2SR weights.
if (!noModels && !existsSync(join(models, "sr_x2.onnx"))) console.log("src/models/sr_x2.onnx is missing: run python3 -I scripts/export-sr-model.py for the 2x upscale (needs torch; see NOTICE).");
const bad = verifyVendor({ dir: src, models: noModels ? "skip" : "present" });
if (bad.length) { console.error(bad.join("\n")); process.exit(1); }
console.log(noModels ? "Vendor files are ready and match vendor.sha256 (models skipped)." : "Vendor files and models are ready and match vendor.sha256.");
