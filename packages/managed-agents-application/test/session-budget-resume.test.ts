import { describe, expect, it } from "vitest";
import {
  sessionExecutionEventBatches,
  sessionExecutionEvents,
} from "@open-managed-agents/session-runtime-contract/coordination";
import { SessionEventsApplicationService } from "../src/index";
import { validateBudgetUpdate } from "../src/sessions/budget";

const base = {
  id: "session_01",
  agent: { id: "agent_01", description: null, mcpServers: [], model: { id: "m" }, multiagent: null, name: "a", skills: [], system: null, tools: [], version: 1 },
  archivedAt: null,
  createdAt: "2026-11-01T00:00:00.000Z",
  environmentId: "env_01",
  metadata: {},
  outcomeEvaluations: [],
  resources: [],
  stats: {},
  status: "idle",
  title: null,
  updatedAt: "2026-11-01T00:00:00.000Z",
  vaultIds: [],
};
const session = (cap: string | null, pico: string) => ({
  ...base,
  budget: cap === null ? null : { amountMinor: cap, currency: "USD" },
  usage: { listCost: { amountMinor: "330", currency: "USD" }, list_cost_pico: pico },
}) as any;

function harness(storedSession: any, latestStop: string) {
  const appended: any[] = [];
  const dispatched: any[] = [];
  const service = new SessionEventsApplicationService({
    workspaceId: "ws",
    store: {
      append: async (input: any) => {
        appended.push(input);
        return { type: "appended", events: input.events, session: input.nextSession };
      },
      list: async () => [{ id: "e0", type: "session.status_idle", processedAt: "x", stopReason: { type: latestStop } }],
    } as any,
    sessions: { find: async () => storedSession } as any,
    execution: { find: async () => ({ session: storedSession, environment: {} as any, revision: 3 }) } as any,
    stream: { subscribe: () => (async function* () {})() } as any,
    dispatch: { sessionEventsAccepted: async (input: any) => { dispatched.push(input); } },
    clock: { now: () => new Date("2026-11-01T01:00:00.000Z") },
    ids: { nextEventId: () => "sevt_upd", nextOutcomeId: () => "o" },
  });
  return { service, appended, dispatched };
}

describe("budget update emits session.updated and resumes", () => {
  const pausedBefore = session("300", "3300000000000"); // $3.30 consumed, $3 cap

  it("raising the cap on a budget_reached session emits session.updated and admits a resume", async () => {
    const h = harness(session("500", "3300000000000"), "budget_reached");
    const result = await h.service.recordBudgetUpdate({ sessionId: "session_01", previous: pausedBefore });
    expect(result).toEqual({ type: "recorded", resumed: true });
    expect(h.appended[0].events).toEqual([{
      id: "sevt_upd", type: "session.updated", processedAt: "2026-11-01T01:00:00.000Z",
      budget: { amountMinor: "500", currency: "USD" }, resume: true,
    }]);
    expect(h.dispatched).toHaveLength(1);
    // The continuation execution is admitted without any user event.
    expect(sessionExecutionEvents(h.dispatched[0].events)).toHaveLength(1);
    expect(sessionExecutionEventBatches(h.dispatched[0].events)[0]!.laneId).toBe("sthr_primary");
  });

  it("removing the budget also resumes", async () => {
    const h = harness(session(null, "3300000000000"), "budget_reached");
    expect(await h.service.recordBudgetUpdate({ sessionId: "session_01", previous: pausedBefore }))
      .toEqual({ type: "recorded", resumed: true });
    expect(h.appended[0].events[0].budget).toBeNull();
  });

  it("an update on a session that was not paused emits session.updated without executing", async () => {
    const h = harness(session("900", "100"), "end_turn");
    expect(await h.service.recordBudgetUpdate({ sessionId: "session_01", previous: session("500", "100") }))
      .toEqual({ type: "recorded", resumed: false });
    expect(h.appended[0].events[0].resume).toBeUndefined();
    expect(h.dispatched).toHaveLength(0);
    expect(sessionExecutionEvents(h.appended[0].events)).toEqual([]);
    expect(sessionExecutionEventBatches(h.appended[0].events)).toEqual([]);
  });
});

describe("exact consumed cost in the update check", () => {
  it("compares against unrounded picodollars", () => {
    // consumed $3.004 rounds to 300 cents, but a 300-cent cap is not > consumed.
    const s = session("200", "3004000000000");
    s.usage.listCost.amountMinor = "300";
    expect(validateBudgetUpdate(s, { amountMinor: "300", currency: "USD" } as any)).not.toBeNull();
    expect(validateBudgetUpdate(s, { amountMinor: "301", currency: "USD" } as any)).toBeNull();
    // consumed $2.996 rounds to 300 cents; a 300-cent cap IS greater.
    const t = session("200", "2996000000000");
    expect(validateBudgetUpdate(t, { amountMinor: "300", currency: "USD" } as any)).toBeNull();
  });
});
