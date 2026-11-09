import { expect, it } from "vitest";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { SqlEvalRunRepo } from "../../../packages/evals-store/src/adapters/sql-eval-run-repo";

// PG bigint driver values are decimal strings; SQLite emits numbers. Exercise
// real Drizzle row mapping + the public repo, not a duplicate date helper.
it.each([1794255109719, "1794255109719"])("normalizes driver millisecond value %s", async started => {
  const db = drizzle(async () => ({ rows: ["run", "tenant", "agent", "env", "suite", "completed", started, started, null, null, null] }));
  const row = await new SqlEvalRunRepo(db).get("tenant", "run");
  expect(row?.started_at).toBe("2026-11-09T20:11:49.719Z");
  expect(row?.completed_at).toBe("2026-11-09T20:11:49.719Z");
});
