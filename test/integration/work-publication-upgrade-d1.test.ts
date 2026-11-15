// @ts-nocheck
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { sqlClientFromD1 } from "../../packages/sql-client/src/adapters/cf-d1";
import { backfillWorkPublications } from "../../packages/environment-work-store-sql/src/work-publication-backfill";
import retirement from "../../apps/main/migrations/0030_retire_resource_fences.sql?raw";

it("D1 multi-shard upgrade refuses retirement until every routed publication is verified", async () => {
  const source = sqlClientFromD1(env.WORK_UPGRADE_SOURCE);
  const shards = [env.WORK_UPGRADE_A, env.WORK_UPGRADE_B].map(sqlClientFromD1);
  await source.exec("CREATE TABLE runtime_resource_fences (scope_key text PRIMARY KEY, workspace_id text, environment_id text, session_id text, work_id text, publication_json text, publication_generation integer, revision integer)");
  for (let i = 0; i < 2; i++) {
    await shards[i].exec("CREATE TABLE managed_environment_work (workspace_id text, environment_id text, session_id text, id text, runtime_publication_json text)");
    await source.prepare("INSERT INTO runtime_resource_fences VALUES (?, ?, 'env', 'session', 'work', ?, 3, 7)").bind(`scope-${i}`, `ws-${i}`, JSON.stringify({ workspaceCandidate: { id: `snapshot-${i}` } })).run();
  }
  const retire = async () => {
    for (const sql of retirement.split("--> statement-breakpoint").map(s => s.trim()).filter(Boolean)) await source.prepare(sql).run();
  };
  await expect(retire()).rejects.toThrow();
  const target = workspace => shards[Number(workspace.slice(3))];
  await shards[0].exec("INSERT INTO managed_environment_work VALUES ('ws-0', 'env', 'session', 'work', NULL)");
  await expect(backfillWorkPublications(source, target)).rejects.toThrow(/coverage/);
  expect((await source.prepare("SELECT count(*) AS n FROM runtime_resource_fences WHERE publication_json IS NOT NULL").first()).n).toBe(2);
  await shards[1].exec("INSERT INTO managed_environment_work VALUES ('ws-1', 'env', 'session', 'work', NULL)");
  expect(await backfillWorkPublications(source, target)).toEqual({ copied: 1, verified: 2 });
  for (let i = 0; i < 2; i++) {
    const row = await shards[i].prepare("SELECT runtime_publication_json FROM managed_environment_work").first();
    expect(JSON.parse(row.runtime_publication_json)).toEqual({ workspaceCandidate: { id: `snapshot-${i}` }, generation: 3, revision: 7 });
  }
  await retire();
  expect(await source.prepare("SELECT name FROM sqlite_master WHERE name = 'runtime_resource_fences'").first()).toBeNull();
});
