// In-memory fakes for GitHub-specific ports.
//
// Counterpart to the test-fakes from integrations-core, narrowed to the
// publication-first GitHubPublicationRepo. Lives in this package because
// integrations-core can't depend on @open-managed-agents/github (one-way
// dependency).
//
// These fakes are intentionally simple: maps + arrays, no concurrency
// guards. Tests should treat each instance as single-threaded.

import {
  InMemoryPublicationRepo,
  buildFakeContainer,
  type FakeContainer,
} from "../../integrations-core/src/test-fakes";
import type {
  CapabilityKey,
  Persona,
  Publication,
  SessionGranularity,
  SessionId,
  Clock,
} from "@open-managed-agents/integrations-core";

import type {
  GitHubIssueSession,
  GitHubIssueSessionRepo,
  GitHubIssueSessionStatus,
  GitHubPublicationCredentialState,
  GitHubPublicationRepo,
} from "./ports";
import type { GitHubContainer } from "./provider";

/**
 * In-memory fake of GitHubPublicationRepo. Extends the base fake so all
 * the regular `get` / `listByXxx` / `insert` / `updateStatus` methods
 * still work — adds the publication-first surface
 * (`insertShell` / `setCredentials` / `bindInstallation` / etc.) on top.
 *
 * Cipher fields are stored as `enc(<plaintext>)` (matching FakeCrypto's
 * format) so test assertions can decode them with the same helper.
 */
export class InMemoryGitHubPublicationRepo
  extends InMemoryPublicationRepo
  implements GitHubPublicationRepo
{
  // Parallel maps for the publication-first state. Keep them on the
  // subclass so the base fake stays unaware of github concerns.
  private appOmaIds = new Map<string, string>();
  private appIds = new Map<string, string>();
  private appSlugs = new Map<string, string>();
  private botLogins = new Map<string, string>();
  private clientIds = new Map<string, string>();
  private clientSecrets = new Map<string, string>();
  private webhookSecrets = new Map<string, string>();
  private privateKeys = new Map<string, string>();
  private vaultIds = new Map<string, string>();

  // Track installation_id overrides applied by bindInstallation. The base
  // fake stores rows in a private map we can't reach; this side-channel
  // lets `get()` merge the bound id back in.
  private boundInstallations = new Map<
    string,
    { installationId: string; vaultId: string }
  >();

  private idsCounter = 0;

  constructor(clock?: Clock) {
    super(clock as Clock);
  }

  // GitHub's publication-first signatures diverge from the linear-flavored
  // ones the base InMemoryPublicationRepo now exposes (different return
  // shape, different credential payload). The base methods exist for
  // Linear; GitHub's specialized variants override them with stricter
  // GH-specific shapes. ts-expect-error swallows the structural mismatch
  // since this is a test fake — production runs against the D1 / SQL
  // adapters which don't share the InMemory base.
  // @ts-expect-error — github test fake intentionally diverges from base
  async insertShell(input: {
    tenantId: string;
    userId: string;
    agentId: string;
    environmentId: string;
    persona: Persona;
    capabilities: ReadonlySet<CapabilityKey>;
    sessionGranularity: SessionGranularity;
  }): Promise<{ publication: Publication; appOmaId: string }> {
    const publication = await this.insert({
      tenantId: input.tenantId,
      userId: input.userId,
      agentId: input.agentId,
      installationId: "",
      environmentId: input.environmentId,
      mode: "full",
      status: "pending_setup",
      persona: input.persona,
      capabilities: input.capabilities,
      sessionGranularity: input.sessionGranularity,
    });
    this.idsCounter += 1;
    const appOmaId = `ghapp_fake_${this.idsCounter}`;
    this.appOmaIds.set(publication.id, appOmaId);
    return { publication, appOmaId };
  }

  // @ts-expect-error — github test fake intentionally diverges from base
  async setCredentials(
    publicationId: string,
    input: {
      appId: string;
      appSlug: string;
      botLogin: string;
      clientId: string | null;
      clientSecretCipher: string | null;
      webhookSecretCipher: string;
      privateKeyCipher: string;
    },
  ): Promise<void> {
    const pub = await this.get(publicationId);
    if (!pub) {
      throw new Error(`setCredentials: publication ${publicationId} not found`);
    }
    if (pub.status === "unpublished") {
      throw new Error(
        `setCredentials: publication ${publicationId} is unpublished — restart the publish flow`,
      );
    }
    this.appIds.set(publicationId, input.appId);
    this.appSlugs.set(publicationId, input.appSlug);
    this.botLogins.set(publicationId, input.botLogin);
    if (input.clientId != null) this.clientIds.set(publicationId, input.clientId);
    else this.clientIds.delete(publicationId);
    if (input.clientSecretCipher != null) {
      this.clientSecrets.set(publicationId, decode(input.clientSecretCipher));
    } else {
      this.clientSecrets.delete(publicationId);
    }
    this.webhookSecrets.set(publicationId, decode(input.webhookSecretCipher));
    this.privateKeys.set(publicationId, decode(input.privateKeyCipher));
    if (pub.status === "pending_setup") {
      await this.updateStatus(publicationId, "credentials_filled");
    }
  }

  async getClientSecret(publicationId: string): Promise<string | null> {
    return this.clientSecrets.get(publicationId) ?? null;
  }

  async getWebhookSecret(publicationId: string): Promise<string | null> {
    return this.webhookSecrets.get(publicationId) ?? null;
  }

  async getPrivateKey(publicationId: string): Promise<string | null> {
    return this.privateKeys.get(publicationId) ?? null;
  }

  async getCredentialState(
    publicationId: string,
  ): Promise<GitHubPublicationCredentialState | null> {
    const pub = await this.get(publicationId);
    if (!pub) return null;
    return {
      appOmaId: this.appOmaIds.get(publicationId) ?? null,
      appId: this.appIds.get(publicationId) ?? null,
      appSlug: this.appSlugs.get(publicationId) ?? null,
      botLogin: this.botLogins.get(publicationId) ?? null,
      clientId: this.clientIds.get(publicationId) ?? null,
      hasClientSecret: this.clientSecrets.has(publicationId),
      hasWebhookSecret: this.webhookSecrets.has(publicationId),
      hasPrivateKey: this.privateKeys.has(publicationId),
      vaultId: this.vaultIds.get(publicationId) ?? null,
    };
  }

  // @ts-expect-error — github test fake intentionally diverges from base
  async bindInstallation(input: {
    publicationId: string;
    installationId: string;
    vaultId: string;
  }): Promise<void> {
    const pub = await this.get(input.publicationId);
    if (!pub) {
      throw new Error(
        `bindInstallation: publication ${input.publicationId} not found`,
      );
    }
    this.boundInstallations.set(input.publicationId, {
      installationId: input.installationId,
      vaultId: input.vaultId,
    });
    await this.updateStatus(input.publicationId, "live");
    this.vaultIds.set(input.publicationId, input.vaultId);
  }

  // Override get so bindInstallation's effect is visible to tests.
  // Merges the base row with any bound installation/vault overlay.
  override async get(id: string): Promise<Publication | null> {
    const base = await super.get(id);
    if (!base) return null;
    const bound = this.boundInstallations.get(id);
    if (!bound) return base;
    return { ...base, installationId: bound.installationId };
  }

  async findByAppOmaId(appOmaId: string): Promise<Publication | null> {
    for (const [pubId, mapped] of this.appOmaIds.entries()) {
      if (mapped === appOmaId) return this.get(pubId);
    }
    return null;
  }

  private triggerLabels = new Map<string, string>();

  async getTriggerLabel(publicationId: string): Promise<string | null> {
    return this.triggerLabels.get(publicationId) ?? null;
  }

  async setTriggerLabel(publicationId: string, label: string): Promise<void> {
    this.triggerLabels.set(publicationId, label);
  }
}

/**
 * In-memory fake of GitHubIssueSessionRepo. GitHub-only — webhook-mode
 * two-phase claim, no PAT-mode `claim`. Mirrors the SQL/D1 adapter's
 * INSERT OR IGNORE / UPDATE WHERE status='pending' / DELETE WHERE
 * status='pending' semantics.
 */
export class InMemoryGitHubIssueSessionRepo implements GitHubIssueSessionRepo {
  private rows = new Map<string, GitHubIssueSession>();

  private key(publicationId: string, issueId: string): string {
    return `${publicationId}:${issueId}`;
  }

  async getByIssue(
    publicationId: string,
    issueId: string,
  ): Promise<GitHubIssueSession | null> {
    return this.rows.get(this.key(publicationId, issueId)) ?? null;
  }

  async claimPending(args: {
    tenantId: string;
    publicationId: string;
    issueId: string;
    nowMs: number;
  }): Promise<boolean> {
    const k = this.key(args.publicationId, args.issueId);
    if (this.rows.has(k)) return false; // INSERT OR IGNORE semantics
    this.rows.set(k, {
      tenantId: args.tenantId,
      publicationId: args.publicationId,
      issueId: args.issueId,
      sessionId: "",
      status: "pending",
      createdAt: args.nowMs,
    });
    return true;
  }

  async fulfillPending(
    publicationId: string,
    issueId: string,
    sessionId: SessionId,
  ): Promise<boolean> {
    const k = this.key(publicationId, issueId);
    const row = this.rows.get(k);
    if (!row || row.status !== "pending") return false;
    this.rows.set(k, { ...row, sessionId, status: "active" });
    return true;
  }

  async releasePending(publicationId: string, issueId: string): Promise<void> {
    const k = this.key(publicationId, issueId);
    const row = this.rows.get(k);
    if (row && row.status === "pending") this.rows.delete(k);
  }
}

/** Strips the `enc(...)` wrapper FakeCrypto applies. Provider tests pass
 *  cipher strings produced by FakeCrypto.encrypt — we decode here so the
 *  fake's internal storage holds plaintext (mirrors what real D1 would
 *  do via Crypto.decrypt on read). */
function decode(cipher: string): string {
  if (cipher.startsWith("enc(") && cipher.endsWith(")")) {
    return cipher.slice(4, -1);
  }
  return cipher;
}

/**
 * FakeContainer with `publications` swapped for the github-flavored fake.
 * Tests construct this via buildFakeGitHubContainer and pass it to
 * `new GitHubProvider(c, ...)` — the publications slot satisfies
 * GitHubPublicationRepo while the rest of the container remains the
 * generic FakeContainer.
 *
 * Linear/Slack tests don't need this — they keep using buildFakeContainer
 * directly (their providers don't narrow the publications slot).
 */
export type FakeGitHubContainer = Omit<FakeContainer, "publications"> & {
  publications: InMemoryGitHubPublicationRepo;
  githubIssueSessions: InMemoryGitHubIssueSessionRepo;
};

export function buildFakeGitHubContainer(): FakeGitHubContainer {
  const base = buildFakeContainer();
  const publications = new InMemoryGitHubPublicationRepo(base.clock);
  const githubIssueSessions = new InMemoryGitHubIssueSessionRepo();
  return { ...base, publications, githubIssueSessions };
}

