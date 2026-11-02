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
  it("uses Pi as the default harness and keeps AI SDK as an explicit opt-in", () => {
    registerCoreHarnesses();
    expect(resolveHarness()).toBeInstanceOf(PiHarness);
    expect(resolveHarness("default")).toBeInstanceOf(PiHarness);
    expect(resolveHarness("pi")).toBeInstanceOf(PiHarness);
    expect(resolveHarness("ai-sdk")).toBeInstanceOf(DefaultHarness);
  });

  it("reuses a session harness and disposes it when the binding changes", async () => {
    const disposed: string[] = [];
    let instance = 0;
    registerHarness("lease-test", () => {
      const id = ++instance;
      return {
        run: async () => {},
        dispose: async (reason) => { disposed.push(`${id}:${reason}`); },
      };
    });
    const lease = new HarnessLease();

    const first = await lease.resolve("agent:v1", "lease-test");
    const second = await lease.resolve("agent:v1", "lease-test");
    const replacement = await lease.resolve("agent:v2", "lease-test");

    expect(second).toBe(first);
    expect(replacement).not.toBe(first);
    expect(disposed).toEqual(["1:replace"]);

    await lease.dispose("shutdown");
    expect(disposed).toEqual(["1:replace", "2:shutdown"]);
  });
});
