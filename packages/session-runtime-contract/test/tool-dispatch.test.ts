import { describe, expect, it } from "vitest";
import { InMemoryToolRequestStore, ToolRequestDispatcher, ToolRequestWorker } from "../src/tool-dispatch";
import type { ToolRequestInput } from "../src/tool-dispatch";

const at = (seconds: number) => new Date(1_800_000_000_000 + seconds * 1_000).toISOString();

function request(overrides: Partial<ToolRequestInput> = {}): ToolRequestInput {
  return {
    id: overrides.id ?? "r1",
    idempotencyKey: overrides.idempotencyKey ?? overrides.id ?? "r1-key",
    workspaceId: overrides.workspaceId ?? "w1",
    sessionId: overrides.sessionId ?? "s1",
    toolUseId: overrides.toolUseId ?? overrides.id ?? "tool-1",
    toolName: overrides.toolName ?? "read",
    args: overrides.args ?? { path: "/tmp/a" },
    concurrency: overrides.concurrency ?? "parallel_safe",
    resourceKey: overrides.resourceKey,
    createdAt: overrides.createdAt ?? at(0),
    availableAt: overrides.availableAt,
  };
}

describe("tool request lifecycle contract", () => {
  it("deduplicates enqueue and rejects an idempotency conflict", async () => {
    const store = new InMemoryToolRequestStore();
    const first = await store.enqueue(request());
    expect(first.type).toBe("enqueued");
    expect((await store.enqueue(request())).type).toBe("replayed");
    expect((await store.enqueue(request({ args: { path: "/tmp/other" } }))).type).toBe("conflict");
  });

  it("claims parallel-safe work together while serial work waits", async () => {
    const store = new InMemoryToolRequestStore();
    await store.enqueue(request({ id: "parallel-1", idempotencyKey: "parallel-1", resourceKey: "session-files" }));
    await store.enqueue(request({ id: "parallel-2", idempotencyKey: "parallel-2", resourceKey: "session-files", createdAt: at(1) }));
    await store.enqueue(request({
      id: "serial", idempotencyKey: "serial", toolName: "write", concurrency: "resource_serial",
      resourceKey: "session-files", createdAt: at(2),
    }));
    const claimed = await store.poll({ workerId: "worker-a", now: at(3), leaseTtlMs: 30_000, limit: 3 });
    expect(claimed.type).toBe("claimed");
    if (claimed.type !== "claimed") return;
    expect(claimed.leases.map((lease) => lease.request.id)).toEqual(["parallel-1", "parallel-2"]);
    const blocked = await store.poll({ workerId: "worker-b", now: at(4), leaseTtlMs: 30_000, limit: 1 });
    expect(blocked.type).toBe("empty");
    await store.complete({
      fence: claimed.leases[0]!.fence,
      result: { status: "succeeded", isError: false, content: "ok", completedAt: at(5) },
    });
    await store.complete({
      fence: claimed.leases[1]!.fence,
      result: { status: "succeeded", isError: false, content: "ok", completedAt: at(5) },
    });
    const serial = await store.poll({ workerId: "worker-b", now: at(6), leaseTtlMs: 30_000, limit: 1 });
    expect(serial.type).toBe("claimed");
  });

  it("reclaims an expired lease and fences stale completion", async () => {
    const store = new InMemoryToolRequestStore();
    await store.enqueue(request({ id: "r-expire", idempotencyKey: "r-expire" }));
    const first = await store.poll({ workerId: "worker-a", now: at(0), leaseTtlMs: 1_000 });
    expect(first.type).toBe("claimed");
    if (first.type !== "claimed") return;
    const second = await store.poll({ workerId: "worker-b", now: at(2), leaseTtlMs: 1_000 });
    expect(second.type).toBe("claimed");
    if (second.type !== "claimed") return;
    expect((await store.complete({
      fence: first.leases[0]!.fence,
      result: { status: "succeeded", isError: false, completedAt: at(3) },
    })).type).toBe("lost");
    const completed = await store.complete({
      fence: second.leases[0]!.fence,
      result: { status: "succeeded", isError: false, content: "done", completedAt: at(2.5) },
    });
    expect(completed.type).toBe("completed");
    expect((await store.complete({
      fence: second.leases[0]!.fence,
      result: { status: "succeeded", isError: false, content: "done", completedAt: at(2.5) },
    })).type).toBe("replayed");
  });

  it("renews a live lease and rejects a stale generation", async () => {
    const store = new InMemoryToolRequestStore();
    await store.enqueue(request({ id: "r-heartbeat", idempotencyKey: "r-heartbeat" }));
    const claimed = await store.poll({ workerId: "worker-a", now: at(0), leaseTtlMs: 1_000 });
    expect(claimed.type).toBe("claimed");
    if (claimed.type !== "claimed") return;
    const renewed = await store.renew({ fence: claimed.leases[0]!.fence, renewedAt: at(0.5), leaseTtlMs: 2_000 });
    expect(renewed.type).toBe("renewed");
    if (renewed.type !== "renewed") return;
    expect((await store.complete({
      fence: claimed.leases[0]!.fence,
      result: { status: "succeeded", isError: false, completedAt: at(1) },
    })).type).toBe("lost");
    expect((await store.complete({
      fence: renewed.fence,
      result: { status: "succeeded", isError: false, completedAt: at(1) },
    })).type).toBe("completed");
  });

  it("polls, heartbeats, completes, and publishes worker results", async () => {
    const store = new InMemoryToolRequestStore();
    await store.enqueue(request({ id: "p1", idempotencyKey: "p1", resourceKey: "files" }));
    await store.enqueue(request({ id: "p2", idempotencyKey: "p2", resourceKey: "files", createdAt: at(1) }));
    await store.enqueue(request({
      id: "s1", idempotencyKey: "s1", toolName: "write", concurrency: "resource_serial",
      resourceKey: "files", createdAt: at(2),
    }));
    const active = new Map<string, number>();
    const peak = new Map<string, number>();
    const completed: string[] = [];
    const controller = new AbortController();
    const worker = new ToolRequestWorker({
      store,
      workerId: "worker-a",
      leaseTtlMs: 1_000,
      pollIntervalMs: 1,
      now: () => at(10),
      execute: async (item) => {
        const count = (active.get(item.toolName) ?? 0) + 1;
        active.set(item.toolName, count);
        peak.set(item.toolName, Math.max(peak.get(item.toolName) ?? 0, count));
        await new Promise((resolve) => setTimeout(resolve, 5));
        active.set(item.toolName, count - 1);
        return { status: "succeeded", isError: false, content: item.id };
      },
      onCompleted: (item) => {
        completed.push(item.id);
        if (completed.length === 3) controller.abort();
      },
    });
    await worker.run(controller.signal);
    expect(completed.sort()).toEqual(["p1", "p2", "s1"]);
    expect(peak.get("read")).toBe(2);
    expect(peak.get("write")).toBe(1);
  });

  it("connects a dispatcher wait to a polling worker result", async () => {
    const store = new InMemoryToolRequestStore();
    const workerController = new AbortController();
    const worker = new ToolRequestWorker({
      store,
      workerId: "worker-dispatch",
      leaseTtlMs: 1_000,
      pollIntervalMs: 1,
      execute: async (item) => ({ status: "succeeded", isError: false, content: `done:${item.toolName}` }),
      onCompleted: () => workerController.abort(),
    });
    const workerRun = worker.run(workerController.signal);
    const dispatcher = new ToolRequestDispatcher({
      store,
      workspaceId: "w1",
      sessionId: "s1",
      pollIntervalMs: 1,
    });
    await expect(dispatcher.dispatch({
      toolCallId: "call-1",
      toolName: "read",
      args: { path: "/tmp/a" },
      concurrency: "parallel_safe",
    }, new AbortController().signal)).resolves.toEqual({
      status: "succeeded",
      isError: false,
      content: "done:read",
    });
    await workerRun;
  });

  it("parks CMA dispatch after durable enqueue", async () => {
    const store = new InMemoryToolRequestStore();
    let woken = false;
    const dispatcher = new ToolRequestDispatcher({
      store,
      workspaceId: "w1",
      sessionId: "s1",
      parkAfterEnqueue: true,
      onEnqueued: () => { woken = true; },
    });
    await expect(dispatcher.dispatch({
      toolCallId: "call-park",
      toolName: "read",
      args: { path: "/tmp/a" },
      concurrency: "parallel_safe",
    }, new AbortController().signal)).resolves.toMatchObject({
      pending: true,
      requestId: "s1:tool:call-park",
    });
    expect(woken).toBe(true);
    expect((await store.find({ requestId: "s1:tool:call-park" }))?.state).toBe("queued");
  });
});
