// SlackProvider — implements integrations-core's IntegrationProvider for
// Slack. Mirror of LinearProvider with Slack-specific quirks:
//
// - OAuth v2 dual-token flow (bot scope + user scope, both tokens stored).
// - Webhook signature is HMAC-SHA256 over `v0:{ts}:{rawBody}` with replay
//   protection (5-min skew limit).
// - First webhook to a fresh URL is a `url_verification` handshake — must
//   verify the signature, then echo the challenge string within 3 sec.
// - Slack's 3-second response budget rules out doing the dispatch inline.
//   The provider returns a `deferredWork` closure on WebhookOutcome; the
//   route handler attaches it to `executionCtx.waitUntil(...)` and 200's.
// - Per_thread session granularity, scopeKey = `${channel_id}:${thread_ts}`.
// - MCP runs via vault outbound injection of the user xoxp- token.

import type {
  Container,
  ContinueInstallInput,
  IntegrationProvider,
  InstallComplete,
  InstallStep,
  McpScope,
  McpToolDescriptor,
  McpToolResult,
  ProviderId,
  Publication,
  SessionGranularity,
  StartInstallInput,
  WebhookOutcome,
  WebhookRequest,
} from "@open-managed-agents/integrations-core";

import { SlackApiClient } from "./api/client";
import {
  ALL_SLACK_CAPABILITIES,
  DEFAULT_SLACK_BOT_SCOPES,
  DEFAULT_SLACK_SUBSCRIBED_EVENTS,
  DEFAULT_SLACK_USER_SCOPES,
  type SlackConfig,
} from "./config";
import {
  buildAuthorizeUrl,
  buildTokenExchangeBody,
  parseTokenResponse,
} from "./oauth/protocol";
import { buildManifest, buildManifestLaunchUrl } from "./oauth/manifest";
import type {
  SlackInstallationRepo,
  SlackPublicationRepo,
  SlackSessionScopeRepo,
} from "./ports";
import {
  buildBaseString,
  isTimestampFresh,
  parseSignatureHeader,
} from "./webhook/signature";
import {
  parseWebhook,
  type NormalizedSlackEvent,
  type RawSlackEnvelope,
  type RawUrlVerification,
  type RawEventCallback,
} from "./webhook/parse";

// 60 minutes — the manifest flow can spin up a new browser tab, walk through
// Slack's app creation, copy 3 secrets, and come back. 30 minutes was tight
// once the manifest tab and OAuth grant are added in.
const OAUTH_STATE_TTL_SECONDS = 60 * 60;
const PROVIDER_ID: ProviderId = "slack";

/** Slack's hosted MCP server. Outbound injection matches by hostname. */
const SLACK_MCP_URL = "https://mcp.slack.com/mcp";
/** Slack's Web API base — bot token vault binds here. */
const SLACK_API_URL = "https://slack.com/api";

/**
 * For `per_channel` granularity: how long after the first new top-level
 * message we hold the "armed" flag before allowing another scan-arm dispatch.
 * The agent receives the armed signal immediately and is expected to call
 * scheduleWakeup with roughly this same delay; on wake it reads
 * conversations.history for everything that arrived during the window.
 */
const PER_CHANNEL_DEBOUNCE_WINDOW_MS = 90_000;

/**
 * Once-per-session protocol prose appended to the agent's system prompt at
 * `sessions.create` time for per_channel Slack sessions. The webhook-driven
 * `<oma_signal>` user.message texts (see renderEventAsUserMessage) carry only
 * the per-event variable bits; everything stable lives here so we get prompt-
 * cache locality and avoid re-emitting the same kilobytes on every turn.
 *
 * Frozen at session.create — resumes against an existing session see
 * whatever protocol text was current when the session was first opened. The
 * protocol rarely changes; if it does, new sessions pick up the new text.
 *
 * Exported for unit tests so a regression that drops/mangles the prompt
 * fails loudly.
 */
export const SLACK_SIGNAL_PROTOCOL_PROMPT = [
  `<oma_slack_signal_protocol>`,
  `Slack-originated turns arrive as user.message events whose text is wrapped in an \`<oma_signal kind="…">\` envelope. The envelope is runtime metadata — never quote signal names, attributes, or envelope structure back to humans.`,
  ``,
  `To post into Slack, use the Slack tools in the \`mcp__slack__*\` namespace; pick by name semantics (e.g. for posting, look for \`chat\` + \`post\`/\`message\`). Copy \`channel\` and \`thread_ts\` from the envelope; omit \`thread_ts\` to post top-level.`,
  ``,
  `## Signal kinds`,
  ``,
  `- \`joined_channel\`: you were added to the channel. Read topic + recent history, then post a brief self-intro top-level (no thread_ts).`,
  `- \`direct_invocation\`: a human @-mentioned or DM'd you. Reply in the channel + thread_ts. If the work spans multiple turns, post an acknowledgement now and \`scheduleWakeup\` for the follow-up.`,
  `- \`channel_scan_armed\`: a top-level message arrived; runtime has armed a debounce window. Call \`scheduleWakeup({ delay_seconds: <debounce_seconds>, prompt: "scan_channel <channel_id>" })\` and end the turn — do NOT post. When the wakeup fires, read history (oldest=<lastScanAt>) and decide whether to act.`,
  `- \`reaction_on_bot_message\`: someone reacted on your prior message. Default: stay silent. Only follow up if the reaction signals a real problem (🚫 / 🐛 / ❓) and you can add value. Never post "noted" / "thanks for the feedback".`,
  `- \`session_closed\`: you were removed or the channel was archived. End the turn with no output.`,
  ``,
  `Never quote signal names, envelope attributes, or internal terms (\`scheduleWakeup\`, \`oma_signal\`, "scan window", "debounce", "session") back to humans. Speak as the bot persona.`,
  `</oma_slack_signal_protocol>`,
].join("\n");

/**
 * Routing intent for per_channel dispatch. classifyDispatch sets this so
 * dispatchEvent knows which signal to render and which lifecycle action to
 * take. For per_thread / per_event (legacy) paths intent is undefined.
 */
type DispatchIntent =
  | "joined_channel"     // member_joined_channel for bot, or first wake of a fresh channel session
  | "scan_arm"           // top-level message in per_channel — debounce + signal
  | "direct_invocation"  // @ / DM / thread reply (per_channel routes to channel session)
  | "reaction_on_bot"    // reaction on a bot-authored message
  | "close_session"      // member_left_channel for bot, or channel_archive
  | "reopen_session";    // channel_unarchive

type ClassifyDecision =
  | { kind: "dispatch"; intent?: DispatchIntent }
  | { kind: "drop"; reason: string }
  /** channel_rename: update the cached channel_name on the scope row but don't wake the agent. */
  | { kind: "metadata_only"; channelName: string };

/**
 * Single source of truth for `slack_thread_sessions.scope_key` shape, given
 * a publication's session granularity. Used by both the dispatcher (to look
 * up the active scope row) and the session-creator (to write the same row).
 *
 *   per_channel: `channel:${channelId}`
 *     One running session per (publication, channel). Bot perceives a
 *     channel as a long-lived conversation; @-mentions, DMs to threads,
 *     and thread replies all converge on the same session id.
 *
 *   per_thread:  `${channelId}:${threadTs}`
 *     One session per (publication, channel, thread). Each thread is its
 *     own context; cross-thread events get fresh sessions. `threadTs` is
 *     required — top-level messages with no thread anchor return null.
 *
 *   per_event / per_issue: null
 *     No persistent scope; every event creates a throwaway session.
 *
 * Returns null when the event lacks the fields needed for the requested
 * granularity (e.g. uninstall events with no channel; per_thread without
 * thread_ts) — caller treats null as "no scope binding" and either drops
 * the event or routes via per-event semantics.
 */
export function scopeKeyFor(
  event: NormalizedSlackEvent,
  granularity: SessionGranularity,
): string | null {
  if (!event.channelId) return null;
  switch (granularity) {
    case "per_channel":
      return `channel:${event.channelId}`;
    case "per_thread":
      return event.threadTs ? `${event.channelId}:${event.threadTs}` : null;
    case "per_event":
    case "per_issue":
      return null;
    default:
      return null;
  }
}

/**
 * The kind of signal embedded in the rendered user.message text. Drives the
 * agent's behavior — each kind's prompt phrasing is documented in
 * renderEventAsUserMessage. Distinct from DispatchIntent because intents
 * describe routing actions (close session, arm scan) while signals describe
 * what the agent perceives.
 */
type SignalKind =
  | "joined_channel"
  | "channel_scan_armed"
  | "direct_invocation"
  | "reaction_on_bot_message"
  | "session_closed";

/** Optional context fields passed to renderEventAsUserMessage / buildSessionEvent. */
interface SignalExtras {
  /** Cached channel display name (without `#`), if known. */
  channelName?: string | null;
  /** Debounce window the agent should match in scheduleWakeup, in ms. */
  debounceMs?: number;
  /** ms timestamp of last completed scan; renderer formats as Slack `oldest=`. */
  lastScanAt?: number | null;
  /** Whether this is a reopen rather than a fresh join. */
  reopened?: boolean;
}

/**
 * SlackProvider's container differs from the base Container in three places:
 * `installations` is a SlackInstallationRepo (extends InstallationRepo with
 * getUserToken / setBotVaultId), `publications` is a SlackPublicationRepo
 * (extends PublicationRepo with the publication-first credential staging
 * methods), and `sessionScopes` is a SlackSessionScopeRepo (extends
 * SessionScopeRepo with armPendingScan / clearPendingScan /
 * updateChannelName for per_channel granularity).
 */
export interface SlackContainer extends Omit<Container, "installations" | "publications" | "sessionScopes"> {
  installations: SlackInstallationRepo;
  publications: SlackPublicationRepo;
  sessionScopes: SlackSessionScopeRepo;
}

export class SlackProvider implements IntegrationProvider {
  readonly id: ProviderId = PROVIDER_ID;
  private readonly api: SlackApiClient;

  constructor(
    private readonly container: SlackContainer,
    private readonly config: SlackConfig,
  ) {
    this.api = new SlackApiClient(container.http);
  }

  // ─── Install ─────────────────────────────────────────────────────────
  //
  // Publication-first install:
  //   1. startInstall → INSERT a slack_publications shell row, status=
  //      'pending_setup'. Returns the FINAL callback URL keyed on the
  //      publication id ("/slack/oauth/pub/<pub_id>/callback") so the
  //      manifest baked at api.slack.com is correct from minute one.
  //   2. submitCredentials → PATCH client_id / client_secret / signing_secret
  //      onto the publication row (encrypted). Status flips to
  //      'credentials_filled'. Idempotent — re-pasting overwrites cipher
  //      columns; never creates a second row.
  //   3. handleOAuthCallback → reads the publication row, exchanges the
  //      OAuth code, creates installation + vaults + slack_apps row, binds
  //      everything back onto the publication, flips status='live'.
  //
  // The old "OAuth callback creates everything" flow (with cascading INSERTs
  // across slack_installations, slack_apps, vaults, slack_publications) is
  // gone. Mid-flow failure now leaves at most a stale set of cipher columns
  // on a single row — the user can re-paste credentials and re-do OAuth
  // without first cleaning up a ghost row.

  async startInstall(input: StartInstallInput): Promise<InstallStep | InstallComplete> {
    // INSERT the publication shell up-front. Doing this here (vs. a separate
    // route handler) keeps the provider as the single source of truth for
    // "what state is a half-finished install in".
    const tenantId = await this.container.tenants.resolveByUserId(input.userId);
    const publication = await this.container.publications.insertShell({
      tenantId,
      userId: input.userId,
      agentId: input.agentId,
      environmentId: input.environmentId,
      persona: input.persona,
      capabilities: new Set(
        this.config.defaultCapabilities ?? ALL_SLACK_CAPABILITIES,
      ),
      sessionGranularity: this.config.defaultSessionGranularity ?? "per_channel",
    });

    const formToken = await this.container.jwt.sign(
      {
        kind: "slack.pub.form",
        publicationId: publication.id,
        userId: input.userId,
        returnUrl: input.returnUrl,
      },
      OAUTH_STATE_TTL_SECONDS,
    );

    return {
      kind: "step",
      step: "credentials_form",
      data: {
        formToken,
        publicationId: publication.id,
        suggestedAppName: input.persona.name,
        suggestedAvatarUrl: input.persona.avatarUrl,
        callbackUrl: this.callbackUriForPublication(publication.id),
        webhookUrl: this.webhookForPublication(publication.id),
        manifestLaunchUrl: this.buildManifestLaunchUrlForPublication(
          publication.id,
          input.persona.name,
        ),
      },
    };
  }

  /**
   * Build the Slack "Create from manifest" URL for a publication-first shell.
   * The manifest's redirect_url is keyed on the publication id; the events
   * request URL is the placeholder `/slack/webhook/app/__pending__` until
   * the OAuth callback rewrites it (the user can paste the final webhook
   * URL into Slack's UI after install completes — Slack stores it
   * server-side, manifest is read-once at app create).
   *
   * Why a placeholder for the webhook URL: it must include the Slack-side
   * app id (which Slack only assigns when the manifest is created), but the
   * manifest is what creates the app. The manifest UI shows the URL so the
   * user can copy-paste, but Slack also accepts a self-update via the
   * Events Subscriptions admin page after install. Documented in the
   * wizard.
   */
  buildManifestLaunchUrlForPublication(
    publicationId: string,
    personaName: string,
  ): string {
    const manifest = buildManifest({
      personaName,
      // Webhook URL is keyed on pub_id which we already have here. The
      // gateway resolves pub_id → publication.slack_app_id at delivery
      // time, so the URL stays valid from manifest-build through OAuth
      // and beyond. No more placeholder + post-install paste step.
      webhookUrl: this.webhookForPublication(publicationId),
      redirectUrl: this.callbackUriForPublication(publicationId),
      botScopes: this.config.botScopes ?? DEFAULT_SLACK_BOT_SCOPES,
      userScopes: this.config.userScopes ?? DEFAULT_SLACK_USER_SCOPES,
      subscribedEvents: DEFAULT_SLACK_SUBSCRIBED_EVENTS,
    });
    return buildManifestLaunchUrl(manifest);
  }

  async continueInstall(
    input: ContinueInstallInput,
  ): Promise<InstallStep | InstallComplete> {
    const payload = input.payload as { kind?: string; [k: string]: unknown };
    if (payload.kind === "submit_credentials") {
      return this.submitCredentials(payload);
    }
    if (payload.kind === "handoff_link") {
      return this.createHandoffLink(payload);
    }
    if (payload.kind === "reissue_form_token") {
      return this.reissueFormToken({
        publicationId: (payload.publicationId as string) ?? "",
        userId: (payload.userId as string) ?? "",
        returnUrl: (payload.returnUrl as string) ?? "",
      });
    }
    if (payload.kind === "oauth_callback_pub") {
      return this.completeInstall(
        (payload.publicationId as string) ?? "",
        (payload.code as string) ?? "",
        (payload.state as string) ?? "",
      );
    }
    throw new Error(
      `SlackProvider.continueInstall: unknown payload kind '${payload.kind}'`,
    );
  }

  /**
   * Re-mint a formToken for an existing publication shell. Caller (apps/main
   * route) is responsible for ownership check; this method only validates
   * the publication exists and is in a resumable state. No new shell row is
   * INSERTed — the same publication id flows back through the wizard.
   *
   * Returns the same `credentials_form` step shape as `startInstall`.
   */
  async reissueFormToken(input: {
    publicationId: string;
    userId: string;
    returnUrl: string;
  }): Promise<InstallStep> {
    if (!input.publicationId) throw new Error("reissueFormToken: publicationId required");
    if (!input.userId) throw new Error("reissueFormToken: userId required");
    const pub = await this.container.publications.get(input.publicationId);
    if (!pub) throw new Error(`reissueFormToken: unknown publicationId ${input.publicationId}`);
    if (pub.userId !== input.userId) {
      throw new Error("reissueFormToken: publication owner mismatch");
    }
    if (
      pub.status !== "pending_setup" &&
      pub.status !== "credentials_filled" &&
      pub.status !== "awaiting_install"
    ) {
      throw new Error(
        `reissueFormToken: publication is '${pub.status}', cannot resume`,
      );
    }

    const formToken = await this.container.jwt.sign(
      {
        kind: "slack.pub.form",
        publicationId: pub.id,
        userId: input.userId,
        returnUrl: input.returnUrl,
      },
      OAUTH_STATE_TTL_SECONDS,
    );

    return {
      kind: "step",
      step: "credentials_form",
      data: {
        formToken,
        publicationId: pub.id,
        suggestedAppName: pub.persona.name,
        suggestedAvatarUrl: pub.persona.avatarUrl,
        callbackUrl: this.callbackUriForPublication(pub.id),
        webhookUrl: this.webhookForPublication(pub.id),
        manifestLaunchUrl: this.buildManifestLaunchUrlForPublication(
          pub.id,
          pub.persona.name,
        ),
      },
    };
  }

  private async submitCredentials(
    payload: Record<string, unknown>,
  ): Promise<InstallStep> {
    const formToken = (payload.formToken as string) ?? "";
    const clientId = ((payload.clientId as string) ?? "").trim();
    const clientSecret = ((payload.clientSecret as string) ?? "").trim();
    const signingSecret = ((payload.signingSecret as string) ?? "").trim();
    if (!formToken || !clientId || !clientSecret || !signingSecret) {
      throw new Error(
        "submit_credentials: formToken, clientId, clientSecret, signingSecret required",
      );
    }

    const form = await this.container.jwt.verify<{
      kind: string;
      publicationId: string;
      userId: string;
      returnUrl: string;
    }>(formToken);
    if (form.kind !== "slack.pub.form") {
      throw new Error("submit_credentials: invalid formToken kind");
    }
    if (!form.publicationId) {
      throw new Error(
        "submit_credentials: formToken missing publicationId — please restart the publish flow",
      );
    }

    // Verify the publication is in a state where credentials can still be
    // staged. Allow re-paste at pending_setup OR credentials_filled OR
    // awaiting_install (user noticed a typo after starting OAuth — letting
    // them rewind without re-creating the shell is the whole point).
    const pub = await this.container.publications.get(form.publicationId);
    if (!pub) {
      throw new Error(
        "submit_credentials: publication not found — it may have been deleted; restart the publish flow",
      );
    }
    if (pub.status === "live" || pub.status === "unpublished") {
      throw new Error(
        `submit_credentials: publication is '${pub.status}', credentials cannot be re-pasted at this stage`,
      );
    }

    // Encrypt with the same Crypto + label the rest of the integrations
    // subsystem uses. Helper port handles the AES-GCM + label binding.
    const clientSecretCipher = await this.container.crypto.encrypt(clientSecret);
    const signingSecretCipher = await this.container.crypto.encrypt(signingSecret);
    await this.container.publications.setCredentials(pub.id, {
      clientId,
      clientSecretCipher,
      signingSecretCipher,
    });
    // Move to credentials_filled unless already past it. setCredentials
    // already promotes pending_setup → credentials_filled, but we want the
    // wizard's next step to dispatch off the latest known status (e.g. if
    // user already kicked off OAuth and is now re-pasting after a typo,
    // status stays at awaiting_install).
    if (pub.status === "pending_setup") {
      await this.container.publications.updateStatus(pub.id, "awaiting_install");
    } else if (pub.status === "needs_reauth") {
      // Re-credentialing after a token revocation. Keep the bound install
      // alive (the user may want to re-OAuth without losing channels) but
      // signal that fresh OAuth is needed.
      await this.container.publications.updateStatus(pub.id, "awaiting_install");
    }

    const state = await this.container.jwt.sign(
      {
        kind: "slack.oauth.pub",
        publicationId: pub.id,
        userId: form.userId,
        returnUrl: form.returnUrl,
        nonce: this.container.ids.generate(),
      },
      OAUTH_STATE_TTL_SECONDS,
    );
    const url = buildAuthorizeUrl({
      clientId,
      redirectUri: this.callbackUriForPublication(pub.id),
      botScopes: this.config.botScopes ?? DEFAULT_SLACK_BOT_SCOPES,
      userScopes: this.config.userScopes ?? DEFAULT_SLACK_USER_SCOPES,
      state,
    });

    return {
      kind: "step",
      step: "install_link",
      data: {
        url,
        publicationId: pub.id,
        callbackUrl: this.callbackUriForPublication(pub.id),
        // Webhook URL is keyed on pub_id (NOT slack_app_id), known from
        // shell-create time, so the manifest baked at api.slack.com is
        // already correct. No "after install completes, paste the real
        // URL" step.
        webhookUrl: this.webhookForPublication(pub.id),
      },
    };
  }

  private async completeInstall(
    publicationId: string,
    code: string,
    stateToken: string,
  ): Promise<InstallComplete> {
    if (!publicationId) throw new Error("Slack OAuth callback: missing publicationId");
    if (!code) throw new Error("Slack OAuth callback: missing code");
    if (!stateToken) throw new Error("Slack OAuth callback: missing state");

    const state = await this.container.jwt.verify<{
      kind: string;
      publicationId: string;
      userId: string;
      returnUrl: string;
    }>(stateToken);
    if (state.kind !== "slack.oauth.pub") {
      throw new Error("Slack OAuth callback: invalid state kind");
    }
    if (state.publicationId !== publicationId) {
      throw new Error("Slack OAuth callback: publicationId mismatch");
    }

    const pub = await this.container.publications.get(publicationId);
    if (!pub) throw new Error("Slack OAuth callback: unknown publicationId");

    // Idempotency: if this publication is already live (Slack retried or
    // the user double-clicked), short-circuit. We DO NOT re-run token
    // exchange — the Slack code is one-shot and would 400 anyway.
    if (pub.status === "live" && pub.installationId && pub.installationId !== "") {
      return { kind: "complete", publicationId: pub.id };
    }

    const credState = await this.container.publications.getCredentialState(publicationId);
    if (!credState || !credState.hasClientSecret || !credState.clientId) {
      throw new Error(
        "Slack OAuth callback: publication has no client credentials — re-paste credentials before installing",
      );
    }
    const clientId = credState.clientId;
    const clientSecret = await this.container.publications.getClientSecret(publicationId);
    if (!clientSecret) {
      throw new Error("Slack OAuth callback: missing client secret");
    }

    const tokenReq = buildTokenExchangeBody({
      code,
      redirectUri: this.callbackUriForPublication(publicationId),
      clientId,
      clientSecret,
    });
    const tokenRes = await this.container.http.fetch({
      method: "POST",
      url: tokenReq.url,
      headers: { "content-type": tokenReq.contentType },
      body: tokenReq.body,
    });
    if (tokenRes.status < 200 || tokenRes.status >= 300) {
      throw new Error(
        `Slack OAuth token exchange failed: HTTP ${tokenRes.status} ${tokenRes.body.slice(0, 200)}`,
      );
    }
    const token = parseTokenResponse(tokenRes.body);

    // Best-effort sanity check; non-fatal if Slack is throttling our test.
    try {
      await this.api.authTest(token.access_token);
    } catch {
      // Continue — install otherwise succeeded; the bot token will work
      // when next exercised by an event.
    }

    // Materialize the slack_apps row keyed on Slack's app_id. The signing
    // secret + client secret are still on the publication row — slack_apps
    // is now mostly an audit / app→tenant link table; the webhook handler
    // reads creds straight from the publication row.
    const tenantId = pub.tenantId;
    const app = await this.container.apps.insert({
      id: token.app_id,
      tenantId,
      publicationId: pub.id,
      clientId,
      // Mirror the credentials onto the App row too, so legacy webhook
      // paths that read via apps.getWebhookSecret still work. This is a
      // double-write for transitional safety; future PR can drop the App
      // table once the publication-first path is the only reader.
      clientSecret,
      webhookSecret: (await this.container.publications.getSigningSecret(publicationId)) ?? "",
    });

    const installation = await this.container.installations.insert({
      tenantId,
      userId: state.userId,
      providerId: PROVIDER_ID,
      workspaceId: token.team.id,
      workspaceName: token.team.name,
      installKind: "dedicated",
      appId: app.id,
      // accessToken slot holds the bot xoxb- token — same field as Linear.
      accessToken: token.access_token,
      refreshToken: null,
      // Encode both bot + user scopes in one JSON blob so the column type
      // doesn't need to change. Repo serializes as JSON.
      scopes: [
        ...token.scope.split(/[\s,]+/).filter(Boolean).map((s) => `bot:${s}`),
        ...token.authed_user.scope.split(/[\s,]+/).filter(Boolean).map((s) => `user:${s}`),
      ],
      botUserId: token.bot_user_id,
    });

    // Stash the user xoxp- token on the install row (Slack-only field).
    await this.container.installations.setUserToken(
      installation.id,
      token.authed_user.access_token,
    );

    // Vault for mcp.slack.com — uses the USER xoxp- token (mcp.slack.com
    // rejects bot tokens; user token inherits the installer's permissions).
    const { vaultId: userVaultId } = await this.container.vaults.createCredentialForUser({
      userId: state.userId,
      vaultName: `Slack · ${token.team.name} · ${pub.persona.name} (user)`,
      displayName: `Slack MCP user token (${pub.persona.name})`,
      mcpServerUrl: SLACK_MCP_URL,
      bearerToken: token.authed_user.access_token,
    });
    await this.container.installations.setVaultId(installation.id, userVaultId);

    // Vault for direct slack.com/api calls (bot xoxb-). Used if the agent
    // calls Web API methods directly without going through MCP.
    const { vaultId: botVaultId } = await this.container.vaults.createCredentialForUser({
      userId: state.userId,
      vaultName: `Slack · ${token.team.name} · ${pub.persona.name} (bot)`,
      displayName: `Slack bot token (${pub.persona.name})`,
      mcpServerUrl: SLACK_API_URL,
      bearerToken: token.access_token,
    });
    await this.container.installations.setBotVaultId(installation.id, botVaultId);

    // Bind the installation + slack_app_id back onto the publication row,
    // flipping status='live'. Done last so an early failure leaves the row
    // resumable (status stays at awaiting_install / credentials_filled).
    await this.container.publications.bindInstallation({
      publicationId: pub.id,
      installationId: installation.id,
      slackAppId: token.app_id,
    });

    // Probe mcp.slack.com with the user xoxp- token to detect whether the
    // App's "Model Context Protocol" toggle (Agents & AI Apps page) is on.
    // The toggle defaults OFF for new Apps and Slack provides no API to
    // flip it — the only way to know is to actually call the MCP server.
    // We tolerate any failure: this is observability, not a gate. UI uses
    // the probe to either green-check the install or surface a precise
    // "still off, flip it here" warning with deeplink.
    const probe = await this.probeMcpEnabled(token.authed_user.access_token, token.app_id);

    return { kind: "complete", publicationId: pub.id, capabilityProbe: probe };
  }

  /**
   * One-shot capability probe for Slack's MCP server. POSTs tools/list
   * with the user xoxp- token; classifies the response:
   *
   *   200 → toggle is on, model has access to typed mcp__slack__* tools
   *   400 with "App is not enabled for Slack MCP server access" → toggle off
   *   anything else → unknown (network blip, vendor outage) — best to stay
   *     silent rather than alarm the user with a stale-toggle warning
   *
   * Bounded to ~5s so a slow upstream doesn't stall the install response.
   * Uses globalThis.fetch directly: the integration HttpClient abstraction
   * is for testable provider-API calls; this is a fire-and-forget probe
   * whose result is descriptive only — replace with a stub in tests.
   */
  private async probeMcpEnabled(
    userToken: string,
    slackAppId: string,
  ): Promise<{ kind: "slack_mcp"; ok: boolean; message?: string; fixUrl?: string }> {
    const fixUrl = `https://api.slack.com/apps/${slackAppId}/app-assistant`;
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 5000);
      let res: Response;
      try {
        res = await fetch(SLACK_MCP_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${userToken}`,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
          signal: ac.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (res.status >= 200 && res.status < 300) {
        return { kind: "slack_mcp", ok: true };
      }
      const body = await res.text().catch(() => "");
      if (res.status === 400 && /not enabled for Slack MCP server access/i.test(body)) {
        return {
          kind: "slack_mcp",
          ok: false,
          message:
            "Slack MCP server access is OFF on this App. Open the App's Agents & AI Apps page and toggle Model Context Protocol on.",
          fixUrl,
        };
      }
      return {
        kind: "slack_mcp",
        ok: false,
        message: `Slack MCP probe returned HTTP ${res.status}; tool calls may not work yet.`,
        fixUrl,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        kind: "slack_mcp",
        ok: false,
        message: `Slack MCP probe failed (${msg.slice(0, 80)}); verify the toggle manually.`,
        fixUrl,
      };
    }
  }

  /** 7-day re-signed formToken — gives an admin a public install URL. */
  private async createHandoffLink(
    payload: Record<string, unknown>,
  ): Promise<InstallStep> {
    const formToken = (payload.formToken as string) ?? "";
    if (!formToken) throw new Error("handoff_link: formToken required");
    const form = await this.container.jwt.verify<{
      kind: string;
      publicationId: string;
      userId: string;
      returnUrl: string;
    }>(formToken);
    if (form.kind !== "slack.pub.form") {
      throw new Error("handoff_link: invalid formToken kind");
    }
    const handoffToken = await this.container.jwt.sign(
      { ...form, kind: "slack.pub.form", handoff: true },
      7 * 24 * 60 * 60,
    );
    return {
      kind: "step",
      step: "install_link",
      data: {
        url: `${this.config.gatewayOrigin}/slack-setup/${handoffToken}`,
        expiresInDays: 7,
      },
    };
  }

  // ─── Webhook ─────────────────────────────────────────────────────────

  async handleWebhook(req: WebhookRequest): Promise<WebhookOutcome> {
    // App lookup happens before signature verify so we can verify even on
    // url_verification (the very first webhook a new URL receives).
    //
    // Resolve publication + signing secret. Two webhook URL shapes:
    //
    //   1. /slack/webhook/pub/:pubId  (publication-first, post-2026-05-19)
    //      Gateway sets x-internal-pub-id → look up the publication by id,
    //      derive its slack_app_id from the row.
    //   2. /slack/webhook/app/:appId  (legacy)
    //      Gateway sets x-internal-app-id → look up the publication via
    //      findBySlackAppId, fall back to slack_apps for transitional safety.
    let pubId: string | null = null;
    let signingSecret: string | null = null;
    let appId: string | null = null;
    const headerPubId = req.headers["x-internal-pub-id"];
    if (typeof headerPubId === "string" && headerPubId.length > 0) {
      const pub = await this.container.publications.get(headerPubId);
      if (!pub) {
        return { handled: false, reason: "unknown_publication_id" };
      }
      // pub-keyed delivery: skip findBySlackAppId (we know the row).
      pubId = pub.id;
      signingSecret = await this.container.publications.getSigningSecret(pub.id);
      const credState = await this.container.publications.getCredentialState(pub.id);
      appId = credState?.slackAppId ?? null;
      if (!appId) {
        return { handled: false, reason: "publication_not_yet_installed" };
      }
    } else {
      appId = this.appIdFromHeaders(req);
      if (!appId) {
        return { handled: false, reason: "missing_app_id" };
      }
      const pubByApp = await this.container.publications.findBySlackAppId(appId);
      if (pubByApp) {
        pubId = pubByApp.id;
        signingSecret = await this.container.publications.getSigningSecret(pubByApp.id);
      } else {
        const appRow = await this.container.apps.get(appId);
        if (!appRow) {
          return { handled: false, reason: "unknown_app_id" };
        }
        pubId = appRow.publicationId;
        signingSecret = await this.container.apps.getWebhookSecret(appId);
      }
    }
    if (!signingSecret) {
      return { handled: false, reason: "missing_signing_secret" };
    }

    // Signature + timestamp verification.
    const sigHeader = req.headers["x-slack-signature"];
    const tsHeader = req.headers["x-slack-request-timestamp"];
    const parsed = parseSignatureHeader(sigHeader);
    if (!parsed || parsed.version !== "v0") {
      return { handled: false, reason: "invalid_signature_header" };
    }
    if (!tsHeader || !isTimestampFresh(tsHeader, this.container.clock.nowMs())) {
      return { handled: false, reason: "stale_timestamp" };
    }
    const baseString = buildBaseString(tsHeader, req.rawBody);
    const ok = await this.container.hmac.verify(signingSecret, baseString, parsed.hex);
    if (!ok) return { handled: false, reason: "invalid_signature" };

    // Parse envelope.
    let raw: RawSlackEnvelope;
    try {
      raw = JSON.parse(req.rawBody) as RawSlackEnvelope;
    } catch {
      return { handled: false, reason: "invalid_json" };
    }

    // url_verification — echo the challenge. No event_id, skip dedup.
    if (raw.type === "url_verification") {
      const challenge = (raw as RawUrlVerification).challenge ?? "";
      return {
        handled: true,
        reason: "url_verification",
        challengeResponse: challenge,
      };
    }

    // app_rate_limited — informational, log + 200, skip dedup.
    if (raw.type === "app_rate_limited") {
      return { handled: false, reason: "app_rate_limited" };
    }

    // Route only event_callback envelopes from here.
    if (raw.type !== "event_callback") {
      return { handled: false, reason: `unknown_envelope_${raw.type}` };
    }
    const env = raw as RawEventCallback;

    // Find the installation behind this app.
    if (!pubId) {
      // App registered but install hasn't completed — drop.
      return { handled: false, reason: "no_publication_yet" };
    }
    const pub = await this.container.publications.get(pubId);
    if (!pub) {
      return { handled: false, reason: "publication_not_found" };
    }
    const installation = await this.container.installations.get(pub.installationId);
    if (!installation || installation.revokedAt !== null) {
      return { handled: false, reason: "installation_not_found_or_revoked" };
    }

    // Idempotency on event_id.
    const fresh = await this.container.webhookEvents.recordIfNew(
      env.event_id,
      installation.tenantId,
      installation.id,
      env.event?.type ?? "unknown",
      this.container.clock.nowMs(),
    );
    if (!fresh) return { handled: false, reason: "duplicate_delivery" };

    const event = parseWebhook(raw);
    if (!event) {
      await this.container.webhookEvents.attachError(env.event_id, "unparseable");
      return { handled: false, reason: "unparseable" };
    }

    // Revocation events — flip the installation, close all channel-scope
    // sessions for the publication so dangling scheduleWakeups don't burn
    // turns 401-ing against a now-revoked token. No agent dispatch needed
    // (the wakeups themselves will cascade through and discover their
    // sessions are completed).
    if (event.kind === "tokens_revoked" || event.kind === "app_uninstalled") {
      await this.container.installations.markRevoked(installation.id, this.container.clock.nowMs());
      await this.container.sessionScopes.closeAllForPublication(pub.id);
      await this.container.webhookEvents.attachPublication(env.event_id, pub.id);
      return { handled: true, reason: event.kind, publicationId: pub.id, tenantId: installation.tenantId };
    }

    // Skip bot's own messages to avoid loops.
    if (event.isBotMessage) {
      await this.container.webhookEvents.attachError(env.event_id, "skipped_bot_message");
      return { handled: false, reason: "bot_message" };
    }

    // Decide whether this event should reach the agent. Slack delivers a
    // mix of signals; we route them according to user intent rather than
    // raw event kind. See classifyDispatch() for the rules.
    const decision = await this.classifyDispatch(pub, event, installation.botUserId);
    if (decision.kind === "drop") {
      await this.container.webhookEvents.attachError(env.event_id, decision.reason);
      return { handled: false, reason: decision.reason };
    }

    if (pub.status !== "live") {
      await this.container.webhookEvents.attachError(env.event_id, "publication_not_live");
      return { handled: false, reason: "publication_not_live" };
    }

    // metadata_only — channel_rename: update the cached channel_name on the
    // scope row without waking the agent. Agent reads it from session
    // metadata on its next natural wake (scan / mention / etc.).
    if (decision.kind === "metadata_only") {
      if (event.channelId) {
        const scopeKey = `channel:${event.channelId}`;
        await this.container.sessionScopes.updateChannelName(
          pub.id,
          scopeKey,
          decision.channelName,
        );
      }
      await this.container.webhookEvents.attachPublication(env.event_id, pub.id);
      return {
        handled: true,
        reason: "metadata_only",
        publicationId: pub.id,
        tenantId: installation.tenantId,
      };
    }

    await this.container.webhookEvents.attachPublication(env.event_id, pub.id);

    // Defer the actual session create/resume to satisfy Slack's 3-sec budget.
    // The route handler attaches this to executionCtx.waitUntil(...).
    const deferred = async () => {
      try {
        const sessionId = await this.dispatchEvent(pub, installation.id, event, decision.intent);
        if (sessionId) {
          await this.container.webhookEvents.attachSession(env.event_id, sessionId);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.container.webhookEvents.attachError(env.event_id, msg.slice(0, 200));
      }
    };

    return {
      handled: true,
      reason: event.kind ?? "dispatched",
      publicationId: pub.id,
      tenantId: installation.tenantId,
      deferredWork: deferred,
    };
  }

  private async dispatchEvent(
    publication: Publication,
    installationId: string,
    event: NormalizedSlackEvent,
    intent?: DispatchIntent,
  ): Promise<string | null> {
    // Both vaults — user token (xoxp-) for mcp.slack.com + bot token (xoxb-)
    // for direct slack.com/api calls.
    const installation = await this.container.installations.get(installationId);
    const vaultIds: string[] = [];
    if (installation?.vaultId) vaultIds.push(installation.vaultId);
    // The bot vault id lives on the installation row but isn't on the base
    // Installation type. Read it via a side query.
    const botVaultId = await this.getBotVaultIdSafe(installationId);
    if (botVaultId) vaultIds.push(botVaultId);

    const mcpServers = [{ name: "slack", url: SLACK_MCP_URL }];

    // ─── per_channel granularity ──────────────────────────────────────
    // One session per (publication, channel_id). All channel events route
    // to it via intent. Top-level scan-arms throttle on a D1 watermark.
    if (publication.sessionGranularity === "per_channel" && event.channelId) {
      const scopeKey = scopeKeyFor(event, "per_channel")!;
      const existing = await this.container.sessionScopes.getByScope(
        publication.id,
        scopeKey,
      );

      // Two-phase claim window: a winner has just inserted a pending
      // placeholder and is currently calling sessions.create. The session
      // id we see is `_pending_<uuid>`, NOT a real session. If we let any
      // intent handler below run, two bad things happen:
      //   1. updateStatus('active') would corrupt the row — the next
      //      fulfillPending UPDATE WHERE status='pending' would match 0
      //      rows, leaving session_id=`_pending_<uuid>` permanently active
      //      and every subsequent event 404'ing in sessions.resume.
      //   2. resume(existing.sessionId) would 404 immediately.
      // Drop instead — only when the claim is still fresh. A stale claim
      // (>60s old, winner crashed before fulfilling) should fall through
      // to createChannelSession's reassignIfInactive recovery path.
      const PENDING_FRESH_MS = 60_000;
      if (
        existing &&
        existing.status === "pending" &&
        this.container.clock.nowMs() - existing.createdAt < PENDING_FRESH_MS
      ) {
        await this.container.webhookEvents.attachError(
          event.deliveryId,
          "pending_winner_in_progress",
        );
        return null;
      }

      // close_session (bot kicked / channel archived) — flip status, clear
      // the debounce watermark, send a final session_closed signal so the
      // agent can cancel its own scheduleWakeups before going dormant.
      if (intent === "close_session") {
        if (!existing) return null;
        await this.container.sessionScopes.updateStatus(
          publication.id,
          scopeKey,
          "completed",
        );
        await this.container.sessionScopes.clearPendingScan(publication.id, scopeKey);
        if (existing.status === "active") {
          const sessionEvent = this.buildSessionEvent(
            event,
            "session_closed",
            { channelName: existing.channelName ?? null },
          );
          await this.container.sessions.resume(
            publication.userId,
            existing.sessionId,
            sessionEvent,
          );
        }
        return existing.sessionId;
      }

      // scan_arm — debounce check on the scope row. If already armed within
      // window, drop silently. If armed fresh, resume with the signal.
      if (intent === "scan_arm") {
        // Lazy-create the scope row if missing — bot may have been added to
        // the channel before per_channel rolled out, so member_joined_channel
        // wasn't received. First top-level message bootstraps the session.
        if (!existing) {
          const newId = await this.createChannelSession(
            publication,
            event,
            scopeKey,
            "joined_channel",
            vaultIds,
            mcpServers,
          );
          // Arm immediately — the bootstrap turn establishes context, the
          // agent should already start its first scheduleWakeup loop.
          await this.container.sessionScopes.armPendingScan(
            publication.id,
            scopeKey,
            this.container.clock.nowMs() + PER_CHANNEL_DEBOUNCE_WINDOW_MS,
            this.container.clock.nowMs(),
          );
          return newId;
        }
        if (existing.status !== "active") return null;
        const now = this.container.clock.nowMs();
        const armResult = await this.container.sessionScopes.armPendingScan(
          publication.id,
          scopeKey,
          now + PER_CHANNEL_DEBOUNCE_WINDOW_MS,
          now,
        );
        if (!armResult.armed) {
          // Already armed; throttle silently. Surface as a soft drop reason
          // on the webhook event so operators can see throttle hits in logs.
          await this.container.webhookEvents.attachError(
            event.deliveryId,
            "throttled_pending_scan",
          );
          return existing.sessionId;
        }
        const sessionEvent = this.buildSessionEvent(event, "channel_scan_armed", {
          debounceMs: PER_CHANNEL_DEBOUNCE_WINDOW_MS,
          lastScanAt: existing.lastScanAt ?? null,
          channelName: existing.channelName ?? null,
        });
        await this.container.sessions.resume(
          publication.userId,
          existing.sessionId,
          sessionEvent,
        );
        return existing.sessionId;
      }

      // direct_invocation / reaction_on_bot — both require resuming a live
      // channel session. Lazy-create if missing (bot may pre-date per_channel
      // rollout in this channel).
      if (intent === "direct_invocation" || intent === "reaction_on_bot") {
        const signalKind =
          intent === "direct_invocation" ? "direct_invocation" : "reaction_on_bot_message";
        const sessionEvent = this.buildSessionEvent(event, signalKind, {
          channelName: existing?.channelName ?? null,
        });
        if (existing && existing.status === "active") {
          await this.container.sessions.resume(
            publication.userId,
            existing.sessionId,
            sessionEvent,
          );
          return existing.sessionId;
        }
        // Lazy bootstrap on a missing or inactive scope. Reuse joined_channel
        // signal as the initial event — agent gets onboarding context, then
        // sees the actual trigger as a follow-up resume.
        const newId = await this.createChannelSession(
          publication,
          event,
          scopeKey,
          "joined_channel",
          vaultIds,
          mcpServers,
        );
        // Follow-up resume with the actual trigger signal so the agent sees
        // both: "you're new here" + "and X just happened".
        await this.container.sessions.resume(publication.userId, newId, sessionEvent);
        return newId;
      }

      // joined_channel — bot was added (or re-bootstrapped via reopen).
      // Reopen path also lands here: existing row may be `completed` and we
      // flip it back to `active`.
      if (intent === "joined_channel" || intent === "reopen_session") {
        if (existing) {
          if (existing.status !== "active") {
            await this.container.sessionScopes.updateStatus(
              publication.id,
              scopeKey,
              "active",
            );
          }
          await this.container.sessionScopes.clearPendingScan(
            publication.id,
            scopeKey,
          );
          const sessionEvent = this.buildSessionEvent(event, "joined_channel", {
            channelName: existing.channelName ?? null,
            reopened: intent === "reopen_session",
          });
          await this.container.sessions.resume(
            publication.userId,
            existing.sessionId,
            sessionEvent,
          );
          return existing.sessionId;
        }
        return await this.createChannelSession(
          publication,
          event,
          scopeKey,
          "joined_channel",
          vaultIds,
          mcpServers,
        );
      }

      // Per_channel intent fell through — defensive: treat as direct
      // invocation. Should never happen if classifyDispatch is exhaustive.
      const sessionEvent = this.buildSessionEvent(event, "direct_invocation", {
        channelName: existing?.channelName ?? null,
      });
      if (existing && existing.status === "active") {
        await this.container.sessions.resume(
          publication.userId,
          existing.sessionId,
          sessionEvent,
        );
        return existing.sessionId;
      }
      return await this.createChannelSession(
        publication,
        event,
        scopeKey,
        "direct_invocation",
        vaultIds,
        mcpServers,
      );
    }

    // ─── per_thread granularity (legacy) ──────────────────────────────
    const sessionEvent = this.buildSessionEvent(event, null, {});

    const perThreadKey = scopeKeyFor(event, publication.sessionGranularity);
    if (publication.sessionGranularity === "per_thread" && perThreadKey) {
      const existing = await this.container.sessionScopes.getByScope(
        publication.id,
        perThreadKey,
      );
      if (existing && existing.status === "active") {
        await this.container.sessions.resume(
          publication.userId,
          existing.sessionId,
          sessionEvent,
        );
        return existing.sessionId;
      }
      const created = await this.container.sessions.create({
        userId: publication.userId,
        agentId: publication.agentId,
        environmentId: publication.environmentId,
        vaultIds,
        mcpServers,
        metadata: {
          slack: {
            workspaceId: event.workspaceId,
            channelId: event.channelId,
            threadTs: event.threadTs,
            publicationId: publication.id,
          },
        },
        initialEvent: sessionEvent,
      });
      const inserted = await this.container.sessionScopes.insert({
        tenantId: publication.tenantId,
        publicationId: publication.id,
        scopeKey: perThreadKey,
        sessionId: created.sessionId,
        status: "active",
        createdAt: this.container.clock.nowMs(),
      });
      if (inserted) return created.sessionId;
      // Lost a race with a concurrent dispatcher that already bound this
      // scope to a session. Re-read, route THIS event to the winner via
      // resume, and abandon the throwaway session we just spun up. (Slack
      // sandwich case: app_mention + message arrive almost-concurrently
      // for the same @-bot message — classifyDispatch already drops the
      // duplicate `message`, but two genuinely distinct events on the
      // same scope can still race.)
      const winner = await this.container.sessionScopes.getByScope(
        publication.id,
        perThreadKey,
      );
      if (winner && winner.status === "active") {
        await this.container.sessions.resume(publication.userId, winner.sessionId, sessionEvent);
        return winner.sessionId;
      }
      // Edge: row exists but inactive (rerouted / completed). Fall through to
      // returning our session id; the just-created session will run for this
      // event and the scope row stays bound to whoever wrote it.
      return created.sessionId;
    }

    // per_event (or per_thread without a scopeKey): always fresh session.
    const created = await this.container.sessions.create({
      userId: publication.userId,
      agentId: publication.agentId,
      environmentId: publication.environmentId,
      vaultIds,
      mcpServers,
      metadata: {
        slack: {
          workspaceId: event.workspaceId,
          channelId: event.channelId,
          threadTs: event.threadTs,
          publicationId: publication.id,
        },
      },
      initialEvent: sessionEvent,
    });
    return created.sessionId;
  }

  /**
   * Create a fresh per_channel session and bind the scope row.
   *
   * Uses a two-phase claim to keep `sessions.create` from running on the
   * loser of a concurrent webhook race:
   *
   *   1. claimPending(): INSERT a row with status='pending' and a
   *      placeholder session id. Atomic UNIQUE — only one dispatcher wins.
   *   2a. Winner: call sessions.create, then fulfillPending() to swap the
   *       placeholder for the real id + flip to 'active'. If sessions.create
   *       throws, releasePending() so a retry can re-claim.
   *   2b. Loser: poll getByScope until the winner fulfills (status='active',
   *       resume that session) or the pending claim goes stale (fall through
   *       to reactivation path, same as the existing non-active case).
   *
   * Reactivation paths (existing non-active row or stale pending) still
   * call sessions.create + reassignIfInactive — same as before the
   * two-phase change.
   */
  private async createChannelSession(
    publication: Publication,
    event: NormalizedSlackEvent,
    scopeKey: string,
    signalKind: SignalKind,
    vaultIds: string[],
    mcpServers: { name: string; url: string }[],
  ): Promise<string> {
    const sessionEvent = this.buildSessionEvent(event, signalKind, {});
    const now = this.container.clock.nowMs();

    // Phase 1: race-gate via pending claim.
    const placeholderSessionId = `_pending_${this.container.ids.generate()}`;
    const claimed = await this.container.sessionScopes.claimPending({
      tenantId: publication.tenantId,
      publicationId: publication.id,
      scopeKey,
      placeholderSessionId,
      now,
    });

    if (claimed) {
      // Phase 2a: we won. Create the session and fulfill the claim.
      let created: { sessionId: string };
      try {
        created = await this.container.sessions.create({
          userId: publication.userId,
          agentId: publication.agentId,
          environmentId: publication.environmentId,
          vaultIds,
          mcpServers,
          metadata: {
            slack: {
              workspaceId: event.workspaceId,
              channelId: event.channelId,
              granularity: "per_channel",
              publicationId: publication.id,
            },
          },
          initialEvent: sessionEvent,
          additionalSystemPrompt: SLACK_SIGNAL_PROTOCOL_PROMPT,
        });
      } catch (err) {
        // sessions.create threw before we wrote the binding. Release the
        // pending row so a retry doesn't see a stuck claim. Re-throw so
        // the caller (drainEventQueue) handles the failure normally.
        await this.container.sessionScopes
          .releasePending(publication.id, scopeKey)
          .catch(() => undefined);
        throw err;
      }
      const fulfilled = await this.container.sessionScopes.fulfillPending(
        publication.id,
        scopeKey,
        created.sessionId,
      );
      if (fulfilled) return created.sessionId;
      // TOCTOU: row got reclaimed (stale-takeover) between our claim and
      // fulfill. Extremely rare — only happens if our own claim aged out,
      // which means sessions.create took >PENDING_STALE_AFTER_MS. Re-read
      // the winner and route to it; our just-created session is orphaned.
      const winner = await this.container.sessionScopes.getByScope(publication.id, scopeKey);
      if (winner && winner.status === "active") {
        await this.container.sessions.resume(
          publication.userId,
          winner.sessionId,
          sessionEvent,
        );
        return winner.sessionId;
      }
      return created.sessionId;
    }

    // Phase 2b: we lost the claim. Inspect existing row.
    const existing = await this.container.sessionScopes.getByScope(publication.id, scopeKey);

    if (existing && existing.status === "pending") {
      // Short-circuit: if the pending claim is already stale, skip polling
      // and fall through to the reactivation path immediately. A stale
      // claim means the winner crashed before fulfilling; no point waiting.
      const pendingAge = this.container.clock.nowMs() - existing.createdAt;
      const STALE_THRESHOLD_MS = 60_000;
      if (pendingAge < STALE_THRESHOLD_MS) {
        // Live winner mid-create. Poll briefly for fulfillment.
        const POLL_INTERVAL_MS = 100;
        const POLL_MAX_MS = 5_000;
        const deadline = Date.now() + POLL_MAX_MS;
        while (Date.now() < deadline) {
          await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
          const fresh = await this.container.sessionScopes.getByScope(publication.id, scopeKey);
          if (!fresh) break; // released — fall through to reactivation
          if (fresh.status === "pending") continue;
          if (fresh.status === "active") {
            await this.container.sessions.resume(
              publication.userId,
              fresh.sessionId,
              sessionEvent,
            );
            return fresh.sessionId;
          }
          break; // non-active terminal — fall through to reactivation
        }
        // Poll timed out OR winner released/failed. Fall through.
      }
    } else if (existing && existing.status === "active") {
      await this.container.sessions.resume(
        publication.userId,
        existing.sessionId,
        sessionEvent,
      );
      return existing.sessionId;
    }

    // Reactivation: existing row is non-active (completed/escalated/etc.),
    // a stale pending claim, or got released after poll timeout. Create
    // a session and atomically reassign the row.
    const created = await this.container.sessions.create({
      userId: publication.userId,
      agentId: publication.agentId,
      environmentId: publication.environmentId,
      vaultIds,
      mcpServers,
      metadata: {
        slack: {
          workspaceId: event.workspaceId,
          channelId: event.channelId,
          granularity: "per_channel",
          publicationId: publication.id,
        },
      },
      initialEvent: sessionEvent,
      additionalSystemPrompt: SLACK_SIGNAL_PROTOCOL_PROMPT,
    });
    const reassigned = await this.container.sessionScopes.reassignIfInactive(
      publication.id,
      scopeKey,
      created.sessionId,
      this.container.clock.nowMs(),
    );
    if (reassigned) return created.sessionId;
    // TOCTOU: someone activated the row between our read and reassign.
    // Resume their session; our newly-created one is orphaned.
    const final = await this.container.sessionScopes.getByScope(publication.id, scopeKey);
    if (final && final.status === "active") {
      await this.container.sessions.resume(
        publication.userId,
        final.sessionId,
        sessionEvent,
      );
      return final.sessionId;
    }
    return created.sessionId;
  }

  /**
   * Build the SessionEventInput for a Slack event, with signal-aware text and
   * metadata. signalKind === null means legacy per_thread/per_event rendering
   * (no signal framing); pass a SignalKind for per_channel paths.
   */
  private buildSessionEvent(
    event: NormalizedSlackEvent,
    signalKind: SignalKind | null,
    extras: SignalExtras,
  ): {
    type: "user.message";
    content: { type: "text"; text: string }[];
    metadata: { slack: Record<string, unknown> };
  } {
    return {
      type: "user.message",
      content: [
        { type: "text", text: this.renderEventAsUserMessage(event, signalKind, extras) },
      ],
      metadata: {
        slack: {
          workspaceId: event.workspaceId,
          channelId: event.channelId,
          threadTs: event.threadTs,
          eventTs: event.eventTs,
          userId: event.userId,
          eventKind: event.kind,
          deliveryId: event.deliveryId,
          ...(signalKind ? { signalKind } : {}),
          ...(extras.channelName ? { channelName: extras.channelName } : {}),
          ...(event.reactionName ? { reactionName: event.reactionName } : {}),
          ...(event.itemTs ? { itemTs: event.itemTs } : {}),
          ...(event.itemUserId ? { itemUserId: event.itemUserId } : {}),
        },
      },
    };
  }

  /**
   * Render a Slack event as the user-facing text the agent will see. The
   * `signalKind` parameter is the load-bearing piece for per_channel
   * granularity — the agent's behavior on each kind is shaped by what we
   * write here.
   *
   * Signals are wrapped in `<oma_signal>` XML to make explicit they are
   * out-of-band system events from the integration runtime, NOT user-typed
   * content. Agent must NEVER quote, paraphrase, or reference the signal
   * framing in any reply that goes back to Slack — leaking internal
   * vocabulary (signal names, "scan window", scheduleWakeup mechanics) to
   * end users breaks the abstraction.
   */
  private renderEventAsUserMessage(
    event: NormalizedSlackEvent,
    signalKind: SignalKind | null,
    extras: SignalExtras,
  ): string {
    const channelLabel = extras.channelName
      ? `#${extras.channelName}${event.channelId ? ` (${event.channelId})` : ""}`
      : event.channelId ?? "<unknown channel>";

    // Per-channel signals are intentionally minimal: only the per-event
    // variable bits live here. The stable protocol prose (signal catalog,
    // reply rules, mandatory action lists, "treat as telemetry" directive)
    // lives in SLACK_SIGNAL_PROTOCOL_PROMPT, injected once into
    // agent_snapshot.system at session.create — see provider.ts top.
    //
    // Tag schema is preserved (kind only, plus channel/thread_ts on
    // direct_invocation) — the agent runtime parses those attrs.

    if (signalKind === "joined_channel") {
      const verb = extras.reopened ? "added back to" : "added to";
      return [
        `<oma_signal kind="joined_channel">`,
        `You (the bot) were ${verb} ${channelLabel}.`,
        `</oma_signal>`,
      ].join("\n");
    }

    if (signalKind === "channel_scan_armed") {
      const debounceSec = Math.round((extras.debounceMs ?? PER_CHANNEL_DEBOUNCE_WINDOW_MS) / 1000);
      const oldest = extras.lastScanAt
        ? `${(extras.lastScanAt / 1000).toFixed(6)}`
        : `<channel-session-creation-time>`;
      // Body keeps debounce_seconds + oldest as inline data the protocol
      // prompt's scheduleWakeup instructions reference. Channel id is
      // already on the signal envelope via channelLabel.
      return [
        `<oma_signal kind="channel_scan_armed">`,
        `New top-level activity in ${channelLabel}. debounce_seconds=${debounceSec} oldest=${oldest}`,
        `</oma_signal>`,
      ].join("\n");
    }

    if (signalKind === "direct_invocation") {
      const inThread = event.threadTs && event.threadTs !== event.eventTs ? ` in thread ${event.threadTs}` : "";
      const who = event.userId ? `<@${event.userId}>` : "Someone";
      const text = event.text ?? "";
      return [
        `<oma_signal kind="direct_invocation" channel="${event.channelId ?? ""}" thread_ts="${event.threadTs ?? ""}">`,
        `${who} addressed you directly in ${channelLabel}${inThread}.`,
        `User message:`,
        text,
        `</oma_signal>`,
      ].join("\n");
    }

    if (signalKind === "reaction_on_bot_message") {
      const removed = event.kind === "reaction_removed";
      const verb = removed ? "removed" : "added";
      const actor = event.userId ? `<@${event.userId}>` : "Someone";
      return [
        `<oma_signal kind="reaction_on_bot_message">`,
        `${actor} ${verb} :${event.reactionName ?? "?"}: on a message (ts=${event.itemTs ?? "?"}) in ${channelLabel}.`,
        `</oma_signal>`,
      ].join("\n");
    }

    if (signalKind === "session_closed") {
      const reason =
        event.kind === "member_left_channel" ? "removed_from_channel" : "channel_archived";
      return [
        `<oma_signal kind="session_closed">`,
        `Final wakeup for ${channelLabel}: ${reason}.`,
        `</oma_signal>`,
      ].join("\n");
    }

    // Legacy / per_thread / per_event rendering — same as before.
    const lines: string[] = [];
    const where = event.channelId
      ? `${event.channelId}${event.threadTs ? ` (thread ${event.threadTs})` : ""}`
      : "<unknown channel>";
    lines.push(`Slack ${event.kind ?? "event"} in ${where}`);
    if (event.userId) lines.push(`From: ${event.userId}`);
    if (event.text) lines.push(`\n${event.text}`);
    return lines.join("\n");
  }

  /**
   * Classify whether an inbound event should reach the agent. Slack delivers
   * a noisy stream of overlapping signals; this is the single place that
   * decides "drop" vs "dispatch" vs "metadata_only" so that handleWebhook +
   * dispatchEvent stay narrow.
   *
   * Rules (in order — first match wins):
   *   0.  `member_joined_channel` — dispatch with intent `joined_channel`
   *       only when joiner is the bot itself. Other users joining a channel
   *       the bot is in is not the bot's business.
   *   0.1 `member_left_channel` — dispatch with intent `close_session` only
   *       when the leaver is the bot. Cleans up the channel session.
   *   0.2 `channel_archive` — dispatch with intent `close_session` if there's
   *       an active per_channel session for this channel; else drop.
   *   0.3 `channel_unarchive` — dispatch with intent `reopen_session` if any
   *       per_channel session has ever existed for this channel; else drop.
   *   0.4 `channel_rename` — return `metadata_only` so handleWebhook updates
   *       the cached channel name without waking the agent.
   *   0.5 `reaction_added` / `reaction_removed` — dispatch with intent
   *       `reaction_on_bot` only when the reacted-on message was authored by
   *       the bot. Reactions on other people's messages are noise.
   *   1.  `app_mention` — dispatch. Canonical signal that the bot was invoked.
   *       Wins over the simultaneous `message` Slack also delivers for the
   *       same Slack message ts. Intent `direct_invocation` for per_channel.
   *   2.  `assistant_thread_started` — dispatch. Explicit AI-pane open.
   *       Intent `direct_invocation` for per_channel (the pane is the
   *       conversational surface; treat the open as a direct invocation).
   *   3.  `message` in a DM (channel_type === "im") → dispatch. The DM IS
   *       addressed to the bot; no @-mention is needed.
   *   4.  `message` whose text contains `<@bot_user_id>` → drop. Slack
   *       always also delivers `app_mention` for these; treating both would
   *       double-record the user.message in the OMA session.
   *   5.  `per_channel` + `isTopLevel` `message` → dispatch with intent
   *       `scan_arm`. dispatchEvent will check the debounce watermark and
   *       only resume the session if not already armed.
   *   6.  `message` continuing an active thread (scopeKey already bound) →
   *       dispatch. The bot was previously invoked here; the user is
   *       following up. Intent `direct_invocation` for per_channel.
   *   7.  Anything else → drop. Random channel chatter the bot happened to
   *       see because it's a member of the channel; not addressed to it.
   */
  private async classifyDispatch(
    publication: Publication,
    event: NormalizedSlackEvent,
    botUserId: string | null,
  ): Promise<ClassifyDecision> {
    const isPerChannel = publication.sessionGranularity === "per_channel";

    // ─── Lifecycle events (rules 0.x) ──────────────────────────────────

    if (event.kind === "member_joined_channel") {
      if (event.userId && event.userId === botUserId) {
        return { kind: "dispatch", intent: "joined_channel" };
      }
      return { kind: "drop", reason: "non_bot_member_joined" };
    }

    if (event.kind === "member_left_channel") {
      if (event.userId && event.userId === botUserId) {
        return { kind: "dispatch", intent: "close_session" };
      }
      return { kind: "drop", reason: "non_bot_member_left" };
    }

    if (event.kind === "channel_archive" || event.kind === "channel_unarchive") {
      if (!event.channelId) return { kind: "drop", reason: "missing_channel_id" };
      const scopeKey = `channel:${event.channelId}`;
      const existing = await this.container.sessionScopes.getByScope(
        publication.id,
        scopeKey,
      );
      if (event.kind === "channel_archive") {
        if (existing && existing.status === "active") {
          return { kind: "dispatch", intent: "close_session" };
        }
        return { kind: "drop", reason: "no_active_channel_session" };
      }
      // unarchive: any prior scope row is enough to revive
      if (existing) {
        return { kind: "dispatch", intent: "reopen_session" };
      }
      return { kind: "drop", reason: "no_prior_channel_session" };
    }

    if (event.kind === "channel_rename") {
      if (!event.channelId || !event.channelName) {
        return { kind: "drop", reason: "missing_channel_id_or_name" };
      }
      const scopeKey = `channel:${event.channelId}`;
      const existing = await this.container.sessionScopes.getByScope(
        publication.id,
        scopeKey,
      );
      if (!existing) return { kind: "drop", reason: "no_channel_session" };
      return { kind: "metadata_only", channelName: event.channelName };
    }

    if (event.kind === "reaction_added" || event.kind === "reaction_removed") {
      // For per_channel granularity: dispatch if we have an active session in
      // this channel. Reactions in channels the bot inhabits are perceived
      // regardless of message authorship — `treat agent like human`.
      // For per_thread (legacy): only dispatch reactions where item_user
      // matches the bot user. Note: mcp.slack.com posts via the user xoxp-
      // token, so Slack reports item_user as the installer (not the bot
      // user) for bot-authored messages — the per_thread match path is
      // unreliable but kept for backward compat.
      if (isPerChannel && event.channelId) {
        const scopeKey = `channel:${event.channelId}`;
        const existing = await this.container.sessionScopes.getByScope(
          publication.id,
          scopeKey,
        );
        if (existing && existing.status === "active") {
          return { kind: "dispatch", intent: "reaction_on_bot" };
        }
      }
      if (event.itemUserId && event.itemUserId === botUserId) {
        return { kind: "dispatch", intent: "reaction_on_bot" };
      }
      return { kind: "drop", reason: "reaction_not_on_bot_message" };
    }

    // ─── Conversation events (rules 1-7) ───────────────────────────────

    if (event.kind === "app_mention") {
      return { kind: "dispatch", intent: isPerChannel ? "direct_invocation" : undefined };
    }
    if (event.kind === "assistant_thread_started") {
      return { kind: "dispatch", intent: isPerChannel ? "direct_invocation" : undefined };
    }
    if (event.kind !== "message") {
      // Anything else (tokens_revoked, app_uninstalled, unknown) is handled
      // upstream; if it reaches here, drop defensively.
      return { kind: "drop", reason: "unsupported_event_kind" };
    }
    if (event.channelType === "im") {
      return { kind: "dispatch", intent: isPerChannel ? "direct_invocation" : undefined };
    }
    if (botUserId && event.text && event.text.includes(`<@${botUserId}>`)) {
      // Slack will also deliver app_mention for this message.
      return { kind: "drop", reason: "redundant_with_app_mention" };
    }
    // Unified lookup: scopeKeyFor() returns the right scope_key shape for
    // this publication's granularity (per_channel: `channel:${id}`,
    // per_thread: `${channelId}:${threadTs}`, others: null). One lookup
    // serves both granularities — no more namespace-mismatch bug where a
    // per_channel publication had thread-shaped lookups silently miss the
    // channel-shaped row.
    const scopeKey = scopeKeyFor(event, publication.sessionGranularity);
    if (scopeKey) {
      const existing = await this.container.sessionScopes.getByScope(
        publication.id,
        scopeKey,
      );
      if (existing && existing.status === "active") {
        return {
          kind: "dispatch",
          intent: isPerChannel
            ? event.isTopLevel
              ? "scan_arm"
              : "direct_invocation"
            : "direct_invocation",
        };
      }
    }
    // No active scope — per_channel still arms a scan on new top-level
    // activity so the session can be lazily created on first decision to
    // chime. Thread replies in a channel with no active session genuinely
    // aren't ours: drop.
    if (isPerChannel && event.isTopLevel) {
      return { kind: "dispatch", intent: "scan_arm" };
    }
    return { kind: "drop", reason: "not_addressed_to_bot" };
  }

  /**
   * Slack's webhook URL contains the appId (`/slack/webhook/app/:appId`).
   * The route handler is responsible for surfacing it via the
   * `x-internal-app-id` header before calling handleWebhook — keeps the
   * provider runtime-agnostic (no Hono context here).
   */
  private appIdFromHeaders(req: WebhookRequest): string | null {
    const headerAppId = req.headers["x-internal-app-id"];
    if (typeof headerAppId === "string" && headerAppId.length > 0) {
      return headerAppId;
    }
    // Fallback: the request's `installationId` field on WebhookRequest is
    // path-derived and the route can stuff appId there too. Useful for tests.
    if (req.installationId) return req.installationId;
    return null;
  }

  /**
   * The base Installation type doesn't carry `botVaultId` — fetch via the
   * Slack installation repo extension. Returns null if not set.
   */
  private async getBotVaultIdSafe(installationId: string): Promise<string | null> {
    return await this.container.installations.getBotVaultId(installationId);
  }

  /**
   * Publication-first callback URI. Embeds the OMA publication id so the
   * OAuth callback can find the right shell, read its encrypted client
   * secret, and complete the install.
   */
  private callbackUriForPublication(publicationId: string): string {
    return `${this.config.gatewayOrigin}/slack/oauth/pub/${publicationId}/callback`;
  }
  /**
   * Webhook URL keyed on the OMA publication id (NOT the Slack app id).
   * Publication-first install means we know pub_id at shell-create time —
   * before the user even creates the Slack app — so the manifest baked at
   * api.slack.com gets the final URL from minute one. No more "after
   * install completes, paste the real URL into Event Subscriptions"
   * manual step. Gateway routes /slack/webhook/pub/:pubId resolve the
   * publication's slack_app_id and continue exactly the same dispatch
   * path the old /slack/webhook/app/:appId route used.
   */
  private webhookForPublication(publicationId: string): string {
    return `${this.config.gatewayOrigin}/slack/webhook/pub/${publicationId}`;
  }
  /**
   * Legacy alias kept for any pre-publication-first install row whose
   * stored slack_apps.webhook_url still references the app-keyed shape.
   * New manifests never use this.
   */
  private webhookUri(appId: string): string {
    return `${this.config.gatewayOrigin}/slack/webhook/app/${appId}`;
  }

  // ─── MCP (vault-injection model — same as Linear's hosted approach) ──

  async mcpTools(_scope: McpScope): Promise<readonly McpToolDescriptor[]> {
    throw new Error("SlackProvider.mcpTools: MCP runs via vault outbound injection (mcp.slack.com)");
  }

  async invokeMcpTool(
    _scope: McpScope,
    _toolName: string,
    _input: unknown,
  ): Promise<McpToolResult> {
    throw new Error("SlackProvider.invokeMcpTool: MCP runs via vault outbound injection (mcp.slack.com)");
  }
}
