import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBetterSqlite3SqlClient, type SqlClient, type SqlStatement } from "@open-managed-agents/sql-client";
import { ensureSessionExecutionCoordinatorSchema, SqlSessionExecutionStore } from "../src/coordination";

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

it("rechecks Session occupancy when a stale lane candidate reads the mutex version after another claim commits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openma-serial-candidate-"));
  directories.push(directory);
  const path = join(directory, "shared.sqlite");
  const firstSql = await createBetterSqlite3SqlClient(path);
  const secondSql = await createBetterSqlite3SqlClient(path);
  await ensureSessionExecutionCoordinatorSchema(firstSql);
  const selected = barrier();
  const continueClaim = barrier();
  let paused = false;
  const delayed: SqlClient = {
    exec: query => secondSql.exec(query),
    batch: statements => secondSql.batch(statements),
    prepare: query => {
      const statement = secondSql.prepare(query);
      if (!query.includes("SELECT candidate.workspace_id")) return statement;
      function wrap(bound: SqlStatement): SqlStatement {
        return {
          bind: (...parameters) => wrap(bound.bind(...parameters)),
          run: () => bound.run(), all: () => bound.all(),
          first: async <T>() => {
            const row = await bound.first<T>();
            if (!paused) {
              paused = true;
              selected.resolve();
              await continueClaim.promise;
            }
            return row;
          },
        };
      }
      return wrap(statement);
    },
  };
  const first = new SqlSessionExecutionStore(firstSql, { serializeSessionClaims: true });
  const second = new SqlSessionExecutionStore(delayed, { serializeSessionClaims: true });
  const scope = { workspaceId: "w", sessionId: "s" };
  const now = "2026-11-05T00:00:00.000Z";
  for (const id of ["a", "b"]) {
    await first.admit({ execution: { ...scope, id, laneId: id, admittedAt: now,
      events: [{ id, type: "user.message", processedAt: null, content: [{ type: "text", text: id }] }],
    } });
  }
  const input = (id: string) => ({ ...scope, laneId: id, ownerId: id, attemptId: id, claimedAt: now, leaseTtlMs: 30_000 });
  // B has already observed no running peer. Pause before claimSerial's mutex
  // version read, then let A fully commit on another database connection.
  const pendingSecond = second.claim(input("b"));
  await selected.promise;
  const firstClaim = await first.claim(input("a"));
  continueClaim.resolve();
  expect(firstClaim.type).toBe("claimed");
  expect(await pendingSecond).toEqual({ type: "empty" });
  expect((await first.listActive(scope)).map(row => ({ id: row.id, state: row.state, attempts: row.attemptCount })))
    .toEqual([{ id: "a", state: "running", attempts: 1 }, { id: "b", state: "queued", attempts: 0 }]);
  // The failed contender did not consume B or poison the Session mutex.
  if (firstClaim.type !== "claimed") throw new Error("expected A claim");
  await first.settle({ fence: firstClaim.fence, settledAt: now, outcome: "completed" });
  expect(await second.claim(input("b"))).toMatchObject({ type: "claimed", execution: { id: "b", attemptCount: 1 } });
});
