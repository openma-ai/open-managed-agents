import { describe, expect, it, vi } from "vitest";
import { TurnInvocation } from "../src/runtime/turn-invocation";

describe("TurnInvocation", () => {
  it("waits for cooperative cancellation before rejecting a deadline, never leaving the turn detached", async () => {
    vi.useFakeTimers();
    try {
      const invocation = new TurnInvocation(100);
      let cleaned = false;
      const work = invocation.run(async () => {
        await new Promise<void>(resolve => invocation.signal.addEventListener("abort", () => resolve(), { once: true }));
        await new Promise(resolve => setTimeout(resolve, 10));
        cleaned = true;
      });
      const rejection = expect(work).rejects.toThrow("invocation wall-time budget");
      await vi.advanceTimersByTimeAsync(100);
      expect(cleaned).toBe(false);
      await vi.advanceTimersByTimeAsync(10);
      await rejection;
      expect(cleaned).toBe(true);
      await expect(invocation.run(async () => { throw new Error("must not start another turn"); }))
        .rejects.toThrow("invocation wall-time budget");
      invocation.close();
    } finally { vi.useRealTimers(); }
  });
  it("does not keep a timer after a successful invocation", async () => {
    vi.useFakeTimers();
    try {
      const invocation = new TurnInvocation(100);
      await invocation.run(async () => undefined);
      invocation.close();
      await vi.advanceTimersByTimeAsync(200);
      expect(invocation.signal.aborted).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
