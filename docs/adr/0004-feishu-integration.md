# ADR 0004: Feishu Integration — Mirror Slack's Publication-First Install

**Status**: Accepted (2026-08-13)
**Deciders**: Engineering
**Supersedes**: None
**Related**: [`linear-integration-current.md`](../linear-integration-current.md), [`feishu-multi-agent-integration-prd.md`](../feishu-multi-agent-integration-prd.md), [`feishu-session-lifecycle.md`](../feishu-session-lifecycle.md)

---

## Context

We need to ship a Feishu (飞书) integration for OMA. The existing Linear and Slack integrations set the pattern: Linear is OAuth-first (`installPersonalToken` and handoff-link paths), Slack is publication-first (a wizard that creates a durable `feishu_publications`-equivalent row up front, then fills secrets). Both end up at the same `installations × publications × scope` data shape downstream, but the install-time UX is fundamentally different because each provider's open platform exposes a different onboarding surface.

Feishu's open platform sits between the two extremes:
- It has no public OAuth flow. Apps are configured in the Feishu admin console, secrets are pasted server-side.
- It does not require a public callback URL. Inbound events are pushed over an outbound WebSocket per app.
- It uses 4 secrets (App ID, App Secret, Verification Token, Encrypt Key) instead of 3.
- It supports both internal tenant apps and external ISV apps in the same schema.

We had three options for how to design the install flow:

### Option A — Mirror Slack (publication-first wizard)

3-step wizard: PickStep → CredentialsStep → CompleteStep. Creates a `feishu_publications` row at step 1 with status `pending_setup`, fills credentials at step 2, transitions to `credentials_filled` then `awaiting_install` then `live`. No public callback, no handoff link.

**Pros**: Same shape as Slack — the gateway worker can reuse its publication-first dispatcher. One browser tab. UX parity with the Slack install. No NAT, no public ingress, no DNS.

**Cons**: Future ISV install path needs a different shape (we'd need a per-installation setup-link once we go external). Wizard blocks on user input (secrets paste) — no "click link to install" path.

### Option B — Mirror Linear (handoff-link + dedicated callback)

User picks persona in console → server returns a setup link → user opens it → setup page lets them paste secrets → callback to a dedicated `/integrations/feishu/dedicated-callback` lands in the worker → worker transitions `pending_setup → credentials_filled → live`.

**Pros**: Setup link can be sent via DM or stored in the workspace. Future ISV path is straightforward (each tenant opens the same link). The "hand-off to a different persona" UX (admin configures, user installs) is native.

**Cons**: Two browser hops. Requires a public callback URL — Cloudflare Workers can front this but it means our Feishu integration needs to expose an HTTP endpoint to the internet, which the WebSocket-first design explicitly avoids. Schema is the same but the gateway has to learn a new `dedicated-callback` route.

### Option C — Single-step ("paste secrets here" form)

User opens `/integrations/feishu/install` directly, picks persona inline, pastes 4 secrets, submits. No setup link, no wizard, no callback.

**Pros**: Smallest possible surface. No state machine to debug.

**Cons**: No way to refresh-resume. User closes the tab mid-install = publication shell is orphaned. No tenant-type / granularity choice until after the secrets are filled, which means the schema can't commit those choices to a durable shell up front.

---

## Decision

**Option A — mirror Slack's publication-first install.** Reasons in priority order:

1. **Feishu's open platform is fundamentally paste-secrets-server-side, not OAuth-redirect.** Linear's `installPersonalToken` works because Linear supports a personal API token + workspace-scoped OAuth. Feishu does not. The closest analog is "create a Feishu app, copy 4 secrets into our UI" — which is closer to a paste-in-form than a redirect dance.

2. **WebSocket-first design removes the need for a public callback.** Slack needs a callback URL because Slack's event subscription model requires HTTPS ingress. Feishu's `im/v1/messages` event stream is dialed outbound by the integrations worker. There's no reason to expose an HTTP endpoint we don't need.

3. **Schema symmetry with Slack lowers engineering cost.** The 5 tables (`feishu_installations`, `feishu_publications`, `feishu_thread_sessions`, `feishu_setup_links`, `feishu_webhook_events`) are 1:1 with Slack's. The repos in `packages/integrations-adapters-cf/src/d1/feishu/` mirror Slack's line-for-line except where Feishu's API shape diverges (4 secrets instead of 3; `chat_id` instead of `channel_id`).

4. **Wizard UX matches Slack's, which operators already understand.** Same 3-step rhythm. Same `pending_setup → credentials_filled → live` state pill in the Console.

---

## Consequences

### Positive

- **One mental model for the gateway team.** "Publication-first install" is a known shape; this PR doesn't introduce a new install topology.
- **No public callback URL.** Inbound is dial-only. Egress firewall rules stay narrow.
- **Future schema work is additive.** The `tenant_type = external` column is reserved on `feishu_installations` but unused at the gateway level today — when ISV support lands, we add a per-installation WS runner without touching the schema.

### Negative

- **No setup-link path.** Linear's `createHandoffLink` lets a workspace admin configure secrets on behalf of a user. Feishu's wizard blocks until *the user who started it* pastes secrets. For most teams this is fine (the person who installs the bot is the same person who configures it), but for "IT-managed install" workflows we need a separate handoff path later.
- **`tenant_type = external` is a placeholder.** The wizard records it, the schema accepts it, but the WS runner hard-codes the internal-auth flow. Shipping ISV is a follow-on.
- **`encrypt_key` is optional in the Feishu open platform but the wizard always shows it.** We support the `verification_token`-only path (the parser detects the missing `encrypt` envelope and falls back to HMAC), but the wizard collects both. This trades 5 seconds of extra form time for never-ambiguous credentials state.

---

## Alternatives considered but rejected

- **Reuse Linear's `LinearPublicationShell` type for the wizard step-1 response.** The shapes diverge enough (Feishu has no OAuth callback, no handoff-link) that a shared type would just need an `omit`-heavy mapping. Cleaner to keep `FeishuPublicationShell` separate.
- **Use a single bot-app credential for all installations (one OMA bot, many tenants).** This is the internal-tenant pattern only. External ISV install means the bot-app is OMA-owned but the install is per-tenant — different `tenant_access_token`, different WS, different `feishu_installations` row. The schema supports this from day 1; the runner doesn't yet.

---

## Open questions

1. **Card streaming vs `updateText`**: Feishu supports in-place card updates via `card_id`. The bot today uses `updateText` which works but isn't native to Feishu's affordances. Re-evaluate when the bot's primary output becomes structured (cards, tables, action buttons).
2. **Per-thread scope (`root_id`)**: Feishu threads via `root_id`. The current scope key is `chat:<chat_id>[:user:<user_id>]`. Threading would add `:root:<message_id>` for the rare case a bot reply is threaded.
3. **Setup-link for ISV path**: When ISV lands, will the link live on `feishu_setup_links` (which exists but is unused) or get a new `feishu_external_install_links` table?

---

## References

- Feishu open platform docs (internal reference; not externally citable)
- Slack pattern this mirrors: `apps/integrations/src/routes/slack/publications.ts` (see git history pre-Feishu)
- WebCryptoAesGcm cipher key: `secrets-design.md`
- Session-scoped vs chat-scoped tradeoffs: `feishu-session-lifecycle.md`