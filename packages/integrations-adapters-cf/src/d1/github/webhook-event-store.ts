import { eq } from "drizzle-orm";
import {
  asBuilder,
  getOne,
  type OmaDb,
  type OmaDbBuilder,
  runOnce,
} from "@open-managed-agents/db-schema";
import { github_webhook_events } from "@open-managed-agents/db-schema/cf-integrations";
import type { WebhookEventStore } from "@open-managed-agents/integrations-core";

/**
 * Standalone SQL store for `github_webhook_events`. Previously GitHub
 * webhooks borrowed `linear_webhook_events` (a leftover from before
 * 0009_split_github_tables.sql split installations + publications). This
 * completes the split: GitHub now has its own dedup + audit table.
 *
 * GitHub dispatch is inline (no async queue), so the schema is the simple
 * audit-only shape — same as `slack_webhook_events`.
 */
export class SqlGitHubWebhookEventStore implements WebhookEventStore {
  private readonly db: OmaDbBuilder;
  constructor(db: OmaDb) {
    this.db = asBuilder(db);
  }

  /**
   * Atomic insert via INSERT OR IGNORE on the primary key. Returns true if a
   * row was actually inserted (new event), false if the delivery_id was
   * already present (duplicate — caller should short-circuit). GitHub's
   * `x-github-delivery` UUID is the dedup key.
   */
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
        .insert(github_webhook_events)
        .values({
          delivery_id: deliveryId,
          tenant_id: tenantId,
          installation_id: installationId,
          event_type: eventType,
          received_at: receivedAt,
        })
        .onConflictDoNothing()
        .returning({ delivery_id: github_webhook_events.delivery_id }),
    );
    return inserted !== null;
  }

  async attachSession(deliveryId: string, sessionId: string): Promise<void> {
    await runOnce(
      this.db
        .update(github_webhook_events)
        .set({ session_id: sessionId })
        .where(eq(github_webhook_events.delivery_id, deliveryId)),
    );
  }

  async attachPublication(deliveryId: string, publicationId: string): Promise<void> {
    await runOnce(
      this.db
        .update(github_webhook_events)
        .set({ publication_id: publicationId })
        .where(eq(github_webhook_events.delivery_id, deliveryId)),
    );
  }

  async attachError(deliveryId: string, error: string): Promise<void> {
    await runOnce(
      this.db
        .update(github_webhook_events)
        .set({ error: error.slice(0, 2000) })
        .where(eq(github_webhook_events.delivery_id, deliveryId)),
    );
  }
}
