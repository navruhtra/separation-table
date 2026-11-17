# Contributing

Thanks for helping. Issues and pull requests are welcome.

## Report a problem

Open an issue. Attach the job file (`job.json` from the
download, or the job ZIP) and the art if you can share it.
A problem we can open again is a problem we can fix.

## Before you open a pull request

Run these in the repository root, after `npm run setup`. All
must pass.

```bash
npm test             # unit, property, read-back, fuzz, CLI and MCP tools
npm run typecheck    # tsc on the files marked @ts-check
npm run gate         # test images within +0.5 mean dE00, CPU within 15%
npm start            # in a second terminal
npm run setup:e2e    # once: Playwright and its Chromium
npm run e2e          # browser end to end
```

The gate needs Python 3 with Pillow.

A change to the engine also shows its effect in the app's
Print view (Auto on, default settings, 390 px wide), before
and after. The bench supports that check; it does not replace
it.

## One change per pull request

Keep a pull request to one feature or one fix, made from
current `main`. A pull request that does several things, or
that conflicts with `main`, will be asked to split. The split
goes in this order:

1. Changes that stand alone and conflict with nothing.
2. Changes that touch code that moved since your branch
   started. Rebase these on `main` first.
3. Changes that need rework or a measured print. These wait.

Each part merges on its own, with its tests.

## Rules for code and data

- No new dependency without a reason in the pull request.
  Pin its version and add its hash to `src/vendor.sha256`.
- Copy no code, model or ink data without a licence that lets
  us ship it under MIT. Name its source in NOTICE.
- Every quality number is a model number until a press run
  measures it. Say so in the text.
- Never write a file over another file unless the user asked.

## Licence

By contributing you agree that your work ships under the MIT
licence in LICENSE.
