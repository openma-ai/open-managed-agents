import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { SqliteHistory } from "../../apps/agent/src/runtime/sqlite-history";

// Direct DO fixtures bypass HTTP init; bootstrap the real deployment schema
// before event projection/markProcessed RPCs can reach the combined worker.
beforeAll(async () => {
  const response = await exports.default.fetch(new Request("http://localhost/v1/oma/model_cards", { headers: { "x-api-key": "test-key" } }));
  expect(response.status).toBe(200);
});

// Official CMA: against an already-idle session (including idle
// requires_action) an interrupt is a true no-op — accept, leave event_ids /
// pending_tool_calls / stop_reason untouched. A late custom_tool_result for a
// still-open call resumes; an unknown id is 400.
describe("user.interrupt while requires_action (custom tool)", () => {
  it("idle requires_action interrupt is a no-op; late result still answers the open call", async () => {
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
      const before = history.getEvents() as any[];
      expect((await post({ type: "user.interrupt" })).status).toBe(202);
      const afterInterrupt = history.getEvents() as any[];
      // Wire no-op: accept + echo user.interrupt on the stream, but do not
      // invent tool_result / end_turn or overwrite requires_action.
      expect(afterInterrupt.filter((e) => e.type === "agent.tool_result")).toEqual([]);
      expect(afterInterrupt).toHaveLength(before.length + 1);
      expect(afterInterrupt.at(-1)).toMatchObject({ type: "user.interrupt" });
      expect(afterInterrupt.filter((e) => e.type === "session.status_idle").at(-1)).toMatchObject({
        type: "session.status_idle",
        stop_reason: { type: "requires_action", event_ids: ["ctu_1"] },
      });
      expect(room.state.pending_tool_calls).toEqual([
        expect.objectContaining({ toolCallId: "ctu_1" }),
      ]);

      // Late answer for the still-open call: accepted and effectful path may run.
      const late = await post({ type: "user.custom_tool_result", custom_tool_use_id: "ctu_1", content: [{ type: "text", text: "late" }] });
      expect(late.status).toBe(202);
      const final = history.getEvents() as any[];
      expect(final.some((e) => e.type === "user.custom_tool_result")).toBe(true);

      // Unknown id -> 400.
      expect((await post({ type: "user.custom_tool_result", custom_tool_use_id: "nope", content: [] })).status).toBe(400);
      await room._managedProjectionChain;
    });
  });
});
