import { describe, expect, it, vi } from "vitest";
import { finalizeStaleTurns, type StaleTurnFinalizerPort } from "../src/finalize-stale-turns";

const NOW = 1_000_000;

function port(overrides: Partial<StaleTurnFinalizerPort> = {}) {
  const appended: Array<Record<string, unknown>> = [];
  const graces: number[] = [];
  const ended: string[] = [];
  const value: StaleTurnFinalizerPort = {
    unknownToolResultText: "unknown",
    instanceStartedAt: NOW - 60_000,
    now: () => NOW,
    listToolUses: () => [],
    listToolResultIds: () => [],
    parkedCallIds: () => [],
    append: async (event) => { appended.push(event as never); },
    broadcast: () => undefined,
    listOrphanTurns: async () => [],
    endTurn: async (id) => { ended.push(id); },
    isTurnActive: () => false,
    hasLiveWork: () => false,
    latestSessionStatus: () => null,
    clearMarkerlessTurn: async () => true,
    scheduleGraceRetry: async (at) => { graces.push(at); },
    log: () => undefined,
    ...overrides,
  };
  return { value, appended, graces, ended };
}
const orphan = (turn_id: string, turn_started_at: number) => ({ session_id: "s", turn_id, turn_started_at });
const types = (events: Array<Record<string, unknown>>) => events.map((event) => event.type);
const dangling = { type: "session.status_running", ts: (NOW - 120_000) / 1000 };

describe("finalizeStaleTurns", () => {
  it("closes unpaired calls by kind, keeps the thread, skips answered and parked ones", async () => {
    const { value, appended } = port({
      listToolUses: () => [
        { id: "a", type: "agent.tool_use", thread: "sthr_x" },
        { id: "m", type: "agent.mcp_tool_use" },
        { id: "done", type: "agent.tool_use" },
        { id: "parked", type: "agent.custom_tool_use" },
      ],
      listToolResultIds: () => ["done"],
      parkedCallIds: () => ["parked"],
    });
    await finalizeStaleTurns(value);
    expect(appended).toEqual([
      { type: "agent.tool_result", tool_use_id: "a", content: "unknown", is_error: true, session_thread_id: "sthr_x" },
      { type: "agent.mcp_tool_result", mcp_tool_use_id: "m", content: "unknown", is_error: true },
    ]);
  });

  it("ends a dead incarnation's turn with rescheduled then idle, even when it is seconds old", async () => {
    const { value, appended, ended } = port({ instanceStartedAt: NOW, listOrphanTurns: async () => [orphan("t", NOW - 1_000)] });
    await finalizeStaleTurns(value);
    expect(ended).toEqual(["t"]);
    expect(types(appended)).toEqual(["session.status_rescheduled", "session.status_idle"]);
  });

  it("skips live turns and re-checks a fresh turn of this incarnation after its grace", async () => {
    const { value, appended, ended, graces } = port({
      listOrphanTurns: async () => [orphan("live", NOW - 1), orphan("fresh", NOW - 1_000)],
      isTurnActive: (id) => id === "live",
    });
    await finalizeStaleTurns(value);
    expect(ended).toEqual([]);
    expect(appended).toEqual([]);
    expect(graces).toEqual([NOW + 30_000]);
  });

  it("emits nothing for a turn whose marker could not be cleared", async () => {
    vi.spyOn(console, "warn").mockImplementationOnce(() => undefined);
    const { value, appended } = port({
      listOrphanTurns: async () => [orphan("t", NOW - 120_000)],
      endTurn: async () => { throw new Error("d1"); },
    });
    await finalizeStaleTurns(value);
    expect(appended).toEqual([]);
  });

  it("closes a markerless dangling turn only when its row actually changed", async () => {
    const closed = port({ latestSessionStatus: () => dangling });
    await finalizeStaleTurns(closed.value);
    expect(types(closed.appended)).toEqual(["session.status_rescheduled", "session.status_idle"]);
    const raced = port({ latestSessionStatus: () => dangling, clearMarkerlessTurn: async () => false });
    await finalizeStaleTurns(raced.value);
    expect(raced.appended).toEqual([]);
  });

  it("leaves a markerless turn alone while this incarnation has live work or an orphan was seen", async () => {
    const clear = vi.fn(async () => true);
    await finalizeStaleTurns(port({ latestSessionStatus: () => dangling, clearMarkerlessTurn: clear, hasLiveWork: () => true }).value);
    await finalizeStaleTurns(port({
      latestSessionStatus: () => dangling,
      clearMarkerlessTurn: clear,
      listOrphanTurns: async () => [orphan("live", NOW - 1)],
      isTurnActive: () => true,
    }).value);
    expect(clear).not.toHaveBeenCalled();
  });
});
