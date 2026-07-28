import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  asBuilder,
  getAll,
  getOne,
  type OmaDb,
  type OmaDbBuilder,
  runOnce,
} from "@open-managed-agents/db-schema";
import { eval_runs } from "@open-managed-agents/db-schema/cf-auth";
import { EvalRunNotFoundError } from "../errors";
import type {
  EvalRunListOptions,
  EvalRunRepo,
  EvalRunUpdateFields,
  NewEvalRunInput,
} from "../ports";
import type { EvalRunRow, EvalRunStatus } from "../types";


/**
 * Drizzle implementation of {@link EvalRunRepo}. Owns the queries against
 * the `eval_runs` table defined in apps/main/migrations/0012_eval_runs_table.sql.
 *
 * Atomicity:
 *   - insert is a single INSERT — replaces the two-put non-atomic KV pattern
 *     in evals.ts:114-118 (eval-run record + active-index were separate puts).
 *   - delete and deleteByAgent are single DELETE statements; no resources to
 *     cascade (trajectory blobs live in CONFIG_KV under their own keys).
 */
export class SqlEvalRunRepo implements EvalRunRepo {
  private readonly db: OmaDbBuilder;
  constructor(db: OmaDb) {
    this.db = asBuilder(db);
  }

  async insert(input: NewEvalRunInput): Promise<EvalRunRow> {
    await runOnce(
      this.db.insert(eval_runs).values({
        id: input.id,
        tenant_id: input.tenantId,
        agent_id: input.agentId,
        environment_id: input.environmentId,
        suite: input.suite,
        status: input.status,
        started_at: input.startedAt,
        completed_at: null,
        results:
          input.results !== null && input.results !== undefined
            ? JSON.stringify(input.results)
            : null,
        score: input.score,
        error: input.error,
      }),
    );
    const row = await this.get(input.tenantId, input.id);
    if (!row) throw new Error("eval_run vanished after insert");
    return row;
  }

  async get(tenantId: string, runId: string): Promise<EvalRunRow | null> {
    const row = await getOne<typeof eval_runs.$inferSelect>(
      this.db
        .select()
        .from(eval_runs)
        .where(and(eq(eval_runs.id, runId), eq(eval_runs.tenant_id, tenantId))),
    );
    return row ? toRow(row) : null;
  }

  async getById(runId: string): Promise<EvalRunRow | null> {
    const row = await getOne<typeof eval_runs.$inferSelect>(
      this.db
        .select()
        .from(eval_runs)
        .where(eq(eval_runs.id, runId)),
    );
    return row ? toRow(row) : null;
  }

  async list(tenantId: string, opts: EvalRunListOptions): Promise<EvalRunRow[]> {
    const conds = [eq(eval_runs.tenant_id, tenantId)];
    if (opts.agentId) conds.push(eq(eval_runs.agent_id, opts.agentId));
    if (opts.environmentId) {
      conds.push(eq(eval_runs.environment_id, opts.environmentId));
    }
    if (opts.status) conds.push(eq(eval_runs.status, opts.status));
    const order =
      opts.order === "asc" ? asc(eval_runs.started_at) : desc(eval_runs.started_at);
    const rows = await getAll<typeof eval_runs.$inferSelect>(
      this.db
        .select()
        .from(eval_runs)
        .where(and(...conds))
        .orderBy(order)
        .limit(opts.limit),
    );
    return rows.map(toRow);
  }

  async listActive(): Promise<EvalRunRow[]> {
    const rows = await getAll<typeof eval_runs.$inferSelect>(
      this.db
        .select()
        .from(eval_runs)
        .where(inArray(eval_runs.status, ["pending", "running"]))
        .orderBy(asc(eval_runs.started_at)),
    );
    return rows.map(toRow);
  }

  async hasActiveByAgent(tenantId: string, agentId: string): Promise<boolean> {
    const row = await getOne<{ one: number }>(
      this.db
        .select({ one: sql<number>`1` })
        .from(eval_runs)
        .where(
          and(
            eq(eval_runs.tenant_id, tenantId),
            eq(eval_runs.agent_id, agentId),
            inArray(eval_runs.status, ["pending", "running"]),
          ),
        )
        .limit(1),
    );
    return !!row;
  }

  async hasActiveByEnvironment(
    tenantId: string,
    environmentId: string,
  ): Promise<boolean> {
    const row = await getOne<{ one: number }>(
      this.db
        .select({ one: sql<number>`1` })
        .from(eval_runs)
        .where(
          and(
            eq(eval_runs.tenant_id, tenantId),
            eq(eval_runs.environment_id, environmentId),
            inArray(eval_runs.status, ["pending", "running"]),
          ),
        )
        .limit(1),
    );
    return !!row;
  }

  async update(
    tenantId: string,
    runId: string,
    fields: EvalRunUpdateFields,
  ): Promise<EvalRunRow> {
    // Pre-check existence — Drizzle's run() result shape is dialect-specific,
    // so we read first to throw a domain error if the row is missing.
    const existing = await this.get(tenantId, runId);
    if (!existing) throw new EvalRunNotFoundError();

    const set: Record<string, unknown> = {};
    if (fields.status !== undefined) set.status = fields.status;
    if (fields.results !== undefined) {
      set.results = fields.results !== null ? JSON.stringify(fields.results) : null;
    }
    if (fields.score !== undefined) set.score = fields.score;
    if (fields.error !== undefined) set.error = fields.error;
    if (fields.completedAt !== undefined) set.completed_at = fields.completedAt;
    if (Object.keys(set).length === 0) {
      // Nothing to update — short-circuit and return the row as-is.
      return existing;
    }
    await runOnce(
      this.db
        .update(eval_runs)
        .set(set)
        .where(and(eq(eval_runs.id, runId), eq(eval_runs.tenant_id, tenantId))),
    );
    const row = await this.get(tenantId, runId);
    if (!row) throw new EvalRunNotFoundError();
    return row;
  }

  async delete(tenantId: string, runId: string): Promise<void> {
    await runOnce(
      this.db
        .delete(eval_runs)
        .where(and(eq(eval_runs.id, runId), eq(eval_runs.tenant_id, tenantId))),
    );
  }

  async deleteByAgent(tenantId: string, agentId: string): Promise<number> {
    // Drizzle's run() shape is dialect-specific — count via SELECT first so
    // the return value is portable across SQLite (D1, better-sqlite3) and PG.
    const matched = await getAll<{ id: string }>(
      this.db
        .select({ id: eval_runs.id })
        .from(eval_runs)
        .where(
          and(
            eq(eval_runs.tenant_id, tenantId),
            eq(eval_runs.agent_id, agentId),
          ),
        ),
    );
    if (!matched.length) return 0;
    await runOnce(
      this.db
        .delete(eval_runs)
        .where(
          and(
            eq(eval_runs.tenant_id, tenantId),
            eq(eval_runs.agent_id, agentId),
          ),
        ),
    );
    return matched.length;
  }
}

function toRow(r: typeof eval_runs.$inferSelect): EvalRunRow {
  return {
    id: r.id,
    tenant_id: r.tenant_id,
    agent_id: r.agent_id,
    environment_id: r.environment_id,
    suite: r.suite,
    status: r.status as EvalRunStatus,
    started_at: msToIso(r.started_at),
    completed_at: r.completed_at !== null ? msToIso(r.completed_at) : null,
    results: r.results !== null ? (JSON.parse(r.results) as unknown) : null,
    score: r.score,
    error: r.error,
  };
}

function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}
