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

for (const [name, migrationPath] of [
  ["Cloudflare D1", "../apps/main/migrations/0027_session_admission_fifo.sql"],
  ["Node SQLite", "../apps/main-node/migrations-sqlite/0031_session_admission_fifo.sql"],
]) {
  test(`admission FIFO preserves historical rows when upgrading ${name}`, async () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(`CREATE TABLE managed_session_executions (
        workspace_id TEXT, session_id TEXT, lane_id TEXT, id TEXT, admitted_at_ms INTEGER);
        INSERT INTO managed_session_executions VALUES ('w', 's', 'lane', 'z-old', 1000), ('w', 's', 'lane', 'a-old', 1000);`);
      database.exec(await readFile(new URL(migrationPath, import.meta.url), "utf8"));
      assert.deepEqual(database.prepare("SELECT admission_sequence FROM managed_session_executions").all().map(row => row.admission_sequence), [0, 0]);
      database.exec("INSERT INTO managed_session_admission_counters (workspace_id, session_id) VALUES ('w', 's')");
      assert.equal(database.prepare("SELECT last_sequence FROM managed_session_admission_counters").get().last_sequence, 0);
      assert.deepEqual(database.prepare("PRAGMA index_info(managed_session_executions_admission_idx)").all().map(row => row.name),
        ["workspace_id", "session_id", "lane_id", "admission_sequence"]);
    } finally {
      database.close();
    }
  });
}
