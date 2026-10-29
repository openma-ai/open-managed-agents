import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  hasNativeMemoryStoreMount,
  withSandboxExecutionGuard,
  type SandboxExecutor,
} from "@open-managed-agents/sandbox";
import type {
  MemoriesApplicationPort,
  MemoryView,
  Session,
} from "@open-managed-agents/managed-agents-application";

import { NodeManagedSessionInputPreparer } from "../../../packages/control-plane-node/src/lib/node-managed-session-inputs.js";
import {
  NodeManagedMemoryFileSync,
  synchronizeNodeManagedMemoryStores,
} from "../../../packages/control-plane-node/src/lib/node-managed-memory-file-sync.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

/** Canonical Memory Stores kept in memory, behind the application port. */
class InMemoryMemories implements MemoriesApplicationPort {
  readonly stores = new Map<string, Map<string, { id: string; content: string }>>();
  private nextId = 1;

  seed(storeId: string, files: Record<string, string>): void {
    const store = new Map<string, { id: string; content: string }>();
    for (const [path, content] of Object.entries(files)) {
      store.set(path, { id: `mem_${this.nextId++}`, content });
    }
    this.stores.set(storeId, store);
  }

  files(storeId: string): Record<string, string> {
    return Object.fromEntries(
      [...this.stores.get(storeId)!].map(([path, entry]) => [path, entry.content]),
    );
  }

  private view(storeId: string, path: string, entry: { id: string; content: string }): MemoryView {
    return {
      kind: "memory", id: entry.id, path, content: entry.content,
      contentSha256: sha(entry.content), contentSizeBytes: entry.content.length,
      createdAt: "", updatedAt: "", memoryStoreId: storeId, memoryVersionId: `${entry.id}_v`,
    };
  }

  async listMemories(query: Parameters<MemoriesApplicationPort["listMemories"]>[0]) {
    const store = this.stores.get(query.memoryStoreId);
    if (store === undefined) return { type: "not_found" as const };
    return {
      type: "page" as const,
      page: {
        items: [...store].map(([path, entry]) => this.view(query.memoryStoreId, path, entry)),
        nextCursor: null,
      },
    };
  }

  async createMemory(command: Parameters<MemoriesApplicationPort["createMemory"]>[0]) {
    const store = this.stores.get(command.memoryStoreId);
    if (store === undefined) return { type: "not_found" as const };
    if (store.has(command.path)) return { type: "conflict" as const };
    const entry = { id: `mem_${this.nextId++}`, content: command.content ?? "" };
    store.set(command.path, entry);
    return { type: "created" as const, memory: this.view(command.memoryStoreId, command.path, entry) };
  }

  async updateMemory(command: Parameters<MemoriesApplicationPort["updateMemory"]>[0]) {
    const store = this.stores.get(command.memoryStoreId);
    const found = [...(store ?? [])].find(([, entry]) => entry.id === command.memoryId);
    if (found === undefined) return { type: "not_found" as const };
    const [path, entry] = found;
    if (sha(entry.content) !== command.contentPrecondition?.expectedSha256) {
      return { type: "precondition_failed" as const };
    }
    entry.content = command.content ?? "";
    return { type: "updated" as const, memory: this.view(command.memoryStoreId, path, entry) };
  }

  async deleteMemory(command: Parameters<MemoriesApplicationPort["deleteMemory"]>[0]) {
    const store = this.stores.get(command.memoryStoreId);
    const found = [...(store ?? [])].find(([, entry]) => entry.id === command.memoryId);
    if (found === undefined) return { type: "not_found" as const };
    store!.delete(found[0]);
    return { type: "deleted" as const, memoryId: command.memoryId };
  }

  async retrieveMemory() {
    return { type: "not_found" as const };
  }
}

const prepareRootPrefix = "mkdir -p /mnt/memory 2>/dev/null;";
const findCommand = /^if \[ -d ('[^']+') \]; then find/;
const probeCommand = /^if \[ -f ('[^']+') \]/;
const replaceCommand = /^rm -rf -- ('[^']+') && mkdir -p -- '[^']+'$/;

/** A sandbox with no native Memory mount: a plain filesystem reachable
 * through shell commands and file reads/writes. It still has a
 * `mountMemoryStore` that fails, like E2B without a memory bucket, to prove
 * that an undeclared mount is never used. */
function plainSandbox() {
  const files = new Map<string, string>();
  const env: Record<string, string> = {};
  const commands: string[] = [];
  const unquote = (value: string) => value.replace(/^'|'$/g, "");
  const sandbox = {
    files,
    env,
    commands,
    async exec(command: string): Promise<string> {
      commands.push(command);
      let match: RegExpMatchArray | null;
      if (command.startsWith(prepareRootPrefix)) return "";
      if ((match = command.match(findCommand))) {
        const root = `${unquote(match[1]!)}/`;
        const paths = [...files.keys()].filter((path) => path.startsWith(root));
        return paths.length === 0 ? "" : Buffer.from(paths.map((path) => `${path}\0`).join("")).toString("base64");
      }
      if ((match = command.match(probeCommand))) {
        return files.has(unquote(match[1]!)) ? "1" : "0";
      }
      if ((match = command.match(replaceCommand))) {
        const root = `${unquote(match[1]!)}/`;
        for (const path of [...files.keys()]) if (path.startsWith(root)) files.delete(path);
        return "";
      }
      if (/^mkdir -p( --)? /.test(command)) return "";
      throw new Error(`unexpected sandbox command: ${command}`);
    },
    async readFile(path: string): Promise<string> {
      const content = files.get(path);
      if (content === undefined) throw new Error(`ENOENT ${path}`);
      return content;
    },
    async writeFile(path: string, content: string): Promise<string> {
      files.set(path, content);
      return path;
    },
    async setEnvVars(values: Record<string, string>): Promise<void> {
      Object.assign(env, values);
    },
    sessionOutputMountCapabilities: () => ({ durability: "durable" as const }),
    async mountSessionOutputs(): Promise<void> {},
    async mountMemoryStore(): Promise<void> {
      throw new Error("FUSE is not available in this sandbox");
    },
  };
  return sandbox;
}

/** A sandbox whose adapter declares a native Memory mount. Any shell or file
 * access under /mnt/memory would mean file sync ran as well. */
function nativeSandbox(
  mount: (input: { storeName: string; storeId: string; readOnly: boolean }) => Promise<void>,
) {
  const touch = (path: string) => {
    if (path.includes("/mnt/memory")) throw new Error(`file sync touched ${path}`);
  };
  return {
    supportsNativeMemoryStoreMount: () => true,
    mountMemoryStore: vi.fn(mount),
    synchronizeMemoryStores: vi.fn(async () => undefined),
    setEnvVars: vi.fn(async (_values: Record<string, string>) => undefined),
    sessionOutputMountCapabilities: () => ({ durability: "durable" as const }),
    async mountSessionOutputs(): Promise<void> {},
    async exec(command: string): Promise<string> { touch(command); return ""; },
    async readFile(path: string): Promise<string> { touch(path); throw new Error("ENOENT"); },
    async writeFile(path: string): Promise<string> { touch(path); return path; },
  };
}

function session(id: string, access: "read_write" | "read_only" = "read_write"): Session {
  return {
    id,
    agent: {
      id: "agent_memory", description: null, mcpServers: [], model: { id: "model" },
      multiagent: null, name: "Memory", skills: [], system: null, tools: [], version: 1,
    },
    archivedAt: null, budget: null, createdAt: "", environmentId: "env_memory",
    metadata: {}, outcomeEvaluations: [],
    resources: [{
      type: "memory_store",
      memoryStoreId: "memstore_1",
      name: "project",
      access,
      mountPath: "/mnt/memory/project",
    }] as unknown as Session["resources"],
    stats: {}, status: "running", title: null, updatedAt: "", usage: {}, vaultIds: [],
  };
}

function preparer(
  memories: MemoriesApplicationPort,
  materialize: () => Promise<{ mountStoreId: string }> = async () => {
    throw new Error("native snapshot must not be used");
  },
) {
  return new NodeManagedSessionInputPreparer({
    sharedOutputs: false,
    memories,
    files: {} as never,
    skillVersions: {} as never,
    repositoryCredentials: {} as never,
    memorySnapshots: { materialize },
  });
}

async function prepare(memories: MemoriesApplicationPort, value: Session) {
  const sandbox = plainSandbox();
  await preparer(memories).prepare({
    workspaceId: "default",
    session: value,
    sandbox: sandbox as unknown as SandboxExecutor,
    runtimeGeneration: "runtime_1",
  });
  return sandbox;
}

function writeBack(
  memories: MemoriesApplicationPort,
  value: Session,
  sandbox: unknown,
  authorize: () => Promise<boolean> = async () => true,
  native: () => Promise<void> = async () => {
    throw new Error("native synchronization must not be used");
  },
) {
  return synchronizeNodeManagedMemoryStores({
    workspaceId: "default",
    session: value,
    sandbox: sandbox as SandboxExecutor,
    memories,
    authorize,
    workId: "exec_1",
    fileSync: new NodeManagedMemoryFileSync(),
    native,
  });
}

/** Every canonical Memory call fails: proves file sync never ran. */
const untouchedMemories = new Proxy({} as MemoriesApplicationPort, {
  get: (_target, property) => async () => {
    throw new Error(`file sync called memories.${String(property)}`);
  },
});

describe("Memory Stores on a sandbox without a native mount (default file sync)", () => {
  it("copies store files into /mnt/memory/<name>/ before the turn without mounting", async () => {
    const memories = new InMemoryMemories();
    memories.seed("memstore_1", { "/notes/plan.md": "ship it" });

    const sandbox = await prepare(memories, session("sess_a"));

    expect(sandbox.files.get("/mnt/memory/project/notes/plan.md")).toBe("ship it");
    expect(sandbox.commands[0]!.startsWith(prepareRootPrefix)).toBe(true);
    expect(sandbox.env).toMatchObject({
      OMA_MEMORY_DIR: "/mnt/memory",
      OMA_MEMORY_PROJECT: "/mnt/memory/project",
    });
  });

  it("writes agent edits back at the barrier so the next Session sees them", async () => {
    const memories = new InMemoryMemories();
    memories.seed("memstore_1", { "/notes/plan.md": "ship it", "/old.md": "remove me" });
    const first = session("sess_a");
    const sandbox = await prepare(memories, first);

    sandbox.files.set("/mnt/memory/project/notes/plan.md", "shipped");
    sandbox.files.set("/mnt/memory/project/learned.md", "use file sync");
    sandbox.files.delete("/mnt/memory/project/old.md");
    await writeBack(memories, first, sandbox);

    expect(memories.files("memstore_1")).toEqual({
      "/notes/plan.md": "shipped",
      "/learned.md": "use file sync",
    });
    const next = await prepare(memories, session("sess_b"));
    expect(next.files.get("/mnt/memory/project/learned.md")).toBe("use file sync");
    expect(next.files.get("/mnt/memory/project/notes/plan.md")).toBe("shipped");
    expect(next.files.has("/mnt/memory/project/old.md")).toBe(false);
  });

  it("keeps the store's version when the store changed underneath the Session", async () => {
    const memories = new InMemoryMemories();
    memories.seed("memstore_1", { "/notes/plan.md": "ship it" });
    const value = session("sess_conflict");
    const sandbox = await prepare(memories, value);

    await memories.updateMemory({
      memoryStoreId: "memstore_1",
      memoryId: memories.stores.get("memstore_1")!.get("/notes/plan.md")!.id,
      content: "store edit",
      contentPrecondition: { expectedSha256: sha("ship it") },
    });
    sandbox.files.set("/mnt/memory/project/notes/plan.md", "session edit");
    await writeBack(memories, value, sandbox);

    expect(memories.files("memstore_1")).toEqual({ "/notes/plan.md": "store edit" });
    expect(sandbox.files.get("/mnt/memory/project/notes/plan.md")).toBe("store edit");
  });

  it("never writes a read_only store back", async () => {
    const memories = new InMemoryMemories();
    memories.seed("memstore_1", { "/notes/plan.md": "ship it" });
    const readOnly = session("sess_ro", "read_only");
    const sandbox = await prepare(memories, readOnly);

    sandbox.files.set("/mnt/memory/project/notes/plan.md", "tampered");
    sandbox.files.set("/mnt/memory/project/extra.md", "should not persist");
    await writeBack(memories, readOnly, sandbox);

    expect(memories.files("memstore_1")).toEqual({ "/notes/plan.md": "ship it" });
    expect(sandbox.files.get("/mnt/memory/project/notes/plan.md")).toBe("ship it");
    expect(sandbox.files.has("/mnt/memory/project/extra.md")).toBe(false);
  });

  it("refuses to write back after the execution fence is lost", async () => {
    const memories = new InMemoryMemories();
    memories.seed("memstore_1", { "/notes/plan.md": "ship it" });
    const value = session("sess_fence");
    const sandbox = await prepare(memories, value);

    sandbox.files.set("/mnt/memory/project/notes/plan.md", "stale writer");
    await expect(writeBack(memories, value, sandbox, async () => false))
      .rejects.toThrow("Session Memory resource fence lost");
    expect(memories.files("memstore_1")).toEqual({ "/notes/plan.md": "ship it" });
  });

  it("surfaces a missing store as an error instead of an empty directory", async () => {
    const memories = new InMemoryMemories();
    await expect(prepare(memories, session("sess_missing")))
      .rejects.toThrow("Managed Memory Store memstore_1 could not be listed: not_found");
  });

  it("surfaces a sandbox command failure instead of continuing", async () => {
    const memories = new InMemoryMemories();
    memories.seed("memstore_1", { "/notes/plan.md": "ship it" });
    const sandbox = plainSandbox();
    const exec = sandbox.exec;
    sandbox.exec = async (command: string) => command.startsWith(prepareRootPrefix)
      ? "/mnt/memory is not writable by the sandbox user\n[exit 1]"
      : exec(command);

    await expect(preparer(memories).prepare({
      workspaceId: "default",
      session: session("sess_unwritable"),
      sandbox: sandbox as unknown as SandboxExecutor,
      runtimeGeneration: "runtime_1",
    })).rejects.toThrow("/mnt/memory is not writable");
    expect(sandbox.files.size).toBe(0);
  });
});

describe("Memory Stores on a sandbox that declares a native mount", () => {
  it("mounts natively and never file-syncs, before or after the turn", async () => {
    const sandbox = nativeSandbox(async () => undefined);
    const materialize = vi.fn(async () => ({ mountStoreId: "snapshot/memstore_1" }));
    const value = session("sess_native");

    await preparer(untouchedMemories, materialize).prepare({
      workspaceId: "default",
      session: value,
      sandbox: sandbox as unknown as SandboxExecutor,
      runtimeGeneration: "runtime_1",
    });
    const native = vi.fn(async () => undefined);
    await writeBack(untouchedMemories, value, sandbox, async () => true, native);

    expect(materialize).toHaveBeenCalledOnce();
    expect(sandbox.mountMemoryStore).toHaveBeenCalledWith({
      storeName: "project",
      storeId: "snapshot/memstore_1",
      readOnly: false,
    });
    expect(native).toHaveBeenCalledOnce();
    expect(sandbox.setEnvVars).toHaveBeenCalledWith({
      OMA_MEMORY_DIR: "/mnt/memory",
      OMA_MEMORY_PROJECT: "/mnt/memory/project",
    });
  });

  it("surfaces a failing native mount without falling back to file sync", async () => {
    const sandbox = nativeSandbox(async () => {
      throw new Error("s3fs: mount failed");
    });

    await expect(preparer(
      untouchedMemories,
      async () => ({ mountStoreId: "snapshot/memstore_1" }),
    ).prepare({
      workspaceId: "default",
      session: session("sess_native_fail"),
      sandbox: sandbox as unknown as SandboxExecutor,
      runtimeGeneration: "runtime_1",
    })).rejects.toThrow("s3fs: mount failed");
    expect(sandbox.setEnvVars).not.toHaveBeenCalledWith(
      expect.objectContaining({ OMA_MEMORY_DIR: "/mnt/memory" }),
    );
  });

  it("keeps the declaration visible through the execution guard", () => {
    const declared = withSandboxExecutionGuard(
      nativeSandbox(async () => undefined) as unknown as SandboxExecutor,
      { isValid: () => true },
    );
    const undeclared = withSandboxExecutionGuard(
      plainSandbox() as unknown as SandboxExecutor,
      { isValid: () => true },
    );

    expect(hasNativeMemoryStoreMount(declared)).toBe(true);
    expect(hasNativeMemoryStoreMount(undeclared)).toBe(false);
  });
});
