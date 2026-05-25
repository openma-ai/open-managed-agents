// LinearProvider — implements integrations-core's IntegrationProvider for
// Linear. This is the orchestrator: routes between OAuth, webhook, and MCP
// flows, and translates between integration-core's port shapes and Linear's
// API shapes.
//
// All runtime concerns (HTTP, storage, crypto, JWT, sessions) are injected
// via the Container. The provider itself is pure logic and unit-testable
// with the in-memory fakes from @open-managed-agents/integrations-core/test-fakes.

import type {
  Container,
  ContinueInstallInput,
  DispatchRule,
  IntegrationProvider,
  InstallComplete,
  InstallStep,
  LinearEventStore,
  LinearPublicationRepo,
  McpScope,
  McpToolDescriptor,
  McpToolResult,
  ProviderId,
  StartInstallInput,
  WebhookOutcome,
  WebhookRequest,
  CapabilityKey,
  Persona,
  Publication,
} from "@open-managed-agents/integrations-core";

import { ALL_CAPABILITIES, DEFAULT_LINEAR_SCOPES, type LinearConfig } from "./config";
import { LinearGraphQLClient } from "./graphql/client";
import {
  buildAuthorizeUrl,
  buildRefreshTokenBody,
  buildTokenExchangeBody,
  parseTokenResponse,
} from "./oauth/protocol";
import type { LinearIssueSessionRepo } from "./ports";
import { parseWebhook, type NormalizedWebhookEvent, type RawWebhookEnvelope } from "./webhook/parse";

/** Subset of Container the LinearProvider depends on. Narrows
 *  `webhookEvents` to LinearEventStore (merged `linear_events` table holds
 *  the async drain queue) and `publications` to LinearPublicationRepo
 *  (publication-first install fields live on the row directly). */
export interface LinearContainer extends Container {
  webhookEvents: LinearEventStore;
  publications: LinearPublicationRepo;
  /** Linear-specific per-issue session bookkeeping (`linear_issue_sessions`
   *  table). Backed by SqlLinearIssueSessionRepo in production,
   *  InMemoryLinearIssueSessionRepo in tests. */
  linearIssueSessions: LinearIssueSessionRepo;
}

const OAUTH_STATE_TTL_SECONDS = 30 * 60; // 30 min — covers slow OAuth UX
const PROVIDER_ID: ProviderId = "linear";

/** Linear's hosted MCP server. Outbound injection matches by hostname. */
const LINEAR_MCP_URL = "https://mcp.linear.app/mcp";

/**
 * Injected as `additionalSystemPrompt` on every session.create for Linear
 * webhook engagements. Mirrors the Slack and GitHub engagement prompts —
 * the model needs to know the dispatch envelope is metadata, the reply
 * mechanism is tool-mediated, and which kinds expect which behavior.
 *
 * Concise on purpose. Threats and MANDATORY framing get gamed (see Slack
 * history); facts + a clear tool-name pattern work better.
 */
export const LINEAR_ENGAGEMENT_PROMPT = [
  `<oma_linear_engagement>`,
  `You are engaging on a Linear issue. Webhook events arrive as user.message turns whose text starts with "# Linear <kind>" — runtime metadata, never quote it back to humans.`,
  ``,
  `## Reply mechanism`,
  ``,
  `Plain assistant text is NOT delivered to Linear. Only tool calls produce visible output. To post into Linear, use tools in the \`mcp__linear__*\` namespace plus OMA's \`linear_post_comment\` tool when present. Scan the available tool list and pick by name semantics — don't hardcode names; Linear's MCP renames between releases.`,
  ``,
  `- Top-level comment on the issue: \`linear_post_comment\` (OMA tool) or the Linear MCP \`save_comment\` with no \`parentId\`.`,
  `- Threaded reply on an existing comment: \`save_comment\` with \`parentId\` set to the parent comment id.`,
  `- Issue state / assignee / labels / etc.: \`save_issue\` and related Linear MCP tools.`,
  ``,
  `When a panel was opened (event includes a \`Linear panel:\` reference), OMA has already acknowledged the panel for you — your work goes in comments + issue state, not panel acks.`,
  ``,
  `## Event kinds`,
  ``,
  `- \`issueAssignedToYou\` / \`issueMention\` / \`issueCommentMention\`: you've been pinged on an issue. Read the context if needed, then post a useful comment. Ack briefly if the work spans multiple turns and \`scheduleWakeup\` for the follow-up.`,
  ``,
  `- \`issueNewComment\` / \`commentReply\`: a new comment arrived on an issue you have an active session on. Respond in the same thread (set \`parentId\` to the new comment id when replying inline; omit it for a fresh top-level comment).`,
  ``,
  `- \`agentSessionCreated\` / \`agentSessionPrompted\`: Linear opened an Agent panel for this engagement. After OMA's ack, do all communication via issue comments — the panel is a UI affordance, not the work surface.`,
  ``,
  `## Vocabulary`,
  ``,
  `Don't quote internal terms back to humans: \`issueAssignedToYou\`, \`commentReply\`, \`agentSessionPrompted\`, \`oma_linear_engagement\`, "webhook envelope", "session". Speak as a teammate on the issue.`,
  `</oma_linear_engagement>`,
].join("\n");

export class LinearProvider implements IntegrationProvider {
  readonly id: ProviderId = PROVIDER_ID;
  private readonly graphql: LinearGraphQLClient;

  constructor(
    private readonly container: LinearContainer,
    private readonly config: LinearConfig,
  ) {
    this.graphql = new LinearGraphQLClient(container.http);
  }

  // ─── Install ─────────────────────────────────────────────────────────
  //
  // Linear has two install paths, both publication-first:
  //
  //   - OAuth (dedicated): UI calls startPublication → submitCredentials →
  //     user clicks Install → handleOAuthCallback. Each step writes only
  //     to its anchor row (`linear_publications`); the installation +
  //     vault are created atomically inside the callback once Linear has
  //     returned a valid token. No more cascading INSERT across
  //     installations / publications / vaults inside the callback —
  //     publication is the single anchor.
  //
  //   - PAT (personal_token): single-shot `installPersonalToken`. The user
  //     pastes a `lin_api_…` token; we validate via viewer query, persist
  //     installation + vault + publication, and return. PAT mode never had
  //     ghost-row issues (single user request, dedup check via
  //     installations.findByWorkspace catches retries) so it stays as-is.
  //
  // `startInstall` / `continueInstall` are kept as adapters over the new
  // methods so the InstallBridge can dispatch by state-kind without knowing
  // which path won; the routes call the new methods directly.

  async startInstall(input: StartInstallInput): Promise<InstallStep | InstallComplete> {
    // The original API conflated "start the flow" with "mint a form
    // token". Publication-first replaces both with `startPublication`,
    // which writes a real row to D1 up front. The InstallBridge no longer
    // calls this; only legacy callers (e.g. CLI scripts that hardcode
    // continueInstall payload kinds) still hit it.
    throw new Error(
      "LinearProvider.startInstall: the dedicated install flow is publication-first now. " +
        "Call startPublication() / submitCredentials() / handleOAuthCallback() instead.",
    );
  }

  async continueInstall(
    input: ContinueInstallInput,
  ): Promise<InstallStep | InstallComplete> {
    const payload = input.payload as { kind?: string; [k: string]: unknown };
    if (payload.kind === "oauth_callback_publication") {
      return this.handleOAuthCallback({
        publicationId: (payload.publicationId as string) ?? "",
        code: (payload.code as string) ?? "",
        state: (payload.state as string) ?? "",
      });
    }
    throw new Error(
      `LinearProvider.continueInstall: unknown payload kind '${payload.kind}'`,
    );
  }

  // ─── PAT install (Symphony-equivalent, no OAuth app) ────────────────

  /**
   * Install a Linear connection backed by a Personal API Key. Equivalent
   * to Symphony's `LINEAR_API_KEY` model — the bot acts as the PAT
   * owner. No webhook source, so triggering relies on dispatch rules.
   *
   * One-shot vs the OAuth dance: validate via viewer query, persist,
   * return InstallComplete in a single call. No formToken, no callback.
   *
   * Returns InstallComplete with the new publicationId on success.
   * Throws on validation failure or workspace conflicts.
   */
  async installPersonalToken(input: {
    userId: string;
    agentId: string;
    environmentId: string;
    persona: Persona;
    /** Linear PAT, format `lin_api_…`. */
    patToken: string;
  }): Promise<InstallComplete> {
    if (!input.patToken || !input.patToken.trim()) {
      throw new Error("patToken required");
    }
    const token = input.patToken.trim();

    // Validate token + capture the user this PAT acts as. Linear PATs are
    // sent as the raw token in `Authorization: <token>` (no Bearer prefix
    // for some endpoints) but our client always sends Bearer; Linear's
    // GraphQL accepts both.
    let viewer: { id: string; name: string };
    let organization: { id: string; name: string; urlKey: string };
    try {
      const result = await this.graphql.fetchViewerAndOrg(token);
      viewer = result.viewer;
      organization = result.organization;
    } catch (err) {
      throw new Error(
        `Linear PAT validation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const tenantId = await this.container.tenants.resolveByUserId(input.userId);

    // Reject conflicting active install (same workspace + same install_kind).
    // Two PAT installs of the same workspace by the same OMA tenant would
    // race on dispatch and look identical in audit logs.
    const existing = await this.container.installations.findByWorkspace(
      PROVIDER_ID,
      organization.id,
      "personal_token",
      null,
    );
    if (existing) {
      throw new Error(
        `Linear workspace ${organization.name} already has an active personal-token install (id=${existing.id})`,
      );
    }

    const installation = await this.container.installations.insert({
      tenantId,
      userId: input.userId,
      providerId: PROVIDER_ID,
      workspaceId: organization.id,
      workspaceName: organization.name,
      installKind: "personal_token",
      appId: null,
      accessToken: token,
      refreshToken: null,
      scopes: ["personal_api_key"],
      botUserId: viewer.id,
    });

    const { vaultId } = await this.container.vaults.createCredentialForUser({
      userId: input.userId,
      vaultName: `Linear · ${organization.name} · ${input.persona.name} (PAT)`,
      displayName: `Linear PAT (${input.persona.name})`,
      mcpServerUrl: LINEAR_MCP_URL,
      bearerToken: token,
    });
    await this.container.installations.setVaultId(installation.id, vaultId);

    const publication = await this.container.publications.insert({
      tenantId,
      userId: input.userId,
      agentId: input.agentId,
      installationId: installation.id,
      environmentId: input.environmentId,
      mode: "full",
      status: "live",
      persona: input.persona,
      capabilities: new Set<CapabilityKey>(
        this.config.defaultCapabilities ?? ALL_CAPABILITIES,
      ),
      sessionGranularity: "per_issue",
    });

    return { kind: "complete", publicationId: publication.id };
  }

  // ─── Dedicated install (publication-first) ──────────────────────────
  //
  // Three discrete steps, each touching exactly one anchor row. A failure
  // mid-flow leaves a recoverable state on disk — the user just retries
  // from the step they were on.
  //
  //   1. startPublication       → insertShell (status='pending_setup')
  //   2. submitCredentials      → setCredentials (status='awaiting_install')
  //   3. handleOAuthCallback    → installation + vault inserts + bindInstallation
  //                               (status='live')
  //
  // The webhook URL we hand the user at step 1 contains the publication
  // id, so it's stable from creation: the user pastes it into Linear's
  // form once, and webhooks land on `/linear/webhook/pub/<pubId>` for the
  // rest of the install's life.

  /**
   * Step 1: create a publication shell + return the URLs the user must
   * register with Linear. `agentId` and `environmentId` are fixed at this
   * point — they're baked into the row and never patched. The shell row
   * gives subsequent steps a stable id to key on.
   */
  async startPublication(input: {
    userId: string;
    agentId: string;
    environmentId: string;
    persona: Persona;
    returnUrl: string;
  }): Promise<{
    publicationId: string;
    callbackUrl: string;
    webhookUrl: string;
    suggestedAppName: string;
    suggestedAvatarUrl: string | null;
    returnUrl: string;
  }> {
    if (!input.userId) throw new Error("startPublication: userId required");
    if (!input.agentId) throw new Error("startPublication: agentId required");
    if (!input.environmentId) {
      throw new Error("startPublication: environmentId required");
    }
    if (!input.persona?.name) throw new Error("startPublication: persona.name required");

    const tenantId = await this.container.tenants.resolveByUserId(input.userId);
    const publication = await this.container.publications.insertShell({
      tenantId,
      userId: input.userId,
      agentId: input.agentId,
      environmentId: input.environmentId,
      mode: "full",
      persona: input.persona,
      capabilities: new Set<CapabilityKey>(
        this.config.defaultCapabilities ?? ALL_CAPABILITIES,
      ),
      sessionGranularity: "per_issue",
    });

    return {
      publicationId: publication.id,
      callbackUrl: this.publicationCallbackUri(publication.id),
      webhookUrl: this.publicationWebhookUri(publication.id),
      suggestedAppName: input.persona.name,
      suggestedAvatarUrl: input.persona.avatarUrl,
      // Echo back so the route can persist it in a state JWT for the
      // OAuth dance; we don't store returnUrl on the publication row
      // (it's a one-shot UI hint, not durable state).
      returnUrl: input.returnUrl,
    };
  }

  /**
   * Re-derive the publication-shell payload for an existing pub row. Used
   * by the Console wizard's refresh-resume path: when the user lands with
   * `?pub=<id>` we re-build the same callback/webhook URLs they pasted
   * into Linear, without INSERTing a new shell. Caller is responsible for
   * the ownership check.
   *
   * Returns the same shape `startPublication` does so the gateway route
   * doesn't have to fork its serializer.
   */
  async resumePublication(input: {
    publicationId: string;
    userId: string;
    returnUrl: string;
  }): Promise<{
    publicationId: string;
    callbackUrl: string;
    webhookUrl: string;
    suggestedAppName: string;
    suggestedAvatarUrl: string | null;
    returnUrl: string;
  }> {
    if (!input.publicationId) throw new Error("resumePublication: publicationId required");
    if (!input.userId) throw new Error("resumePublication: userId required");
    const pub = await this.container.publications.get(input.publicationId);
    if (!pub) throw new Error(`resumePublication: unknown publicationId ${input.publicationId}`);
    if (pub.userId !== input.userId) {
      throw new Error("resumePublication: publication owner mismatch");
    }
    if (
      pub.status !== "pending_setup" &&
      pub.status !== "credentials_filled" &&
      pub.status !== "awaiting_install"
    ) {
      throw new Error(
        `resumePublication: publication is '${pub.status}', cannot resume`,
      );
    }
    return {
      publicationId: pub.id,
      callbackUrl: this.publicationCallbackUri(pub.id),
      webhookUrl: this.publicationWebhookUri(pub.id),
      suggestedAppName: pub.persona.name,
      suggestedAvatarUrl: pub.persona.avatarUrl,
      returnUrl: input.returnUrl,
    };
  }

  /**
   * Step 2: encrypt and persist the OAuth-app credentials onto the pub
   * row, then return the Linear OAuth authorize URL the user clicks. The
   * state JWT carries the publicationId + returnUrl so step 3 can find
   * the row without a separate lookup table.
   *
   * Re-callable: if the user re-pastes credentials (typo on the first
   * attempt), this just overwrites the cipher columns. Status stays at
   * 'awaiting_install'.
   */
  async submitCredentials(input: {
    publicationId: string;
    clientId: string;
    clientSecret: string;
    webhookSecret: string;
    /** Reserved for upstream surfaces that distinguish HMAC key from
     *  webhook secret. Linear today uses webhookSecret for both. */
    signingSecret?: string | null;
    returnUrl: string;
  }): Promise<{ installUrl: string; publicationId: string; callbackUrl: string; webhookUrl: string }> {
    if (!input.publicationId) throw new Error("submitCredentials: publicationId required");
    if (!input.clientId || !input.clientSecret || !input.webhookSecret) {
      throw new Error(
        "submitCredentials: clientId, clientSecret, webhookSecret required",
      );
    }
    const pub = await this.container.publications.get(input.publicationId);
    if (!pub) throw new Error(`submitCredentials: unknown publicationId ${input.publicationId}`);
    if (pub.status === "live") {
      throw new Error(
        `submitCredentials: publication ${pub.id} is already live — re-running install would re-grant OAuth consent. Use the reauthorize flow instead.`,
      );
    }
    if (pub.status === "unpublished") {
      throw new Error(`submitCredentials: publication ${pub.id} is unpublished`);
    }

    await this.container.publications.setCredentials(input.publicationId, {
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      webhookSecret: input.webhookSecret,
      signingSecret: input.signingSecret ?? null,
    });

    const state = await this.container.jwt.sign(
      {
        kind: "linear.oauth.publication",
        publicationId: input.publicationId,
        returnUrl: input.returnUrl,
        nonce: this.container.ids.generate(),
      },
      OAUTH_STATE_TTL_SECONDS,
    );
    const installUrl = buildAuthorizeUrl({
      clientId: input.clientId,
      redirectUri: this.publicationCallbackUri(input.publicationId),
      scopes: this.config.scopes ?? DEFAULT_LINEAR_SCOPES,
      state,
      actor: "app",
    });
    return {
      installUrl,
      publicationId: input.publicationId,
      callbackUrl: this.publicationCallbackUri(input.publicationId),
      webhookUrl: this.publicationWebhookUri(input.publicationId),
    };
  }

  /**
   * Step 3: complete the OAuth dance. Validates the state JWT against
   * the publicationId, exchanges the code with Linear, then:
   *
   *   - inserts linear_installations (with appId=null — credentials live
   *     on the pub row now, not in linear_apps)
   *   - creates the vault for outbound token injection
   *   - flips pub status='live' + records installation_id / vault_id
   *
   * The installation insert is the first write; if it fails we leave a
   * pending pub row that the user can retry from. If the vault insert
   * fails after the installation insert, the installation row exists but
   * the pub row is still 'awaiting_install' — the user retries the
   * OAuth click and we re-enter; the installation `findByWorkspace`
   * dedup catches the half-finished install and we surface a clear
   * error.
   */
  async handleOAuthCallback(input: {
    publicationId: string;
    code: string;
    state: string;
  }): Promise<InstallComplete & { returnUrl: string | null }> {
    if (!input.publicationId) {
      throw new Error("handleOAuthCallback: publicationId required");
    }
    if (!input.code) throw new Error("handleOAuthCallback: code required");
    if (!input.state) throw new Error("handleOAuthCallback: state required");

    const state = await this.container.jwt.verify<{
      kind: string;
      publicationId: string;
      returnUrl: string;
    }>(input.state);
    if (state.kind !== "linear.oauth.publication") {
      throw new Error("handleOAuthCallback: invalid state kind");
    }
    if (state.publicationId !== input.publicationId) {
      throw new Error("handleOAuthCallback: state.publicationId mismatch");
    }

    const pub = await this.container.publications.get(input.publicationId);
    if (!pub) throw new Error(`handleOAuthCallback: unknown publicationId ${input.publicationId}`);
    if (pub.status === "live") {
      // Double-click on Install. Re-running the token exchange with the
      // same code would fail (Linear single-uses codes), so just return
      // the existing publication.
      return { kind: "complete", publicationId: pub.id, returnUrl: state.returnUrl };
    }

    const credentials = await this.container.publications.getCredentials(input.publicationId);
    if (!credentials) {
      throw new Error(
        `handleOAuthCallback: publication ${pub.id} has no credentials — submitCredentials must run first`,
      );
    }

    // Token exchange with the user's own App credentials.
    const tokenReq = buildTokenExchangeBody({
      code: input.code,
      redirectUri: this.publicationCallbackUri(pub.id),
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
    });
    const tokenRes = await this.container.http.fetch({
      method: "POST",
      url: tokenReq.url,
      headers: { "content-type": tokenReq.contentType },
      body: tokenReq.body,
    });
    if (tokenRes.status < 200 || tokenRes.status >= 300) {
      throw new Error(
        `Linear OAuth token exchange failed: ${tokenRes.status} ${tokenRes.body.slice(0, 200)}`,
      );
    }
    const token = parseTokenResponse(tokenRes.body);
    const { viewer, organization } = await this.graphql.fetchViewerAndOrg(token.access_token);

    // Installation insert. UNIQUE on (provider, workspace, kind, app_id)
    // catches retries that survived a previous partial flow — surface a
    // clear error instead of double-inserting.
    const existing = await this.container.installations.findByWorkspace(
      PROVIDER_ID,
      organization.id,
      "dedicated",
      null,
    );
    if (existing) {
      // A prior install for the same workspace is already active. The
      // user must revoke it first; we don't auto-recover because that
      // would silently re-tenant the install.
      throw new Error(
        `Linear workspace ${organization.name} already has an active dedicated install (id=${existing.id}). Revoke it before publishing this agent again.`,
      );
    }
    const installation = await this.container.installations.insert({
      tenantId: pub.tenantId,
      userId: pub.userId,
      providerId: PROVIDER_ID,
      workspaceId: organization.id,
      workspaceName: organization.name,
      installKind: "dedicated",
      // linear_installations.app_id is now nullable — credentials live on
      // the pub row, not in a separate linear_apps row, so installation no
      // longer needs to point at an apps row.
      appId: null,
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      scopes: token.scope ? token.scope.split(/[\s,]+/) : [...(this.config.scopes ?? DEFAULT_LINEAR_SCOPES)],
      botUserId: viewer.id,
    });

    // Vault for outbound token injection.
    const { vaultId } = await this.container.vaults.createCredentialForUser({
      userId: pub.userId,
      vaultName: `Linear · ${organization.name} · ${pub.persona.name}`,
      displayName: `Linear MCP token (${pub.persona.name})`,
      mcpServerUrl: LINEAR_MCP_URL,
      bearerToken: token.access_token,
    });
    await this.container.installations.setVaultId(installation.id, vaultId);

    // Bind installation + vault onto the publication row. This is the
    // last write — once it succeeds, the install is live. If it fails,
    // the installation row exists but the publication is still
    // 'awaiting_install'; the user re-running OAuth would hit the
    // `findByWorkspace` guard above and get a clear error.
    await this.container.publications.bindInstallation(pub.id, {
      installationId: installation.id,
      vaultId,
    });

    return { kind: "complete", publicationId: pub.id, returnUrl: state.returnUrl };
  }

  // ─── URL builders ───────────────────────────────────────────────────

  /** Callback URL surfaced to the user at step 1; baked into Linear's
   *  OAuth-app config. Stable for the life of the publication. */
  private publicationCallbackUri(pubId: string): string {
    return `${this.config.gatewayOrigin}/linear/oauth/pub/${pubId}/callback`;
  }
  /** Webhook URL surfaced to the user at step 1; baked into Linear's
   *  OAuth-app webhook config. Linear webhooks land here for the life of
   *  the publication; webhook handler resolves the pub by id. */
  private publicationWebhookUri(pubId: string): string {
    return `${this.config.gatewayOrigin}/linear/webhook/pub/${pubId}`;
  }

  // ─── Webhook ─────────────────────────────────────────────────────────

  async handleWebhook(req: WebhookRequest): Promise<WebhookOutcome> {
    // Webhook URL is publication-keyed in the publication-first flow:
    // `/linear/webhook/pub/<pubId>`. The route packs the path-derived
    // pubId into `req.installationId` for transport (the field name is a
    // hold-over from the legacy app-id keying — see WebhookRequest in
    // integrations-core for why we don't rename it). Resolve the
    // publication first, then walk to its installation.
    if (!req.installationId) {
      return { handled: false, reason: "missing_publication_id" };
    }
    if (!req.deliveryId) {
      return { handled: false, reason: "missing_delivery_id" };
    }
    const publicationId = req.installationId;

    const publication = await this.container.publications.get(publicationId);
    if (!publication) {
      return { handled: false, reason: "publication_not_found" };
    }
    if (publication.status === "unpublished") {
      return { handled: false, reason: "publication_unpublished" };
    }
    if (!publication.installationId) {
      // Pending pub — credentials filled but install hasn't completed.
      return { handled: false, reason: "publication_not_live" };
    }

    const installation = await this.container.installations.get(publication.installationId);
    if (!installation || installation.revokedAt !== null) {
      return { handled: false, reason: "installation_not_found_or_revoked" };
    }

    // Webhook secret lives on the publication row in the publication-first
    // flow (it was on linear_apps in the old flow). Pull it from there.
    const webhookSecret = await this.container.publications.getWebhookSecret(publicationId);
    if (!webhookSecret) {
      return { handled: false, reason: "missing_webhook_secret" };
    }

    // Verify HMAC. Linear sends signatures in the `linear-signature` header.
    const signature = req.headers["linear-signature"];
    if (!signature) return { handled: false, reason: "missing_signature" };
    const ok = await this.container.hmac.verify(
      webhookSecret,
      req.rawBody,
      signature,
    );
    if (!ok) return { handled: false, reason: "invalid_signature" };

    // Idempotency: refuse to dispatch the same delivery twice. Linear retries
    // aggressively on 5xx, so this gate matters.
    const fresh = await this.container.webhookEvents.recordIfNew(
      req.deliveryId,
      installation.tenantId, // Phase 0: nullable until backfill of pre-existing rows
      installation.id,
      "unknown",
      this.container.clock.nowMs(),
    );
    if (!fresh) return { handled: false, reason: "duplicate_delivery" };

    // Parse + dispatch.
    let raw: RawWebhookEnvelope;
    try {
      raw = JSON.parse(req.rawBody) as RawWebhookEnvelope;
    } catch {
      await this.container.webhookEvents.attachError(req.deliveryId, "invalid_json");
      return { handled: false, reason: "invalid_json" };
    }
    const event = parseWebhook(raw);
    if (!event) {
      await this.container.webhookEvents.attachError(req.deliveryId, "unparseable");
      return { handled: false, reason: "unparseable" };
    }
    console.log(
      `[linear-parsed] eventType=${event.eventType} kind=${event.kind} issueId=${event.issueId} issueIdent=${event.issueIdentifier} agentSessionId=${event.agentSessionId ?? "-"} promptCtx=${event.promptContext ? event.promptContext.length : 0}b`,
    );

    // Linear sends multiple webhooks per agent action (e.g. an Issue update
    // PLUS an AgentSessionEvent). Only AgentSessionEvent and the
    // AppUserNotification subtypes carry actionable user intent for the
    // agent — bare Issue/Comment events are noise here. Drop them so we
    // don't create empty "Linear event on ?" sessions.
    if (event.kind === null) {
      return { handled: false, reason: `ignored_event_${event.eventType}` };
    }

    // Publication-first: the URL key already gave us the publication. Skip
    // the pubs.find scan; it would only find the same row anyway since
    // dedicated installs are 1:1 publication ↔ installation.
    if (publication.status !== "live") {
      const reason = "publication_not_live";
      await this.container.webhookEvents.attachError(req.deliveryId, reason);
      return { handled: false, reason };
    }
    await this.container.webhookEvents.attachPublication(
      req.deliveryId,
      publication.id,
    );

    // Comment-on-active-issue path: when ANY human (not the bot itself)
    // posts a comment on an issue with an active OMA session bound to it,
    // resume that session synchronously with the comment as a user message.
    // Routing key is issueId (not parentCommentId) — drops the
    // authored_comments lookup we used to maintain per-comment, in favor
    // of the simpler issue-level binding kept in linear_issue_sessions.
    //
    // Bots post comments via Linear's hosted MCP `save_comment`; replies
    // come back here naturally because Linear webhooks all comments on
    // issues in workspaces our app is installed in.
    if (event.kind === "commentReply" && event.issueId) {
      // Don't bounce the bot's own comments back at itself.
      if (event.actorUserId && installation.botUserId === event.actorUserId) {
        return { handled: false, reason: "comment_from_bot_self" };
      }
      const existing = await this.container.linearIssueSessions.getByIssue(
        publication.id,
        event.issueId,
      );
      if (!existing || existing.status !== "active") {
        return { handled: false, reason: "comment_on_issue_with_no_active_session" };
      }
      const actorDisplayName = await this.resolveActorDisplayName(installation.id, event.actorUserId);
      const handle = actorDisplayName ? `@${actorDisplayName}` : "(unknown user)";
      const replyText = [
        `# Linear comment activity`,
        ``,
        `**Issue:** ${event.issueIdentifier ?? "?"}`,
        ...(event.issueId ? [`**Issue UUID:** \`${event.issueId}\``] : []),
        `**Author:** ${handle}`,
        ...(event.commentId ? [`**Comment id:** \`${event.commentId}\``] : []),
        ...(event.parentCommentId ? [`**Parent comment id:** \`${event.parentCommentId}\` (this is a thread reply)`] : []),
        ``,
        `> ${(event.commentBody ?? "").replace(/\n/g, "\n> ")}`,
        ``,
        `Reply via the Linear hosted MCP \`save_comment\` tool — pass \`parentId\``,
        `to reply within the same thread, or omit it to start a new top-level comment.`,
      ].join("\n");
      try {
        await this.container.sessions.resume(publication.userId, existing.sessionId, {
          type: "user.message",
          content: [{ type: "text", text: replyText }],
          metadata: { linear: { publicationId: publication.id } },
        });
      } catch (err) {
        // Bot session was archived/deleted between webhook and now. Comment
        // is dropped; operator can react via Linear if it matters.
        console.warn(
          `[linear-comment-route] resume failed session=${existing.sessionId} issue=${event.issueId} — dropping. err=${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return { handled: false, reason: "comment_resume_failed_session_gone" };
      }
      await this.container.webhookEvents.attachSession(req.deliveryId, existing.sessionId);
      return {
        handled: true,
        reason: "comment_on_active_issue",
        publicationId: publication.id,
        sessionId: existing.sessionId,
        tenantId: installation.tenantId,
      };
    }

    // Dispatch path: persist event into pending_events queue, optionally
    // synchronously ack the panel (AgentSessionEvent only), return 200.
    // The cron sweep drains the queue and calls processPendingEvent which
    // does sessions.create/resume.
    //
    // Why async: Linear gives webhook handlers ~30s deadline, but spawning
    // a SessionDO + booting the sandbox container can take 10-30s on a
    // cold start. Persisting + 200ing in <500ms is safer; the panel ack
    // (when applicable) gives the user immediate UX feedback while the
    // real work is being prepared.
    if (event.kind === "agentSessionCreated" || event.kind === "agentSessionPrompted") {
      // Best-effort ack-and-close: post a single AgentActivity (kind=response)
      // that finalizes the panel UI. Bot's actual work then happens via
      // comments + state changes (no more linear_say). If this fails we
      // still continue — the queue entry exists, bot will pick it up via
      // cron and post a comment instead.
      if (event.agentSessionId) {
        try {
          await this.ackAgentSessionPanel(installation.id, event.agentSessionId);
        } catch (err) {
          console.warn(
            `[linear-ack] panel ack failed session=${event.agentSessionId} err=${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }

    // agentSessionCreated co-fires with `issueMention` (or
    // `issueAssignedToYou` / `issueCommentMention`) when a description-@
    // or assignment opens both the Agent panel AND a notification. Both
    // routes used to drain into independent user.messages on the same
    // session, producing duplicate top-level comments seconds apart
    // (BOA-19 reproduction). Suppress the drain side of agentSessionCreated
    // — the panel ack above is its only meaningful side-effect; the actual
    // engagement is delivered via the AppUserNotification companion.
    //
    // agentSessionPrompted (follow-up prompt typed in the panel) is NOT
    // suppressed: it carries new user content that has no notification
    // companion.
    if (event.kind === "agentSessionCreated") {
      return {
        handled: true,
        reason: "agent_session_created_panel_only",
        publicationId: publication.id,
        tenantId: installation.tenantId,
      };
    }

    // Promote the deduped row from "audit-only" into the drain queue by
    // setting payload + event_kind + publication_id. Drain picks it up on
    // the next cron tick.
    await this.container.webhookEvents.markActionable(
      req.deliveryId,
      event.kind ?? "unknown",
      publication.id,
      JSON.stringify(event),
    );

    return {
      handled: true,
      reason: "dedicated_install_queued",
      publicationId: publication.id,
      // No sessionId yet — created by the drain. Caller logs this as null.
      // We surface deliveryId so that ops can grep linear_events for the
      // queue row.
      sessionId: req.deliveryId,
      tenantId: installation.tenantId,
    };
  }

  /**
   * Synchronously POST a `kind=response` AgentActivity to finalize the
   * panel Linear opened for this AgentSessionEvent. After this, the panel
   * is in `complete` state and any further linear_say-style writes won't
   * render — the bot does its real work via comments instead.
   *
   * Auth: uses the installation's stored access token. Returns once Linear
   * confirms 200; throws on transport / GraphQL errors so the caller can
   * decide whether to log and continue.
   */
  private async ackAgentSessionPanel(
    installationId: string,
    agentSessionId: string,
  ): Promise<void> {
    const accessToken = await this.container.installations.getAccessToken(installationId);
    if (!accessToken) throw new Error(`no access token for installation ${installationId}`);
    await this.graphql.query<{ agentActivityCreate: { success: boolean } }>(
      accessToken,
      `mutation AckPanel($input: AgentActivityCreateInput!) {
         agentActivityCreate(input: $input) { success }
       }`,
      {
        input: {
          agentSessionId,
          content: {
            type: "response",
            body:
              "Acknowledged — picking this up. I'll respond in the comment thread (this panel is now complete).",
          },
        },
      },
    );
  }

  private async dispatchEvent(
    publication: Publication,
    event: NormalizedWebhookEvent,
  ): Promise<string | null> {
    // Look up the installation to find the vault holding the access token.
    const installation = await this.container.installations.get(publication.installationId);
    const vaultIds = installation?.vaultId ? [installation.vaultId] : [];
    // Hand the bot Linear's hosted MCP server. The outbound MITM
    // Bearer-wraps the vaulted token (PAT or OAuth-app developer token);
    // both work against mcp.linear.app/mcp. Together with our own minimal
    // MCP (see apps/integrations/src/routes/linear/mcp.ts) the bot has
    // ~30 hosted tools + our routing tools.
    const mcpServers: Array<{ name: string; url: string }> = [
      { name: "linear", url: LINEAR_MCP_URL },
    ];

    const actorDisplayName = await this.resolveActorDisplayName(
      installation?.id ?? null,
      event.actorUserId,
    );

    const sessionEvent = {
      type: "user.message" as const,
      content: [
        {
          type: "text" as const,
          text: this.renderEventAsUserMessage(event, actorDisplayName),
        },
      ],
      // Metadata only carries the immutable wiring fields the MCP server
      // needs. The bot owns all "where am I right now" decisions via the
      // tool semantics (issueId is in the prompt body for the bot to read).
      metadata: { linear: { publicationId: publication.id } },
    };

    if (publication.sessionGranularity === "per_issue" && event.issueId) {
      // Two-phase claim race-guard: a sibling webhook (e.g. AgentSessionEvent
      // + AppUserNotification fire concurrently for the same description-@)
      // has just won the (publication, issue) claim and is currently in
      // sessions.create. The pending row holds a placeholder session_id;
      // resuming it would 404. Drop this delivery — the winner will deliver
      // its own message. Stale pending rows (>60s, winner crashed) fall
      // through to reassignIfInactive recovery below.
      const PENDING_FRESH_MS = 60_000;
      const existing = await this.container.linearIssueSessions.getByIssue(
        publication.id,
        event.issueId,
      );
      if (
        existing &&
        existing.status === "pending" &&
        this.container.clock.nowMs() - existing.createdAt < PENDING_FRESH_MS
      ) {
        return null;
      }
      if (existing && existing.status === "active") {
        // Linear is the source of truth; we don't track session lifecycle in
        // our DB. The row's status field is just a "claim marker" — assume
        // any active row points at a still-resumable session. If resume
        // fails (session was archived/deleted), fall through to claim.
        try {
          await this.container.sessions.resume(publication.userId, existing.sessionId, sessionEvent);
          return existing.sessionId;
        } catch (err) {
          console.warn(
            `[linear-dispatch] resume failed for session=${existing.sessionId} issue=${event.issueId} — falling through to claim. err=${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          // fall through to claim path
        }
      }
      // Two-phase claim — phase 1: insert pending row, atomically. Loser
      // returns null (sibling is creating).
      const claimed = await this.container.linearIssueSessions.claimPending({
        tenantId: publication.tenantId,
        publicationId: publication.id,
        issueId: event.issueId,
        nowMs: this.container.clock.nowMs(),
      });
      if (!claimed) {
        // A row already exists. Either we lost the race to a sibling
        // (status='pending' fresh) or there's a stale/terminal row. Try
        // stale-takeover; if that also fails, drop.
        // Note: we don't try to reassign with a real session id here because
        // we haven't created one yet. Just drop and let the next event retry.
        return null;
      }

      // Phase 2: create the session, then atomically swap real id in.
      try {
        const created = await this.container.sessions.create({
          userId: publication.userId,
          agentId: publication.agentId,
          environmentId: publication.environmentId,
          vaultIds,
          mcpServers,
          metadata: { linear: { publicationId: publication.id, issueId: event.issueId, workspaceId: event.workspaceId } },
          initialEvent: sessionEvent,
          additionalSystemPrompt: LINEAR_ENGAGEMENT_PROMPT,
        });
        const fulfilled = await this.container.linearIssueSessions.fulfillPending(
          publication.id,
          event.issueId,
          created.sessionId,
        );
        if (!fulfilled) {
          // Pending row was reaped by stale-takeover before fulfillPending
          // landed. The created session is now orphaned but harmless — Linear
          // will deliver further events to whoever owns the row now.
          console.warn(
            `[linear-dispatch] fulfillPending lost row for issue=${event.issueId} — created session ${created.sessionId} orphaned`,
          );
        }
        return created.sessionId;
      } catch (err) {
        // Roll back the pending row so the next webhook can re-claim. If we
        // leave it, the row stays pending forever and events get dropped
        // until the 60s staleness window opens.
        try {
          await this.container.linearIssueSessions.releasePending(publication.id, event.issueId);
        } catch {
          // best-effort rollback
        }
        throw err;
      }
    }

    // per_event (or per_issue without an issue id): always fresh session.
    const created = await this.container.sessions.create({
      userId: publication.userId,
      agentId: publication.agentId,
      environmentId: publication.environmentId,
      vaultIds,
      mcpServers,
      metadata: { linear: { publicationId: publication.id, issueId: event.issueId, workspaceId: event.workspaceId } },
      initialEvent: sessionEvent,
      additionalSystemPrompt: LINEAR_ENGAGEMENT_PROMPT,
    });
    return created.sessionId;
  }

  private renderEventAsUserMessage(
    event: NormalizedWebhookEvent,
    actorDisplayName: string | null = null,
  ): string {
    // Hard rule: bot only ever sees `@<displayName>`, never the user's
    // `name`. Linear's pre-rendered `promptContext` XML embeds raw `name`
    // values (e.g. "蛇皮") in user attributes — passing it verbatim to
    // the bot causes it to copy the wrong handle into replies and fail to
    // render real mentions. We rebuild the context ourselves from the
    // parsed event fields so every user reference is the displayName.
    const actor = actorDisplayName ? `@${actorDisplayName}` : "(unknown)";
    const headerByKind: Record<string, string> = {
      agentSessionPrompted: `Linear agent session — new prompt`,
      agentSessionCreated: `Linear agent session — newly opened`,
    };
    const header = headerByKind[event.kind ?? ""] ?? `Linear ${event.kind ?? "event"}`;
    const lines: string[] = [`# ${header}`, ""];
    lines.push(`**Issue:** ${event.issueIdentifier ?? "?"}`);
    if (event.issueId) {
      lines.push(`**Issue UUID:** \`${event.issueId}\` (use this when a tool asks for issueId)`);
    }
    lines.push(`**Actor:** ${actor}`);
    if (event.agentSessionId) {
      lines.push(`**Linear panel:** \`${event.agentSessionId}\``);
    }
    if (event.issueTitle) {
      lines.push("");
      lines.push(`**Title:** ${event.issueTitle}`);
    }
    if (event.issueDescription) {
      lines.push("");
      lines.push(`**Description:**`);
      lines.push(event.issueDescription);
    }
    if (event.commentBody) {
      lines.push("");
      lines.push(`**Source comment:**`);
      lines.push(`> ${event.commentBody.replace(/\n/g, "\n> ")}`);
    }
    if (event.agentSessionId) {
      lines.push("");
      lines.push(
        `Linear opened a panel for this trigger but OMA already acknowledged ` +
          `and finalized it. Do all your work via comments + issue state ` +
          `changes — use \`linear_post_comment\` (OMA tool) for top-level ` +
          `progress notes and final results, and the Linear hosted MCP ` +
          `(\`save_issue\`, \`save_comment\` for replies, etc.) for everything else.`,
      );
    }
    return lines.join("\n");
  }

  /** Best-effort displayName resolution. Returns null if anything goes
   *  wrong — callers fall back to "(unknown)" and the bot just doesn't get
   *  the @-handle hint. */
  private async resolveActorDisplayName(
    installationId: string | null,
    actorUserId: string | null | undefined,
  ): Promise<string | null> {
    if (!installationId || !actorUserId) return null;
    try {
      const accessToken = await this.container.installations.getAccessToken(installationId);
      if (!accessToken) return null;
      const res = await this.container.http.fetch({
        method: "POST",
        url: "https://api.linear.app/graphql",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          query: `query($id:String!){ user(id:$id){ displayName } }`,
          variables: { id: actorUserId },
        }),
      });
      const parsed = JSON.parse(res.body) as {
        data?: { user?: { displayName?: string } };
      };
      return parsed.data?.user?.displayName ?? null;
    } catch {
      return null;
    }
  }

  // ─── MCP (Phase 8+) ──────────────────────────────────────────────────

  async mcpTools(_scope: McpScope): Promise<readonly McpToolDescriptor[]> {
    throw new Error("LinearProvider.mcpTools: not yet implemented");
  }

  async invokeMcpTool(
    _scope: McpScope,
    _toolName: string,
    _input: unknown,
  ): Promise<McpToolResult> {
    throw new Error("LinearProvider.invokeMcpTool: not yet implemented");
  }

  // ─── Token refresh ───────────────────────────────────────────────────
  //
  // Linear's `actor=app` authorization-code grant returns a 24-hour access
  // token + a refresh token. We persist both at install time. When a Linear
  // API call returns 401, the gateway calls `refreshAccessToken(installationId)`
  // to swap the dead token for a fresh one in-place — no reinstall needed.
  //
  // Linear rotates the refresh_token on every call, so the response payload
  // must be persisted in full. If Linear ever responds with a missing or
  // empty refresh_token, we leave the old one in place to keep future
  // refreshes possible.
  //
  // Publication-first: client credentials live on the publication row, so
  // we walk installation → publication to find them. A dedicated install
  // is 1:1 with a publication, so the lookup is unambiguous.

  /**
   * Run Linear's OAuth refresh flow for `installationId`. Persists the rotated
   * tokens via the installation repo and returns the new access token. Throws
   * if the installation is missing, has no stored refresh token, the bound
   * publication can't be located (no credentials), or Linear rejects the
   * refresh (e.g. user revoked the App). Caller decides whether to bubble
   * the error or surface a friendlier "please reinstall" message.
   */
  async refreshAccessToken(installationId: string): Promise<string> {
    const installation = await this.container.installations.get(installationId);
    if (!installation) {
      throw new Error(`installation ${installationId} not found`);
    }
    if (installation.revokedAt !== null) {
      throw new Error(`installation ${installationId} is revoked`);
    }
    const refreshToken = await this.container.installations.getRefreshToken(installationId);
    if (!refreshToken) {
      throw new Error(
        `installation ${installationId} has no stored refresh_token — cannot refresh, user must reinstall`,
      );
    }
    const credentials = await this.findPublicationCredentialsForInstallation(installationId);
    if (!credentials) {
      throw new Error(
        `installation ${installationId} has no live publication with credentials — cannot refresh`,
      );
    }
    const refreshReq = buildRefreshTokenBody({
      refreshToken,
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
    });
    const refreshRes = await this.container.http.fetch({
      method: "POST",
      url: refreshReq.url,
      headers: { "content-type": refreshReq.contentType },
      body: refreshReq.body,
    });
    if (refreshRes.status < 200 || refreshRes.status >= 300) {
      throw new Error(
        `Linear OAuth refresh failed: ${refreshRes.status} ${refreshRes.body.slice(0, 200)}`,
      );
    }
    const fresh = parseTokenResponse(refreshRes.body);
    await this.container.installations.setTokens(
      installationId,
      fresh.access_token,
      // null is fine here — setTokens leaves the prior refresh row in place
      // when Linear didn't rotate. In practice Linear always sends one.
      fresh.refresh_token,
    );

    // Mirror the new bearer into the vault so the sandbox MITM injection picks
    // it up on the next outbound HTTPS call. Best-effort: a missing vault row
    // (older installs) shouldn't fail the refresh.
    if (installation.vaultId) {
      await this.container.vaults.rotateBearerToken({
        userId: installation.userId,
        vaultId: installation.vaultId,
        newBearerToken: fresh.access_token,
      });
    }

    return fresh.access_token;
  }

  /** Walks installation → publication → credentials. Returns null if no
   *  live publication is bound to the installation. */
  private async findPublicationCredentialsForInstallation(
    installationId: string,
  ): Promise<{ clientId: string; clientSecret: string; publicationId: string } | null> {
    const pubs = await this.container.publications.listByInstallation(installationId);
    const live = pubs.find((p) => p.status === "live") ?? pubs[0];
    if (!live) return null;
    const creds = await this.container.publications.getCredentials(live.id);
    if (!creds) return null;
    return {
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      publicationId: live.id,
    };
  }

  // ─── One-shot re-authorize ──────────────────────────────────────────
  //
  // When Linear rotates an OAuth app's secret (or the previous install
  // predates refresh-token capture), the only way back to a working state
  // is to re-grant OAuth consent. These methods drive that flow keyed on
  // the installation's existing publication row — the publication holds
  // both client credentials and the redirect URI so reauth doesn't need
  // to register fresh OAuth-app config in Linear.
  //
  //   buildReauthorizeUrl(installationId, redirectBase)
  //     → builds the Linear authorize URL + state JWT, no DB writes
  //   completeReauthorize(publicationId, code, state)
  //     → verifies state, exchanges code, rotates tokens + vault in place

  /**
   * Build a single-use Linear authorize URL that re-grants consent for an
   * existing installation. The state JWT carries the bound `publicationId`
   * so the companion callback rotates the right row.
   */
  async buildReauthorizeUrl(input: {
    installationId: string;
    redirectBase: string;
    ttlSeconds?: number;
  }): Promise<{
    authorizeUrl: string;
    publicationId: string;
    workspaceName: string;
    botUserId: string;
  }> {
    const inst = await this.container.installations.get(input.installationId);
    if (!inst) throw new Error(`installation ${input.installationId} not found`);
    const credentials = await this.findPublicationCredentialsForInstallation(inst.id);
    if (!credentials) {
      throw new Error(
        `installation ${input.installationId} has no live publication with credentials`,
      );
    }
    const stateToken = await this.container.jwt.sign(
      {
        kind: "linear.oauth.reauth",
        installationId: inst.id,
        publicationId: credentials.publicationId,
      },
      input.ttlSeconds ?? 60 * 30,
    );
    // Reuse the publication's install callback URI on purpose — it's already
    // registered as a redirect_uri in the user's Linear OAuth app. The
    // callback handler dispatches by state.kind: "linear.oauth.publication"
    // → first install; "linear.oauth.reauth" → token rotation.
    const redirectUri = this.publicationCallbackUriFromBase(
      input.redirectBase,
      credentials.publicationId,
    );
    const authorizeUrl = buildAuthorizeUrl({
      clientId: credentials.clientId,
      redirectUri,
      scopes: this.config.scopes ?? DEFAULT_LINEAR_SCOPES,
      state: stateToken,
      actor: "app",
    });
    return {
      authorizeUrl,
      publicationId: credentials.publicationId,
      workspaceName: inst.workspaceName,
      botUserId: inst.botUserId,
    };
  }

  /**
   * Verify a re-authorize callback's state, exchange the fresh code for a
   * token pair, and rotate the existing installation's tokens (and vault
   * bearer) in place. Throws on any validation or upstream failure.
   */
  async completeReauthorize(input: {
    publicationId: string;
    code: string;
    state: string;
    redirectBase: string;
  }): Promise<{
    installationId: string;
    publicationId: string;
    workspaceName: string;
    botUserId: string;
    accessToken: string;
    capturedRefreshToken: boolean;
  }> {
    const payload = await this.container.jwt.verify<{
      kind: string;
      installationId: string;
      publicationId: string;
    }>(input.state);
    if (payload.kind !== "linear.oauth.reauth") {
      throw new Error("reauth callback: wrong state kind");
    }
    if (payload.publicationId !== input.publicationId) {
      throw new Error("reauth callback: publicationId mismatch");
    }
    const inst = await this.container.installations.get(payload.installationId);
    if (!inst) throw new Error("reauth callback: installation not found");
    const credentials = await this.container.publications.getCredentials(input.publicationId);
    if (!credentials) {
      throw new Error("reauth callback: publication has no credentials");
    }

    const redirectUri = this.publicationCallbackUriFromBase(
      input.redirectBase,
      input.publicationId,
    );
    const tokenReq = buildTokenExchangeBody({
      code: input.code,
      redirectUri,
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
    });
    const tokenRes = await this.container.http.fetch({
      method: "POST",
      url: tokenReq.url,
      headers: { "content-type": tokenReq.contentType },
      body: tokenReq.body,
    });
    if (tokenRes.status < 200 || tokenRes.status >= 300) {
      throw new Error(
        `reauth token exchange failed: ${tokenRes.status} ${tokenRes.body.slice(0, 200)}`,
      );
    }
    const token = parseTokenResponse(tokenRes.body);
    if (!token.refresh_token) {
      throw new Error(
        "reauth token exchange returned no refresh_token — check the OAuth app's actor=app + offline access settings",
      );
    }

    await this.container.installations.setTokens(
      inst.id,
      token.access_token,
      token.refresh_token,
    );
    if (inst.vaultId) {
      await this.container.vaults.rotateBearerToken({
        userId: inst.userId,
        vaultId: inst.vaultId,
        newBearerToken: token.access_token,
      });
    }
    return {
      installationId: inst.id,
      publicationId: input.publicationId,
      workspaceName: inst.workspaceName,
      botUserId: inst.botUserId,
      accessToken: token.access_token,
      capturedRefreshToken: true,
    };
  }

  /** Build a publication callback URI from an arbitrary origin. Used by
   *  reauth helpers that get the gateway origin handed in (vs reading
   *  `this.config.gatewayOrigin`) so they're callable from admin paths. */
  private publicationCallbackUriFromBase(redirectBase: string, pubId: string): string {
    const trimmed = redirectBase.replace(/\/+$/, "");
    return `${trimmed}/linear/oauth/pub/${pubId}/callback`;
  }

  // ─── Cron sweep + queue drain ─────────────────────────────────

  /**
   * Drain the linear_events queue (rows where payload_json IS NOT NULL AND
   * processed_at IS NULL). Each event is parsed back into a
   * NormalizedWebhookEvent and processed via dispatchEvent. Per-event
   * failures are caught so one bad row doesn't poison the whole tick.
   *
   * `limit` caps work per tick to share cron CPU with runDispatchSweep.
   *
   * Successful + failed rows both get processed_at set (markProcessed /
   * markFailed); they then sit in the table until the 7-day retention
   * sweep GCs them. Operators can grep linear_events by delivery_id for
   * historical debug.
   */
  async drainPendingEvents(nowMs: number, limit = 25): Promise<{
    drainedEvents: number;
    succeeded: number;
    failed: number;
  }> {
    const rows = await this.container.webhookEvents.listUnprocessed(limit);
    let succeeded = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        const publication = await this.container.publications.get(row.publicationId);
        if (!publication || publication.status !== "live") {
          await this.container.webhookEvents.markFailed(
            row.deliveryId,
            "publication not found or not live",
            nowMs,
          );
          failed++;
          continue;
        }
        const event = JSON.parse(row.payload) as NormalizedWebhookEvent;
        const sessionId = await this.dispatchEvent(publication, event);
        // Linear stays the source of truth for issue state. Mark the row
        // processed with the spawned session id; 7-day retention sweep GCs
        // it later. Keeping it lets ops grep linear_events by delivery_id
        // for "what happened to this webhook" debugging. sessionId is null
        // when the dispatcher dropped the event (e.g. lost the two-phase
        // claim race to a sibling); record empty string in that case.
        await this.container.webhookEvents.markProcessed(
          row.deliveryId,
          sessionId ?? "",
          nowMs,
        );
        succeeded++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        try {
          await this.container.webhookEvents.markFailed(row.deliveryId, msg, nowMs);
        } catch {
          // best-effort
        }
        failed++;
        console.warn(`[linear-drain] delivery=${row.deliveryId} kind=${row.eventKind} err=${msg}`);
      }
    }
    return { drainedEvents: rows.length, succeeded, failed };
  }

  /**
   * Cron entry point. Picks rules whose `lastPolledAt` is older than the
   * configured interval, runs each, and marks polled. Per-rule errors are
   * caught so one bad rule doesn't poison the whole tick.
   *
   * `ruleLimit` caps how many rules a single tick processes — a noisy
   * Linear workspace (lots of due rules) shouldn't starve other tenants.
   * Default 50 leaves plenty of cron-tick budget.
   */
  async runDispatchSweep(nowMs: number, ruleLimit = 50): Promise<{
    sweptRules: number;
    assignedIssues: number;
    errors: ReadonlyArray<{ ruleId: string; message: string }>;
  }> {
    const rules = await this.container.dispatchRules.listDueForSweep(nowMs, ruleLimit);
    const errors: Array<{ ruleId: string; message: string }> = [];
    let assignedIssues = 0;
    for (const rule of rules) {
      try {
        const n = await this.processDispatchRule(rule, nowMs);
        assignedIssues += n;
      } catch (err) {
        errors.push({
          ruleId: rule.id,
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        // Always advance lastPolledAt so a permanently broken rule
        // doesn't get retried every tick. Operator can re-enable by
        // patching the rule (which doesn't reset lastPolledAt — that's
        // fine, next interval will fire normally).
        try {
          await this.container.dispatchRules.markPolled(rule.id, nowMs);
        } catch {
          // markPolled failing is not fatal — sweep retries next tick.
        }
      }
    }
    return { sweptRules: rules.length, assignedIssues, errors };
  }

  private async processDispatchRule(
    rule: DispatchRule,
    nowMs: number,
  ): Promise<number> {
    const publication = await this.container.publications.get(rule.publicationId);
    if (!publication || publication.status !== "live") return 0;
    const installation = await this.container.installations.get(publication.installationId);
    if (!installation || installation.revokedAt !== null) return 0;
    const accessToken = await this.container.installations.getAccessToken(
      installation.id,
    );
    if (!accessToken) return 0;

    // Combined query: candidate issues + current bot load (for max_concurrent
    // enforcement) in one Linear round trip. We don't trust local DB rows
    // for "is the bot still working" — Linear is the source of truth.
    const initialSlots = Math.min(rule.maxConcurrent * 2, 25);
    const { candidates, currentLoad } = await this.queryDispatchCandidates(
      accessToken,
      rule,
      installation.botUserId,
      initialSlots,
    );
    const slots = Math.max(0, rule.maxConcurrent - currentLoad);
    if (slots === 0 || candidates.length === 0) return 0;

    let assigned = 0;
    for (const issue of candidates) {
      if (assigned >= slots) break;
      try {
        if (installation.installKind === "personal_token") {
          const ok = await this.dispatchPatModeIssue({
            rule,
            publication,
            installation,
            accessToken,
            issue,
            nowMs,
          });
          if (ok) assigned++;
        } else {
          // OAuth-app mode: assign and let Linear's IssueAssignedToYou
          // webhook fire dispatchEvent. linear_issue_sessions dedup
          // protects us from races.
          await this.linearIssueAssign(accessToken, issue.id, installation.botUserId);
          assigned++;
        }
      } catch (err) {
        // Per-issue failures don't poison the rule — log and continue.
        console.warn(
          `[linear-dispatch] rule=${rule.id} issue=${issue.identifier} kind=${installation.installKind} err=${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return assigned;
  }

  /**
   * PAT mode has no webhook source, so the sweep claims atomically and
   * spawns the session itself. Order matters:
   *   1. CAS-claim with sentinel sessionId — wins the race or aborts.
   *   2. sessions.create() — actual session id assigned by host.
   *   3. issueSessions.insert() — UPSERTs the real sessionId over the
   *      sentinel (status remains 'active').
   *   4. issueUpdate(assignee) — best-effort, only for Linear UI
   *      visibility. Failure here doesn't unwind the session.
   *
   * If sessions.create throws after claim, we mark the row 'inactive' so
   * the next sweep tick can retry the issue.
   */
  private async dispatchPatModeIssue(args: {
    rule: DispatchRule;
    publication: Publication;
    installation: { id: string; tenantId: string; botUserId: string; vaultId: string | null };
    accessToken: string;
    issue: DispatchCandidate;
    nowMs: number;
  }): Promise<boolean> {
    const { rule, publication, installation, accessToken, issue, nowMs } = args;
    const claimed = await this.container.linearIssueSessions.claim({
      tenantId: publication.tenantId,
      publicationId: publication.id,
      issueId: issue.id,
      sessionId: "_supervisor_claim",
      nowMs,
    });
    if (!claimed) return false;

    let sessionId: string | null = null;
    try {
      const sessionEvent = {
        type: "user.message" as const,
        content: [
          {
            type: "text" as const,
            text: this.renderSupervisorPickupAsUserMessage(rule, issue),
          },
        ],
        metadata: { linear: { publicationId: publication.id } },
      };
      const created = await this.container.sessions.create({
        userId: publication.userId,
        agentId: publication.agentId,
        environmentId: publication.environmentId,
        vaultIds: installation.vaultId ? [installation.vaultId] : [],
        mcpServers: [{ name: "linear", url: LINEAR_MCP_URL }],
        metadata: {
          linear: {
            publicationId: publication.id,
            issueId: issue.id,
            workspaceId: null,
          },
        },
        initialEvent: sessionEvent,
        additionalSystemPrompt: LINEAR_ENGAGEMENT_PROMPT,
      });
      sessionId = created.sessionId;

      // UPSERT the row with the real session id (replaces the sentinel).
      await this.container.linearIssueSessions.insert({
        tenantId: publication.tenantId,
        publicationId: publication.id,
        issueId: issue.id,
        sessionId,
        status: "active",
        createdAt: nowMs,
      });
    } catch (err) {
      // Roll back the claim so next tick can retry.
      try {
        await this.container.linearIssueSessions.updateStatus(
          publication.id,
          issue.id,
          "failed",
        );
      } catch {
        // best-effort
      }
      throw err;
    }

    // Best-effort visibility update — humans browsing the board should
    // see the bot has picked the issue up. Failure here is a UX papercut,
    // not a correctness issue.
    try {
      await this.linearIssueAssign(accessToken, issue.id, installation.botUserId);
    } catch (err) {
      console.warn(
        `[linear-dispatch] PAT visibility-assign failed issue=${issue.identifier} session=${sessionId} err=${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return true;
  }

  private async queryDispatchCandidates(
    accessToken: string,
    rule: DispatchRule,
    botUserId: string,
    first: number,
  ): Promise<{ candidates: DispatchCandidate[]; currentLoad: number }> {
    const candidateFilter: Record<string, unknown> = {
      assignee: { null: true },
    };
    if (rule.filterStates && rule.filterStates.length > 0) {
      candidateFilter.state = { name: { in: rule.filterStates } };
    }
    if (rule.filterLabel) {
      candidateFilter.labels = { some: { name: { eq: rule.filterLabel } } };
    }
    if (rule.filterProjectId) {
      candidateFilter.project = { id: { eq: rule.filterProjectId } };
    }
    // Linear is the source of truth for "is the bot still working on this"
    // — we do NOT track session lifecycle in our DB. Count by querying for
    // the bot's own non-terminal assigned issues. Combined with the
    // candidate query in one round trip.
    const loadFilter = {
      assignee: { id: { eq: botUserId } },
      state: { type: { nin: ["completed", "canceled"] } },
    };
    const data = await this.graphql.query<{
      candidates: { nodes: DispatchCandidate[] };
      load: { nodes: Array<{ id: string }> };
    }>(
      accessToken,
      `query DispatchCandidatesAndLoad(
         $candidateFilter: IssueFilter, $loadFilter: IssueFilter,
         $first: Int!, $loadFirst: Int!
       ) {
         candidates: issues(filter: $candidateFilter, first: $first) {
           nodes { id identifier title url description }
         }
         load: issues(filter: $loadFilter, first: $loadFirst) {
           nodes { id }
         }
       }`,
      {
        candidateFilter,
        loadFilter,
        first,
        // Cap load query at maxConcurrent — we only need to know whether
        // we're at/over the cap, not the exact count if it's huge.
        loadFirst: rule.maxConcurrent,
      },
    );
    return {
      candidates: data.candidates.nodes ?? [],
      currentLoad: (data.load.nodes ?? []).length,
    };
  }

  private async linearIssueAssign(
    accessToken: string,
    issueId: string,
    assigneeId: string,
  ): Promise<void> {
    await this.graphql.query<{ issueUpdate: { success: boolean } }>(
      accessToken,
      `mutation AssignIssue($id: String!, $assigneeId: String!) {
         issueUpdate(id: $id, input: { assigneeId: $assigneeId }) { success }
       }`,
      { id: issueId, assigneeId },
    );
  }

  private renderSupervisorPickupAsUserMessage(
    rule: DispatchRule,
    issue: DispatchCandidate,
  ): string {
    const filters: string[] = [];
    if (rule.filterLabel) filters.push(`label="${rule.filterLabel}"`);
    if (rule.filterStates) filters.push(`state in [${rule.filterStates.join(", ")}]`);
    if (rule.filterProjectId) filters.push(`project=${rule.filterProjectId}`);
    const filterDesc = filters.length > 0 ? filters.join(" AND ") : "(no filter)";
    const lines: string[] = [
      `# Linear supervisor pickup`,
      ``,
      `**Issue:** ${issue.identifier}`,
      `**Issue UUID:** \`${issue.id}\` (use this when a tool asks for issueId)`,
      `**Title:** ${issue.title}`,
    ];
    if (issue.url) {
      lines.push(`**URL:** ${issue.url}`);
    }
    if (issue.description) {
      lines.push("");
      lines.push(`**Description:**`);
      lines.push(issue.description);
    }
    lines.push("");
    lines.push(
      `You were auto-assigned by the dispatch rule "${rule.name}" (${filterDesc}). ` +
        `Move the issue to In Progress (Linear hosted MCP: \`save_issue(id, state)\`), ` +
        `do the work, post progress comments via OMA's \`linear_post_comment\`, ` +
        `and when done set state to Done + clear assignee via \`save_issue\`.`,
    );
    return lines.join("\n");
  }
}

interface DispatchCandidate {
  id: string;
  identifier: string;
  title: string;
  url: string | null;
  description: string | null;
}
