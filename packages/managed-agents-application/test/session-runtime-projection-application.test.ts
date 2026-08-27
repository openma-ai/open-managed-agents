import { describe, expect, it } from "vitest";
import type { Session } from "../src/domain/session";
import { SessionRuntimeProjectionApplicationService } from "../src/index";

const idleSession: Session = {
  id: "session_01",
  agent: {
    id: "agent_01",
    description: null,
    mcpServers: [],
    model: { id: "claude-opus-5" },
    multiagent: null,
    name: "Coding agent",
    skills: [],
    system: null,
    tools: [],
    version: 1,
  },
  archivedAt: null,
  budget: null,
  createdAt: "2026-08-26T00:00:00.000Z",
  environmentId: "env_01",
  metadata: {},
  outcomeEvaluations: [],
  resources: [],
  stats: {},
  status: "idle",
  title: null,
  updatedAt: "2026-08-26T00:00:00.000Z",
  usage: {},
  vaultIds: [],
};

describe("SessionRuntimeProjectionApplicationService", () => {
  it("atomically projects official runtime history and lifecycle state", async () => {
    const writes: object[] = [];
    const service = new SessionRuntimeProjectionApplicationService({
      workspaceId: "workspace_01",
      persistence: {
        findCurrent: async (input: object) => {
          expect(input).toEqual({
            workspaceId: "workspace_01",
            sessionId: "session_01",
          });
          return { session: structuredClone(idleSession), revision: 4 };
        },
        project: async (input: {
          next: Session;
          expectedRevision: number;
        }) => {
          writes.push(structuredClone(input));
          return {
            type: "projected" as const,
            record: {
              session: structuredClone(input.next),
              revision: input.expectedRevision + 1,
            },
          };
        },
      },
    });

    const result = await service.recordSessionRuntimeEvents({
      sessionId: "session_01",
      events: [
        {
          id: "event_status_01",
          type: "session.status_running",
          processedAt: "2026-08-26T01:00:00.000Z",
        },
        {
          id: "event_message_01",
          type: "agent.message",
          content: [{ type: "text", text: "Started" }],
          processedAt: "2026-08-26T01:00:01.000Z",
        },
      ],
    });

    expect(result).toEqual({
      type: "recorded",
      session: {
        ...idleSession,
        status: "running",
        updatedAt: "2026-08-26T01:00:01.000Z",
      },
    });
    expect(writes).toEqual([
      {
        workspaceId: "workspace_01",
        sessionId: "session_01",
        expectedRevision: 4,
        events: [
          {
            id: "event_status_01",
            type: "session.status_running",
            processedAt: "2026-08-26T01:00:00.000Z",
          },
          {
            id: "event_message_01",
            type: "agent.message",
            content: [{ type: "text", text: "Started" }],
            processedAt: "2026-08-26T01:00:01.000Z",
          },
        ],
        next: {
          ...idleSession,
          status: "running",
          updatedAt: "2026-08-26T01:00:01.000Z",
        },
      },
    ]);
  });

  it("does not project events for a missing tenant-scoped session", async () => {
    let projected = false;
    const service = new SessionRuntimeProjectionApplicationService({
      workspaceId: "workspace_01",
      persistence: {
        findCurrent: async () => null,
        project: async () => {
          projected = true;
          throw new Error("unexpected projection");
        },
      },
    });

    await expect(
      service.recordSessionRuntimeEvents({
        sessionId: "session_missing",
        events: [
          {
            id: "event_status_01",
            type: "session.status_running",
            processedAt: "2026-08-26T01:00:00.000Z",
          },
        ],
      }),
    ).resolves.toEqual({ type: "not_found" });
    expect(projected).toBe(false);
  });

  it("advances an existing outcome aggregate from official evaluation spans", async () => {
    const pending: Session = {
      ...idleSession,
      outcomeEvaluations: [{
        type: "outcome_evaluation",
        completedAt: null,
        description: "Ship the migration",
        explanation: null,
        iteration: 0,
        outcomeId: "outc_01",
        result: "pending",
      }],
    };
    const projectedSessions: Session[] = [];
    const service = new SessionRuntimeProjectionApplicationService({
      workspaceId: "workspace_01",
      persistence: {
        findCurrent: async () => ({ session: pending, revision: 8 }),
        project: async (input) => {
          projectedSessions.push(structuredClone(input.next));
          return {
            type: "projected",
            record: { session: input.next, revision: 9 },
          };
        },
      },
    });

    await service.recordSessionRuntimeEvents({
      sessionId: pending.id,
      events: [
        {
          id: "event_eval_start_01",
          type: "span.outcome_evaluation_start",
          iteration: 1,
          outcomeId: "outc_01",
          processedAt: "2026-08-26T06:00:00.000Z",
        },
        {
          id: "event_eval_end_01",
          type: "span.outcome_evaluation_end",
          explanation: "All checks pass",
          iteration: 1,
          outcomeEvaluationStartId: "event_eval_start_01",
          outcomeId: "outc_01",
          processedAt: "2026-08-26T06:01:00.000Z",
          result: "satisfied",
          usage: {
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            inputTokens: 10,
            outputTokens: 2,
          },
        },
      ],
    });

    expect(projectedSessions).toEqual([{
      ...pending,
      outcomeEvaluations: [{
        type: "outcome_evaluation",
        completedAt: "2026-08-26T06:01:00.000Z",
        description: "Ship the migration",
        explanation: "All checks pass",
        iteration: 1,
        outcomeId: "outc_01",
        result: "satisfied",
      }],
      updatedAt: "2026-08-26T06:01:00.000Z",
    }]);
  });
});
