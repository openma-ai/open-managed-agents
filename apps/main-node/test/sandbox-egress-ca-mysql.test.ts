import { describe, expect, it, vi } from "vitest";
import { Mysql2SqlClient } from "../../../packages/sql-client/src/adapters/mysql2.js";
import { SqlEgressCaStore } from "../../../packages/control-plane-node/src/lib/sandbox-egress/sql-ca-store.js";
import { createNodeSecrets } from "../../../packages/control-plane-node/src/secrets.js";

function mysqlBoundary() {
  const execute = vi.fn<(...args: [string, unknown[]?]) => Promise<[Record<string, unknown>[] | { affectedRows: number }, unknown]>>()
    .mockResolvedValue([{ affectedRows: 1 }, []]);
  const sql = new Mysql2SqlClient({
    execute,
    query: async () => [[], []],
    getConnection: async () => { throw new Error("CA writes must use one atomic statement"); },
    end: async () => {},
  });
  return { sql, execute };
}

const cipher = () => createNodeSecrets("root-test").cipherFor("managed.sandbox-egress.ca");

describe("shared egress CA MySQL boundary", () => {
  it("emits a strict atomic no-op on duplicate keys without suppressing other write errors", async () => {
    const { sql, execute } = mysqlBoundary();
    const store = new SqlEgressCaStore(sql, cipher());
    await store.createIfAbsent({ cert: "public-certificate", key: "private-key-canary" });

    const [query, params] = execute.mock.calls[0]!;
    expect(query.replace(/\s+/g, " ").trim()).toBe(
      "INSERT INTO kv_entries (tenant_id, `key`, value, expires_at) VALUES (?, ?, ?, NULL) ON DUPLICATE KEY UPDATE tenant_id = tenant_id",
    );
    expect(params).toEqual(["__platform__", "sandbox-egress.ca.v1", expect.any(String)]);
    expect(params![2]).not.toContain("private-key-canary");
    expect(JSON.parse(await cipher().decrypt(params![2] as string)))
      .toEqual({ cert: "public-certificate", key: "private-key-canary" });

    execute.mockRejectedValueOnce(Object.assign(new Error("write denied"), { code: "ER_TABLEACCESS_DENIED_ERROR" }));
    await expect(store.createIfAbsent({ cert: "other-cert", key: "other-key" })).rejects.toThrow("write denied");
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("reads the persisted winner through quoted MySQL identifiers and the dedicated cipher", async () => {
    const { sql, execute } = mysqlBoundary();
    const encrypted = await cipher().encrypt(JSON.stringify({ cert: "winner-cert", key: "winner-key" }));
    execute.mockResolvedValueOnce([[{ value: encrypted }], []]);
    await expect(new SqlEgressCaStore(sql, cipher()).load()).resolves.toEqual({ cert: "winner-cert", key: "winner-key" });
    expect(execute).toHaveBeenCalledWith(
      "SELECT value FROM kv_entries WHERE tenant_id = ? AND `key` = ?",
      ["__platform__", "sandbox-egress.ca.v1"],
    );
  });

  it.each([
    { suffix: "ON CONFLICT (tenant_id, \"key\") DO NOTHING", assignment: "tenant_id = tenant_id" },
    { suffix: "ON CONFLICT DO NOTHING", assignment: "`key` = `key`" },
  ])("uses a duplicate-key no-op for $suffix", async ({ suffix, assignment }) => {
    const { sql, execute } = mysqlBoundary();
    await sql.prepare(`INSERT INTO kv_entries ("key", tenant_id, value) VALUES (?, ?, ?) ${suffix}`)
      .bind("ca", "platform", "ciphertext").run();
    expect(execute.mock.calls[0]).toEqual([
      `INSERT INTO kv_entries (\`key\`, tenant_id, value) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE ${assignment}`,
      ["ca", "platform", "ciphertext"],
    ]);
  });
});
