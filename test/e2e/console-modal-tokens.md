# Modal token browser regression

Related: [#506](https://github.com/openma-ai/open-managed-agents/issues/506),
parent [#501](https://github.com/openma-ai/open-managed-agents/issues/501).

These are real browser renders with deterministic API fixtures, not live
backend or deployment certification. Install workspace dependencies and
Playwright Chromium first. Retain a production build of base
`0d26903185e3fd8bb89c6499ae21f021e3a3b23e` for the before comparison, and build
this branch for the after comparison. Serve each build on a separate port:

```sh
pnpm --filter managed-agents-console build
pnpm --filter managed-agents-console exec vite preview --host 127.0.0.1 --port 4187 --strictPort
# Serve the retained before build on port 4186 in another terminal.
MODAL_BASELINE=1 MODAL_OUTPUT=test-results/modal-before node test/e2e/console-modal-tokens.mjs
MODAL_BASE_URL=http://127.0.0.1:4187 MODAL_OUTPUT=test-results/modal-after node test/e2e/console-modal-tokens.mjs
```

`MODAL_BASELINE=1` omits the new-token override checks on the old build.
`MODAL_CASE` (comma-separated case names), `MODAL_THEME`, and
`MODAL_DESKTOP=1` narrow the matrix. Output includes screenshots and
`results.json`. The same driver and fixtures must be used for both builds.

## Direct callers and inherited shell coverage

The default matrix covers 19 entry points on 15 routes, light/dark at
1280×900. Session creation, workspace creation and deployment confirmation
also run at 390×640 with 16px and 20px root fonts. This gives 48 open/close
cases and two disabled Trajectory route checks per build.

`console-modal-closure.mjs` parses the real TypeScript import/re-export graph
and router. At this base it finds Modal **17**, Select **9**, Input **5** and
Avatar **6** direct importers; transitive importer counts are 25/12/10/18.
Modal reaches every protected route through
`TenantSwitcher → AppSidebar → AppShell`. The registry contains no plugin
routes; the inventory fails if plugins appear rather than silently omitting
them. The separate `/join`, `/login`, `/cli/login`, and `/connect-runtime`
branches do not mount that shell. Importing a shared module does not imply
mounting all its exported components.

```sh
node test/e2e/console-modal-closure.mjs > test-results/modal-closure.json
MODAL_SHELL=1 MODAL_BASELINE=1 MODAL_OUTPUT=test-results/shell-before node test/e2e/console-modal-tokens.mjs
MODAL_SHELL=1 MODAL_BASE_URL=http://127.0.0.1:4187 MODAL_OUTPUT=test-results/shell-after node test/e2e/console-modal-tokens.mjs
```

Shell mode opens Create workspace through the actual sidebar on all **43
router entries** (40 page routes, two explicit redirects and the shell-only
`/integrations` parent), in both
themes. It records the final URL, including normal redirects. The bare
`/loops/new` intentionally redirects to template selection, so an additional
`/loops/new?template=slack-agent` case mounts the actual creation form.
Six cases also run on mobile with both root fonts: home, environment detail,
skills, bare and configured new-loop routes, and GitHub bind. Total: **112
open/close cases and 336 screenshots per build**. The submitted evidence
stores the initial 104-case sweep, six configured-loop cases and two shell-only parent
cases separately.
No product code or route behavior is changed for this matrix.

Each modal is captured closed, open and after Escape. Assertions cover the
70vh effective cap, viewport containment, rem padding, mobile long-form
scrolling and confirmation-only dimming. The after build independently changes
the cap token, existing top-offset token, light/dark stylesheet variant, and
confirmation-dim token. Assertions wait for the existing 100ms transition.

## Trajectory: isolated component versus blocked route

The actual SessionDetail route still cannot open Trajectory on this base.
`trajectory` is initialized to `undefined`; its only setter call resets it to
`undefined`. The button is disabled while that value is undefined/loading.
The route check records the disabled state, a normal click timing out with
`element is not enabled`, no opened Modal and the actual API request paths.
It never forces React state or removes the disabled attribute.

The real exported `TrajectoryViewerModal` is separately rendered using a
small ephemeral fixture entry under ignored `node_modules/.cache`, with the
exact retained production CSS/assets from each revision. Only the before
fixture substitutes the baseline Modal source. Using the retained CSS avoids
rebuilding old Tailwind classes against the current source scan.

```sh
MODAL_BEFORE_DIST=/absolute/path/to/before-dist MODAL_OUTPUT=/tmp/trajectory-build node test/e2e/console-trajectory-fixture.mjs --build
# Serve /tmp/trajectory-build/before and /after with vite preview on 4188/4189.
MODAL_BASE_URL=http://127.0.0.1:4188 MODAL_OUTPUT=test-results/trajectory-before node test/e2e/console-trajectory-fixture.mjs
MODAL_BASE_URL=http://127.0.0.1:4189 MODAL_OUTPUT=test-results/trajectory-after node test/e2e/console-trajectory-fixture.mjs
```

`MODAL_BASE_REF` defaults to the base commit above; `MODAL_AFTER_DIST`
defaults to `apps/console/dist`. The fixture labels itself as isolated and uses
the same deterministic trajectory in both revisions. Ten cases per build
cover ready/loading/error in both themes, plus ready on mobile at both root
fonts. It checks actual open/Escape close, JSON download, scrolling, padding,
height and viewport containment; 36 screenshots per build include the
scrolled ready state. **This fills component rendering coverage, not route
reachability.** Repairing the missing trajectory-loading flow is outside this
Modal-token change. No live-backend, hosted-plugin, Safari/Firefox, or every
possible data-state coverage is claimed.

## Token-gate coordination

PR #547 was still open during this follow-up. When its gate is integrated,
`apps/console/token-gate/token-allowlist.json` needs this PR's two new names
through the `owner-approved:console-tokens` path:

- `--modal-viewport-cap`
- `--modal-confirmation-dim`

PR #555 independently adds:

- `--filter-chip-clear-w`
- `--combobox-menu-min-w`
- `--local-combobox-menu-max-h`

A temporary three-way merge against base `0d269031` confirmed the token file
combines cleanly with #555 head `b1167b0959e130942615182e4386224663616693`.
The #547 scanner at `7896a8f76d1bc35052343765c7672c51ec255ba1` reports
**108 root tokens and 167 should-token** (108 CSS / 56 TSX / 3 inline) for
that combined source. The gate integrator must preserve all five additions.
Only #555 ratchets the Combobox budget 1→0 and console-list budget 11→9
(account for #549 separately if it has also landed).

This PR alone has scoped should-token **0→0**, whole-console **170→170**,
root tokens **103→105**, and mixed TSX expressions **12→11**. The old height
expression was an unbudgeted mixed value; `bg-black/35` was outside the
arbitrary-value classifier. Removing those two component literals does not
satisfy #506's original decrease criterion. This PR changes neither scanner
classification nor hardcode budgets and does not close #506.
