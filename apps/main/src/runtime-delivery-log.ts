export interface RuntimeDelivery { stream_id: string; seq: number }
export type RuntimeDeliveryFrame = Record<string, unknown> & {
  session_id: string; tenant_id: string; delivery: RuntimeDelivery;
};
export interface RuntimeReplay { turn_id: string; after: Record<string, number> }

export function readRuntimeReplay(value: string): RuntimeReplay | null {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed.turn_id !== "string" || !parsed.turn_id || !parsed.after || typeof parsed.after !== "object" || Array.isArray(parsed.after)) return null;
    const entries = Object.entries(parsed.after);
    if (entries.length > 64 || entries.some(([id, seq]) => !id || id.length > 128 || !Number.isSafeInteger(seq) || Number(seq) < 0)) return null;
    return { turn_id: parsed.turn_id, after: Object.fromEntries(entries) as Record<string, number> };
  } catch { return null; }
}

export function readRuntimeDelivery(value: unknown): RuntimeDelivery | null {
  if (!value || typeof value !== "object") return null;
  const { stream_id, seq } = value as Partial<RuntimeDelivery>;
  return typeof stream_id === "string" && stream_id.length > 0 && stream_id.length <= 128
    && Number.isSafeInteger(seq) && seq! > 0 ? { stream_id, seq: seq! } : null;
}

/** The relay owns receipts, not task completion. Retain raw frames so the
 * service can recover its consumer independently of the runner connection. */
export class RuntimeDeliveryLog {
  constructor(private storage: DurableObjectStorage) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS runtime_delivery_streams (
      id TEXT PRIMARY KEY, tenant TEXT NOT NULL, session TEXT NOT NULL, head INTEGER NOT NULL DEFAULT 0
    )`);
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS runtime_delivery_frames (
      stream TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(stream, seq)
    )`);
  }

  receive(frame: RuntimeDeliveryFrame): { head: number; frames: RuntimeDeliveryFrame[] } | null {
    return this.storage.transactionSync(() => {
      const sql = this.storage.sql;
      const { stream_id, seq } = frame.delivery;
      sql.exec("INSERT OR IGNORE INTO runtime_delivery_streams (id, tenant, session) VALUES (?, ?, ?)", stream_id, frame.tenant_id, frame.session_id);
      const stream = sql.exec<{ tenant: string; session: string; head: number }>("SELECT tenant, session, head FROM runtime_delivery_streams WHERE id = ?", stream_id).one();
      if (stream.tenant !== frame.tenant_id || stream.session !== frame.session_id || seq > stream.head + 1024) return null;
      const body = JSON.stringify(frame);
      const previous = sql.exec<{ body: string }>("SELECT body FROM runtime_delivery_frames WHERE stream = ? AND seq = ?", stream_id, seq).toArray()[0];
      // A sequence number cannot be reused for different content.
      if (previous && previous.body !== body) return null;
      sql.exec("INSERT OR IGNORE INTO runtime_delivery_frames VALUES (?, ?, ?)", stream_id, seq, body);
      const frames: RuntimeDeliveryFrame[] = [];
      let head = stream.head;
      for (const row of sql.exec<{ seq: number; body: string }>("SELECT seq, body FROM runtime_delivery_frames WHERE stream = ? AND seq > ? ORDER BY seq", stream_id, head)) {
        if (row.seq !== head + 1) break;
        frames.push(JSON.parse(row.body)); head = row.seq;
      }
      sql.exec("UPDATE runtime_delivery_streams SET head = ? WHERE id = ?", head, stream_id);
      return { head, frames };
    });
  }

  replay(sessionId: string, tenantId: string, request: RuntimeReplay): RuntimeDeliveryFrame[] {
    const rows = this.storage.sql.exec<{ stream: string; seq: number; body: string }>(`SELECT stream, seq, body
      FROM runtime_delivery_frames f JOIN runtime_delivery_streams s ON s.id = f.stream
      WHERE s.session = ? AND s.tenant = ? AND f.seq <= s.head AND json_extract(f.body, '$.turn_id') = ?
      ORDER BY s.rowid, f.seq`, sessionId, tenantId, request.turn_id);
    return rows.toArray().filter((row) => row.seq > (Object.hasOwn(request.after, row.stream) ? request.after[row.stream]! : 0)).map((row) => JSON.parse(row.body));
  }
}
