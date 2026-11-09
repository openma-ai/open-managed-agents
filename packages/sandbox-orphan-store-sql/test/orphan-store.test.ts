import { describe, expect, it, vi } from "vitest";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";

import {
  ensureRuntimeOrphanSchema,
  runtimeOrphanSqlSchema,
  SqlRuntimeOrphanPort,
} from "../src/index";

const scope = {
  workspaceId: "workspace_1",
  environmentId: "environment_1",
  sessionId: "session_1",
  workId: "work_1",
};

function scriptedSql(options: { all?: unknown[]; resultsUndefined?: boolean } = {}) {
  const all = [...(options.all ?? [])];
  return {
    prepare: vi.fn(() => {
      const statement: any = {
        bind: vi.fn(() => statement),
        first: vi.fn(async () => null),
        all: vi.fn(async () => options.resultsUndefined
          ? {}
          : { results: (all.shift() as unknown[] | undefined) ?? [] }),
        run: vi.fn(async () => ({ meta: { changes: 1 } })),
      };
      return statement;
    }),
    batch: vi.fn(async () => []),
    exec: vi.fn(async () => undefined),
  } as any;
}

describe("SqlRuntimeOrphanPort", () => {
  it("installs only the orphan queue", async () => {
    expect(runtimeOrphanSqlSchema).toContain("runtime_resource_orphans");
    expect(runtimeOrphanSqlSchema).not.toContain("runtime_resource_fences");
    const sql = await createBetterSqlite3SqlClient(":memory:");
    await ensureRuntimeOrphanSchema(sql);
    await ensureRuntimeOrphanSchema(sql);
    const tables = await sql.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all<{ name: string }>();
    expect(tables.results?.map((table) => table.name)).toEqual(["runtime_resource_orphans"]);
  });

  it("persists idempotent orphan cleanup work without credentials", async () => {
    const sql = await createBetterSqlite3SqlClient(":memory:");
    await ensureRuntimeOrphanSchema(sql);
    const orphans = new SqlRuntimeOrphanPort(sql);
    const input = {
      scope,
      generation: 4,
      ownerId: "owner_orphan",
      sandbox: {
        provider: "docker",
        runtimeId: "container_orphan",
        metadata: { region: "local", zones: ["a", "b"] },
      },
      reason: "lease_lost" as const,
      error: new Error("docker unavailable"),
    };

    await orphans.enqueue(input);
    await orphans.enqueue(input);
    await expect(orphans.list({ limit: 0 })).rejects.toThrow(
      "Runtime orphan list limit must be a positive integer",
    );
    const pending = await orphans.list({ limit: 10 });
    expect(pending).toEqual([
      expect.objectContaining({
        scope,
        generation: 4,
        ownerId: "owner_orphan",
        sandbox: input.sandbox,
        reason: "lease_lost",
        attempts: 0,
        lastError: "docker unavailable",
      }),
    ]);
    expect(JSON.stringify(pending)).not.toContain("token");

    await orphans.failed({ id: pending[0]!.id, error: new Error("still unavailable") });
    await expect(orphans.list({ limit: 10 })).resolves.toEqual([
      expect.objectContaining({ attempts: 1, lastError: "still unavailable" }),
    ]);
    await orphans.resolve({ id: pending[0]!.id });
    await orphans.resolve({ id: pending[0]!.id });
    await expect(orphans.list({ limit: 10 })).resolves.toEqual([]);
  });
});

describe("SQL runtime orphan persisted-state boundaries", () => {
  const validRow = {
    id: "orphan",
    workspace_id: scope.workspaceId,
    environment_id: scope.environmentId,
    session_id: scope.sessionId,
    work_id: scope.workId,
    generation: "1",
    owner_id: "owner",
    sandbox_json: JSON.stringify({ provider: "docker", runtimeId: "runtime" }),
    reason: "failed",
    attempts: "0",
    last_error: "failed",
  };

  it("supports SQL drivers that omit an empty results array", async () => {
    const port = new SqlRuntimeOrphanPort(scriptedSql({ resultsUndefined: true }));
    await expect(port.list({ limit: 10 })).resolves.toEqual([]);
  });

  it("accepts safe integer strings from SQL drivers", async () => {
    const port = new SqlRuntimeOrphanPort(scriptedSql({ all: [[validRow]] }));
    await expect(port.list({ limit: 10 })).resolves.toEqual([
      expect.objectContaining({ generation: 1, attempts: 0 }),
    ]);
  });

  it.each([
    [{ ...validRow, sandbox_json: JSON.stringify({ provider: "", runtimeId: "runtime" }) }, /invalid sandbox lease/i],
    [{ ...validRow, sandbox_json: JSON.stringify({ provider: "docker", runtimeId: "" }) }, /invalid sandbox lease/i],
    [{ ...validRow, sandbox_json: JSON.stringify(null) }, /invalid sandbox lease/i],
    [{ ...validRow, reason: "unknown" }, /invalid cleanup reason/i],
    [{ ...validRow, generation: "not-a-number" }, /invalid orphan generation/i],
  ])("fails closed on corrupt persisted orphan rows", async (row, expected) => {
    const port = new SqlRuntimeOrphanPort(scriptedSql({ all: [[row]] }));
    await expect(port.list({ limit: 10 })).rejects.toThrow(expected);
  });

  it("normalizes non-Error cleanup diagnostics", async () => {
    const sql = scriptedSql();
    const port = new SqlRuntimeOrphanPort(sql);
    await port.enqueue({
      scope,
      generation: 1,
      ownerId: "owner",
      sandbox: { provider: "docker", runtimeId: "runtime" },
      reason: "failed",
      error: { code: "ECONNRESET" },
    });
    const statement = sql.prepare.mock.results[0]!.value;
    expect(statement.bind).toHaveBeenCalledWith(
      expect.any(String),
      scope.workspaceId,
      scope.environmentId,
      scope.sessionId,
      scope.workId,
      1,
      "owner",
      expect.any(String),
      "failed",
      "[object Object]",
    );
  });
});
