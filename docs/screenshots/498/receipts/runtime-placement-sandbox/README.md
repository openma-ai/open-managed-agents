# Attached Runtime sandbox placement: mocked LiteBox coverage

Date: 2026-11-05. Branch: `draft/runtime-download-selection`. Draft implementation; no live LiteBox-on-Runtime daemon execution is claimed.

`_oma.runtime.placement: "sandbox"` selects embedded LiteBox on the attached Runtime machine via `@open-managed-agents/managed-runtime-boxlite` / `createBoxLiteProvider({ providerId: "litebox" })`. The daemon contacts the OMA control plane. This is separate from the Cloud Environment main-node `SANDBOX_PROVIDER=litebox` path; the sibling [`litebox-local` receipts](../litebox-local/) do not certify this daemon path.

## Coverage

`packages/cli/test/runtime-placement.test.ts` mocks the managed LiteBox provider and ACP placement factory. Its nine tests cover:

- Omitted and explicit host placement select the local ACP runtime.
- Sandbox bundle placement selects sandbox ACP through SessionManager and reports `/workspace` as the bundle directory.
- Host cwd / GitHub `local_path` rejection before allocation, with no host fallback on provider failure.
- Durable `litebox` ownership and same-box resume after registry recreation.
- Separate boxes and ownership records per session, with concurrent same-session acquisitions serialized.
- Cross-session and incompatible-provider ownership rejection; a missing retained box is not silently recreated.
- Selected skill package bytes copied into jail-local paths with `writeFileBytes`, jail-local links/config, and ACP resume forwarding.
- Invalid placement/custom directories and cloud/boxrun REST settings rejected; image selection and embedded defaults verified.

The existing `prepareSandboxBundle` copy path remains in use. No custom Environment host directories are mounted. Sessions receive no other session's handles, paths or caches. Workspace-centric attachment permissions and default-on/opt-out host worktrees are documented; the full directory authorization UI, worktree manager, retention cleanup and Mac support remain design-only.

## Reproduce verification

Run from the repository root:

```sh
pnpm install
pnpm exec vitest run packages/managed-agents-api/test/environments-runtime-attachment.contract.test.ts packages/managed-agents-application/test/environments-application.test.ts test/integration/runtimes-route.test.ts
pnpm --filter @openma/cli test test/runtime-placement.test.ts
pnpm --filter @openma/cli test
pnpm --filter managed-agents-console test src/lib/env-overlay.test.ts src/pages/EnvironmentDetail.runtime.test.tsx
pnpm --filter @open-managed-agents/managed-runtime-boxlite test test/boxlite-boundaries.test.ts
pnpm --filter @openma/cli typecheck
pnpm --filter managed-agents-console typecheck
pnpm --filter @openma/cli build
node packages/cli/dist/index.js --help
node scripts/check-dependency-sources.mjs
```

Observed results:

| Check | Result |
|---|---|
| API contract + application + Runtime bundle route | 3 files, 48 tests passed |
| CLI placement, mocked LiteBox | 1 file, 9 tests passed |
| Full CLI suite (includes placement) | 13 files, 73 passed, 1 existing skipped test |
| Console env overlay + EnvironmentDetail Runtime | 2 files, 6 tests passed |
| Managed BoxLite provider boundary suite | 1 file, 13 tests passed; mocked SDK |
| CLI and Console TypeScript | Passed |
| CLI build and built help command | Passed |
| Dependency source policy | Passed |

The native `@boxlite-ai/boxlite` SDK is an external optional peer in the CLI build: it is required only for sandbox execution, not ordinary host commands. Bundling it pulled in unrelated browser dependencies and failed; externalizing the peer fixed the build. CLI dependencies and its lockfile importer contain no OpenSandbox adapter/SDK. Existing control-plane providers are unchanged.

## Deferred live evidence and prerequisites

Live attached-Runtime daemon allocation, ACP inference, restart/resume and isolation evidence are deferred. No production deployment or model call was performed. A live run requires a supported Runtime host with local LiteBox support, the `@boxlite-ai/boxlite` peer installed, and a prepared `SANDBOX_IMAGE` containing Node and the selected ACP binary. The default `node:22-bookworm` does not itself install an ACP binary. REST/cloud BoxRun is not supported by this slice.

The existing Agent Runtime binding is still required for routing; attaching an Environment alone does not consume the Environment Work queue. Workspace-grant enforcement on attachment writes remains a documented gap. Automatic retention/cleanup and Mac certification are outside this slice.
