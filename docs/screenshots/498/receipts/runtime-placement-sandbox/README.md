# Attached Runtime sandbox placement: LiteBox-on-Runtime

Date: 2026-11-05 (America/Detroit). Branch: `draft/runtime-download-selection`.

`_oma.runtime.placement: "sandbox"` selects embedded LiteBox on the attached Runtime machine via `@open-managed-agents/managed-runtime-boxlite` / `createBoxLiteProvider({ providerId: "litebox" })`. The daemon contacts the OMA control plane. This is **separate** from the Cloud Environment main-node `SANDBOX_PROVIDER=litebox` path; the sibling [`litebox-local` receipts](../litebox-local/) do not certify this daemon path.

## Mocked coverage

`packages/cli/test/runtime-placement.test.ts` mocks the managed LiteBox provider and ACP placement factory. Its tests cover:

- Omitted and explicit host placement select the local ACP runtime.
- Sandbox bundle placement selects sandbox ACP through SessionManager and reports `/workspace` as the bundle directory.
- Host cwd / GitHub `local_path` rejection before allocation, with no host fallback on provider failure.
- Durable `litebox` ownership and same-box resume after registry recreation.
- Separate boxes and ownership records per session, with concurrent same-session acquisitions serialized; **one `createBoxLiteProvider` client per registry** (required on real LiteBox — a second embedded client deadlocks on `BOXLITE_HOME`).
- Cross-session and incompatible-provider ownership rejection; a missing retained box is not silently recreated.
- Selected skill package bytes copied into jail-local paths with `writeFileBytes`, jail-local links/config, and ACP resume forwarding.
- Invalid placement/custom directories and cloud/boxrun REST settings rejected; image selection, embedded defaults, and optional `BOXLITE_HOME` verified.

The existing `prepareSandboxBundle` copy path remains in use. No custom Environment host directories are mounted. Sessions receive no other session's handles, paths or caches. Workspace-centric attachment permissions and default-on/opt-out host worktrees are documented; the full directory authorization UI, worktree manager, retention cleanup and Mac support remain design-only.

## Live LiteBox-on-Runtime evidence

Artifacts under [`live/`](./live/). Ran on the shared Linux box with `/dev/kvm`, tip code path `RuntimeSandboxRegistry` + real `@boxlite-ai/boxlite` 0.9.0.

| Item | Value |
|------|-------|
| Provider | `litebox` embedded (`createBoxLiteProvider`) |
| Image | `node:22-bookworm` (default `SANDBOX_IMAGE`) |
| Guest | `Linux boxlite 6.12.76`, `init=/init.krun`, `KRUN_INIT=/boxlite/bin/boxlite-guest`, Node v22.23.4 |
| Session A handle | see `live/session-a-handle.json` (`provider: litebox`) |
| Session B handle | distinct runtimeId; `ISOLATED_OK` / `SKILL_ISOLATED_OK` |
| Skill copy | `writeFileBytes` → `/oma/cache/skills/<sha256>/` + soft-link `/workspace/skills/demo-skill`; marker `RUNTIME_PLACEMENT_SKILL_OK` |
| Resume | same-registry ownership resume restored `SESSION_A_ONLY` + skill link |
| `BOXLITE_HOME` | `/tmp/oma-498-runtime-placement-live/boxlite-home` — isolated from Cloud litebox-local main-node lock on `/home/box/.boxlite` |

### Live finding fixed in this tip

Creating a **new** `createBoxLiteProvider` / embedded client on every `acquire` fails once any box is live (`Only one runtime instance can use a BOXLITE_HOME directory at a time`). `RuntimeSandboxRegistry` now reuses one provider/client per registry. Optional `BOXLITE_HOME` selects an isolated embedded home when another process already owns the default.

### Still not claimed

- Full paired-daemon ↔ control-plane Session turn / ACP model inference (default image has no ACP binary; host has no Docker to bake `apps/main-node/test/fixtures/*-acp-sandbox`).
- Process-restart resume across a new OS process while another holder keeps the BOXLITE_HOME lock.
- Mac certification.

## Online harness-in-sandbox image/cache reuse

| Pattern | Reused by Runtime `placement=sandbox` M1? |
|---------|-------------------------------------------|
| `SANDBOX_IMAGE` env key / default `node:22-bookworm` | Yes (name + default) |
| LiteBox OCI/ext4 materialization under a BOXLITE home | Yes (mechanism; daemon home, not Cloud factory) |
| `prepareSandboxBundle` skill `writeFileBytes` + jail soft-links | Yes |
| `createAcpRuntime({ type: "sandbox" })` placement factory | Intended for ACP spawn (not model-turned in live pack) |
| `packages/harness-runtime-acp` **post-allocation** versioned harness install / `OPENMA_ACP_ARTIFACT_ROOT` | **No** — M1 expects ACP **baked into** `SANDBOX_IMAGE` |
| `apps/main-node` harness-in-sandbox `live.e2e.ts` Docker duplex + fixture Dockerfiles | **No** |
| Cloud `SANDBOX_PROVIDER=litebox` `LiteBoxSandbox` lease path | **No** (sibling `litebox-local` receipts) |

Divergence is intentional for this slice: online/production harness-in-sandbox installs harness software after allocate, independent of the environment image; Runtime placement M1 requires a prepared image containing the selected ACP binary.

## Reproduce verification

```sh
pnpm install
pnpm --filter @openma/cli test test/runtime-placement.test.ts
# live (needs /dev/kvm + optional peer @boxlite-ai/boxlite; set BOXLITE_HOME if default home is locked):
# BOXLITE_HOME=/tmp/oma-rt-boxlite pnpm exec tsx /path/to/probe.mjs
```

Observed mocked results (this tip): **11 tests passed** (`live/vitest.log`). Live SUMMARY: `live/SUMMARY.json` (`ok: true`).
