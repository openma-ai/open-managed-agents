// @ts-nocheck
import { describe, it, expect, beforeEach } from "vitest";
import { AcpTranslator } from "../src/acp-translate";
import type { HarnessRuntime } from "../src/interface";

/**
 * AcpTranslator dedup behaviour for tool_call frames.
 *
 * Real failure mode this guards against: Claude Code's ACP child sends a
 * `tool_call` skeleton (title=<kind>, rawInput={}) immediately followed by
 * one or more richer frames (title=<command-string>, rawInput={...}) for
 * the same toolCallId. Eager emission produced N agent.tool_use events per
 * actual invocation, the first being the useless empty skeleton. The fix
 * defers emission until terminal status (or a flush trigger) and merges
 * the richest fields seen across all frames for that id.
 */

interface Broadcast {
  type: string;
  [k: string]: unknown;
}

/** Capture every event the translator broadcasts; ignore stream-lifecycle
 *  noise we don't care about for these tests. */
function makeFakeRuntime(): {
  runtime: HarnessRuntime;
  events: Broadcast[];
  reportedUsage: Array<{ input: number; output: number }>;
} {
  const events: Broadcast[] = [];
  const reportedUsage: Array<{ input: number; output: number }> = [];
  const runtime = {
    history: { append() {}, getMessages() { return []; }, getEvents() { return []; } },
    sandbox: {} as never,
    broadcast: (e: Broadcast) => { events.push(e); },
    broadcastStreamStart: async () => { /* noop */ },
    broadcastChunk: async () => { /* noop */ },
    broadcastStreamEnd: async () => { /* noop */ },
    broadcastThinkingStart: async () => { /* noop */ },
    broadcastThinkingChunk: async () => { /* noop */ },
    broadcastThinkingEnd: async () => { /* noop */ },
    broadcastToolInputStart: async () => { /* noop */ },
    broadcastToolInputChunk: async () => { /* noop */ },
    broadcastToolInputEnd: async () => { /* noop */ },
    reportUsage: async (input: number, output: number) => {
      reportedUsage.push({ input, output });
    },
  } as unknown as HarnessRuntime;
  return { runtime, events, reportedUsage };
}

function ev(update: Record<string, unknown>) {
  return { type: "session.event", event: { sessionId: "s1", update } };
}

describe("AcpTranslator tool_call dedup", () => {
  let runtime: HarnessRuntime;
  let events: Broadcast[];
  let translator: AcpTranslator;

  beforeEach(() => {
    const r = makeFakeRuntime();
    runtime = r.runtime;
    events = r.events;
    translator = new AcpTranslator(runtime);
  });

  it("collapses two tool_call frames for the same id into one tool_use, keeping richer data", async () => {
    // Skeleton — empty input, generic title.
    await translator.consume(ev({
      sessionUpdate: "tool_call",
      toolCallId: "tc-1",
      title: "Terminal",
      rawInput: {},
    }));
    // Filled — same id, real command + args. We expect this data to win.
    await translator.consume(ev({
      sessionUpdate: "tool_call",
      toolCallId: "tc-1",
      title: "`bash -c 'echo hi'`",
      rawInput: { command: "echo hi", description: "say hi" },
    }));
    // Terminal update — flushes the pending tool_use, then emits result.
    await translator.consume(ev({
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-1",
      status: "completed",
      rawOutput: "hi\n",
    }));

    const toolUses = events.filter((e) => e.type === "agent.tool_use");
    const toolResults = events.filter((e) => e.type === "agent.tool_result");
    expect(toolUses).toHaveLength(1);
    expect(toolResults).toHaveLength(1);
    // Filled-frame data wins over skeleton.
    expect(toolUses[0]).toMatchObject({
      type: "agent.tool_use",
      id: "tc-1",
      name: "`bash -c 'echo hi'`",
      input: { command: "echo hi", description: "say hi" },
    });
    expect(toolResults[0]).toMatchObject({
      type: "agent.tool_result",
      tool_use_id: "tc-1",
      content: "hi\n",
    });
    // Order in events log: tool_use BEFORE tool_result.
    const toolUseIdx = events.findIndex((e) => e.type === "agent.tool_use");
    const toolResultIdx = events.findIndex((e) => e.type === "agent.tool_result");
    expect(toolUseIdx).toBeLessThan(toolResultIdx);
  });

  it("merges non-terminal tool_call_update into pending without emitting", async () => {
    await translator.consume(ev({
      sessionUpdate: "tool_call",
      toolCallId: "tc-2",
      title: "Read",
      rawInput: {},
    }));
    // Non-terminal update — should patch pending state, NOT emit.
    await translator.consume(ev({
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-2",
      status: "in_progress",
      rawInput: { path: "/tmp/x.txt" },
    }));
    expect(events.filter((e) => e.type === "agent.tool_use")).toHaveLength(0);

    // Terminal — flushes with the merged input from the in-progress update.
    await translator.consume(ev({
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-2",
      status: "completed",
      rawOutput: "file contents",
    }));
    const toolUses = events.filter((e) => e.type === "agent.tool_use");
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0].input).toEqual({ path: "/tmp/x.txt" });
  });

  it("drops a duplicate tool_call after the id has already been flushed", async () => {
    await translator.consume(ev({
      sessionUpdate: "tool_call",
      toolCallId: "tc-3",
      title: "Bash",
      rawInput: { command: "ls" },
    }));
    await translator.consume(ev({
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-3",
      status: "completed",
      rawOutput: "a b c",
    }));
    // Stray late tool_call for an already-finished id (some ACP children
    // re-announce). Must not produce a phantom second tool_use.
    await translator.consume(ev({
      sessionUpdate: "tool_call",
      toolCallId: "tc-3",
      title: "Bash (late echo)",
      rawInput: { command: "ls", phantom: true },
    }));
    expect(events.filter((e) => e.type === "agent.tool_use")).toHaveLength(1);
  });

  it("flushes pending tool_use before an interleaved agent_message_chunk so order is preserved", async () => {
    // Skeleton arrives, then agent starts narrating before the terminal update.
    // We must flush the pending tool_use FIRST so the events log reads
    // tool_use → message, not message → tool_use.
    await translator.consume(ev({
      sessionUpdate: "tool_call",
      toolCallId: "tc-4",
      title: "Search",
      rawInput: { query: "foo" },
    }));
    await translator.consume(ev({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Looking that up..." },
    }));
    await translator.flush("completed");

    const types = events.map((e) => e.type);
    const toolUseIdx = types.indexOf("agent.tool_use");
    const messageIdx = types.indexOf("agent.message");
    expect(toolUseIdx).toBeGreaterThanOrEqual(0);
    expect(messageIdx).toBeGreaterThanOrEqual(0);
    expect(toolUseIdx).toBeLessThan(messageIdx);
  });

  it("flushes any pending tool_use at turn end via flush('completed')", async () => {
    // Skeleton with no terminal update — happens when the ACP child crashes
    // mid-call. Turn end must still produce a tool_use so downstream replay
    // doesn't see a phantom result with no matching call.
    await translator.consume(ev({
      sessionUpdate: "tool_call",
      toolCallId: "tc-5",
      title: "Edit",
      rawInput: { file_path: "/tmp/y.ts" },
    }));
    expect(events.filter((e) => e.type === "agent.tool_use")).toHaveLength(0);

    await translator.flush("completed");
    const toolUses = events.filter((e) => e.type === "agent.tool_use");
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0]).toMatchObject({ id: "tc-5", input: { file_path: "/tmp/y.ts" } });
  });

  it("drops pending tool_use on flush('aborted') — no tool_use without matching result", async () => {
    await translator.consume(ev({
      sessionUpdate: "tool_call",
      toolCallId: "tc-6",
      title: "Bash",
      rawInput: { command: "sleep 999" },
    }));
    await translator.flush("aborted");
    expect(events.filter((e) => e.type === "agent.tool_use")).toHaveLength(0);
  });

  it("falls back to anonymous emission when toolCallId is missing", async () => {
    // Defensive — malformed ACP frame. Skip dedup tracking, emit so the
    // events stream stays useful for debugging.
    await translator.consume(ev({
      sessionUpdate: "tool_call",
      title: "Mystery",
      rawInput: { x: 1 },
    }));
    const toolUses = events.filter((e) => e.type === "agent.tool_use");
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0].name).toBe("Mystery");
    expect(typeof toolUses[0].id).toBe("string");
  });
});

describe("AcpTranslator prompt usage", () => {
  it("projects ACP PromptResponse usage, including cache hits, into the managed span", async () => {
    const { runtime, events, reportedUsage } = makeFakeRuntime();
    const translator = new AcpTranslator(runtime, { model: "deepseek-v4-flash" });

    await translator.consume({
      type: "promptComplete",
      response: {
        stopReason: "end_turn",
        usage: {
          totalTokens: 1_520,
          inputTokens: 300,
          outputTokens: 20,
          cachedReadTokens: 1_200,
          cachedWriteTokens: 0,
        },
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: "span.model_request_start",
        model: "deepseek-v4-flash",
        id: expect.any(String),
      }),
      expect.objectContaining({
        type: "span.model_request_end",
        model: "deepseek-v4-flash",
        model_request_start_id: expect.any(String),
        model_usage: {
          input_tokens: 300,
          output_tokens: 20,
          cache_read_input_tokens: 1_200,
          cache_creation_input_tokens: 0,
        },
        finish_reason: "end_turn",
        is_error: false,
      }),
    ]);
    expect(events[1]?.model_request_start_id).toBe(events[0]?.id);
    expect(reportedUsage).toEqual([{ input: 300, output: 20 }]);
  });

  it("closes the managed span as an error when the ACP prompt rejects", async () => {
    const { runtime, events, reportedUsage } = makeFakeRuntime();
    const translator = new AcpTranslator(runtime);

    await translator.consume({
      type: "promptError",
      error: "provider unavailable",
    });

    expect(events.at(-1)).toMatchObject({
      type: "span.model_request_end",
      is_error: true,
      finish_reason: "error",
      error_message: "provider unavailable",
    });
    expect(reportedUsage).toEqual([]);
  });
});


describe("common projector child lifecycle", () => {
  it.each(["flush", "complete", "error"])("preserves pending child tools at %s boundary with a discoverable thread", async boundary => {
    const {runtime,events}=makeFakeRuntime(); const translator=new AcpTranslator(runtime);
    await translator.consume(ev({sessionUpdate:"tool_call",toolCallId:"task",_meta:{claudeCode:{toolName:"Task"}}}));
    await translator.consume(ev({sessionUpdate:"tool_call",toolCallId:"read",title:"Read",_meta:{claudeCode:{parentToolUseId:"task"}}}));
    if(boundary==="flush") await translator.flush();
    else await translator.consume(boundary==="complete"?{type:"promptComplete",response:{stopReason:"end_turn"}}:{type:"promptError",error:"failed"});
    const tools=events.filter(e=>e.type==="agent.tool_use");
    expect(tools.map(e=>e.id)).toEqual(["task","read"]);
    const child=tools.find(e=>e.id==="read")!;
    expect(child.session_thread_id).toBe("acp:claude:task");
    expect(events.some(e=>e.type==="session.thread_created"&&e.session_thread_id===child.session_thread_id)).toBe(true);
    expect(events.some(e=>e.type==="session.thread_status_running"&&e.session_thread_id===child.session_thread_id)).toBe(true);
  });
});

it("preserves nested common child lanes and cancelled lifecycle without root fallback", async () => {
  const {runtime,events}=makeFakeRuntime(); const t=new AcpTranslator(runtime);
  await t.consume(ev({sessionUpdate:"tool_call",toolCallId:"outer",_meta:{claudeCode:{toolName:"Task"}}}));
  await t.consume(ev({sessionUpdate:"tool_call",toolCallId:"inner",_meta:{claudeCode:{toolName:"Task",parentToolUseId:"outer"}}}));
  await t.consume(ev({sessionUpdate:"tool_call",toolCallId:"leaf",title:"Read",_meta:{claudeCode:{parentToolUseId:"inner"}}}));
  await t.consume(ev({sessionUpdate:"tool_call_update",toolCallId:"leaf",status:"completed",rawOutput:"ok"}));
  await t.consume(ev({sessionUpdate:"tool_call_update",toolCallId:"inner",status:"cancelled"}));
  await t.flush();
  expect(events.find(e=>e.type==="session.thread_created"&&e.session_thread_id==="acp:claude:inner")).toMatchObject({parent_thread_id:"acp:claude:outer"});
  expect(events.find(e=>e.type==="agent.tool_use"&&e.id==="leaf")).toMatchObject({session_thread_id:"acp:claude:inner"});
  expect(events.find(e=>e.type==="session.thread_status_idle"&&e.session_thread_id==="acp:claude:inner")).toMatchObject({interrupted:true});
  expect(events.filter(e=>e.type==="agent.tool_result"&&e.tool_use_id==="leaf")).toHaveLength(1);
});

it("keeps child text in its common lane without duplicating root text", async () => {
  const {runtime,events}=makeFakeRuntime(); const t=new AcpTranslator(runtime);
  await t.consume(ev({sessionUpdate:"tool_call",toolCallId:"task",_meta:{claudeCode:{toolName:"Task"}}}));
  await t.consume(ev({sessionUpdate:"agent_message_chunk",content:{text:"child answer"},_meta:{claudeCode:{parentToolUseId:"task"}}}));
  await t.consume(ev({sessionUpdate:"agent_message_chunk",content:{text:"root answer"}}));
  await t.flush();
  const messages=events.filter(e=>e.type==="agent.message");
  expect(messages.filter(e=>e.session_thread_id==="acp:claude:task")).toMatchObject([{content:[{type:"text",text:"child answer"}]}]);
  expect(messages.filter(e=>!e.session_thread_id)).toMatchObject([{content:[{type:"text",text:"root answer"}]}]);
});

it("does not leak unknown-parent text into root and keeps child thinking attributed", async () => {
  const {runtime,events}=makeFakeRuntime(); const t=new AcpTranslator(runtime);
  await t.consume(ev({sessionUpdate:"agent_message_chunk",content:{text:"unattributed child"},_meta:{claudeCode:{parentToolUseId:"missing"}}}));
  await t.consume(ev({sessionUpdate:"tool_call",toolCallId:"task",_meta:{claudeCode:{toolName:"Task"}}}));
  await t.consume(ev({sessionUpdate:"agent_thought_chunk",content:{text:"child reasoning"},_meta:{claudeCode:{parentToolUseId:"task"}}}));
  await t.flush();
  expect(events.filter(e=>e.type==="agent.message")).toHaveLength(0);
  expect(events.filter(e=>e.type==="agent.thinking")).toMatchObject([{session_thread_id:"acp:claude:task"}]);
});

it.each(["root","main"])("normalizes %s aliases without losing or duplicating root text/thinking",async lane=>{
 const {runtime,events}=makeFakeRuntime();const t=new AcpTranslator(runtime);
 await t.consume({type:"session.event",event:{session_thread_id:lane,update:{sessionUpdate:"agent_message_chunk",content:{text:"root answer"}}}});
 await t.consume({type:"session.event",event:{session_thread_id:lane,update:{sessionUpdate:"agent_thought_chunk",content:{text:"root thought"}}}});
 await t.flush();
 expect(events.filter(e=>e.type==="agent.message")).toMatchObject([{content:[{type:"text",text:"root answer"}]}]);
 expect(events.filter(e=>e.type==="agent.message")).toHaveLength(1);
 expect(events.filter(e=>e.type==="agent.thinking")).toMatchObject([{text:"root thought"}]);
 expect(events.filter(e=>e.type==="agent.thinking")).toHaveLength(1);
});

it("closes only outstanding calls once when the process fails, retaining child call identity", async () => {
  const {runtime,events}=makeFakeRuntime();const translator=new AcpTranslator(runtime);
  await translator.consume(ev({sessionUpdate:"tool_call",toolCallId:"done",title:"write"}));
  await translator.consume(ev({sessionUpdate:"tool_call_update",toolCallId:"done",status:"completed",rawOutput:"written"}));
  await translator.consume(ev({sessionUpdate:"tool_call",toolCallId:"pending",title:"read"}));
  await translator.consume({type:"promptError",error:"provider lost"});
  await translator.consume({type:"promptError",error:"duplicate transport terminal"});
  await translator.flush();
  const results=events.filter(e=>e.type==="agent.tool_result");
  expect(results.filter(e=>e.tool_use_id==="done")).toHaveLength(1);
  expect(results.filter(e=>e.tool_use_id==="pending")).toEqual([expect.objectContaining({is_error:true,content:"provider lost"})]);
});
