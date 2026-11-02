import { describe, expect, it, vi } from "vitest";
import {
  probeSandboxLiveness,
  startSandboxHeartbeat,
  withSandboxRecovery,
  SandboxRecoveryFailedError,
  SandboxReplacedError,
  type SandboxPort,
} from "../src/index";

class FakeRuntime {
  dead = false;
  statusFailures = 0;
  readonly renewals: number[] = [];
  renewFailures = 0;
  constructor(readonly id: string) {}
  async exec(command: string): Promise<string> {
    if (this.dead) throw new Error("Sandbox is probably not running anymore");
    if (command === "boom") throw new Error("command failed");
    return `${this.id}:${command}`;
  }
  async readFile(): Promise<string> {
    if (this.dead) throw new Error("Sandbox is probably not running anymore");
    return this.id;
  }
  async writeFile(path: string): Promise<string> { return path; }
  setEnvVars(): void {}
  runtimeHandle() { return { provider: "fake", runtimeId: this.id }; }
  runtimeCapabilities() { return { lease: true, suspend: [], checkpoint: [] }; }
  async status() {
    if (this.statusFailures > 0) { this.statusFailures -= 1; throw new Error("network"); }
    if (this.dead) throw new Error("healthy sandbox not found");
    return "running" as const;
  }
  async renewLease(input: { ttlMs: number }) {
    if (this.renewFailures > 0) { this.renewFailures -= 1; throw new Error("renew failed"); }
    if (this.dead) throw new Error("sandbox not found");
    this.renewals.push(input.ttlMs);
  }
  async suspend(): Promise<never> { throw new Error("unsupported"); }
  async resume(): Promise<void> {}
  async checkpoint(): Promise<never> { throw new Error("unsupported"); }
}

const port = (runtime: FakeRuntime) => runtime as unknown as SandboxPort;

function harness(options: { replaceFails?: boolean; maxReplacements?: number } = {}) {
  let current = new FakeRuntime("sb1");
  const created = [current];
  const replace = vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (options.replaceFails) throw new Error("provider unavailable");
    current = new FakeRuntime(`sb${created.length + 1}`);
    created.push(current);
    return "/workspace is back to its state as of 2026-10-21 12:50:23 UTC; files created after that are gone.";
  });
  const onGiveUp = vi.fn();
  const recovery = withSandboxRecovery({
    current: () => port(current),
    probe: (sandbox) => probeSandboxLiveness(sandbox, { retryDelayMs: 0 }),
    replace,
    onGiveUp,
    maxReplacements: options.maxReplacements,
  });
  return { recovery, replace, onGiveUp, created, current: () => current };
}

describe("probeSandboxLiveness", () => {
  it("is unknown for sandboxes without the runtime Port and tolerates one failed probe", async () => {
    expect(await probeSandboxLiveness({ exec: async () => "" } as unknown as SandboxPort)).toBe("unknown");
    const runtime = new FakeRuntime("sb");
    runtime.statusFailures = 1;
    expect(await probeSandboxLiveness(port(runtime), { retryDelayMs: 0 })).toBe("alive");
    runtime.statusFailures = 2;
    expect(await probeSandboxLiveness(port(runtime), { retryDelayMs: 0 })).toBe("lost");
    runtime.dead = true;
    expect(await probeSandboxLiveness(port(runtime), { retryDelayMs: 0 })).toBe("lost");
  });
});

describe("withSandboxRecovery", () => {
  it("passes ordinary failures through and never replaces a live sandbox", async () => {
    const { recovery, replace } = harness();
    await expect(recovery.sandbox.exec("ls")).resolves.toBe("sb1:ls");
    await expect(recovery.sandbox.exec("boom")).rejects.toThrow("command failed");
    expect(replace).not.toHaveBeenCalled();
  });

  it("replaces a lost sandbox once for concurrent failures and runs later calls on the replacement", async () => {
    const { recovery, replace, created } = harness();
    created[0]!.dead = true;
    const results = await Promise.allSettled([
      recovery.sandbox.exec("a"),
      recovery.sandbox.readFile("/x"),
      recovery.sandbox.exec("b"),
    ]);
    expect(replace).toHaveBeenCalledTimes(1);
    for (const result of results) {
      expect(result.status).toBe("rejected");
      const error = (result as PromiseRejectedResult).reason;
      expect(error).toBeInstanceOf(SandboxReplacedError);
      expect(error.message).toBe(
        "This tool call was interrupted because the environment restarted. /workspace is back to its state as of 2026-10-21 12:50:23 UTC; files created after that are gone. Background processes were stopped. Re-run the tool call if it is still needed.",
      );
      // The agent never learns about sandboxes or the provider's error.
      expect(error.message).not.toMatch(/sandbox|not running anymore/i);
      expect(error.cause).toBeUndefined();
    }
    await expect(recovery.sandbox.exec("c")).resolves.toBe("sb2:c");
    expect(recovery.replacements).toBe(1);
  });

  it("gives up after too many losses and reports it once", async () => {
    const { recovery, onGiveUp, current } = harness({ maxReplacements: 2 });
    for (let loss = 0; loss < 2; loss++) {
      current().dead = true;
      await expect(recovery.sandbox.exec("x")).rejects.toBeInstanceOf(SandboxReplacedError);
    }
    current().dead = true;
    await expect(recovery.sandbox.exec("x")).rejects.toBeInstanceOf(SandboxRecoveryFailedError);
    await expect(recovery.sandbox.exec("y")).rejects.toThrow(/restarted 3 times/);
    expect(onGiveUp).toHaveBeenCalledTimes(1);
  });

  it("fails every later call when the replacement cannot be acquired", async () => {
    const { recovery, onGiveUp, created } = harness({ replaceFails: true });
    created[0]!.dead = true;
    await expect(recovery.sandbox.exec("x")).rejects.toThrow(/^The environment stopped and could not be restarted\.$/);
    await expect(recovery.sandbox.readFile("/x")).rejects.toBeInstanceOf(SandboxRecoveryFailedError);
    expect(onGiveUp).toHaveBeenCalledTimes(1);
  });

  it("check() replaces proactively, e.g. after a failed lease renewal", async () => {
    const { recovery, replace, created } = harness();
    await recovery.check(port(created[0]!), new Error("renew failed"));
    expect(replace).not.toHaveBeenCalled();
    created[0]!.dead = true;
    await recovery.check(port(created[0]!), new Error("renew failed"));
    expect(replace).toHaveBeenCalledTimes(1);
    // The caller must learn its files are gone before it uses the new sandbox.
    await expect(recovery.sandbox.exec("ls")).rejects.toThrow(/^This tool call was interrupted because the environment restarted\./);
    await expect(recovery.sandbox.exec("ok")).resolves.toBe("sb2:ok");
  });

  it("close() waits for a replacement in flight, refuses new ones and returns an unreported notice", async () => {
    const { recovery, replace, created } = harness();
    created[0]!.dead = true;
    const check = recovery.check(port(created[0]!), new Error("renew failed"));
    await vi.waitFor(() => expect(replace).toHaveBeenCalled());
    expect(await recovery.close()).toMatch(/environment restarted/);
    await check;
    expect(replace).toHaveBeenCalledTimes(1);
    created[1]!.dead = true;
    await expect(recovery.sandbox.exec("x")).rejects.toThrow(/stopped after the turn ended/);
    expect(replace).toHaveBeenCalledTimes(1);
  });
});

describe("startSandboxHeartbeat", () => {
  it("renews the current sandbox until stopped and reports failed renewals without stopping", async () => {
    let current = new FakeRuntime("sb1");
    current.renewFailures = 1;
    const failed: string[] = [];
    const stop = startSandboxHeartbeat(() => port(current), {
      ttlMs: 60, intervalMs: 5,
      onRenewFailed: (sandbox) => { failed.push((sandbox as unknown as FakeRuntime).id); },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const first = current;
    current = new FakeRuntime("sb2");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await stop();
    const after = current.renewals.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(failed).toEqual(["sb1"]);
    expect(first.renewals.length).toBeGreaterThan(0);
    expect(first.renewals.every((ttl) => ttl === 60)).toBe(true);
    expect(current.renewals.length).toBeGreaterThan(0);
    expect(current.renewals.length).toBe(after);
  });

  it("rejects an interval that cannot keep the lease", () => {
    expect(() => startSandboxHeartbeat(() => port(new FakeRuntime("x")), { ttlMs: 10, intervalMs: 10 })).toThrow(TypeError);
  });
});
