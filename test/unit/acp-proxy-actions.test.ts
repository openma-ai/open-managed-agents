import { describe, expect, it, vi } from "vitest";
import { AcpProxyHarness } from "../../apps/agent/src/harness/acp-proxy-loop";
import type { HarnessContext } from "../../apps/agent/src/harness/interface";

class Socket {
  listeners = new Map<string, Array<(event: any) => void>>();
  sent: Array<Record<string, any>> = [];
  onSend: (frame: Record<string, any>) => void = () => {};
  addEventListener(type: string, listener: (event: any) => void) { this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]); }
  removeEventListener(type: string, listener: (event: any) => void) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry !== listener)); }
  accept() { this.receive({ type: "attached", daemon_online: true }); }
  receive(frame: unknown) { for (const listener of this.listeners.get("message") ?? []) listener({ data: JSON.stringify(frame) }); }
  close() { for (const listener of this.listeners.get("close") ?? []) listener({}); }
  send(raw: string) { const frame = JSON.parse(raw); this.sent.push(frame); queueMicrotask(() => this.onSend(frame)); }
}

describe("ACP proxy runner approvals", () => {
  it.each([false, true])("reattaches after disconnect (ambiguous send: %s), keeps translation and does not repeat input", async (ambiguousSend) => {
    const events: Array<Record<string, any>> = [];
    const sockets: Socket[] = [];
    const attaches: Request[] = [];
    let turnId = "";
    const output = (seq: number, text: string) => ({ type: "session.event", turn_id: turnId, delivery: { stream_id: "stream", seq }, event: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
    const context = {
      agent: { model: "test-model", runtime_binding: { runtime_id: "runner", acp_agent_id: "codex-acp" } },
      session_id: "remote", tenant_id: "team", userMessage: { type: "user.message", content: [{ type: "text", text: "go" }] },
      env: { RUNTIME_ROOM: { idFromName: (id: string) => id, get: () => ({ fetch: async (request: Request) => {
        attaches.push(request);
        const socket = new Socket(); sockets.push(socket);
        if (ambiguousSend && sockets.length === 1) {
          const send = socket.send.bind(socket);
          socket.send = (raw) => { send(raw); if (JSON.parse(raw).type === "session.prompt") throw new Error("socket lost while writing"); };
        }
        socket.accept = () => {
          socket.receive({ type: "attached", daemon_online: true, capabilities: ["durable_session_events_v1"] });
          if (sockets.length > 1) {
            socket.receive(output(1, "Before ")); // lost receipt replay must not duplicate text
            socket.receive(output(2, "after"));
            socket.receive({ type: "session.complete", turn_id: turnId, delivery: { stream_id: "stream", seq: 3 } });
          }
        };
        socket.onSend = (frame) => {
          if (frame.type === "session.start") socket.receive({ type: "session.ready", acp_session_id: "native" });
          if (frame.type === "session.prompt") { turnId = frame.turn_id; socket.receive(output(1, "Before ")); socket.close(); }
        };
        return { status: 101, webSocket: socket };
      } }) } },
      runtime: {
        history: { getEvents: () => events }, broadcast: (event: Record<string, any>) => events.push(event), pendingConfirmations: [],
        broadcastStreamStart: async () => {}, broadcastChunk: async () => {}, broadcastStreamEnd: async () => {},
        broadcastThinkingStart: async () => {}, broadcastThinkingChunk: async () => {}, broadcastThinkingEnd: async () => {},
      },
    } as unknown as HarnessContext;
    await new AcpProxyHarness().run(context);
    expect(attaches).toHaveLength(2);
    expect(JSON.parse(attaches[1]!.headers.get("x-runtime-replay")!)).toEqual({ turn_id: turnId, after: ambiguousSend ? {} : { stream: 1 } });
    expect(sockets.flatMap((socket) => socket.sent).filter((frame) => frame.type === "session.prompt")).toHaveLength(1);
    expect(sockets[1]!.sent).toEqual([]);
    expect(events.filter((event) => event.type === "agent.message")).toEqual([
      expect.objectContaining({ content: [{ type: "text", text: "Before after" }] }),
    ]);
    expect(events.some((event) => event.type === "session.error")).toBe(false);
  });

  it("pauses for a callback and resumes the original ACP turn without another prompt", async () => {
    const events: Array<Record<string, any>> = [];
    const sockets: Socket[] = [];
    const clearPending = vi.fn();
    const context = {
      agent: { model: "test-model", runtime_binding: { runtime_id: "runner", acp_agent_id: "codex-acp" } },
      session_id: "remote", tenant_id: "team", userMessage: { type: "user.message", content: [{ type: "text", text: "go" }] },
      env: { RUNTIME_ROOM: { idFromName: (id: string) => id, get: () => ({ fetch: async () => {
        const socket = new Socket(); sockets.push(socket);
        socket.onSend = (frame) => {
          if (frame.type === "session.start") socket.receive({ type: "session.ready", acp_session_id: "acp" });
          if (frame.type === "session.prompt") socket.receive({ type: "session.event", turn_id: frame.turn_id, delivery: { stream_id: "approval-stream", seq: 1 }, event: {
            type: "client.request", request_id: "approval", method: "session/request_permission", params: {
              toolCall: { toolCallId: "tool", title: "Write a file" }, options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }],
            },
          } });
          if (frame.type === "session.response") {
            socket.receive({ type: "session.event", turn_id: frame.turn_id, delivery: { stream_id: "approval-stream", seq: 2 }, event: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Before " } } } });
            socket.receive({ type: "session.event", turn_id: frame.turn_id, delivery: { stream_id: "approval-stream", seq: 3 }, event: { type: "client.response", request_id: "approval" } });
            socket.receive({ type: "session.event", turn_id: frame.turn_id, delivery: { stream_id: "approval-stream", seq: 4 }, event: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done" } } } });
            socket.receive({ type: "session.complete", turn_id: frame.turn_id });
          }
        };
        return { status: 101, webSocket: socket };
      } }) } },
      runtime: {
        history: { getEvents: () => events }, broadcast: (event: Record<string, any>) => events.push(event), pendingConfirmations: [],
        consumePendingConfirmation: clearPending,
        broadcastStreamStart: async () => {}, broadcastChunk: async () => {}, broadcastStreamEnd: async () => {},
        broadcastThinkingStart: async () => {}, broadcastThinkingChunk: async () => {}, broadcastThinkingEnd: async () => {},
      },
    } as unknown as HarnessContext;
    const harness = new AcpProxyHarness();
    const run = harness.run(context);
    try {
      await vi.waitFor(() => expect(events.find((event) => event.type === "agent.custom_tool_use")).toMatchObject({ id: "approval", input: { _openma: { type: "runtime_action", method: "session/request_permission" } } }), { timeout: 1000 });
      await run;
      expect(context.runtime.pendingConfirmations).toEqual(["approval"]);
      const turnId = sockets[0]!.sent.find((frame) => frame.type === "session.prompt")!.turn_id;
      events.push({ type: "user.custom_tool_result", custom_tool_use_id: "approval", content: [{ type: "text", text: JSON.stringify({ outcome: { outcome: "selected", optionId: "yes" } }) }] });
      context.userMessage = { type: "user.message", content: [{ type: "text", text: "" }] } as never;
      context.runtime.pendingConfirmations = [];
      await harness.run(context);
      expect(sockets.flatMap((socket) => socket.sent).filter((frame) => frame.type === "session.prompt")).toHaveLength(1);
      expect(sockets[1]!.sent).toContainEqual({ type: "session.response", turn_id: turnId, request_id: "approval", response: { outcome: { outcome: "selected", optionId: "yes" } } });
      expect(clearPending).toHaveBeenCalledWith("approval");
      expect(events).toContainEqual(expect.objectContaining({ type: "agent.message", content: [{ type: "text", text: "Before Done" }] }));
    } finally { for (const socket of sockets) socket.close(); await run; }
  });
});
