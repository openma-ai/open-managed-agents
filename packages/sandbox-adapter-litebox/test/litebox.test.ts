import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  instances: [] as FakeBox[],
  options: [] as Array<Record<string, unknown>>,
  native: new Map<string, ReturnType<typeof nativeBox>>(),
  get: vi.fn(async (id: string): Promise<ReturnType<typeof nativeBox> | null> => sdk.native.get(id) ?? null),
  remove: vi.fn(async (id: string) => { await sdk.native.get(id)?.source.stop(); sdk.native.delete(id); }),
}));

vi.mock("@boxlite-ai/boxlite", () => ({
  JsBoxlite: class {
    async create(options: Record<string, unknown>, name: string) {
      sdk.options.push({ ...options, name });
      const id = `physical-${sdk.native.size + 1}`;
      const value = nativeBox(id, name, sdk.instances.shift() ?? fakeBox());
      sdk.native.set(id, value);
      return value;
    }
    get = sdk.get;
    remove = sdk.remove;
  },
  SimpleBox: class {
    constructor(options: Record<string, unknown>) {
      sdk.options.push(options);
      const box = sdk.instances.shift();
      if (!box) throw new Error("fake box missing");
      return box;
    }
  },
}));

import { LiteBoxSandbox, sandboxFactory } from "../src/litebox";

function fakeBox() {
  return {
    exec: vi.fn(async () => ({ exitCode: 0, stdout: "ok\n", stderr: "" })),
    copyIn: vi.fn(async () => {}),
    copyOut: vi.fn(async (_source: string, destination: string) => { await fs.writeFile(destination, "content"); }),
    stop: vi.fn(async () => {}),
  };
}

type FakeBox = ReturnType<typeof fakeBox>;

function nativeBox(id: string, name: string, source: FakeBox) {
  return {
    id, name, source,
    async exec(command: string, args: string[], env: Array<[string, string]>, _tty: boolean, user?: string, timeoutSecs?: number, cwd?: string) {
      const result = await (source.exec as (...args: unknown[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>)(command, args, Object.fromEntries(env), { user, timeoutSecs, cwd });
      const stream = (text: string) => { let sent = false; return { next: async () => { if (sent) return null; sent = true; return text; } }; };
      return { stdout: async () => stream(result.stdout), stderr: async () => stream(result.stderr), wait: async () => ({ exitCode: result.exitCode }) };
    },
    copyIn: source.copyIn, copyOut: source.copyOut,
  };
}

function queueBox() {
  const box = fakeBox();
  sdk.instances.push(box);
  return box;
}

const originalEnv = {
  memory: process.env.MEMORY_BLOB_DIR,
  outputs: process.env.FILES_BLOB_DIR,
};

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  sdk.instances.length = 0;
  sdk.options.length = 0;
  sdk.native.clear();
  sdk.get.mockClear();
  sdk.remove.mockClear();
  delete process.env.MEMORY_BLOB_DIR;
  delete process.env.FILES_BLOB_DIR;
});

afterEach(() => {
  restore("MEMORY_BLOB_DIR", originalEnv.memory);
  restore("FILES_BLOB_DIR", originalEnv.outputs);
  vi.restoreAllMocks();
});

describe("LiteBoxSandbox", () => {
  it("stages durable Session outputs before allocation and preserves the mount on rebind", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "litebox-bound-outputs-"));
    const context = { workspaceId: "tenant", sessionId: "session", allocationId: "allocation", workdir: root, outputsRoot: join(root, "outputs") };
    const sandbox = await sandboxFactory(context, {});
    const binding = sandboxFactory.runtimeBinding!;
    const handle = JSON.parse(JSON.stringify(binding.getHandle(sandbox)));
    try {
      expect(sdk.options[0]!.volumes).toEqual([
        { hostPath: join(root, "outputs", "tenant", "session"), guestPath: "/mnt/session/outputs", readOnly: false },
      ]);
      expect(sandbox.sessionOutputMountCapabilities!()).toEqual({ durability: "durable" });
      // The factory returns a durable handle before the orchestrator configures outputs.
      await sandbox.mountSessionOutputs!({ tenantId: "tenant", sessionId: "session" });
      const resumed = await binding.resume(handle, context, {});
      await resumed.mountSessionOutputs!({ tenantId: "tenant", sessionId: "session" });
      expect(binding.getHandle(resumed)).toEqual(handle);
      expect(sdk.options).toHaveLength(1);
      await expect(resumed.mountSessionOutputs!({ tenantId: "other", sessionId: "session" })).rejects.toThrow("box already created");
      await expect(binding.resume(handle, { ...context, outputsRoot: join(root, "other") }, {})).rejects.toThrow("output mount");
    } finally {
      await sandbox.destroy!();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rebinds a retained native box on the same host/home with no get-or-create fallback", async () => {
    const context = { workspaceId: "tenant", environmentId: "env", sessionId: "session", allocationId: "physical-a", workdir: undefined } as never;
    const first = await sandboxFactory(context, {});
    const binding = sandboxFactory.runtimeBinding!;
    const handle = JSON.parse(JSON.stringify(binding.getHandle(first)));
    expect(handle).toMatchObject({ provider: "litebox", runtimeId: "physical-1" });
    expect(sdk.options[0]).toMatchObject({ autoRemove: false, detach: true });
    const resumed = await binding.resume(handle, context, {});
    expect(binding.getHandle(resumed)).toEqual(handle);
    expect(await resumed.readFile("retained")).toBe("content");
    expect(await resumed.exec("command")).toBe("ok");
    expect(sdk.options).toHaveLength(1);
    await expect(binding.resume({ ...handle, metadata: { ...handle.metadata, host: "another-host" } }, context, {})).rejects.toThrow("host");
    await expect(binding.resume(handle, context, { LITEBOX_HOME: "/other-runtime" })).rejects.toThrow("runtime home");
    sdk.remove.mockRejectedValueOnce(new Error("removal response lost"));
    await expect(resumed.destroy!()).rejects.toThrow("removal response lost");
    sdk.remove.mockResolvedValueOnce();
    await expect(resumed.destroy!()).rejects.toThrow("not confirmed");
    await resumed.destroy!();
    expect(sdk.remove).toHaveBeenCalledWith("physical-1", true);
    await expect(binding.resume(handle, context, {})).rejects.toThrow("no longer exists");
    expect(sdk.options).toHaveLength(1);
    await first.destroy!();
  });

  it("isolates factory allocation names and late stop while preserving legacy Session naming", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "oma-litebox-allocation-"));
    let finishStop!: () => void;
    const oldBox = queueBox(); const freshBox = queueBox(); const legacyBox = queueBox();
    oldBox.stop.mockImplementation(() => new Promise<void>(resolve => { finishStop = resolve; }));
    const context = { sessionId: "same-logical-session", workspaceId: "workspace", environmentId: "env", workdir: root };
    const a = await sandboxFactory({ ...context, allocationId: "runtime_shared_prefix_a" }, {});
    const b = await sandboxFactory({ ...context, allocationId: "runtime_shared_prefix_b" }, {});
    const legacy = await sandboxFactory(context, {});
    try {
      await a.exec("initial"); await b.exec("initial"); await legacy.exec("initial");
      expect(sdk.options[0]!.name).not.toBe(sdk.options[1]!.name);
      expect(sdk.options[0]!.name).toMatch(/^oma-[a-f0-9]{30,32}$/);
      expect(sdk.options[2]!.name).toBe("oma-same-logical-session");
      expect(sandboxFactory.capabilities?.allocationIsolation).toBe(true);
      expect(sandboxFactory.runtimeBinding?.provider).toBe("litebox");
      const deleting = a.destroy!();
      await vi.waitFor(() => expect(oldBox.stop).toHaveBeenCalledOnce());
      expect(await b.exec("while old stop is pending")).toBe("ok");
      finishStop(); await deleting;
      expect(freshBox.stop).not.toHaveBeenCalled();
      expect(legacyBox.stop).not.toHaveBeenCalled();
      expect(await b.exec("after old stop")).toBe("ok");
    } finally {
      finishStop?.();
      await b.destroy?.(); await legacy.destroy?.();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("creates lazily once with default options and executes commands", async () => {
    const box = queueBox();
    const sandbox = new LiteBoxSandbox();
    await expect(sandbox.exec("one")).resolves.toBe("ok");
    await expect(sandbox.exec("two")).resolves.toBe("ok");
    expect(sdk.options).toEqual([{
      image: "node:22-bookworm",
      memoryMib: undefined,
      cpus: undefined,
      name: undefined,
      volumes: [],
      network: { mode: "enabled" },
    }]);
    expect(box.exec).toHaveBeenNthCalledWith(1, "mkdir", ["-p", "/workspace"]);
    expect(box.exec).toHaveBeenNthCalledWith(2, "sh", ["-c", "one"], {}, {
      cwd: "/workspace",
      timeoutSecs: 120,
    });
    expect(box.exec).toHaveBeenNthCalledWith(3, "sh", ["-c", "two"], {}, {
      cwd: "/workspace",
      timeoutSecs: 120,
    });
    await expect(sandbox.startProcess("ignored")).resolves.toBeNull();
    await sandbox.destroy();
  });

  it("maps output, minimum/default timeouts, env, secrets, and failures", async () => {
    const box = queueBox();
    box.exec
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 4, stdout: "out\n", stderr: "err\n" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "out", stderr: "err" })
      .mockRejectedValueOnce(new Error("offline"));
    const sandbox = new LiteBoxSandbox({ image: "image:1", memoryMib: 512, cpus: 2, name: "named", defaultTimeoutMs: 100 });
    await sandbox.setEnvVars({ A: "1" });
    await sandbox.setEnvVars({ B: "2" });
    sandbox.registerCommandSecrets("git ", { TOKEN: "secret" });
    sandbox.registerCommandSecrets("npm ", { NPM: "secret" });
    await expect(sandbox.exec("git clone", 1)).resolves.toBe("out\nerr\n[exit 4]");
    await expect(sandbox.exec("echo clean")).resolves.toBe("out\nerr");
    await expect(sandbox.exec("npm install")).rejects.toThrow("offline");
    expect(box.exec.mock.calls[1]?.[2]).toEqual({ A: "1", B: "2", TOKEN: "secret" });
    expect(box.exec.mock.calls[2]?.[2]).toEqual({ A: "1", B: "2" });
    expect(box.exec.mock.calls[1]?.[3]).toEqual({ cwd: "/workspace", timeoutSecs: 1 });
    expect(sdk.options[0]).toMatchObject({ image: "image:1", memoryMib: 512, cpus: 2, name: "named" });
    await sandbox.destroy();
  });

  it("explains a missing optional SDK", async () => {
    vi.resetModules();
    vi.doMock("@boxlite-ai/boxlite", () => { throw new Error("not installed"); });
    const fresh = await import("../src/litebox");
    const missing = new fresh.LiteBoxSandbox({ logger: { warn: vi.fn(), log: vi.fn() } });
    await expect(missing.exec("x")).rejects.toThrow("failed to load '@boxlite-ai/boxlite'");
    await expect(missing.destroy()).rejects.toThrow("failed to load '@boxlite-ai/boxlite'");
    await fs.rm((missing as unknown as { tmpRoot: string }).tmpRoot, { recursive: true, force: true });
    vi.doUnmock("@boxlite-ai/boxlite");
    vi.doMock("@boxlite-ai/boxlite", () => ({
      JsBoxlite: class {
        async create(options: Record<string, unknown>, name: string) {
          sdk.options.push({ ...options, name });
          const id = `physical-${sdk.native.size + 1}`;
          const value = nativeBox(id, name, sdk.instances.shift() ?? fakeBox());
          sdk.native.set(id, value);
          return value;
        }
        get = sdk.get;
        remove = sdk.remove;
      },
      SimpleBox: class {
        constructor(options: Record<string, unknown>) {
          sdk.options.push(options);
          const box = sdk.instances.shift();
          if (!box) throw new Error("fake box missing");
          return box as never;
        }
      },
    }));
  });

  it("mounts memory and outputs from explicit roots before construction", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "openma-litebox-roots-"));
    queueBox();
    const warn = vi.fn();
    const sandbox = new LiteBoxSandbox({ memoryRoot: join(root, "memory"), outputsRoot: join(root, "outputs"), logger: { warn, log: vi.fn() } });
    expect(sandbox.sessionOutputMountCapabilities()).toEqual({ durability: "durable" });
    await sandbox.mountMemoryStore({ storeName: "memory", storeId: "store", readOnly: true });
    await sandbox.mountSessionOutputs({ tenantId: "tenant", sessionId: "session" });
    await sandbox.exec("x");
    expect(sdk.options[0]?.volumes).toEqual([
      { hostPath: join(root, "memory", "store"), guestPath: "/mnt/memory/memory", readOnly: true },
      { hostPath: join(root, "outputs", "tenant", "session"), guestPath: "/mnt/session/outputs", readOnly: false },
    ]);
    expect(warn).not.toHaveBeenCalled();
    await sandbox.destroy();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("supports legacy env roots with warnings and reports missing/late mount configuration", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "openma-litebox-env-"));
    process.env.MEMORY_BLOB_DIR = join(root, "memory");
    process.env.FILES_BLOB_DIR = join(root, "outputs");
    const warn = vi.fn();
    queueBox();
    const sandbox = new LiteBoxSandbox({ logger: { warn, log: vi.fn() } });
    expect(sandbox.sessionOutputMountCapabilities()).toEqual({ durability: "durable" });
    await sandbox.mountMemoryStore({ storeName: "m", storeId: "s", readOnly: false });
    await sandbox.mountSessionOutputs({ tenantId: "t", sessionId: "s" });
    expect(warn).toHaveBeenCalledTimes(2);
    await sandbox.exec("x");
    await expect(sandbox.mountMemoryStore({ storeName: "late", storeId: "s", readOnly: false })).rejects.toThrow("box already created");
    await expect(sandbox.mountSessionOutputs({ tenantId: "late", sessionId: "s" })).rejects.toThrow("box already created");
    await sandbox.destroy();

    delete process.env.MEMORY_BLOB_DIR;
    delete process.env.FILES_BLOB_DIR;
    const missing = new LiteBoxSandbox();
    expect(missing.sessionOutputMountCapabilities()).toBeNull();
    await expect(missing.mountMemoryStore({ storeName: "m", storeId: "s", readOnly: false })).rejects.toThrow("memoryRoot not provided");
    await expect(missing.mountSessionOutputs({ tenantId: "t", sessionId: "s" })).rejects.toThrow("outputsRoot not provided");
    await missing.destroy();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("copies text and bytes in both directions with relative and absolute paths", async () => {
    const box = queueBox();
    box.copyOut
      .mockImplementationOnce(async (_source, destination) => { await fs.writeFile(destination, "text"); })
      .mockImplementationOnce(async (_source, destination) => { await fs.writeFile(destination, new Uint8Array([1, 2, 3])); });
    const sandbox = new LiteBoxSandbox();
    await expect(sandbox.readFile("relative.txt")).resolves.toBe("text");
    await expect(sandbox.readFileBytes("/absolute.bin")).resolves.toEqual(new Uint8Array([1, 2, 3]));
    await expect(sandbox.writeFile("relative.txt", "hello")).resolves.toBe("/workspace/relative.txt");
    await expect(sandbox.writeFileBytes("/absolute.bin", new Uint8Array([4, 5]))).resolves.toBe("/absolute.bin");
    expect(box.copyOut.mock.calls[0]?.[0]).toBe("/workspace/relative.txt");
    expect(box.copyOut.mock.calls[1]?.[0]).toBe("/absolute.bin");
    expect(box.copyIn.mock.calls[0]?.[1]).toBe("/workspace/relative.txt");
    expect(box.copyIn.mock.calls[1]?.[1]).toBe("/absolute.bin");
    expect(box.exec).toHaveBeenCalledWith("mkdir", ["-p", "/workspace"]);
    expect(box.exec).toHaveBeenCalledWith("mkdir", ["-p", "/"]);
    await sandbox.destroy();
  });

  it("cleans staging paths even when copy operations or cleanup fail", async () => {
    const box = queueBox();
    box.copyOut.mockRejectedValueOnce(new Error("copy out"));
    box.copyIn.mockRejectedValueOnce(new Error("copy in"));
    const sandbox = new LiteBoxSandbox();
    await expect(sandbox.readFile("a")).rejects.toThrow("copy out");
    await expect(sandbox.writeFile("b", "x")).rejects.toThrow("copy in");
    await sandbox.destroy();

    const cleanup = queueBox();
    const rm = vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("cleanup"));
    const cleanupFailure = new LiteBoxSandbox();
    await expect(cleanupFailure.readFile("a")).resolves.toBe("content");
    expect(rm).toHaveBeenCalled();
    rm.mockRestore();
    await cleanupFailure.destroy();
    expect(cleanup.copyOut).toHaveBeenCalled();
  });

  it("destroy preserves stop failures and only ignores scratch cleanup failures", async () => {
    const warn = vi.fn();
    const stopped = queueBox();
    stopped.stop.mockRejectedValueOnce(new Error("stop failed"));
    const sandbox = new LiteBoxSandbox({ logger: { warn, log: vi.fn() } });
    await sandbox.exec("x");
    await expect(sandbox.destroy()).rejects.toThrow("stop failed");
    await sandbox.destroy();
    expect(warn).toHaveBeenCalledWith("destroy stop failed: stop failed");
    expect(stopped.stop).toHaveBeenCalledTimes(2);
    expect(sdk.options).toHaveLength(1);

    const rejected = queueBox();
    rejected.exec
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
      .mockRejectedValueOnce(new Error("exec"));
    const createPromise = new LiteBoxSandbox({ logger: { warn, log: vi.fn() } });
    await expect(createPromise.exec("x")).rejects.toThrow("exec");
    await createPromise.destroy();

    const scratchRoot = await fs.mkdtemp(join(tmpdir(), "openma-litebox-cleanup-failure-"));
    const rm = vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("rm"));
    const scratch = new LiteBoxSandbox({ scratchRoot });
    await expect(scratch.destroy()).resolves.toBeUndefined();
    rm.mockRestore();
    await fs.rm(scratchRoot, { recursive: true, force: true });
  });

  it.each([false, true])("rejects the original command response loss after one effect (durable=%s)", async durable => {
    const box = queueBox();
    const root = await fs.mkdtemp(join(tmpdir(), "litebox-command-uncertainty-"));
    const sandbox = durable
      ? await sandboxFactory({ workspaceId: "w", environmentId: "e", sessionId: "s", allocationId: "a", workdir: root }, {})
      : new LiteBoxSandbox({ scratchRoot: root });
    try {
      if (!durable) await sandbox.exec("initialize");
      const cause = new Error("socket closed");
      const failure = new Error("command response lost", { cause });
      let effects = 0;
      box.exec.mockImplementationOnce(async () => { effects++; throw failure; });
      await expect(sandbox.exec("charge-account")).rejects.toBe(failure);
      expect(failure.cause).toBe(cause);
      expect(effects).toBe(1);
      expect(box.exec.mock.calls.filter(call => call[0] === "sh" && call[1]?.[1] === "charge-account")).toHaveLength(1);
    } finally {
      await sandbox.destroy!();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an upload response loss after exactly one remote write", async () => {
    const box = queueBox();
    const failure = new Error("copy response lost");
    let writes = 0;
    box.copyIn.mockImplementationOnce(async () => { writes++; throw failure; });
    const sandbox = new LiteBoxSandbox();
    await expect(sandbox.writeFile("file", "data")).rejects.toBe(failure);
    expect(writes).toBe(1);
    await sandbox.destroy();
  });

  it.each(["wait", "stdout"])("preserves native execution %s failures after dispatch", async phase => {
    queueBox();
    const root = await fs.mkdtemp(join(tmpdir(), "litebox-native-uncertainty-"));
    const sandbox = await sandboxFactory({ workspaceId: "w", environmentId: "e", sessionId: "s", allocationId: "a", workdir: root }, {});
    try {
      const native = sdk.native.get(sandboxFactory.runtimeBinding!.getHandle(sandbox).runtimeId)!;
      const failure = new Error("native execution response lost", { cause: new Error("connection reset") });
      let effects = 0;
      const dispatched = vi.spyOn(native, "exec").mockImplementationOnce(async () => {
        effects++;
        return {
          stdout: async () => ({ next: async () => { if (phase === "stdout") throw failure; return null; } }),
          stderr: async () => ({ next: async () => null }),
          wait: async () => { if (phase === "wait") throw failure; return { exitCode: 0 }; },
        };
      });
      await expect(sandbox.exec("charge-account")).rejects.toBe(failure);
      expect(dispatched).toHaveBeenCalledTimes(1);
      expect(effects).toBe(1);
    } finally {
      await sandbox.destroy!();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("factory maps optional provider construction settings", async () => {
    const configured = await sandboxFactory(
      { sessionId: "session", memoryRoot: "/memory", outputsRoot: "/outputs" } as never,
      { SANDBOX_IMAGE: "image", LITEBOX_MEMORY_MIB: "1024", LITEBOX_CPUS: "4" },
    );
    const defaults = await sandboxFactory({ sessionId: "session" } as never, {});
    expect(configured).toBeInstanceOf(LiteBoxSandbox);
    expect(defaults).toBeInstanceOf(LiteBoxSandbox);
    await configured.destroy();
    await defaults.destroy();
  });

  it("factory rejects a prepared sandbox base", async () => {
    await expect(sandboxFactory(
      { sessionId: "session", preparedBase: { provider: "litebox", id: "base_1" } } as never,
      { SANDBOX_IMAGE: "image" },
    )).rejects.toThrow("SANDBOX_PROVIDER=litebox cannot create a sandbox from a prepared base");
  });

  it("factory prefers an Environment-selected catalog image over SANDBOX_IMAGE", async () => {
    const selected = await sandboxFactory(
      { sessionId: "session", image: { alias: "analytics", reference: "registry.example/analytics:1" } } as never,
      { SANDBOX_IMAGE: "image" },
    );
    expect((selected as unknown as { opts: { image?: string } }).opts.image).toBe("registry.example/analytics:1");
    const fallback = await sandboxFactory({ sessionId: "session" } as never, { SANDBOX_IMAGE: "image" });
    expect((fallback as unknown as { opts: { image?: string } }).opts.image).toBe("image");
    await selected.destroy();
    await fallback.destroy();
  });

  it("factory scopes copy staging to the session workdir lifecycle", async () => {
    const workdir = await fs.mkdtemp(join(tmpdir(), "openma-litebox-session-"));
    const sandbox = await sandboxFactory({ sessionId: "session", workdir }, {});

    const scratchEntries = await fs.readdir(join(workdir, ".openma"));
    expect(scratchEntries).toHaveLength(1);
    expect(scratchEntries[0]).toMatch(/^litebox-scratch-/);

    await sandbox.destroy();
    await expect(fs.readdir(join(workdir, ".openma"))).resolves.toEqual([]);
    await fs.rm(workdir, { recursive: true, force: true });
  });

  it("default logger callbacks remain usable", async () => {
    const box = queueBox();
    box.stop.mockRejectedValueOnce(new Error("stop"));
    const sandbox = new LiteBoxSandbox();
    await sandbox.exec("x");
    await expect(sandbox.destroy()).rejects.toThrow("stop");
    await sandbox.destroy();
  });
});
