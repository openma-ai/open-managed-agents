import { describe, expect, it } from "vitest";
import type { SqlClient } from "@open-managed-agents/sql-client";
import { createSqlSessionExecutionLeases } from "../src/execution-lease";

function sql(current: Record<string, unknown> | null) {
  const seen: unknown[][] = [];
  const client = {
    prepare(query: string) {
      return { bind: (...args: unknown[]) => ({ async first() { seen.push([query, ...args]); return current; } }) };
    },
  } as unknown as SqlClient;
  return { client, seen };
}

describe("createSqlSessionExecutionLeases", () => {
  it("reads the attempt row by workspace and execution (string columns from pg too)", async () => {
    const { client, seen } = sql({ id: "exe_1", session_id: "sess", state: "running", attempt_id: "att_1", owner_id: "owner", generation: "3", claimed_at_ms: "1000", lease_expires_at_ms: "2000" });
    expect(await createSqlSessionExecutionLeases(client).find({ workspaceId: "ws", executionId: "exe_1" })).toEqual({
      executionId: "exe_1", sessionId: "sess", state: "running", attemptId: "att_1", ownerId: "owner", generation: 3, claimedAtMs: 1000, leaseExpiresAtMs: 2000,
    });
    expect(seen[0]).toEqual([expect.stringContaining("FROM managed_session_executions"), "ws", "exe_1"]);
    expect(await createSqlSessionExecutionLeases(sql(null).client).find({ workspaceId: "ws", executionId: "x" })).toBeNull();
  });
});
