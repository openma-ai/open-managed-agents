import { describe, expect, it } from "vitest";
import type { SessionEventView } from "@open-managed-agents/domain/sessions";
import type { MarkSessionEventsProcessed } from "@open-managed-agents/session-event-store";
import type { SentSessionEvent } from "../src/ports/session-events";
import {
  isQueuedSessionEventType,
  markSessionEventsProcessed,
  SessionEventsApplicationService,
} from "../src/index";

const session = {
  id: "session_01", agent: { id: "agent_01", version: 1 }, archivedAt: null,
  createdAt: "2026-08-26T04:00:00.000Z", environmentId: "env_01", metadata: {},
  outcomeEvaluations: [], status: "running", updatedAt: "2026-08-26T04:00:00.000Z",
} as never;

function serviceFor(config: { type: "cloud" } | { type: "self_hosted" }) {
  const appended: SentSessionEvent[] = [];
  const service = new SessionEventsApplicationService({
    workspaceId: "workspace_01",
    store: {
      append: async (input) => {
        appended.push(...input.events);
        return { type: "appended", events: input.events, session: input.nextSession };
      },
      list: async () => [],
    },
    sessions: { find: async () => session },
    execution: {
      find: async () => ({ session, environment: { id: "env_01", config } as never, revision: 1 }),
    },
    stream: { subscribe: () => (async function* () {})() },
    dispatch: { sessionEventsAccepted: async () => {} },
    clock: { now: () => new Date("2026-08-26T05:00:00.000Z") },
    ids: { nextEventId: (() => { let n = 0; return () => `event_0${++n}`; })(), nextOutcomeId: () => "outcome_01" },
  });
  return { service, appended };
}

describe("queued input processing (Claude Managed Agents processed_at)", () => {
  it("classifies queued input types", () => {
    for (const type of ["user.message", "user.interrupt", "user.tool_confirmation", "system.message"]) {
      expect(isQueuedSessionEventType(type)).toBe(true);
    }
    for (const type of ["user.define_outcome", "user.custom_tool_result", "user.tool_result", "agent.message"]) {
      expect(isQueuedSessionEventType(type)).toBe(false);
    }
  });

  it("returns queued inputs with null processed_at and stamps receipt-processed inputs", async () => {
    const { service, appended } = serviceFor({ type: "cloud" });
    const result = await service.sendSessionEvents({
      sessionId: "session_01",
      events: [
        { type: "user.message", content: [{ type: "text", text: "hi" }] },
        { type: "user.interrupt" },
        { type: "user.tool_confirmation", toolUseId: "t1", result: "allow" },
        { type: "user.custom_tool_result", customToolUseId: "c1" },
        { type: "user.tool_result", toolUseId: "t2" },
      ],
    });
    expect(result.type).toBe("accepted");
    expect(appended.map((event) => [event.type, event.processedAt])).toEqual([
      ["user.message", null],
      ["user.interrupt", null],
      ["user.tool_confirmation", null],
      ["user.custom_tool_result", "2026-08-26T05:00:00.000Z"],
      ["user.tool_result", "2026-08-26T05:00:00.000Z"],
    ]);
  });

  it("keeps stamp-on-receipt for self-hosted Environment Work", async () => {
    const { service, appended } = serviceFor({ type: "self_hosted" });
    await service.sendSessionEvents({
      sessionId: "session_01",
      events: [{ type: "user.message", content: [{ type: "text", text: "hi" }] }],
    });
    expect(appended[0]?.processedAt).toBe("2026-08-26T05:00:00.000Z");
  });

  it("stamps queued inputs once and re-emits only changed events with the same id", async () => {
    const rows = new Map<string, SessionEventView>([
      ["m1", { id: "m1", type: "user.message", content: [], processedAt: null } as SessionEventView],
      ["r1", { id: "r1", type: "user.tool_result", toolUseId: "t", processedAt: "2026-08-26T01:00:00.000Z" } as SessionEventView],
    ]);
    const store = {
      markProcessed: async (input: MarkSessionEventsProcessed) => input.eventIds.flatMap((id) => {
        const row = rows.get(id);
        if (row === undefined) return [];
        if (row.processedAt == null) rows.set(id, { ...row, processedAt: input.processedAt } as SessionEventView);
        return [rows.get(id)!];
      }),
    };
    const emitted: SessionEventView[][] = [];
    const sink = { emit: (events: SessionEventView[]) => { emitted.push(events); } };
    const command = { workspaceId: "w", sessionId: "s", eventIds: ["m1", "r1", "missing"], processedAt: "2026-08-26T06:00:00.000Z" };
    const first = await markSessionEventsProcessed(store, command, sink);
    expect(first.map((event) => [event.id, event.processedAt])).toEqual([["m1", "2026-08-26T06:00:00.000Z"]]);
    const second = await markSessionEventsProcessed(store, { ...command, processedAt: "2026-08-26T07:00:00.000Z" }, sink);
    expect(second).toEqual([]);
    expect(emitted).toEqual([first]);
  });
});
