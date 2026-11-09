import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { sqlClientFromD1 } from "@open-managed-agents/sql-client/adapters/cf-d1";
import {
  ensureRuntimeOrphanSchema,
  SqlRuntimeOrphanPort,
} from "@open-managed-agents/sandbox-orphan-store-sql";

describe("SqlRuntimeOrphanPort on Cloudflare D1", () => {
  it("persists orphan cleanup work in D1 without the claim token", async () => {
    const sql = sqlClientFromD1(env.MAIN_DB);
    await ensureRuntimeOrphanSchema(sql);
    const unique = crypto.randomUUID();
    const scope = {
      workspaceId: `d1-orphan-workspace-${unique}`,
      environmentId: "d1-orphan-environment",
      sessionId: "d1-orphan-session",
      workId: "d1-orphan-work",
    };
    const orphans = new SqlRuntimeOrphanPort(sql);
    await orphans.enqueue({
      scope,
      generation: 3,
      ownerId: "d1-owner",
      sandbox: { provider: "cloudflare", runtimeId: "d1-runtime" },
      reason: "lease_lost",
      error: new Error("unavailable"),
    });
    const pending = await orphans.list({ limit: 100 });
    const record = pending.find((candidate) => candidate.scope.workspaceId === scope.workspaceId);
    expect(record).toMatchObject({ scope, attempts: 0, lastError: "unavailable" });
    expect(JSON.stringify(record)).not.toContain("token");
    await orphans.resolve({ id: record!.id });
  });
});
