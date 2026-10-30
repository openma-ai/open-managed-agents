// @ts-nocheck
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createEgressRelayPasses } from "../../packages/managed-credential-resolver/src/relay";

describe("Cloudflare production Session relay route", () => {
  it("accepts only the Session pass, uses the current D1 Session and denies archival", async () => {
    const health = await exports.default.fetch(new Request("http://localhost/health"));
    expect(health.status).toBe(200);
    const id = `relay-${crypto.randomUUID()}`;
    await env.MAIN_DB.prepare(`INSERT INTO managed_sessions
      (workspace_id,id,document,revision,agent_id,agent_version,environment_id,status,created_at,updated_at,archived_at)
      VALUES ('default',?,?,1,'agent',1,'environment','idle',?,?,NULL)`)
      .bind(id, JSON.stringify({ vaultIds: [] }), Date.now(), Date.now()).run();
    const passes = createEgressRelayPasses(env.PLATFORM_ROOT_SECRET, Date.now);
    const pass = await passes.issue({ workspaceId: "default", sessionId: id, ttlMs: 60000 });
    const call = (authorization: string) => exports.default.fetch(new Request("https://localhost/v1/oma/egress/resolve", {
      method: "POST", headers: { authorization, "x-oma-egress-target": "https://public.example/" },
    }));
    try {
      const response = await call(`Bearer ${pass}`);
      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toEqual({ inject: false });
      expect((await call("Bearer test-key")).status).toBe(401);
      await env.MAIN_DB.prepare("UPDATE managed_sessions SET archived_at=? WHERE workspace_id='default' AND id=?").bind(Date.now(), id).run();
      expect((await call(`Bearer ${pass}`)).status).toBe(403);
    } finally {
      await env.MAIN_DB.prepare("DELETE FROM managed_sessions WHERE workspace_id='default' AND id=?").bind(id).run();
    }
  });
});
