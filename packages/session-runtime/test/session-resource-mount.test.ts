import { describe, expect, it, vi } from "vitest";
import { mountSessionResources, type SessionResourceMountPorts } from "../src/session-resource-mount";

const ports = (overrides: Partial<SessionResourceMountPorts> = {}): SessionResourceMountPorts => ({
  repositories: { prepare: vi.fn(async () => undefined) },
  memoryStores: { mode: "native" },
  ...overrides,
});

describe("mountSessionResources", () => {
  it("mounts in resource order, prepares repository access first and batches env last", async () => {
    const order: string[] = [];
    const sandbox = {
      exec: vi.fn(async (command: string) => { order.push(command.split(" ")[0]!); return ""; }),
      readFile: async () => { throw new Error("missing"); },
      writeFileBytes: vi.fn(async (path: string) => { order.push(`file ${path}`); return "ok"; }),
      mountMemoryStore: vi.fn(async () => { order.push("memory"); }),
      setEnvVars: vi.fn(async (env: Record<string, string>) => { order.push(`env ${Object.keys(env).join(",")}`); }),
    };
    const repositories = { prepare: vi.fn(async () => { order.push("access"); }) };
    const afterRepositories = vi.fn(async () => { order.push("after"); });
    await mountSessionResources(sandbox, [
      { type: "file", fileId: "f", mountPath: "/workspace/f" },
      { type: "github_repository", url: "https://g/x.git", mountPath: "/workspace/x" },
      { type: "memory_store", memoryStoreId: "m", name: "notes" },
      { type: "env", id: "e", name: "TOKEN" },
    ], ports({
      downloadFile: async () => new Uint8Array([1]),
      repositories,
      envSecrets: new Map([["e", "v"]]),
      afterRepositories,
    }));
    expect(order).toEqual([
      "access", "file /workspace/f", "git", "git", "memory", "env OMA_MEMORY_DIR,OMA_MEMORY_NOTES", "env TOKEN", "after",
    ]);
  });

  it("leaves Memory Stores to the storage Port", async () => {
    const mountMemoryStore = vi.fn();
    await mountSessionResources({ exec: vi.fn(), readFile: vi.fn(), mountMemoryStore },
      [{ type: "memory_store", memoryStoreId: "m", name: "notes" }], ports({ memoryStores: { mode: "storage" } }));
    expect(mountMemoryStore).not.toHaveBeenCalled();
  });

  it("resolves an undeclared Memory name and fails closed when it is unknown", async () => {
    const mountMemoryStore = vi.fn();
    const sandbox = { exec: vi.fn(), readFile: vi.fn(), mountMemoryStore, setEnvVars: vi.fn() };
    const facts = await mountSessionResources(sandbox, [{ type: "memory_store", memory_store_id: "m", mount_path: "/mnt/memory/custom", instructions: "Read before acting." }],
      ports({ memoryStores: { mode: "native", lookupName: async () => "Notes" } }));
    expect(mountMemoryStore).toHaveBeenCalledWith({ storeName: "Notes", storeId: "m", readOnly: false });
    expect(facts).toEqual([{ storeId: "m", storeName: "Notes", path: "/mnt/memory/Notes", access: "read_write", instructions: "Read before acting." }]);
    // Every SandboxPort.mountMemoryStore mounts at /mnt/memory/<storeName>; a
    // record mount_path the port never honours must not leak into the env.
    expect(sandbox.setEnvVars).toHaveBeenCalledWith({ OMA_MEMORY_DIR: "/mnt/memory", OMA_MEMORY_NOTES: "/mnt/memory/Notes" });
    await expect(mountSessionResources(sandbox, [{ type: "memory_store", memory_store_id: "m" }],
      ports({ memoryStores: { mode: "native", lookupName: async () => null } }))).rejects.toThrow(/Memory Store m was not found/);
    await expect(mountSessionResources(sandbox, [{ type: "memory_store", memory_store_id: "m" }], ports()))
      .rejects.toThrow(/requires a metadata lookup Port/);
  });

  it.each([
    [{ type: "file", fileId: "f" }, {}, /tenant-scoped file source/],
    [{ type: "file", fileId: "f" }, { downloadFile: async () => new Uint8Array() }, /binary sandbox writes/],
    [{ type: "memory_store", memoryStoreId: "m" }, {}, /memory mount Port/],
    [{ type: "env", id: "e", name: "N" }, { envSecrets: new Map([["e", "v"]]) }, /environment injection/],
  ])("preflights %j before any side effect", async (record, overrides, message) => {
    const repositories = { prepare: vi.fn() };
    await expect(mountSessionResources({ exec: vi.fn(), readFile: vi.fn() },
      [{ type: "github_repository", url: "https://g/x.git" }, record as never], ports({ repositories, ...overrides })))
      .rejects.toThrow(message);
    expect(repositories.prepare).not.toHaveBeenCalled();
  });
});
