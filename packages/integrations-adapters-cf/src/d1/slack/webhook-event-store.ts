import { eq } from "drizzle-orm";
import {
  asBuilder,
  getOne,
  type OmaDb,
  type OmaDbBuilder,
  runOnce,
} from "@open-managed-agents/db-schema";
import { slack_webhook_events } from "@open-managed-agents/db-schema/cf-integrations";
import type { WebhookEventStore } from "@open-managed-agents/integrations-core";

export class SqlSlackWebhookEventStore implements WebhookEventStore {
  private readonly db: OmaDbBuilder;
  constructor(db: OmaDb) {
    this.db = asBuilder(db);
  }

  /**
   * Atomic insert via INSERT OR IGNORE on the primary key. Returns true if a
   * row was actually inserted (new event), false if the delivery_id was
   * already present (duplicate — caller should short-circuit). Slack's
   * `event_id` (e.g. `Ev01ABC…`) is the dedup key.
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
        .insert(slack_webhook_events)
        .values({
          delivery_id: deliveryId,
          tenant_id: tenantId,
          installation_id: installationId,
          event_type: eventType,
          received_at: receivedAt,
        })
        .onConflictDoNothing()
        .returning({ delivery_id: slack_webhook_events.delivery_id }),
    );
    return inserted !== null;
  }

  async attachSession(deliveryId: string, sessionId: string): Promise<void> {
    await runOnce(
      this.db
        .update(slack_webhook_events)
        .set({ session_id: sessionId })
        .where(eq(slack_webhook_events.delivery_id, deliveryId)),
    );
  }

  async attachPublication(deliveryId: string, publicationId: string): Promise<void> {
    await runOnce(
      this.db
        .update(slack_webhook_events)
        .set({ publication_id: publicationId })
        .where(eq(slack_webhook_events.delivery_id, deliveryId)),
    );
  }

  async attachError(deliveryId: string, error: string): Promise<void> {
    await runOnce(
      this.db
        .update(slack_webhook_events)
        .set({ error })
        .where(eq(slack_webhook_events.delivery_id, deliveryId)),
    );
  }
}
