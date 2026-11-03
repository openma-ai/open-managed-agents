import { expect, it } from "vitest";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import { SqlMcpOAuthCliStore } from "../src/mcp-oauth-cli-store";

it("uses existing kv_entries with atomic callback CAS and one-time claim across independent adapters", async () => {
  const sql = await createBetterSqlite3SqlClient(":memory:");
  await sql.exec("CREATE TABLE kv_entries (tenant_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, expires_at INTEGER, PRIMARY KEY (tenant_id, key))");
  const first = new SqlMcpOAuthCliStore(sql, { now: () => new Date(1000) });
  const second = new SqlMcpOAuthCliStore(sql, { now: () => new Date(1000) });
  await first.create("flow_1", "pending", 2000);
  expect(await second.read("flow_1")).toBe("pending");
  expect(await Promise.all([first.compareAndSwap("flow_1", "pending", "ready"), second.compareAndSwap("flow_1", "pending", "ready")])).toEqual([true, false]);
  expect(await Promise.all([first.consume("flow_1", "ready"), second.consume("flow_1", "ready")])).toEqual([true, false]);
  expect(await first.read("flow_1")).toBeNull();
  await first.create("expired", "secret", 1000);
  expect(await second.read("expired")).toBeNull();
  expect(await first.compareAndSwap("expired", "secret", "ready")).toBe(false);
});
