import { describe, expect, it } from "vitest";
import { appendStaleTurnEvent, backfillStaleTurnEvents } from "../src/runtime/stale-turn-settlement";
import type { SessionExecutionFence } from "@open-managed-agents/session-runtime-contract/coordination";
const fence: SessionExecutionFence = { workspaceId: "w", sessionId: "s", executionId: "old", attemptId: "a", ownerId: "o", generation: 1, expiresAt: "2026-01-01T00:00:00Z", settlement: "failed" };
describe("CF stale turn settlement infrastructure", () => {
  it("backfills canonical events after a crash even when a newer execution owns the Session", async () => {
    const event = { id: "stale:old:1:session.status_idle", type: "session.status_idle", processedAt: "2026-01-01T00:00:00Z" };
    const local: any[] = [], sent: string[] = [];
    const input = { binding: { managedSessionStaleEvents: async () => [event] } as never,
      workspaceId: "w", sessionId: "s", hasEvent: (id: string) => local.some(e => e.id === id),
      append: (e: any) => { local.push(e); }, sockets: () => [{ send: (data: string) => sent.push(data) } as WebSocket] };
    await backfillStaleTurnEvents(input);
    await backfillStaleTurnEvents(input);
    expect(local).toEqual([event]); expect(sent.map(data => JSON.parse(data))).toEqual([event]);
  });
  it("persists and broadcasts nothing when atomic projection rejects a superseded attempt", async () => {
    const local: unknown[] = [], sent: string[] = [];
    const binding = { managedSessionEventProduced: async (input: any) => {
      expect(input.executionFence).toEqual(fence);
      return { type: "execution_fence_lost" };
    } } as never;
    expect(await appendStaleTurnEvent({ binding, workspaceId: "w", sessionId: "s", append: e => local.push(e), sockets: () => [{ send: (data: string) => sent.push(data) } as WebSocket] }, { type: "session.status_idle" } as never, fence)).toBe(false);
    expect(local).toEqual([]); expect(sent).toEqual([]);
  });
  it("retains retry eligibility when canonical persistence fails", async () => {
    const local: unknown[] = [];
    const binding = { managedSessionEventProduced: async () => { throw new Error("D1 unavailable"); } } as never;
    await expect(appendStaleTurnEvent({ binding, workspaceId: "w", sessionId: "s", append: e => local.push(e), sockets: () => [] }, { type: "session.error" } as never, fence)).rejects.toThrow("D1 unavailable");
    expect(local).toEqual([]);
  });
});
