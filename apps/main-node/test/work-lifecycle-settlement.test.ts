import { describe, expect, it } from "vitest";
import { decodeSessionEventDocument } from "@open-managed-agents/session-runtime-contract/history";
import { lifecycleFixture } from "./session-lifecycle-parity-worker.helper";

// Real HTTP/CAS/SQL coverage for response-loss retries of derived lifecycle
// facts. The parity acceptance suites remain unchanged.
describe("Work lifecycle settlement replay", () => {
  it("confirms an identical failed-turn publication after it has made the session idle", async () => {
    const f = await lifecycleFixture();
    try {
      await f.message("effect once"); await f.claim();
      await f.publish([{ id: "running", type: "session.status_running", processed_at: new Date().toISOString() }]);
      const events = [{ id: "failed", type: "session.error", processed_at: new Date().toISOString(),
        error: { type: "unknown_error", message: "connection lost after output", retry_status: "terminal" } }];
      await f.publish(events);
      const before = await f.events();
      await f.publish(events);
      expect(await f.events()).toEqual(before);
      const changed = await f.cp.fetch(new Request("https://parity.test/v1/oma/sessions/" + f.session.id + "/runtime-events", {
        method: "POST", headers: { authorization: "Bearer " + f.token(), "content-type": "application/json" },
        body: JSON.stringify({ events: [{ ...events[0], error: { ...events[0].error, message: "different failure" } }] }),
      }));
      expect(changed.status).toBe(409);
      expect(await f.events()).toEqual(before);
      expect(before.filter(e => e.type === "session.status_idle").at(-1)?.stop_reason).toEqual({ type: "retries_exhausted" });
    } finally { await f.dispose(); }
  });

  it("confirms a budget stop retry after a cap increase without reverting the cap or its resume event", async () => {
    const f = await lifecycleFixture({ type: "limit", max_list_cost: { amount: "1", currency: "USD" } });
    try {
      await f.message("budget turn"); await f.claim();
      // Persist the same canonical exact meter that the real proxy maintains;
      // this case isolates response loss from the provider and common pump.
      const sql = f.cp.components.database.sql;
      const row = await sql.prepare("SELECT document FROM managed_sessions WHERE id = ?").bind(f.session.id).first<{ document: string }>();
      const session = JSON.parse(row!.document);
      session.usage = { list_cost_pico: "10000000000", listCost: { amountMinor: "1", currency: "USD" } };
      await sql.prepare("UPDATE managed_sessions SET document = ? WHERE id = ?").bind(JSON.stringify(session), f.session.id).run();
      const events = [{ id: "budget-idle", type: "session.status_idle", processed_at: new Date().toISOString(), stop_reason: { type: "end_turn" } }];
      await f.publish(events);
      const rows = await sql.prepare("SELECT document FROM managed_session_events WHERE session_id = ?").bind(f.session.id).all<{ document: string }>();
      const ordered = rows.results.map(row => decodeSessionEventDocument(row.document)).sort((a, b) => a.position!.revision - b.position!.revision || a.position!.index - b.position!.index);
      expect(ordered.slice(-3).map(row => row.event.type)).toEqual(["session.thread_status_idle", "session.usage", "session.status_idle"]);
      await f.api("/v1/sessions/" + f.session.id, { budget: { type: "limit", max_list_cost: { amount: "3", currency: "USD" } } });
      const before = await f.events();
      const update = await sql.prepare("SELECT document FROM managed_session_events WHERE session_id = ? AND type = 'session.updated'").bind(f.session.id).first<{ document: string }>();
      expect(decodeSessionEventDocument(update!.document).event).toMatchObject({ resume: true });
      await f.publish(events);
      expect(await f.events()).toEqual(before);
      expect((await f.api("/v1/sessions/" + f.session.id)).budget.max_list_cost.amount).toBe("3");
      await sql.prepare("UPDATE managed_environment_work SET claim_generation = claim_generation + 1 WHERE id = ?").bind(f.scope.workId).run();
      const stale = await f.cp.fetch(new Request("https://parity.test/v1/oma/sessions/" + f.session.id + "/runtime-events", {
        method: "POST", headers: { authorization: "Bearer " + f.token(), "content-type": "application/json" }, body: JSON.stringify({ events }),
      }));
      expect(stale.status).toBeGreaterThanOrEqual(400);
      expect(await f.events()).toEqual(before);
    } finally { await f.dispose(); }
  });
});
