import { describe, expect, it, vi } from "vitest";
import { SqlManagedSessionsComposition } from "../../../packages/managed-agents-adapters-sql/src/managed-sessions-composition";
import { lifecycleFixture } from "./session-lifecycle-parity-worker.helper";

// main d45d7dc application.ts:270-303 distinguishes budget interrupt (empty
// receipt, no append) from RA interrupt (receipt persists). This fixture seeds
// an already-committed pause via the real runtime API, not a fake admission gate.
describe("main parity: parked admission and production recovery races", () => {
  it.each(["interrupt", "message", "mixed"] as const)("budget_reached admission: %s", async mode => {
    const f = await lifecycleFixture({ type: "limit", max_list_cost: { amount: "0", currency: "USD" } });
    try {
      await f.claim();
      await f.publish([{ id: "budget-paused", type: "session.status_idle", processed_at: new Date().toISOString(), stop_reason: { type: "budget_reached" } }]);
      const before = await f.events();
      const workPath = "/v1/environments/" + f.scope.environmentId + "/work/" + f.scope.workId;
      const work = await f.api(workPath);
      const events = [
        ...(mode !== "message" ? [{ type: "user.interrupt" }] : []),
        ...(mode !== "interrupt" ? [{ type: "user.message", content: [{ type: "text", text: "cannot bypass budget" }] }] : []),
      ];
      const response = await f.cp.fetch(new Request("https://parity.test/v1/sessions/" + f.session.id + "/events", {
        method: "POST", headers: { "x-api-key": "parity-admin", "content-type": "application/json" }, body: JSON.stringify({ events }),
      }));
      expect(response.status).toBe(mode === "interrupt" ? 200 : 400);
      if (mode === "interrupt") expect((await response.json() as any).data).toEqual([]);
      expect(await f.events()).toEqual(before);
      expect(await f.api(workPath)).toEqual(work);
      expect((await f.api("/v1/sessions/" + f.session.id)).status).toBe("idle");
    } finally { await f.dispose(); }
  });

  it("production startup recovery and idempotent HTTP retry retain exactly one already-live Work", async () => {
    const tick = vi.spyOn(SqlManagedSessionsComposition.prototype, "recoverSchedulingPage"); // call-through, no fake recovery
    const f = await lifecycleFixture();
    try {
      const send = () => f.cp.fetch(new Request("https://parity.test/v1/sessions/" + f.session.id + "/events", {
        method: "POST", headers: { "x-api-key": "parity-admin", "content-type": "application/json", "Idempotency-Key": "tick-live" },
        body: JSON.stringify({ events: [{ type: "user.message", content: [{ type: "text", text: "pending live input" }] }] }),
      }));
      const original = await send(); expect(original.status).toBe(200); const receipt = await original.json() as any;
      const work = await f.claim();
      const [retry] = await Promise.all([send(), f.cp.start()]);
      expect(tick).toHaveBeenCalled();
      expect(retry.status).toBe(200);
      expect((await retry.json() as any).data.map((e: any) => e.id)).toEqual(receipt.data.map((e: any) => e.id));
      const sql = f.cp.components.database.sql;
      expect(await sql.prepare("SELECT id FROM managed_environment_work WHERE session_id = ?").bind(f.session.id).all()).toMatchObject({ results: [{ id: work.id }] });
      expect(await sql.prepare("SELECT count(*) AS n FROM managed_session_executions WHERE session_id = ?").bind(f.session.id).first()).toEqual({ n: 0 });
      expect((await f.events()).filter(e => e.type === "user.message")).toHaveLength(1);
    } finally { await f.dispose(); tick.mockRestore(); }
  });

  it("archive concurrent with production startup recovery cannot leave a new runnable Work", async () => {
    const tick = vi.spyOn(SqlManagedSessionsComposition.prototype, "recoverSchedulingPage"); // observes production wiring
    const f = await lifecycleFixture();
    try {
      await f.message("pending at archive");
      const work = await f.claim();
      await Promise.all([f.cp.start(), f.api("/v1/sessions/" + f.session.id + "/archive", {})]);
      expect(tick).toHaveBeenCalled();
      const session = await f.api("/v1/sessions/" + f.session.id);
      expect(session.archived_at).toEqual(expect.any(String));
      const rows = await f.cp.components.database.sql.prepare("SELECT id,state FROM managed_environment_work WHERE session_id = ?").bind(f.session.id).all<{ id: string; state: string }>();
      expect(rows.results).toHaveLength(1);
      expect(rows.results![0]!.id).toBe(work.id);
      expect(["stopping", "stopped"]).toContain(rows.results![0]!.state);
      const response = await f.cp.fetch(new Request("https://parity.test/v1/sessions/" + f.session.id + "/events", {
        method: "POST", headers: { "x-api-key": "parity-admin", "content-type": "application/json" },
        body: JSON.stringify({ events: [{ type: "user.message", content: [] }] }),
      }));
      expect(response.status).toBe(400);
    } finally { await f.dispose(); tick.mockRestore(); }
  });
});
