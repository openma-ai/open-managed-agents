import { describe, expect, it } from "vitest";
import { createBetterSqlite3SqlClient } from "../src/adapters/better-sqlite3";

describe("BetterSqlite3SqlClient transactional RETURNING", () => {
  it("rolls back earlier writes when the batch result rejects admission", async () => {
    const sql = await createBetterSqlite3SqlClient(":memory:");
    await sql.exec("CREATE TABLE guarded (id TEXT PRIMARY KEY)");
    await expect(sql.batchChecked!([sql.prepare("INSERT INTO guarded VALUES ('old')")], () => { throw new Error("fence lost"); })).rejects.toThrow("fence lost");
    expect((await sql.prepare("SELECT * FROM guarded").all()).results).toEqual([]);
  });
  it("returns mutation rows and changes from a batch without weakening transaction rollback", async () => {
    const sql = await createBetterSqlite3SqlClient(":memory:");
    await sql.exec("CREATE TABLE items (id TEXT PRIMARY KEY, revision INTEGER NOT NULL)");
    await sql.prepare("INSERT INTO items (id, revision) VALUES (?, ?)").bind("one", 0).run();
    const results = await sql.batch<{ id: string; revision: number }>([
      sql.prepare("UPDATE items SET revision = revision + 1 WHERE id = ? RETURNING id, revision").bind("one"),
      sql.prepare("UPDATE items SET revision = revision + 1 WHERE id = ? RETURNING id, revision").bind("missing"),
    ]);
    expect(results[0]).toMatchObject({ meta: { changes: 1 }, results: [{ id: "one", revision: 1 }] });
    expect(results[1]).toMatchObject({ meta: { changes: 0 }, results: [] });
    await expect(sql.batch([
      sql.prepare("UPDATE items SET revision = revision + 1 WHERE id = ? RETURNING id").bind("one"),
      sql.prepare("INSERT INTO items (id, revision) VALUES (?, ?)").bind("one", 0),
    ])).rejects.toThrow();
    await expect(sql.prepare("SELECT revision FROM items WHERE id = ?").bind("one").first())
      .resolves.toEqual({ revision: 1 });
  });
});
