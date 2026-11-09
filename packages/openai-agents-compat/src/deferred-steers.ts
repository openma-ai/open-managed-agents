import type { SendableSessionEvent } from "@open-managed-agents/managed-agents-application/ports/session-events";
import { OpenAIAgentsProtocolError } from "@open-managed-agents/openai-agents-api";

type Steer = Extract<SendableSessionEvent, { type: "user.message" }>;
/** Strong, tenant-scoped storage; SQL/D1 CAS, never eventually-consistent KV. */
export interface DeferredSteerStore {
  get(key: string): Promise<string | null>;
  compareAndSwap(key: string, expected: string | null, value: string | null): Promise<boolean>;
}
interface Entry { id: string; turnId: string; steers: Steer[] }
export function deferredSteers(store: DeferredSteerStore) {
  const keyOf = (sessionId: string) => "oai_deferred_steers:" + sessionId;
  async function change(sessionId: string, update: (entries: Entry[]) => Entry[]) {
    const key = keyOf(sessionId);
    for (let attempt = 0; attempt < 20; attempt++) {
      const raw = await store.get(key);
      const next = update(raw === null ? [] : JSON.parse(raw) as Entry[]);
      if (await store.compareAndSwap(key, raw, next.length ? JSON.stringify(next) : null)) return;
    }
    throw new OpenAIAgentsProtocolError(409, "Deferred steer changed concurrently; retry the request");
  }
  return {
    async stage(sessionId: string, entry: Entry) {
      await change(sessionId, entries => {
        const previous = entries.find(row => row.id === entry.id);
        if (previous) {
          if (JSON.stringify(previous) !== JSON.stringify(entry)) throw new OpenAIAgentsProtocolError(409, "Deferred steer idempotency payload conflict");
          return entries;
        }
        return [...entries, entry];
      });
    },
    async flush(sessionId: string, turnId: string, commit: (steers: Steer[], key: string) => Promise<void>) {
      const raw = await store.get(keyOf(sessionId));
      for (const entry of raw === null ? [] : JSON.parse(raw) as Entry[]) {
        if (entry.turnId !== turnId) continue;
        // Stable input identity makes a crash after commit safe to replay.
        await commit(entry.steers, "oai-deferred:" + entry.id);
        await change(sessionId, entries => entries.filter(row => row.id !== entry.id));
      }
    },
    async clear(sessionId: string) { await change(sessionId, () => []); },
  };
}
