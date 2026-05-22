# Webhook / OAuth / MCP mocks for e2e testing

External-integration paths (Linear / GitHub / Slack inbound webhooks, MCP
proxy refresh-token, OAuth install) were uncovered by `e2e.sh /
e2e-advanced.sh / e2e-tools.sh` — those run end-to-end through the gateway
but assume real third-party services on the other side. This directory
holds the mock infrastructure that closes that gap.

## What's implemented

### `webhook-signatures.ts` + `fire-webhook.ts`

Pure-Node CLI that produces correctly-HMAC-signed inbound webhook payloads
for the three providers and POSTs them at an OMA integrations gateway.

```bash
tsx test/mocks/fire-webhook.ts slack <gateway> <pubId> <signingSecret> "<@U_BOT> hi"
tsx test/mocks/fire-webhook.ts github-labeled <gateway> <pubId> <webhookSecret> 1 oma:engage
tsx test/mocks/fire-webhook.ts github-comment <gateway> <pubId> <webhookSecret> 1 "follow-up"
tsx test/mocks/fire-webhook.ts linear-mention <gateway> <pubId> <webhookSecret> "Issue title"
tsx test/mocks/fire-webhook.ts linear-assigned <gateway> <pubId> <webhookSecret> "Issue title"
```

`test/e2e/e2e-webhooks.sh <gateway> <provider> <pubId> <secret>` wraps the
above into a per-provider scoreboard.

### Operator workflow

Webhook test requires a real `publication` row + its webhook/signing secret.
Today the secrets land on the install wizard's verify-credentials toast.
For test purposes you can also fetch them via the API (encrypted at rest,
exposed in the response of the publish endpoint right after credential
submission).

## What's NOT implemented (deferred)

Both addressed below — keeping this section for historical context.

### Done: mock CF Worker (MCP proxy + OAuth provider)

`test/mocks/mock-server/` — a single CF Worker that serves both MCP and OAuth mock endpoints. Deployed at https://oma-mock-services.hrhrngxy.workers.dev (workers.dev subdomain — no DNS, no auth, public).

**MCP scenarios** (per-bearer-token state in a Durable Object):

| Path | Behavior |
|------|----------|
| `/mcp/ok/...` | Always 200 with a valid `tools/list` JSON-RPC response |
| `/mcp/401-once/...` | First call per bearer → 401 with `WWW-Authenticate`; subsequent calls 200 |
| `/mcp/403-always/...` | Every call → 403 (tests the 403→refresh trigger added to mcp-proxy) |
| `/mcp/expire/{ttl_seconds}/...` | Bearer valid for ttl from first use, then 401 |

A "new" bearer always gets a fresh 401 budget — this is how the mcp-proxy refresh path is exercised: gateway hits `/mcp/401-once/...` with the stale bearer → 401 → gateway hits `/oauth/token` to refresh → retries `/mcp/401-once/...` with the new bearer → 200.

**OAuth endpoints:**

| Path | Behavior |
|------|----------|
| `GET /oauth/authorize?redirect_uri=&state=` | 302 to `{redirect_uri}?code=mock_code_<rand>&state=<state>` |
| `POST /oauth/token` with `grant_type=authorization_code&code=mock_code_*` | 200 with `{access_token, refresh_token, token_type:"Bearer", expires_in}` |
| `POST /oauth/token` with `grant_type=refresh_token&refresh_token=mock_rt_*` | Same shape; rotates both tokens (matches real Linear/Slack/GitHub) |

**Admin:**

| Path | Behavior |
|------|----------|
| `GET /__/state` | Dump bearer→state map per scenario (debug) |
| `POST /__/reset` | Wipe state (test isolation) |

**Smoke:** `./test/e2e/e2e-mock-services.sh` — 16 assertions, ~3s.

### Wiring through OMA gateway (real refresh-token e2e)

To exercise the full mcp-proxy refresh-token path through OMA against this mock:

1. Create a vault credential with `auth.type=mcp_oauth`, pointing `mcp_server_url` at e.g. `https://oma-mock-services.hrhrngxy.workers.dev/mcp/401-once/...` and `token_endpoint` at `https://oma-mock-services.hrhrngxy.workers.dev/oauth/token`.
2. Create an agent that references that vault credential as an MCP server.
3. Create a session, send a user message that should result in the agent calling the MCP tool.
4. Observe the gateway's `forwardWithRefresh` path: 401 → refresh → 200, all in SSE telemetry.

(Same flow for `/403-always` if you want to verify the 403→refresh trigger we added in this PR.)

### Future improvements

- `/mcp/server-side-event-stream/...` — long-lived SSE responses to test how the gateway handles streaming bodies during refresh.
- Per-credential bearer expiry programmable via query string instead of path (`?ttl=` overrides the path-embedded TTL).

## When to use which

| Surface                                  | How to test today                                        |
| ---------------------------------------- | -------------------------------------------------------- |
| Agent / Env / Session / SSE              | `e2e.sh`, `e2e-local.sh`                                 |
| Tool execution (write / bash / multi)    | `e2e-tools.sh`                                           |
| Memory / vault / cred / files / dup-cred | `e2e-advanced.sh`                                        |
| Webhook delivery (post-install)          | `e2e-webhooks.sh` ← this directory                       |
| MCP-proxy 401→refresh / 403→refresh      | `e2e-mock-services.sh` against the mock CF Worker        |
| OAuth /authorize + /token round-trip     | `e2e-mock-services.sh` against the mock CF Worker        |
| Publication-first install OAuth callback | Manual browser flow (mock OAuth available — see Wiring)  |
| Full mcp-proxy refresh-token race via OMA gateway | Wire vault credential at mock + send agent message (see Wiring) |
