import { and, asc, desc, eq, isNotNull, isNull } from "drizzle-orm";
import {
  asBuilder,
  getAll,
  getOne,
  type OmaDb,
  type OmaDbBuilder,
  runOnce,
} from "@open-managed-agents/db-schema";
import { linear_events } from "@open-managed-agents/db-schema/cf-integrations";
import type { LinearEventStore, LinearActionableEvent } from "@open-managed-agents/integrations-core";

/**
 * SQL adapter for the merged `linear_events` table. Replaces the previous
 * pair of D1WebhookEventStore + D1PendingEventRepo. One row plays three
 * roles in sequence:
 *
 *   recordIfNew → INSERT OR IGNORE skeleton (delivery_id PK ⇒ dedup)
 *   markActionable → set payload_json + event_kind + publication_id (enter queue)
 *   markProcessed | markFailed → set processed_at (leave queue)
 *
 * Rows that the handler chose not to act on stay payload_json=NULL with
 * `error` set; they're invisible to the drain index.
 */
export class SqlLinearEventStore implements LinearEventStore {
  private readonly db: OmaDbBuilder;
  constructor(db: OmaDb) {
    this.db = asBuilder(db);
  }

  async recordIfNew(
    deliveryId: string,
    tenantId: string,
    installationId: string,
    eventType: string,
    receivedAt: number,
  ): Promise<boolean> {
    // RETURNING tells us atomically whether the INSERT happened (row
    // returned) or was ignored on conflict (no row).
    const inserted = await getOne<{ delivery_id: string }>(
      this.db
        .insert(linear_events)
        .values({
          delivery_id: deliveryId,
          tenant_id: tenantId,
          installation_id: installationId,
          event_type: eventType,
          received_at: receivedAt,
        })
        .onConflictDoNothing()
        .returning({ delivery_id: linear_events.delivery_id }),
    );
    return inserted !== null;
  }

  async attachSession(deliveryId: string, sessionId: string): Promise<void> {
    await runOnce(
      this.db
        .update(linear_events)
        .set({ session_id: sessionId })
        .where(eq(linear_events.delivery_id, deliveryId)),
    );
  }

  async attachPublication(deliveryId: string, publicationId: string): Promise<void> {
    await runOnce(
      this.db
        .update(linear_events)
        .set({ publication_id: publicationId })
        .where(eq(linear_events.delivery_id, deliveryId)),
    );
  }

  async attachError(deliveryId: string, error: string): Promise<void> {
    await runOnce(
      this.db
        .update(linear_events)
        .set({ error: error.slice(0, 2000) })
        .where(eq(linear_events.delivery_id, deliveryId)),
    );
  }

  async markActionable(
    deliveryId: string,
    eventKind: string,
    publicationId: string,
    payloadJson: string,
  ): Promise<void> {
    await runOnce(
      this.db
        .update(linear_events)
        .set({
          event_kind: eventKind,
          publication_id: publicationId,
          payload_json: payloadJson,
        })
        .where(eq(linear_events.delivery_id, deliveryId)),
    );
  }

  async listUnprocessed(limit: number): Promise<readonly LinearActionableEvent[]> {
    const rows = await getAll<typeof linear_events.$inferSelect>(
      this.db
        .select()
        .from(linear_events)
        .where(
          and(
            isNotNull(linear_events.payload_json),
            isNull(linear_events.processed_at),
          ),
        )
        .orderBy(asc(linear_events.received_at))
        .limit(limit),
    );
    return rows.map(toActionable);
  }

  async markProcessed(
    deliveryId: string,
    sessionId: string,
    processedAtMs: number,
  ): Promise<void> {
    await runOnce(
      this.db
        .update(linear_events)
        .set({
          processed_at: processedAtMs,
          processed_session_id: sessionId,
        })
        .where(eq(linear_events.delivery_id, deliveryId)),
    );
  }

  async markFailed(
    deliveryId: string,
    errorMessage: string,
    processedAtMs: number,
  ): Promise<void> {
    await runOnce(
      this.db
        .update(linear_events)
        .set({
          processed_at: processedAtMs,
          error: errorMessage.slice(0, 2000),
        })
        .where(eq(linear_events.delivery_id, deliveryId)),
    );
  }

  async listByPublication(
    publicationId: string,
    limit: number,
  ): Promise<readonly LinearActionableEvent[]> {
    const rows = await getAll<typeof linear_events.$inferSelect>(
      this.db
        .select()
        .from(linear_events)
        .where(
          and(
            eq(linear_events.publication_id, publicationId),
            isNotNull(linear_events.payload_json),
          ),
        )
        .orderBy(desc(linear_events.received_at))
        .limit(limit),
    );
    return rows.map(toActionable);
  }
}

function toActionable(row: typeof linear_events.$inferSelect): LinearActionableEvent {
  return {
    deliveryId: row.delivery_id,
    tenantId: row.tenant_id,
    publicationId: row.publication_id ?? "",
    eventKind: row.event_kind ?? "unknown",
    payload: row.payload_json ?? "",
    receivedAt: row.received_at,
    processedAt: row.processed_at,
    processedSessionId: row.processed_session_id,
    errorMessage: row.error,
  };
}
