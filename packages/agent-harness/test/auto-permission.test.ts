import { describe, expect, it, vi } from "vitest";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type { SessionEvent } from "@open-managed-agents/shared";
import type { HarnessContext, HarnessRuntime } from "../src/interface";
import { PiHarness } from "../src/pi-loop";
import { buildTools } from "../src/tools";

function runtime(events: SessionEvent[]): HarnessRuntime {
  return {
    history: {
      getEvents: () => events,
      getMessages: () => [],
      append: (event: SessionEvent) => events.push(event),
    },
    sandbox: {},
    broadcast: (event: SessionEvent) => events.push(event),
    broadcastStreamStart: vi.fn(async () => undefined),
    broadcastChunk: vi.fn(async () => undefined),
    broadcastStreamEnd: vi.fn(async () => undefined),
    broadcastThinkingStart: vi.fn(async () => undefined),
    broadcastThinkingChunk: vi.fn(async () => undefined),
    broadcastThinkingEnd: vi.fn(async () => undefined),
    broadcastToolInputStart: vi.fn(async () => undefined),
    broadcastToolInputChunk: vi.fn(async () => undefined),
    broadcastToolInputEnd: vi.fn(async () => undefined),
    reportUsage: vi.fn(async () => undefined),
    pendingConfirmations: [],
  } as unknown as HarnessRuntime;
}

function agent() {
  return {
    id: "agent-auto-permission",
    model: "test-model",
    system: "Use tools when asked.",
    tools: [{
      type: "agent_toolset_20260401",
      default_config: { enabled: true, permission_policy: { type: "auto" } },
    }],
  } as never;
}

function sandbox() {
  return {
    exec: vi.fn(async () => "exit=0\nallowed\n"),
    readFile: vi.fn(async () => ""),
    writeFile: vi.fn(async () => undefined),
    editFile: vi.fn(async () => undefined),
  };
}

async function runPi(judge: (input: {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  history?: readonly SessionEvent[];
}) => Promise<{ decision: "allow" | "deny" | "ask"; reason?: string }>) {
  const faux = fauxProvider({ tokensPerSecond: 100_000 });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("bash", { command: "echo allowed" }, { id: "call-auto" })]),
    fauxAssistantMessage("done"),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const events: SessionEvent[] = [{ type: "user.message", content: [{ type: "text", text: "run it" }] }];
  const rt = runtime(events);
  const sb = sandbox();
  const tools = await buildTools(agent(), sb as never, {
    permissionJudge: async (input) => judge({
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      input: input.input,
      history: input.history,
    }),
  });
  const ctx = {
    agent: { id: "agent-auto-permission", model: faux.getModel().id },
    userMessage: events[0],
    session_id: "session-auto-permission",
    tools,
    model: {} as HarnessContext["model"],
    pi: { models, model: faux.getModel(), thinkingLevel: "off", speed: "standard" },
    systemPrompt: "Use tools when asked.",
    env: {},
    runtime: rt,
  } as unknown as HarnessContext;
  await new PiHarness().run(ctx);
  return { events, rt, sb, tools };
}

function fakeJudgeModel(captured?: { request?: unknown }) {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "judge-model",
    supportedUrls: {},
    doGenerate: vi.fn(async (request: unknown) => {
      if (captured) captured.request = request;
      return {
        content: [{ type: "text", text: '{"decision":"allow","reason":"safe"}' }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 17, noCache: 17, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 4, text: 4, reasoning: 0 },
        },
        warnings: [],
      };
    }),
  };
}

describe("default harness auto permission", () => {
  it("allows after one judge call and records the evaluated decision", async () => {
    const judge = vi.fn(async (_input: { history?: readonly SessionEvent[] }) => ({ decision: "allow" as const, reason: "read-only command" }));
    const result = await runPi(judge);
    expect(judge).toHaveBeenCalledTimes(1);
    expect(judge.mock.calls[0]?.[0].history).toContainEqual(expect.objectContaining({ type: "user.message" }));
    expect(result.sb.exec).toHaveBeenCalledWith("echo allowed", 120000);
    expect(result.events).toContainEqual(expect.objectContaining({
      type: "agent.tool_use",
      id: "call-auto",
      evaluated_permission: "allow",
    }));
  });

  it("denies as an error tool result and continues the turn", async () => {
    const result = await runPi(async () => ({ decision: "deny" as const, reason: "destructive command" }));
    expect(result.sb.exec).not.toHaveBeenCalled();
    expect(result.events).toContainEqual(expect.objectContaining({
      type: "agent.tool_use",
      id: "call-auto",
      evaluated_permission: "deny",
    }));
    expect(result.events).toContainEqual(expect.objectContaining({
      type: "agent.tool_result",
      tool_use_id: "call-auto",
      is_error: true,
      content: [{ type: "text", text: "Error: Tool execution denied by auto permission policy: destructive command" }],
    }));
    expect(result.events.some(event => event.type === "agent.message")).toBe(true);
  });

  it("parks an ask decision and leaves confirmation replay executable", async () => {
    const result = await runPi(async () => ({ decision: "ask" as const, reason: "needs approval" }));
    expect(result.sb.exec).not.toHaveBeenCalled();
    expect(result.rt.pendingConfirmations).toEqual(["call-auto"]);
    expect(result.events).toContainEqual(expect.objectContaining({
      type: "agent.tool_use",
      id: "call-auto",
      evaluated_permission: "ask",
    }));

    const replay = await buildTools(agent(), result.sb as never, undefined, { enforcePermissions: false });
    await replay.bash.execute({ command: "echo allowed" }, { toolCallId: "call-auto", messages: [] });
    expect(result.sb.exec).toHaveBeenCalledTimes(1);
  });

  it("uses the active model when no auxiliary judge is configured", async () => {
    const config = agent();
    const sb = sandbox();
    const mainModel = fakeJudgeModel();
    const events: SessionEvent[] = [];
    const tools = await buildTools(config, sb as never, {
      mainModel: mainModel as never,
      mainModelInfo: { model_id: "test-model" },
      broadcastEvent: event => events.push(event),
    });
    const result = await tools.bash.execute({ command: "echo allowed" }, { toolCallId: "call-no-aux", messages: [] });
    expect(result).toBe("exit=0\nallowed\n");
    expect(mainModel.doGenerate).toHaveBeenCalledTimes(1);
    expect(sb.exec).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual(expect.objectContaining({
      type: "aux.model_call",
      task: "permission_judge",
      parent_tool_use_id: "call-no-aux",
      model_id: "test-model",
      model_role: "main",
      status: "ok",
    }));
  });

  it("emits active-model judge telemetry through the Pi tool loop", async () => {
    const faux = fauxProvider({ tokensPerSecond: 100_000 });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "echo allowed" }, { id: "call-pi-main" })]),
      fauxAssistantMessage("done"),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const events: SessionEvent[] = [{ type: "user.message", content: [{ type: "text", text: "run it" }] }];
    const rt = runtime(events);
    const sb = sandbox();
    const mainModel = fakeJudgeModel();
    const tools = await buildTools(agent(), sb as never, {
      mainModel: mainModel as never,
      mainModelInfo: { model_id: "test-model" },
    });
    const ctx = {
      agent: { id: "agent-auto-permission", model: faux.getModel().id },
      userMessage: events[0],
      session_id: "session-auto-permission-pi",
      tools,
      model: {} as HarnessContext["model"],
      pi: { models, model: faux.getModel(), thinkingLevel: "off", speed: "standard" },
      systemPrompt: "Use tools when asked.",
      env: {},
      runtime: rt,
    } as unknown as HarnessContext;

    await new PiHarness().run(ctx);

    expect(mainModel.doGenerate).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual(expect.objectContaining({
      type: "aux.model_call",
      task: "permission_judge",
      parent_tool_use_id: "call-pi-main",
      model_id: "test-model",
      model_role: "main",
      status: "ok",
    }));
  });

  it("fails closed to ask when neither reviewer nor active model is available", async () => {
    const config = agent();
    const sb = sandbox();
    const tools = await buildTools(config, sb as never);
    const result = await tools.bash.execute({ command: "echo allowed" }, { toolCallId: "call-no-model", messages: [] });
    expect(result).toMatchObject({ openmaPermissionDecision: "ask" });
    expect(sb.exec).not.toHaveBeenCalled();
  });

  it("uses the auxiliary model once and records judge telemetry", async () => {
    const auxModel = fakeJudgeModel();
    const sb = sandbox();
    const events: SessionEvent[] = [];
    const tools = await buildTools(agent(), sb as never, {
      auxModel: auxModel as never,
      auxModelInfo: { model_id: "judge-model" },
      broadcastEvent: event => events.push(event),
    });
    await tools.bash.execute({ command: "echo allowed" }, { toolCallId: "call-aux", messages: [] });
    expect(auxModel.doGenerate).toHaveBeenCalledTimes(1);
    expect(sb.exec).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual(expect.objectContaining({
      type: "aux.model_call",
      task: "permission_judge",
      parent_tool_use_id: "call-aux",
      model_id: "judge-model",
      model_role: "aux",
      status: "ok",
      tokens: { input: 17, output: 4 },
    }));
  });

  it("sends a bounded semantic transcript plus the current action to the reviewer", async () => {
    const captured: { request?: unknown } = {};
    const mainModel = fakeJudgeModel(captured);
    const sb = sandbox();
    const tools = await buildTools(agent(), sb as never, {
      mainModel: mainModel as never,
      mainModelInfo: { model_id: "test-model" },
      broadcastEvent: () => undefined,
    });
    const history = [
      { type: "user.message", content: [{ type: "text", text: "inspect the repository" }] },
      { type: "agent.thinking", text: "private reasoning must not be copied" },
      { type: "agent.tool_result", tool_use_id: "old-call", content: "read-only evidence" },
      { type: "aux.model_call", model_id: "judge", task: "permission_judge", duration_ms: 1, tokens: { input: 1, output: 1 }, status: "ok" },
    ] as SessionEvent[];
    const permission = (tools.bash as { metadata?: { openmaPermission?: { bindHistory?: (getHistory: () => SessionEvent[]) => void } } }).metadata?.openmaPermission;
    permission?.bindHistory?.(() => history);

    await tools.bash.execute({ command: "echo current" }, { toolCallId: "current-call", messages: [] });

    const request = captured.request as { prompt?: unknown };
    const prompt = JSON.stringify(request.prompt);
    expect(prompt).toContain("inspect the repository");
    expect(prompt).toContain("read-only evidence");
    expect(prompt).toContain("current-call");
    expect(prompt).toContain("echo current");
    expect(prompt).not.toContain("private reasoning must not be copied");
    expect(prompt).not.toContain("permission_judge");
  });
});
