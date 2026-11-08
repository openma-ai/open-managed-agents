import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { sqlClientFromD1 } from "@open-managed-agents/sql-client/adapters/cf-d1";
import { SqlRuntimeOrphanPort } from "@open-managed-agents/runtime-resource-fence-sql";
import { setCloudflareSandboxForTest } from "../../apps/agent/src/runtime/sandbox";
import { getCfServicesForTenant } from "@open-managed-agents/services";
import type { E2BV2Module } from "@open-managed-agents/sandbox-adapter-e2b/v2";
import { reclaimCloudflareOrphanSandboxes } from "../../apps/agent/src/runtime/sandbox-orphan-reclaim";

// Design §0.0 rule 14 on Cloudflare: the apps/main cron calls the agent
// worker, which drains the MAIN_DB orphan queue with the shared job and, on
// SANDBOX_ADAPTER=e2b ("changes" handle), lists the labelled sandboxes and
// releases those whose Session ended.

const HOUR_AGO = () => new Date(Date.now() - 60 * 60_000).toISOString();

/** The e2b module surface the v2 adapter's list/release call. */
function fakeE2B(sandboxes: Array<{ sandboxId: string; workspaceId: string; sessionId: string; startedAt: string }>) {
  const killed: string[] = [];
  const sdk = {
    Sandbox: {
      list: () => {
        let served = false;
        return {
          get hasNext() { return !served; },
          async nextItems() {
            served = true;
            return sandboxes.map((s) => ({ sandboxId: s.sandboxId, startedAt: s.startedAt, metadata: { workspaceId: s.workspaceId, sessionId: s.sessionId } }));
          },
        };
      },
      async kill(sandboxId: string) { killed.push(sandboxId); return true; },
    },
  } as unknown as E2BV2Module;
  return { sdk, killed };
}

function e2bEnv(extra: Record<string, unknown> = {}) {
  return { ...env, SANDBOX_ADAPTER: "e2b", E2B_API_KEY: "test-key", E2B_TEMPLATE: "tmpl", E2B_MAX_LIFETIME_MS: "3600000", ...extra } as never;
}

afterEach(() => setCloudflareSandboxForTest(undefined));

describe("Cloudflare sandbox orphan reclaim", () => {
  // The queue table must come from apps/main/migrations: test-worker applies
  // them on the first request. No manual schema setup here on purpose.
  it("reaps queued orphans and resolves them on a database built by the real migrations", async () => {
    await exports.default.fetch(new Request("http://localhost/health"));
    const sql = sqlClientFromD1(env.MAIN_DB);
    const destroyed: string[] = [];
    setCloudflareSandboxForTest({
      async destroy() { destroyed.push("destroy"); },
      async describe() { return { running: true, incarnation: "i", mounts: [] }; },
      async exec() { return { stdout: "", stderr: "", exitCode: 0 }; },
    });
    const unique = crypto.randomUUID();
    await new SqlRuntimeOrphanPort(sql).enqueue({
      scope: { workspaceId: `orphan-ws-${unique}`, environmentId: "env", sessionId: `orphan-sess-${unique}`, workId: "work" },
      generation: 1,
      ownerId: "owner",
      sandbox: { provider: "cloudflare", runtimeId: `orphan-sess-${unique}` },
      reason: "lease_lost",
      error: new Error("release failed"),
    });
    const result = await reclaimCloudflareOrphanSandboxes(env as never, () => undefined);
    expect(result.queue.inspected).toBeGreaterThanOrEqual(1);
    expect(result.queue.resolved).toBe(result.queue.inspected);
    expect(destroyed.length).toBeGreaterThanOrEqual(1);
    expect(await new SqlRuntimeOrphanPort(sql).list({ limit: 100 })).toEqual([]);
  });

  it("SANDBOX_ADAPTER=e2b: releases a labelled sandbox only when its Session is archived", async () => {
    await exports.default.fetch(new Request("http://localhost/health"));
    const tenantId = `orphan-tenant-${crypto.randomUUID()}`;
    const sessions = (await getCfServicesForTenant(env as never, tenantId)).sessions;
    const ended = (await sessions.create({ tenantId, agentId: "agent_orphan", environmentId: "env_orphan" })).session;
    await sessions.archive({ tenantId, sessionId: ended.id });
    const active = (await sessions.create({ tenantId, agentId: "agent_orphan", environmentId: "env_orphan" })).session;
    const e2b = fakeE2B([
      { sandboxId: "sbx-ended", workspaceId: tenantId, sessionId: ended.id, startedAt: HOUR_AGO() },
      { sandboxId: "sbx-active", workspaceId: tenantId, sessionId: active.id, startedAt: HOUR_AGO() },
      { sandboxId: "sbx-unknown", workspaceId: tenantId, sessionId: "sess_not_here", startedAt: HOUR_AGO() },
      { sandboxId: "sbx-young", workspaceId: tenantId, sessionId: ended.id, startedAt: new Date().toISOString() },
    ]);
    const warnings: string[] = [];
    const result = await reclaimCloudflareOrphanSandboxes(e2bEnv(), (m) => { warnings.push(m); }, { e2b: async () => e2b.sdk });
    expect(result.listed).toBe(4);
    expect(result.released).toBe(1);
    expect(e2b.killed).toEqual(["sbx-ended"]);
    expect(warnings).toEqual([]);
  });

  it("SANDBOX_ADAPTER=e2b: a failed Session lookup releases nothing", async () => {
    await exports.default.fetch(new Request("http://localhost/health"));
    const e2b = fakeE2B([{ sandboxId: "sbx-lookup", workspaceId: "ws", sessionId: "sess", startedAt: HOUR_AGO() }]);
    const warnings: string[] = [];
    // The sessions store routed to an unwired backend: every lookup throws.
    const result = await reclaimCloudflareOrphanSandboxes(e2bEnv({ STORE_BACKENDS: '{"sessions":"pg"}' }), (m) => { warnings.push(m); }, { e2b: async () => e2b.sdk });
    expect(result.listed).toBe(1);
    expect(result.released).toBe(0);
    expect(e2b.killed).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^sandbox_orphan_lookup_failed runtime=sbx-lookup /);
  });

  it("the Cloudflare container adapter (fixed handle) lists nothing", async () => {
    await exports.default.fetch(new Request("http://localhost/health"));
    const e2b = fakeE2B([{ sandboxId: "sbx-cf", workspaceId: "ws", sessionId: "sess", startedAt: HOUR_AGO() }]);
    const result = await reclaimCloudflareOrphanSandboxes(env as never, () => undefined, { e2b: async () => e2b.sdk });
    expect(result.listed).toBe(0);
    expect(e2b.killed).toEqual([]);
  });
});
