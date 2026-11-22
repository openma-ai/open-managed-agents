import { beforeEach, describe, expect, it } from "vitest";
import { createBetterSqlite3SqlClient, type SqlClient } from "@open-managed-agents/sql-client";
import { managedToolRequestSchema, SqlToolRequestStore } from "../src";
import type { ToolRequestInput } from "@open-managed-agents/session-runtime-contract/tool-dispatch";

const t0 = "2026-11-21T00:00:00.000Z";

function request(id: string, toolName: string, overrides: Partial<ToolRequestInput> = {}): ToolRequestInput {
  return {
    id,
    idempotencyKey: `idem-${id}`,
    workspaceId: "workspace-1",
    sessionId: "session-1",
    toolUseId: `tool-${id}`,
    toolName,
    args: { id },
    concurrency: "parallel_safe",
    createdAt: t0,
    ...overrides,
  };
}

describe("SqlToolRequestStore", () => {
  let sql: SqlClient;

  beforeEach(async () => {
    sql = await createBetterSqlite3SqlClient(":memory:");
    await sql.exec(managedToolRequestSchema);
  });

  it("persists idempotency, claims parallel work, and stores a durable result", async () => {
    const store = new SqlToolRequestStore(sql, { dialect: "sqlite" });
    const first = request("request-1", "read");
    await expect(store.enqueue(first)).resolves.toMatchObject({ type: "enqueued" });
    await expect(store.enqueue(first)).resolves.toMatchObject({ type: "replayed" });
    await expect(store.enqueue({ ...first, args: { changed: true } })).resolves.toMatchObject({ type: "conflict" });
    await expect(store.enqueue({ ...first, idempotencyKey: "different-key" })).resolves.toMatchObject({ type: "conflict" });
    await store.enqueue(request("request-2", "read"));

    const claimed = await store.poll({ workerId: "worker-1", now: t0, leaseTtlMs: 30_000, limit: 8 });
    expect(claimed.type).toBe("claimed");
    if (claimed.type !== "claimed") return;
    expect(claimed.leases).toHaveLength(2);
    const completed = await store.complete({
      fence: claimed.leases[0].fence,
      result: { status: "succeeded", isError: false, content: "ok", completedAt: "2026-11-21T00:00:01.000Z" },
    });
    expect(completed.type).toBe("completed");
    const found = await store.find({ requestId: claimed.leases[0].request.id });
    expect(found?.result?.content).toBe("ok");
  });

  it("keeps resource-serial work behind an active lease and reclaims expiry", async () => {
    const store = new SqlToolRequestStore(sql, { dialect: "sqlite" });
    await store.enqueue(request("a-write", "write", { concurrency: "resource_serial", resourceKey: "workspace-1/session-1" }));
    await store.enqueue(request("b-read", "read"));
    const first = await store.poll({ workerId: "worker-1", now: t0, leaseTtlMs: 10_000, limit: 8 });
    expect(first.type).toBe("claimed");
    if (first.type !== "claimed") return;
    expect(first.leases).toHaveLength(1);
    expect(first.leases[0].request.id).toBe("a-write");

    const blocked = await store.poll({ workerId: "worker-2", now: "2026-11-21T00:00:05.000Z", leaseTtlMs: 10_000, limit: 8 });
    expect(blocked.type).toBe("empty");
    const reclaimed = await store.poll({ workerId: "worker-2", now: "2026-11-21T00:00:11.000Z", leaseTtlMs: 10_000, limit: 8 });
    expect(reclaimed.type).toBe("claimed");
    if (reclaimed.type !== "claimed") return;
    expect(reclaimed.leases[0].request.id).toBe("a-write");
    await expect(store.complete({
      fence: first.leases[0].fence,
      result: { status: "succeeded", isError: false, completedAt: "2026-11-21T00:00:12.000Z" },
    })).resolves.toMatchObject({ type: "lost" });
  });
});
