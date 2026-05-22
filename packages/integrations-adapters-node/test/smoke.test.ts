// Smoke test: verify the Node adapter (sqlite via better-sqlite3) implements
// the integrations-core ports and round-trips data through every repo.
// Catches schema/typo regressions when the Node port drifts from the CF port.

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createBetterSqlite3SqlClient, type SqlClient } from "@open-managed-agents/sql-client";
import BetterSqlite3 from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { OmaDb } from "@open-managed-agents/db-schema";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildNodeRepos,
  WebCryptoAesGcm,
  CryptoIdGenerator,
  SqlSlackInstallationRepo,
} from "../src";

describe("integrations-adapters-node smoke", () => {
  let sql: SqlClient;
  let drz: BetterSQLite3Database;
  let tmpDir: string;
  beforeAll(async () => {
    // Drizzle migrate runs against an on-disk DB so the SqlClient opened
    // afterward observes the migrated schema (`:memory:` is per-connection).
    tmpDir = mkdtempSync(join(tmpdir(), "oma-int-smoke-"));
    const dbPath = join(tmpDir, "smoke.db");
    drz = (() => {
      const raw = new BetterSqlite3(dbPath);
      raw.exec("PRAGMA foreign_keys = OFF");
      return drizzle(raw);
    })();
    const migrationsFolder = fileURLToPath(
      new URL("../../../apps/main-node/migrations-sqlite", import.meta.url),
    );
    migrate(drz, { migrationsFolder });
    sql = await createBetterSqlite3SqlClient(dbPath);
    await sql
      .prepare(
        `INSERT INTO "tenant" (id, name, "createdAt", "updatedAt") VALUES (?, ?, ?, ?)`,
      )
      .bind("tn_test", "test", Date.now(), Date.now())
      .run();
    await sql
      .prepare(
        `INSERT INTO membership (user_id, tenant_id, role, created_at) VALUES (?, ?, 'owner', ?)`,
      )
      .bind("usr_test", "tn_test", Date.now())
      .run();
  });

  afterAll(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolves tenant via membership", async () => {
    const repos = buildNodeRepos({ sql, db: drz as unknown as OmaDb, PLATFORM_ROOT_SECRET: "test-secret-32bytes-min-1234567890" });
    expect(await repos.tenants.resolveByUserId("usr_test")).toBe("tn_test");
  });

  it("inserts + reads a linear installation + publication round trip", async () => {
    const repos = buildNodeRepos({ sql, db: drz as unknown as OmaDb, PLATFORM_ROOT_SECRET: "test-secret-32bytes-min-1234567890" });
    const inst = await repos.linearInstallations.insert({
      tenantId: "tn_test",
      userId: "usr_test",
      providerId: "linear",
      workspaceId: "ws_demo",
      workspaceName: "Demo",
      installKind: "shared",
      appId: null,
      accessToken: "lin_oauth_abc",
      refreshToken: null,
      scopes: ["read", "write"],
      botUserId: "u_bot_demo",
    });
    expect(inst.id).toMatch(/.+/);
    expect(inst.tenantId).toBe("tn_test");
    expect(await repos.linearInstallations.getAccessToken(inst.id)).toBe("lin_oauth_abc");

    const pub = await repos.linearPublications.insert({
      tenantId: "tn_test",
      userId: "usr_test",
      agentId: "agent_alpha",
      installationId: inst.id,
      environmentId: "env_local",
      mode: "full",
      status: "live",
      persona: { name: "Demo Bot", avatarUrl: null },
      capabilities: new Set(["mention_response"]),
      sessionGranularity: "per_issue",
    });
    const fetched = await repos.linearPublications.get(pub.id);
    expect(fetched?.userId).toBe("usr_test");
    const list = await repos.linearPublications.listByUserAndAgent("usr_test", "agent_alpha");
    expect(list.length).toBe(1);
  });

  it("HMAC verify recordIfNew dedupe (linear_events)", async () => {
    const repos = buildNodeRepos({ sql, db: drz as unknown as OmaDb, PLATFORM_ROOT_SECRET: "test-secret-32bytes-min-1234567890" });
    const ok = await repos.linearEvents.recordIfNew(
      "delivery_x1",
      "tn_test",
      "ins_unused",
      "Comment",
      Date.now(),
    );
    expect(ok).toBe(true);
    const dupe = await repos.linearEvents.recordIfNew(
      "delivery_x1",
      "tn_test",
      "ins_unused",
      "Comment",
      Date.now(),
    );
    expect(dupe).toBe(false);
  });

  it("HMAC verifies a known-good signature and rejects a bad one", async () => {
    const { WebCryptoHmacVerifier } = await import("../src");
    const v = new WebCryptoHmacVerifier();
    const secret = "lin_wh_demo_secret";
    const body = '{"action":"create"}';
    // hex(HMAC-SHA256(body, secret))
    const expected = await hmacHex(secret, body);
    expect(await v.verify(secret, body, expected)).toBe(true);
    expect(await v.verify(secret, body, "00".repeat(32))).toBe(false);
  });

  it("WebCryptoAesGcm round-trips", async () => {
    const c = new WebCryptoAesGcm("test-secret-32bytes-min-1234567890");
    const plain = "hello-bearer-token";
    const ct = await c.encrypt(plain);
    expect(ct).not.toBe(plain);
    expect(await c.decrypt(ct)).toBe(plain);
  });

  it("Slack installation repo round trip uses slack_installations", async () => {
    const crypto = new WebCryptoAesGcm("test-secret-32bytes-min-1234567890");
    const ids = new CryptoIdGenerator();
    const slackRepo = new SqlSlackInstallationRepo(drz as unknown as OmaDb, crypto, ids);
    const inst = await slackRepo.insert({
      tenantId: "tn_test",
      userId: "usr_test",
      providerId: "slack",
      workspaceId: "T_ABC",
      workspaceName: "Slack Demo",
      installKind: "dedicated",
      appId: null,
      accessToken: "xoxb-bot",
      refreshToken: null,
      scopes: ["app_mentions:read"],
      botUserId: "U_BOT",
    });
    const got = await slackRepo.get(inst.id);
    expect(got?.workspaceName).toBe("Slack Demo");
  });
});

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const bytes = new Uint8Array(sig);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
