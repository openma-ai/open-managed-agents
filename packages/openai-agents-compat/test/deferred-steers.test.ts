import { expect, it } from "vitest";
import { deferredSteers, type DeferredSteerStore } from "../src/deferred-steers";
function store(): DeferredSteerStore {
  const rows = new Map<string, string>();
  return { get: async key => rows.get(key) ?? null, compareAndSwap: async (key, expected, value) => {
    if ((rows.get(key) ?? null) !== expected) return false;
    if (value === null) rows.delete(key); else rows.set(key, value);
    return true;
  } };
}
const entry = (id: string, turnId = "original") => ({ id, turnId, steers: [{ type: "user.message" as const, content: [{ type: "text" as const, text: id }] }] });
it("survives a new handler and retains a failed commit for stable-identity retry", async () => {
  const shared = store(); await deferredSteers(shared).stage("session", entry("one"));
  await expect(deferredSteers(shared).flush("session", "original", async () => { throw new Error("commit unavailable"); })).rejects.toThrow("unavailable");
  const committed: string[] = [];
  await deferredSteers(shared).flush("session", "original", async (_events, key) => { committed.push(key); });
  await deferredSteers(shared).flush("session", "original", async (_events, key) => { committed.push(key); });
  expect(committed).toEqual(["oai-deferred:one"]);
});
it("CAS preserves concurrent stages, binds original Turn and rejects payload reuse", async () => {
  const shared = store();
  await Promise.all([deferredSteers(shared).stage("session", entry("one")), deferredSteers(shared).stage("session", entry("two"))]);
  await expect(deferredSteers(shared).stage("session", entry("one", "other"))).rejects.toThrow("payload conflict");
  const committed: string[] = [];
  await deferredSteers(shared).flush("session", "other", async (_events, key) => { committed.push(key); });
  expect(committed).toEqual([]);
  await deferredSteers(shared).flush("session", "original", async (_events, key) => { committed.push(key); });
  expect(committed.sort()).toEqual(["oai-deferred:one", "oai-deferred:two"]);
});
