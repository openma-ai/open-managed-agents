import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { sqlClientFromD1 } from "@open-managed-agents/sql-client/adapters/cf-d1";
import { SqlRuntimeOrphanPort } from "@open-managed-agents/runtime-resource-fence-sql";
import { setCloudflareSandboxForTest } from "../../apps/agent/src/runtime/sandbox";
import { reclaimCloudflareOrphanSandboxes } from "../../apps/agent/src/runtime/sandbox-orphan-reclaim";

// Design §0.0 rule 14 on Cloudflare: the apps/main cron calls the agent
// worker, which drains the MAIN_DB orphan queue with the shared job.

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
});
