import { describe, expect, it } from "vitest";
import type { EnvironmentWorkRecord } from "@open-managed-agents/environment-work-store";
import { MemoryEnvironmentWorkStore } from "../src/index";

function record(id: string, createdAt: string, sessionId = `session_${id}`): EnvironmentWorkRecord {
  return {
    work: {
      id,
      acknowledgedAt: null,
      createdAt,
      data: { type: "session", id: sessionId },
      environmentId: "env_01",
      latestHeartbeatAt: null,
      metadata: {},
      startedAt: null,
      state: "queued",
      stopRequestedAt: null,
      stoppedAt: null,
    },
    secret: { sessionsToken: `secret_${id}` },
    claim: null,
    heartbeatTtlSeconds: 90,
  };
}

describe("MemoryEnvironmentWorkStore", () => {
  it("isolates workspaces and protects records with revision CAS", async () => {
    const store = new MemoryEnvironmentWorkStore();
    const initial = record("work_01", "2026-08-26T09:00:00.000Z");
    await expect(store.insert({ workspaceId: "workspace_a", record: initial }))
      .resolves.toEqual({ ...initial, revision: 1 });
    await expect(store.find({
      workspaceId: "workspace_b",
      environmentId: "env_01",
      workId: "work_01",
    })).resolves.toBeNull();

    const next = {
      ...initial,
      work: { ...initial.work, metadata: { shard: "b" } },
    };
    await expect(store.replace({
      workspaceId: "workspace_a",
      environmentId: "env_01",
      workId: "work_01",
      expectedRevision: 1,
      next,
    })).resolves.toEqual({
      type: "replaced",
      record: { ...next, revision: 2 },
    });
    await expect(store.replace({
      workspaceId: "workspace_a",
      environmentId: "env_01",
      workId: "work_01",
      expectedRevision: 1,
      next: initial,
    })).resolves.toEqual({ type: "revision_conflict", actualRevision: 2 });
  });

  it("claims the oldest available work and reports queue/worker state", async () => {
    const store = new MemoryEnvironmentWorkStore();
    const first = record("work_01", "2026-08-26T09:00:00.000Z", "session_01");
    const second = record("work_02", "2026-08-26T09:01:00.000Z", "session_02");
    await store.insert({ workspaceId: "workspace_a", record: first });
    await store.insert({ workspaceId: "workspace_a", record: second });

    const claimed = await store.claimAvailable({
      workspaceId: "workspace_a",
      environmentId: "env_01",
      claimedAt: "2026-08-26T09:02:00.000Z",
      reclaimBefore: "2026-08-26T09:01:55.000Z",
      workerId: "worker_01",
    });
    expect(claimed).toMatchObject({
      type: "claimed",
      record: {
        work: { id: "work_01" },
        claim: { workerId: "worker_01" },
        revision: 2,
      },
    });
    await expect(store.findActiveSession({
      workspaceId: "workspace_a",
      sessionId: "session_01",
    })).resolves.toMatchObject({ work: { id: "work_01" } });
    await expect(store.list({
      workspaceId: "workspace_a",
      environmentId: "env_01",
      limit: 10,
    })).resolves.toMatchObject([
      { work: { id: "work_02" } },
      { work: { id: "work_01" } },
    ]);
    await expect(store.queueStats({
      workspaceId: "workspace_a",
      environmentId: "env_01",
      workerActiveSince: "2026-08-26T09:01:30.000Z",
    })).resolves.toEqual({
      depth: 1,
      oldestQueuedAt: "2026-08-26T09:00:00.000Z",
      pending: 1,
      workersPolling: 1,
    });
  });
});
