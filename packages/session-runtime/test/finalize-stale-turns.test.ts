import { describe, expect, it, vi } from "vitest";
import {
  deadExecutionFailure,
  finalizeStaleTurns,
  type SessionExecutionRecords,
  type StaleTurnFinalizerPort,
} from "../src/finalize-stale-turns";

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
    executions: async () => ({ store: null, workspaceId: "w", sessionId: "s" }),
    scheduleGraceRetry: async (at) => { graces.push(at); },
    log: () => undefined,
    ...overrides,
  };
  return { value, appended, graces, ended };
}
const orphan = (turn_id: string, turn_started_at: number) => ({ session_id: "s", turn_id, turn_started_at });
const types = (events: Array<Record<string, unknown>>) => events.map((event) => event.type);
const dangling = { type: "session.status_running", ts: (NOW - 120_000) / 1000 };

function settled(state: "failed" | "completed", settledAtMs: number, failure: string | null = null) {
  return { state, settledAt: new Date(settledAtMs).toISOString(), failure } as never;
}
function records(active: unknown[], last: ReturnType<typeof settled> | null) {
  return {
    listActive: vi.fn(async () => active),
    latestSettled: vi.fn(async () => last),
  } satisfies SessionExecutionRecords;
}

describe("deadExecutionFailure", () => {
  const scope = { workspaceId: "w", sessionId: "s" };
  const turnAt = 10_000;
  it("reads the failure the sweep settled after the turn started", async () => {
    expect(await deadExecutionFailure({ store: records([], settled("failed", turnAt + 1, "lease expired")), ...scope }, turnAt)).toBe("lease expired");
    expect(await deadExecutionFailure({ store: records([], settled("failed", turnAt, null)), ...scope }, turnAt)).toBe("execution failed");
  });
  it("is null while an execution is queued or running, or with no store", async () => {
    expect(await deadExecutionFailure({ store: records([{}], settled("failed", turnAt + 1)), ...scope }, turnAt)).toBeNull();
    expect(await deadExecutionFailure({ store: null, ...scope }, turnAt)).toBeNull();
  });
  it("is null when the last execution completed, settled before the turn, or none settled", async () => {
    expect(await deadExecutionFailure({ store: records([], settled("completed", turnAt + 1)), ...scope }, turnAt)).toBeNull();
    expect(await deadExecutionFailure({ store: records([], settled("failed", turnAt - 1, "older")), ...scope }, turnAt)).toBeNull();
    expect(await deadExecutionFailure({ store: records([], null), ...scope }, turnAt)).toBeNull();
  });
});

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

  it("leaves unpaired calls alone while this incarnation has live work (a running call is unpaired too)", async () => {
    const listToolUses = vi.fn(() => [{ id: "running", type: "agent.tool_use" }]);
    const { value, appended } = port({ listToolUses, hasLiveWork: () => true });
    await finalizeStaleTurns(value);
    expect(appended).toEqual([]);
    expect(listToolUses).not.toHaveBeenCalled();
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

  // cf-container-acp-mm-r1 (session_30b83e8f17f44e72a04e92393e8169f4): the
  // SessionDO isolate died mid-turn, the lease sweep settled the execution
  // failed, and with no marker in the unified sessions row every recovery
  // pass skipped it — status_running forever, no session.error.
  it("fails a markerless turn whose execution the lease sweep settled failed, as Node fails a turn", async () => {
    const store = records([], settled("failed", dangling.ts * 1000 + 1_000, "execution interrupted after applied input"));
    const { value, appended } = port({
      latestSessionStatus: () => dangling,
      clearMarkerlessTurn: async () => false,
      executions: async () => ({ store, workspaceId: "w", sessionId: "s" }),
    });
    await finalizeStaleTurns(value);
    expect(store.latestSettled).toHaveBeenCalledWith({ workspaceId: "w", sessionId: "s" });
    expect(appended).toEqual([
      {
        type: "session.error",
        error: {
          type: "unknown_error",
          message: "The agent runtime stopped during the turn (execution interrupted after applied input). Send a new message to continue.",
          retry_status: { type: "exhausted" },
        },
      },
      { type: "session.status_idle", stop_reason: { type: "retries_exhausted" } },
    ]);
  });

  it("does not ask the execution record once the markerless row itself was ended", async () => {
    const executions = vi.fn(async () => ({ store: null, workspaceId: "w", sessionId: "s" }));
    const { value, appended } = port({ latestSessionStatus: () => dangling, executions });
    await finalizeStaleTurns(value);
    expect(executions).not.toHaveBeenCalled();
    expect(types(appended)).toEqual(["session.status_rescheduled", "session.status_idle"]);
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
