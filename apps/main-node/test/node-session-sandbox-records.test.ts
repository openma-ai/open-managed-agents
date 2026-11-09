import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import { SqlSessionSandboxRecords } from "../../../packages/control-plane-node/src/lib/node-session-sandbox-records";

// Design §0.0b A.10: the Node handle record's save is one conditional
// statement, so two processes writing from the same version cannot both win.

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function twoProcesses() {
  const root = mkdtempSync(join(tmpdir(), "oma-sandbox-records-"));
  roots.push(root);
  const a = await createBetterSqlite3SqlClient(join(root, "records.db"));
  const b = await createBetterSqlite3SqlClient(join(root, "records.db"));
  await a.exec(`CREATE TABLE kv_entries (tenant_id TEXT NOT NULL, "key" TEXT NOT NULL, value TEXT NOT NULL, expires_at INTEGER, PRIMARY KEY (tenant_id, "key"))`);
  return { a: new SqlSessionSandboxRecords(a), b: new SqlSessionSandboxRecords(b), sql: a };
}

const record = (runtimeId: string, version: number) => ({ phase: "running" as const, handle: { provider: "fake", runtimeId }, runStartedAt: 1, latestSnapshot: { status: "none" as const }, stores: [], outputs: false, version });

describe("SqlSessionSandboxRecords", () => {
  it("first write: of two inserts from version 0 only one wins", async () => {
    const { a, b } = await twoProcesses();
    expect(await a.save("ws", "s1", record("ra", 1), 0)).toBe(true);
    expect(await b.save("ws", "s1", record("rb", 1), 0)).toBe(false);
    expect(await b.load("ws", "s1")).toEqual(record("ra", 1));
  });

  it("later writes: of two updates from the same version only one wins; the winner's record stays", async () => {
    const { a, b } = await twoProcesses();
    await a.save("ws", "s1", record("r0", 1), 0);
    const [wonA, wonB] = await Promise.all([a.save("ws", "s1", record("ra", 2), 1), b.save("ws", "s1", record("rb", 2), 1)]);
    expect([wonA, wonB].filter(Boolean)).toHaveLength(1);
    expect(await a.load("ws", "s1")).toEqual(record(wonA ? "ra" : "rb", 2));
    expect(await a.save("ws", "s1", record("stale", 2), 1)).toBe(false);
  });

  it("records are per workspace and Session", async () => {
    const { a } = await twoProcesses();
    await a.save("ws", "s1", record("r1", 1), 0);
    await a.save("ws2", "s1", record("r2", 1), 0);
    expect(await a.load("ws", "s1")).toEqual(record("r1", 1));
    expect(await a.load("ws2", "s1")).toEqual(record("r2", 1));
    expect(await a.load("ws", "s2")).toBeUndefined();
  });
});
