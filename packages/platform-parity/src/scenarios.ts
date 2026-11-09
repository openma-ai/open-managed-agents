import {
  finishChunk,
  streamStep,
  textChunks,
  toolCallChunks,
} from "../../../test/fakes/scripted-language-model";
import { ACP_CHILD_EXIT_HARNESS, ACP_TIMEOUT_HARNESS, ACP_REVISION_TIMEOUT_HARNESS } from "./acp-child-exit";
import type { ParityScenario, ScenarioContext } from "./context";
import type { ParityModelStep } from "./models";

/** Deterministic usage so budget / usage reporting is comparable. */
function usage(input: number, output: number) {
  return {
    inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: output, text: output, reasoning: 0 },
  };
}

function say(id: string, text: string, tokens: [number, number] = [11, 7]): ParityModelStep {
  return streamStep([...textChunks(id, [text]), finishChunk("stop", usage(...tokens))]);
}

function call(id: string, toolName: string, input: unknown, tokens: [number, number] = [13, 5]): ParityModelStep {
  return streamStep([
    ...toolCallChunks({ id, toolName, inputDeltas: [JSON.stringify(input)] }),
    finishChunk("tool-calls", usage(...tokens)),
  ]);
}

async function simpleSession(context: ScenarioContext, body: Record<string, unknown> = {}, agentBody: Record<string, unknown> = {}) {
  const agent = await context.agent("parity-agent", agentBody);
  await context.session(agent, body);
  return agent;
}

export const oneTurn: ParityScenario = {
  name: "one-turn",
  covers: "一轮对话: one user.message, one scripted text reply, end_turn",
  async run(context) {
    context.models("parity-agent", [say("parity_text_1", "Hello from the parity model.")]);
    await simpleSession(context);
    await context.message("Say hello.");
    await context.waitIdle(1, "end_turn");
  },
};

export const toolCall: ParityScenario = {
  name: "tool-call",
  covers: "工具调用: built-in bash tool through the platform sandbox double, then a reply",
  async run(context) {
    context.models("parity-agent", [
      call("parity_bash_1", "bash", { command: "echo parity" }),
      say("parity_text_1", "The command ran."),
    ]);
    await simpleSession(context);
    await context.message("Run echo.");
    await context.waitIdle(1, "end_turn");
  },
};

export const memoryReadWrite: ParityScenario = {
  name: "memory-read-write",
  covers: "记忆读写: memory store attached as a session resource, read + write through file tools, store read back through the public API",
  async run(context) {
    const storeName = `parity-notes${context.runSuffix.replace(/[^a-z0-9]/giu, "")}`;
    const store = await context.request("POST", "/v1/memory_stores", { name: storeName, description: "parity" });
    context.record("memory_store_create_status", store.status);
    if (store.status !== 201) throw new Error(`memory store create: ${store.status} ${JSON.stringify(store.body)}`);
    context.name(store.body?.id, "memory_store");
    context.name(storeName, "memory_store_name");
    const seeded = await context.request("POST", `/v1/memory_stores/${store.body?.id}/memories`, {
      path: "/seed.md",
      content: "seeded by the parity scenario",
    });
    context.record("memory_seed_status", seeded.status);
    const root = `/mnt/memory/${storeName}`;
    context.models("parity-agent", [
      call("parity_read_1", "read", { file_path: `${root}/seed.md` }),
      call("parity_write_1", "write", { file_path: `${root}/learned.md`, content: "written by the agent" }),
      say("parity_text_1", "Memory updated."),
    ]);
    await simpleSession(context, {
      resources: [{ type: "memory_store", memory_store_id: store.body?.id, access: "read_write" }],
    });
    await context.message("Read the seed note and write what you learned.");
    await context.waitIdle(1, "end_turn");
    // Agent writes reach the store asynchronously on some platforms; poll the
    // public read path for a bounded time and record what is there.
    let memories: unknown = null;
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const listed = await context.request("GET", `/v1/memory_stores/${store.body?.id}/memories?view=full`);
      const data = (listed.body?.data ?? []) as Array<Record<string, unknown>>;
      memories = data
        .map((memory) => ({ path: memory.path, content: memory.content ?? null, type: memory.type }))
        .sort((a, b) => String(a.path).localeCompare(String(b.path)));
      if (data.some((memory) => memory.path === "/learned.md")) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    context.record("memories", memories);
  },
};

export const sessionOutputs: ParityScenario = {
  name: "session-outputs",
  covers: "输出: agent writes /mnt/session/outputs/report.txt, outputs listed and read through the public API",
  async run(context) {
    context.models("parity-agent", [
      call("parity_write_1", "write", { file_path: "/mnt/session/outputs/report.txt", content: "parity report" }),
      say("parity_text_1", "Report written."),
    ]);
    await simpleSession(context);
    await context.message("Write the report.");
    await context.waitIdle(1, "end_turn");
    const listed = await context.request("GET", context.sessionPath("/outputs"));
    context.record("outputs_list_status", listed.status);
    const files = ((listed.body?.data ?? []) as Array<Record<string, unknown>>)
      .map((output) => ({ ...output }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    context.record("outputs", files);
    const read = await context.request("GET", context.sessionPath("/outputs/report.txt"));
    context.record("output_read", { status: read.status, body: read.body });
  },
};

export const subagentCall: ParityScenario = {
  name: "subagent-call",
  covers: "子 agent: predefined subagent delegated through call_agent_<id>, child reply returned to the parent",
  async run(context) {
    const child = await context.agent("parity-child", { tools: [] });
    const parent = await context.agent("parity-parent", {
      multiagent: {
        type: "multiagent_20261001",
        advisor: { type: "disabled" },
        subagents: { type: "enabled", inline_agents: { type: "disabled" }, predefined_agents: [child.id] },
        workflows: { type: "disabled" },
      },
    });
    const toolName = `call_agent_${child.id.replace(/[^a-zA-Z0-9_]/gu, "_")}`;
    context.name(child.id.replace(/[^a-zA-Z0-9_]/gu, "_"), "agent:parity-child");
    context.models("parity-parent", [
      call("parity_delegate_1", toolName, { message: "Summarise the plan." }),
      say("parity_text_1", "The child answered."),
    ]);
    context.models("parity-child", [say("parity_child_text_1", "Plan summarised by the child.")]);
    await context.session(parent);
    await context.message("Delegate to the child.");
    await context.waitIdle(1, "end_turn");
  },
};

export const outcomeEvaluation: ParityScenario = {
  name: "outcome-evaluation",
  covers: "outcome: user.define_outcome + turn; the platform's evaluator model (not the harness model) decides",
  async run(context) {
    context.models("parity-agent", [say("parity_text_1", "Here is the fibonacci function.")]);
    await simpleSession(context);
    // One batch: the outcome applies to this turn on every platform instead of
    // depending on how fast define_outcome alone runs. Order inside one
    // request is undefined (normalize.ts canonicalBatchOrder).
    await context.send([
      { type: "user.message", content: [{ type: "text", text: "Write fibonacci." }] },
      {
        type: "user.define_outcome",
        description: "A fibonacci function is written",
        rubric: { type: "text", content: "The reply contains a fibonacci function." },
        max_iterations: 1,
      },
    ], "message_and_outcome");
    await context.waitFor("outcome settled", (events) =>
      events.some((event) => event.type === "session.status_idle")
      && (events.some((event) => String(event.type).startsWith("session.outcome_evaluat")
        || String(event.type).startsWith("span.outcome_evaluation_end"))
        || events.some((event) => event.type === "session.error")));
  },
};

export const budgetUsage: ParityScenario = {
  name: "budget-usage",
  covers: "预算: session budget accepted, usage reported on the session and spans after two model calls",
  async run(context) {
    context.models("parity-agent", [
      call("parity_bash_1", "bash", { command: "echo budget" }, [100, 20]),
      say("parity_text_1", "Budget turn done.", [120, 30]),
    ]);
    await simpleSession(context, {
      budget: { type: "limit", max_list_cost: { amount: "5", currency: "USD" } },
    });
    await context.message("Spend a little.");
    await context.waitIdle(1, "end_turn");
  },
};

export const requiresAction: ParityScenario = {
  name: "requires-action",
  covers: "requires_action: custom tool result, then tool confirmation (always_ask bash, allow)",
  async run(context) {
    context.models("parity-agent", [
      call("parity_custom_1", "lookup_ticket", { ticket: "PAR-1" }),
      call("parity_bash_1", "bash", { command: "echo confirmed" }),
      say("parity_text_1", "Ticket handled."),
    ]);
    await simpleSession(context, {}, {
      tools: [
        {
          type: "agent_toolset_20260401",
          configs: [{ name: "bash", enabled: true, permission_policy: { type: "always_ask" } }],
        },
        {
          type: "custom",
          name: "lookup_ticket",
          description: "Look up a ticket",
          input_schema: { type: "object", properties: { ticket: { type: "string" } }, required: ["ticket"] },
        },
      ],
    });
    await context.message("Handle ticket PAR-1.");
    await context.waitIdle(1, "requires_action");
    await context.send([{
      type: "user.custom_tool_result",
      custom_tool_use_id: "parity_custom_1",
      content: [{ type: "text", text: "PAR-1 is open" }],
    }], "custom_tool_result");
    await context.waitIdle(2, "requires_action");
    await context.send([{ type: "user.tool_confirmation", tool_use_id: "parity_bash_1", result: "allow" }], "tool_confirmation");
    await context.waitIdle(1, "end_turn");
  },
};

export const interrupt: ParityScenario = {
  name: "interrupt",
  covers: "中断: user.interrupt while a model call is in flight, then a follow-up turn",
  async run(context) {
    context.models("parity-agent", [
      call("parity_bash_1", "bash", { command: "echo before-interrupt" }),
      { type: "await-abort", timeoutMs: 8_000 },
      say("parity_text_1", "Back after the interrupt."),
    ]);
    await simpleSession(context);
    await context.message("Start a long task.");
    await context.waitFor("tool result before interrupt", (events) =>
      events.some((event) => event.type === "agent.tool_result"));
    await context.send([{ type: "user.interrupt" }], "interrupt");
    await context.waitIdle(1);
    await context.message("Continue.", "follow_up");
    await context.waitFor("follow-up reply", (events) =>
      events.some((event) => event.type === "agent.message"
        && JSON.stringify(event.content ?? "").includes("Back after the interrupt"))
      && events.filter((event) => event.type === "session.status_idle").length >= 2);
  },
};

export const mcpToolSelection: ParityScenario = {
  name: "mcp-tool-selection",
  covers: "MCP lists hide disabled tools and disabled calls never contact the upstream",
  async run(context) {
    const originalFetch = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).hostname !== "parity-mcp.example.test") return originalFetch(input, init);
      const rpc = await request.json() as { id: number; method: string };
      seen.push(rpc.method);
      return Response.json({ jsonrpc: "2.0", id: rpc.id, result: {
        tools: [{ name: "echo" }, { name: "hidden" }], nextCursor: "page-2",
      } });
    };
    try {
      const agent = await context.agent("mcp-selection", {
        mcp_servers: [{ name: "public", type: "url", url: "https://parity-mcp.example.test/mcp" }],
        tools: [{ type: "mcp_toolset", mcp_server_name: "public", default_config: { enabled: false }, configs: [{ name: "echo", enabled: true }] }],
      });
      const sessionId = await context.session(agent);
      const path = "/v1/oma/mcp-proxy/" + sessionId + "/public";
      const list = await context.request("POST", path, { jsonrpc: "2.0", id: 567, method: "tools/list" });
      if (JSON.stringify(list.body?.result?.tools) !== '[{"name":"echo"}]') throw new Error("MCP list was not filtered");
      context.record("filtered_list", list);
      const response = await context.request("POST", path, {
        jsonrpc: "2.0", id: 568, method: "tools/call", params: { name: "hidden", arguments: {} },
      });
      if (response.body?.error?.code !== -32601) throw new Error("disabled MCP call was not refused");
      context.record("disabled_call", response);
      if (seen.join(",") !== "tools/list") throw new Error("disabled call reached upstream");
      context.record("upstream_methods", seen);
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
};

export const contextBuildFailure: ParityScenario = {
  name: "context-build-failure",
  covers: "构建上下文失败: an ACP sandbox turn whose model channel cannot be issued (no PUBLIC_BASE_URL) settles session.error exhausted, then idle",
  async run(context) {
    await simpleSession(context, {}, {
      _oma: { harness: "acp-sandbox", acp: { agent: { command: "parity-acp-agent" } } },
    });
    await context.message("Start.");
    await context.waitIdle(1);
  },
};

export const acpChildExit: ParityScenario = {
  name: "acp-child-exit",
  covers: "ACP 子进程中途退出: the in-sandbox agent process exits mid-prompt; the turn ends with session.error and the Session goes idle, not running",
  async run(context) {
    await simpleSession(context, {}, { _oma: { harness: ACP_CHILD_EXIT_HARNESS } });
    await context.message("Start.");
    await context.waitIdle(1);
  },
};

export const acpTimeout: ParityScenario = {
  name: "acp-timeout",
  covers: "ACP 每轮超时: session.error and retries_exhausted, never a silent end_turn",
  async run(context) {
    await simpleSession(context, {}, { _oma: { harness: ACP_TIMEOUT_HARNESS } });
    await context.message("Start.");
    await context.waitIdle(1, "retries_exhausted");
  },
};

export const acpRevisionTimeout: ParityScenario = {
  name: "acp-revision-timeout",
  covers: "共享 outcome revision 的真实 ACP 超时必须 error exhausted → idle retries_exhausted",
  async run(context) {
    await simpleSession(context, {}, { _oma: { harness: ACP_REVISION_TIMEOUT_HARNESS } });
    await context.send([
      { type: "user.message", content: [{ type: "text", text: "Start." }] },
      { type: "user.define_outcome", description: "parity-revision-timeout", rubric: { type: "text", content: "parity-revision-timeout" }, max_iterations: 3 },
    ], "message_and_outcome");
    await context.waitIdle(1, "retries_exhausted");
  },
};

/** The scenario set every platform runner executes (order = report order). */
export const PARITY_SCENARIOS: ParityScenario[] = [
  mcpToolSelection,
  oneTurn,
  toolCall,
  memoryReadWrite,
  sessionOutputs,
  subagentCall,
  outcomeEvaluation,
  budgetUsage,
  requiresAction,
  interrupt,
  contextBuildFailure,
  acpChildExit,
  acpTimeout,
  acpRevisionTimeout,
];
