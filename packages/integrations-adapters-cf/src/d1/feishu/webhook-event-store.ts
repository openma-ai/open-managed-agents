// SQL webhook-event store for Feishu (D1 / SQLite).
//
// Mirrors packages/integrations-adapters-cf/src/d1/slack/webhook-event-store.ts
// but writes to feishu_webhook_events. Used by the HTTP webhook handler
// (legacy URL verification + occasional HTTP callbacks); the WS runner uses
// the node-pg feishu_message_events table instead.

import { eq } from "drizzle-orm";
import {
  asBuilder,
  getOne,
  type OmaDb,
  type OmaDbBuilder,
  runOnce,
} from "@open-managed-agents/db-schema";
import { feishu_webhook_events } from "@open-managed-agents/db-schema/cf-integrations";
import type { WebhookEventStore } from "@open-managed-agents/integrations-core";

export class SqlFeishuWebhookEventStore implements WebhookEventStore {
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
    const inserted = await getOne<{ delivery_id: string }>(
      this.db
        .insert(feishu_webhook_events)
        .values({
          delivery_id: deliveryId,
          tenant_id: tenantId,
          installation_id: installationId,
          event_type: eventType,
          received_at: receivedAt,
        })
        .onConflictDoNothing()
        .returning({ delivery_id: feishu_webhook_events.delivery_id }),
    );
    return inserted !== null;
  }

  async attachSession(deliveryId: string, sessionId: string): Promise<void> {
    await runOnce(
      this.db
        .update(feishu_webhook_events)
        .set({ session_id: sessionId })
        .where(eq(feishu_webhook_events.delivery_id, deliveryId)),
    );
  }

  async attachPublication(
    deliveryId: string,
    publicationId: string,
  ): Promise<void> {
    await runOnce(
      this.db
        .update(feishu_webhook_events)
        .set({ publication_id: publicationId })
        .where(eq(feishu_webhook_events.delivery_id, deliveryId)),
    );
  }

  async attachError(deliveryId: string, error: string): Promise<void> {
    await runOnce(
      this.db
        .update(feishu_webhook_events)
        .set({ error })
        .where(eq(feishu_webhook_events.delivery_id, deliveryId)),
    );
  }
}
