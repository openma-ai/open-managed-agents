import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SANDBOX_ORPHAN_RECLAIM_MS,
  sandboxOrphanReclaimMs,
  startSandboxOrphanReclaim,
} from "../../../packages/control-plane-node/src/lib/node-sandbox-orphan-reclaim.js";

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
});
