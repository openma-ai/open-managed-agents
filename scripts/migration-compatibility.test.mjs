import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

const environmentServiceKeysMigration = await readFile(
  new URL("../apps/main/migrations/0021_environment_service_keys.sql", import.meta.url),
  "utf8",
);

const legacyApiKeysSchema = `
  CREATE TABLE api_keys (
    id TEXT PRIMARY KEY NOT NULL,
    tenant_id TEXT NOT NULL,
    user_id TEXT,
    name TEXT NOT NULL,
    prefix TEXT NOT NULL,
    hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at INTEGER
  );
`;

for (const [name, bootstrap] of [
  ["Cloudflare KV-backed database without an api_keys table", ""],
  ["Node SQL database with the legacy api_keys table", legacyApiKeysSchema],
]) {
  test(`0021 applies to ${name}`, () => {
    const database = new DatabaseSync(":memory:");
    try {
      if (bootstrap) database.exec(bootstrap);
      database.exec(environmentServiceKeysMigration);
      const columns = database
        .prepare("PRAGMA table_info(api_keys)")
        .all()
        .map((column) => column.name);
      assert.ok(columns.includes("credential_type"));
      assert.ok(columns.includes("environment_id"));
    } finally {
      database.close();
    }
  });
}

const runtimeResourceTablesMigration = await readFile(
  new URL("../apps/main/migrations/0027_runtime_resource_tables.sql", import.meta.url),
  "utf8",
);

// What ensureRuntimeResourceFenceSchema created before these tables had a
// migration (Node deployments with initializeFenceSchema: true).
const operatorCreatedFenceSchema = `
  CREATE TABLE runtime_resource_fences (scope_key TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, environment_id TEXT NOT NULL, session_id TEXT NOT NULL, work_id TEXT NOT NULL, generation BIGINT NOT NULL, owner_id TEXT NOT NULL, fence_token TEXT NOT NULL, expires_at_ms BIGINT NOT NULL, publication_json TEXT, publication_generation BIGINT, revision BIGINT NOT NULL DEFAULT 0);
  CREATE INDEX runtime_resource_fences_expiry_idx ON runtime_resource_fences(expires_at_ms);
  CREATE TABLE runtime_resource_orphans (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, environment_id TEXT NOT NULL, session_id TEXT NOT NULL, work_id TEXT NOT NULL, generation BIGINT NOT NULL, owner_id TEXT NOT NULL, sandbox_json TEXT NOT NULL, reason TEXT NOT NULL, attempts BIGINT NOT NULL DEFAULT 0, last_error TEXT NOT NULL);
  INSERT INTO runtime_resource_orphans VALUES ('kept', 'w', 'e', 's', 'x', 1, 'o', '{}', 'failed', 0, 'boom');
`;

for (const [name, bootstrap, orphans] of [
  ["a database without the tables", "", 0],
  ["a database where the operator already created them", operatorCreatedFenceSchema, 1],
]) {
  test(`0027 applies to ${name}`, () => {
    const database = new DatabaseSync(":memory:");
    try {
      if (bootstrap) database.exec(bootstrap);
      database.exec(runtimeResourceTablesMigration);
      assert.equal(database.prepare("SELECT count(*) AS n FROM runtime_resource_orphans").get().n, orphans);
      assert.equal(database.prepare("SELECT count(*) AS n FROM runtime_resource_fences").get().n, 0);
    } finally {
      database.close();
    }
  });
}
