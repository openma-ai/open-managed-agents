import Database from "better-sqlite3";
import { readFile, readdir, mkdir, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { MySqlContainer } from "@testcontainers/mysql";
import pg from "pg";
import mysql from "mysql2/promise";
import { expect, it } from "vitest";
import { migrateNodeMysqlSchema } from "@open-managed-agents/db-schema/node-mysql";
import { createMysql2SqlClient } from "@open-managed-agents/sql-client";

const root = resolve(import.meta.dirname, "../../..");
const workColumns = "workspace_id,environment_id,id,session_id,document,sealed_secret,claim_at,claim_worker_id,claim_generation,heartbeat_ttl_seconds,revision,state,created_at,runtime_publication_json,sandbox_token_hashes";
const oldRow = `'w','e','active','s','{}','sealed-token',1,'worker',7,90,5,'active',1,'{"revision":3}','["hash"]'`;
const queuedRow = "'w','e','queued','s2','{}','unacked-token',NULL,NULL,0,90,1,'queued',2,NULL,NULL";
async function migrations(directory: string) {
  const journal = JSON.parse(await readFile(resolve(directory, "meta/_journal.json"), "utf8"));
  const entries = directory.endsWith("/main/migrations")
    ? (await readdir(directory)).filter(name => name.endsWith(".sql")).sort().map(name => ({ idx: Number(name.slice(0, 4)), tag: name.slice(0, -4) }))
    : journal.entries;
  return Promise.all(entries.map(async (entry: any) => ({ ...entry, sql: await readFile(resolve(directory, entry.tag + ".sql"), "utf8") })));
}

it.each([["D1 SQL", "apps/main/migrations", 30], ["Node SQLite", "apps/main-node/migrations-sqlite", 33]])("%s upgrade preserves old claims, tokens and publications; old code can roll back", async (_, path, oldTip) => {
  const db = new Database(":memory:");
  try {
    const entries = await migrations(resolve(root, path as string));
    for (const entry of entries.filter(entry => entry.idx <= oldTip)) db.exec(entry.sql);
    db.exec("INSERT INTO managed_environment_work (" + workColumns + ") VALUES (" + oldRow + "),(" + queuedRow + ")");
    const before = db.prepare("SELECT * FROM managed_environment_work ORDER BY id").all();
    for (const entry of entries.filter(entry => entry.idx > oldTip)) db.exec(entry.sql);
    const columns = db.pragma("table_info(managed_environment_work)") as any[];
    expect(columns.find(column => column.name === "runtime_projection")).toMatchObject({ type: "TEXT", notnull: 0, dflt_value: null });
    expect(db.prepare("SELECT * FROM managed_environment_work ORDER BY id").all()).toEqual(before.map((row: any) => ({ ...row, runtime_projection: null })));
    db.prepare("UPDATE managed_environment_work SET runtime_projection=? WHERE id='active'").run('{"checkpoint":1}');
    // A previous binary's explicit-column read/update remains valid after expansion.
    db.exec("UPDATE managed_environment_work SET revision=revision+1 WHERE id='active'");
    expect(db.prepare("SELECT sealed_secret,runtime_publication_json,claim_generation,runtime_projection FROM managed_environment_work WHERE id='active'").get()).toEqual({ sealed_secret: "sealed-token", runtime_publication_json: '{"revision":3}', claim_generation: 7, runtime_projection: '{"checkpoint":1}' });
    db.exec("BEGIN; UPDATE managed_environment_work SET runtime_projection='rollback' WHERE id='active'; ROLLBACK;");
    expect((db.prepare("SELECT runtime_projection FROM managed_environment_work WHERE id='active'").get() as any).runtime_projection).toBe('{"checkpoint":1}');
  } finally { db.close(); }
});

it("real PostgreSQL upgrades old Work rows without replacing their authority", async () => {
  const container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const client = new pg.Client({ connectionString: container.getConnectionUri() });
  try {
    await client.connect();
    const entries = await migrations(resolve(root, "apps/main-node/migrations"));
    for (const entry of entries.filter(entry => entry.idx <= 33)) await client.query(entry.sql);
    await client.query("INSERT INTO managed_environment_work (" + workColumns + ") VALUES (" + oldRow + "),(" + queuedRow + ")");
    const before = (await client.query("SELECT * FROM managed_environment_work ORDER BY id")).rows;
    for (const entry of entries.filter(entry => entry.idx > 33)) await client.query(entry.sql);
    expect((await client.query("SELECT data_type,is_nullable,column_default FROM information_schema.columns WHERE table_name='managed_environment_work' AND column_name='runtime_projection'")).rows).toEqual([{ data_type: "text", is_nullable: "YES", column_default: null }]);
    expect((await client.query("SELECT * FROM managed_environment_work ORDER BY id")).rows).toEqual(before.map(row => ({ ...row, runtime_projection: null })));
    await client.query("BEGIN; UPDATE managed_environment_work SET runtime_projection='rollback'; ROLLBACK");
    await client.query("UPDATE managed_environment_work SET revision=revision+1 WHERE id='active'");
    expect((await client.query("SELECT runtime_projection FROM managed_environment_work ORDER BY id")).rows).toEqual([{runtime_projection:null},{runtime_projection:null}]);
  } finally { await client.end(); await container.stop(); }
}, 120_000);

it("real MySQL snapshot upgrade is restart-safe and preserves old Work rows", async () => {
  const container = await new MySqlContainer("mysql:8.4").start();
  const connection = await mysql.createConnection(container.getConnectionUri());
  const sql = await createMysql2SqlClient(container.getConnectionUri());
  const directory = resolve(root, "node_modules/.work-projection-migration-" + randomUUID());
  try {
    await mkdir(resolve(directory, "meta"), { recursive: true });
    const source = resolve(root, "apps/main-node/migrations-sqlite");
    const journal = JSON.parse(await readFile(resolve(source, "meta/_journal.json"), "utf8"));
    journal.entries = journal.entries.filter((entry: any) => entry.idx <= 33);
    await writeFile(resolve(directory, "meta/_journal.json"), JSON.stringify(journal));
    await writeFile(resolve(directory, "meta/0033_snapshot.json"), await readFile(resolve(source, "meta/0033_snapshot.json")));
    await migrateNodeMysqlSchema(sql, directory);
    await connection.query("INSERT INTO managed_environment_work (" + workColumns + ") VALUES (" + oldRow + "),(" + queuedRow + ")");
    const [before] = await connection.query("SELECT * FROM managed_environment_work ORDER BY id");
    await migrateNodeMysqlSchema(sql, source);
    await migrateNodeMysqlSchema(sql, source);
    const [columns]: any = await connection.query("SELECT DATA_TYPE AS data_type,IS_NULLABLE AS nullable,COLUMN_DEFAULT AS default_value FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='managed_environment_work' AND column_name='runtime_projection'");
    expect(columns).toEqual([{data_type:"text",nullable:"YES",default_value:null}]);
    const [after] = await connection.query("SELECT * FROM managed_environment_work ORDER BY id");
    expect(after).toEqual((before as any[]).map(row => ({ ...row, runtime_projection: null })));
    await connection.query("START TRANSACTION");
    await connection.query("UPDATE managed_environment_work SET runtime_projection='rollback'");
    await connection.query("ROLLBACK");
    await connection.query("UPDATE managed_environment_work SET revision=revision+1 WHERE id='active'");
    const [rows]: any = await connection.query("SELECT runtime_projection FROM managed_environment_work ORDER BY id");
    expect(rows).toEqual([{runtime_projection:null},{runtime_projection:null}]);
  } finally { await sql.close(); await connection.end(); await container.stop(); await rm(directory, {recursive:true,force:true}); }
}, 120_000);
