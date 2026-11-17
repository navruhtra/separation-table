# Publishing a release

The version lives in `src/version.js`. Everything else follows
it, and `node scripts/release.mjs check` fails when it does not.

1. Draft the entry: `node scripts/release.mjs draft` prints the
   next CHANGELOG entry from the pull request titles merged since
   the last tag. Rewrite each line in shop words.
2. Set the new version in `src/version.js` and `package.json`.
   Put the entry at the top of CHANGELOG.md, linking
   `releases/<version>.md`, and write that notes file
   (`# Separation Table <version>`, then what changed, how to
   use it, checksums and known limits; see releases/0.1.0.md).
3. If a pin in `scripts/vendor-pins.mjs` changed: `node
   scripts/fetch-vendor.mjs`, then `node scripts/notices.mjs`
   rewrites THIRD-PARTY-NOTICES.md and src/vendor.sha256.
   Commit both.
4. Rebuild the README status: `npm run status`.
5. Merge. CI must be green on the merged commit.
6. Tag the merged commit: `node scripts/release.mjs tag`. It
   reruns the check and makes the annotated tag `v<version>` with the
   notes as its message, then prints the push command. Push
   the tag alone.
7. Make a GitHub release from the tag as a draft. Check its
   notes and checksums, then publish it.

A published tag is never moved, deleted or replaced. The script
refuses a tag that exists here or on origin; a fix is a new
version.
