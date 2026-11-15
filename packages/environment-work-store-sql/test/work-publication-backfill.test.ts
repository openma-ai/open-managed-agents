import { describe, expect, it } from "vitest";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import { backfillWorkPublications } from "../src/work-publication-backfill";

async function fixture() {
  const source = await createBetterSqlite3SqlClient(":memory:");
  const shards = await Promise.all([0, 1].map(() => createBetterSqlite3SqlClient(":memory:")));
  await source.exec("CREATE TABLE runtime_resource_fences (scope_key text PRIMARY KEY, workspace_id text, environment_id text, session_id text, work_id text, publication_json text, publication_generation integer, revision integer)");
  for (let i = 0; i < shards.length; i++) {
    await shards[i]!.exec("CREATE TABLE managed_environment_work (workspace_id text, environment_id text, session_id text, id text, runtime_publication_json text)");
    await shards[i]!.prepare("INSERT INTO managed_environment_work VALUES (?, 'env', 'sess', 'work', NULL)").bind("ws-" + i).run();
    await source.prepare("INSERT INTO runtime_resource_fences VALUES (?, ?, 'env', 'sess', 'work', ?, 3, 7)").bind("scope-" + i, "ws-" + i, JSON.stringify({ workspaceCandidate: { id: "snapshot-" + i } })).run();
  }
  return { source, shards, target: (workspace: string) => shards[Number(workspace.slice(3))]! };
}

describe("legacy Work publications across tenant shards", () => {
  it("copies each MAIN_DB publication into its routed shard and verifies all rows before retiring the source", async () => {
    const f = await fixture();
    expect(await backfillWorkPublications(f.source, f.target)).toEqual({ copied: 2, verified: 2 });
    for (let i = 0; i < 2; i++) {
      const row = await f.shards[i]!.prepare("SELECT runtime_publication_json FROM managed_environment_work").first<{ runtime_publication_json: string }>();
      expect(JSON.parse(row!.runtime_publication_json)).toEqual({ workspaceCandidate: { id: "snapshot-" + i }, generation: 3, revision: 7 });
    }
    expect((await f.source.prepare("SELECT count(*) AS n FROM runtime_resource_fences WHERE publication_json IS NOT NULL").first<{ n: number }>())!.n).toBe(0);
  });
  it("a missing Work preserves every source publication and reports incomplete coverage", async () => {
    const f = await fixture();
    await f.shards[1]!.exec("DELETE FROM managed_environment_work");
    await expect(backfillWorkPublications(f.source, f.target)).rejects.toThrow(/coverage/);
    expect((await f.source.prepare("SELECT count(*) AS n FROM runtime_resource_fences WHERE publication_json IS NOT NULL").first<{ n: number }>())!.n).toBe(2);
  });
  it("a conflicting target preserves all source rows and can resume after operator repair", async () => {
    const f = await fixture();
    await f.shards[1]!.exec("UPDATE managed_environment_work SET runtime_publication_json = '{}'");
    await expect(backfillWorkPublications(f.source, f.target)).rejects.toThrow(/coverage/);
    expect((await f.source.prepare("SELECT count(*) AS n FROM runtime_resource_fences WHERE publication_json IS NOT NULL").first<{ n: number }>())!.n).toBe(2);
    await f.shards[1]!.exec("UPDATE managed_environment_work SET runtime_publication_json = NULL");
    expect(await backfillWorkPublications(f.source, f.target)).toEqual({ copied: 1, verified: 2 });
    expect(await backfillWorkPublications(f.source, f.target)).toEqual({ copied: 0, verified: 0 });
  });

  it("a routing failure never retires a source publication", async () => {
    const f = await fixture();
    await expect(backfillWorkPublications(f.source, async () => { throw new Error("shard unavailable"); })).rejects.toThrow("shard unavailable");
    expect((await f.source.prepare("SELECT count(*) AS n FROM runtime_resource_fences WHERE publication_json IS NOT NULL").first<{ n: number }>())!.n).toBe(2);
  });
});
