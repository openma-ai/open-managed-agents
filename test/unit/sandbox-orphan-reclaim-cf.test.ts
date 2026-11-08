import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { sqlClientFromD1 } from "@open-managed-agents/sql-client/adapters/cf-d1";
import { ensureRuntimeResourceFenceSchema, SqlRuntimeOrphanPort } from "@open-managed-agents/runtime-resource-fence-sql";
import { setCloudflareSandboxForTest } from "../../apps/agent/src/runtime/sandbox";
import { reclaimCloudflareOrphanSandboxes } from "../../apps/agent/src/runtime/sandbox-orphan-reclaim";

// Design §0.0 rule 14 on Cloudflare: the apps/main cron calls the agent
// worker, which drains the MAIN_DB orphan queue with the shared job.

afterEach(() => setCloudflareSandboxForTest(undefined));

describe("Cloudflare sandbox orphan reclaim", () => {
  it("reaps queued orphans and resolves them", async () => {
    const sql = sqlClientFromD1(env.MAIN_DB);
    await ensureRuntimeResourceFenceSchema(sql);
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
});
