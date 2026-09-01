import { describe, expect, it } from "vitest";
import type {
  Environment,
  InitialSessionEvent,
  Session,
  SessionEventView,
  SessionRuntimeHistoryApplicationPort,
} from "@open-managed-agents/managed-agents-application";
import type {
  AcceptNodeManagedSessionEvents,
  ArchiveNodeManagedSessionThread,
  StartNodeManagedSessionRuntime,
  StopNodeManagedSessionRuntime,
} from "../src/lib/node-managed-session-runtime.js";
import * as engineModule from "../src/lib/node-managed-session-runtime.js";

const session: Session = {
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
  status: "running",
  title: null,
  updatedAt: "2026-08-26T00:00:00.000Z",
  usage: {},
  vaultIds: [],
};

const environment: Environment = {
  id: "env_01",
  archivedAt: null,
  config: { type: "self_hosted" },
  createdAt: "2026-08-25T00:00:00.000Z",
  description: null,
  metadata: {},
  name: "Node runtime",
  updatedAt: "2026-08-25T00:00:00.000Z",
};

interface RunnerAcceptInput extends AcceptNodeManagedSessionEvents {
  initialEvents: InitialSessionEvent[];
  historyEvents: SessionEventView[];
  output(frame: unknown): Promise<void>;
}

interface Runner {
  start(input: StartNodeManagedSessionRuntime): Promise<void>;
  stop(input: StopNodeManagedSessionRuntime): Promise<void>;
  accept(input: RunnerAcceptInput): Promise<void>;
  archiveThread(input: ArchiveNodeManagedSessionThread): Promise<void>;
}

interface Engine {
  start(
    input: StartNodeManagedSessionRuntime,
    output: (frame: unknown) => Promise<void>,
  ): Promise<void>;
  accept(input: AcceptNodeManagedSessionEvents): Promise<void>;
}

interface EngineConstructor {
  new (dependencies: {
    historyFor(workspaceId: string): SessionRuntimeHistoryApplicationPort;
    runner: Runner;
  }): Engine;
}

describe("ApplicationBackedNodeManagedSessionRuntimeEngine", () => {
  it("runs an accepted event from complete application history and context", async () => {
    const Engine = (
      engineModule as typeof engineModule & {
        ApplicationBackedNodeManagedSessionRuntimeEngine?: EngineConstructor;
      }
    ).ApplicationBackedNodeManagedSessionRuntimeEngine ?? class {
      async start(): Promise<void> {}
      async accept(): Promise<void> {}
    } as EngineConstructor;
    const initialEvents: InitialSessionEvent[] = [
      {
        type: "user.message",
        content: [{ type: "text", text: "Initial brief" }],
      },
    ];
    const events: SessionEventView[] = [
      {
        id: "event_status_01",
        type: "session.status_running",
        processedAt: "2026-08-26T01:00:00.000Z",
      },
    ];
    const historyLookups: object[] = [];
    const runnerInputs: RunnerAcceptInput[] = [];
    const receivedOutput: unknown[] = [];
    const runner: Runner = {
      start: async () => {},
      stop: async () => {},
      accept: async (input) => {
        runnerInputs.push(input);
        await input.output({
          type: "agent.message_chunk",
          message_id: "event_message_01",
          delta: "Hello",
        });
      },
      archiveThread: async () => {},
    };
    const engine = new Engine({
      historyFor: (workspaceId) => {
        expect(workspaceId).toBe("workspace_01");
        return {
          loadSessionRuntimeHistory: async (query) => {
            historyLookups.push(query);
            return { type: "found", initialEvents, events };
          },
        };
      },
      runner,
    });
    await engine.start(
      {
        workspaceId: "workspace_01",
        sessionId: session.id,
        session,
        environment,
        initialEvents: [],
      },
      async (frame) => { receivedOutput.push(frame); },
    );
    const acceptedEvent: AcceptNodeManagedSessionEvents["events"][number] = {
      id: "event_message_01",
      type: "user.message",
      content: [{ type: "text", text: "Continue" }],
      processedAt: "2026-08-26T02:00:00.000Z",
    };
    await engine.accept({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      events: [acceptedEvent],
    });

    expect(historyLookups).toEqual([{ sessionId: "session_01" }]);
    expect(runnerInputs).toEqual([
      {
        workspaceId: "workspace_01",
        sessionId: "session_01",
        session,
        environment,
        events: [acceptedEvent],
        initialEvents,
        historyEvents: events,
        output: expect.any(Function),
      },
    ]);
    expect(receivedOutput).toEqual([
      {
        type: "agent.message_chunk",
        message_id: "event_message_01",
        delta: "Hello",
      },
    ]);
  });

  it("routes equal session IDs to workspace-scoped output callbacks", async () => {
    const outputA: unknown[] = [];
    const outputB: unknown[] = [];
    const runner: Runner = {
      start: async () => {},
      stop: async () => {},
      accept: async (input) => {
        await input.output({ workspaceId: input.workspaceId });
      },
      archiveThread: async () => {},
    };
    const engine = new engineModule.ApplicationBackedNodeManagedSessionRuntimeEngine({
      historyFor: () => ({
        loadSessionRuntimeHistory: async () => ({
          type: "found",
          initialEvents: [],
          events: [],
        }),
      }),
      runner,
    });
    const start = (workspaceId: string, output: unknown[]) => engine.start(
      { workspaceId, sessionId: session.id, session, environment, initialEvents: [] },
      async (frame) => { output.push(frame); },
    );
    await start("workspace_a", outputA);
    await start("workspace_b", outputB);

    const accept = (workspaceId: string) => engine.accept({
      workspaceId,
      sessionId: session.id,
      session,
      environment,
      events: [{
        id: `event_${workspaceId}`,
        type: "user.message" as const,
        content: [{ type: "text" as const, text: workspaceId }],
        processedAt: "2026-08-26T02:00:00.000Z",
      }],
    });
    await accept("workspace_a");
    await accept("workspace_b");

    expect(outputA).toEqual([{ workspaceId: "workspace_a" }]);
    expect(outputB).toEqual([{ workspaceId: "workspace_b" }]);
  });
});
