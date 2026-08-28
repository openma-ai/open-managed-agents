# Feishu Integration — Current Architecture

**Status**: Live, this is what's in code as of 2026-08-13.
**Predecessors**: [`feishu-multi-agent-integration-prd.md`](../feishu-multi-agent-integration-prd.md) (PRD) and [`feishu-session-lifecycle.md`](../feishu-session-lifecycle.md) (session strategy). This doc is the implementation reference — read those for product/session-design context, this one for what shipped.

---

## TL;DR

Feishu (飞书) is a first-class OMA integration provider that mirrors Slack's publication-first install pattern. There is no OAuth — install is a 3-step wizard that finishes in one browser hop after the user pastes four secrets (App ID, App Secret, Verification Token, Encrypt Key). Inbound events are pulled over a single outbound WebSocket per installation; no public webhook ingress is required. Each Feishu chat (or chat+user) maps to one OMA session, configurable per publication.

---

## Mental model

```
                    Feishu open platform
                    ────────────────────
                          │
        WebSocket long-poll ↓   ↑ REST (im/v1/messages)
        (per installation)      │
                          │
       ┌──────────────────────┼──────────────────────────────────────┐
       │  apps/integrations (gateway worker)                        │
       │  ┌──────────────────────────┐  ┌─────────────────────┐    │
       │  │  WS runner (CF container)│  │  HTTP gateway       │    │
       │  │  per installation        │  │  /integrations/feishu│    │
       │  │  decrypt → dispatch      │  │  /publications/*     │    │
       │  └─────────────┬────────────┘  └──────────▲──────────┘    │
       └────────────────│─────────────────────────│─────────────────┘
                        │ user.message             │ start-a1, credentials
                        ▼                          │
       ┌────────────────────────────────────────────────────────────┐
       │  apps/main (OMA)  →  apps/agent (SessionDO)                │
       │  bot decides what to surface; per-chat/per-chat-user scope │
       └────────────────────────────────────────────────────────────┘
```

Two channels, same shape as Slack:
- **Input** (Feishu → bot): WebSocket events decrypted (or verification-token-verified), normalized, dispatched as `user.message` into the bot's OMA session bound by `(publicationId, scopeKey)`.
- **Output** (bot → Feishu): bot calls Feishu MCP / HTTP tools to post messages, edit prior messages, add reactions.

There is no auto-mirror layer. Bot's internal `thought` / `tool_use` events stay in OMA; nothing reaches Feishu unless the bot calls a tool.

---

## Install flow (publication-first)

The install is a single wizard that finishes in one click after the user pastes secrets. There is no `installPersonalToken` path, no handoff link, no two-step OAuth — Feishu's open platform is fundamentally "you bring your own bot app."

```
1. Console wizard PickStep
   → agent + environment + persona + tenant_type (internal | external ISV)
   + session_granularity (per_chat | per_chat_user)
   POST /v1/integrations/feishu/start-a1
   → server creates a `feishu_publications` row (status = pending_setup),
   returns `formToken` (used as setup-link secret)

2. User pastes 4 secrets (App ID, App Secret, Verification Token, Encrypt Key)
   POST /v1/integrations/feishu/credentials
   → server validates via getTenantAccessToken against open.feishu.cn,
   encrypts the 3 secret-shaped fields with WebCryptoAesGcm,
   transitions status pending_setup → credentials_filled

3. Console installs a WebSocket runner for the new `feishu_installations`
   row. Once the runner successfully (re)connects and pulls one event
   successfully, status flips to awaiting_install → live.
```

State machine: `pending_setup → credentials_filled → awaiting_install → live → (unpublished | needs_reauth)`. `unpublished` is a terminal state. `needs_reauth` is triggered when the WS runner hits a 401-refresh failure.

There is no public callback URL in this flow — Feishu's open platform pushes events over an outbound WebSocket per app, which the integrations worker dials.

---

## Tenant types

Feishu splits the world into two:

| `tenant_type` | Audience | Notes |
|---|---|---|
| `internal` | Apps published inside one tenant | Bot is created under that tenant's app directory; the WS connects as the tenant's app |
| `external` | Apps published as an ISV (third-party SaaS) | App is "available to all tenants"; each tenant installs it independently and the WS is dialed with a per-installation `tenant_access_token` |

The `feishu_installations` table is keyed on `(provider_id, workspace_id, install_kind, COALESCE(app_id, ''))` with `revoked_at IS NULL` — internal and external installs of the same bot in the same workspace would land on different rows because their `install_kind` differs.

---

## Signing-mode auto-detection

Feishu has two signing modes — one mandatory (`verification_token`), one optional (`encrypt_key` for AES-256-CBC event encryption). The integration auto-detects which the publisher configured:

```ts
detectSigningMode(verificationToken, encryptKey):
  if encryptKey is present AND long enough (>= 16 chars) → "encrypt_key"
  else                                              → "verification_token"
```

Either way, a constant-time comparison protects against timing oracles. The WS payload envelope discriminates the mode by the presence of an `encrypt` field at the root.

---

## Session granularity

| `session_granularity` | Scope key | When to use |
|---|---|---|
| `per_chat` | `chat:oc_<id>` | Group ops — one running context per chat |
| `per_chat_user` | `chat:oc_<id>:user:ou_<id>` | 1:1 ops — each user in a chat gets their own session, but context still keys off the chat |

The bot's first message in a new scope claims a placeholder session via `claimPending(scope, placeholderSessionId)` (DB-row `insert ... onConflictDoNothing`). When the agent thread spins up, `fulfillPending(scope, realSessionId)` swaps the placeholder for the real session id and flips status `pending → active`. If the same scope arrives again with a different sender while the prior session is still active, the router reuses the existing active session — `reassignIfInactive` only fires when status is `pending` and `created_at < now - 60s`, or status is `completed`.

---

## Tables (D1 / SQLite; Postgres mirror under `node-pg`)

| Table | Rows | Hot path |
|---|---|---|
| `feishu_apps` | 1 per OMA bot app per tenant | lookup-by-app-id on inbound event |
| `feishu_installations` | 1 per install (workspace × app × kind) | WS runner lifecycle, tenant_token cache |
| `feishu_publications` | 1 per OMA agent × environment × tenant × installation | wizard state, capability set, persona |
| `feishu_thread_sessions` | 1 per publication × scope | session allocation, claimPending → fulfillPending |
| `feishu_setup_links` | short-lived one-time tokens | console → setup-page hand-off (currently unused — wizard is in-place) |
| `feishu_webhook_events` | 1 per delivered event | idempotency dedup on delivery_id |

Migration: `apps/main/migrations-integrations/0008_feishu_publication_first.sql`.

---

## Secrets

- **Stored**: `app_secret_cipher`, `verification_token_cipher`, `encrypt_key_cipher` on `feishu_publications`; `tenant_access_token_cipher` on `feishu_installations`. Cipher key is `WebCryptoAesGcm(platformSecret, "integrations.tokens")` — same shape as Slack.
- **Not stored**: the App ID is stored plaintext (it's not secret — Feishu identifiers are public on every chat the bot joins).
- **Decryption** is gated by the integrations worker; the Agent sandbox never sees plaintext App Secret / Encrypt Key. `tenant_access_token` is decrypted on each WS connect (and on each REST call from the bot's MCP tools).

---

## Worker (apps/integrations)

| File | Purpose |
|---|---|
| `apps/integrations/src/routes/feishu/publications.ts` | `/integrations/feishu/start-a1`, `/credentials`, `/publications/*` HTTP gateway |
| `apps/integrations/src/routes/feishu/setup-page.ts` | Setup-page HTML form (currently unused — wizard is in-place, kept for future handoff-link path) |
| `apps/integrations/src/wire.ts` | Wires publications + setup-page into the CF worker router |
| `packages/feishu/src/provider.ts` | Outbound WS runner lifecycle: dial, re-dial on 401, claimPending/fulfillPending |
| `packages/feishu/src/webhook/parse.ts` | Inbound event normalization: envelope discriminates `encrypt_key` vs `verification_token` |
| `packages/feishu/src/webhook/signature.ts` | `detectSigningMode`, `constantTimeEqual`, HMAC-SHA256 challenges |
| `packages/feishu/src/oauth/credentials.ts` | App-Secret → tenant_access_token mint + 2h cache + single-flight |
| `packages/feishu/src/api/client.ts` | Outbound REST: `sendText`, `updateText`, `addReaction`, `removeReaction`, `getChatName` |
| `packages/feishu/src/scope.ts` | `scopeKeyFor(granularity, chatId, userId?)` |
| `packages/feishu/src/signal.ts` | `FEISHU_SIGNAL_PROTOCOL_PROMPT` — non-Slack signal phrasing for the agent's system prompt |

---

## Console surfaces (`/integrations/feishu/*`)

| Page | Job |
|---|---|
| `IntegrationsFeishuList` | Tenant cards (live workspaces), PendingRow (in-flight wizard runs), PublicationRow (per-publication summary) |
| `IntegrationsFeishuWorkspace` | Single-tenant management: publication cards with persona + capabilities + session-granularity radio + capabilities picker |
| `IntegrationsFeishuPublishWizard` | 3-step: PickStep → CredentialsStep (4-secret form with show/hide + Event URL copy) → CompleteStep (success banner + URL verification checklist) |

`IntegrationsFeishuClient` lives in `apps/console/src/integrations/api/feishu-client.ts` so its coverage threshold stays isolated from Slack/GitHub/Linear clients that share the same module.

---

## Feishu-side limitations

| Limitation | Workaround |
|---|---|
| `tenant_access_token` expires in 2h; no refresh_token — re-mint via App ID + App Secret | Cached + single-flight + 60s pre-expiry refresh buffer; on 401, refresh-once and retry |
| Per-app message rate limit (~50 req/s) | `im/v1/messages` calls are token-bucket'd in the API client; reactions are batched per user message |
| Bot can only edit messages it sent within the last 24h | `updateText` returns Feishu's error code; UI surfaces "too old to edit" and falls back to a follow-up message |
| Chat rename is not exposed via API; `chat_name` only resolvable on first message receipt | `getChatName` is called once per scope and cached in `feishu_thread_sessions.chat_name` |
| WebSocket disconnects without a clear reason code | Runner treats any close as transient and re-dials with exponential backoff (1s → 30s); 4 consecutive `99991663` codes flip status to `needs_reauth` |
| `encrypt_key` is optional — some publishers only configure `verification_token` | `detectSigningMode` falls back to `verification_token`; HMAC-SHA256 over the raw payload |
| `chat_id` (`oc_*`) and `user_id` (`ou_*`) are tenant-scoped, not globally unique | All lookups use `(publication_id, scope_key)` as the dedup tuple |

---

## Future work (not in this iteration)

### ISV app store path

Currently `tenant_type = external` is supported in the schema and wizard but the WS runner hard-codes `internal` auth. To publish a real ISV app we'd need to dial the WS per-installation (one socket per tenant) rather than per-bot, and store a `tenant_access_token` per `feishu_installations` row that the runner refreshes independently.

### Reply-in-thread

Feishu supports `root_id` for threaded replies. The current parser ignores it — every message wakes the same scope. Threading would let us scope per-thread (`chat:oc_x:root:om_y`) instead of per-chat.

### Card-streaming

`im/v1/messages` supports a card-message payload type that updates in-place via the `card_id` mechanism. Today we stream via `updateText` calls, which renders cleanly but loses the structured card affordances.

### Per-bot identity

PRD Phase 2: spawn one real Feishu bot per persona instead of one bot with persona avatars. Requires per-bot credential vaulting and a routing layer that picks a bot at message send time.

---

## Test coverage

| Layer | Where | Tests | Coverage |
|---|---|---|---|
| Package units | `packages/feishu/test/` | 68 | 99% lines, 95% branches |
| CF adapter SQL | `packages/integrations-adapters-cf/test/feishu-adapters.test.ts` | 39 | 95% lines, 81% branches |
| Console client | `apps/console/src/integrations/api/feishu-client.test.ts` | 17 | 100% lines, 100% branches |
| End-to-end (live Feishu sandbox) | manual smoke; future Playwright harness | — | — |

Total: **144 tests passing** across the Feishu surface. Threshold: lines ≥ 80%, branches ≥ 70%.

---

## See also

- [`linear-integration-current.md`](../linear-integration-current.md) — mirror image of this doc for Linear
- [`slack-integration-current.md`](#) — the pattern Feishu mirrors (publication-first install)
- [`feishu-multi-agent-integration-prd.md`](../feishu-multi-agent-integration-prd.md) — PRD Phase 1 + Phase 2 context
- [`feishu-session-lifecycle.md`](../feishu-session-lifecycle.md) — session strategy (event-scoped Sessions, Memory store)
- [`secrets-design.md`](../secrets-design.md) — Vault + external secret manager layering
- [`architecture-overview.md`](../architecture-overview.md) — system topology