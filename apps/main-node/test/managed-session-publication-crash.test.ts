import { describe, expect, it } from "vitest";
import type { Environment, Session, SessionEventView, SessionRuntimeHistoryEventView } from "@open-managed-agents/managed-agents-application";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";
import { createSessionClockRegistry, type SessionEvent } from "@open-managed-agents/shared";
import { decodeRuntimeProducedSessionEvent } from "@open-managed-agents/managed-agents-adapters-runtime";
import { resourcesFixture } from "../../../packages/openai-agents-compat/test/helpers/resources";
import { encodeResourceMetadata } from "../../../packages/openai-agents-compat/src/resource-metadata";
import { createNodeOpenAIArtifactPublisher } from "../../../packages/control-plane-node/src/openai-artifact-publication";
import { DefaultNodeManagedSessionRunner } from "../../../packages/control-plane-node/src/lib/node-managed-session-runner.js";
import { ApplicationBackedNodeManagedSessionRuntimeEngine, committedExecutionTerminal } from "../../../packages/control-plane-node/src/lib/node-managed-session-runtime.js";

const environment: Environment = {
  id: "native-env", archivedAt: null, config: { type: "self_hosted" }, createdAt: "2026-08-25T00:00:00.000Z",
  description: null, metadata: {}, name: "Node runtime", updatedAt: "2026-08-25T00:00:00.000Z",
};

class ProcessKilled extends Error {}

/** Durable state shared across "processes": the event log, Files and the
 * host-backed /workspace directory. Everything else is rebuilt per process. */
async function durableState() {
  const resources = resourcesFixture();
  const session = {
    id: "session",
    agent: { id: "agent", description: null, mcpServers: [], model: { id: "deepseek-flash" }, multiagent: null, name: "Agent", skills: [], system: null, tools: [], version: 1 },
    archivedAt: null, budget: null, createdAt: new Date(100_000).toISOString(), environmentId: "native-env",
    metadata: encodeResourceMetadata({}, "session", { sealed: await resources.secrets.seal(JSON.stringify({ agent: {}, environment: { type: "openai_hosted" }, environmentId: "native-env" })) }),
    outcomeEvaluations: [], resources: [], stats: {}, status: "running", title: null, updatedAt: new Date(100_000).toISOString(), usage: {}, vaultIds: [],
  } as unknown as Session;
  const input: SessionEventView = { id: "sevt_input", type: "user.message", content: [{ type: "text", text: "write a and b" }], processedAt: "2026-08-26T01:00:00.000Z" } as SessionEventView;
  const rows: SessionRuntimeHistoryEventView[] = [
    { event: input, position: { revision: 1, index: 0 }, executionId: input.id, consumedByExecutionId: input.id },
  ];
  const history = {
    loadSessionRuntimeHistory: async () => ({
      type: "found" as const, revision: rows.length, initialEvents: [],
      events: rows.map(row => row.event), orderedEvents: rows.slice(),
    }),
  };
  const workspace = new Map<string, Uint8Array>();
  return { resources, session, input, rows, history, workspace };
}

type State = Awaited<ReturnType<typeof durableState>>;

/** One Node process: fresh runner, engine and in-memory maps. */
function nodeProcess(state: State, options: { killAfterFirstArtifact: boolean; harnessRuns: { count: number } }) {
  let readBytes = 0;
  const sandbox = {
    exec: async () => Buffer.from([...state.workspace.keys()].sort().map(path => `.${path.slice("/workspace".length)}\0`).join("")).toString("base64"),
    readFile: async () => "",
    writeFile: async () => undefined,
    setEnvVars: async () => undefined,
    readFileBytes: async (path: string) => {
      if (options.killAfterFirstArtifact && ++readBytes === 2) throw new ProcessKilled("kill -9 during publication");
      return state.workspace.get(path)!;
    },
  } as unknown as SandboxExecutor;
  let nextId = 0;
  const runner = new DefaultNodeManagedSessionRunner({
    sessionClocks: createSessionClockRegistry(),
    outcomes: { evaluate: async () => { throw new Error("unexpected outcome evaluation"); } },
    confirmedTools: { execute: async () => { throw new Error("unexpected confirmed tool"); } },
    buildSandbox: async () => sandbox,
    buildModel: async () => ({}),
    buildTools: async () => ({}),
    buildHarness: () => ({
      run: async (context: unknown) => {
        options.harnessRuns.count += 1;
        state.workspace.set("/workspace/outputs/a.txt", new TextEncoder().encode("ARTIFACT_A"));
        state.workspace.set("/workspace/outputs/b.txt", new TextEncoder().encode("ARTIFACT_B"));
        (context as { runtime: { broadcast(event: SessionEvent): void } }).runtime.broadcast({
          type: "agent.message", content: [{ type: "text", text: "DONE" }],
        } as SessionEvent);
      },
    }),
    buildHarnessContext: async (input: unknown) => input,
    afterExecution: createNodeOpenAIArtifactPublisher({
      historyForWorkspace: () => state.history,
      filesForWorkspace: () => state.resources.files,
      secrets: state.resources.secrets,
      isFenceActive: async () => true,
      environmentId: () => "oai_env_session",
    }),
    clock: { now: () => new Date("2026-08-26T02:00:00.000Z") },
    ids: { nextEventId: () => `evt_${options.killAfterFirstArtifact ? "p1" : "p2"}_${++nextId}` },
    runtimeGenerations: { next: () => "runtime_generation" },
  } as unknown as ConstructorParameters<typeof DefaultNodeManagedSessionRunner>[0]);
  const engine = new ApplicationBackedNodeManagedSessionRuntimeEngine({ historyFor: () => state.history as never, runner });
  return async (generation: number) => {
    const scope = { workspaceId: "workspace_a", sessionId: state.session.id };
    const fence = { ...scope, executionId: state.input.id, attemptId: `attempt_${generation}`, ownerId: `worker_${generation}`, generation, expiresAt: "2026-08-26T03:00:00.000Z" };
    // Mirrors the runtime driver: each produced frame commits with the fence's execution id.
    await engine.start({ ...scope, session: state.session, environment, initialEvents: [] }, async (frame) => {
      const event = decodeRuntimeProducedSessionEvent(frame);
      if (event !== null) state.rows.push({ event, position: { revision: state.rows.length + 1, index: 0 }, executionId: fence.executionId });
    });
    await engine.accept({ ...scope, session: state.session, environment, events: [state.input], executionFence: fence } as never);
  };
}

describe("Node OpenAI publication crash recovery", () => {
  it("never re-runs a turn whose terminal committed before a crash during publication; recovery only completes publication", async () => {
    const state = await durableState();
    const harnessRuns = { count: 0 };

    // Process 1: the turn answers, its terminal commits, publication persists
    // a.txt and the process dies before b.txt and before settle.
    await expect(nodeProcess(state, { killAfterFirstArtifact: true, harnessRuns })(1)).rejects.toBeInstanceOf(ProcessKilled);
    expect(state.rows.at(-1)?.event).toMatchObject({ type: "session.status_idle", stopReason: { type: "end_turn" } });
    const before = await state.resources.files.listFiles({ scopeId: state.session.id });
    if (before.type !== "page") throw new Error(before.message);
    expect(before.page.files.map(file => file.origin?.type === "session_output" ? file.origin.path : null)).toEqual(["/workspace/outputs/a.txt"]);

    // Process 2 reclaims the still-running execution (generation 2).
    await nodeProcess(state, { killAfterFirstArtifact: false, harnessRuns })(2);

    expect(harnessRuns.count).toBe(1);
    const answers = state.rows.filter(row => row.event.type === "agent.message");
    expect(answers).toHaveLength(1);
    expect(state.rows.filter(row => row.event.type === "session.status_idle")).toHaveLength(1);
    expect(state.rows.filter(row => row.event.type === "session.status_running")).toHaveLength(1);
    const after = await state.resources.files.listFiles({ scopeId: state.session.id });
    if (after.type !== "page") throw new Error(after.message);
    const published = await Promise.all(after.page.files.map(async file => {
      const download = await state.resources.files.downloadFile({ fileId: file.id });
      if (download.type !== "found") throw new Error("missing artifact content");
      return [file.origin?.type === "session_output" ? file.origin.path : null, new TextDecoder().decode(download.file.content), file.origin?.type === "session_output" ? file.origin.turnId : null];
    }));
    expect(published.sort()).toEqual([
      ["/workspace/outputs/a.txt", "ARTIFACT_A", "turn_session:root:sevt_input"],
      ["/workspace/outputs/b.txt", "ARTIFACT_B", "turn_session:root:sevt_input"],
    ]);
  });

  it("treats only an idle that is the execution's last committed fact as its terminal", () => {
    const row = (event: Record<string, unknown>, executionId?: string, consumedByExecutionId?: string) =>
      ({ event: event as unknown as SessionEventView, position: { revision: 1, index: 0 }, executionId, consumedByExecutionId });
    const idle = { id: "idle", type: "session.status_idle", stopReason: { type: "end_turn" } };
    expect(committedExecutionTerminal(undefined, "X")).toBeNull();
    expect(committedExecutionTerminal([row({ id: "X", type: "user.message" }, "X", "X"), row({ id: "m", type: "agent.message" }, "X")], "X")).toBeNull();
    expect(committedExecutionTerminal([row({ id: "X", type: "user.message" }, "X", "X"), row(idle, "X")], "X")).toMatchObject(idle);
    // Interrupt ended the turn, then the same execution consumed a queued message: not terminal.
    expect(committedExecutionTerminal([row(idle, "X"), row({ id: "Q", type: "user.message" }, "Q", "X")], "X")).toBeNull();
    // Another execution's idle never counts.
    expect(committedExecutionTerminal([row({ id: "X", type: "user.message" }, "X", "X"), row(idle, "Y")], "X")).toBeNull();
  });
});
