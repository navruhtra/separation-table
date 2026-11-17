// Release discipline for the Separation Table. src/version.js is the one source of the version; this checks the rest agrees.
//   node scripts/release.mjs check [--tag <tag>]   version.js = package.json = top CHANGELOG entry = releases/<v>.md = README status;
//                                           with --tag, the tag names the same version (CI runs this on every PR and tag)
//   node scripts/release.mjs draft [--minor|--major] the next CHANGELOG entry, drafted from the merged PR titles since the last tag
//                                           that touched this folder and are not in CHANGELOG.md yet (printed, not written)
//   node scripts/release.mjs tag                   check, then make the annotated tag for version.js locally. It refuses a tag that
//                                           exists here or on origin: a published tag is never moved or replaced.
// Tags: vX.Y.Z (separation-table-vX.Y.Z when this folder sits inside a larger repository).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../src/version.js";

const root = join(dirname(fileURLToPath(import.meta.url)), ".."), argv = process.argv.slice(2);
const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
const read = f => readFileSync(join(root, f), "utf8");
export const tagPrefix = () => { try { return resolve(git("rev-parse", "--show-toplevel")) === resolve(root) ? "v" : "separation-table-v"; } catch { return "v"; } };

/** @returns {string[]} one line per disagreement; empty when the release files agree */
export function releaseProblems({ version = VERSION, files = { pkg: read("package.json"), changelog: read("CHANGELOG.md"), readme: read("README.md") }, notes = v => existsSync(join(root, "releases", `${v}.md`)) ? read(`releases/${v}.md`) : null, tag = null, prefix = "v" } = {}) {
  const bad = [];
  if (!/^\d+\.\d+\.\d+$/.test(version)) bad.push(`version.js: "${version}" is not major.minor.patch`);
  const pv = JSON.parse(files.pkg).version; if (pv !== version) bad.push(`package.json version ${pv} is not version.js ${version}`);
  const top = files.changelog.match(/^## (\d+\.\d+\.\d+)\b.*$/m), entry = top ? files.changelog.slice(top.index).split(/\n## (?!#)/)[0] : "";
  if (!top || top[1] !== version) bad.push(`CHANGELOG.md top entry is ${top ? top[1] : "missing"}, not version.js ${version}`);
  else if (!entry.includes(`releases/${version}.md`)) bad.push(`CHANGELOG.md ${version} entry does not link releases/${version}.md`);
  const n = notes(version);
  if (n == null) bad.push(`releases/${version}.md is missing`); else if (!n.startsWith(`# Separation Table ${version}\n`)) bad.push(`releases/${version}.md must start with "# Separation Table ${version}"`);
  const st = files.readme.match(/<!-- status:begin[^>]*-->\nVersion (\d+\.\d+\.\d+)\./); if (!st || st[1] !== version) bad.push(`README.md status block says version ${st ? st[1] : "(none)"}: run node scripts/status.mjs`);
  if (tag != null && tag !== `${prefix}${version}`) bad.push(`tag ${tag} is not ${prefix}${version} (version.js)`);
  return bad;
}

/** The squash-merge subjects "Title (#123)" since the last tag, minus PRs CHANGELOG.md already names. */
export function draftLines(subjects, changelog) {
  const seen = new Set([...changelog.matchAll(/#(\d+)\b/g)].map(m => m[1])), out = [];
  for (const s of subjects) { const m = s.match(/^(.*?)\s*\(#(\d+)\)$/); if (m && !seen.has(m[2])) { seen.add(m[2]); out.push(`- ${m[1].replace(/^Separation (Table|Bench):\s*/i, "")} (#${m[2]})`); } }
  return out;
}
export const bump = (v, part) => { const [a, b, c] = v.split(".").map(Number); return part === "major" ? `${a + 1}.0.0` : part === "minor" ? `${a}.${b + 1}.0` : `${a}.${b}.${c + 1}`; };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cmd = argv[0], prefix = tagPrefix();
  if (cmd === "check") {
    const ti = argv.indexOf("--tag"), bad = releaseProblems({ tag: ti > 0 ? argv[ti + 1].replace(/^refs\/tags\//, "") : null, prefix });
    for (const l of bad) console.log("FAIL", l);
    console.log(bad.length ? `${bad.length} FAILED` : `release files agree on ${VERSION}`); process.exit(bad.length ? 1 : 0);
  } else if (cmd === "draft") {
    const last = git("tag", "--list", `${prefix}*`, "--sort=-v:refname").split("\n").filter(Boolean)[0];
    const subjects = git("log", "--format=%s", ...(last ? [`${last}..HEAD`] : []), "--", ".").split("\n");
    const lines = draftLines(subjects, read("CHANGELOG.md")), next = bump(VERSION, argv.includes("--major") ? "major" : argv.includes("--minor") ? "minor" : "patch");
    console.log(`<!-- Draft from ${lines.length} merged PR titles since ${last || "the first commit"}. Rewrite each line in shop words, drop internal-only ones, then set version.js and package.json to ${next} and add releases/${next}.md. -->`);
    console.log(`## ${next} (${new Date().toISOString().slice(0, 10)})\n\n${lines.join("\n") || "- (no merged PRs since the last tag)"}\n\n[Full release notes](releases/${next}.md)`);
  } else if (cmd === "tag") {
    const tag = `${prefix}${VERSION}`, bad = releaseProblems({ tag, prefix });
    if (git("status", "--porcelain", "--", ".")) bad.push("uncommitted changes in this folder: commit them first");
    if (git("tag", "--list", tag)) bad.push(`tag ${tag} already exists here: a release is never re-tagged; raise the version`);
    try { if (git("ls-remote", "--tags", "origin", `refs/tags/${tag}`)) bad.push(`tag ${tag} already exists on origin: a release is never re-tagged; raise the version`); } catch { bad.push("could not read origin's tags: check the network, then retry"); }
    if (bad.length) { for (const l of bad) console.log("FAIL", l); process.exit(1); }
    git("tag", "-a", tag, "-F", join(root, "releases", `${VERSION}.md`));
    console.log(`Tagged ${tag} at ${git("rev-parse", "--short", "HEAD")}. Review it, then push the tag alone:\n  git push origin refs/tags/${tag}`);
  } else { console.log("usage: node scripts/release.mjs check [--tag <tag>] | draft [--minor|--major] | tag"); process.exit(2); }
}
