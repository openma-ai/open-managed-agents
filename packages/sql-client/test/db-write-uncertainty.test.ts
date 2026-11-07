import { describe, expect, it, vi } from "vitest";
import { CfD1SqlClient } from "../src/adapters/cf-d1";
import { PostgresSqlClient } from "../src/adapters/postgres";
import { ConnectionLost, driverRetry } from "../src/db-errors";
import { translatePostgresError } from "../src/adapters/postgres-errors";

describe("unknown database write outcomes", () => {
  it("does not repeat a D1 write or atomic batch after a committed response is lost", async () => {
    let writes = 0;
    const lost = () => new Error("D1_ERROR: Network connection lost.");
    const statement = { bind() { return this; }, run: async () => { writes++; throw lost(); } };
    const binding = { prepare: () => statement, batch: async () => { writes++; throw lost(); } };
    const sql = new CfD1SqlClient(binding as unknown as D1Database);
    await expect(sql.prepare("UPDATE balances SET balance = balance + 1").run()).rejects.toBeInstanceOf(ConnectionLost);
    expect(writes).toBe(1);
    await expect(sql.batch([sql.prepare("UPDATE balances SET balance = balance + 1")])).rejects.toBeInstanceOf(ConnectionLost);
    expect(writes).toBe(2);
  });

  it("does not repeat a PostgreSQL transaction whose commit acknowledgement was lost", async () => {
    let balance = 0;
    const tx = { unsafe: async () => { balance++; return Object.assign([], { count: 1 }); } };
    const begin = vi.fn(async (operation: (connection: typeof tx) => Promise<unknown>) => {
      await operation(tx);
      throw Object.assign(new Error("commit response lost"), { code: "CONNECTION_CLOSED" });
    });
    const sql = new PostgresSqlClient({ ...tx, begin } as any);
    await expect(sql.batch([sql.prepare("UPDATE balances SET balance = balance + 1")])).rejects.toBeInstanceOf(ConnectionLost);
    expect(balance).toBe(1); expect(begin).toHaveBeenCalledOnce();
  });

  it("allows connection retry only when the operation owner explicitly guarantees replay safety", async () => {
    let reads = 0;
    const retry = driverRetry(translatePostgresError);
    const result = await retry(async () => {
      if (++reads === 1) throw Object.assign(new Error("read disconnected"), { code: "CONNECTION_CLOSED" });
      return "snapshot";
    }, { retryConnectionLost: true });
    expect(result).toBe("snapshot"); expect(reads).toBe(2);
  });
});
