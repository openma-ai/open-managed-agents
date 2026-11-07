import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConsumerRuntime,
  type ConsumerRuntimeOptions,
} from "@open-managed-agents/queue/consumer-runtime";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Flush the promise continuations without advancing the periodic poll clock.
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe("ConsumerRuntime", () => {
  const consumers: Array<{ stop(): void }> = [];
  function consumer<T>(options: ConsumerRuntimeOptions<T>) {
    const runtime = new ConsumerRuntime(options);
    consumers.push(runtime);
    return runtime;
  }

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => {
    for (const runtime of consumers.splice(0)) runtime.stop();
    vi.useRealTimers();
  });

  it.each([0, -1, 1.5, NaN, Infinity])("rejects invalid concurrency %s", (maxConcurrent) => {
    expect(() => consumer({ maxConcurrent, claim: async () => null, run: () => {} }))
      .toThrow("maxConcurrent must be a positive integer");
  });

  it("fills available capacity and wakes when work finishes without exceeding the limit", async () => {
    const remaining = [1, 2, 3, 4];
    const gates = new Map(remaining.map((item) => [item, deferred<void>()]));
    const ran: number[] = [];
    let active = 0;
    let peak = 0;
    const claim = vi.fn(async () => remaining.shift() ?? null);
    const runtime = consumer({
      maxConcurrent: 2,
      claim,
      run: async (item) => {
        ran.push(item);
        peak = Math.max(peak, ++active);
        await gates.get(item)!.promise;
        active--;
      },
    });

    await runtime.poll();
    expect(ran).toEqual([1, 2]);
    expect(claim).toHaveBeenCalledTimes(2);
    gates.get(1)!.resolve();
    await flush();
    expect(ran).toEqual([1, 2, 3]);
    expect(active).toBe(2);
    gates.get(2)!.resolve();
    gates.get(3)!.resolve();
    await flush();
    expect(ran).toEqual([1, 2, 3, 4]);
    gates.get(4)!.resolve();
    await runtime.waitForIdle();
    expect(active).toBe(0);
    expect(peak).toBe(2);
  });

  it("coalesces repeated wakeups while one claim is pending", async () => {
    const claimed = deferred<number | null>();
    const finished = deferred<void>();
    const claim = vi.fn(() => claimed.promise);
    const run = vi.fn(() => finished.promise);
    const runtime = consumer({ maxConcurrent: 1, claim, run });

    const first = runtime.poll();
    expect(runtime.poll()).toBe(first);
    expect(runtime.poll()).toBe(first);
    expect(claim).toHaveBeenCalledTimes(1);
    claimed.resolve(1);
    await first;
    await runtime.poll();
    expect(claim).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledExactlyOnceWith(1);
    runtime.stop();
    finished.resolve();
    await runtime.waitForIdle();
  });

  it("recovers from periodic poll failure even when the error observer throws", async () => {
    const failure = new Error("database unavailable");
    const claim = vi.fn<() => Promise<number | null>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(1)
      .mockResolvedValue(null);
    const onError = vi.fn(() => { throw new Error("observer unavailable"); });
    const run = vi.fn(async () => {});
    const runtime = consumer({ claim, run, onError, pollIntervalMs: 10 });

    runtime.start();
    await flush();
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
    await vi.advanceTimersByTimeAsync(10);
    expect(run).toHaveBeenCalledExactlyOnceWith(1);
    runtime.stop();
    await runtime.waitForIdle();
  });

  it("returns manual claim failures to the caller and permits a later poll", async () => {
    const claim = vi.fn<() => Promise<null>>()
      .mockRejectedValueOnce("claim failed")
      .mockResolvedValue(null);
    const runtime = consumer({ claim, run: () => {} });

    await expect(runtime.poll()).rejects.toBe("claim failed");
    await expect(runtime.poll()).resolves.toBeUndefined();
    expect(claim).toHaveBeenCalledTimes(2);
  });

  it.each(["throw", "reject"])("observes a task %s and continues without deciding its settlement", async (mode) => {
    const failure = new Error("handler failed before settlement");
    const items = ["bad", "good"];
    const onError = vi.fn();
    const settlements: string[] = [];
    const runtime = consumer({
      maxConcurrent: 1,
      claim: async () => items.shift() ?? null,
      run: (item) => {
        if (item === "bad") {
          if (mode === "throw") throw failure;
          return Promise.reject(failure);
        }
        settlements.push(item);
      },
      onError,
    });

    await runtime.waitForIdle();
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(settlements).toEqual(["good"]);
  });

  it("does not claim again after stop, including completion and explicit wakeups", async () => {
    const finished = deferred<void>();
    const claim = vi.fn(async () => 1);
    const runtime = consumer({ maxConcurrent: 1, claim, run: () => finished.promise });

    await runtime.poll();
    runtime.stop();
    runtime.stop();
    let drained = false;
    const draining = runtime.waitForIdle().then(() => { drained = true; });
    await runtime.poll();
    await flush();
    expect(drained).toBe(false);
    finished.resolve();
    await draining;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it("tracks and drains an in-flight claim result after stop without claiming another item", async () => {
    const claimed = deferred<number | null>();
    const finished = deferred<void>();
    const claim = vi.fn(() => claimed.promise);
    const run = vi.fn(() => finished.promise);
    const runtime = consumer({ maxConcurrent: 4, claim, run });

    runtime.start();
    runtime.stop();
    let drained = false;
    const draining = runtime.waitForIdle().then(() => { drained = true; });
    await flush();
    expect(drained).toBe(false);
    claimed.resolve(1);
    await flush();
    expect(run).toHaveBeenCalledExactlyOnceWith(1);
    expect(drained).toBe(false);
    finished.resolve();
    await draining;
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it("supports repeated start/stop and restarts with one poll timer", async () => {
    const claimed = deferred<null>();
    const claim = vi.fn<() => Promise<null>>()
      .mockImplementationOnce(() => claimed.promise)
      .mockResolvedValue(null);
    const runtime = consumer({ claim, run: () => {}, pollIntervalMs: 10 });

    runtime.start();
    runtime.start();
    runtime.stop();
    runtime.stop();
    runtime.start();
    runtime.start();
    expect(claim).toHaveBeenCalledTimes(1);
    claimed.resolve(null);
    await flush();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(30);
    expect(claim).toHaveBeenCalledTimes(4);
    runtime.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    await runtime.poll();
    expect(claim).toHaveBeenCalledTimes(4);
    runtime.start();
    await flush();
    expect(claim).toHaveBeenCalledTimes(5);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("counts duplicate item values as separate runs and drains both", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const claim = vi.fn(async () => "same-value");
    const run = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const runtime = consumer({ maxConcurrent: 2, claim, run });

    await runtime.poll();
    expect(claim).toHaveBeenCalledTimes(2);
    runtime.stop();
    let drained = false;
    const draining = runtime.waitForIdle().then(() => { drained = true; });
    first.resolve();
    await flush();
    expect(drained).toBe(false);
    second.resolve();
    await draining;
    expect(run).toHaveBeenCalledTimes(2);
  });
});
