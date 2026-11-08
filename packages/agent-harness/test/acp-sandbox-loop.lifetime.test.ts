import { beforeEach, describe, expect, it, vi } from "vitest";
import { AcpSandboxHarness } from "../src/acp-sandbox-loop";
import type { HarnessContext } from "../src/interface";
import { captureAcpSandboxAgentState } from "../../acp-runtime/src/sandbox-agent.ts";

// Lifetime of the in-sandbox ACP child (design §0.6 "harness 在沙箱内（ACP）的生命周期").

const started: Array<Record<string, unknown>> = [];
const disposed: string[] = [];
let alive = true;

vi.mock("../../acp-runtime/src/placement.ts", () => ({
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

const wired: Array<{ model: { wireModel: string } }> = [];
vi.mock("../../harness-inference-adapters/src/index.ts", () => ({
  wireHostedInferenceForAcpLaunch: (input: { model: { wireModel: string }; env: Record<string, string> }) => {
    wired.push(input);
    return { env: input.env, files: [] };
  },
}));

vi.mock("../../acp-runtime/src/sandbox-agent.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../acp-runtime/src/sandbox-agent.ts")>();
  return {
    ...actual,
    installAcpSandboxAgent: async (_sandbox: unknown, preparation: unknown) => preparation,
    materializeAcpSandboxAgentState: async () => undefined,
    materializeHostedInferenceConfigFiles: async () => undefined,
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
  beforeEach(() => { started.length = 0; disposed.length = 0; alive = true; vi.mocked(captureAcpSandboxAgentState).mockClear(); });

  it("ignores idle_timeout_ms: it belongs to acp-proxy", async () => {
    const s = sandbox(false);
    await new AcpSandboxHarness().run(context(s.port, { idle_timeout_ms: 1234 }));
    expect(started).toHaveLength(1);
    expect(started[0]).not.toHaveProperty("idleTimeoutMs");
  });

  it("closes the child when the execution ends, saves native state after, and resumes next time", async () => {
    const s = sandbox(false);
    const harness = new AcpSandboxHarness();
    await harness.run(context(s.port));
    expect(disposed).toEqual(["acp_1"]);
    expect(vi.mocked(captureAcpSandboxAgentState)).toHaveBeenCalledTimes(1);
    await harness.run(context(s.port));
    expect(started).toHaveLength(2);
    expect(started[1]!.resumeAcpSessionId).toBe("acp_1");
    expect(disposed).toEqual(["acp_1", "acp_2"]);
    await harness.dispose("shutdown");
    expect(disposed).toEqual(["acp_1", "acp_2"]);
  });

  it("launches with the hosted model's upstream wireModel, not the card handle", async () => {
    wired.length = 0;
    const s = sandbox(false);
    const ctx = context(s.port);
    (ctx as { env: unknown }).env = {
      hostedInference: {
        gatewayBaseUrl: "https://oma.example", sessionsToken: "sk-ant-req-v1.x",
        model: { providerId: "anthropic", baseUrl: null, wireModel: "claude-sonnet-5-5" },
      },
    };
    await new AcpSandboxHarness().run(ctx);
    expect(wired.map((input) => input.model.wireModel)).toEqual(["claude-sonnet-5-5"]);
  });

  it("leaves keep-alive to the core: no lease renewal from the harness", async () => {
    const s = sandbox(true);
    await new AcpSandboxHarness().run(context(s.port));
    expect(s.calls).not.toContain("renewLease");
  });
});
