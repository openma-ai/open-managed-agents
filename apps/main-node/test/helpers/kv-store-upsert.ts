// Shared KV upsert contract, run against each supported Node dialect
// (mysql / postgres legs sit next to this file). Covers the production
// regression where SqlKvStore.put crashed on MySQL with
// "onConflictDoUpdate is not a function".

import { expect } from "vitest";

import type { NodeDatabase } from "@open-managed-agents/node-database";
import { SqlKvStore } from "@open-managed-agents/kv-store/adapters/sql";
import { EvalBenchmarkStore } from "@open-managed-agents/evals-runner";

export async function runKvStoreUpsert(database: NodeDatabase): Promise<void> {
  const kv = new SqlKvStore({ db: database.drizzle, tenantId: "tenant_kv_upsert" });

  await kv.put("alpha", "one");
  expect(await kv.get("alpha")).toBe("one");

  // Upsert: the second write wins.
  await kv.put("alpha", "two");
  expect(await kv.get("alpha")).toBe("two");

  // Upsert also resets TTL: a TTL'd write followed by a plain write lists
  // without an expiration.
  await kv.put("beta", "ttl", { expirationTtl: 600 });
  await kv.put("beta", "persisted");
  const listed = await kv.list({ prefix: "beta" });
  expect(listed.keys).toHaveLength(1);
  expect(listed.keys[0].expiration).toBeUndefined();

  await kv.delete("alpha");
  expect(await kv.get("alpha")).toBeNull();

  // CAS is used by the durable environment cache. The insert-if-absent branch
  // must remain atomic on every Node SQL dialect, including MySQL where
  // Drizzle exposes a different conflict API and no INSERT RETURNING.
  expect(await kv.compareAndSwap?.("cas", null, "one")).toBe(true);
  expect(await kv.compareAndSwap?.("cas", null, "two")).toBe(false);
  expect(await kv.compareAndSwap?.("cas", "one", "two")).toBe(true);
  expect(await kv.compareAndSwap?.("cas", "two", "two")).toBe(true);
  expect(await kv.get("cas")).toBe("two");
  expect(await kv.compareAndSwap?.("cas", "two", null)).toBe(true);
  expect(await kv.get("cas")).toBeNull();
}

/** The POST /v1/oma/evals/benchmarks path that 500'd on MySQL. */
export async function runBenchmarkStoreCreateMessages(database: NodeDatabase): Promise<void> {
  const tenantId = "tenant_eval_bm";
  const store = new EvalBenchmarkStore(new SqlKvStore({ db: database.drizzle, tenantId }), tenantId);

  const created = await store.createMessages("messages-bench", [
    { kind: "messages", name: "case-1", messages: ["hello"] },
  ]);
  expect(created.kind).toBe("messages");

  const fetched = await store.get(created.id);
  expect(fetched?.name).toBe("messages-bench");
  expect(fetched?.cases).toHaveLength(1);
  expect(await store.delete(created.id)).toBe(true);
}
