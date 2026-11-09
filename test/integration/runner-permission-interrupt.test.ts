import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { registerHarness } from "../../packages/agent-harness/src/registry";
import { AcpProxyHarness } from "../../packages/agent-harness/src/acp-proxy-loop";
import { SqliteHistory } from "../../apps/agent/src/runtime/sqlite-history";

registerHarness("acp-proxy", () => new AcpProxyHarness());

class RunnerSocket {
  listeners = new Map<string, Array<(event: any) => void>>();
  sent: Array<Record<string, any>> = [];
  constructor(readonly complete: boolean) {}
  addEventListener(type: string, listener: (event: any) => void) { this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]); }
  removeEventListener(type: string, listener: (event: any) => void) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry !== listener)); }
  accept() { this.receive({ type: "attached", daemon_online: true }); }
  receive(frame: unknown) { for (const listener of this.listeners.get("message") ?? []) listener({ data: JSON.stringify(frame) }); }
  close() { for (const listener of this.listeners.get("close") ?? []) listener({}); }
  send(raw: string) {
    const frame = JSON.parse(raw); this.sent.push(frame);
    if (frame.type === "session.cancel") queueMicrotask(() => {
      if (this.complete) this.receive({ type: "session.complete", turn_id: frame.turn_id });
      else this.close();
    });
  }
}

describe("interrupting a runner while its proxy is waiting for permission", () => {
  it.each([true, false])("idle requires_action interrupt is a no-op (completion=%s fixture retained)", async (complete) => {
    const sessionId = `permission_interrupt_${crypto.randomUUID()}`;
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));
    await runInDurableObject(stub, async (instance, state) => {
      // Seed a parked requires_action session with no in-flight turn. Official
      // CMA: interrupt against idle (including requires_action) is a true no-op
      // — no session.cancel to the runner, pending calls unchanged.
      const room = instance as any;
      room._ensureCfAgentsSchema(); room.ensureSchema(); room._coldStartFlushDone = true;
      const action = (id: string, thread?: string) => ({ type: "agent.custom_tool_use" as const, id, name: "Write a file",
        ...(thread ? { session_thread_id: thread } : {}),
        input: { _openma: { type: "runtime_action", method: "session/request_permission", turn_id: `turn-${id}`, params: { options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }] } } },
      });
      const actions = [action("primary-request"), action("sibling-request", "sthr_sibling")];
      room.setState({ ...room.state, session_id: sessionId, tenant_id: "workspace", agent_id: "runner-agent",
        agent_snapshot: { id: "runner-agent", version: 1, name: "Runner", model: "codex", system: "", tools: [], mcp_servers: [], skills: [], harness: "acp-proxy", runtime_binding: { runtime_id: "machine", acp_agent_id: "codex-acp" } },
        pending_tool_calls: actions.map((event) => ({ toolCallId: event.id, toolName: event.name, args: event.input })),
      });
      room._ensurePrimaryThread();
      const history = new SqliteHistory(state.storage.sql, null);
      for (const event of actions) history.append(event as never);
      history.append({ type: "session.status_idle", stop_reason: { type: "requires_action", event_ids: ["primary-request"] } } as never);
      expect(room._threadAbortControllers.size).toBe(0);
      const socket = new RunnerSocket(complete);
      const originalEnv = room.env;
      room.env = { ...originalEnv, RUNTIME_ROOM: { idFromName: (id: string) => id, get: (id: string) => {
        expect(id).toBe("machine");
        return { fetch: async () => ({ status: 101, webSocket: socket }) };
      } } };
      try {
        const beforeLen = (history.getEvents() as any[]).length;
        const response = await room.fetch(new Request("http://internal/event", { method: "POST", body: JSON.stringify({ type: "user.interrupt" }) }));
        expect(response.status).toBe(202);
        expect(socket.sent).toEqual([]);
        expect(room.state.pending_tool_calls.map((pending: any) => pending.toolCallId)).toEqual([
          "primary-request",
          "sibling-request",
        ]);
        // Wire no-op still echoes user.interrupt; does not close tools.
        expect((history.getEvents() as any[]).length).toBe(beforeLen + 1);
        expect((history.getEvents() as any[]).at(-1)).toMatchObject({ type: "user.interrupt" });
        expect(history.getEvents().filter((event: any) => event.type === "agent.tool_result")).toEqual([]);
        // complete fixture retained for parametrize stability; no runner cancel either way.
        void complete;
      } finally { room.env = originalEnv; socket.close(); }
    });
  });
});
