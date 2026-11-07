# #504 list-surface screenshot regression (light)

Evidence branch for PR openma-ai/open-managed-agents#504 work (`feat/504-tokenize-list`). Not for merge.

- `before/` — `origin/main` @ 0d269031, light theme, 1440×900, DPR 1, fixed clock, reduced motion.
- `after/` — `feat/504-tokenize-list` @ 2c723b6b, same fixtures/viewport.
- `pixel-diff.txt` — exact RGBA pixel comparison before vs after.
- `pixel-diff-flake-control.txt` — `05-runtimes` captured twice with the *same* code: the same 1-pixel
  antialiasing flake appears, so the single differing pixel on Runtimes is capture noise, not the change.
- `*/capture-log.json` — per route: API requests, page errors (none), row count, and computed
  `.console-list-toolbar` `column-gap` (6px both) and `.console-list-toolbar-spacer` `min-width` (8px both).
- `capture-504-regression.mjs` — local Vite + Playwright route fixtures (no backend, no credentials).
  Run: `pnpm --filter managed-agents-console exec vite --port 5604`, then
  `BASE_URL=http://127.0.0.1:5604 OUT=<dir> node apps/console/scripts/capture-504-regression.mjs`.
