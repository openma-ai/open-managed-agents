import { describe, expect, it, vi } from "vitest";

import {
  declarePersistenceCapabilities,
  UNDECLARED_PERSISTENCE,
  withSandboxFactoryCapabilities,
  wrapLegacySandboxFactory,
  type SandboxFactory,
  type SandboxPersistenceCapabilities,
  type SandboxPort,
} from "../src/index";

const CONTEXT = { sessionId: "sess_caps", workdir: "/unused" };

function factoryReturning(sandbox: SandboxPort): SandboxFactory {
  return Object.assign(vi.fn(async () => sandbox), {});
}

/** Models a Workers RPC stub: every property looks like a function. Like a
 * real stub it is not a thenable, so it can be awaited. */
function rpcStub(): SandboxPort {
  return new Proxy({}, {
    get: (_target, property) => (property === "then" ? undefined : async () => undefined),
  }) as SandboxPort;
}

describe("declarePersistenceCapabilities", () => {
  it("treats everything undeclared as unsupported", () => {
    expect(UNDECLARED_PERSISTENCE).toEqual({
      workspace: { strategy: "ephemeral" },
      outputs: "unsupported",
      memoryStores: "file_sync",
      runtimeCheckpoint: "unsupported",
      preparedBase: "unsupported",
    });
    expect(Object.isFrozen(UNDECLARED_PERSISTENCE)).toBe(true);
    expect(Object.isFrozen(UNDECLARED_PERSISTENCE.workspace)).toBe(true);
  });

  it("returns a frozen copy of a complete declaration", () => {
    const input = {
      workspace: { strategy: "checkpoint_restore", durability: "durable" },
      outputs: { strategy: "durable_mount", durability: "best_effort" },
      memoryStores: "native_mount",
      runtimeCheckpoint: { kinds: ["filesystem", "process"], durability: "best_effort" },
      preparedBase: { durability: "durable" },
    } satisfies SandboxPersistenceCapabilities;

    const declared = declarePersistenceCapabilities(input);
    (input.runtimeCheckpoint.kinds as string[]).push("filesystem");

    expect(declared).toEqual({
      ...input,
      runtimeCheckpoint: { kinds: ["filesystem", "process"], durability: "best_effort" },
    });
    expect(Object.isFrozen(declared.runtimeCheckpoint)).toBe(true);
    expect(Object.isFrozen((declared.runtimeCheckpoint as { kinds: readonly string[] }).kinds))
      .toBe(true);
  });

  it.each([
    ["an unknown field", { workspaces: { strategy: "ephemeral" } }],
    ["a non-object declaration", "durable"],
    ["a non-object workspace", { workspace: "ephemeral" }],
    ["an unknown workspace strategy", { workspace: { strategy: "nfs", durability: "durable" } }],
    ["a durable workspace without durability", { workspace: { strategy: "durable_mount" } }],
    ["a durability on an ephemeral workspace", { workspace: { strategy: "ephemeral", durability: "durable" } }],
    ["an unknown durability", { workspace: { strategy: "durable_mount", durability: "forever" } }],
    ["an unknown output strategy", { outputs: { strategy: "email", durability: "durable" } }],
    ["a non-object outputs value", { outputs: "durable_mount" }],
    ["an extra output field", { outputs: { strategy: "final_collect", durability: "durable", ttl: 1 } }],
    ["an unknown memory store mode", { memoryStores: "fuse" }],
    ["empty checkpoint kinds", { runtimeCheckpoint: { kinds: [], durability: "durable" } }],
    ["duplicate checkpoint kinds", { runtimeCheckpoint: { kinds: ["process", "process"], durability: "durable" } }],
    ["an unknown checkpoint kind", { runtimeCheckpoint: { kinds: ["memory"], durability: "durable" } }],
    ["a non-object checkpoint value", { runtimeCheckpoint: "process" }],
    ["a prepared base without durability", { preparedBase: {} }],
    ["a non-object prepared base", { preparedBase: "durable" }],
  ])("rejects %s", (_label, declaration) => {
    expect(() => declarePersistenceCapabilities(
      declaration as unknown as Partial<SandboxPersistenceCapabilities>,
    )).toThrow(/Invalid sandbox persistence declaration/);
  });
});

describe("wrapLegacySandboxFactory", () => {
  it("requires a provider name", () => {
    expect(() => wrapLegacySandboxFactory(factoryReturning(rpcStub()), { provider: "", env: {} }))
      .toThrow(TypeError);
  });

  it("folds the factory's own declarations into the persistence declaration", () => {
    const factory = withSandboxFactoryCapabilities(factoryReturning(rpcStub()), {
      nativeMemoryStoreMount: true,
      preparedBase: true,
    });

    const driver = wrapLegacySandboxFactory(factory, {
      provider: "e2b",
      env: {},
      persistence: { workspace: { strategy: "checkpoint_restore", durability: "durable" } },
    });

    expect(driver.provider).toBe("e2b");
    expect(driver.capabilities).toEqual({
      workspace: { strategy: "checkpoint_restore", durability: "durable" },
      outputs: "unsupported",
      memoryStores: "native_mount",
      runtimeCheckpoint: "unsupported",
      preparedBase: { durability: "best_effort" },
    });
  });

  it("allows a downgrade but refuses a declaration the factory does not back", () => {
    const plain = factoryReturning(rpcStub());
    const mounting = withSandboxFactoryCapabilities(plain, { nativeMemoryStoreMount: true });

    expect(wrapLegacySandboxFactory(mounting, {
      provider: "litebox",
      env: {},
      persistence: { memoryStores: "file_sync" },
    }).capabilities.memoryStores).toBe("file_sync");
    expect(() => wrapLegacySandboxFactory(plain, {
      provider: "boxrun",
      env: {},
      persistence: { memoryStores: "native_mount" },
    })).toThrow(/nativeMemoryStoreMount/);
    expect(() => wrapLegacySandboxFactory(plain, {
      provider: "boxrun",
      env: {},
      persistence: { preparedBase: { durability: "durable" } },
    })).toThrow(/preparedBase/);
    expect(wrapLegacySandboxFactory(plain, {
      provider: "boxrun",
      env: {},
      persistence: { preparedBase: "unsupported" },
    }).capabilities.preparedBase).toBe("unsupported");
  });

  it("never infers capabilities from the sandbox it acquires", async () => {
    const driver = wrapLegacySandboxFactory(factoryReturning(rpcStub()), {
      provider: "cloudflare",
      env: {},
    });

    const sandbox = await driver.acquire({ context: CONTEXT, signal: new AbortController().signal });

    expect(typeof sandbox.createWorkspaceBackup).toBe("function");
    expect(driver.capabilities).toEqual(UNDECLARED_PERSISTENCE);
  });

  it("acquires through the factory, prepares through the v0 hook, and destroys on release", async () => {
    const destroy = vi.fn(async () => undefined);
    const sandbox: SandboxPort = {
      exec: async () => "",
      readFile: async () => "",
      writeFile: async () => "",
      destroy,
    };
    const factory = factoryReturning(sandbox);
    const prepare = vi.fn(async () => undefined);
    const env = { SANDBOX_PROVIDER: "local-subprocess" };
    const driver = wrapLegacySandboxFactory(factory, { provider: "local-subprocess", env, prepare });
    const signal = new AbortController().signal;

    await expect(driver.acquire({ context: CONTEXT, signal })).resolves.toBe(sandbox);
    await driver.prepare({ sandbox, context: CONTEXT, signal });
    await driver.release({ sandbox, context: CONTEXT, reason: "deleted" });

    expect(factory).toHaveBeenCalledWith(CONTEXT, env);
    expect(prepare).toHaveBeenCalledWith({ sandbox, context: CONTEXT, signal });
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("tolerates v0 sandboxes without preparation or destroy", async () => {
    const sandbox: SandboxPort = {
      exec: async () => "",
      readFile: async () => "",
      writeFile: async () => "",
    };
    const driver = wrapLegacySandboxFactory(factoryReturning(sandbox), {
      provider: "local-subprocess",
      env: {},
    });
    const signal = new AbortController().signal;

    await expect(driver.prepare({ sandbox, context: CONTEXT, signal })).resolves.toBeUndefined();
    await expect(driver.release({ sandbox, context: CONTEXT, reason: "unused" }))
      .resolves.toBeUndefined();
  });
});
