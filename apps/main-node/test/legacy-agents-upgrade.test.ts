import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqlAgentStore } from "@open-managed-agents/agent-store-sql";
import { BetterSqlite3SqlClient } from "@open-managed-agents/sql-client/adapters/better-sqlite3";
import { moveLegacyAgents } from "../src/lib/move-legacy-agents";

const migrationsFolder = resolve(import.meta.dirname, "../migrations-sqlite");
const directories: string[] = [];
const databases: Database.Database[] = [];

afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

/** A database at the schema before the legacy agent tables were dropped,
 *  holding one agent the way the previous release stored it. */
async function previousRelease(): Promise<Database.Database> {
  const directory = await mkdtemp(join(tmpdir(), "legacy-agents-"));
  directories.push(directory);
  await mkdir(join(directory, "meta"));
  const journal = JSON.parse(await readFile(join(migrationsFolder, "meta/_journal.json"), "utf8"));
  journal.entries = journal.entries.filter((entry: { tag: string }) => entry.tag !== "0028_drop_legacy_agents");
  await writeFile(join(directory, "meta/_journal.json"), JSON.stringify(journal));
  for (const entry of journal.entries) {
    await cp(join(migrationsFolder, `${entry.tag}.sql`), join(directory, `${entry.tag}.sql`));
  }
  const db = new Database(":memory:");
  databases.push(db);
  migrate(drizzle(db), { migrationsFolder: directory });
  const created = Date.parse("2026-10-01T00:00:00.000Z");
  db.prepare("INSERT INTO agents (id, tenant_id, config, version, created_at, updated_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "agent_keep", "ws", JSON.stringify({ id: "agent_keep", name: "keep", model: { id: "m" }, harness: "acp-sandbox", version: 2 }),
    2, created, created + 1000, null,
  );
  db.prepare("INSERT INTO agent_versions (agent_id, tenant_id, version, snapshot, created_at) VALUES (?, ?, ?, ?, ?)").run(
    "agent_keep", "ws", 1, JSON.stringify({ id: "agent_keep", name: "keep v1", model: "m", version: 1 }), created,
  );
  return db;
}

const tables = (db: Database.Database) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(({ name }) => name);

describe("upgrading a database with legacy agent tables", () => {
  it("moves the agents into managed_agents and drops the legacy tables", async () => {
    const db = await previousRelease();
    const sql = new BetterSqlite3SqlClient(db);

    await moveLegacyAgents(sql, "sqlite");
    migrate(drizzle(db), { migrationsFolder });

    expect(tables(db)).not.toContain("agents");
    expect(tables(db)).not.toContain("agent_versions");
    const store = new SqlAgentStore(sql);
    expect(await store.findCurrent({ workspaceId: "ws", agentId: "agent_keep" }))
      .toMatchObject({ name: "keep", version: 2, openma: { harness: "acp-sandbox" }, updatedAt: "2026-10-01T00:00:01.000Z" });
    expect(await store.findVersion({ workspaceId: "ws", agentId: "agent_keep", version: 1 }))
      .toMatchObject({ name: "keep v1", model: { id: "m" } });

    // A second start finds nothing to move.
    await moveLegacyAgents(sql, "sqlite");
    migrate(drizzle(db), { migrationsFolder });
  });

  it("refuses to drop legacy tables whose rows were not moved", async () => {
    const db = await previousRelease();
    expect(() => migrate(drizzle(db), { migrationsFolder })).toThrow(/legacy_agents_guard/);
    expect(tables(db)).toContain("agents");
    expect(db.prepare("SELECT COUNT(*) AS n FROM agents").get()).toEqual({ n: 1 });
  });
});
