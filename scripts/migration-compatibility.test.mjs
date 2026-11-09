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

// What the since-removed ensureRuntimeResourceFenceSchema created before these
// tables had a migration (Node deployments with initializeFenceSchema: true).
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

const workClaimPublicationMigration = await readFile(
  new URL("../apps/main/migrations/0029_work_claim_publication.sql", import.meta.url),
  "utf8",
);
const nodeSqliteWorkClaimPublicationMigration = await readFile(
  new URL("../apps/main-node/migrations-sqlite/0033_work_claim_publication.sql", import.meta.url),
  "utf8",
);

const environmentWorkSchema = `
  CREATE TABLE managed_environment_work (workspace_id TEXT NOT NULL, environment_id TEXT NOT NULL, id TEXT NOT NULL, session_id TEXT, document TEXT NOT NULL, sealed_secret TEXT NOT NULL, claim_at INTEGER, claim_worker_id TEXT, claim_generation INTEGER DEFAULT 0 NOT NULL, heartbeat_ttl_seconds INTEGER NOT NULL, revision INTEGER NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (workspace_id, id));
  INSERT INTO managed_environment_work VALUES ('w', 'e', 'x', 's', '{}', 'sealed', 1, 'worker', 2, 90, 5, 'active', 1);
`;

test("D1 adds Work publication columns without dropping a cross-shard source", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(environmentWorkSchema); database.exec(runtimeResourceTablesMigration);
  database.exec(workClaimPublicationMigration);
  assert.equal(database.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'runtime_resource_fences'").get().n, 1);
  database.close();
});
const retireFenceMigration = await readFile(new URL("../apps/main/migrations/0030_retire_resource_fences.sql", import.meta.url), "utf8");
test("D1 refuses to drop a publication whose tenant-shard backfill is incomplete", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(environmentWorkSchema); database.exec(runtimeResourceTablesMigration);
  database.exec("INSERT INTO runtime_resource_fences VALUES ('unmoved', 'sharded', 'e', 's', 'x', 1, 'o', 't', 9, '{}', 1, 1)");
  database.exec(workClaimPublicationMigration);
  assert.throws(() => database.exec(retireFenceMigration), /CHECK constraint/);
  assert.equal(database.prepare("SELECT count(*) AS n FROM runtime_resource_fences WHERE publication_json IS NOT NULL").get().n, 1);
  database.exec("UPDATE runtime_resource_fences SET publication_json = NULL");
  database.exec(retireFenceMigration);
  assert.equal(database.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'runtime_resource_fences'").get().n, 0);
  database.close();
});

for (const [name, bootstrap, orphans] of [
  ["a database migrated by 0027", "", 0],
  ["a database whose operator created the fence tables, with fence rows", `${operatorCreatedFenceSchema}
    INSERT INTO runtime_resource_fences VALUES ('k', 'w', 'e', 's', 'x', 1, 'o', 't', 9, NULL, NULL, 0);`, 1],
]) {
  test(`0029 retires the fence table and keeps orphans on ${name}`, () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(environmentWorkSchema);
      if (bootstrap) database.exec(bootstrap);
      database.exec(runtimeResourceTablesMigration);
      database.exec(workClaimPublicationMigration);
      database.exec(retireFenceMigration);
      assert.equal(
        database.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'runtime_resource_fences%'").get().n,
        0,
      );
      assert.equal(database.prepare("SELECT count(*) AS n FROM runtime_resource_orphans").get().n, orphans);
      const work = database.prepare("SELECT revision, runtime_publication_json, sandbox_token_hashes FROM managed_environment_work").get();
      assert.equal(work.revision, 5);
      assert.equal(work.runtime_publication_json, null);
      assert.equal(work.sandbox_token_hashes, null);
    } finally {
      database.close();
    }
  });
}

for (const [name, migration] of [["Node SQLite", nodeSqliteWorkClaimPublicationMigration]]) {
  test(`${name} preserves the legacy publication before dropping its fence`, () => {
    const database = new DatabaseSync(":memory:");
    const candidates = {
      workspaceCandidate: { id: "workspace", contentHash: "sha256:workspace", revision: 7 },
      outputCandidate: { id: "outputs", contentHash: "sha256:outputs" },
      runtimeCheckpoint: { provider: "test", checkpointId: "snapshot", kind: "filesystem",
        sourceRuntimeId: "runtime", sessionId: "s", workGeneration: 3, workspaceRevision: 7,
        harnessVersion: "1", runtimeIdentity: "test" },
    };
    try {
      database.exec(environmentWorkSchema);
      database.exec(runtimeResourceTablesMigration);
      // Fence and Work generations were independent. Preserve the publication's
      // generation even after a later fence acquisition, not the current fence's.
      database.prepare("INSERT INTO runtime_resource_fences VALUES (?, 'w', 'e', 's', 'x', 9, 'o', 't', 0, ?, 3, 7)")
        .run("matching", JSON.stringify(candidates));
      database.prepare("INSERT INTO runtime_resource_fences VALUES (?, 'w', 'other', 's', 'x', 9, 'o', 't', 0, ?, 4, 8)")
        .run("wrong-environment", JSON.stringify({ ...candidates, workspaceCandidate: { id: "wrong", contentHash: "wrong" } }));
      database.exec(migration);
      const work = database.prepare("SELECT runtime_publication_json, revision FROM managed_environment_work").get();
      assert.deepEqual(JSON.parse(work.runtime_publication_json), { ...candidates, generation: 3, revision: 7 });
      assert.equal(work.revision, 5);
      assert.equal(database.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'runtime_resource_fences'").get().n, 0);
    } finally {
      database.close();
    }
  });
}
