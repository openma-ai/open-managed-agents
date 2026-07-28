// Shared test fixtures for Slack provider tests. Eliminates duplicate
// FakeSlackInstallationRepo / buildFakeSlackContainer / makeProvider blocks
// across slack-provider-*.test.ts.
//
// Mirrors test/unit/github-test-helpers.ts — both keep helper surface narrow
// enough that a test reader doesn't have to chase indirection to follow the
// scenario.

import { SlackProvider, type SlackContainer } from "../../packages/slack/src/provider";
import type {
  SlackInstallationRepo,
  SlackPublicationRepo,
  SlackPublicationCredentialState,
  SlackSessionScopeRepo,
} from "../../packages/slack/src/ports";
import {
  buildFakeContainer,
  InMemoryInstallationRepo,
  InMemoryPublicationRepo,
  type FakeContainer,
} from "../../packages/integrations-core/src/test-fakes";
import {
  ALL_SLACK_CAPABILITIES,
  DEFAULT_SLACK_BOT_SCOPES,
  DEFAULT_SLACK_USER_SCOPES,
} from "../../packages/slack/src/config";
import type {
  CapabilityKey,
  Clock,
  IdGenerator,
  Persona,
  Publication,
  SessionGranularity,
} from "../../packages/integrations-core/src/index";

/**
 * Slack-flavored InMemoryInstallationRepo: extends the base with the two
 * Slack-only fields (user_token, bot_vault_id) that aren't part of the core
 * Installation row.
 */
export class FakeSlackInstallationRepo
  extends InMemoryInstallationRepo
  implements SlackInstallationRepo
{
  private userTokens = new Map<string, string>();
  private botVaults = new Map<string, string>();

  async getUserToken(id: string): Promise<string | null> {
    return this.userTokens.get(id) ?? null;
  }

  async setUserToken(id: string, userToken: string): Promise<void> {
    this.userTokens.set(id, userToken);
  }

  async setBotVaultId(id: string, botVaultId: string): Promise<void> {
    this.botVaults.set(id, botVaultId);
  }

  async getBotVaultId(id: string): Promise<string | null> {
    return this.botVaults.get(id) ?? null;
  }
}

/**
 * Slack-flavored InMemoryPublicationRepo: extends the base with the
 * publication-first credential staging methods. Stores the encrypted
 * client_secret/signing_secret + slack_app_id alongside the row so the
 * tests can verify the wiring without spinning up a real Crypto. The fake
 * Crypto in test-fakes.ts uses base64-style `enc(...)` ciphertext, so
 * encrypt-then-decrypt round-trip works the same way prod will.
 */
export class FakeSlackPublicationRepo
  extends InMemoryPublicationRepo
  implements SlackPublicationRepo
{
  private creds = new Map<
    string,
    {
      clientId: string;
      clientSecretCipher: string;
      signingSecretCipher: string;
      slackAppId: string | null;
    }
  >();
  // Stash the plaintext for tests that want to assert it (and to mirror the
  // adapter behavior of returning decrypted secrets via crypto.decrypt).
  private secrets = new Map<
    string,
    { clientSecret: string; signingSecret: string }
  >();
  constructor(clock: Clock, _ids?: IdGenerator) {
    super(clock);
  }

  async insertShell(input: {
    tenantId: string;
    userId: string;
    agentId: string;
    environmentId: string;
    persona: Persona;
    capabilities: ReadonlySet<CapabilityKey>;
    sessionGranularity: SessionGranularity;
  }): Promise<Publication> {
    return await this.insert({
      tenantId: input.tenantId,
      userId: input.userId,
      agentId: input.agentId,
      installationId: "", // sentinel — flipped to a real id on bindInstallation
      environmentId: input.environmentId,
      mode: "full",
      status: "pending_setup",
      persona: input.persona,
      capabilities: input.capabilities,
      sessionGranularity: input.sessionGranularity,
    });
  }

  async setCredentials(
    publicationId: string,
    input: { clientId: string; clientSecretCipher: string; signingSecretCipher: string },
  ): Promise<void> {
    const pub = await this.get(publicationId);
    if (!pub) throw new Error(`FakeSlackPublicationRepo.setCredentials: unknown publication ${publicationId}`);
    const existing = this.creds.get(publicationId);
    this.creds.set(publicationId, {
      clientId: input.clientId,
      clientSecretCipher: input.clientSecretCipher,
      signingSecretCipher: input.signingSecretCipher,
      slackAppId: existing?.slackAppId ?? null,
    });
    // Mirror plaintext for getClientSecret/getSigningSecret. Decode the
    // FakeCrypto's `enc(...)` envelope; if a caller passed plaintext (some
    // tests bypass the encrypt step), accept it verbatim.
    const decode = (s: string): string =>
      s.startsWith("enc(") && s.endsWith(")") ? s.slice(4, -1) : s;
    this.secrets.set(publicationId, {
      clientSecret: decode(input.clientSecretCipher),
      signingSecret: decode(input.signingSecretCipher),
    });
    if (pub.status === "pending_setup") {
      await this.updateStatus(publicationId, "awaiting_install");
    }
  }

  async getClientSecret(publicationId: string): Promise<string | null> {
    return this.secrets.get(publicationId)?.clientSecret ?? null;
  }

  async getSigningSecret(publicationId: string): Promise<string | null> {
    return this.secrets.get(publicationId)?.signingSecret ?? null;
  }

  async getCredentialState(
    publicationId: string,
  ): Promise<SlackPublicationCredentialState | null> {
    const pub = await this.get(publicationId);
    if (!pub) return null;
    const c = this.creds.get(publicationId);
    return {
      clientId: c?.clientId ?? null,
      hasClientSecret: !!c?.clientSecretCipher,
      hasSigningSecret: !!c?.signingSecretCipher,
      slackAppId: c?.slackAppId ?? null,
    };
  }

  async bindInstallation(input: {
    publicationId: string;
    installationId: string;
    slackAppId: string;
  }): Promise<void> {
    const pub = await this.get(input.publicationId);
    if (!pub) throw new Error(`FakeSlackPublicationRepo.bindInstallation: unknown publication ${input.publicationId}`);
    // Idempotency: re-running with the same args is a no-op.
    if (pub.status === "live" && pub.installationId === input.installationId) {
      const c = this.creds.get(input.publicationId);
      if (c?.slackAppId === input.slackAppId) return;
    }
    // The base InMemoryPublicationRepo holds rows in a private Map, so we
    // can't directly mutate installationId — instead we (a) flip status to
    // 'live' via the existing API and (b) keep a side-map of bound install
    // ids that we splice in on read (see `get` override below).
    await this.updateStatus(input.publicationId, "live");
    this.boundInstalls.set(input.publicationId, input.installationId);
    const existing = this.creds.get(input.publicationId);
    this.creds.set(input.publicationId, {
      clientId: existing?.clientId ?? "",
      clientSecretCipher: existing?.clientSecretCipher ?? "",
      signingSecretCipher: existing?.signingSecretCipher ?? "",
      slackAppId: input.slackAppId,
    });
  }

  // Override get to inject the bound installationId we tracked in
  // bindInstallation. The base class's installationId field stayed at "" so
  // we patch it on read.
  private boundInstalls = new Map<string, string>();
  override async get(id: string): Promise<Publication | null> {
    const row = await super.get(id);
    if (!row) return null;
    const bound = this.boundInstalls.get(id);
    return bound ? { ...row, installationId: bound } : row;
  }

  override async listByInstallation(installationId: string): Promise<readonly Publication[]> {
    // Have to honor bound rows too.
    const allBound = [...this.boundInstalls.entries()]
      .filter(([, instId]) => instId === installationId)
      .map(([pid]) => pid);
    const rows = await Promise.all(allBound.map((p) => this.get(p)));
    return rows.filter((r): r is Publication => r !== null);
  }

  async findBySlackAppId(slackAppId: string): Promise<Publication | null> {
    for (const [pubId, cred] of this.creds.entries()) {
      if (cred.slackAppId === slackAppId) {
        return await this.get(pubId);
      }
    }
    return null;
  }
}

/**
 * Slack-flavored in-memory SessionScopeRepo with per_channel methods
 * (armPendingScan / clearPendingScan / updateChannelName) on top of the base
 * SessionScopeRepo contract. Doesn't extend InMemorySessionScopeRepo because
 * the base stores plain SessionScope rows that lose the per_channel fields
 * across updateStatus; cleaner to own the Map directly.
 */
export class FakeSlackSessionScopeRepo implements SlackSessionScopeRepo {
  private rows = new Map<
    string,
    import("../../packages/integrations-core/src/domain").SessionScope
  >();

  private key(publicationId: string, scopeKey: string): string {
    return `${publicationId}:${scopeKey}`;
  }

  async getByScope(
    publicationId: string,
    scopeKey: string,
  ): Promise<import("../../packages/integrations-core/src/domain").SessionScope | null> {
    return this.rows.get(this.key(publicationId, scopeKey)) ?? null;
  }

  async insert(
    row: import("../../packages/integrations-core/src/domain").SessionScope,
  ): Promise<boolean> {
    const k = this.key(row.publicationId, row.scopeKey);
    if (this.rows.has(k)) return false;
    this.rows.set(k, row);
    return true;
  }

  async updateStatus(
    publicationId: string,
    scopeKey: string,
    status: import("../../packages/integrations-core/src/domain").SessionScopeStatus,
  ): Promise<void> {
    const k = this.key(publicationId, scopeKey);
    const row = this.rows.get(k);
    if (row) this.rows.set(k, { ...row, status });
  }

  async reassignIfInactive(
    publicationId: string,
    scopeKey: string,
    newSessionId: string,
    now: number,
  ): Promise<boolean> {
    const k = this.key(publicationId, scopeKey);
    const row = this.rows.get(k);
    if (!row) return false;
    if (row.status === "active") return false;
    if (row.status === "pending" && now - row.createdAt < 60_000) return false;
    this.rows.set(k, { ...row, sessionId: newSessionId, status: "active" });
    return true;
  }

  async claimPending(args: {
    tenantId: string;
    publicationId: string;
    scopeKey: string;
    placeholderSessionId: string;
    now: number;
  }): Promise<boolean> {
    const k = this.key(args.publicationId, args.scopeKey);
    if (this.rows.has(k)) return false;
    this.rows.set(k, {
      tenantId: args.tenantId,
      publicationId: args.publicationId,
      scopeKey: args.scopeKey,
      sessionId: args.placeholderSessionId,
      status: "pending",
      createdAt: args.now,
      pendingScanUntil: null,
      lastScanAt: null,
      channelName: null,
    });
    return true;
  }

  async fulfillPending(
    publicationId: string,
    scopeKey: string,
    sessionId: string,
  ): Promise<boolean> {
    const k = this.key(publicationId, scopeKey);
    const row = this.rows.get(k);
    if (!row || row.status !== "pending") return false;
    this.rows.set(k, { ...row, sessionId, status: "active" });
    return true;
  }

  async releasePending(publicationId: string, scopeKey: string): Promise<void> {
    const k = this.key(publicationId, scopeKey);
    const row = this.rows.get(k);
    if (row && row.status === "pending") this.rows.delete(k);
  }

  async listActive(
    publicationId: string,
  ): Promise<readonly import("../../packages/integrations-core/src/domain").SessionScope[]> {
    return [...this.rows.values()].filter(
      (r) => r.publicationId === publicationId && r.status === "active",
    );
  }

  async armPendingScan(
    publicationId: string,
    scopeKey: string,
    until: number,
    now: number,
  ): Promise<{ armed: boolean; currentUntil: number | null }> {
    const k = this.key(publicationId, scopeKey);
    const row = this.rows.get(k);
    if (!row) return { armed: false, currentUntil: null };
    const current = row.pendingScanUntil ?? null;
    if (current === null || current <= now) {
      this.rows.set(k, { ...row, pendingScanUntil: until });
      return { armed: true, currentUntil: null };
    }
    return { armed: false, currentUntil: current };
  }

  async clearPendingScan(publicationId: string, scopeKey: string): Promise<void> {
    const k = this.key(publicationId, scopeKey);
    const row = this.rows.get(k);
    if (row) this.rows.set(k, { ...row, pendingScanUntil: null });
  }

  async updateChannelName(
    publicationId: string,
    scopeKey: string,
    channelName: string,
  ): Promise<void> {
    const k = this.key(publicationId, scopeKey);
    const row = this.rows.get(k);
    if (row) this.rows.set(k, { ...row, channelName });
  }

  async closeAllForPublication(publicationId: string): Promise<void> {
    for (const [k, row] of this.rows.entries()) {
      if (row.publicationId === publicationId && row.status === "active") {
        this.rows.set(k, { ...row, status: "completed", pendingScanUntil: null });
      }
    }
  }
}

export interface FakeSlackBundle extends Omit<FakeContainer, "installations" | "publications" | "sessionScopes"> {
  installations: FakeSlackInstallationRepo;
  publications: FakeSlackPublicationRepo;
  sessionScopes: FakeSlackSessionScopeRepo;
}

export function buildFakeSlackContainer(): FakeSlackBundle {
  const base = buildFakeContainer();
  return {
    ...base,
    installations: new FakeSlackInstallationRepo(base.clock),
    publications: new FakeSlackPublicationRepo(base.clock),
    sessionScopes: new FakeSlackSessionScopeRepo(),
  };
}

export function makeSlackProvider(
  c: FakeSlackBundle,
  overrides?: Partial<{ gatewayOrigin: string; defaultSessionGranularity: SessionGranularity }>,
): SlackProvider {
  return new SlackProvider(c as SlackContainer, {
    gatewayOrigin: overrides?.gatewayOrigin ?? "https://gw",
    botScopes: DEFAULT_SLACK_BOT_SCOPES,
    userScopes: DEFAULT_SLACK_USER_SCOPES,
    defaultCapabilities: ALL_SLACK_CAPABILITIES,
    defaultSessionGranularity: overrides?.defaultSessionGranularity,
  });
}

/**
 * Token-exchange response fixture. Returns the JSON string the SlackProvider
 * expects from `oauth.v2.access`.
 */
export function tokenResponseBody(opts?: {
  bot?: string;
  user?: string;
  teamId?: string;
  teamName?: string;
}): string {
  return JSON.stringify({
    ok: true,
    access_token: opts?.bot ?? "xoxb-bot-test",
    token_type: "bot",
    scope: "app_mentions:read,chat:write",
    bot_user_id: "U07BOT",
    app_id: "A07APP",
    team: { id: opts?.teamId ?? "T07TEAM", name: opts?.teamName ?? "Acme" },
    enterprise: null,
    authed_user: {
      id: "U07USER",
      scope: "search:read.public,channels:history",
      access_token: opts?.user ?? "xoxp-user-test",
      token_type: "user",
    },
  });
}

/**
 * Seeds a dedicated-mode Slack publication: app row, installation row with
 * vault ids, and a live publication. Returns the ids most tests need.
 *
 * `signingSecret` is stored both on the slack_apps row (legacy lookup path
 * the webhook handler still falls back to) and on the slack_publications row
 * (publication-first lookup path the new flow uses). Tests assert against
 * either; provider chooses publication-first when both are present.
 */
export async function seedDedicatedSlackPublication(
  c: FakeSlackBundle,
  opts: { signingSecret: string; sessionGranularity?: SessionGranularity },
): Promise<{ instId: string; pubId: string; appId: string }> {
  const app = await c.apps.insert({
    tenantId: "tn_for_usr_a",
    publicationId: null,
    clientId: "cid",
    clientSecret: "csec",
    webhookSecret: opts.signingSecret,
  });
  const inst = await c.installations.insert({
    tenantId: "tn_for_usr_a",
    userId: "usr_a",
    providerId: "slack",
    workspaceId: "T07TEAM",
    workspaceName: "Acme",
    installKind: "dedicated",
    appId: app.id,
    accessToken: "xoxb-bot",
    refreshToken: null,
    scopes: ["bot:app_mentions:read", "user:search:read.public"],
    botUserId: "U07BOT",
  });
  await c.installations.setVaultId(inst.id, "vlt_user_xoxp");
  await c.installations.setBotVaultId(inst.id, "vlt_bot_xoxb");
  const pub = await c.publications.insertShell({
    tenantId: "tn_for_usr_a",
    userId: "usr_a",
    agentId: "agt_default",
    environmentId: "env_dev",
    persona: { name: "Triage", avatarUrl: null },
    capabilities: new Set(),
    sessionGranularity: opts.sessionGranularity ?? "per_thread",
  });
  await c.publications.setCredentials(pub.id, {
    clientId: "cid",
    clientSecretCipher: `enc(csec)`,
    signingSecretCipher: `enc(${opts.signingSecret})`,
  });
  await c.publications.bindInstallation({
    publicationId: pub.id,
    installationId: inst.id,
    slackAppId: app.id,
  });
  await c.apps.setPublicationId(app.id, pub.id);
  return { instId: inst.id, pubId: pub.id, appId: app.id };
}

/** app_mention envelope as a JSON string (for handleWebhook tests). */
export function appMentionPayload(opts: {
  channel: string;
  ts: string;
  thread_ts?: string;
  eventId: string;
  user?: string;
  text?: string;
}): string {
  return JSON.stringify({
    type: "event_callback",
    event_id: opts.eventId,
    event_time: 1_700_000_000,
    team_id: "T07TEAM",
    api_app_id: "A07APP",
    event: {
      type: "app_mention",
      channel: opts.channel,
      ts: opts.ts,
      thread_ts: opts.thread_ts,
      user: opts.user ?? "U0USER",
      text: opts.text ?? "<@U07BOT> hello",
      event_ts: opts.ts,
    },
  });
}

/** url_verification challenge envelope as a JSON string. */
export function urlVerificationPayload(challenge: string): string {
  return JSON.stringify({
    type: "url_verification",
    token: "legacy_token",
    challenge,
  });
}

/**
 * Plain `message` event envelope (NOT an `app_mention`). Use to test
 * channel chatter, thread continuations, and DMs.
 */
export function messagePayload(opts: {
  channel: string;
  channelType?: "channel" | "im" | "group" | "mpim";
  ts: string;
  thread_ts?: string;
  eventId: string;
  user?: string;
  text?: string;
}): string {
  return JSON.stringify({
    type: "event_callback",
    event_id: opts.eventId,
    event_time: 1_700_000_000,
    team_id: "T07TEAM",
    api_app_id: "A07APP",
    event: {
      type: "message",
      channel: opts.channel,
      channel_type: opts.channelType ?? "channel",
      ts: opts.ts,
      thread_ts: opts.thread_ts,
      user: opts.user ?? "U0USER",
      text: opts.text ?? "hello",
      event_ts: opts.ts,
    },
  });
}

/** member_joined_channel envelope. user defaults to bot id. */
export function memberJoinedChannelPayload(opts: {
  channel: string;
  eventId: string;
  user?: string;
}): string {
  return JSON.stringify({
    type: "event_callback",
    event_id: opts.eventId,
    event_time: 1_700_000_000,
    team_id: "T07TEAM",
    api_app_id: "A07APP",
    event: {
      type: "member_joined_channel",
      channel: opts.channel,
      user: opts.user ?? "U07BOT",
      event_ts: "1700000000.000100",
    },
  });
}

/** member_left_channel envelope. */
export function memberLeftChannelPayload(opts: {
  channel: string;
  eventId: string;
  user?: string;
}): string {
  return JSON.stringify({
    type: "event_callback",
    event_id: opts.eventId,
    event_time: 1_700_000_000,
    team_id: "T07TEAM",
    api_app_id: "A07APP",
    event: {
      type: "member_left_channel",
      channel: opts.channel,
      user: opts.user ?? "U07BOT",
      event_ts: "1700000000.000200",
    },
  });
}

/** channel_archive / channel_unarchive envelope. */
export function channelLifecyclePayload(opts: {
  type: "channel_archive" | "channel_unarchive";
  channel: string;
  eventId: string;
  user?: string;
}): string {
  return JSON.stringify({
    type: "event_callback",
    event_id: opts.eventId,
    event_time: 1_700_000_000,
    team_id: "T07TEAM",
    api_app_id: "A07APP",
    event: {
      type: opts.type,
      channel: opts.channel,
      user: opts.user ?? "U07ADMIN",
      event_ts: "1700000000.000300",
    },
  });
}

/** channel_rename envelope — channel field is `{ id, name }`. */
export function channelRenamePayload(opts: {
  channelId: string;
  newName: string;
  eventId: string;
}): string {
  return JSON.stringify({
    type: "event_callback",
    event_id: opts.eventId,
    event_time: 1_700_000_000,
    team_id: "T07TEAM",
    api_app_id: "A07APP",
    event: {
      type: "channel_rename",
      channel: { id: opts.channelId, name: opts.newName, created: 1_700_000_000 },
      event_ts: "1700000000.000400",
    },
  });
}

/** reaction_added / reaction_removed envelope. */
export function reactionPayload(opts: {
  type: "reaction_added" | "reaction_removed";
  channel: string;
  itemTs: string;
  itemUser?: string;
  reaction?: string;
  eventId: string;
  user?: string;
}): string {
  return JSON.stringify({
    type: "event_callback",
    event_id: opts.eventId,
    event_time: 1_700_000_000,
    team_id: "T07TEAM",
    api_app_id: "A07APP",
    event: {
      type: opts.type,
      user: opts.user ?? "U0USER",
      reaction: opts.reaction ?? "thumbsup",
      item: {
        type: "message",
        channel: opts.channel,
        ts: opts.itemTs,
      },
      item_user: opts.itemUser ?? "U07BOT",
      event_ts: "1700000000.000500",
    },
  });
}
