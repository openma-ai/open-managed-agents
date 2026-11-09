import { describe, expect, it } from "vitest";
import { durableObjectSandboxState } from "../src/runtime/session-sandbox-do-state";

// Design §0.0b A.10: the SessionDO handle record's save is a compare-and-set
// in one synchronous step of the SQLite-backed KV API.

function storage() {
  const kv = new Map<string, unknown>();
  return { kv: { get: (key: string) => kv.get(key), put: (key: string, value: unknown) => { kv.set(key, value); }, delete: (key: string) => kv.delete(key) } } as unknown as Pick<DurableObjectStorage, "kv">;
}

const record = (runtimeId: string, version: number) => ({ phase: "running" as const, handle: { provider: "fake", runtimeId }, runStartedAt: 1, latestSnapshot: { status: "none" as const }, stores: [], outputs: false, version });

describe("durableObjectSandboxState", () => {
  it("of two writers from the same version only one wins; the winner's record stays", async () => {
    const state = durableObjectSandboxState(storage(), "k");
    const results = await Promise.all([state.save(record("a", 1), 0), state.save(record("b", 1), 0)]);
    expect(results).toEqual([true, false]);
    expect(await state.load()).toEqual(record("a", 1));
    expect(await state.save(record("c", 2), 1)).toBe(true);
    expect(await state.save(record("d", 2), 1)).toBe(false);
  });
});
