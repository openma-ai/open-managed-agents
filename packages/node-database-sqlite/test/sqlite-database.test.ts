import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { openSqliteDatabase } from "../src/index.js";

const migrationsFolder = fileURLToPath(new URL("./fixtures/migrations", import.meta.url));

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "oma-node-database-sqlite-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("openSqliteDatabase", () => {
  it("creates the file's directory and describes the database by path", async () => {
    const path = join(tempDir(), "nested", "oma.db");
    const database = await openSqliteDatabase({ path });
    expect(existsSync(path)).toBe(true);
    expect(database.dialect).toBe("sqlite");
    expect(database.description).toBe(`sqlite ${path}`);
  });

  it("applies Drizzle migrations, readable through the SqlClient", async () => {
    const database = await openSqliteDatabase({ path: join(tempDir(), "oma.db") });
    await database.applyMigrations(migrationsFolder);
    // A second run is a no-op: Drizzle records applied migrations.
    await database.applyMigrations(migrationsFolder);
    await database.sql.prepare("INSERT INTO widgets (id, name) VALUES (?, ?)").bind("w1", "one").run();
    const row = await database.sql.prepare("SELECT name FROM widgets WHERE id = ?").bind("w1").first<{ name: string }>();
    expect(row).toEqual({ name: "one" });
  });

  it("keeps Better Auth in its own file", async () => {
    const dir = tempDir();
    const database = await openSqliteDatabase({ path: join(dir, "oma.db") });
    const authPath = join(dir, "auth", "auth.db");
    const auth = await database.openAuthDatabase!({ sqlitePath: authPath });
    await auth.sql.exec("CREATE TABLE user (id text PRIMARY KEY)");
    expect(auth.database).toBeInstanceOf(BetterSqlite3);
    await auth.stop?.();

    const check = new BetterSqlite3(authPath, { readonly: true });
    const tables = check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    check.close();
    expect(tables).toEqual([{ name: "user" }]);
  });
});
