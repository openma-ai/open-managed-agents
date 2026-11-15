import { beforeEach, describe, expect, it, vi } from "vitest";
import { openTurnMarker } from "../src/turn-marker";

function setup(fail: { begin?: boolean; end?: boolean } = {}) {
  const calls: string[] = [];
  const adapter = {
    beginTurn: async (s: string, t: string) => { if (fail.begin) throw new Error("d1"); calls.push(`begin:${s}:${t}`); },
    endTurn: async (s: string, t: string, status: string) => { if (fail.end) throw new Error("d1"); calls.push(`end:${s}:${t}:${status}`); },
  };
  const hooks = { began: (t: string) => calls.push(`began:${t}`), ended: (t: string) => calls.push(`ended:${t}`) };
  return { adapter, hooks, calls };
}

describe("openTurnMarker", () => {
  beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => undefined); });

  it("marks then clears the turn as idle", async () => {
    const { adapter, hooks, calls } = setup();
    const marker = await openTurnMarker(adapter, "s", "t", hooks);
    expect(marker.marked).toBe(true);
    await expect(marker.end()).resolves.toBe(true);
    expect(calls).toEqual(["begin:s:t", "began:t", "end:s:t:idle", "ended:t"]);
  });

  it("does not fail the turn when the marker cannot be written, and has nothing to clear", async () => {
    const { adapter, hooks, calls } = setup({ begin: true });
    const marker = await openTurnMarker(adapter, "s", "t", hooks);
    expect(marker.marked).toBe(false);
    await expect(marker.end()).resolves.toBe(true);
    expect(calls).toEqual([]);
  });

  it("reports a failed clear and still ends the turn locally", async () => {
    const { adapter, hooks, calls } = setup({ end: true });
    const marker = await openTurnMarker(adapter, "s", "t", hooks);
    await expect(marker.end()).resolves.toBe(false);
    expect(calls).toEqual(["begin:s:t", "began:t", "ended:t"]);
  });
});
