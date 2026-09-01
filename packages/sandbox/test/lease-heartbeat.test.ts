import { describe, expect, it } from "vitest";

import {
  runWithSandboxLease,
  SandboxLeaseLostError,
  type SandboxRuntimePort,
} from "../src";

function runtime(renew: () => Promise<void>): SandboxRuntimePort {
  return {
    runtimeHandle: () => ({ provider: "fake", runtimeId: "runtime-01" }),
    runtimeCapabilities: () => ({ lease: true, suspend: [], checkpoint: [] }),
    status: async () => "running",
    renewLease: renew,
    suspend: async () => { throw new Error("unexpected suspend"); },
    resume: async () => { throw new Error("unexpected resume"); },
    checkpoint: async () => { throw new Error("unexpected checkpoint"); },
  };
}

describe("sandbox lease heartbeat", () => {
  it("aborts the workload and fences it when a periodic renewal fails", async () => {
    let renewals = 0;
    let operationSignal: AbortSignal | undefined;
    const result = runWithSandboxLease(
      runtime(async () => {
        renewals += 1;
        if (renewals === 2) throw new Error("lease owner changed");
      }),
      {
        ttlMs: 90_000,
        intervalMs: 30_000,
        scheduler: { sleep: async () => {} },
      },
      async (signal) => {
        operationSignal = signal;
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true })
        );
      },
    );

    await expect(result).rejects.toBeInstanceOf(SandboxLeaseLostError);
    expect(renewals).toBe(2);
    expect(operationSignal?.aborted).toBe(true);
  });

  it("cancels the sleeping heartbeat as soon as the workload completes", async () => {
    let renewals = 0;
    let sleepSignal: AbortSignal | undefined;
    const value = await runWithSandboxLease(
      runtime(async () => { renewals += 1; }),
      {
        ttlMs: 90_000,
        intervalMs: 30_000,
        scheduler: {
          sleep: (_ms, signal) => {
            sleepSignal = signal;
            return new Promise<void>((resolve) =>
              signal.addEventListener("abort", () => resolve(), { once: true })
            );
          },
        },
      },
      async () => "done",
    );

    expect(value).toBe("done");
    expect(renewals).toBe(1);
    expect(sleepSignal?.aborted).toBe(true);
  });
});
