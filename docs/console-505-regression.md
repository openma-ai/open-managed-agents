# Filter and combobox dimensions (#505)

Related: [#505](https://github.com/openma-ai/open-managed-agents/issues/505),
parent [#501](https://github.com/openma-ai/open-managed-agents/issues/501).

## Narrow exception to the existing-token rule

The initial audit found no semantically appropriate tokens for these three
uses. The Owner then delegated this specific design judgment ("你觉得呢？我肯定没有你懂ui").
This change adds only the three missing component dimensions, retaining their
existing values and units. These are **new tokens**, not reused tokens:

| Token | Value | Consumers |
| --- | --- | --- |
| `--filter-chip-clear-w` | `20px` | `.console-filter-chip-clear` width and flex basis |
| `--combobox-menu-min-w` | `200px` | Combobox popover minimum width |
| `--local-combobox-menu-max-h` | `18rem` | LocalCombobox default `maxHeight` |

They live beside the existing chip/control dimensions in `console-tokens.css`.
`--switch-h` and typography line heights were rejected despite equal numeric
values: changing a switch or type scale must not resize a filter clear action.
`--filter-chip-max-w` governs a chip's maximum width, not a dropdown's minimum.
LocalCombobox still passes a caller-supplied `maxHeight` directly to its inline
style; only the omitted-prop default changes to a variable reference.

FilterChip.tsx and FacetedFilter.tsx already have zero scanner hits and remain
unchanged. Only the chip-owned clear-action rule in console-list.css changes.
No colors, shadows, behavior, new components, or unrelated list/shell styles change.

## Scanner and pending gate coordination

Measured with the unmodified scanner from #547 at
`7896a8f76d1bc35052343765c7672c51ec255ba1`
(`apps/console/scripts/token-audit.mjs`, blob
`c234c1dd7319afeb21022403e7a03d7226bcf960`). #547 was still open during this work.

| Measurement | Base | This change |
| --- | ---: | ---: |
| Root token names | 103 | 106 |
| Console CSS hardcodes | 110 | 108 |
| Console TSX arbitrary hardcodes | 57 | 56 |
| Console inline-style hardcodes | 3 | 3 |
| Console total | 170 | 167 |
| Combobox.tsx | 1 | 0 |
| Chip-owned CSS declarations | 2 | 0 |
| Entire console-list.css | 11 | 9 |

The removed hits are Combobox.tsx:293 and console-list.css:124–125 on base
`0d26903185e3fd8bb89c6499ae21f021e3a3b23e`. LocalCombobox's former `18rem`
prop default is outside this scanner's inline-literal classifier, so that
cleanup does not reduce its count. No scanner or baseline files were changed.

Whichever PR lands after #547 must add the three names above to the allowlist,
record this delegated exception with `owner-approved:console-tokens`, and
ratchet Combobox's budget 1→0 and console-list.css 11→9. If #549 has also landed,
console-list.css becomes **7**, since its two removed declarations are separate.
The original category ceilings remain frozen; do not raise them. Review only
these three allowlist additions and the relevant per-file budget changes when
running the gate's approved update workflow. #548 and #554 are independent.

To reproduce the measurement with the fetched scanner:

```sh
node /tmp/token-audit.mjs --root apps/console --json
```

## Browser coverage and reproduction

All captures use local Vite and synthetic API responses; no backend, real
credentials, OAuth, publication, or deployment is involved. The fixtures
provide populated rows and selectable items. They exercise the UI controls,
not server-side filter correctness. External assets/requests are blocked.

At 1440×900 and 390×900, light theme, DPR 1, UTC, English, fixed clock:

| Routes / callers | States |
| --- | --- |
| `/agents`, `/sessions`, `/deployments`, `/environments`, `/runtimes`, `/evals`, `/files`, `/skills`, `/vaults`, `/memory`, `/model-cards`, `/loops` | Populated; each chip open, selected and clear-hover; cleared |
| `/vaults/vault_01demo` | Populated credentials; type chip; Add credential → LocalCombobox open, empty, searched, picked, cleared |
| `/deployments/new` | Agent and environment pickers open, empty search, keyboard selection |
| `/integrations/linear/install-pat`, `/integrations/linear/publish`, `/integrations/slack/publish`, `/integrations/github/bind` | Both resource pickers open, empty search, keyboard selection |
| `/agents` → new Agent form; `/agents/agent_01demo` → edit | Both model Comboboxes open, empty search, keyboard selection |
| `/sessions` → Create session | Agent and environment pickers open, empty search, keyboard selection |

This is 21 route/flow cases × 2 viewport widths = 42 cases, 248 screenshots
per revision. The capture asserts the actual computed clear width/flex basis
and dropdown minimum width, plus LocalCombobox's computed maximum height.
Before each chip interaction it resets horizontal scroll positions: browser
automation can scroll overflow-hidden ancestors to reveal long mobile chips.
Screenshots disable animations; they do not change product layout styles.

After installing the repo's locked dependencies, start Vite in `apps/console`:

```sh
node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5195 --strictPort
```

Use the same scripts/fixtures from this PR against base code and changed code,
respectively, preserving both capture directories under the repository root:

```sh
node apps/console/scripts/capture-505.mjs before
node apps/console/scripts/capture-505.mjs after
node apps/console/scripts/compare-505.mjs
node apps/console/scripts/verify-505-dimensions.mjs
```

The comparison decodes PNGs in Chromium and compares exact RGBA pixels; it also
checks matching capture sets and computed styles. JSON evidence lives under
`.docs/screenshots/505/`. `ONLY=agents,vault-detail` supports focused diagnostic
captures, which write a separate result manifest.

The additional dimension contract script uses real components to check:

- A 160px trigger still yields a 200px menu, then a 260px token override
  changes the actual menu width to 260px.
- A chip clear-width override changes both width and flex basis from 20 to 24px.
- LocalCombobox's 18rem is 288px at a 16px root and 360px at a 20px root.
  A caller's 112px override survives a token change; omitting it resumes the token.

Console validation commands, from `apps/console`:

```sh
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vitest/vitest.mjs run
node node_modules/vite/bin/vite.js build
```

Limitations: Chromium only; screenshots are of dev-server rendering, while the
production bundle is build-checked. No dark screenshots were taken because no
colors or shadows changed. Existing mobile overflow behavior is not redesigned.
See the PR for evidence links, exact pixel results, and current-head CI.
