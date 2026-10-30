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

const migrationTargets = [
  { name: "SQLite", folder: resolve(import.meta.dirname, "../migrations-sqlite"), retirementTag: "0028_drop_legacy_agents" },
  { name: "D1", folder: resolve(import.meta.dirname, "../../main/migrations"), retirementTag: "0024_drop_legacy_agents" },
];
const directories: string[] = [];
const databases: Database.Database[] = [];

afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

/** A database before legacy agent retirement, holding one agent as the previous release stored it. */
async function previousRelease(folder: string, retirementTag: string): Promise<Database.Database> {
  const directory = await mkdtemp(join(tmpdir(), "legacy-agents-"));
  directories.push(directory);
  await mkdir(join(directory, "meta"));
  const journal = JSON.parse(await readFile(join(folder, "meta/_journal.json"), "utf8"));
  journal.entries = journal.entries.filter((entry: { tag: string }) => entry.tag !== retirementTag);
  await writeFile(join(directory, "meta/_journal.json"), JSON.stringify(journal));
  for (const entry of journal.entries) {
    await cp(join(folder, `${entry.tag}.sql`), join(directory, `${entry.tag}.sql`));
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

describe.each(migrationTargets)("$name legacy agent upgrade", ({ folder: migrationsFolder, retirementTag }) => {
  it("moves agents and their history into managed tables and retains empty legacy tables", async () => {
    const db = await previousRelease(migrationsFolder, retirementTag);
    const sql = new BetterSqlite3SqlClient(db);

    await moveLegacyAgents(sql, "sqlite");
    migrate(drizzle(db), { migrationsFolder });

    const expectMoved = async () => {
      expect(tables(db)).toEqual(expect.arrayContaining(["agents", "agent_versions"]));
      expect(db.prepare("SELECT COUNT(*) AS n FROM agents").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM agent_versions").get()).toEqual({ n: 0 });
      const store = new SqlAgentStore(sql);
      expect(await store.findCurrent({ workspaceId: "ws", agentId: "agent_keep" }))
        .toMatchObject({ name: "keep", version: 2, openma: { harness: "acp-sandbox" }, updatedAt: "2026-10-01T00:00:01.000Z" });
      expect(await store.findVersion({ workspaceId: "ws", agentId: "agent_keep", version: 1 }))
        .toMatchObject({ name: "keep v1", model: { id: "m" } });
    };
    await expectMoved();

    // A second start finds nothing to move and keeps the managed documents intact.
    await moveLegacyAgents(sql, "sqlite");
    migrate(drizzle(db), { migrationsFolder });
    await expectMoved();
  });

  it.each(["agents", "agent_versions"])("refuses retirement while %s has unmoved rows", async (table) => {
    const db = await previousRelease(migrationsFolder, retirementTag);
    if (table === "agents") db.prepare("DELETE FROM agent_versions").run();
    else db.prepare("DELETE FROM agents").run();
    expect(() => migrate(drizzle(db), { migrationsFolder })).toThrow(/legacy_agents_guard/);
    expect(tables(db)).toEqual(expect.arrayContaining(["agents", "agent_versions"]));
    expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 1 });
  });

  it("restarts databases where the previous release already dropped the legacy tables", async () => {
    const db = await previousRelease(migrationsFolder, retirementTag);
    const sql = new BetterSqlite3SqlClient(db);
    await moveLegacyAgents(sql, "sqlite");
    migrate(drizzle(db), { migrationsFolder });
    db.exec("DROP TABLE IF EXISTS agent_versions; DROP TABLE IF EXISTS agents");

    await moveLegacyAgents(sql, "sqlite");
    migrate(drizzle(db), { migrationsFolder });
    expect(await new SqlAgentStore(sql).findCurrent({ workspaceId: "ws", agentId: "agent_keep" }))
      .toMatchObject({ name: "keep", version: 2 });
  });
});
