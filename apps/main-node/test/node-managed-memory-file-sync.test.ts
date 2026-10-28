import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";
import type {
  MemoriesApplicationPort,
  MemoryView,
  Session,
} from "@open-managed-agents/managed-agents-application";

import { NodeManagedSessionInputPreparer } from "../../../packages/control-plane-node/src/lib/node-managed-session-inputs.js";
import { NodeManagedMemoryFileSync } from "../../../packages/control-plane-node/src/lib/node-managed-memory-file-sync.js";

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

/** A sandbox without FUSE: a plain filesystem reachable through shell
 * commands and file reads/writes, like an E2B-compatible sandbox. */
function plainSandbox() {
  const files = new Map<string, string>();
  const env: Record<string, string> = {};
  const unquote = (value: string) => value.replace(/^'|'$/g, "");
  const sandbox = {
    files,
    env,
    async exec(command: string): Promise<string> {
      let match: RegExpMatchArray | null;
      if ((match = command.match(/^if \[ -d ('[^']+') \]; then find/))) {
        const root = `${unquote(match[1]!)}/`;
        const paths = [...files.keys()].filter((path) => path.startsWith(root));
        return paths.length === 0 ? "" : Buffer.from(paths.map((path) => `${path}\0`).join("")).toString("base64");
      }
      if ((match = command.match(/^if \[ -f ('[^']+') \]/))) {
        return files.has(unquote(match[1]!)) ? "1" : "0";
      }
      if ((match = command.match(/^rm -rf -- ('[^']+') && mkdir -p -- '[^']+'$/))) {
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

function preparer(memories: MemoriesApplicationPort, sync = new NodeManagedMemoryFileSync()) {
  return new NodeManagedSessionInputPreparer({
    sharedOutputs: false,
    memoryFileSync: { sync, memories },
    files: {} as never,
    skillVersions: {} as never,
    repositoryCredentials: {} as never,
    memorySnapshots: {
      materialize: async () => { throw new Error("FUSE snapshot must not be used"); },
    },
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
  sandbox: ReturnType<typeof plainSandbox>,
  authorize: () => Promise<boolean> = async () => true,
) {
  return new NodeManagedMemoryFileSync().synchronize({
    workspaceId: "default",
    session: value,
    sandbox: sandbox as unknown as SandboxExecutor,
    memories,
    authorize,
    workId: "exec_1",
  });
}

describe("Memory Stores on a sandbox without FUSE (file sync)", () => {
  it("copies store files into /mnt/memory/<name>/ before the turn without mounting", async () => {
    const memories = new InMemoryMemories();
    memories.seed("memstore_1", { "/notes/plan.md": "ship it" });

    const sandbox = await prepare(memories, session("sess_a"));

    expect(sandbox.files.get("/mnt/memory/project/notes/plan.md")).toBe("ship it");
    expect(sandbox.env).toMatchObject({
      OMA_MEMORY_DIR: "/mnt/memory",
      OMA_MEMORY_PROJECT: "/mnt/memory/project",
    });
  });

  it("writes agent edits back after the turn so a new session sees them", async () => {
    const memories = new InMemoryMemories();
    memories.seed("memstore_1", { "/notes/plan.md": "ship it" });
    const first = session("sess_a");
    const sandbox = await prepare(memories, first);

    sandbox.files.set("/mnt/memory/project/notes/plan.md", "shipped");
    sandbox.files.set("/mnt/memory/project/learned.md", "use file sync");
    await writeBack(memories, first, sandbox);

    expect(memories.files("memstore_1")).toEqual({
      "/notes/plan.md": "shipped",
      "/learned.md": "use file sync",
    });
    const next = await prepare(memories, session("sess_b"));
    expect(next.files.get("/mnt/memory/project/learned.md")).toBe("use file sync");
    expect(next.files.get("/mnt/memory/project/notes/plan.md")).toBe("shipped");
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

  it("surfaces a missing store as an error instead of an empty directory", async () => {
    const memories = new InMemoryMemories();
    await expect(prepare(memories, session("sess_missing")))
      .rejects.toThrow("Managed Memory Store memstore_1 could not be listed: not_found");
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
});
