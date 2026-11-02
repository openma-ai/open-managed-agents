import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  create: vi.fn(async (template: string) => makeSdkSandbox(`created:${template}`)),
  connect: vi.fn(async (sandboxId: string) => makeSdkSandbox(`connected:${sandboxId}`)),
}));

function makeSdkSandbox(sandboxId: string) {
  return {
    sandboxId,
    commands: { run: vi.fn() },
    files: { read: vi.fn(), write: vi.fn() },
    kill: vi.fn(),
    getInfo: vi.fn(async () => ({ state: "running" })),
    setTimeout: vi.fn(async () => {}),
    pause: vi.fn(async () => true),
    connect: vi.fn(async function (this: unknown) { return this; }),
    createSnapshot: vi.fn(async () => ({
      snapshotId: "snap_default",
      names: ["project/default:v1"],
    })),
  };
}

vi.mock("e2b", () => ({
  Sandbox: { create: sdk.create, connect: sdk.connect },
}));

import * as e2bAdapter from "../src/e2b";
import { sandboxFactory } from "../src/e2b";
import { E2BSandboxExecutor } from "../src/e2b";

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let value = "";
  for (;;) {
    const item = await reader.read();
    if (item.done) return value + decoder.decode();
    value += decoder.decode(item.value, { stream: true });
  }
}

describe("E2B SDK v2 adapter", () => {
  beforeEach(() => {
    sdk.create.mockClear();
    sdk.connect.mockClear();
  });

  it("passes the template and self-hosted endpoints using the official v2 shape", async () => {
    await sandboxFactory(
      { sessionId: "session_e2b", workdir: "/tmp/unused" },
      {
        E2B_API_KEY: "local",
        E2B_API_URL: "http://127.0.0.1:3000",
        E2B_SANDBOX_URL: "http://127.0.0.1:3002",
        E2B_DOMAIN: "localhost",
        SANDBOX_IMAGE: "code-interpreter",
      },
    );

    expect(sdk.create).toHaveBeenCalledWith("code-interpreter", {
      apiKey: "local",
      apiUrl: "http://127.0.0.1:3000",
      sandboxUrl: "http://127.0.0.1:3002",
      domain: "localhost",
      timeoutMs: 30 * 60_000,
      lifecycle: {
        onTimeout: { action: "pause", keepMemory: true },
        autoResume: true,
      },
    });
  });

  it("gives the sandbox the configured lifetime and leaves renewal to the host lease", async () => {
    const executor = await sandboxFactory(
      { sessionId: "session_lifetime", workdir: "/tmp/unused" },
      { E2B_API_KEY: "local", E2B_SANDBOX_TIMEOUT_MS: "3600000" },
    );
    expect(sdk.create).toHaveBeenCalledWith("base", expect.objectContaining({ timeoutMs: 3_600_000 }));
    const sandbox = await sdk.create.mock.results.at(-1)!.value as ReturnType<typeof makeSdkSandbox>;
    sandbox.commands.run.mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0 });
    await executor.exec("true");
    expect(sandbox.setTimeout).not.toHaveBeenCalled();
    await (executor as unknown as E2BSandboxExecutor).renewLease({ ttlMs: 600_000 });
    expect(sandbox.setTimeout).toHaveBeenCalledWith(600_000);
  });

  it("rejects a malformed sandbox lifetime", async () => {
    await expect(
      sandboxFactory(
        { sessionId: "session_bad_lifetime", workdir: "/tmp/unused" },
        { E2B_API_KEY: "local", E2B_SANDBOX_TIMEOUT_MS: "soon" },
      ),
    ).rejects.toThrow(/E2B_SANDBOX_TIMEOUT_MS/);
    expect(sdk.create).not.toHaveBeenCalled();
  });

  it("passes creation metadata from JSON to E2B-compatible providers", async () => {
    await sandboxFactory(
      { sessionId: "session_dynamic", workdir: "/tmp/unused" },
      {
        E2B_API_KEY: "local",
        SANDBOX_IMAGE: "design-worker-dynamic",
        E2B_CREATE_METADATA: JSON.stringify({
          "e2b.agents.kruise.io/image": "txharbor.example/openma-sandbox:v1",
          "e2b.agents.kruise.io/create-on-no-stock": "true",
        }),
      },
    );

    expect(sdk.create).toHaveBeenCalledWith(
      "design-worker-dynamic",
      expect.objectContaining({
        metadata: {
          "e2b.agents.kruise.io/image": "txharbor.example/openma-sandbox:v1",
          "e2b.agents.kruise.io/create-on-no-stock": "true",
        },
      }),
    );
  });

  it("rejects malformed creation metadata before calling the provider", async () => {
    await expect(
      sandboxFactory(
        { sessionId: "session_bad_metadata", workdir: "/tmp/unused" },
        { E2B_API_KEY: "local", E2B_CREATE_METADATA: "not-json" },
      ),
    ).rejects.toThrow(/E2B_CREATE_METADATA.*JSON/);
    expect(sdk.create).not.toHaveBeenCalled();
  });

  it("rejects non-string creation metadata values", async () => {
    await expect(
      sandboxFactory(
        { sessionId: "session_bad_metadata_value", workdir: "/tmp/unused" },
        { E2B_API_KEY: "local", E2B_CREATE_METADATA: '{"image":42}' },
      ),
    ).rejects.toThrow(/E2B_CREATE_METADATA.*string values/);
    expect(sdk.create).not.toHaveBeenCalled();
  });

  it("reports a non-zero exit the way the official SDK signals it: a rejected CommandExitError", async () => {
    // e2b v2 never resolves commands.run() with exitCode !== 0; it rejects with
    // an error that implements CommandResult.
    class CommandExitError extends Error {
      constructor(readonly exitCode: number, readonly stdout: string, readonly stderr: string) {
        super(`exit status ${exitCode}`);
      }
    }
    const sandbox = makeSdkSandbox("exit-codes");
    sandbox.commands.run.mockRejectedValueOnce(new CommandExitError(1, "partial\n", "ls: no such file\n"));
    const adapter = new E2BSandboxExecutor(sandbox as never, {});

    await expect(adapter.exec("ls /missing")).resolves.toBe("partial\nls: no such file\n[exit 1]");
  });

  it("still surfaces transport failures from exec as errors", async () => {
    const sandbox = makeSdkSandbox("transport");
    sandbox.commands.run.mockRejectedValueOnce(new Error("[unauthenticated] invalid username: 'user'"));
    const adapter = new E2BSandboxExecutor(sandbox as never, {});

    await expect(adapter.exec("id")).rejects.toThrow("invalid username");
  });

  it("records a background process's non-zero exit instead of leaving it running forever", async () => {
    const sandbox = makeSdkSandbox("background");
    let reject!: (error: unknown) => void;
    sandbox.commands.run.mockResolvedValueOnce({
      pid: 41,
      kill: async () => true,
      wait: () => new Promise((_, r) => { reject = r; }),
    });
    const adapter = new E2BSandboxExecutor(sandbox as never, {});
    const handle = (await adapter.startProcess("node server.js"))!;
    expect(await handle.getStatus()).toBe("running");

    reject(Object.assign(new Error("exit status 3"), { exitCode: 3, stdout: "boot\n", stderr: "crash\n" }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(await handle.getStatus()).toBe("error");
    expect(await handle.getLogs()).toEqual({ stdout: "boot\n", stderr: "crash\n" });
  });

  it.each(["BAD=NAME", "BAD;echo injected", "-u", ""])("rejects invalid duplex env names before remote execution: %s", async name => {
    const sandbox = makeSdkSandbox("bad-env");
    const adapter = new E2BSandboxExecutor(sandbox as never, {});
    await expect(adapter.spawnDuplexProcess({ command: "node", env: { [name]: undefined } })).rejects.toThrow(/environment variable name/i);
    expect(sandbox.commands.run).not.toHaveBeenCalled();
  });

  it("removes inherited credentials from the remote duplex process environment", async () => {
    let launch = "";
    const sandbox = makeSdkSandbox("unset");
    sandbox.commands.run.mockImplementation(async (command: string, options: { envs: Record<string, string> }) => {
      launch = command;
      expect(options.envs).not.toHaveProperty("ANTHROPIC_API_KEY");
      return { wait: async () => ({ exitCode: 0 }), sendStdin: async () => {}, closeStdin: async () => {}, kill: async () => {} };
    });
    const adapter = new E2BSandboxExecutor(sandbox as never, {});
    const child = await adapter.spawnDuplexProcess({ command: "node", args: ["-e", "process.stdout.write(process.env.ANTHROPIC_API_KEY ?? 'absent')"], env: { ANTHROPIC_API_KEY: undefined } });
    await child.exited;
    // Execute the actual remote command under an inherited secret, not just
    // an assertion on the SDK mock's object shape.
    const { execFileSync } = await import("node:child_process");
    expect(execFileSync("sh", ["-c", launch], { env: { ...process.env, ANTHROPIC_API_KEY: "test-inherited-key" }, encoding: "utf8" })).toBe("absent");
  });

  it("uses the official live-stdin command channel for ACP", async () => {
    let commandOptions:
      | {
          background?: boolean;
          stdin?: boolean;
          timeoutMs?: number;
          cwd?: string;
          envs?: Record<string, string>;
          onStdout?(data: string): void;
          onStderr?(data: string): void;
        }
      | undefined;
    let finish!: (result: { stdout: string; stderr: string; exitCode: number }) => void;
    const wait = new Promise<{ stdout: string; stderr: string; exitCode: number }>(
      (resolve) => { finish = resolve; },
    );
    const handle = {
      pid: 73,
      async sendStdin(data: Uint8Array) {
        commandOptions?.onStdout?.(new TextDecoder().decode(data));
      },
      async closeStdin() {},
      async kill() { return true; },
      wait: () => wait,
    };
    const adapter = new E2BSandboxExecutor({
      commands: {
        async run(_command: string, options: typeof commandOptions) {
          commandOptions = options;
          return handle;
        },
      },
      files: { async read() { return ""; }, async write() {} },
      async kill() {},
    } as never, {});

    const child = await adapter.spawnDuplexProcess({
      command: "agent",
      args: ["--acp"],
      cwd: "/workspace",
      env: { MODEL: "test" },
    });
    const stdout = readAll(child.stdout);
    const stderr = readAll(child.stderr);
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode('{"id":1}\n'));
    await writer.write(new TextEncoder().encode('{"id":2}\n'));
    await writer.close();
    commandOptions?.onStderr?.("diagnostic");
    finish({ stdout: "", stderr: "", exitCode: 0 });

    expect(commandOptions).toMatchObject({
      background: true,
      stdin: true,
      timeoutMs: 0,
      cwd: "/workspace",
      envs: { MODEL: "test" },
    });
    await expect(child.exited).resolves.toEqual({ code: 0, signal: null });
    await expect(stdout).resolves.toBe('{"id":1}\n{"id":2}\n');
    await expect(stderr).resolves.toBe("diagnostic");
  });

  it("maps lease, suspend, resume and durable checkpoint to the official E2B lifecycle", async () => {
    const calls: unknown[] = [];
    const sandbox = {
      ...makeSdkSandbox("sb_runtime_01"),
      async getInfo() { return { state: "paused" as const }; },
      async setTimeout(timeoutMs: number) { calls.push(["setTimeout", timeoutMs]); },
      async pause(options: { keepMemory?: boolean }) {
        calls.push(["pause", options]);
        return true;
      },
      async connect() {
        calls.push(["connect"]);
        return this;
      },
      async createSnapshot(options: { name?: string }) {
        calls.push(["createSnapshot", options]);
        return {
          snapshotId: "snap_checkpoint_01",
          names: ["project/checkpoint:v1"],
        };
      },
    };
    const adapter = new E2BSandboxExecutor(sandbox as never, {});
    const runtime = adapter as unknown as {
      runtimeHandle(): { provider: string; runtimeId: string };
      runtimeCapabilities(): {
        lease: boolean;
        suspend: string[];
        checkpoint: string[];
      };
      status(): Promise<string>;
      renewLease(input: { ttlMs: number }): Promise<void>;
      suspend(input: { kind: "filesystem" | "memory" }): Promise<unknown>;
      resume(checkpoint: unknown): Promise<void>;
      checkpoint(input: { kind: "memory"; name: string }): Promise<unknown>;
    };

    expect(runtime.runtimeHandle()).toEqual({
      provider: "e2b",
      runtimeId: "sb_runtime_01",
    });
    expect(runtime.runtimeCapabilities()).toEqual({
      lease: true,
      suspend: ["filesystem", "memory"],
      checkpoint: ["memory"],
    });
    await expect(runtime.status()).resolves.toBe("suspended");
    await runtime.renewLease({ ttlMs: 45_000 });
    const suspension = await runtime.suspend({ kind: "memory" });
    expect(suspension).toEqual({
      provider: "e2b",
      checkpointId: "sb_runtime_01",
      sourceRuntimeId: "sb_runtime_01",
      kind: "memory",
      scope: "runtime",
    });
    await runtime.resume(suspension);
    const snapshot = await runtime.checkpoint({
      kind: "memory",
      name: "checkpoint-01",
    });
    expect(snapshot).toEqual({
      provider: "e2b",
      checkpointId: "snap_checkpoint_01",
      sourceRuntimeId: "sb_runtime_01",
      kind: "memory",
      scope: "portable",
    });
    expect(calls).toEqual([
      ["setTimeout", 45_000],
      ["pause", { keepMemory: true }],
      ["connect"],
      ["createSnapshot", { name: "checkpoint-01" }],
    ]);
  });

  it("restores portable snapshots and resumes suspended runtimes through the provider port", async () => {
    const provider = (e2bAdapter as unknown as {
      sandboxProvider?: {
        resume(
          handle: unknown,
          context: { sessionId: string; workdir: string },
          env: Record<string, string>,
        ): Promise<unknown>;
        restore(
          checkpoint: unknown,
          context: { sessionId: string; workdir: string },
          env: Record<string, string>,
        ): Promise<unknown>;
      };
    }).sandboxProvider;
    expect(provider).toBeDefined();

    const context = { sessionId: "session_e2b_restore", workdir: "/tmp/unused" };
    const env = { E2B_API_KEY: "test-key", E2B_DOMAIN: "sandbox.test" };
    const resumed = await provider!.resume({
      provider: "e2b",
      runtimeId: "sb_paused_01",
    }, context, env) as { runtimeHandle(): unknown };
    const restored = await provider!.restore({
      provider: "e2b",
      checkpointId: "snap_portable_01",
      sourceRuntimeId: "sb_source_01",
      kind: "memory",
      scope: "portable",
    }, context, env) as { runtimeHandle(): unknown };

    expect(sdk.connect).toHaveBeenCalledWith("sb_paused_01", {
      apiKey: "test-key",
      apiUrl: undefined,
      sandboxUrl: undefined,
      domain: "sandbox.test",
    });
    expect(sdk.create).toHaveBeenCalledWith("snap_portable_01", {
      apiKey: "test-key",
      apiUrl: undefined,
      sandboxUrl: undefined,
      domain: "sandbox.test",
      timeoutMs: 30 * 60_000,
      lifecycle: {
        onTimeout: { action: "pause", keepMemory: true },
        autoResume: true,
      },
    });
    expect(resumed.runtimeHandle()).toEqual({
      provider: "e2b",
      runtimeId: "connected:sb_paused_01",
    });
    expect(restored.runtimeHandle()).toEqual({
      provider: "e2b",
      runtimeId: "created:snap_portable_01",
    });
  });

  describe("prepared sandbox base", () => {
    it("captures a named snapshot and returns a serializable handle", async () => {
      const executor = await sandboxFactory(
        { sessionId: "builder", workdir: "/tmp/unused" },
        { E2B_API_KEY: "local" },
      ) as E2BSandboxExecutor;
      const raw = await sdk.create.mock.results.at(-1)!.value as ReturnType<typeof makeSdkSandbox>;
      raw.createSnapshot.mockResolvedValueOnce({ snapshotId: "snap_base_01", names: ["oma-base-abc"] });

      await expect(executor.capturePreparedBase({ name: "oma-base-abc" }))
        .resolves.toEqual({ provider: "e2b", id: "snap_base_01" });
      expect(raw.createSnapshot).toHaveBeenCalledWith({ name: "oma-base-abc" });
    });

    it("surfaces a provider that has no snapshot route as a capture failure", async () => {
      // e2b@2.46.1 SandboxError from an E2B-compatible API without /sandboxes/{id}/snapshots.
      class SandboxError extends Error {
        override name = "SandboxError";
      }
      const raw = makeSdkSandbox("sb_no_snapshots");
      raw.createSnapshot.mockRejectedValueOnce(new SandboxError("404: route not found"));
      const executor = new E2BSandboxExecutor(raw as never, {});
      await expect(executor.capturePreparedBase({ name: "oma-base-abc" }))
        .rejects.toMatchObject({ name: "SandboxError", message: "404: route not found" });
      expect(raw.createSnapshot).toHaveBeenCalledTimes(1);
      expect(raw.createSnapshot).toHaveBeenCalledWith({ name: "oma-base-abc" });
      expect(raw.kill).not.toHaveBeenCalled();
    });

    it("refuses to capture when the SDK has no createSnapshot", async () => {
      const raw = makeSdkSandbox("sb_old") as Partial<ReturnType<typeof makeSdkSandbox>>;
      delete raw.createSnapshot;
      const executor = new E2BSandboxExecutor(raw as never, {});
      await expect(executor.capturePreparedBase({ name: "oma-base-abc" }))
        .rejects.toThrow("E2B SDK does not expose sandbox.createSnapshot");
    });

    it("creates from the base instead of the template, keeping lifetime and metadata", async () => {
      const executor = await sandboxFactory(
        {
          sessionId: "session_hit",
          workdir: "/tmp/unused",
          image: { alias: "analytics", reference: "analytics-template" },
          preparedBase: { provider: "e2b", id: "snap_base_01" },
        },
        { E2B_API_KEY: "local", SANDBOX_IMAGE: "code-interpreter", E2B_CREATE_METADATA: '{"team":"a"}' },
      ) as E2BSandboxExecutor;

      expect(sdk.create).toHaveBeenCalledTimes(1);
      expect(sdk.create).toHaveBeenCalledWith("snap_base_01", expect.objectContaining({
        metadata: { team: "a" },
        timeoutMs: 30 * 60_000,
      }));
      expect(executor.runtimeHandle()).toEqual({ provider: "e2b", runtimeId: "created:snap_base_01" });
    });

    it("rejects a prepared base of another provider before calling E2B", async () => {
      await expect(sandboxFactory(
        { sessionId: "s", workdir: "/tmp/unused", preparedBase: { provider: "daytona", id: "x" } },
        { E2B_API_KEY: "local" },
      )).rejects.toThrow("E2B provider cannot create a sandbox from a daytona prepared base");
      expect(sdk.create).not.toHaveBeenCalled();
    });
  });
});
