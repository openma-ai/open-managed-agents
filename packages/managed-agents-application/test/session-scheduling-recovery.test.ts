import { describe, expect, it } from "vitest";
import { SessionSchedulingRecoveryService } from "../src/session-events/scheduling-recovery";
import type { SessionRuntimeHistoryEventView } from "../src/session-execution/port";

function fixture(rows: SessionRuntimeHistoryEventView[]) {
  const scheduled: unknown[] = [];
  const session = { id: "s", environmentId: "e", archivedAt: null, agent: { openma: { harness: "acp-sandbox" } } } as never;
  const service = new SessionSchedulingRecoveryService({ workspaceId: "w",
    execution: { find: async () => ({ revision: 9, session, environment: { id: "e", archivedAt: null, config: { type: "cloud" } } as never }) },
    history: { loadSessionRuntimeHistory: async () => ({ type: "found", revision: 9, initialEvents: [], events: rows.map(row => row.event), orderedEvents: rows }) },
    dispatch: { sessionEventsAccepted: async () => { throw new Error("must not replay execution"); }, recoverSessionScheduling: async input => { scheduled.push(input); } },
  });
  return { service, scheduled };
}
const message = (id: string, revision: number, extra = {}): SessionRuntimeHistoryEventView => ({
  position: { revision, index: 0 }, event: { id, type: "user.message", content: [], processedAt: null, ...extra } as never,
});
const idle = (type: string, revision: number): SessionRuntimeHistoryEventView => ({ position: { revision, index: 0 },
  event: { id: "idle", type: "session.status_idle", processedAt: "2026-11-10T00:00:00.000Z", stopReason: { type, eventIds: ["tool"] } } as never });

describe("canonical Session scheduling recovery", () => {
  it("only ensures a consumer of the exact history revision", async () => {
    const f = fixture([message("input", 2)]);
    expect(await f.service.recoverSessionScheduling({ sessionId: "s" })).toEqual({ type: "scheduled" });
    expect(f.scheduled).toMatchObject([{ expectedSessionRevision: 9, events: [{ id: "input", processedAt: null }] }]);
  });
  it("does not revive queued inputs held before retries_exhausted, but permits a new round", async () => {
    const held = fixture([message("held", 2), idle("retries_exhausted", 3)]);
    expect(await held.service.recoverSessionScheduling({ sessionId: "s" })).toEqual({ type: "idle" });
    expect(held.scheduled).toEqual([]);
    const next = fixture([message("held", 2), idle("retries_exhausted", 3), message("fresh", 4)]);
    await next.service.recoverSessionScheduling({ sessionId: "s" });
    expect(next.scheduled).toMatchObject([{ events: [{ id: "fresh" }] }]);
  });
  it("still schedules queued input not consumed by a preceding end_turn", async () => {
    const f = fixture([message("queued", 2), idle("end_turn", 3)]);
    expect(await f.service.recoverSessionScheduling({ sessionId: "s" })).toEqual({ type: "scheduled" });
    expect(f.scheduled).toMatchObject([{ events: [{ id: "queued" }] }]);
  });
  it("never replays a consumed tool result with an unknown external effect", async () => {
    const f = fixture([{ position: { revision: 2, index: 0 }, consumedByExecutionId: "old-execution",
      event: { id: "result", type: "user.custom_tool_result", customToolUseId: "tool", processedAt: "2026-11-10T00:00:00.000Z" } as never }]);
    expect(await f.service.recoverSessionScheduling({ sessionId: "s" })).toEqual({ type: "idle" });
    expect(f.scheduled).toEqual([]);
  });

  it.each(["deferred", "cancelled", "consumed", "processed", "interrupt", "system", "ra"])("does not schedule %s input", async kind => {
    let row = message("input", 4);
    if (kind === "deferred") row = message("input", 4, { deferredUntilToolResults: ["tool"] });
    if (kind === "cancelled") row = message("input", 4, { cancelled_at_ms: 1 });
    if (kind === "consumed") row.consumedByExecutionId = "previous-execution";
    if (kind === "processed") row = message("input", 4, { processedAt: "2026-11-10T00:00:00.000Z" });
    if (kind === "interrupt" || kind === "system") row.event = { id: "input", type: kind === "interrupt" ? "user.interrupt" : "system.message", processedAt: null, content: [] } as never;
    const f = fixture(kind === "ra" ? [idle("requires_action", 3), row] : [row]);
    expect(await f.service.recoverSessionScheduling({ sessionId: "s" })).toEqual({ type: "idle" });
    expect(f.scheduled).toEqual([]);
  });
});
