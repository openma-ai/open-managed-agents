import { describe, expect, it } from "vitest";
import { DefaultHarness } from "../src/harness/default-loop";
import { PiHarness } from "../src/harness/pi-loop";
import { registerCoreHarnesses } from "../src/harness/builtins";
import {
  HarnessLease,
  registerHarness,
  resolveHarness,
} from "../src/harness/registry";

describe("production harness composition", () => {
  it("keeps the OpenMA AI SDK loop as default and Pi as an explicit harness", () => {
    registerCoreHarnesses();
    expect(resolveHarness("default")).toBeInstanceOf(DefaultHarness);
    expect(resolveHarness("ai-sdk")).toBeInstanceOf(DefaultHarness);
    expect(resolveHarness("pi")).toBeInstanceOf(PiHarness);
  });

  it("reuses a session harness and disposes it when the binding changes", async () => {
    const disposed: number[] = [];
    let instance = 0;
    registerHarness("lease-test", () => {
      const id = ++instance;
      return {
        run: async () => {},
        dispose: async () => { disposed.push(id); },
      };
    });
    const lease = new HarnessLease();

    const first = await lease.resolve("agent:v1", "lease-test");
    const second = await lease.resolve("agent:v1", "lease-test");
    const replacement = await lease.resolve("agent:v2", "lease-test");

    expect(second).toBe(first);
    expect(replacement).not.toBe(first);
    expect(disposed).toEqual([1]);

    await lease.dispose();
    expect(disposed).toEqual([1, 2]);
  });
});
