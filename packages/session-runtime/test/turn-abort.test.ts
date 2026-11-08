import { describe, expect, it, vi } from "vitest";
import {
  abortableDelay,
  abortedError,
  cancellationError,
  isAbortError,
  linkAbort,
  untilAborted,
} from "../../control-plane-node/src/lib/node-managed-session-runtime";

describe("turn abort primitives", () => {
  it("names cancellations AbortError and keeps the reason", () => {
    expect(isAbortError(cancellationError("lease_lost"))).toBe(true);
    expect(cancellationError("lease_lost").message).toBe("lease_lost");
    expect(cancellationError().message).toBe("The operation was aborted");
    expect(isAbortError(new Error("x"))).toBe(false);
  });

  it("abortedError returns an Error reason as-is and wraps a string", () => {
    const reason = new Error("gone");
    const a = new AbortController();
    a.abort(reason);
    expect(abortedError(a.signal)).toBe(reason);
    const b = new AbortController();
    b.abort("interrupt_requested");
    expect(abortedError(b.signal).message).toBe("interrupt_requested");
  });

  it("linkAbort forwards the reason, handles aborted parents and unlinks", () => {
    const parent = new AbortController();
    const child = new AbortController();
    const unlink = linkAbort(parent.signal, child);
    parent.abort("why");
    expect(child.signal.reason).toBe("why");

    const done = new AbortController();
    done.abort("early");
    const late = new AbortController();
    linkAbort(done.signal, late);
    expect(late.signal.reason).toBe("early");

    const p2 = new AbortController();
    const c2 = new AbortController();
    linkAbort(p2.signal, c2)();
    p2.abort();
    expect(c2.signal.aborted).toBe(false);
    unlink();
    expect(() => linkAbort(undefined, new AbortController())()).not.toThrow();
  });

  it("abortableDelay resolves early on abort", async () => {
    const a = new AbortController();
    const started = Date.now();
    const delay = abortableDelay(60_000, a.signal);
    a.abort();
    await delay;
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("untilAborted passes through results and failures", async () => {
    const a = new AbortController();
    await expect(untilAborted(Promise.resolve(1), a.signal)).resolves.toBe(1);
    await expect(untilAborted(Promise.reject(new Error("no")), a.signal)).rejects.toThrow("no");
  });

  it("untilAborted rejects on abort and hands a late value to abandon", async () => {
    const a = new AbortController();
    let resolveLate!: (value: string) => void;
    const abandon = vi.fn(async () => undefined);
    const run = untilAborted(new Promise<string>((r) => { resolveLate = r; }), a.signal, abandon);
    a.abort("stop");
    await expect(run).rejects.toThrow("stop");
    resolveLate("sandbox");
    await vi.waitFor(() => expect(abandon).toHaveBeenCalledWith("sandbox"));
  });

  it("untilAborted on an already-aborted signal abandons the value", async () => {
    const a = new AbortController();
    a.abort("stop");
    const abandon = vi.fn(async () => undefined);
    await expect(untilAborted(Promise.resolve("v"), a.signal, abandon)).rejects.toThrow("stop");
    await vi.waitFor(() => expect(abandon).toHaveBeenCalledWith("v"));
  });
});
