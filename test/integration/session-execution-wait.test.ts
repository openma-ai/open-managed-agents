// @ts-nocheck
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { SqliteHistory } from "../../apps/agent/src/runtime/sqlite-history";
import { SqlSessionExecutionStore } from "@open-managed-agents/session-runtime-sql/coordination";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import { encodeSessionEventDocument } from "@open-managed-agents/session-runtime-contract/history";
import { waitForSessionExecution } from "./_session-execution";

async function fixture() {
  await exports.default.fetch(new Request("http://localhost/health"));
  const id = crypto.randomUUID(), stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(id));
  const workspaceId = crypto.randomUUID();
  await runInDurableObject(stub, (instance, state) => {
    instance.ensureSchema(); instance._state = { tenant_id: workspaceId, session_id: id };
    new SqliteHistory(state.storage.sql, null).append({ type: "session.status_idle", stop_reason: { type: "end_turn" } });
  });
  const store = new SqlSessionExecutionStore(new CfD1SqlClient(env.MAIN_DB));
  async function execution(executionId, inputId) {
    await store.admit({ execution: { workspaceId, sessionId: id, id: executionId, admittedAt: new Date().toISOString(), events: [{ id: inputId, type: "user.message", content: [{ type: "text", text: inputId }], processedAt: null }] } });
    const claim = await store.claim({ workspaceId, sessionId: id, ownerId: "test", attemptId: crypto.randomUUID(), claimedAt: new Date().toISOString(), leaseTtlMs: 30_000 });
    await store.settle({ fence: claim.fence, settledAt: new Date().toISOString(), outcome: "completed" });
  }
  async function input(inputId, consumer) {
    const event = { id: inputId, type: "user.message", content: [{ type: "text", text: inputId }], processedAt: new Date().toISOString() };
    await env.MAIN_DB.prepare("INSERT INTO managed_session_events (workspace_id,session_id,id,type,document,processed_at) VALUES (?,?,?,'user.message',?,?)")
      .bind(workspaceId,id,inputId,encodeSessionEventDocument(event,{ revision: 1,index: 0 },inputId,consumer),Date.now()).run();
    await runInDurableObject(stub, (_i,state) => new SqliteHistory(state.storage.sql,null).append({ ...event, processed_at: event.processedAt }));
  }
  async function idle() { await runInDurableObject(stub, (_i,state) => new SqliteHistory(state.storage.sql,null).append({ type: "session.status_idle", stop_reason: { type: "end_turn" } })); }
  return { id, workspaceId, stub, store, execution, input, idle };
}
it("rejects processed input plus an unrelated completed execution and initial idle", async () => {
  const f = await fixture(); await f.execution("old", "old-input"); await f.input("new-input", "new-execution");
  await expect(waitForSessionExecution(f.id, ["new-input"], 150)).rejects.toThrow("did not finish");
});
it("requires a real idle after the accepted input, even when its consumer is terminal", async () => {
  const f = await fixture(); await f.execution("consumer", "input"); await f.input("input", "consumer");
  await expect(waitForSessionExecution(f.id, ["input"], 150)).rejects.toThrow("did not finish");
  await f.idle(); await waitForSessionExecution(f.id, ["input"], 500);
  await expect(waitForSessionExecution(f.id, ["input", "missing"], 150)).rejects.toThrow("did not finish");
});
it("does not accept a completed steering admission while its actual consumer is running", async () => {
  const f = await fixture(); await f.execution("admission", "steered"); await f.input("steered", "actual-consumer"); await f.idle();
  await f.store.admit({ execution: { workspaceId: f.workspaceId, sessionId: f.id, id: "actual-consumer", admittedAt: new Date().toISOString(), events: [{ id: "trigger", type: "user.message", content: [{ type: "text", text: "trigger" }], processedAt: null }] } });
  await expect(waitForSessionExecution(f.id, ["steered"], 150)).rejects.toThrow("did not finish");
});
it("uses the consumer link, not the input's own execution or future inputs", async () => {
  const f = await fixture(); await f.execution("consumer", "input"); await f.input("input", "consumer"); await f.idle();
  // A later accepted input is deliberately unprocessed. It must not expand this wait's fixed set.
  await runInDurableObject(f.stub, instance => instance.queue.enqueueQueueInput({ id: "future", type: "user.message", content: [{ type: "text", text: "future" }] }));
  await waitForSessionExecution(f.id, ["input"], 500);
});
