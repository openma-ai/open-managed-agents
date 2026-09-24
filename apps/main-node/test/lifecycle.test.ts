import { describe, expect, it, vi } from "vitest";
import { Disposables } from "../src/lifecycle";

describe("Disposables", () => {
  it("stops registered resources in reverse registration order", async () => {
    const order: string[] = [];
    const d = new Disposables();
    d.add("db", () => { order.push("db"); });
    d.add("worker", async () => { order.push("worker"); });
    d.add("server", () => { order.push("server"); });

    await d.dispose();

    expect(order).toEqual(["server", "worker", "db"]);
  });

  it("keeps stopping the remaining resources when one stop fails and reports it", async () => {
    const order: string[] = [];
    const onError = vi.fn();
    const d = new Disposables({ onError });
    d.add("db", () => { order.push("db"); });
    d.add("broken", () => { throw new Error("boom"); });
    d.add("server", () => { order.push("server"); });

    await d.dispose();

    expect(order).toEqual(["server", "db"]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith("broken", expect.objectContaining({ message: "boom" }));
  });

  it("is idempotent: a second dispose does nothing and resources added afterwards stop immediately", async () => {
    const stop = vi.fn();
    const d = new Disposables();
    d.add("db", stop);

    await d.dispose();
    await d.dispose();
    expect(stop).toHaveBeenCalledTimes(1);

    const late = vi.fn();
    d.add("late", late);
    await Promise.resolve();
    expect(late).toHaveBeenCalledTimes(1);
  });

  it("rolls back already-created resources when construction fails", async () => {
    const stopped: string[] = [];
    const d = new Disposables();
    d.add("db", () => { stopped.push("db"); });

    await expect(
      d.guard(async () => {
        d.add("worker", () => { stopped.push("worker"); });
        throw new Error("blob store unreachable");
      }),
    ).rejects.toThrow("blob store unreachable");

    expect(stopped).toEqual(["worker", "db"]);
  });

  it("guard returns the constructed value and leaves resources running on success", async () => {
    const stopped: string[] = [];
    const d = new Disposables();

    const value = await d.guard(async () => {
      d.add("db", () => { stopped.push("db"); });
      return 42;
    });

    expect(value).toBe(42);
    expect(stopped).toEqual([]);
    expect(d.disposed).toBe(false);
  });
});
