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

### MCP-proxy refresh-token mock server

Needs a deployed HTTP endpoint that the gateway can reach: returns 401
once, then 200 after the gateway hits its `/token` endpoint with the
refresh_token. The interesting test is the D1 CAS race when two RPC
calls hit `expires_in` simultaneously — needs a controllable mock with
per-call response programming.

Realistic implementation: a tiny CF Worker deployed alongside staging
(e.g. `mock-mcp.staging.openma.dev`). Bookkeeping is per-request state in
a Durable Object so two concurrent calls can race.

### OAuth provider mock servers

Needs deployed `/authorize` and `/token` endpoints that pretend to be
Linear / Slack / GitHub. Same deployment shape as the MCP mock.

Both would unlock e2e for publication-first install UI (today only
exercisable in a browser against the real Slack / Linear app admin UIs).

## When to use which

| Surface                                  | How to test today                                        |
| ---------------------------------------- | -------------------------------------------------------- |
| Agent / Env / Session / SSE              | `e2e.sh`, `e2e-local.sh`                                 |
| Tool execution (write / bash / multi)    | `e2e-tools.sh`                                           |
| Memory / vault / cred / files / dup-cred | `e2e-advanced.sh`                                        |
| Webhook delivery (post-install)          | `e2e-webhooks.sh` ← this directory                       |
| Publication-first install OAuth callback | Manual browser flow (until OAuth mock lands)             |
| MCP-proxy refresh-token race             | Manual + careful prod observation (until MCP mock lands) |
