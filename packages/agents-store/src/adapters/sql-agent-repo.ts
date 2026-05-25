import { and, asc, desc, eq, gte, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import {
  asBuilder,
  atomicWrite,
  getAll,
  getOne,
  type OmaDb,
  type OmaDbBuilder,
  runOnce,
} from "@open-managed-agents/db-schema";
import {
  agent_versions,
  agents,
} from "@open-managed-agents/db-schema/cf-auth";
import type {
  AgentConfig,
  PageCursor,
} from "@open-managed-agents/shared";
import {
  escapeLikePattern,
  fetchN,
  trimPage,
} from "@open-managed-agents/shared";
import { AgentNotFoundError } from "../errors";
import type {
  AgentRepo,
  AgentUpdateFields,
  AgentVersionSnapshotInput,
  NewAgentInput,
} from "../ports";
import type { AgentRow, AgentVersionRow } from "../types";


/**
 * Drizzle implementation of {@link AgentRepo}. Owns the SQL against the
 * `agents` and `agent_versions` tables.
 *
 * Backend-agnostic: takes an {@link OmaDb} (Drizzle wrapper around D1 /
 * better-sqlite3 / postgres-js).
 *
 * Atomicity:
 *   - updateWithVersionSnapshot batches the snapshot INSERT and the
 *     current-row UPDATE so they succeed-or-fail together (D1 batch on CF,
 *     transaction on PG).
 *   - deleteWithVersions batches the cascade delete of agent_versions + agents
 *     in the same way.
 */
export class SqlAgentRepo implements AgentRepo {
  private readonly db: OmaDbBuilder;
  constructor(db: OmaDb) {
    this.db = asBuilder(db);
  }

  async insert(input: NewAgentInput): Promise<AgentRow> {
    await runOnce(
      this.db.insert(agents).values({
        id: input.id,
        tenant_id: input.tenantId,
        config: JSON.stringify(input.config),
        version: input.config.version,
        created_at: input.createdAt,
        updated_at: input.createdAt,
      }),
    );
    const row = await this.get(input.tenantId, input.id);
    if (!row) throw new Error("agent vanished after insert");
    return row;
  }

  async get(tenantId: string, agentId: string): Promise<AgentRow | null> {
    const row = await getOne<typeof agents.$inferSelect>(
      this.db
        .select()
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.tenant_id, tenantId))),
    );
    return row ? toRow(row) : null;
  }

  async getById(agentId: string): Promise<AgentRow | null> {
    const row = await getOne<typeof agents.$inferSelect>(
      this.db.select().from(agents).where(eq(agents.id, agentId)),
    );
    return row ? toRow(row) : null;
  }

  async list(
    tenantId: string,
    opts: { includeArchived: boolean },
  ): Promise<AgentRow[]> {
    const conds = [eq(agents.tenant_id, tenantId)];
    if (!opts.includeArchived) conds.push(isNull(agents.archived_at));
    const rows = await getAll<typeof agents.$inferSelect>(
      this.db
        .select()
        .from(agents)
        .where(and(...conds))
        .orderBy(asc(agents.created_at)),
    );
    return rows.map(toRow);
  }

  async listPage(
    tenantId: string,
    opts: {
      status?: "active" | "archived" | "any";
      createdAfter?: number;
      createdBefore?: number;
      limit: number;
      after?: PageCursor;
      q?: string;
    },
  ): Promise<{ items: AgentRow[]; hasMore: boolean }> {
    const conds = [eq(agents.tenant_id, tenantId)];
    // status: default "any" — caller has to opt in to a narrow row set.
    // Mirrors the legacy includeArchived=true default; callers that
    // genuinely want "exclude archived" pass "active" explicitly.
    if (opts.status === "active") conds.push(isNull(agents.archived_at));
    else if (opts.status === "archived") conds.push(isNotNull(agents.archived_at));
    if (opts.createdAfter !== undefined)
      conds.push(gte(agents.created_at, opts.createdAfter));
    if (opts.createdBefore !== undefined)
      conds.push(lt(agents.created_at, opts.createdBefore));
    if (opts.q) {
      // agents.name lives in the JSON config blob, so the q-filter has to
      // pull it out via json_extract. SQLite's LIKE is ASCII-case-insensitive
      // by default; we explicitly bind ESCAPE '\' so a user-supplied `%`/`_`
      // is literal, not a wildcard. See escapeLikePattern.
      // TODO: PG path needs json_extract → ->> rewrite (json_extract is SQLite-only).
      const pattern = `%${escapeLikePattern(opts.q)}%`;
      conds.push(
        sql`json_extract(${agents.config}, '$.name') LIKE ${pattern} ESCAPE '\\'`,
      );
    }
    if (opts.after) {
      // (created_at, id) DESC composite cursor: created_at < c, OR same created_at AND id < c.
      const c = opts.after;
      conds.push(
        or(
          lt(agents.created_at, c.createdAt),
          and(eq(agents.created_at, c.createdAt), lt(agents.id, c.id))!,
        )!,
      );
    }
    const rows = await getAll<typeof agents.$inferSelect>(
      this.db
        .select()
        .from(agents)
        .where(and(...conds))
        .orderBy(desc(agents.created_at), desc(agents.id))
        .limit(fetchN(opts.limit)),
    );
    return trimPage(rows.map(toRow), opts.limit);
  }

  async count(
    tenantId: string,
    opts: { includeArchived: boolean },
  ): Promise<number> {
    const conds = [eq(agents.tenant_id, tenantId)];
    if (!opts.includeArchived) conds.push(isNull(agents.archived_at));
    const row = await getOne<{ c: number }>(
      this.db
        .select({ c: sql<number>`COUNT(*)` })
        .from(agents)
        .where(and(...conds)),
    );
    return row?.c ?? 0;
  }

  async updateWithVersionSnapshot(
    tenantId: string,
    agentId: string,
    update: AgentUpdateFields,
    priorSnapshot: AgentVersionSnapshotInput,
  ): Promise<AgentRow> {
    // Two-statement batch: write the prior snapshot to history then bump the
    // current row. Atomic on D1 batch / PG transaction. No FK needed.
    const insertSnapshotQ = this.db.insert(agent_versions).values({
      agent_id: priorSnapshot.agentId,
      tenant_id: priorSnapshot.tenantId,
      version: priorSnapshot.version,
      snapshot: JSON.stringify(priorSnapshot.snapshot),
      created_at: priorSnapshot.createdAt,
    });
    const updateAgentQ = this.db
      .update(agents)
      .set({
        config: JSON.stringify(update.config),
        version: update.version,
        updated_at: update.updatedAt,
      })
      .where(and(eq(agents.id, agentId), eq(agents.tenant_id, tenantId)));

    await atomicWrite(this.db, [insertSnapshotQ, updateAgentQ]);

    // Verify the UPDATE actually hit a row. We re-read instead of inspecting
    // the batch result (D1 surfaces meta.changes per-statement, but PG's
    // transaction return shape is different). One extra round-trip in the
    // success path; keeps the dialect fork small.
    const row = await this.get(tenantId, agentId);
    if (!row) throw new AgentNotFoundError();
    return row;
  }

  async archive(
    tenantId: string,
    agentId: string,
    archivedAt: number,
  ): Promise<AgentRow> {
    // Read the existing config so we can bump archived_at inside the JSON
    // alongside the column for round-trip consistency with consumers that
    // read straight from the parsed config (e.g. SessionDO snapshot fallback).
    const existing = await this.get(tenantId, agentId);
    if (!existing) throw new AgentNotFoundError();
    const nextConfig: AgentConfig = {
      ...stripTenantId(existing),
      archived_at: msToIso(archivedAt),
    };
    await runOnce(
      this.db
        .update(agents)
        .set({
          archived_at: archivedAt,
          updated_at: archivedAt,
          config: JSON.stringify(nextConfig),
        })
        .where(and(eq(agents.id, agentId), eq(agents.tenant_id, tenantId))),
    );
    const row = await this.get(tenantId, agentId);
    if (!row) throw new AgentNotFoundError();
    return row;
  }

  async deleteWithVersions(tenantId: string, agentId: string): Promise<void> {
    // Two-statement batch: drop history rows first then the agent row.
    const deleteVersionsQ = this.db
      .delete(agent_versions)
      .where(eq(agent_versions.agent_id, agentId));
    const deleteAgentQ = this.db
      .delete(agents)
      .where(and(eq(agents.id, agentId), eq(agents.tenant_id, tenantId)));
    await atomicWrite(this.db, [deleteVersionsQ, deleteAgentQ]);
  }

  async listVersions(
    tenantId: string,
    agentId: string,
  ): Promise<AgentVersionRow[]> {
    const rows = await getAll<typeof agent_versions.$inferSelect>(
      this.db
        .select()
        .from(agent_versions)
        .where(
          and(
            eq(agent_versions.agent_id, agentId),
            eq(agent_versions.tenant_id, tenantId),
          ),
        )
        .orderBy(asc(agent_versions.version)),
    );
    return rows.map(toVersionRow);
  }

  async getVersion(
    tenantId: string,
    agentId: string,
    version: number,
  ): Promise<AgentVersionRow | null> {
    const row = await getOne<typeof agent_versions.$inferSelect>(
      this.db
        .select()
        .from(agent_versions)
        .where(
          and(
            eq(agent_versions.agent_id, agentId),
            eq(agent_versions.tenant_id, tenantId),
            eq(agent_versions.version, version),
          ),
        ),
    );
    return row ? toVersionRow(row) : null;
  }
}

function toRow(r: typeof agents.$inferSelect): AgentRow {
  const cfg = JSON.parse(r.config) as AgentConfig;
  // Surface the mutable state from the columns into the AgentRow result so
  // the JSON blob and the columns stay consistent (insert + update keep them
  // in sync, but archive_at via the column path is the canonical one).
  return {
    ...cfg,
    tenant_id: r.tenant_id,
    version: r.version,
    created_at: msToIso(r.created_at),
    updated_at: r.updated_at !== null ? msToIso(r.updated_at) : undefined,
    archived_at: r.archived_at !== null ? msToIso(r.archived_at) : undefined,
  };
}

function toVersionRow(r: typeof agent_versions.$inferSelect): AgentVersionRow {
  return {
    agent_id: r.agent_id,
    tenant_id: r.tenant_id,
    version: r.version,
    snapshot: JSON.parse(r.snapshot) as AgentConfig,
    created_at: msToIso(r.created_at),
  };
}

function stripTenantId(row: AgentRow): AgentConfig {
  const { tenant_id: _t, ...rest } = row;
  return rest;
}

function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}
