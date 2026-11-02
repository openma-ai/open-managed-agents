// Realtime component: how live session events reach SSE subscribers on
// every replica. In-process by default; Postgres NOTIFY or SQL polling when
// the control plane runs as several replicas.

import { SqlEventLog } from "@open-managed-agents/event-log/sql";
import { generateEventId, sessionMonotonicClock } from "@open-managed-agents/shared";
import type { SessionEvent } from "@open-managed-agents/shared";

import {
  InProcessEventStreamHub,
  SqlPollingEventStreamHub,
  type EventStreamHub,
  type NodeDatabase,
  type NodeRealtime,
  type RealtimeFanoutConfig,
} from "@open-managed-agents/control-plane-node";

import { PgEventStreamHub } from "./lib/pg-event-stream-hub.js";

export type { NodeRealtime };

export async function createNodeRealtime(
  config: RealtimeFanoutConfig,
  database: NodeDatabase,
  options: { postgresDsn?: string } = {},
): Promise<NodeRealtime> {
  const { sql } = database;
  if (config.mode === "pg-notify") {
    if (options.postgresDsn === undefined) {
      throw new Error("pg-notify realtime needs the Postgres connection string");
    }
    const hub = await PgEventStreamHub.create({
      dsn: options.postgresDsn,
      fetchEventsAfter: (sessionId, afterSeq) => eventLog(sql, sessionId).getEventsAsync(afterSeq),
    });
    return { hub, replicaSync: { pollIntervalMs: config.pollIntervalMs }, description: "pg-notify", stop: () => hub.stop() };
  }
  if (config.mode === "sql-poll") {
    const hub = new SqlPollingEventStreamHub({ sql, pollIntervalMs: config.pollIntervalMs });
    return { hub, replicaSync: { pollIntervalMs: config.pollIntervalMs }, description: "sql-poll", stop: () => hub.stop() };
  }
  return { hub: new InProcessEventStreamHub(), replicaSync: null, description: "in-process" };
}

function eventLog(sql: NodeDatabase["sql"], sessionId: string): SqlEventLog {
  return new SqlEventLog(sql, sessionId, (e) => {
    const ev = e as SessionEvent & { id?: string; processed_at?: string };
    if (!ev.id) ev.id = `sevt_${generateEventId()}`;
    if (!ev.processed_at) ev.processed_at = sessionMonotonicClock(sessionId).nowIso();
  });
}
