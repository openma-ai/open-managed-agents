# Cloud Environment → sandbox provision (PR #498 lane)

## LiteBox vs lane provider

**LiteBox** (`SANDBOX_PROVIDER=litebox`, `@boxlite-ai/boxlite`) is a **Node-local**
sandbox adapter. It is **not** bound on the Cloudflare Workers lane.

Lane Hosting Type **Cloud — provision a sandbox** uses **Cloudflare Containers**
(Firecracker) via worker `sandbox-default-lane-pr-498` /
application `sandbox-default-lane-pr-498-sandbox`.

## Proven live

| Step | Result |
|------|--------|
| `POST /v1/environments` `config.type=cloud` | 201 `env_aeb1c14c…` |
| Model card `deepseek-flash` + cloud Agent | 201 |
| `POST /v1/sessions` on cloud env | 201 |
| SessionDO warmup → container exec / setup-on-warmup | OK (worker logs) |
| User turn → `agent.message` `CLOUD_SANDBOX_OK` → idle | OK `session_910dff3d…` |

## Lane blockers fixed for this evidence

1. Prior deploy used `--containers-rollout=none` and the box has no Docker CLI, so
   no container app existed. Created `sandbox-default-lane-pr-498-sandbox` via CF
   API reusing the staging `openma-runtime` image digest; scaled to 7 instances.
2. `scripts/lane-generate.mjs` only bound `MAIN` on the agent worker. Cloud warmup
   needs `MAIN_MCP` → `McpProxyRpc`. Patched generator + redeployed agent
   (`--containers-rollout=none`).

## Still thin

- Browser loopback pairing remains fixture-only (M1 Attach path already covered by botty).
- Image digest is staging’s (sdk 0.12.10 vs container 0.12.9 warn); full image rebuild needs Docker.
