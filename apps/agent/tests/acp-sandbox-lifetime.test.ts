import { beforeEach, describe, expect, it, vi } from "vitest";
import { AcpSandboxHarness } from "../src/harness/acp-sandbox-loop";
import type { HarnessContext } from "../src/harness/interface";

// Lifetime of the in-sandbox ACP child (design §0.6 "harness 在沙箱内（ACP）的生命周期").

const started: Array<Record<string, unknown>> = [];
const disposed: string[] = [];
let alive = true;

vi.mock("../../../packages/acp-runtime/src/placement.ts", () => ({
  createAcpRuntime: () => ({
    async start(options: Record<string, unknown>) {
      started.push(options);
      const id = `acp_${started.length}`;
      return {
        acpSessionId: id,
        isAlive: () => alive,
        async *prompt() { yield { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } }; },
        async dispose() { disposed.push(id); },
      };
    },
  }),
}));

vi.mock("../../../packages/acp-runtime/src/sandbox-agent.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../packages/acp-runtime/src/sandbox-agent.ts")>();
  return {
    ...actual,
    installAcpSandboxAgent: async (_sandbox: unknown, preparation: unknown) => preparation,
    materializeAcpSandboxAgentState: async () => undefined,
    captureAcpSandboxAgentState: vi.fn(async () => undefined),
    restoreAcpSandboxAgentState: async () => undefined,
    hasRequiredAcpSandboxAgentState: async () => true,
    releaseAcpSandboxAgentState: async () => undefined,
  };
});

function sandbox(lease: boolean) {
  const files = new Map<string, string>();
  const calls: string[] = [];
  return {
    calls,
    port: {
      exec: async () => "exit=0\n",
      readFile: async (path: string) => { const v = files.get(path); if (v === undefined) throw new Error("missing"); return v; },
      writeFile: async (path: string, content: string) => { files.set(path, content); return "ok"; },
      spawnDuplexProcess: async () => { throw new Error("unused"); },
      resolveWorkspaceRoot: async () => "/workspace",
      runtimeHandle: () => ({ provider: "test", runtimeId: "rt" }),
      runtimeCapabilities: () => ({ lease, suspend: false, checkpoint: false }),
      status: async () => "running",
      renewLease: async () => { calls.push("renewLease"); },
      suspend: async () => { throw new Error("unused"); },
      resume: async () => { throw new Error("unused"); },
      checkpoint: async () => { throw new Error("unused"); },
    },
  };
}

function context(port: unknown, acp: Record<string, unknown> = {}): HarnessContext {
  const events: unknown[] = [];
  return {
    agent: { id: "agent", version: 1, model: "m", harness: "acp-sandbox", acp: { agent: { command: "fake-acp" }, ...acp } },
    userMessage: { type: "user.message", content: [{ type: "text", text: "hello" }] },
    session_id: "sess_acp",
    systemPrompt: "",
    env: {},
    tools: {},
    runtime: {
      sandbox: port,
      history: { getEvents: () => events, append: () => undefined },
      broadcast: (event: unknown) => { events.push(event); },
      broadcastStreamStart: async () => undefined,
      broadcastChunk: async () => undefined,
      broadcastStreamEnd: async () => undefined,
      broadcastThinkingStart: async () => undefined,
      broadcastThinkingChunk: async () => undefined,
      broadcastThinkingEnd: async () => undefined,
      broadcastToolInputStart: async () => undefined,
      broadcastToolInputChunk: async () => undefined,
      broadcastToolInputEnd: async () => undefined,
      abortSignal: new AbortController().signal,
    },
  } as unknown as HarnessContext;
}

describe("acp-sandbox child lifetime", () => {
  beforeEach(() => { started.length = 0; disposed.length = 0; alive = true; });

  it("passes idle_timeout_ms to the in-sandbox ACP runtime", async () => {
    const s = sandbox(false);
    await new AcpSandboxHarness().run(context(s.port, { idle_timeout_ms: 1234 }));
    expect(started).toHaveLength(1);
    expect(started[0]!.idleTimeoutMs).toBe(1234);
  });

  it("closes nothing at turn end: the host decides when the child exits", async () => {
    const s = sandbox(false);
    const harness = new AcpSandboxHarness();
    await harness.run(context(s.port));
    expect(disposed).toEqual([]);
    await harness.dispose("shutdown");
    expect(disposed).toEqual(["acp_1"]);
  });
});
