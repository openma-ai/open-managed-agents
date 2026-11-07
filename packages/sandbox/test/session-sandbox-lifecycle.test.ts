import { describe, expect, it, vi } from "vitest";

import {
  openSessionSandbox,
  SandboxCapabilityMissingError,
  SandboxProvisionFailedError,
  SandboxReleasedError,
  UNDECLARED_PERSISTENCE,
  withSandboxReadinessBarrier,
  type SandboxPort,
  type SessionSandboxDriver,
  type SessionSandboxErrorEvent,
} from "../src/index";

const CONTEXT = { sessionId: "sess_lifecycle", workdir: "/unused" };
const WAIT = { timeoutMs: 1_000 };

function sandboxStub(extra: Partial<SandboxPort> = {}): SandboxPort {
  return {
    exec: async (command: string) => `ran ${command}`,
    readFile: async () => "",
    writeFile: async () => "",
    ...extra,
  };
}

function driverStub(overrides: Partial<SessionSandboxDriver> = {}): SessionSandboxDriver {
  return {
    provider: "stub",
    capabilities: UNDECLARED_PERSISTENCE,
    acquire: async () => sandboxStub(),
    prepare: async () => undefined,
    release: async () => undefined,
    ...overrides,
  };
}

describe("openSessionSandbox", () => {
  it("rejects a non-positive attempt budget", () => {
    expect(() => openSessionSandbox(driverStub(), CONTEXT, { retry: { maxAttempts: 0 } }))
      .toThrow(TypeError);
    expect(() => openSessionSandbox(driverStub(), CONTEXT, { retry: { maxAttempts: 1.5 } }))
      .toThrow(TypeError);
  });

  it("acquires nothing until provisioning is requested", async () => {
    const acquire = vi.fn(async () => sandboxStub());
    const sandbox = openSessionSandbox(driverStub({ acquire }), CONTEXT);

    expect(sandbox.state()).toEqual({ phase: "idle" });
    expect(sandbox.context).toBe(CONTEXT);
    expect(acquire).not.toHaveBeenCalled();
    await expect(sandbox.whenReady({ timeoutMs: Number.NaN })).rejects.toThrow(TypeError);
    await expect(sandbox.whenReady({ timeoutMs: -1 })).rejects.toThrow(TypeError);
    expect(acquire).not.toHaveBeenCalled();
  });

  it("does not start provisioning for a waiter whose signal is already aborted", async () => {
    const acquire = vi.fn(async () => sandboxStub());
    const sandbox = openSessionSandbox(driverStub({ acquire }), CONTEXT);
    const controller = new AbortController();
    controller.abort("not an Error");

    const error = await sandbox.whenReady({ ...WAIT, signal: controller.signal })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("AbortError");
    expect(acquire).not.toHaveBeenCalled();
  });

  it("backs off between attempts with the configured policy", async () => {
    const sleep = vi.fn(async () => undefined);
    const acquire = vi.fn(async (): Promise<SandboxPort> => {
      throw new Error("provider unavailable");
    });
    const sandbox = openSessionSandbox(driverStub({ acquire }), CONTEXT, { sleep });

    await expect(sandbox.whenReady(WAIT)).rejects.toBeInstanceOf(SandboxProvisionFailedError);

    expect(acquire).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([250, 500]);
  });

  it("caps the default backoff", async () => {
    const sleep = vi.fn(async () => undefined);
    const sandbox = openSessionSandbox(
      driverStub({ acquire: async () => { throw new Error("down"); } }),
      CONTEXT,
      { sleep, retry: { maxAttempts: 7 } },
    );

    await expect(sandbox.whenReady(WAIT)).rejects.toBeInstanceOf(SandboxProvisionFailedError);

    expect(sleep.mock.calls.map(([milliseconds]) => milliseconds))
      .toEqual([250, 500, 1_000, 2_000, 4_000, 5_000]);
  });

  it("keeps provider errors on cause and reports them to the observer only", async () => {
    const events: SessionSandboxErrorEvent[] = [];
    const sandbox = openSessionSandbox(
      driverStub({
        acquire: async () => { throw new Error("secret-bearing provider detail"); },
      }),
      CONTEXT,
      {
        retry: { maxAttempts: 1 },
        onError: (event) => {
          events.push(event);
          throw new Error("observer bug");
        },
      },
    );

    const error = await sandbox.whenReady(WAIT).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxProvisionFailedError);
    expect((error as SandboxProvisionFailedError).toolMessage).not.toContain("secret");
    expect(((error as Error).cause as Error).message).toBe("secret-bearing provider detail");
    expect(events).toEqual([
      { kind: "attempt_failed", attempt: 1, error: expect.any(Error) },
    ]);
  });

  it("retries after a driver that throws synchronously", async () => {
    let calls = 0;
    const sandbox = openSessionSandbox(
      driverStub({
        acquire: (() => {
          calls += 1;
          if (calls === 1) throw new Error("sync failure");
          return Promise.resolve(sandboxStub());
        }) as SessionSandboxDriver["acquire"],
      }),
      CONTEXT,
      { retry: { maxAttempts: 1 } },
    );

    await expect(sandbox.whenReady(WAIT)).rejects.toBeInstanceOf(SandboxProvisionFailedError);
    expect(sandbox.state()).toMatchObject({ phase: "failed", attempts: 1 });
    sandbox.provision();
    await expect(sandbox.whenReady(WAIT)).resolves.toBeTruthy();
    expect(calls).toBe(2);
  });

  it("stops backing off when released", async () => {
    const release = vi.fn(async () => undefined);
    const sandbox = openSessionSandbox(
      driverStub({ acquire: async () => { throw new Error("down"); }, release }),
      CONTEXT,
      { retry: { maxAttempts: 3, backoffMs: () => 60_000 } },
    );
    sandbox.provision();
    await vi.waitFor(() => expect(sandbox.state()).toMatchObject({ step: "backoff" }));

    await sandbox.release("unused");

    expect(sandbox.state()).toEqual({ phase: "released", reason: "unused" });
    expect(release).not.toHaveBeenCalled();
  });

  it("reports a failed release without rejecting release()", async () => {
    const events: SessionSandboxErrorEvent[] = [];
    const sandbox = openSessionSandbox(
      driverStub({ release: async () => { throw new Error("provider 500"); } }),
      CONTEXT,
      { onError: (event) => events.push(event) },
    );
    await sandbox.whenReady(WAIT);

    await expect(sandbox.release("deleted")).resolves.toBeUndefined();

    expect(events).toEqual([
      { kind: "release_failed", reason: "deleted", error: expect.any(Error) },
    ]);
  });

  it("ignores provision() after release and never leaves the released state", async () => {
    const acquire = vi.fn(async () => sandboxStub());
    const sandbox = openSessionSandbox(driverStub({ acquire }), CONTEXT);
    await sandbox.release("archived");

    sandbox.provision();

    expect(acquire).not.toHaveBeenCalled();
    const error = await sandbox.whenReady(WAIT).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SandboxReleasedError);
    expect((error as SandboxReleasedError).reason).toBe("archived");
  });

  it("releases a sandbox whose preparation is interrupted by release", async () => {
    let finishPrepare!: () => void;
    const prepared = new Promise<void>((resolve) => { finishPrepare = resolve; });
    const release = vi.fn(async () => undefined);
    const sandbox = openSessionSandbox(
      driverStub({ prepare: () => prepared, release }),
      CONTEXT,
    );
    sandbox.provision();
    await vi.waitFor(() => expect(sandbox.state()).toMatchObject({ step: "prepare" }));

    await sandbox.release("deleted");
    finishPrepare();

    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
    expect(release.mock.calls[0]![0]).toMatchObject({ reason: "deleted" });
    expect(sandbox.current()).toBeNull();
  });
});

describe("withSandboxReadinessBarrier", () => {
  it("exposes only the declared methods", async () => {
    const sandbox = openSessionSandbox(driverStub(), CONTEXT);

    const plain = withSandboxReadinessBarrier(sandbox, WAIT);
    const bytes = withSandboxReadinessBarrier(sandbox, {
      ...WAIT,
      optionalMethods: ["readFileBytes"],
    });

    expect(Object.keys(plain).sort()).toEqual(["exec", "readFile", "writeFile"]);
    expect("readFileBytes" in plain).toBe(false);
    expect(Object.keys(bytes).sort()).toEqual(["exec", "readFile", "readFileBytes", "writeFile"]);
    expect(Object.isFrozen(plain)).toBe(true);
    await expect(plain.exec("ls")).resolves.toBe("ran ls");
  });

  it("fails closed when a declared optional method is missing on the prepared sandbox", async () => {
    const sandbox = openSessionSandbox(driverStub(), CONTEXT);
    const barrier = withSandboxReadinessBarrier(sandbox, {
      ...WAIT,
      optionalMethods: ["writeFileBytes"],
    });

    await expect(barrier.writeFileBytes("/workspace/a.bin", new Uint8Array([1])))
      .rejects.toBeInstanceOf(SandboxCapabilityMissingError);
  });

  it("forwards declared optional methods to the prepared sandbox", async () => {
    const readFileBytes = vi.fn(async () => new Uint8Array([7]));
    const sandbox = openSessionSandbox(
      driverStub({ acquire: async () => sandboxStub({ readFileBytes }) }),
      CONTEXT,
    );
    const barrier = withSandboxReadinessBarrier(sandbox, {
      ...WAIT,
      optionalMethods: ["readFileBytes"],
    });

    await expect(barrier.readFileBytes("/workspace/a.bin")).resolves.toEqual(new Uint8Array([7]));
    expect(readFileBytes).toHaveBeenCalledWith("/workspace/a.bin");
  });

  it("rejects invalid options at construction", () => {
    const sandbox = openSessionSandbox(driverStub(), CONTEXT);

    expect(() => withSandboxReadinessBarrier(sandbox, { timeoutMs: Number.POSITIVE_INFINITY }))
      .toThrow(TypeError);
    expect(() => withSandboxReadinessBarrier(sandbox, {
      ...WAIT,
      optionalMethods: ["destroy" as "startProcess"],
    })).toThrow(/unsupported optional sandbox barrier method: destroy/);
  });
});
