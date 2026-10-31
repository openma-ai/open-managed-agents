import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SqliteHistory } from "../../apps/agent/src/runtime/history";

// Official CMA (platform.claude.com/docs/en/managed-agents/events-and-streaming):
// an interrupted turn ends with session.status_idle end_turn, and "a second
// result for the same call is accepted and has no effect".
describe("user.interrupt while requires_action (custom tool)", () => {
  it("ends the turn with end_turn and a late custom_tool_result has no effect", async () => {
    const sessionId = `interrupt_ra_${crypto.randomUUID()}`;
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));
    await runInDurableObject(stub, async (instance, state) => {
      const room = instance as any;
      room._ensureCfAgentsSchema(); room.ensureSchema(); room._coldStartFlushDone = true;
      const use = { type: "agent.custom_tool_use" as const, id: "ctu_1", name: "run_tests", input: {} };
      room.setState({ ...room.state, session_id: sessionId, tenant_id: "workspace", agent_id: "a",
        pending_tool_calls: [{ toolCallId: "ctu_1", toolName: "run_tests", args: {} }] });
      room._ensurePrimaryThread();
      const history = new SqliteHistory(state.storage.sql, null);
      history.append({ type: "user.message", content: [{ type: "text", text: "go" }], processed_at: new Date().toISOString() } as never);
      history.append(use as never);
      history.append({ type: "session.status_idle", stop_reason: { type: "requires_action", event_ids: ["ctu_1"] } } as never);

      const post = (body: unknown) => room.fetch(new Request("http://internal/event", { method: "POST", body: JSON.stringify(body) }));
      expect((await post({ type: "user.interrupt" })).status).toBe(202);
      const after = history.getEvents() as any[];
      const results = after.filter((e) => e.type === "agent.tool_result");
      expect(results).toEqual([expect.objectContaining({ tool_use_id: "ctu_1", is_error: true,
        content: [{ type: "text", text: "Tool execution was interrupted before completion. Please retry." }] })]);
      const statuses = after.filter((e) => e.type.startsWith("session.status_"));
      expect(statuses.at(-1)).toMatchObject({ type: "session.status_idle", stop_reason: { type: "end_turn" } });
      expect(after.findIndex((e) => e.type === "agent.tool_result")).toBeLessThan(after.length - 1);
      expect(room.state.pending_tool_calls).toEqual([]);

      // Double interrupt: no second idle.
      await post({ type: "user.interrupt" });
      const n = (history.getEvents() as any[]).length;

      // Late answer for the closed call: accepted, stamped, no effect.
      const late = await post({ type: "user.custom_tool_result", custom_tool_use_id: "ctu_1", content: [{ type: "text", text: "late" }] });
      expect(late.status).toBe(202);
      const final = history.getEvents() as any[];
      expect(final.slice(n).map((e) => e.type)).toEqual(["user.custom_tool_result"]);
      expect(final.at(-1).processed_at).toBeTruthy();
      expect(final.filter((e) => e.type === "agent.tool_result")).toHaveLength(1);
      expect(final.filter((e) => e.type === "session.status_idle" && e.stop_reason?.type === "end_turn")).toHaveLength(1);
      expect(final.some((e) => e.type === "session.status_running")).toBe(false);

      // Unknown id -> 400.
      expect((await post({ type: "user.custom_tool_result", custom_tool_use_id: "nope", content: [] })).status).toBe(400);
    });
  });
});
