import { beforeEach, describe, expect, it, vi } from "vitest";
import { AcpSandboxHarness } from "../src/acp-sandbox-loop";
import type { HarnessContext } from "../src/interface";
import { captureAcpSandboxAgentState, hasRequiredAcpSandboxAgentState } from "../../acp-runtime/src/sandbox-agent.ts";

// Lifetime of the in-sandbox ACP child (design §0.6 "harness 在沙箱内（ACP）的生命周期").

const started: Array<Record<string, unknown>> = [];
const disposed: string[] = [];
const prompts: string[] = [];
let alive = true;
let failPrompt = false;
let gonePrompt = false;
let terminalError = false;
let resumeSame = false;
let duringPrompt: (() => Promise<void> | void) | undefined;

vi.mock("../../acp-runtime/src/placement.ts", () => ({
  createAcpRuntime: () => ({
    async start(options: Record<string, unknown>) {
      started.push(options);
      const id = resumeSame && options.resumeAcpSessionId ? String(options.resumeAcpSessionId) : `acp_${started.length}`;
      return {
        acpSessionId: id,
        isAlive: () => alive,
        async *prompt(text: string) { prompts.push(text); await duringPrompt?.(); if (gonePrompt) { const {SandboxGoneError}=await import("@open-managed-agents/sandbox"); throw new SandboxGoneError("confirmed gone"); } if (failPrompt) throw new Error("first turn failed"); yield { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } }; if (terminalError) yield {type:"promptError",error:"provider disconnected"}; },
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
    hasRequiredAcpSandboxAgentState: vi.fn(async () => true),
    releaseAcpSandboxAgentState: async () => undefined,
  };
});

function sandbox(lease: boolean) {
  const files = new Map<string, string>();
  const calls: string[] = [];
  return {
    calls, files,
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
  it.each(["terminal", "throw"])("stops before translating post-refusal output (%s), without a success checkpoint", async failure => {
    const { createSessionBudgetGate, memoryListCostPicoStore, modelEgress } = await import("../src/budget");
    const s = sandbox(false), ctx = context(s.port);
    ctx.budget = createSessionBudgetGate({ amount: "1", currency: "USD" }, { version: 1, currency: "USD", input_per_mtok: "1000000", output_per_mtok: "1000000" }, memoryListCostPicoStore());
    const chunks: string[] = [];
    ctx.runtime.broadcastChunk = async (_id, text) => { chunks.push(text); };
    duringPrompt = async () => {
      const meter = modelEgress(ctx.budget)!;
      expect(meter.begin()).toBe(true);
      meter.complete({ input_tokens: 1 });
      expect(meter.begin()).toBe(false);
      const callbacks = started.at(-1)!.clientCallbacks as { requestPermission: (request: unknown) => Promise<unknown> };
      await expect(callbacks.requestPermission({ options: [{ optionId: "allow", kind: "allow_once" }] })).resolves.toEqual({ outcome: { outcome: "cancelled" } });
      if (failure === "throw") throw new Error("gateway request refused");
      terminalError = true;
    };
    await new AcpSandboxHarness().run(ctx);
    expect(ctx.budget!.reached).toBe(true);
    expect(chunks).toEqual([]);
    expect(ctx.runtime.history.getEvents().filter(e => e.type === "session.error" || e.type === "agent.message")).toEqual([]);
    expect(s.files.size).toBe(0);
    expect(disposed).toEqual(["acp_1"]);
  });
  it("preserves canonical output from before a later request refusal", async () => {
    const { createSessionBudgetGate, memoryListCostPicoStore, modelEgress } = await import("../src/budget");
    const s = sandbox(false), ctx = context(s.port);
    ctx.budget = createSessionBudgetGate({ amount: "1", currency: "USD" }, { version: 1, currency: "USD", input_per_mtok: "1000000", output_per_mtok: "1000000" }, memoryListCostPicoStore());
    ctx.runtime.broadcastChunk = async () => { modelEgress(ctx.budget)!.complete({ input_tokens: 1 }); expect(modelEgress(ctx.budget)!.begin()).toBe(false); };
    terminalError = true;
    await new AcpSandboxHarness().run(ctx);
    expect(ctx.runtime.history.getEvents()).toContainEqual(expect.objectContaining({type:"agent.message",content:[{type:"text",text:"ok"}]}));
    expect(ctx.runtime.history.getEvents().filter(e => e.type === "session.error")).toEqual([]);
    expect(s.files.size).toBe(0);
  });
  it("preserves the successful final reply when completed usage reaches the cap without a refusal", async () => {
    const { createSessionBudgetGate, memoryListCostPicoStore, modelEgress } = await import("../src/budget");
    const s = sandbox(false), ctx = context(s.port);
    ctx.budget = createSessionBudgetGate({ amount: "1", currency: "USD" }, { version: 1, currency: "USD", input_per_mtok: "1000000", output_per_mtok: "1000000" }, memoryListCostPicoStore());
    duringPrompt = () => { modelEgress(ctx.budget)!.complete({ input_tokens: 1 }); };
    await new AcpSandboxHarness().run(ctx);
    expect(ctx.runtime.history.getEvents()).toContainEqual(expect.objectContaining({type:"agent.message",content:[{type:"text",text:"ok"}]}));
    expect(ctx.runtime.history.getEvents().filter(e => e.type === "session.error")).toEqual([]);
    expect(s.files.size).toBe(1);
  });
  it("does not classify an arbitrary provider error as budget refusal after charging reaches the cap", async () => {
    const { createSessionBudgetGate, memoryListCostPicoStore, modelEgress } = await import("../src/budget");
    const s = sandbox(false), ctx = context(s.port);
    ctx.budget = createSessionBudgetGate({ amount: "1", currency: "USD" }, { version: 1, currency: "USD", input_per_mtok: "1000000", output_per_mtok: "1000000" }, memoryListCostPicoStore());
    duringPrompt = () => { modelEgress(ctx.budget)!.complete({ input_tokens: 1 }); terminalError = true; };
    await new AcpSandboxHarness().run(ctx);
    expect(ctx.runtime.history.getEvents()).toContainEqual(expect.objectContaining({type:"session.error",error:"provider disconnected"}));
  });
  it("returns through the existing budget terminal path before install, child launch or model span at the cap", async () => {
    const { createSessionBudgetGate, memoryListCostPicoStore } = await import("../src/budget");
    const s = sandbox(false), ctx = context(s.port);
    ctx.budget = createSessionBudgetGate({ amount: "0", currency: "USD" }, { version: 1, currency: "USD", input_per_mtok: "1", output_per_mtok: "1" }, memoryListCostPicoStore());
    await new AcpSandboxHarness().run(ctx);
    expect(ctx.budget!.reached).toBe(true);
    expect(started).toHaveLength(0); expect(prompts).toHaveLength(0);
    expect(s.files.size).toBe(0);
    expect(ctx.runtime.history.getEvents()).toEqual([]);
  });
  it("does not start a native agent while an unknown retry waits for authorization", async () => {
    const s = sandbox(false), ctx = context(s.port);
    ctx.runtime.broadcast({id:"effect",type:"agent.tool_use",name:"bash",input:{command:"effect"}});
    ctx.runtime.broadcast({type:"session.warning",source:"tool_outcome_unknown",message:"may have committed",details:{outcome:"dispatched_unknown",tool_use_id:"effect",retry_request_id:"retry:effect"}});
    ctx.runtime.broadcast({id:"retry:effect",type:"agent.tool_use",name:"bash",input:{command:"effect"},evaluated_permission:"ask"});
    await new AcpSandboxHarness().run(ctx);
    expect(started).toHaveLength(0);
    expect(prompts).toHaveLength(0);
    expect(ctx.runtime.pendingConfirmations).toEqual(["retry:effect"]);
  });
  it.each(["missing", "corrupt", "unreadable"])("rebuilds recorded context after a %s checkpoint, never silently blank", async (failure) => {
    const s = sandbox(false), ctx = context(s.port);
    ctx.runtime.broadcast({ type: "user.message", content: [{type:"text",text:"Remember passphrase amber-otter"}] });
    await new AcpSandboxHarness().run(ctx);
    expect(ctx.runtime.history.getEvents()).toContainEqual(expect.objectContaining({source:"oma.acp_context",details:expect.objectContaining({state:"native",acp_session_id:"acp_1",checkpoint_fingerprint:expect.any(String)})}));
    for(const key of s.files.keys()) failure === "corrupt" ? s.files.set(key,"{broken") : s.files.delete(key);
    if(failure === "unreadable") s.port.readFile = async () => {throw new Error("permission denied");};
    const recovered = context(s.port);
    recovered.acpRecoveryHistory = ctx.runtime.history.getEvents();
    await new AcpSandboxHarness().run(recovered);
    expect(prompts.at(-1)).toContain("Remember passphrase amber-otter");
    expect(recovered.runtime.history.getEvents()).toContainEqual(expect.objectContaining({type:"session.warning",source:"oma.acp_context",details:expect.objectContaining({state:"rebuilt",from:"canonical_history"})}));
  });
  it("rebuilds canonical context when native-state probing is unreadable", async () => {
    const s = sandbox(false), ctx = context(s.port, {agent: {command: "pi-acp", id: "pi-acp"}});
    ctx.runtime.broadcast({ type: "user.message", content: [{type:"text",text:"Remember amber-otter"}] });
    await new AcpSandboxHarness().run(ctx);
    vi.mocked(hasRequiredAcpSandboxAgentState).mockRejectedValueOnce(new Error("native state unreadable"));
    const recovered = context(s.port, {agent: {command: "pi-acp", id: "pi-acp"}});
    recovered.acpRecoveryHistory = ctx.runtime.history.getEvents();
    await expect(new AcpSandboxHarness().run(recovered)).resolves.toBeUndefined();
    expect(prompts.at(-1)).toContain("Remember amber-otter");
    expect(recovered.runtime.history.getEvents()).toContainEqual(expect.objectContaining({source:"oma.acp_context", details: expect.objectContaining({state:"rebuilt", reason:"native-state-missing"})}));
  });
  it("does not publish a replacement checkpoint when canonical rebuild fails", async () => {
    const s = sandbox(false), ctx = context(s.port);
    await new AcpSandboxHarness().run(ctx);
    for (const key of s.files.keys()) s.files.set(key, "{broken");
    const recovered = context(s.port);
    recovered.acpRecoveryHistory = ctx.runtime.history.getEvents().filter(event => event.type === "session.warning");
    await new AcpSandboxHarness().run(recovered);
    expect([...s.files.values()]).toEqual(["{broken"]);
    expect(recovered.runtime.history.getEvents()).not.toContainEqual(expect.objectContaining({source: "oma.acp_context", details: expect.objectContaining({state: "native"})}));
    expect(recovered.runtime.history.getEvents()).toContainEqual(expect.objectContaining({type: "session.error", error: expect.stringContaining("no usable conversation")}));
  });
  it("retains started identity after a failed first prompt without publishing a success checkpoint", async () => {
    const s = sandbox(false), ctx = context(s.port);
    ctx.runtime.broadcast({type:"user.message",content:[{type:"text",text:"original canonical request"}]});
    failPrompt = true;
    await new AcpSandboxHarness().run(ctx);
    expect(s.files.size).toBe(0);
    expect(ctx.runtime.history.getEvents()).toContainEqual(expect.objectContaining({type:"span.model_request_end",is_error:true}));
    expect(ctx.runtime.history.getEvents()).toContainEqual(expect.objectContaining({source:"oma.acp_context", details:expect.objectContaining({state:"started",acp_session_id:"acp_1"})}));
    failPrompt = false;
    const recovered = context(s.port);
    recovered.acpRecoveryHistory = ctx.runtime.history.getEvents();
    await new AcpSandboxHarness().run(recovered);
    expect(prompts.at(-1)).toContain("original canonical request");
    expect(recovered.runtime.history.getEvents()).toContainEqual(expect.objectContaining({source:"oma.acp_context",details:expect.objectContaining({state:"rebuilt"})}));
  });
  it("does not checkpoint partial output followed by a terminal promptError", async () => {
    const s = sandbox(false), ctx = context(s.port);
    terminalError = true;
    await new AcpSandboxHarness().run(ctx);
    expect(s.files.size).toBe(0);
    expect(ctx.runtime.history.getEvents()).not.toContainEqual(expect.objectContaining({source:"oma.acp_context",details:expect.objectContaining({state:"native"})}));
    expect(ctx.runtime.history.getEvents()).toContainEqual(expect.objectContaining({type:"session.error",error:expect.stringContaining("provider disconnected")}));
    expect(ctx.runtime.history.getEvents()).toContainEqual(expect.objectContaining({type:"span.model_request_end",is_error:true}));
  });
  it.each(["missing", "corrupt", "unreadable"])("tries durable native identity before rebuild when checkpoint is %s", async failure => {
    const s = sandbox(false), ctx = context(s.port);
    await new AcpSandboxHarness().run(ctx);
    for (const key of s.files.keys()) failure === "corrupt" ? s.files.set(key,"{broken") : s.files.delete(key);
    if (failure === "unreadable") s.port.readFile = async () => {throw new Error("denied");};
    const recovered = context(s.port);
    recovered.acpRecoveryHistory = ctx.runtime.history.getEvents();
    resumeSame = true;
    await new AcpSandboxHarness().run(recovered);
    expect(started.at(-1)).toHaveProperty("resumeAcpSessionId", "acp_1");
    expect(recovered.runtime.history.getEvents()).not.toContainEqual(expect.objectContaining({source:"oma.acp_context",details:expect.objectContaining({state:"rebuilt"})}));
  });
  it.each(["configuration", "id", "fingerprint"])("does not trust a checkpoint with a %s mismatch", async mismatch => {
    const s = sandbox(false), ctx = context(s.port);
    ctx.runtime.broadcast({type:"user.message",content:[{type:"text",text:"valid consumed history"}]});
    await new AcpSandboxHarness().run(ctx);
    for (const [key, raw] of s.files) {
      const checkpoint = JSON.parse(raw);
      if (mismatch === "configuration") checkpoint.configurationSha256 = "other";
      else if (mismatch === "id") checkpoint.acpSessionId = "other";
      else checkpoint.extra = "modified";
      s.files.set(key, JSON.stringify(checkpoint));
    }
    const recovered = context(s.port);
    recovered.acpRecoveryHistory = ctx.runtime.history.getEvents();
    await new AcpSandboxHarness().run(recovered);
    expect(started.at(-1)).not.toHaveProperty("resumeAcpSessionId");
    expect(prompts.at(-1)).toContain("valid consumed history");
  });
  it("does not reuse a missing checkpoint identity after configuration changes", async () => {
    const s = sandbox(false), ctx = context(s.port);
    ctx.runtime.broadcast({type:"user.message",content:[{type:"text",text:"valid consumed history"}]});
    await new AcpSandboxHarness().run(ctx);
    s.files.clear();
    const recovered = context(s.port, {agent:{command:"different-acp"}});
    recovered.acpRecoveryHistory = ctx.runtime.history.getEvents();
    await new AcpSandboxHarness().run(recovered);
    expect(started.at(-1)).not.toHaveProperty("resumeAcpSessionId");
    expect(prompts.at(-1)).toContain("valid consumed history");
  });
  beforeEach(() => { prompts.length = 0; duringPrompt = undefined; gonePrompt=false; resumeSame = false; terminalError = false; failPrompt = false; started.length = 0; disposed.length = 0; alive = true; vi.mocked(captureAcpSandboxAgentState).mockClear(); });

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

  it("reports pre-call ACP failure without transferring sandbox ownership to Session", async () => {
    const s=sandbox(false), ctx=context(s.port), harness=new AcpSandboxHarness();
    gonePrompt=true;
    await expect(harness.run(ctx)).resolves.toBeUndefined();
    expect(s.files.size).toBe(0);
    expect(ctx.runtime.history.getEvents().filter(e=>e.type==="session.error")).toHaveLength(1);
    expect(ctx.runtime.history.getEvents().filter(e=>e.type==="agent.tool_result")).toEqual([]);
    await harness.dispose("shutdown");
  });

  it("leaves keep-alive to the core: no lease renewal from the harness", async () => {
    const s = sandbox(true);
    await new AcpSandboxHarness().run(context(s.port));
    expect(s.calls).not.toContain("renewLease");
  });
});
