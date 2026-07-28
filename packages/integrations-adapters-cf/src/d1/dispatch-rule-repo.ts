import { and, asc, desc, eq, isNull, lte, or, sql } from "drizzle-orm";
import {
  asBuilder,
  getAll,
  getOne,
  type OmaDb,
  type OmaDbBuilder,
  runOnce,
} from "@open-managed-agents/db-schema";
import { linear_dispatch_rules } from "@open-managed-agents/db-schema/cf-integrations";
import type {
  DispatchRule,
  DispatchRulePatch,
  DispatchRuleRepo,
  IdGenerator,
  NewDispatchRule,
} from "@open-managed-agents/integrations-core";

/**
 * SQL dispatch-rule repo for Linear. Targets `linear_dispatch_rules`. Carries
 * the autopilot rule rows the sweep cron rotates through.
 */
export class SqlLinearDispatchRuleRepo implements DispatchRuleRepo {
  private readonly db: OmaDbBuilder;
  constructor(
    db: OmaDb,
    private readonly ids: IdGenerator,
  ) {
    this.db = asBuilder(db);
  }

  async get(id: string): Promise<DispatchRule | null> {
    const row = await getOne<typeof linear_dispatch_rules.$inferSelect>(
      this.db
        .select()
        .from(linear_dispatch_rules)
        .where(eq(linear_dispatch_rules.id, id)),
    );
    return row ? this.toDomain(row) : null;
  }

  async insert(input: NewDispatchRule): Promise<DispatchRule> {
    const id = this.ids.generate();
    const now = Date.now();
    await runOnce(
      this.db.insert(linear_dispatch_rules).values({
        id,
        tenant_id: input.tenantId,
        publication_id: input.publicationId,
        name: input.name,
        enabled: input.enabled ? 1 : 0,
        filter_label: input.filterLabel,
        filter_states: input.filterStates ? JSON.stringify(input.filterStates) : null,
        filter_project_id: input.filterProjectId,
        max_concurrent: input.maxConcurrent,
        poll_interval_seconds: input.pollIntervalSeconds,
        last_polled_at: null,
        created_at: now,
        updated_at: now,
      }),
    );
    return {
      id,
      tenantId: input.tenantId,
      publicationId: input.publicationId,
      name: input.name,
      enabled: input.enabled,
      filterLabel: input.filterLabel,
      filterStates: input.filterStates,
      filterProjectId: input.filterProjectId,
      maxConcurrent: input.maxConcurrent,
      pollIntervalSeconds: input.pollIntervalSeconds,
      lastPolledAt: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  async update(id: string, patch: DispatchRulePatch): Promise<DispatchRule | null> {
    // Build dynamic SET object from only the supplied fields. Avoids stomping
    // columns the caller didn't intend to change (especially enabled=false
    // when a partial update doesn't pass it).
    const updates: Record<string, unknown> = {};
    if (patch.name !== undefined) updates.name = patch.name;
    if (patch.enabled !== undefined) updates.enabled = patch.enabled ? 1 : 0;
    if (patch.filterLabel !== undefined) updates.filter_label = patch.filterLabel;
    if (patch.filterStates !== undefined) {
      updates.filter_states = patch.filterStates ? JSON.stringify(patch.filterStates) : null;
    }
    if (patch.filterProjectId !== undefined) updates.filter_project_id = patch.filterProjectId;
    if (patch.maxConcurrent !== undefined) updates.max_concurrent = patch.maxConcurrent;
    if (patch.pollIntervalSeconds !== undefined) {
      updates.poll_interval_seconds = patch.pollIntervalSeconds;
    }
    if (Object.keys(updates).length === 0) return this.get(id);
    updates.updated_at = Date.now();
    await runOnce(
      this.db
        .update(linear_dispatch_rules)
        .set(updates)
        .where(eq(linear_dispatch_rules.id, id)),
    );
    return this.get(id);
  }

  async delete(id: string): Promise<boolean> {
    // .returning() + getOne lets us tell whether any row was deleted —
    // dialect-agnostic replacement for the previous D1 meta.changes path.
    const deleted = await getOne<{ id: string }>(
      this.db
        .delete(linear_dispatch_rules)
        .where(eq(linear_dispatch_rules.id, id))
        .returning({ id: linear_dispatch_rules.id }),
    );
    return deleted !== null;
  }

  async listByPublication(publicationId: string): Promise<readonly DispatchRule[]> {
    const rows = await getAll<typeof linear_dispatch_rules.$inferSelect>(
      this.db
        .select()
        .from(linear_dispatch_rules)
        .where(eq(linear_dispatch_rules.publication_id, publicationId))
        .orderBy(desc(linear_dispatch_rules.created_at)),
    );
    return rows.map((r) => this.toDomain(r));
  }

  /**
   * Hot path. Filter `enabled = 1` first (cheap, indexed), then "due" check
   * is `last_polled_at IS NULL OR last_polled_at + interval*1000 <= nowMs`.
   * SQLite handles the per-row arithmetic; no precomputed column needed at
   * this scale.
   */
  async listDueForSweep(nowMs: number, limit: number): Promise<readonly DispatchRule[]> {
    const rows = await getAll<typeof linear_dispatch_rules.$inferSelect>(
      this.db
        .select()
        .from(linear_dispatch_rules)
        .where(
          and(
            eq(linear_dispatch_rules.enabled, 1),
            or(
              isNull(linear_dispatch_rules.last_polled_at),
              lte(
                sql`${linear_dispatch_rules.last_polled_at} + (${linear_dispatch_rules.poll_interval_seconds} * 1000)`,
                nowMs,
              ),
            ),
          ),
        )
        .orderBy(asc(sql`COALESCE(${linear_dispatch_rules.last_polled_at}, 0)`))
        .limit(limit),
    );
    return rows.map((r) => this.toDomain(r));
  }

  async markPolled(id: string, polledAtMs: number): Promise<void> {
    await runOnce(
      this.db
        .update(linear_dispatch_rules)
        .set({ last_polled_at: polledAtMs })
        .where(eq(linear_dispatch_rules.id, id)),
    );
  }

  private toDomain(row: typeof linear_dispatch_rules.$inferSelect): DispatchRule {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      publicationId: row.publication_id,
      name: row.name,
      enabled: row.enabled === 1,
      filterLabel: row.filter_label,
      filterStates: row.filter_states ? (JSON.parse(row.filter_states) as string[]) : null,
      filterProjectId: row.filter_project_id,
      maxConcurrent: row.max_concurrent,
      pollIntervalSeconds: row.poll_interval_seconds,
      lastPolledAt: row.last_polled_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
