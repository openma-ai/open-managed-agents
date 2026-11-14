import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SANDBOX_ORPHAN_RECLAIM_MS,
  sandboxOrphanReclaimMs,
  startSandboxOrphanReclaim,
} from "../../../packages/control-plane-node/src/lib/node-sandbox-orphan-reclaim.js";
import { NodeSessionSandboxes, type NodeSessionSandboxOptions } from "../../../packages/control-plane-node/src/lib/node-session-sandbox.js";

describe("Node sandbox orphan reclaim timer", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.parse("2026-11-09T12:00:00.000Z")); });
  afterEach(() => { vi.useRealTimers(); });

  it("reads SANDBOX_ORPHAN_RECLAIM_MS", () => {
    expect(sandboxOrphanReclaimMs(undefined)).toBe(DEFAULT_SANDBOX_ORPHAN_RECLAIM_MS);
    expect(sandboxOrphanReclaimMs("60000")).toBe(60_000);
    expect(() => sandboxOrphanReclaimMs("10")).toThrow(/at least 1000/);
  });

  it("releases listed sandboxes of archived Sessions on each tick until stopped", async () => {
    const released: string[] = [];
    const lifecycle = {
      handle: "changes",
      async list() {
        return [
          { handle: { provider: "e2b", runtimeId: "sb_archived" }, labels: { workspaceId: "ws", sessionId: "s_archived" }, createdAt: "2026-11-09T10:00:00.000Z" },
          { handle: { provider: "e2b", runtimeId: "sb_live" }, labels: { workspaceId: "ws", sessionId: "s_live" }, createdAt: "2026-11-09T10:00:00.000Z" },
        ];
      },
      async release({ handle }: { handle: { runtimeId: string } }) { released.push(handle.runtimeId); },
    };
    const stop = startSandboxOrphanReclaim({
      lifecycle: lifecycle as never,
      findSession: async ({ sessionId }) => ({ archivedAt: sessionId === "s_archived" ? "2026-11-09T11:00:00.000Z" : null }),
      intervalMs: 1000,
      warn: () => undefined,
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(released).toEqual(["sb_archived"]);
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(released).toEqual(["sb_archived"]);
  });
  // Reconnect never cleans up a replaced allocation inline; the sweeper owns it.
  const replacedWorld = () => {
    const released: string[] = [];
    const lifecycle = {
      handle: "changes",
      async list() {
        return [
          { handle: { provider: "e2b", runtimeId: "sb_replaced" }, labels: { workspaceId: "ws", sessionId: "s_live" }, createdAt: "2026-11-09T10:00:00.000Z" },
          { handle: { provider: "e2b", runtimeId: "sb_current" }, labels: { workspaceId: "ws", sessionId: "s_live" }, createdAt: "2026-11-09T10:00:00.000Z" },
          { handle: { provider: "e2b", runtimeId: "sb_unrecorded" }, labels: { workspaceId: "ws", sessionId: "s_none" }, createdAt: "2026-11-09T10:00:00.000Z" },
        ];
      },
      async release({ handle }: { handle: { runtimeId: string } }) { released.push(handle.runtimeId); },
    };
    return { released, lifecycle };
  };

  it("releases a live Session's replaced sandbox not named by its durable record, keeping the recorded one", async () => {
    const { released, lifecycle } = replacedWorld();
    const stop = startSandboxOrphanReclaim({
      lifecycle: lifecycle as never,
      findSession: async () => ({ archivedAt: null }),
      recordedHandle: async ({ sessionId }) => sessionId === "s_live" ? { provider: "e2b", runtimeId: "sb_current" } : undefined,
      intervalMs: 1000,
      warn: () => undefined,
    });
    await vi.advanceTimersByTimeAsync(1000);
    stop();
    expect(released).toEqual(["sb_replaced"]);
  });

  it("Node composition compares the durable Session record, except for checkpoint_restore allocations", async () => {
    const records = {
      load: async (_workspaceId: string, sessionId: string) => sessionId === "s_live"
        ? { phase: "running", handle: { provider: "e2b", runtimeId: "sb_current" }, runStartedAt: 1, latestSnapshot: { status: "none" }, stores: [], outputs: false, version: 1 }
        : undefined,
      save: async () => true,
    };
    const run = async (compareRecordedHandle: boolean) => {
      const { released, lifecycle } = replacedWorld();
      const sandboxes = new NodeSessionSandboxes({ adapter: { adapter: { lifecycle } }, records, idlePauseMs: 60_000 } as unknown as NodeSessionSandboxOptions);
      const stop = sandboxes.startOrphanReclaim("1000", async () => ({ archivedAt: null }), { warn: () => undefined }, { compareRecordedHandle });
      await vi.advanceTimersByTimeAsync(1000);
      stop();
      return released;
    };
    expect(await run(true)).toEqual(["sb_replaced"]);
    expect(await run(false)).toEqual([]);
  });
});
