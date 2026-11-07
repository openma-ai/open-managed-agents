# Console token gate

CI baseline gate for epic [#501](https://github.com/openma-ai/open-managed-agents/issues/501)
(issue [#502](https://github.com/openma-ai/open-managed-agents/issues/502)).
It freezes the design-token allowlist and the hardcode budget so cleanup PRs
(#503+) cannot silently add debt or new tokens. It does not clean anything.

| File | What it is | Who changes it |
|---|---|---|
| `token-allowlist.json` | The 103 custom property names in `src/styles/console-tokens.css` `:root`. | Shrinks with the token-collapse PRs (#514/#515). Adding a name needs Owner approval. |
| `hardcode-baseline.json` | `ceiling`: the frozen epic baseline (170). `files`: the per-file should-token budget. | Every cleanup PR lowers its files in the same PR. Raising needs Owner approval. |
| `approved-components.json` | Owner-approved new component files. | Only after Owner approval. |

The scanner is `apps/console/scripts/token-audit.mjs` (plain Node, no install).
Its rules are pinned by `apps/console/scripts/token-audit.test.mjs`.

## Commands

```bash
# Report: totals + per-file breakdown (css / tsx arbitrary / inline)
pnpm --filter managed-agents-console token-audit
pnpm console:token-audit                       # same, from the repo root

# Every hit with file:line, or only the files your PR owns
pnpm --filter managed-agents-console token-audit -- --hits
pnpm --filter managed-agents-console token-audit -- --file src/styles/console-shell.css --file src/components/AppShell.tsx

# The CI gate (CI also passes --base origin/<base> for the git-diff checks)
pnpm --filter managed-agents-console token-audit:check

# After a cleanup: lower the budgets / drop removed tokens, then commit token-gate/*.json
pnpm --filter managed-agents-console token-audit:update

# Classifier tests
pnpm --filter managed-agents-console test:token-audit

# Machine-readable output
node apps/console/scripts/token-audit.mjs --json
```

## What fails CI

The `console-token-gate` job (`.github/workflows/ci.yml`, required through
`verify`) runs `token-audit.mjs --check --base origin/<base>` on every pull
request. It fails when:

1. **New token.** `console-tokens.css` `:root` declares a name that is not in
   `token-allowlist.json`. Message: *Owner approval needed — reuse an existing
   token, or ask the Owner and explain why the existing tokens are
   insufficient.*
2. **Over budget.** A file has more should-token hits than its budget (a file
   that is not listed has budget 0), or a category total exceeds the frozen
   `ceiling` (css 110 / tsx arbitrary 57 / inline style 3 / total 170).
3. **Stale budget (ratchet).** A file has fewer hits than its budget, or a
   token was removed but is still allowlisted. Run `token-audit:update` and
   commit the result in the same PR. `--update` only lowers; it refuses to add
   a token or raise a budget.
4. **Raised baseline.** Compared with the base branch, the PR adds allowlist
   names, raises a budget total or the ceiling, or adds an
   `approved-components.json` entry, without the PR label
   `owner-approved:console-tokens`.
5. **New component file.** The PR adds a file under `src/components/ui/**`,
   directly under `src/components/` (a top-level wrapper; same-name wrappers of
   a `ui/` primitive are called out), or under a `src/components/<dir>/` other
   than `ai-elements` / `session` / `timeline`, and the file is not in
   `approved-components.json` with an `approval` link. Checklist printed by the
   gate: Owner approved · no existing primitive/wrapper fits · existing tokens
   only · screenshots for every importing route.

Owner approval path: the Owner applies the `owner-approved:console-tokens`
label, the author runs `token-audit:update -- --allow-raise` (or edits the
JSON) and re-runs the job. Labels do not retrigger CI by themselves.

## Classifier rules

Scanned: `apps/console/src/**/*.css`, and `*.ts` / `*.tsx` under
`apps/console/src` except tests (`*.test.*`, `*.spec.*`, `test/`, `mocks/`).

### CSS (one count per declaration)

A **literal** is a length in `px rem em pt pc cm mm in ch ex`, a hex color, or
a color function with numeric channels (`rgb() hsl() oklch() …`). Literals
inside `var(--x, <fallback>)` count. Comments are ignored.

| Class | Rule | Budgeted |
|---|---|---|
| `ok` | No literal, or only allowed literals: `0` (any unit); `1px`/`-1px` hairlines; `-9999px` offscreen honeypots; `em` in `letter-spacing`; `#000`/`#fff` stops in `mask*`. Percentages, viewport units (`vh vw svh dvh …`), `fr`, time (`ms s`), unitless numbers (`font-weight`, `line-height: 1.08`, `opacity`), color-mix `%` and `@media` breakpoints are never literals. | no |
| `in_token_def` | A custom property definition (`--x: …`), e.g. composer locals in `index.css` or print overrides of shared brand tokens. | no |
| `should-token` | Any other literal. Also: re-assigning a **console-tokens.css** token to a literal outside that file (page inset overrides such as `--detail-frame-inset: 18px` in a media query), and `var(--density-unit) * N` outside `console-tokens.css` (a disguised `Npx`). | yes |
| `hljs` | Literal colors in a rule whose selectors all target highlight.js (`.hljs`, `.hljs-*`). Reported separately (11). | no |

### Tailwind arbitrary values in TS/TSX (one count per class)

A class `utility-[value]` (with any variants). Bracket groups followed by `:`
are variants (`data-[state=open]:`) and selectors (`[&_svg]:`) are skipped.

| Class | Rule | Budgeted |
|---|---|---|
| `var` | Value references tokens only (`h-[var(--control-h)]`). Health metric. | no |
| `ok` | No dimension or color (`[inherit]`, `transition-[width]`, `grid-cols-[max-content_1fr]`, `z-[60]`), or gradient geometry `bg-[length:…%]`. | no |
| `should-token` | Value contains a length, percentage, viewport size or color and no token. Unlike CSS there are no 1px / em exceptions: Tailwind already has scale classes (`gap-px`, `tracking-tight`), so an arbitrary value is off-scale by definition. | yes |
| `mixed` | Token plus literal (`rounded-[min(var(--radius-md),10px)]`, 12 hits, all shadcn primitives). Reported, not budgeted. | no |

### Inline style (one count per property)

String values inside JSX `style={{ … }}` (single- or multi-line) that contain a
CSS literal (`containIntrinsicSize: "auto 48px"`, `paddingRight: "0.75rem"`).
Computed geometry (`` `${n}px` ``, constants, props) and time strings do not
count.

## Baseline (main @ 0d269031, 2026-11-07)

| Metric | Audit 2026-11-03 | Measured |
|---|---:|---:|
| `:root` tokens | 103 | 103 |
| should-token total | 170 | 170 |
| CSS | 111 | 110 |
| — `console-pages.css` | 51 | 51 |
| — `index.css` | 37 | 37 |
| — `console-list.css` | 12 | 11 |
| — `console-shell.css` | 11 | 11 |
| TSX arbitrary | 57 | 57 |
| inline style | 2 | 3 |
| hljs (allowed) | 11 | 11 |
| health: TSX `[var(--…)]` | 289 | 288 |
| health: CSS declarations using `var(--` | ~490 lines | 472 declarations |

Deltas against the audit (the total matches):

- **inline style +1:** `src/components/ai-elements/code-block.tsx:317`
  `containIntrinsicSize: "auto 200px"` sits in a multi-line `style={{ … }}`.
  The other two hits are single-line (`TimelineView.tsx:395`,
  `SessionDetail.tsx:1425`). The audit appears to have scanned single-line
  style objects only; the gate scans both so multi-line objects are not a
  loophole.
- **`console-list.css` −1:** the gate finds 11 (lines 35, 124, 125, 136, 141,
  142, 143, 298, 313, 314, 315), and also 11 at every commit of #500 (the
  audit tree had #500's 103 tokens) and on main. The remaining declarations
  with numbers are `0`, `1px`/`-1px` hairlines, percentages, `0.01ms` and the
  640px breakpoint, all `ok` per the audit's own exception list. The 12th
  audit hit could not be identified.
