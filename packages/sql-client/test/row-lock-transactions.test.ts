import { describe, expect, it } from "vitest";
import { PostgresSqlClient } from "../src/adapters/postgres";
import { Mysql2SqlClient } from "../src/adapters/mysql2";
import { transactionScope } from "../src/transaction-scope";
import type { SqlStatement, SqlTransaction } from "../src/ports";

// Driver-contract tests supplement real database gates; not S1-S5 evidence.
describe("connection-bound transaction contract", () => {
  it("drains outstanding readback before rejecting an unawaited statement", async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let readback = false;
    const scope = transactionScope(async () => { await blocked; readback = true; return { meta: { changes: 1 } }; });
    const operation = scope.client.prepare("UPDATE claims RETURNING id").run();
    const closing = scope.close();
    const rejected = expect(closing).rejects.toThrow("unawaited");
    expect(() => scope.client.prepare("SELECT 1")).toThrow("closed");
    expect(readback).toBe(false);
    release(); await operation; await rejected;
    expect(readback).toBe(true);
  });
  it("PostgreSQL uses only tx statements, invalidates retained scope and never retries unknown COMMIT", async () => {
    const calls: string[] = []; let begins = 0;
    const client = new PostgresSqlClient({
      unsafe: async () => { throw new Error("escaped to pool"); },
      begin: async body => {
        begins++;
        await body({ unsafe: async text => { calls.push(text); return [{ id: "a" }]; }, begin: async () => { throw new Error("nested"); } });
        throw new Error("unknown COMMIT");
      },
    });
    let retained!: SqlTransaction; let statement!: SqlStatement;
    await expect(client.rowLockTransactions.run(async tx => {
      retained = tx; statement = tx.prepare("SELECT id FROM claims WHERE id = ? FOR UPDATE SKIP LOCKED").bind("a");
      expect(await statement.first()).toEqual({ id: "a" });
    })).rejects.toThrow("unknown COMMIT");
    expect(begins).toBe(1); expect(calls[1]).toContain("$1");
    expect(() => retained.prepare("SELECT 1")).toThrow("closed");
    await expect(statement.first()).rejects.toThrow("closed");
  });

  it.each([false, true])("MySQL keeps RETURNING readback in scope and releases after validation (reject=%s)", async reject => {
    const calls: string[] = []; let acquired = 0;
    const connection = {
      beginTransaction: async () => { calls.push("BEGIN"); },
      commit: async () => { calls.push("COMMIT"); },
      rollback: async () => { calls.push("ROLLBACK"); },
      release: () => { calls.push("RELEASE"); },
      execute: async (text: string) => {
        calls.push(text);
        if (text.startsWith("SHOW KEYS")) return [[{ Column_name: "id", Seq_in_index: 1 }], []];
        if (text.startsWith("SELECT")) return [[{ id: "a" }], []];
        return [{ affectedRows: 1 }, []];
      },
    };
    const client = new Mysql2SqlClient({
      getConnection: async () => { acquired++; return connection; },
      execute: async () => { throw new Error("escaped to pool"); },
    } as never);
    const result = client.rowLockTransactions.run(async tx => {
      await tx.prepare("SELECT id FROM claims WHERE id = ? FOR UPDATE SKIP LOCKED").bind("a").first();
      expect(await tx.prepare("UPDATE claims SET state = ? WHERE id = ? AND revision = ? RETURNING id").bind("running", "a", 1).first()).toEqual({ id: "a" });
      calls.push("VALIDATE"); if (reject) throw new Error("validation rejected");
    });
    if (reject) await expect(result).rejects.toThrow("validation rejected"); else await result;
    expect(acquired).toBe(1);
    expect(calls.filter(text => text === "BEGIN")).toHaveLength(1);
    expect(calls.at(-2)).toBe(reject ? "ROLLBACK" : "COMMIT");
    expect(calls.at(-1)).toBe("RELEASE");
    expect(calls.findIndex(text => text.startsWith("SELECT id FROM `claims`"))).toBeLessThan(calls.indexOf("VALIDATE"));
  });

  it.each(["5.7.44", "8.0.10", "unknown", "10.11.0-MariaDB"])("explicitly rejects unsupported/unknown MySQL %s without starting a transaction", async version => {
    const client = new Mysql2SqlClient({ execute: async () => [[{ version, identity: "MySQL Community Server" }], []] } as never);
    expect(await client.rowLockTransactions.capability(["claims"])).toMatchObject({ supported: false, version });
  });
  it("rejects an unverified MySQL storage engine", async () => {
    const client = new Mysql2SqlClient({ execute: async (text: string) => [text.includes("VERSION()") ? [{ version: "8.4.0", identity: "MySQL Community Server - GPL" }] : [{ engine: "MyISAM" }], []] } as never);
    expect(await client.rowLockTransactions.capability(["claims"])).toMatchObject({ supported: false, reason: "Table claims is not verified InnoDB; use CAS" });
  });
  it.each(["90400", "unknown"])("explicitly rejects unsupported/unknown PostgreSQL %s", async version_num => {
    const client = new PostgresSqlClient({ unsafe: async () => [{ identity: "PostgreSQL test", version_num, version: version_num }], begin: async () => { throw new Error("unexpected transaction"); } });
    expect(await client.rowLockTransactions.capability([])).toMatchObject({ supported: false });
  });
});
