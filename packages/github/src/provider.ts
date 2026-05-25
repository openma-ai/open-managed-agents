// GitHubProvider — implements integrations-core's IntegrationProvider for
// GitHub. Rewritten on top of a publication-first install flow:
//
//   1. startInstall → INSERT a github_publications shell row, status=
//      'pending_setup'. Mints `app_oma_id` so the FINAL webhook URL —
//      "/github/webhook/app/<appOmaId>" — is stable from minute one (the
//      manifest baked at github.com/settings/apps/new is correct on first
//      try). The setup URL — "/github/oauth/pub/<pubId>/callback" — is
//      keyed on the publication id so retries route to the same row.
//   2. submitCredentials → PATCH client_id / client_secret / app_id /
//      app_slug / bot_login / webhook_secret / private_key onto the
//      publication row (encrypted via Crypto port). Status flips to
//      'credentials_filled'. Idempotent — re-pasting overwrites the
//      same cipher columns.
//   3. handleOAuthCallback → reads the publication row, mints an
//      installation token via App JWT, creates the vault, writes
//      installation_id + vault_id back onto the publication row,
//      flips status='live'.
//
// The old "install callback creates everything" cascading-INSERT flow
// (across github_installations + github_apps + vaults + github_publications)
// is gone. Mid-flow failure now leaves at most a stale set of cipher
// columns on a single row — the user can re-paste credentials and re-do
// the install without first cleaning up a ghost row.
//
// `github_apps` and `github_installations` are still written on install
// callback (transitional dual-write so existing UI surfaces that JOIN
// through them keep working). The webhook handler reads creds straight
// from the publication row via `findByAppOmaId` — no JOIN.
//
// All runtime concerns (HTTP, storage, JWT, sessions) come from the
// Container.

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
  StartInstallInput,
  WebhookOutcome,
  WebhookRequest,
  CapabilityKey,
  Persona,
  Publication,
} from "@open-managed-agents/integrations-core";

import {
  DEFAULT_GITHUB_CAPABILITIES,
  type GitHubConfig,
} from "./config";
import { GitHubApiClient } from "./api/client";
import {
  buildInstallUrl,
  buildInstallationTokenRequest,
  mintAppJwt,
  parseInstallationTokenResponse,
} from "./oauth/protocol";
import {
  buildManifest,
  buildManifestConversionRequest,
  parseManifestConversionResponse,
} from "./oauth/manifest";
import {
  parseWebhook,
  type NormalizedWebhookEvent,
  type RawWebhookEnvelope,
} from "./webhook/parse";
import type { GitHubIssueSessionRepo, GitHubPublicationRepo } from "./ports";

// 60 minutes — covers the slow path: open the wizard, manually create the
// App on GitHub, download the .pem, paste 4-5 fields back. The previous
// 30-min cap was tight once the manifest tab + install grant were added.
const OAUTH_STATE_TTL_SECONDS = 60 * 60;
const PROVIDER_ID: ProviderId = "github";

/**
 * Injected as `additionalSystemPrompt` on every session.create for GitHub
 * webhook engagements. Mirrors the SLACK_SIGNAL_PROTOCOL_PROMPT pattern —
 * the model needs to know that GitHub-originated turns require a tool call
 * to produce visible output (writing internal text doesn't reach the
 * user).
 *
 * Kept short and factual: the engagement model, the reply mechanism, and
 * the per-kind behavior. No threats, no MANDATORY framing — those tend
 * to backfire (see Slack history). The model picks the right tool when
 * the rules are unambiguous and the available toolset is documented.
 */
export const GITHUB_ENGAGEMENT_PROMPT = [
  `<oma_github_engagement>`,
  `You are engaging on a GitHub issue or pull request. Webhook events arrive as user.message turns whose text begins with "GitHub <kind> on <repo>#<num>". The envelope is runtime metadata — never quote it back to humans.`,
  ``,
  `## Reply mechanism`,
  ``,
  `Plain assistant text is NOT delivered to GitHub. To make anything visible to the human, call a GitHub MCP tool:`,
  ``,
  `- For issue or PR conversation comments: use the comment-post tool in the \`mcp__github__*\` namespace (look for \`add\` + \`issue\` + \`comment\` in the name).`,
  `- For PR inline review comments (replying to a specific code line): use the review-comment tool (look for \`pull\` + \`review\` + \`comment\`).`,
  `- For status updates (label add/remove, close/reopen): use the corresponding state-mutation tool.`,
  ``,
  `Tool naming follows the GitHub MCP server's conventions; scan the tool list for verbs like \`add\` / \`update\` / \`get\` and pick by semantics. Don't assume names — the MCP server controls them and may rename across releases.`,
  ``,
  `## Engagement model`,
  ``,
  `An issue or PR is "engaged" when it carries the publication's trigger label OR a body / comment @-mentions the bot. The webhook envelope reaches you only on whitelisted activity (see kinds below). Once engaged, follow-ups don't require re-mentioning — every new comment, edit, or whitelisted action wakes the same session.`,
  ``,
  `## Event kinds`,
  ``,
  `- \`issue_engaged\`: an issue you're subscribed to had whitelisted activity (opened, edited, labeled with the trigger, reopened, or new comment). Read the issue context (use \`get_issue\` / \`list_issue_comments\` if not already in the prompt body) and post a useful comment if you have something to say. If the activity is metadata-only and there's nothing for you to add, end the turn silently.`,
  ``,
  `- \`pr_engaged\`: same idea for pull requests, plus you might inspect the diff (\`list_pull_request_files\`, \`get_pull_request\`) and leave inline review comments on specific lines via the review-comment tool. Top-level summaries go on the conversation thread; line-specific feedback goes inline.`,
  ``,
  `- \`issue_unsubscribed\` / \`pr_unsubscribed\`: the trigger label was removed. End the turn with no output — the human has detached you from this thread.`,
  ``,
  `## Vocabulary`,
  ``,
  `Don't quote internal terms back to humans: \`issue_engaged\`, \`pr_engaged\`, \`trigger_label\`, \`oma_github_engagement\`, "engagement model", "webhook envelope". Speak as a contributor on the thread.`,
  `</oma_github_engagement>`,
].join("\n");

/**
 * GitHubProvider's container differs from the base in one place:
 * `publications` is narrowed to GitHubPublicationRepo so the provider can
 * reach the publication-first credential staging methods (insertShell,
 * setCredentials, getPrivateKey, bindInstallation, findByAppOmaId).
 *
 * `githubIssueSessions` is GitHub-specific (backs `github_issue_sessions`).
 * Strictly separate from Linear's `linearIssueSessions` so schema changes
 * for one provider can't bleed into the other.
 */
export interface GitHubContainer
  extends Omit<Container, "publications"> {
  publications: GitHubPublicationRepo;
  githubIssueSessions: GitHubIssueSessionRepo;
}

export class GitHubProvider implements IntegrationProvider {
  readonly id: ProviderId = PROVIDER_ID;
  private readonly api: GitHubApiClient;

  constructor(
    private readonly container: GitHubContainer,
    private readonly config: GitHubConfig,
  ) {
    this.api = new GitHubApiClient(container.http);
  }

  // ─── Install ─────────────────────────────────────────────────────────

  async startInstall(input: StartInstallInput): Promise<InstallStep | InstallComplete> {
    return this.startPublication(input);
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
      return this.handleOAuthCallback(
        (payload.publicationId as string) ?? "",
        (payload.installationId as string) ?? "",
        (payload.state as string) ?? "",
      );
    }
    if (payload.kind === "manifest_callback") {
      return this.completeManifestConversion(
        (payload.code as string) ?? "",
        (payload.state as string) ?? "",
      );
    }
    throw new Error(
      `GitHubProvider.continueInstall: unknown payload kind '${payload.kind}'`,
    );
  }

  /**
   * Re-mint a formToken for an existing github_publications shell. Caller
   * (apps/main route handler) is responsible for the ownership check; this
   * method only validates the publication exists and is in a resumable
   * state. No new shell row is INSERTed — the same publication id + appOmaId
   * flow back through the wizard.
   *
   * Returns the same `credentials_form` step shape as `startInstall` so the
   * wizard's existing render path handles it transparently.
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
    const credState = await this.container.publications.getCredentialState(input.publicationId);
    if (!credState || !credState.appOmaId) {
      throw new Error(
        "reissueFormToken: publication has no app_oma_id; restart the publish flow",
      );
    }
    const appOmaId = credState.appOmaId;

    const formToken = await this.container.jwt.sign(
      {
        kind: "github.pub.form",
        publicationId: pub.id,
        appOmaId,
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
        appOmaId,
        suggestedAppName: pub.persona.name,
        suggestedAvatarUrl: pub.persona.avatarUrl,
        setupUrl: this.publicationCallbackUri(pub.id),
        webhookUrl: this.dedicatedWebhookUri(appOmaId),
        manifestStartUrl: `${this.config.gatewayOrigin}/github/manifest/start/${formToken}`,
        recommendedPermissions: {
          contents: "write",
          issues: "write",
          pull_requests: "write",
          metadata: "read",
          actions: "read",
        },
        recommendedSubscriptions: [
          "issues",
          "issue_comment",
          "pull_request",
          "pull_request_review",
          "pull_request_review_comment",
        ],
      },
    };
  }

  // ─── A1 (full identity, BYO GitHub App) ────────────────────────────────

  /**
   * Step 1: shell create. Inserts a github_publications row (status=
   * 'pending_setup', installation_id="" sentinel, app_oma_id pre-allocated)
   * and hands back the FINAL setup + webhook URLs the user pastes into
   * GitHub's App registration form.
   */
  private async startPublication(input: StartInstallInput): Promise<InstallStep> {
    const tenantId = await this.container.tenants.resolveByUserId(input.userId);
    const { publication, appOmaId } = await this.container.publications.insertShell({
      tenantId,
      userId: input.userId,
      agentId: input.agentId,
      environmentId: input.environmentId,
      persona: input.persona,
      capabilities: new Set<CapabilityKey>(
        this.config.defaultCapabilities ?? DEFAULT_GITHUB_CAPABILITIES,
      ),
      // GitHub events are usually issue/PR-scoped; per_issue keeps one
      // running session per (issue or PR) until it's closed.
      sessionGranularity: "per_issue",
    });

    const formToken = await this.container.jwt.sign(
      {
        kind: "github.pub.form",
        publicationId: publication.id,
        appOmaId,
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
        // Kept under the legacy name so the wizard's display logic doesn't
        // need to fork. Same value semantically — the github_apps row id.
        appOmaId,
        suggestedAppName: input.persona.name,
        suggestedAvatarUrl: input.persona.avatarUrl,
        // Setup URL keyed on publication id — this is what the user sets
        // as "Setup URL" / "User authorization callback URL" on the App.
        setupUrl: this.publicationCallbackUri(publication.id),
        // Webhook URL keyed on the pre-allocated app_oma_id — webhook
        // contract preserved per the constraint.
        webhookUrl: this.dedicatedWebhookUri(appOmaId),
        // Recommended (default) UX path: open this URL, browser auto-POSTs
        // a manifest to GitHub. Zero copy-paste, ~30s end-to-end.
        manifestStartUrl: `${this.config.gatewayOrigin}/github/manifest/start/${formToken}`,
        // Fields the user must fill in on GitHub's "Register a new GitHub App"
        // form (or via API) IF they go the manual path. The integration only
        // cares about a subset.
        recommendedPermissions: {
          contents: "write",
          issues: "write",
          pull_requests: "write",
          metadata: "read",
          actions: "read",
        },
        recommendedSubscriptions: [
          "issues",
          "issue_comment",
          "pull_request",
          "pull_request_review",
          "pull_request_review_comment",
        ],
      },
    };
  }

  /**
   * Step 2: credentials submit. PATCH the encrypted credentials onto the
   * publication row. Also dual-writes to github_apps so the legacy webhook
   * fallback path (apps.get → app.publicationId) keeps resolving during
   * the transition.
   */
  private async submitCredentials(
    payload: Record<string, unknown>,
  ): Promise<InstallStep> {
    const formToken = (payload.formToken as string) ?? "";
    const appId = (payload.appId as string) ?? "";
    const privateKey = ((payload.privateKey as string) ?? "").trim();
    const webhookSecret = ((payload.webhookSecret as string) ?? "").trim();
    // OAuth credentials are required for the publication-first OAuth
    // callback path — without client_secret on the row we can't exchange
    // an OAuth code on the redirect. Manifest flow auto-generates them
    // server-side; manual flow needs the user to paste them.
    const clientId = ((payload.clientId as string) || "").trim() || null;
    const clientSecret = ((payload.clientSecret as string) || "").trim() || null;
    if (!formToken || !appId || !privateKey || !webhookSecret) {
      throw new Error(
        "submit_credentials: formToken, appId, privateKey, webhookSecret required",
      );
    }

    const form = await this.container.jwt.verify<{
      kind: string;
      publicationId: string;
      appOmaId: string;
      userId: string;
      returnUrl: string;
    }>(formToken);
    if (form.kind !== "github.pub.form") {
      throw new Error("submit_credentials: invalid formToken kind");
    }
    if (!form.publicationId || !form.appOmaId) {
      throw new Error(
        "submit_credentials: formToken missing publicationId/appOmaId — please restart the publish flow",
      );
    }

    const pub = await this.container.publications.get(form.publicationId);
    if (!pub) {
      throw new Error(
        "submit_credentials: publication not found — it may have been deleted; restart the publish flow",
      );
    }
    if (pub.status === "unpublished") {
      throw new Error(
        "submit_credentials: publication is unpublished — restart the publish flow",
      );
    }

    // Discover the App slug + bot login from `GET /app` so the install link
    // and the bot identity are both verified — not user-typed strings we'd
    // have to trust. If this fails the credentials are wrong; fail fast
    // before we persist anything.
    const appJwt = await mintAppJwt(privateKey, { appId });
    const appInfo = await this.api.getApp(appJwt);
    if (String(appInfo.id) !== appId) {
      throw new Error(
        `submit_credentials: appId mismatch — pasted ${appId}, GitHub says ${appInfo.id}`,
      );
    }

    // PATCH credentials onto the publication row. Idempotent — re-pasting
    // overwrites the same cipher columns; never creates a second row.
    const clientSecretCipher =
      clientSecret == null ? null : await this.container.crypto.encrypt(clientSecret);
    const webhookSecretCipher = await this.container.crypto.encrypt(webhookSecret);
    const privateKeyCipher = await this.container.crypto.encrypt(privateKey);
    await this.container.publications.setCredentials(pub.id, {
      appId,
      appSlug: appInfo.slug,
      botLogin: appInfo.botLogin,
      clientId,
      clientSecretCipher,
      webhookSecretCipher,
      privateKeyCipher,
    });

    // Dual-write the github_apps row keyed on the pre-allocated appOmaId
    // (transitional safety so any code that still reads through github_apps
    // — webhook fallback, ops queries — keeps resolving).
    await this.container.githubApps.insert({
      id: form.appOmaId,
      tenantId: pub.tenantId,
      publicationId: pub.id,
      appId,
      appSlug: appInfo.slug,
      botLogin: appInfo.botLogin,
      clientId,
      clientSecret,
      webhookSecret,
      privateKey,
    });

    // Flip status to awaiting_install so the wizard's next step renders
    // the install URL. setCredentials already promotes
    // pending_setup → credentials_filled; we promote one step further now
    // because we're about to hand the user the install URL.
    if (pub.status === "pending_setup" || pub.status === "credentials_filled") {
      await this.container.publications.updateStatus(pub.id, "awaiting_install");
    } else if (pub.status === "needs_reauth") {
      // Re-credentialing after a token revocation. Keep the bound install
      // alive but signal that fresh OAuth is needed.
      await this.container.publications.updateStatus(pub.id, "awaiting_install");
    }

    // Mint a state JWT to round-trip through GitHub's install callback.
    const state = await this.container.jwt.sign(
      {
        kind: "github.install.pub",
        publicationId: pub.id,
        appOmaId: form.appOmaId,
        userId: form.userId,
        returnUrl: form.returnUrl,
        nonce: this.container.ids.generate(),
      },
      OAUTH_STATE_TTL_SECONDS,
    );
    const url = buildInstallUrl({ appSlug: appInfo.slug, state });

    return {
      kind: "step",
      step: "install_link",
      data: {
        url,
        publicationId: pub.id,
        appOmaId: form.appOmaId,
        appSlug: appInfo.slug,
        botLogin: appInfo.botLogin,
        setupUrl: this.publicationCallbackUri(pub.id),
        webhookUrl: this.dedicatedWebhookUri(form.appOmaId),
      },
    };
  }

  /**
   * Step 3: install callback. GitHub redirects to
   * /github/oauth/pub/<pubId>/callback with `installation_id` + `state`.
   * We mint an installation token via App JWT, create the vault, write
   * installation_id + vault_id back onto the publication row, flip
   * status='live'.
   */
  private async handleOAuthCallback(
    publicationId: string,
    installationId: string,
    stateToken: string,
  ): Promise<InstallComplete> {
    if (!publicationId) throw new Error("GitHub OAuth callback: missing publicationId");
    if (!installationId) throw new Error("GitHub OAuth callback: missing installation_id");
    if (!stateToken) throw new Error("GitHub OAuth callback: missing state");

    const state = await this.container.jwt.verify<{
      kind: string;
      publicationId: string;
      appOmaId: string;
      userId: string;
      returnUrl: string;
    }>(stateToken);
    if (state.kind !== "github.install.pub") {
      throw new Error("GitHub OAuth callback: invalid state kind");
    }
    if (state.publicationId !== publicationId) {
      throw new Error("GitHub OAuth callback: publicationId mismatch");
    }

    const pub = await this.container.publications.get(publicationId);
    if (!pub) throw new Error("GitHub OAuth callback: unknown publicationId");

    // Idempotency: if this publication is already live (the user clicked
    // the callback link twice, or GitHub retried), short-circuit. We DO
    // NOT re-mint the installation token — the App JWT path is harmless
    // to retry but creating duplicate vaults is not.
    if (pub.status === "live" && pub.installationId && pub.installationId !== "") {
      return { kind: "complete", publicationId: pub.id };
    }

    const credState = await this.container.publications.getCredentialState(publicationId);
    if (!credState || !credState.appId || !credState.appSlug || !credState.botLogin) {
      throw new Error(
        "GitHub OAuth callback: publication has no credentials — re-paste credentials before installing",
      );
    }
    if (!credState.hasPrivateKey) {
      throw new Error(
        "GitHub OAuth callback: publication missing private key — re-paste credentials",
      );
    }

    const privateKey = await this.container.publications.getPrivateKey(publicationId);
    if (!privateKey) {
      throw new Error("GitHub OAuth callback: missing private key");
    }

    // Mint a 1-hour installation access token and look up the install's org.
    const appJwt = await mintAppJwt(privateKey, { appId: credState.appId });
    const tokReq = buildInstallationTokenRequest(appJwt, installationId);
    const tokRes = await this.container.http.fetch({
      method: "POST",
      url: tokReq.url,
      headers: tokReq.headers,
      body: tokReq.body,
    });
    if (tokRes.status < 200 || tokRes.status >= 300) {
      throw new Error(
        `GitHub installation token: HTTP ${tokRes.status} ${tokRes.body.slice(0, 200)}`,
      );
    }
    const token = parseInstallationTokenResponse(tokRes.body);
    const installDetail = await this.api.getInstallation(appJwt, installationId);

    // Write the github_installations row (still needed for current
    // installations.* read paths). tenantId comes from the publication
    // row directly — no extra lookup needed.
    const installation = await this.container.installations.insert({
      tenantId: pub.tenantId,
      userId: state.userId,
      providerId: PROVIDER_ID,
      // For GitHub the installation id is the stable workspace handle (orgs
      // can rename, install ids can't). The login goes in workspaceName.
      workspaceId: installationId,
      workspaceName: installDetail.account.login,
      installKind: "dedicated",
      appId: state.appOmaId,
      accessToken: token.token,
      refreshToken: null,
      // Persist the granted permissions as scopes for observability. We
      // don't re-validate against this set on each call — GitHub does that
      // itself.
      scopes: Object.keys(installDetail.permissions),
      // Bot login as our `botUserId` field (TEXT-typed, semantically OK).
      botUserId: credState.botLogin,
    });

    // One vault, two surfaces:
    //   1. static_bearer credential — outbound proxy injects on calls to
    //      the hosted GitHub MCP server (api.githubcopilot.com/mcp/).
    //   2. cap_cli credential (cli_id="gh") — cap proxy injects Bearer on
    //      sandbox HTTPS to api.github.com / uploads.github.com when the
    //      agent runs `gh` / `git`. Token never enters sandbox process env.
    const { vaultId } = await this.container.vaults.createCredentialForUser({
      userId: state.userId,
      vaultName: `GitHub · ${installDetail.account.login} · ${pub.persona.name}`,
      displayName: `GitHub MCP token (${pub.persona.name})`,
      mcpServerUrl: this.config.mcpServerUrl,
      bearerToken: token.token,
      provider: "github",
    });
    await this.container.vaults.addCapCliCredential({
      userId: state.userId,
      vaultId,
      vaultName: `GitHub · ${installDetail.account.login} · ${pub.persona.name}`,
      displayName: `GitHub CLI token (${pub.persona.name})`,
      cliId: "gh",
      token: token.token,
      provider: "github",
    });
    await this.container.installations.setVaultId(installation.id, vaultId);

    // Bind everything back onto the publication row, flipping status='live'.
    // Done last so an early failure leaves the row resumable (status stays
    // at awaiting_install with credentials still on the row).
    await this.container.publications.bindInstallation({
      publicationId: pub.id,
      installationId: installation.id,
      vaultId,
    });

    // Keep github_apps.publicationId in sync (transitional dual-write).
    await this.container.githubApps.setPublicationId(state.appOmaId, pub.id);

    return { kind: "complete", publicationId: pub.id };
  }

  private publicationCallbackUri(publicationId: string): string {
    return `${this.config.gatewayOrigin}/github/oauth/pub/${publicationId}/callback`;
  }
  private dedicatedWebhookUri(appOmaId: string): string {
    return `${this.config.gatewayOrigin}/github/webhook/app/${appOmaId}`;
  }
  private manifestRedirectUri(): string {
    return `${this.config.gatewayOrigin}/github/manifest/callback`;
  }

  /**
   * Build the manifest payload + state JWT for the manifest-flow start
   * page. Called by the gateway's GET /github/manifest/start/:formToken
   * handler — provider stays free of HTTP/HTML rendering, just supplies
   * the data.
   */
  async prepareManifestForm(
    formToken: string,
  ): Promise<{
    manifest: Record<string, unknown>;
    state: string;
    publicationId: string;
    appOmaId: string;
    suggestedAppName: string;
  }> {
    const form = await this.container.jwt.verify<{
      kind: string;
      publicationId: string;
      appOmaId: string;
      userId: string;
      returnUrl: string;
    }>(formToken);
    if (form.kind !== "github.pub.form") {
      throw new Error("prepareManifestForm: invalid formToken kind");
    }
    if (!form.publicationId || !form.appOmaId) {
      throw new Error("prepareManifestForm: formToken missing publicationId/appOmaId");
    }

    const pub = await this.container.publications.get(form.publicationId);
    if (!pub) {
      throw new Error("prepareManifestForm: publication not found");
    }

    // Sign a separate state JWT for the manifest callback path so we can
    // reconstruct context after GitHub round-trips us. Includes
    // publicationId so the credentials we persist land on the right row.
    const state = await this.container.jwt.sign(
      {
        kind: "github.manifest.state",
        publicationId: form.publicationId,
        appOmaId: form.appOmaId,
        userId: form.userId,
        returnUrl: form.returnUrl,
        nonce: this.container.ids.generate(),
      },
      OAUTH_STATE_TTL_SECONDS,
    );

    const manifest = buildManifest({
      name: pub.persona.name,
      url: this.config.homepageUrl ?? "https://openma.dev",
      webhookUrl: this.dedicatedWebhookUri(form.appOmaId),
      redirectUrl: this.manifestRedirectUri(),
      // Setup URL = our publication-first OAuth callback. After the user
      // installs on their org, GitHub redirects here with installation_id.
      setupUrl: this.publicationCallbackUri(form.publicationId),
      permissions: {
        contents: "write",
        issues: "write",
        pull_requests: "write",
        metadata: "read",
        actions: "read",
      },
      events: [
        "issues",
        "issue_comment",
        "pull_request",
        "pull_request_review",
        "pull_request_review_comment",
      ],
      public: false,
    });

    return {
      manifest,
      state,
      publicationId: form.publicationId,
      appOmaId: form.appOmaId,
      suggestedAppName: pub.persona.name,
    };
  }

  /**
   * Manifest callback: GitHub redirects here with `?code=&state=`. We
   * exchange the code for App credentials (id, slug, pem, webhook_secret),
   * persist them onto the publication row + dual-write github_apps, and
   * return an InstallStep with the install URL — same shape as the
   * manual `submit_credentials` path's output, so the wizard can keep
   * going regardless of which path was taken.
   */
  private async completeManifestConversion(
    code: string,
    stateToken: string,
  ): Promise<InstallStep> {
    if (!code) throw new Error("manifest callback: missing code");
    if (!stateToken) throw new Error("manifest callback: missing state");

    const state = await this.container.jwt.verify<{
      kind: string;
      publicationId: string;
      appOmaId: string;
      userId: string;
      returnUrl: string;
    }>(stateToken);
    if (state.kind !== "github.manifest.state") {
      throw new Error("manifest callback: invalid state kind");
    }

    // Exchange code for App credentials. GitHub invalidates `code` after
    // first use, so retries on failure must restart the manifest flow.
    const req = buildManifestConversionRequest(code);
    const res = await this.container.http.fetch({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: req.body,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(
        `manifest conversion: HTTP ${res.status} ${res.body.slice(0, 200)}`,
      );
    }
    const result = parseManifestConversionResponse(res.body);

    const pub = await this.container.publications.get(state.publicationId);
    if (!pub) {
      throw new Error("manifest callback: publication not found");
    }

    // PATCH the publication row + dual-write github_apps.
    const clientSecret = result.clientSecret || null;
    const clientSecretCipher =
      clientSecret == null ? null : await this.container.crypto.encrypt(clientSecret);
    const webhookSecretCipher = await this.container.crypto.encrypt(result.webhookSecret);
    const privateKeyCipher = await this.container.crypto.encrypt(result.pem);
    await this.container.publications.setCredentials(state.publicationId, {
      appId: String(result.id),
      appSlug: result.slug,
      botLogin: result.botLogin,
      clientId: result.clientId || null,
      clientSecretCipher,
      webhookSecretCipher,
      privateKeyCipher,
    });
    await this.container.githubApps.insert({
      id: state.appOmaId,
      tenantId: pub.tenantId,
      publicationId: pub.id,
      appId: String(result.id),
      appSlug: result.slug,
      botLogin: result.botLogin,
      clientId: result.clientId || null,
      clientSecret,
      webhookSecret: result.webhookSecret,
      privateKey: result.pem,
    });

    if (pub.status === "pending_setup" || pub.status === "credentials_filled") {
      await this.container.publications.updateStatus(pub.id, "awaiting_install");
    }

    // Now mint the install-state JWT so the user can click through to install.
    const installState = await this.container.jwt.sign(
      {
        kind: "github.install.pub",
        publicationId: pub.id,
        appOmaId: state.appOmaId,
        userId: state.userId,
        returnUrl: state.returnUrl,
        nonce: this.container.ids.generate(),
      },
      OAUTH_STATE_TTL_SECONDS,
    );
    const url = buildInstallUrl({ appSlug: result.slug, state: installState });

    return {
      kind: "step",
      step: "install_link",
      data: {
        url,
        publicationId: pub.id,
        appOmaId: state.appOmaId,
        appSlug: result.slug,
        botLogin: result.botLogin,
        setupUrl: this.publicationCallbackUri(pub.id),
        webhookUrl: this.dedicatedWebhookUri(state.appOmaId),
        // Round-trip returnUrl so the gateway can redirect the user's
        // browser back to the Console wizard with a "ready to install"
        // signal.
        returnUrl: state.returnUrl,
      },
    };
  }

  /**
   * Re-signs a 60-minute formToken into a 7-day handoff token an admin
   * can use without OMA login.
   */
  private async createHandoffLink(
    payload: Record<string, unknown>,
  ): Promise<InstallStep> {
    const formToken = (payload.formToken as string) ?? "";
    if (!formToken) throw new Error("handoff_link: formToken required");
    const form = await this.container.jwt.verify<{
      kind: string;
      publicationId: string;
      appOmaId: string;
      userId: string;
      returnUrl: string;
    }>(formToken);
    if (form.kind !== "github.pub.form") {
      throw new Error("handoff_link: invalid formToken kind");
    }
    const handoffToken = await this.container.jwt.sign(
      { ...form, kind: "github.pub.form", handoff: true },
      7 * 24 * 60 * 60,
    );
    return {
      kind: "step",
      step: "install_link",
      data: {
        url: `${this.config.gatewayOrigin}/github-setup/${handoffToken}`,
        expiresInDays: 7,
      },
    };
  }

  // ─── Webhook ─────────────────────────────────────────────────────────

  async handleWebhook(req: WebhookRequest): Promise<WebhookOutcome> {
    if (!req.deliveryId) {
      return { handled: false, reason: "missing_delivery_id" };
    }

    // Path-derived: which OMA-internal app id is this delivery for? The
    // route handler stuffs it into `installationId` since the
    // WebhookRequest shape doesn't have a per-app field — it gets
    // reinterpreted here.
    const appOmaId = req.installationId;
    if (!appOmaId) {
      return { handled: false, reason: "missing_app_id_in_path" };
    }

    // Primary lookup: by app_oma_id → publication row (the
    // publication-first row holds the signing material). Fallback: legacy
    // github_apps row (kept dual-written for transitional safety; can be
    // removed once all installs are publication-first).
    let publication = await this.container.publications.findByAppOmaId(appOmaId);
    let webhookSecret: string | null = null;
    let tenantId: string | null = null;

    if (publication) {
      tenantId = publication.tenantId;
      webhookSecret = await this.container.publications.getWebhookSecret(publication.id);
    } else {
      const app = await this.container.githubApps.get(appOmaId);
      if (!app) {
        return { handled: false, reason: "unknown_app" };
      }
      if (!app.publicationId) {
        // App row exists but install hasn't completed yet — webhook
        // arrived too early. GitHub will retry; by then the publication
        // should be live.
        return { handled: false, reason: "app_pending_install" };
      }
      tenantId = app.tenantId;
      webhookSecret = await this.container.githubApps.getWebhookSecret(app.id);
      publication = await this.container.publications.get(app.publicationId);
    }

    if (!webhookSecret) {
      return { handled: false, reason: "missing_webhook_secret" };
    }
    if (!publication || publication.status !== "live") {
      // Either the publication was unbound, unpublished, or the install is
      // mid-rotation. Record the dedup row and bail.
      return { handled: false, reason: "no_live_publication" };
    }

    // Verify HMAC. GitHub sends `sha256=<hex>` in `x-hub-signature-256`.
    const sigHeader =
      req.headers["x-hub-signature-256"] ?? req.headers["X-Hub-Signature-256"] ?? "";
    if (!sigHeader.startsWith("sha256=")) {
      return { handled: false, reason: "missing_or_malformed_signature" };
    }
    const sigHex = sigHeader.slice("sha256=".length);
    const ok = await this.container.hmac.verify(webhookSecret, req.rawBody, sigHex);
    if (!ok) return { handled: false, reason: "invalid_signature" };

    // Idempotency: refuse to dispatch the same delivery twice.
    const fresh = await this.container.webhookEvents.recordIfNew(
      req.deliveryId,
      tenantId ?? "",
      publication.id, // stash publicationId here for traceability
      req.headers["x-github-event"] ?? "unknown",
      this.container.clock.nowMs(),
    );
    if (!fresh) return { handled: false, reason: "duplicate_delivery" };

    let raw: RawWebhookEnvelope;
    try {
      raw = JSON.parse(req.rawBody) as RawWebhookEnvelope;
    } catch {
      await this.container.webhookEvents.attachError(req.deliveryId, "invalid_json");
      return { handled: false, reason: "invalid_json" };
    }
    const event = parseWebhook({
      eventType: req.headers["x-github-event"] ?? "",
      deliveryId: req.deliveryId,
      raw,
      botLogin: await this.botLoginFor(publication, appOmaId),
      triggerLabel: await this.container.publications.getTriggerLabel(publication.id),
    });
    if (!event) {
      await this.container.webhookEvents.attachError(req.deliveryId, "unparseable");
      return { handled: false, reason: "unparseable" };
    }

    await this.container.webhookEvents.attachPublication(
      req.deliveryId,
      publication.id,
    );

    if (event.kind === null) {
      // Recorded for observability; nothing to dispatch.
      return { handled: false, reason: "ignored_event_kind" };
    }

    // installation_created / installation_repos_added: not a session event —
    // these are install-lifecycle hooks. We use them to auto-create the
    // trigger label in the newly accessible repos. Errors are logged but
    // don't fail the webhook (label creation is best-effort UX).
    if (event.kind === "installation_created" || event.kind === "installation_repos_added") {
      try {
        await this.autoCreateTriggerLabels(publication, raw);
      } catch (err) {
        console.warn(
          `[github-install-hook] auto-create label failed for pub=${publication.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      return { handled: true, reason: "trigger_label_seeded", publicationId: publication.id, tenantId: tenantId ?? "" };
    }
    if (event.kind === "installation_deleted") {
      // App uninstalled. Existing handlers (if any) can clean up; we don't
      // do anything destructive here — the install row will be marked
      // revoked elsewhere.
      return { handled: false, reason: "installation_deleted" };
    }

    const sessionId = await this.dispatchEvent(publication, event);
    if (sessionId === null) {
      // Dispatcher dropped the event (e.g. lost the two-phase claim race to
      // a sibling webhook). Acknowledge to GitHub but report not_handled.
      return { handled: false, reason: "race_lost_to_concurrent_create" };
    }
    await this.container.webhookEvents.attachSession(req.deliveryId, sessionId);

    return {
      handled: true,
      reason: "publication_first",
      publicationId: publication.id,
      sessionId,
      tenantId: tenantId ?? "",
    };
  }

  /**
   * Best-effort lookup of the bot login. Reads from the publication's
   * credential state if present (publication-first path); falls back to
   * the legacy github_apps row otherwise.
   */
  private async botLoginFor(
    publication: Publication,
    appOmaId: string,
  ): Promise<string> {
    const state = await this.container.publications.getCredentialState(publication.id);
    if (state?.botLogin) return state.botLogin;
    const app = await this.container.githubApps.get(appOmaId);
    return app?.botLogin ?? "";
  }

  private async dispatchEvent(
    publication: Publication,
    event: NormalizedWebhookEvent,
  ): Promise<string | null> {
    const installation = await this.container.installations.get(publication.installationId);
    const vaultIds = installation?.vaultId ? [installation.vaultId] : [];
    const mcpServers = [{ name: "github", url: this.config.mcpServerUrl }];

    // Refresh the installation token before handing the session a vault.
    // GitHub installation tokens last ~1 hour; without rotation the bot
    // would silently start 401-ing on long-running sessions or any
    // session started >1h after install.
    if (installation?.vaultId && installation.appId) {
      try {
        await this.refreshInstallationToken(installation);
      } catch (err) {
        // Don't kill the dispatch on refresh failure — the existing token
        // may still be valid (we refresh proactively, not reactively).
        console.warn(
          `[github] token refresh failed for installation ${installation.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const sessionEvent = {
      type: "user.message" as const,
      content: [
        { type: "text" as const, text: this.renderEventAsUserMessage(event) },
      ],
      metadata: {
        github: {
          installationId: event.installationId,
          repository: event.repository,
          itemKind: event.itemKind,
          itemNumber: event.itemNumber,
          commentId: event.commentId,
          actorLogin: event.actorLogin,
          eventKind: event.kind,
          eventType: event.eventType,
          deliveryId: event.deliveryId,
          htmlUrl: event.htmlUrl,
        },
      },
    };

    // per_issue session granularity: keep one running session per (repo,
    // issue/PR number). We use a synthetic issue id "<repo>#<number>".
    const issueKey =
      event.repository && event.itemNumber != null
        ? `${event.repository}#${event.itemNumber}`
        : null;

    if (publication.sessionGranularity === "per_issue" && issueKey) {
      // Two-phase claim race-guard: GitHub fires multiple webhooks for the
      // same intent (e.g. issues.assigned + issue_comment.created within
      // ms). Without claim, getByIssue→null+sessions.create→insert lets
      // both wake parallel sessions that each post a reply.
      const PENDING_FRESH_MS = 60_000;
      const existing = await this.container.githubIssueSessions.getByIssue(
        publication.id,
        issueKey,
      );
      if (
        existing &&
        existing.status === "pending" &&
        this.container.clock.nowMs() - existing.createdAt < PENDING_FRESH_MS
      ) {
        return null;
      }
      if (existing && existing.status === "active") {
        await this.container.sessions.resume(
          publication.userId,
          existing.sessionId,
          sessionEvent,
        );
        return existing.sessionId;
      }
      // Unsubscribe path: trigger label was removed — close the session.
      if (event.kind === "issue_unsubscribed" || event.kind === "pr_unsubscribed") {
        if (existing && existing.status === "active") {
          await this.container.githubIssueSessions.releasePending(
            publication.id,
            issueKey,
          );
          // Note: there's no first-class "end session" API — we mark the
          // claim row inactive so future events drop. The OMA session
          // itself stays alive but is detached from new webhook deliveries.
        }
        return null;
      }
      const claimed = await this.container.githubIssueSessions.claimPending({
        tenantId: publication.tenantId,
        publicationId: publication.id,
        issueId: issueKey,
        nowMs: this.container.clock.nowMs(),
      });
      if (!claimed) return null;

      try {
        const created = await this.container.sessions.create({
          userId: publication.userId,
          agentId: publication.agentId,
          environmentId: publication.environmentId,
          vaultIds,
          mcpServers,
          metadata: {
            github: { issueKey, repository: event.repository },
          },
          initialEvent: sessionEvent,
          additionalSystemPrompt: GITHUB_ENGAGEMENT_PROMPT,
        });
        const fulfilled = await this.container.githubIssueSessions.fulfillPending(
          publication.id,
          issueKey,
          created.sessionId,
        );
        if (!fulfilled) {
          console.warn(
            `[github-dispatch] fulfillPending lost row for issue=${issueKey} — created session ${created.sessionId} orphaned`,
          );
        }
        return created.sessionId;
      } catch (err) {
        try {
          await this.container.githubIssueSessions.releasePending(publication.id, issueKey);
        } catch {
          // best-effort rollback
        }
        throw err;
      }
    }

    const created = await this.container.sessions.create({
      userId: publication.userId,
      agentId: publication.agentId,
      environmentId: publication.environmentId,
      vaultIds,
      mcpServers,
      metadata: { github: { repository: event.repository } },
      initialEvent: sessionEvent,
      additionalSystemPrompt: GITHUB_ENGAGEMENT_PROMPT,
    });
    return created.sessionId;
  }

  private renderEventAsUserMessage(event: NormalizedWebhookEvent): string {
    const lines: string[] = [];
    const where = event.repository
      ? `${event.repository}#${event.itemNumber ?? "?"}`
      : event.repository ?? "?";
    lines.push(`GitHub ${event.kind ?? event.eventType} on ${where}`);
    if (event.itemTitle) lines.push(`Title: ${event.itemTitle}`);
    if (event.actorLogin) lines.push(`From: @${event.actorLogin}`);
    if (event.htmlUrl) lines.push(`URL: ${event.htmlUrl}`);
    if (event.commentBody) lines.push(`\nComment:\n${event.commentBody}`);
    return lines.join("\n");
  }

  /**
   * Mint a fresh installation_token via GitHub's
   * `/app/installations/<id>/access_tokens` endpoint and rotate both vault
   * credentials (static_bearer for MCP path, cap_cli (cli_id="gh") for
   * sandbox `gh`/`git`). Throws on any HTTP failure; caller decides
   * whether to swallow.
   *
   * Reads the private key from the publication row first (new path),
   * falls back to github_apps (legacy path).
   */
  private async refreshInstallationToken(installation: {
    id: string;
    userId: string;
    workspaceId: string;
    appId: string | null;
    vaultId: string | null;
  }): Promise<void> {
    if (!installation.appId || !installation.vaultId) return;

    // Resolve App numeric id + private key. Prefer the publication row
    // (new flow); fall back to github_apps (legacy installs).
    const app = await this.container.githubApps.get(installation.appId);
    if (!app) return;
    let privateKey: string | null = null;
    if (app.publicationId) {
      privateKey = await this.container.publications.getPrivateKey(app.publicationId);
    }
    if (!privateKey) {
      privateKey = await this.container.githubApps.getPrivateKey(app.id);
    }
    if (!privateKey) return;

    const appJwt = await mintAppJwt(privateKey, { appId: app.appId });
    const tokReq = buildInstallationTokenRequest(appJwt, installation.workspaceId);
    const tokRes = await this.container.http.fetch({
      method: "POST",
      url: tokReq.url,
      headers: tokReq.headers,
      body: tokReq.body,
    });
    if (tokRes.status < 200 || tokRes.status >= 300) {
      throw new Error(
        `installation token refresh: HTTP ${tokRes.status} ${tokRes.body.slice(0, 200)}`,
      );
    }
    const fresh = parseInstallationTokenResponse(tokRes.body);

    await this.container.vaults.rotateBearerToken({
      userId: installation.userId,
      vaultId: installation.vaultId,
      newBearerToken: fresh.token,
    });
    await this.container.vaults.rotateCapCliToken({
      userId: installation.userId,
      vaultId: installation.vaultId,
      cliId: "gh",
      newToken: fresh.token,
    });
  }

  // ─── Trigger label seeding ──────────────────────────────────────────
  /**
   * Auto-create the publication's trigger label in repos covered by an
   * installation event. Called from the webhook handler on
   * `installation_created` (full repo list) and `installation_repos_added`
   * (just the new repos). Best-effort: per-repo failures are logged and
   * skipped — the label is a UX affordance, not a correctness requirement.
   *
   * Idempotent: 422 conflict (already exists with this name) is treated as
   * success; we never modify an existing same-named label's color.
   */
  private async autoCreateTriggerLabels(
    publication: Publication,
    raw: RawWebhookEnvelope,
  ): Promise<void> {
    const triggerLabel = await this.container.publications.getTriggerLabel(publication.id);
    if (!triggerLabel) return;

    const installation = await this.container.installations.get(publication.installationId);
    if (!installation || !installation.workspaceId || !installation.appId) return;

    // Mint a fresh installation token (don't reuse the cached vault one;
    // it may have been revoked in a recent App-uninstall/reinstall cycle).
    const app = await this.container.githubApps.get(installation.appId);
    if (!app) return;
    let privateKey: string | null = null;
    if (app.publicationId) {
      privateKey = await this.container.publications.getPrivateKey(app.publicationId);
    }
    if (!privateKey) privateKey = await this.container.githubApps.getPrivateKey(app.id);
    if (!privateKey) return;
    const appJwt = await mintAppJwt(privateKey, { appId: app.appId });
    const tokReq = buildInstallationTokenRequest(appJwt, installation.workspaceId);
    const tokRes = await this.container.http.fetch({
      method: "POST",
      url: tokReq.url,
      headers: tokReq.headers,
      body: tokReq.body,
    });
    if (tokRes.status < 200 || tokRes.status >= 300) {
      throw new Error(
        `installation token mint: HTTP ${tokRes.status} ${tokRes.body.slice(0, 200)}`,
      );
    }
    const installToken = parseInstallationTokenResponse(tokRes.body).token;

    // Determine target repo list:
    //   - installation_created: payload's `repositories` field (selected
    //     repos at install time) — fall back to listInstallationRepos if
    //     missing.
    //   - installation_repos_added: payload's `repositories_added` field
    //     (just the newly added subset).
    let repos: Array<{ owner: string; name: string }> = [];
    if (raw.repositories_added && Array.isArray(raw.repositories_added)) {
      repos = raw.repositories_added.map((r) => parseRepoFullName(r.full_name));
    } else if (raw.repositories && Array.isArray(raw.repositories)) {
      repos = raw.repositories.map((r) => parseRepoFullName(r.full_name));
    } else {
      // No payload list — enumerate via API.
      let page = 1;
      while (true) {
        const { repos: pageRepos, hasMore } = await this.api.listInstallationRepos(
          installToken,
          page,
        );
        repos.push(...pageRepos);
        if (!hasMore) break;
        page += 1;
      }
    }

    // Brand-derived color for the label. The persona's avatarUrl might
    // hint at a color but we don't fetch it here; just use a neutral
    // brand-ish blue. Users can recolor in GitHub UI; we never overwrite.
    const labelColor = "5319e7"; // GitHub default purple tone, distinct
    const description = `Engage @${app.appSlug ?? publication.persona.name} on this issue or PR`;

    // Bound concurrency to avoid hitting GitHub's secondary rate limits
    // (~30 req/sec on writes); 8-way is plenty for typical ≤200 repo
    // installs without measurable impact.
    const CONCURRENCY = 8;
    let i = 0;
    const worker = async () => {
      while (i < repos.length) {
        const r = repos[i++];
        if (!r.owner || !r.name) continue;
        try {
          await this.api.createIssueLabel(installToken, r.owner, r.name, {
            name: triggerLabel,
            color: labelColor,
            description,
          });
        } catch (err) {
          console.warn(
            `[github-label-seed] failed pub=${publication.id} ${r.owner}/${r.name}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, repos.length) }, worker));
  }

  // ─── MCP (deferred — agents talk to GitHub MCP server directly) ──────

  async mcpTools(_scope: McpScope): Promise<readonly McpToolDescriptor[]> {
    return [];
  }

  async invokeMcpTool(
    _scope: McpScope,
    toolName: string,
    _input: unknown,
  ): Promise<McpToolResult> {
    return {
      ok: false,
      error: {
        code: "not_implemented",
        message:
          `GitHub MCP tools are served by the upstream MCP at ${this.config.mcpServerUrl}; ` +
          `OMA does not proxy "${toolName}".`,
      },
    };
  }
}

/** Split "owner/repo" into components. Returns empty strings on malformed
 *  input so callers can skip without throwing. */
function parseRepoFullName(fullName: string): { owner: string; name: string } {
  const idx = fullName.indexOf("/");
  if (idx <= 0 || idx >= fullName.length - 1) return { owner: "", name: "" };
  return { owner: fullName.slice(0, idx), name: fullName.slice(idx + 1) };
}
