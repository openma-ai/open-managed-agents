import { describe, expect, it } from "vitest";
import { AcpTranslator } from "../src/harness/acp-translate";
import type { HarnessRuntime } from "../src/harness/interface";

function translator() {
  const events: Array<Record<string, unknown>> = [];
  const runtime = {
    broadcast: (event: Record<string, unknown>) => events.push(event),
    broadcastChunk: async () => {},
    broadcastStreamStart: async () => {},
    broadcastStreamEnd: async () => {},
    broadcastThinkingStart: async () => {},
    broadcastThinkingChunk: async () => {},
    broadcastThinkingEnd: async () => {},
  } as unknown as HarnessRuntime;
  const t = new AcpTranslator(runtime);
  const update = (u: Record<string, unknown>) =>
    t.consume({ type: "session.event", event: { sessionId: "s", update: u } } as never);
  const result = () => events.find((e) => e.type === "agent.tool_result")?.content;
  return { update, result };
}

const call = { sessionUpdate: "tool_call", toolCallId: "t1", title: "ls", kind: "execute", rawInput: { command: "ls" } };

describe("AcpTranslator tool output", () => {
  it("keeps terminal output sent before the status update", async () => {
    const { update, result } = translator();
    await update(call);
    await update({ sessionUpdate: "tool_call_update", toolCallId: "t1", _meta: { terminal_output: { terminal_id: "t1", data: "a\nb\n" } } });
    await update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", _meta: { terminal_exit: { exit_code: 0 } } });
    expect(result()).toBe("a\nb\n");
  });

  it("joins terminal output deltas", async () => {
    const { update, result } = translator();
    await update(call);
    await update({ sessionUpdate: "tool_call_update", toolCallId: "t1", _meta: { terminal_output_delta: { data: "a\n" } } });
    await update({ sessionUpdate: "tool_call_update", toolCallId: "t1", _meta: { terminal_output_delta: { data: "b\n" } } });
    await update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "failed" });
    expect(result()).toBe("a\nb\n");
  });

  it("reads text content when the status update carries no rawOutput", async () => {
    const { update, result } = translator();
    await update(call);
    await update({
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "```console\nhi\n```" } }],
    });
    expect(result()).toBe("```console\nhi\n```");
  });

  it("prefers rawOutput and falls back to the status", async () => {
    const a = translator();
    await a.update(call);
    await a.update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", rawOutput: "raw" });
    expect(a.result()).toBe("raw");
    const b = translator();
    await b.update(call);
    await b.update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" });
    expect(b.result()).toBe("(status: completed)");
  });
});
