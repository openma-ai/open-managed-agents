import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { registerHarness } from "../../apps/agent/src/harness/registry";
import { AcpProxyHarness } from "../../apps/agent/src/harness/acp-proxy-loop";
import { SqliteHistory } from "../../apps/agent/src/runtime/history";

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
  it.each([true, false])("uses the original turn and only settles on native completion (completion=%s)", async (complete) => {
    const sessionId = `permission_interrupt_${crypto.randomUUID()}`;
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));
    await runInDurableObject(stub, async (instance, state) => {
      // Seed a hot paused session, including its durable callback history. The
      // real HTTP handler, registry, ACP proxy and SQL persistence all run.
      const room = instance as any;
      room._ensureCfAgentsSchema(); room.ensureSchema(); room._coldStartFlushDone = true;
      const action = (id: string, thread?: string) => ({ type: "agent.custom_tool_use" as const, id, name: "Write a file",
        ...(thread ? { session_thread_id: thread } : {}),
        input: { _openma: { type: "runtime_action", method: "session/request_permission", turn_id: `turn-${id}`, params: { options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }] } } },
      });
      const actions = [action("primary-request"), action("sibling-request", "sthr_sibling")];
      room.setState({ ...room.state, session_id: sessionId, tenant_id: "workspace", agent_id: "runner-agent",
        agent_snapshot: { id: "runner-agent", version: 1, name: "Runner", harness: "acp-proxy", runtime_binding: { runtime_id: "machine", acp_agent_id: "codex-acp" } },
        pending_tool_calls: actions.map((event) => ({ toolCallId: event.id, toolName: event.name, args: event.input })),
      });
      room._ensurePrimaryThread();
      const history = new SqliteHistory(state.storage.sql, null);
      for (const event of actions) history.append(event as never);
      history.append({ type: "session.status_idle", stop_reason: { type: "requires_action", action_type: "custom_tool_result", event_ids: ["primary-request"] } } as never);
      expect(room._threadAbortControllers.size).toBe(0);
      const socket = new RunnerSocket(complete);
      const attached: Request[] = [];
      const originalEnv = room.env;
      room.env = { ...originalEnv, RUNTIME_ROOM: { idFromName: (id: string) => id, get: (id: string) => {
        expect(id).toBe("machine");
        return { fetch: async (request: Request) => { attached.push(request); return { status: 101, webSocket: socket }; } };
      } } };
      try {
        const response = await room.fetch(new Request("http://internal/event", { method: "POST", body: JSON.stringify({ type: "user.interrupt" }) }));
        expect(socket.sent).toEqual([{ type: "session.cancel", turn_id: "turn-primary-request" }]);
        expect(attached[0]?.headers.get("x-session-id")).toBe(sessionId);
        expect(attached[0]?.headers.get("x-harness-tenant")).toBe("workspace");
        expect(response.status).toBe(complete ? 202 : 503);
        expect(room.state.pending_tool_calls.map((pending: any) => pending.toolCallId)).toEqual(complete ? ["sibling-request"] : ["primary-request", "sibling-request"]);
        const persisted = JSON.parse(state.storage.sql.exec<{ state: string }>("SELECT state FROM cf_agents_state LIMIT 1").one().state);
        expect(persisted.pending_tool_calls.map((pending: any) => pending.toolCallId)).toEqual(complete ? ["sibling-request"] : ["primary-request", "sibling-request"]);
        const results = history.getEvents().filter((event: any) => event.type === "agent.tool_result");
        expect(results).toEqual(complete ? [expect.objectContaining({ tool_use_id: "primary-request", is_error: true })] : []);
        const ends = history.getEvents().filter((event: any) => event.type === "session.status_idle" && event.stop_reason?.type === "end_turn");
        expect(ends).toHaveLength(complete ? 1 : 0);
        if (complete) {
          await room.fetch(new Request("http://internal/event", { method: "POST", body: JSON.stringify({ type: "user.interrupt" }) }));
          expect(socket.sent).toHaveLength(1);
          expect(history.getEvents().filter((event: any) => event.type === "session.status_idle" && event.stop_reason?.type === "end_turn")).toHaveLength(1);
        }
      } finally { room.env = originalEnv; socket.close(); }
    });
  });
});
