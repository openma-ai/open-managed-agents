# Modal token browser regression

Related: [#506](https://github.com/openma-ai/open-managed-agents/issues/506),
parent [#501](https://github.com/openma-ai/open-managed-agents/issues/501).

This is a production-build browser check, with intercepted API fixtures. It
does not exercise a backend, credentials, or deployment. Install the workspace
dependencies and Playwright Chromium first, then:

```sh
pnpm --filter managed-agents-console build
pnpm --filter managed-agents-console exec vite preview --host 127.0.0.1 --port 4186 --strictPort
# In another terminal:
node test/e2e/console-modal-tokens.mjs
```

The script writes screenshots and `results.json` under
`test-results/modal-tokens`. `MODAL_BASE_URL` and `MODAL_OUTPUT` override the
server and output directory. Run against a separately served pre-change build
with `MODAL_BASELINE=1` to check unchanged defaults without the new-token
override assertions. `MODAL_CASE`, `MODAL_THEME`, and `MODAL_DESKTOP=1` narrow
the matrix for diagnosis.

The matrix covers 19 entry points on 15 routes, light and dark at 1280×900;
session creation, workspace creation, and deployment confirmation also run at
390×640 with both 16px and 20px root fonts. Each reachable modal is captured
closed, open, and after Escape. Checks cover the existing 70vh effective
height cap, viewport containment, rem padding, overflowing mobile body
scrolling, and confirmation-only dimming. The after-build checks independently
change the viewport-cap token, the existing top-offset token, the light/dark
stylesheet variant, and the confirmation dim token. They wait for the existing
100ms CSS transition rather than inspecting its first animation frame.

## Coverage limits

- 48 open/dismissed cases plus two **closed-only** Trajectory cases. On the
  current base, `SessionDetail` initializes trajectory to `undefined` and only
  resets it to `undefined`; the Trajectory button stays disabled. The script
  records this limitation rather than forcing React state or enabling the
  button. It does not claim to test the Trajectory viewer open state.
- The global TenantSwitcher is exercised on `/agents`, including its mobile
  sidebar entry. Other shell routes inherit that component, but this matrix
  does not claim screenshots of every possible shell route or data state.
- API lists use deterministic fixtures, not live service data. These checks
  establish browser rendering/interaction, not backend integration coverage.

## Token-gate coordination

PR #547 was still open when this change was prepared. Once its gate is merged,
its `apps/console/token-gate/token-allowlist.json` must include exactly these
two new names through its owner-approved token path:

- `--modal-viewport-cap`
- `--modal-confirmation-dim`

No classifier or hardcode budget changes are needed. The #547 scanner reports
scoped should-token **0 → 0**, whole-console **170 → 170**, and root tokens
**103 → 105**. The old height expression was an unbudgeted mixed value; the old
`bg-black/35` utility was outside its arbitrary-value classifier. Removing those
two component literals is not a measured budget reduction and does not satisfy
#506's original decrease criterion.
