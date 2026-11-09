import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SqliteHistory } from "../../apps/agent/src/runtime/sqlite-history";
import { toSessionEventResponse } from "../../packages/managed-agents-api/src/mappers/session-events";

// Characterization (design §0.7 regression rule 1) of CF requires_action
// bookkeeping, locked before it moved into packages/session-runtime: a
// parallel batch re-announces only its outstanding ids (an open custom call
// or confirmation alike), a
// duplicate answer is stored with no effect, and the batch resumes the model
// with an empty resume message once every call has a result.
function seed(room: any, sessionId: string, pending: Array<{ toolCallId: string; toolName: string }>) {
  room._ensureCfAgentsSchema(); room.ensureSchema(); room._coldStartFlushDone = true;
  room.setState({ ...room.state, session_id: sessionId, tenant_id: "workspace", agent_id: "a",
    pending_tool_calls: pending.map((p) => ({ ...p, args: {} })) });
  room._ensurePrimaryThread();
}

describe("CF requires_action batch bookkeeping", () => {
  // Node's runner emits the domain stop reason and the public mapper renders
  // it; CF persists its wire form directly. The two must be the same object.
  it.each([
    ["custom tool", "lookup_user"],
    ["tool confirmation", "bash"],
  ])("stores the same stop_reason shape as Node renders (%s)", async (_label, toolName) => {
    const sessionId = `requires_action_batch_${crypto.randomUUID()}`;
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));
    await runInDurableObject(stub, async (instance, state) => {
      const room = instance as any;
      seed(room, sessionId, [
        { toolCallId: "call_a", toolName: "lookup_ticket" },
        { toolCallId: "call_b", toolName },
      ]);
      const history = new SqliteHistory(state.storage.sql, null);
      history.append({ type: "agent.custom_tool_use", id: "call_a", name: "lookup_ticket", input: {} } as never);
      await room.resumeWhenToolBatchSettled("call_a", history);
      const cf = (history.getEvents() as any[]).filter((e) => e.type === "session.status_idle").at(-1).stop_reason;
      const node = (toSessionEventResponse({
        id: "idle", type: "session.status_idle", processedAt: "2026-11-09T00:00:00.000Z",
        stopReason: { type: "requires_action", eventIds: ["call_b"] },
      } as never) as { stop_reason: unknown }).stop_reason;
      expect(cf).toEqual(node);
      expect(Object.keys(cf).sort()).toEqual(["event_ids", "type"]);
    });
  });

  it("re-announces outstanding ids that are still open", async () => {
    const sessionId = `requires_action_batch_${crypto.randomUUID()}`;
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));
    await runInDurableObject(stub, async (instance, state) => {
      const room = instance as any;
      seed(room, sessionId, [
        { toolCallId: "ctu_a", toolName: "lookup_ticket" },
        { toolCallId: "tu_mcp", toolName: "mcp_github_call" },
      ]);
      const history = new SqliteHistory(state.storage.sql, null);
      history.append({ type: "agent.custom_tool_use", id: "ctu_a", name: "lookup_ticket", input: {} } as never);
      const resumed: unknown[] = [];
      room.processUserMessage = async (...args: unknown[]) => { resumed.push(args); };
      const idles = () => (history.getEvents() as any[]).filter((e) => e.type === "session.status_idle");

      await room.resumeWhenToolBatchSettled("ctu_a", history);
      expect(idles().at(-1).stop_reason).toEqual({ type: "requires_action", event_ids: ["tu_mcp"] });
      expect(room.state.pending_tool_calls.map((p: any) => p.toolCallId)).toEqual(["tu_mcp"]);
      expect(resumed).toEqual([]);
    });
  });

  it("stays parked while a custom call is open, then resumes once settled", async () => {
    const sessionId = `requires_action_batch_${crypto.randomUUID()}`;
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));
    await runInDurableObject(stub, async (instance, state) => {
      const room = instance as any;
      seed(room, sessionId, [
        { toolCallId: "ctu_a", toolName: "lookup_ticket" },
        { toolCallId: "ctu_b", toolName: "lookup_user" },
      ]);
      const history = new SqliteHistory(state.storage.sql, null);
      history.append({ type: "agent.custom_tool_use", id: "ctu_a", name: "lookup_ticket", input: {} } as never);
      history.append({ type: "agent.custom_tool_use", id: "ctu_b", name: "lookup_user", input: {} } as never);
      const resumed: unknown[] = [];
      room.processUserMessage = async (...args: unknown[]) => { resumed.push(args); };
      const idles = () => (history.getEvents() as any[]).filter((e) => e.type === "session.status_idle");

      await room.resumeWhenToolBatchSettled("ctu_a", history);
      expect(idles().at(-1).stop_reason).toEqual({ type: "requires_action", event_ids: ["ctu_b"] });

      // ctu_a's echoed result counts as answered when the batch is re-read.
      history.append({ type: "agent.tool_result", tool_use_id: "ctu_a", content: "a" } as never);
      history.append({ type: "agent.tool_result", tool_use_id: "ctu_b", content: "b" } as never);
      await room.resumeWhenToolBatchSettled("ctu_b", history);
      expect(room.state.pending_tool_calls).toEqual([]);
      expect(resumed).toHaveLength(1);
      expect((resumed[0] as any[])[0]).toEqual({ type: "user.message", content: [{ type: "text", text: "" }] });
      // A custom tool's resume has not announced status_running yet.
      expect((resumed[0] as any[])[2]).toBe(false);
    });
  });

  it("stores a duplicate answer with no effect and rejects an unknown id", async () => {
    const sessionId = `requires_action_batch_${crypto.randomUUID()}`;
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));
    await runInDurableObject(stub, async (instance, state) => {
      const room = instance as any;
      seed(room, sessionId, []);
      const history = new SqliteHistory(state.storage.sql, null);
      history.append({ type: "agent.custom_tool_use", id: "ctu_a", name: "lookup_ticket", input: {} } as never);
      history.append({ type: "agent.tool_result", tool_use_id: "ctu_a", content: "a" } as never);
      const post = (body: unknown) => room.fetch(new Request("http://internal/event", { method: "POST", body: JSON.stringify(body) }));
      const before = (history.getEvents() as any[]).length;
      expect((await post({ type: "user.custom_tool_result", custom_tool_use_id: "ctu_a", content: [{ type: "text", text: "again" }] })).status).toBe(202);
      const after = history.getEvents() as any[];
      expect(after).toHaveLength(before + 1);
      expect(after.at(-1)).toMatchObject({ type: "user.custom_tool_result", custom_tool_use_id: "ctu_a" });
      expect(typeof after.at(-1).processed_at).toBe("string");
      expect((await post({ type: "user.custom_tool_result", custom_tool_use_id: "nope", content: [] })).status).toBe(400);
    });
  });
});
