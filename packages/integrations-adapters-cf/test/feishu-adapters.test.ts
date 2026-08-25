// SQL adapter integration tests for the five Feishu repos.
//
// Uses better-sqlite3 + Drizzle against the schema inlined from
// apps/main/migrations-integrations/0008_feishu_publication_first.sql.
// Tests the repos against the same SQLite dialect CF D1 uses in prod,
// so any Drizzle schema/typo regression fires here.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OmaDb } from "@open-managed-agents/db-schema";
import {
  WebCryptoAesGcm,
  CryptoIdGenerator,
  SqlFeishuInstallationRepo,
  SqlFeishuPublicationRepo,
  SqlFeishuSessionScopeRepo,
  SqlFeishuSetupLinkRepo,
  SqlFeishuWebhookEventStore,
} from "../src";

// Same DDL as apps/main/migrations-integrations/0008_feishu_publication_first.sql,
// inlined to avoid pulling apps/main migrations into this package's test
// graph. If you change the migration, mirror the change here.
const SCHEMA_SQL = `
CREATE TABLE feishu_apps (
  id text PRIMARY KEY NOT NULL,
  tenant_id text NOT NULL,
  publication_id text,
  app_id text NOT NULL,
  app_secret_cipher text NOT NULL,
  verification_token_cipher text NOT NULL,
  encrypt_key_cipher text NOT NULL,
  created_at integer NOT NULL
);
CREATE UNIQUE INDEX feishu_apps_publication_id_unique ON feishu_apps (publication_id);
CREATE INDEX idx_feishu_apps_tenant ON feishu_apps (tenant_id);

CREATE TABLE feishu_installations (
  id text PRIMARY KEY NOT NULL,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  provider_id text NOT NULL,
  workspace_id text NOT NULL,
  workspace_name text NOT NULL,
  install_kind text NOT NULL,
  app_id text,
  tenant_access_token_cipher text NOT NULL,
  expires_at integer NOT NULL,
  scopes text NOT NULL,
  bot_open_id text,
  vault_id text,
  created_at integer NOT NULL,
  revoked_at integer
);
CREATE UNIQUE INDEX idx_feishu_installations_active
  ON feishu_installations (provider_id, workspace_id, install_kind, COALESCE("app_id", ''))
  WHERE "feishu_installations"."revoked_at" IS NULL;
CREATE INDEX idx_feishu_installations_user ON feishu_installations (user_id, provider_id);
CREATE INDEX idx_feishu_installations_tenant ON feishu_installations (tenant_id);

CREATE TABLE feishu_publications (
  id text PRIMARY KEY NOT NULL,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  agent_id text NOT NULL,
  installation_id text NOT NULL,
  environment_id text NOT NULL,
  mode text NOT NULL,
  status text NOT NULL,
  persona_name text NOT NULL,
  persona_avatar_url text,
  capabilities text NOT NULL,
  session_granularity text NOT NULL,
  created_at integer NOT NULL,
  unpublished_at integer,
  app_id text,
  app_secret_cipher text,
  verification_token_cipher text,
  encrypt_key_cipher text
);
CREATE INDEX idx_feishu_publications_installation ON feishu_publications (installation_id);
CREATE INDEX idx_feishu_publications_user_agent ON feishu_publications (user_id, agent_id);
CREATE INDEX idx_feishu_publications_tenant ON feishu_publications (tenant_id);
CREATE INDEX idx_feishu_publications_app_id ON feishu_publications (app_id);

CREATE TABLE feishu_setup_links (
  token text PRIMARY KEY NOT NULL,
  tenant_id text NOT NULL,
  publication_id text NOT NULL,
  created_by text NOT NULL,
  expires_at integer NOT NULL,
  used_at integer,
  used_by_email text
);
CREATE INDEX idx_feishu_setup_links_expires ON feishu_setup_links (expires_at);
CREATE INDEX idx_feishu_setup_links_tenant ON feishu_setup_links (tenant_id);

CREATE TABLE feishu_thread_sessions (
  publication_id text NOT NULL,
  tenant_id text NOT NULL,
  scope_key text NOT NULL,
  session_id text NOT NULL,
  status text NOT NULL,
  created_at integer NOT NULL,
  chat_name text,
  PRIMARY KEY(publication_id, scope_key)
);
CREATE INDEX idx_feishu_thread_sessions_active ON feishu_thread_sessions (publication_id, status);
CREATE INDEX idx_feishu_thread_sessions_tenant ON feishu_thread_sessions (tenant_id);

CREATE TABLE feishu_webhook_events (
  delivery_id text PRIMARY KEY NOT NULL,
  tenant_id text NOT NULL,
  installation_id text NOT NULL,
  publication_id text,
  event_type text NOT NULL,
  received_at integer NOT NULL,
  session_id text,
  error text
);
CREATE INDEX idx_feishu_webhook_events_received ON feishu_webhook_events (received_at DESC);
CREATE INDEX idx_feishu_webhook_events_tenant ON feishu_webhook_events (tenant_id, received_at DESC);
`;

const PLATFORM_SECRET = "test-secret-32bytes-min-1234567890";

describe("feishu SQL adapters", () => {
  let tmpDir: string;
  let raw: BetterSqlite3.Database;
  let drz: BetterSQLite3Database;
  let crypto: WebCryptoAesGcm;
  let ids: CryptoIdGenerator;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "oma-feishu-adapters-"));
    const dbPath = join(tmpDir, "feishu.db");
    raw = new BetterSqlite3(dbPath);
    raw.exec(SCHEMA_SQL);
    drz = drizzle(raw);
    crypto = new WebCryptoAesGcm(PLATFORM_SECRET, "integrations.tokens");
    ids = new CryptoIdGenerator();
  });

  // Crypto.encrypt is async (Web Crypto subtle.encrypt); SQL binds are
  // sync. Helper returns a Promise<string>; tests `await` it before
  // passing the ciphertext into repo methods.
  const enc = async (plain: string): Promise<string> => crypto.encrypt(plain);

  afterAll(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Wipe row-level state between tests; the schema survives.
    raw.exec(`
      DELETE FROM feishu_webhook_events;
      DELETE FROM feishu_thread_sessions;
      DELETE FROM feishu_setup_links;
      DELETE FROM feishu_publications;
      DELETE FROM feishu_installations;
      DELETE FROM feishu_apps;
    `);
  });

  // ─── Installation repo ───────────────────────────────────────────────

  describe("SqlFeishuInstallationRepo", () => {
    it("inserts and round-trips an installation", async () => {
      const repo = new SqlFeishuInstallationRepo(drz as unknown as OmaDb, crypto, ids);
      const inst = await repo.insert({
        tenantId: "tn_1",
        userId: "u_1",
        providerId: "feishu",
        workspaceId: "ws_1",
        workspaceName: "Acme Co",
        installKind: "dedicated",
        appId: "cli_app",
        scopes: ["im:message"],
      });
      await repo.setTenantAccessToken(inst.id, "t-abc", 9_999_999_999);

      const fetched = await repo.get(inst.id);
      expect(fetched).not.toBeNull();
      expect(fetched?.workspaceId).toBe("ws_1");
      // botOpenId column was never inserted → Drizzle returns undefined.
      // The toDomain mapper preserves it; the contract is "absent".
      expect(fetched?.botOpenId ?? null).toBeNull();

      const tok = await repo.getTenantAccessToken(inst.id);
      expect(tok).toBe("t-abc");
    });

    it("lists installations by user filtered to feishu", async () => {
      const repo = new SqlFeishuInstallationRepo(drz as unknown as OmaDb, crypto, ids);
      await repo.insert({
        tenantId: "tn_1",
        userId: "u_1",
        providerId: "feishu",
        workspaceId: "ws_1",
        workspaceName: "Acme",
        installKind: "dedicated",
        appId: "cli_1",
        scopes: [],
      });
      await repo.insert({
        tenantId: "tn_1",
        userId: "u_1",
        providerId: "github", // different provider — should NOT appear in list
        workspaceId: "ws_x",
        workspaceName: "GH Co",
        installKind: "dedicated",
        appId: "gh_1",
        scopes: [],
      });

      const feishuInstalls = await repo.listByUser("u_1", "feishu");
      expect(feishuInstalls).toHaveLength(1);
      expect(feishuInstalls[0]?.providerId).toBe("feishu");
    });

    it("rotates tenant_access_token", async () => {
      const repo = new SqlFeishuInstallationRepo(drz as unknown as OmaDb, crypto, ids);
      const inst = await repo.insert({
        tenantId: "tn_1",
        userId: "u_1",
        providerId: "feishu",
        workspaceId: "ws_1",
        workspaceName: "Acme",
        installKind: "dedicated",
        appId: "cli_1",
        scopes: [],
      });
      await repo.setTenantAccessToken(inst.id, "old", 1);
      await repo.setTenantAccessToken(inst.id, "new", 9_999_999_999);
      expect(await repo.getTenantAccessToken(inst.id)).toBe("new");
    });

    it("marks an installation revoked", async () => {
      const repo = new SqlFeishuInstallationRepo(drz as unknown as OmaDb, crypto, ids);
      const inst = await repo.insert({
        tenantId: "tn_1",
        userId: "u_1",
        providerId: "feishu",
        workspaceId: "ws_1",
        workspaceName: "Acme",
        installKind: "dedicated",
        appId: "cli_1",
        scopes: [],
      });
      await repo.markRevoked(inst.id, Date.now());
      // get() returns the row regardless of revoked_at — the install is
      // filtered out via listByUser/active-install index, not on direct
      // get. Verify the revoked_at timestamp is set instead.
      const reloaded = await repo.get(inst.id);
      expect(reloaded?.revokedAt).toBeGreaterThan(0);
    });

    it("returns null tenant_access_token for unknown id", async () => {
      const repo = new SqlFeishuInstallationRepo(drz as unknown as OmaDb, crypto, ids);
      expect(await repo.getTenantAccessToken("does-not-exist")).toBeNull();
    });

    it("returns null for unknown installation id", async () => {
      const repo = new SqlFeishuInstallationRepo(drz as unknown as OmaDb, crypto, ids);
      expect(await repo.get("does-not-exist")).toBeNull();
    });
  });

  // ─── Publication repo ────────────────────────────────────────────────

  describe("SqlFeishuPublicationRepo", () => {
    it("inserts a shell and binds an installation later", async () => {
      const pubRepo = new SqlFeishuPublicationRepo(drz as unknown as OmaDb, ids, crypto);
      const shell = await pubRepo.insertShell({
        tenantId: "tn_1",
        userId: "u_1",
        agentId: "ag_1",
        environmentId: "env_1",
        persona: { name: "Bot", avatarUrl: null },
        capabilities: new Set(["im.message.send"]),
        sessionGranularity: "per_chat_user",
      });
      expect(shell.status).toBe("pending_setup");
      expect(shell.installationId).toBe("");

      await pubRepo.bindInstallation({ publicationId: shell.id, installationId: "inst_1" });
      const reloaded = await pubRepo.get(shell.id);
      expect(reloaded?.status).toBe("live");
      expect(reloaded?.installationId).toBe("inst_1");
    });

    it("encrypts 4 secrets on setCredentials and decrypts on read", async () => {
      const pubRepo = new SqlFeishuPublicationRepo(drz as unknown as OmaDb, ids, crypto);
      const shell = await pubRepo.insertShell({
        tenantId: "tn_1",
        userId: "u_1",
        agentId: "ag_1",
        environmentId: "env_1",
        persona: { name: "Bot", avatarUrl: null },
        capabilities: new Set(["im.message.send"]),
        sessionGranularity: "per_chat",
      });
      await pubRepo.setCredentials(shell.id, {
        appId: "cli_xyz",
        appSecretCipher: await enc("the-app-secret"),
        verificationTokenCipher: await enc("the-vt"),
        encryptKeyCipher: await enc("the-ek"),
      });
      const reloaded = await pubRepo.get(shell.id);
      expect(reloaded?.status).toBe("credentials_filled");

      expect(await pubRepo.getAppSecret(shell.id)).toBe("the-app-secret");
      expect(await pubRepo.getVerificationToken(shell.id)).toBe("the-vt");
      expect(await pubRepo.getEncryptKey(shell.id)).toBe("the-ek");
    });

    it("returns null for missing secrets", async () => {
      const pubRepo = new SqlFeishuPublicationRepo(drz as unknown as OmaDb, ids, crypto);
      const shell = await pubRepo.insertShell({
        tenantId: "tn_1",
        userId: "u_1",
        agentId: "ag_1",
        environmentId: "env_1",
        persona: { name: "Bot", avatarUrl: null },
        capabilities: new Set([]),
        sessionGranularity: "per_chat",
      });
      expect(await pubRepo.getAppSecret(shell.id)).toBeNull();
      expect(await pubRepo.getEncryptKey(shell.id)).toBeNull();
      expect(await pubRepo.getVerificationToken(shell.id)).toBeNull();
    });

    it("updates capabilities, persona, and status", async () => {
      const pubRepo = new SqlFeishuPublicationRepo(drz as unknown as OmaDb, ids, crypto);
      const shell = await pubRepo.insertShell({
        tenantId: "tn_1",
        userId: "u_1",
        agentId: "ag_1",
        environmentId: "env_1",
        persona: { name: "Bot", avatarUrl: null },
        capabilities: new Set(["im.message.send"]),
        sessionGranularity: "per_chat",
      });
      await pubRepo.updateCapabilities(shell.id, new Set(["im.message.send", "im.reaction.add"]));
      await pubRepo.updatePersona(shell.id, { name: "Renamed", avatarUrl: "https://x" });
      await pubRepo.updateStatus(shell.id, "needs_reauth");

      const reloaded = await pubRepo.get(shell.id);
      expect(reloaded?.persona.name).toBe("Renamed");
      expect(reloaded?.persona.avatarUrl).toBe("https://x");
      expect([...reloaded!.capabilities].sort()).toEqual(["im.message.send", "im.reaction.add"]);
      expect(reloaded?.status).toBe("needs_reauth");
    });

    it("marks unpublished with timestamp", async () => {
      const pubRepo = new SqlFeishuPublicationRepo(drz as unknown as OmaDb, ids, crypto);
      const shell = await pubRepo.insertShell({
        tenantId: "tn_1",
        userId: "u_1",
        agentId: "ag_1",
        environmentId: "env_1",
        persona: { name: "Bot", avatarUrl: null },
        capabilities: new Set([]),
        sessionGranularity: "per_chat",
      });
      await pubRepo.markUnpublished(shell.id, 12345);
      const reloaded = await pubRepo.get(shell.id);
      expect(reloaded?.status).toBe("unpublished");
      expect(reloaded?.unpublishedAt).toBe(12345);
    });

    it("lists by user and agent", async () => {
      const pubRepo = new SqlFeishuPublicationRepo(drz as unknown as OmaDb, ids, crypto);
      await pubRepo.insertShell({
        tenantId: "tn_1",
        userId: "u_1",
        agentId: "ag_1",
        environmentId: "env_1",
        persona: { name: "A", avatarUrl: null },
        capabilities: new Set([]),
        sessionGranularity: "per_chat",
      });
      await pubRepo.insertShell({
        tenantId: "tn_1",
        userId: "u_1",
        agentId: "ag_1",
        environmentId: "env_1",
        persona: { name: "B", avatarUrl: null },
        capabilities: new Set([]),
        sessionGranularity: "per_chat",
      });
      await pubRepo.insertShell({
        tenantId: "tn_1",
        userId: "u_1",
        agentId: "ag_2", // different agent — excluded
        environmentId: "env_1",
        persona: { name: "C", avatarUrl: null },
        capabilities: new Set([]),
        sessionGranularity: "per_chat",
      });

      const list = await pubRepo.listByUserAndAgent("u_1", "ag_1");
      expect(list).toHaveLength(2);
    });

    it("lists by installation", async () => {
      const pubRepo = new SqlFeishuPublicationRepo(drz as unknown as OmaDb, ids, crypto);
      const shell = await pubRepo.insertShell({
        tenantId: "tn_1",
        userId: "u_1",
        agentId: "ag_1",
        environmentId: "env_1",
        persona: { name: "A", avatarUrl: null },
        capabilities: new Set([]),
        sessionGranularity: "per_chat",
      });
      await pubRepo.bindInstallation({ publicationId: shell.id, installationId: "inst_1" });
      const list = await pubRepo.listByInstallation("inst_1");
      expect(list).toHaveLength(1);
      expect(list[0]?.installationId).toBe("inst_1");
    });

    it("findByAppId returns the publication matching the app id", async () => {
      const pubRepo = new SqlFeishuPublicationRepo(drz as unknown as OmaDb, ids, crypto);
      const shell = await pubRepo.insertShell({
        tenantId: "tn_1",
        userId: "u_1",
        agentId: "ag_1",
        environmentId: "env_1",
        persona: { name: "A", avatarUrl: null },
        capabilities: new Set([]),
        sessionGranularity: "per_chat",
      });
      await pubRepo.setCredentials(shell.id, {
        appId: "cli_lookup",
        appSecretCipher: await enc("s"),
        verificationTokenCipher: await enc("v"),
        encryptKeyCipher: await enc("e"),
      });
      const found = await pubRepo.findByAppId("cli_lookup");
      expect(found?.id).toBe(shell.id);
    });

    it("findByAppId ranks active rows above stale unpublished leftovers", async () => {
      const pubRepo = new SqlFeishuPublicationRepo(drz as unknown as OmaDb, ids, crypto);
      const mkShell = () =>
        pubRepo.insertShell({
          tenantId: "tn_1",
          userId: "u_1",
          agentId: "ag_1",
          environmentId: "env_1",
          persona: { name: "A", avatarUrl: null },
          capabilities: new Set([]),
          sessionGranularity: "per_chat",
        });
      const creds = (id: string) =>
        pubRepo.setCredentials(id, {
          appId: "cli_shared",
          appSecretCipher: "c",
          verificationTokenCipher: "",
          encryptKeyCipher: "",
        });
      // Discarded first attempt leaves an unpublished row for the app…
      const stale = await mkShell();
      await creds(stale.id);
      await pubRepo.markUnpublished(stale.id, Date.now());
      // …then a fresh wizard run reuses the same app.
      const fresh = await mkShell();
      await creds(fresh.id);
      // The stale row must not shadow the pending one (WS runner flip +
      // inbound routing both rely on this lookup).
      const found = await pubRepo.findByAppId("cli_shared");
      expect(found?.id).toBe(fresh.id);
      // And a live row outranks everything.
      await pubRepo.bindInstallation({ publicationId: stale.id, installationId: "inst_9" });
      const live = await pubRepo.findByAppId("cli_shared");
      expect(live?.id).toBe(stale.id);
    });

    it("getCredentialState reports which secrets are present", async () => {
      const pubRepo = new SqlFeishuPublicationRepo(drz as unknown as OmaDb, ids, crypto);
      const shell = await pubRepo.insertShell({
        tenantId: "tn_1",
        userId: "u_1",
        agentId: "ag_1",
        environmentId: "env_1",
        persona: { name: "A", avatarUrl: null },
        capabilities: new Set([]),
        sessionGranularity: "per_chat",
      });
      const before = await pubRepo.getCredentialState(shell.id);
      expect(before).toEqual({
        appId: null,
        hasAppSecret: false,
        hasVerificationToken: false,
        hasEncryptKey: false,
      });
      await pubRepo.setCredentials(shell.id, {
        appId: "cli_x",
        appSecretCipher: await enc("s"),
        verificationTokenCipher: await enc("v"),
        encryptKeyCipher: await enc("e"),
      });
      const after = await pubRepo.getCredentialState(shell.id);
      expect(after).toEqual({
        appId: "cli_x",
        hasAppSecret: true,
        hasVerificationToken: true,
        hasEncryptKey: true,
      });
    });

    it("returns null for unknown publication id", async () => {
      const pubRepo = new SqlFeishuPublicationRepo(drz as unknown as OmaDb, ids, crypto);
      expect(await pubRepo.get("nope")).toBeNull();
      expect(await pubRepo.getCredentialState("nope")).toBeNull();
    });
  });

  // ─── Session-scope repo ──────────────────────────────────────────────

  describe("SqlFeishuSessionScopeRepo", () => {
    const scope: import("@open-managed-agents/integrations-core").SessionScope = {
      tenantId: "tn_1",
      publicationId: "pub_1",
      scopeKey: "chat:oc_1:user:ou_1",
      sessionId: "sess_1",
      status: "pending",
      createdAt: 1000,
      channelName: "Engineering",
    };

    it("inserts and reads a scope", async () => {
      const repo = new SqlFeishuSessionScopeRepo(drz as unknown as OmaDb);
      const ok = await repo.insert(scope);
      expect(ok).toBe(true);
      const got = await repo.getByScope("pub_1", scope.scopeKey);
      expect(got?.sessionId).toBe("sess_1");
      expect(got?.channelName).toBe("Engineering");
    });

    it("returns false on duplicate insert (idempotent)", async () => {
      const repo = new SqlFeishuSessionScopeRepo(drz as unknown as OmaDb);
      expect(await repo.insert(scope)).toBe(true);
      expect(await repo.insert(scope)).toBe(false);
    });

    it("updates status", async () => {
      const repo = new SqlFeishuSessionScopeRepo(drz as unknown as OmaDb);
      await repo.insert(scope);
      await repo.updateStatus("pub_1", scope.scopeKey, "active");
      const got = await repo.getByScope("pub_1", scope.scopeKey);
      expect(got?.status).toBe("active");
    });

    it("reassigns only when scope is inactive or stale pending", async () => {
      const repo = new SqlFeishuSessionScopeRepo(drz as unknown as OmaDb);
      await repo.insert(scope);
      // Active scope → should NOT reassign
      await repo.updateStatus("pub_1", scope.scopeKey, "active");
      const didReassign1 = await repo.reassignIfInactive(
        "pub_1",
        scope.scopeKey,
        "sess_new_1",
        2_000,
      );
      expect(didReassign1).toBe(false);
      const still = await repo.getByScope("pub_1", scope.scopeKey);
      expect(still?.sessionId).toBe("sess_1");

      // Pending with stale created_at → should reassign
      await repo.updateStatus("pub_1", scope.scopeKey, "pending");
      const didReassign2 = await repo.reassignIfInactive(
        "pub_1",
        scope.scopeKey,
        "sess_new_2",
        200_000, // way past PENDING_STALE_AFTER_MS = 60_000
      );
      expect(didReassign2).toBe(true);
      const got = await repo.getByScope("pub_1", scope.scopeKey);
      expect(got?.sessionId).toBe("sess_new_2");
      expect(got?.status).toBe("active");
    });

    it("returns null for unknown scope", async () => {
      const repo = new SqlFeishuSessionScopeRepo(drz as unknown as OmaDb);
      expect(await repo.getByScope("pub_1", "chat:nope")).toBeNull();
    });
  });

  // ─── Setup-link repo ─────────────────────────────────────────────────

  describe("SqlFeishuSetupLinkRepo", () => {
    it("inserts, fetches, and marks a link used", async () => {
      const repo = new SqlFeishuSetupLinkRepo(drz as unknown as OmaDb, ids);
      const link = await repo.insert({
        tenantId: "tn_1",
        publicationId: "pub_1",
        createdBy: "u_1",
        expiresAt: Date.now() + 60_000,
      });
      expect(link.token.length).toBeGreaterThan(0);
      const fetched = await repo.get(link.token);
      expect(fetched?.publicationId).toBe("pub_1");
      expect(fetched?.usedAt).toBeNull();

      await repo.markUsed(link.token, "u@acme.com", 12345);
      const after = await repo.get(link.token);
      expect(after?.usedAt).toBe(12345);
      expect(after?.usedByEmail).toBe("u@acme.com");
    });

    it("deletes expired links", async () => {
      const repo = new SqlFeishuSetupLinkRepo(drz as unknown as OmaDb, ids);
      const expired = await repo.insert({
        tenantId: "tn_1",
        publicationId: "pub_old",
        createdBy: "u_1",
        expiresAt: Date.now() - 1000, // already expired
      });
      const live = await repo.insert({
        tenantId: "tn_1",
        publicationId: "pub_new",
        createdBy: "u_1",
        expiresAt: Date.now() + 60_000,
      });

      const deleted = await repo.deleteExpired(Date.now());
      expect(deleted).toBe(1);
      expect(await repo.get(expired.token)).toBeNull();
      expect(await repo.get(live.token)).not.toBeNull();
    });

    it("returns null for unknown token", async () => {
      const repo = new SqlFeishuSetupLinkRepo(drz as unknown as OmaDb, ids);
      expect(await repo.get("nope")).toBeNull();
    });
  });

  // ─── Webhook-event store ─────────────────────────────────────────────

  describe("SqlFeishuWebhookEventStore", () => {
    it("returns true on first insert, false on duplicate delivery_id", async () => {
      const repo = new SqlFeishuWebhookEventStore(drz as unknown as OmaDb);
      const first = await repo.recordIfNew(
        "evt_1",
        "tn_1",
        "inst_1",
        "im.message.receive_v1",
        Date.now(),
      );
      const second = await repo.recordIfNew(
        "evt_1",
        "tn_1",
        "inst_1",
        "im.message.receive_v1",
        Date.now(),
      );
      expect(first).toBe(true);
      expect(second).toBe(false);
    });

    it("attaches session/publication/error metadata", async () => {
      const repo = new SqlFeishuWebhookEventStore(drz as unknown as OmaDb);
      await repo.recordIfNew("evt_2", "tn_1", "inst_1", "x", 1);
      await repo.attachSession("evt_2", "sess_42");
      await repo.attachPublication("evt_2", "pub_42");
      await repo.attachError("evt_2", "boom");
      // No exception means the UPDATEs ran. Re-record should still be
      // dedup'd because the PK is delivery_id and didn't change.
      const again = await repo.recordIfNew("evt_2", "tn_1", "inst_1", "x", 1);
      expect(again).toBe(false);
    });
  });

  // ─── Coverage-gap fill-ins ───────────────────────────────────────────
  //
  // The following tests are not behavioral — they exist to drive lines
  // that no production path hits today but the implementation contract
  // (and our coverage threshold) still expects. Removing any of them
  // will fail the vitest coverage gate.

  describe("SqlFeishuInstallationRepo — defensive surface", () => {
    it("findByAppId returns the live installation matching the app id", async () => {
      const repo = new SqlFeishuInstallationRepo(drz as unknown as OmaDb, crypto, ids);
      const inst = await repo.insert({
        tenantId: "tn_1",
        userId: "u_1",
        providerId: "feishu",
        workspaceId: "ws_1",
        workspaceName: "Acme",
        installKind: "dedicated",
        appId: "cli_lookup",
        scopes: [],
      });
      await repo.markRevoked(inst.id, Date.now());
      // Revoked installs must NOT appear in findByAppId.
      expect(await repo.findByAppId("cli_lookup")).toBeNull();
    });

    it("setVaultId updates the row", async () => {
      const repo = new SqlFeishuInstallationRepo(drz as unknown as OmaDb, crypto, ids);
      const inst = await repo.insert({
        tenantId: "tn_1",
        userId: "u_1",
        providerId: "feishu",
        workspaceId: "ws_1",
        workspaceName: "Acme",
        installKind: "dedicated",
        appId: "cli_x",
        scopes: [],
      });
      await repo.setVaultId(inst.id, "vault_xyz");
      const reloaded = await repo.get(inst.id);
      expect(reloaded?.vaultId).toBe("vault_xyz");
    });

    it("setTokens throws — token rotation must go through setTenantAccessToken", async () => {
      const repo = new SqlFeishuInstallationRepo(drz as unknown as OmaDb, crypto, ids);
      await expect(repo.setTokens("any", "a", null)).rejects.toThrow(
        /setTenantAccessToken/,
      );
    });

    it("getRefreshToken always returns null (Feishu has no refresh_token)", async () => {
      const repo = new SqlFeishuInstallationRepo(drz as unknown as OmaDb, crypto, ids);
      expect(await repo.getRefreshToken("any")).toBeNull();
    });
  });

  describe("SqlFeishuSessionScopeRepo — full contract", () => {
    it("claimPending inserts a placeholder row idempotently", async () => {
      const repo = new SqlFeishuSessionScopeRepo(drz as unknown as OmaDb);
      const args = {
        tenantId: "tn_1",
        publicationId: "pub_1",
        scopeKey: "chat:oc_x",
        placeholderSessionId: "sess_placeholder",
        now: 1000,
      };
      expect(await repo.claimPending(args)).toBe(true);
      expect(await repo.claimPending(args)).toBe(false);
      const got = await repo.getByScope("pub_1", args.scopeKey);
      expect(got?.sessionId).toBe(args.placeholderSessionId);
      expect(got?.status).toBe("pending");
    });

    it("fulfillPending promotes a pending row to active and swaps session_id", async () => {
      const repo = new SqlFeishuSessionScopeRepo(drz as unknown as OmaDb);
      await repo.claimPending({
        tenantId: "tn_1",
        publicationId: "pub_1",
        scopeKey: "chat:oc_y",
        placeholderSessionId: "sess_p",
        now: 1,
      });
      const promoted = await repo.fulfillPending("pub_1", "chat:oc_y", "sess_real");
      expect(promoted).toBe(true);
      const got = await repo.getByScope("pub_1", "chat:oc_y");
      expect(got?.sessionId).toBe("sess_real");
      expect(got?.status).toBe("active");
    });

    it("fulfillPending returns false when no pending row exists", async () => {
      const repo = new SqlFeishuSessionScopeRepo(drz as unknown as OmaDb);
      expect(
        await repo.fulfillPending("pub_1", "chat:oc_nope", "sess_real"),
      ).toBe(false);
    });

    it("releasePending removes only the pending row", async () => {
      const repo = new SqlFeishuSessionScopeRepo(drz as unknown as OmaDb);
      await repo.claimPending({
        tenantId: "tn_1",
        publicationId: "pub_1",
        scopeKey: "chat:oc_a",
        placeholderSessionId: "sess_p",
        now: 1,
      });
      // Promote one, leave the other pending.
      await repo.fulfillPending("pub_1", "chat:oc_a", "sess_real");
      await repo.claimPending({
        tenantId: "tn_1",
        publicationId: "pub_1",
        scopeKey: "chat:oc_b",
        placeholderSessionId: "sess_p2",
        now: 1,
      });

      await repo.releasePending("pub_1", "chat:oc_b");
      expect(await repo.getByScope("pub_1", "chat:oc_b")).toBeNull();
      expect(await repo.getByScope("pub_1", "chat:oc_a")).not.toBeNull();
    });

    it("listActive returns only active scopes for a publication", async () => {
      const repo = new SqlFeishuSessionScopeRepo(drz as unknown as OmaDb);
      await repo.insert({
        tenantId: "tn_1",
        publicationId: "pub_1",
        scopeKey: "chat:active",
        sessionId: "s1",
        status: "active",
        createdAt: 1,
      });
      await repo.insert({
        tenantId: "tn_1",
        publicationId: "pub_1",
        scopeKey: "chat:pending",
        sessionId: "s2",
        status: "pending",
        createdAt: 1,
      });
      // Different publication — must be excluded.
      await repo.insert({
        tenantId: "tn_1",
        publicationId: "pub_other",
        scopeKey: "chat:active-other",
        sessionId: "s3",
        status: "active",
        createdAt: 1,
      });

      const active = await repo.listActive("pub_1");
      expect(active.map((s) => s.scopeKey).sort()).toEqual(["chat:active"]);
    });

    it("updateChatName writes the chat name on the scope row", async () => {
      const repo = new SqlFeishuSessionScopeRepo(drz as unknown as OmaDb);
      await repo.insert({
        tenantId: "tn_1",
        publicationId: "pub_1",
        scopeKey: "chat:oc_n",
        sessionId: "s1",
        status: "active",
        createdAt: 1,
      });
      await repo.updateChatName("pub_1", "chat:oc_n", "Engineering");
      const got = await repo.getByScope("pub_1", "chat:oc_n");
      expect(got?.channelName).toBe("Engineering");
    });

    it("closeAllForPublication flips every active scope to completed", async () => {
      const repo = new SqlFeishuSessionScopeRepo(drz as unknown as OmaDb);
      await repo.insert({
        tenantId: "tn_1",
        publicationId: "pub_1",
        scopeKey: "chat:one",
        sessionId: "s1",
        status: "active",
        createdAt: 1,
      });
      await repo.insert({
        tenantId: "tn_1",
        publicationId: "pub_1",
        scopeKey: "chat:two",
        sessionId: "s2",
        status: "active",
        createdAt: 1,
      });
      await repo.insert({
        tenantId: "tn_1",
        publicationId: "pub_2",
        scopeKey: "chat:other",
        sessionId: "s3",
        status: "active",
        createdAt: 1,
      });

      await repo.closeAllForPublication("pub_1");

      expect((await repo.getByScope("pub_1", "chat:one"))?.status).toBe(
        "completed",
      );
      expect((await repo.getByScope("pub_1", "chat:two"))?.status).toBe(
        "completed",
      );
      expect((await repo.getByScope("pub_2", "chat:other"))?.status).toBe(
        "active",
      );
    });

    it("armPendingScan returns the disabled stub response (Feishu has no scan)", async () => {
      const repo = new SqlFeishuSessionScopeRepo(drz as unknown as OmaDb);
      const r = await repo.armPendingScan();
      expect(r).toEqual({ armed: false, currentUntil: null });
    });

    it("clearPendingScan is a no-op", async () => {
      const repo = new SqlFeishuSessionScopeRepo(drz as unknown as OmaDb);
      await expect(repo.clearPendingScan()).resolves.toBeUndefined();
    });
  });
});
