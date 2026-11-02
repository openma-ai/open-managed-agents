# PR #298 sandbox@1 adaptation — verification report

Date: 2026-11-02 (America/Detroit)

## Adaptation summary
Migrated OMA agent sandbox from `@cloudflare/sandbox` 0.12 (`Sandbox`/`getSandbox`/`ContainerProxy`) to 1.0.3 helpers-only SDK:

- `OmaSandbox` is now a `DurableObject` that owns `ctx.container`, `Files`, `DirectoryBackup`, `S3Mount`
- Outbound via `OmaOutbound` `WorkerEntrypoint` + `interceptAllOutboundHttp/Https`
- Worker exports: `Sandbox` (=OmaSandbox), `OmaOutbound`, `DirectoryBackupGateway`, `S3Gateway` (no `ContainerProxy`)
- `CloudflareSandbox` resolves stubs with `env.SANDBOX.getByName(sessionId)` (+ vitest override)
- Wrangler containers: `scheduling_policy: durable_object`, `images.sandbox.dockerfile`, new app names
- Dockerfile / Dockerfile.sandbox: base image + `COPY` `sandbox-shim` from `cloudflare/sandbox:1.0.3`

## Verification matrix

| Check | Result | Notes |
| --- | --- | --- |
| `pnpm --filter @open-managed-agents/agent exec tsc --noEmit` | PASS | |
| `managed-runtime-cloudflare` typecheck | PASS | |
| `managed-runtime-cloudflare` test:certification:offline | PASS | 19 passed, 1 skipped (live) |
| `apps/agent/tests/cloudflare-sandbox-duplex.test.ts` | PASS | 4/4 |
| `test/unit/harness.test.ts` + `schedule-tool.test.ts` | PASS | 70 tests |
| Local Docker build `apps/agent/Dockerfile.sandbox` | PASS | needs Docker buildx (`--load`) |
| Live CF cert `OMA_CLOUDFLARE_LIVE_CERTIFICATION=1` vitest `cloudflare.live.test.ts` | PASS | ~75s; deployed ephemeral worker on account `44af79e51582ca20c9003eb926540242` |

### Live certification exercised
Against a real Cloudflare Workers + Containers deploy of `apps/agent/test/cloudflare-live-certification-worker.ts` with `Dockerfile.sandbox` (1.0.3 shim):

- Auth gate (401) and invalid sandbox id (400)
- `create` / `read` persistence via `CloudflareSandbox` → DO `getByName` → container `Files`/`exec`
- `renew_lease` → `renewActivityTimeout` / inactivity timeout
- Outbound proxy attach / probe / revoke (`setOutboundByHost` + `OmaOutbound` handlers; secret not in process env; fence params)
- `destroy` + `verify_destroyed`
- R2 checkpoint/restore lane **not** run this pass (`OMA_CLOUDFLARE_R2_CERTIFICATION` unset)
- Harness-in-sandbox artifacts lane **not** run (`OMA_CLOUDFLARE_HARNESS_CERTIFICATION` unset)

## Gaps / residual risk
- R2-backed `createBackup`/`restoreBackup` live path not exercised (needs R2 bucket + access keys)
- Production one-way `scheduling_policy: durable_object` deploy not performed (by design)
- Full toolchain `apps/agent/Dockerfile` (Go/Rust/Python extras) not live-deployed; cert used slim `Dockerfile.sandbox`
- Box needed `docker buildx` plugin for wrangler container builds (`docker build --load`)
- Docs still mention `getSandbox` / `ContainerProxy` / `instance_type` in places (docs PRs separate)
- `@cloudflare/containers` remains in package.json (unused in source); Dependabot group leftover

## Merge stance
Do **not** auto-merge until CI goes green on the pushed branch. Live basic cert is solid; optional follow-up: R2 cert lane.
