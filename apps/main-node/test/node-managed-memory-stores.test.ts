import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalSubprocessSandbox } from "@open-managed-agents/sandbox/adapters/local-subprocess";
import type {
  MemoriesApplicationPort,
  MemoryView,
  Session,
} from "@open-managed-agents/managed-agents-application";

import {
  NodeManagedSessionInputPreparer,
  nodeManagedMemoryStoreModeName,
} from "../../../packages/control-plane-node/src/lib/node-managed-session-inputs.js";
import { synchronizeNodeManagedMemoryStores } from "../../../packages/control-plane-node/src/lib/node-managed-memory-stores.js";

const roots: string[] = [];
const sandboxes: LocalSubprocessSandbox[] = [];

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((sandbox) => sandbox.destroy()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function freshSandbox(): Promise<LocalSubprocessSandbox> {
  const root = await mkdtemp(join(tmpdir(), "openma-node-memory-"));
  roots.push(root);
  const sandbox = new LocalSubprocessSandbox({
    workdir: join(root, "sandbox"),
    outputsRoot: join(root, "outputs"),
  });
  sandboxes.push(sandbox);
  return sandbox;
}

async function digest(content: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(content),
  )), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A Memories application holding one store's documents in memory. */
function memoriesApp(): MemoriesApplicationPort & { documents: Map<string, MemoryView> } {
  const documents = new Map<string, MemoryView>();
  let sequence = 0;
  return {
    documents,
    async listMemories() {
      return { type: "page", page: { items: [...documents.values()], nextCursor: null } };
    },
    async createMemory({ memoryStoreId, path, content }) {
      if (documents.has(path)) return { type: "conflict" };
      sequence += 1;
      const memory: MemoryView = {
        kind: "memory",
        id: `mem_${sequence}`,
        path,
        content,
        contentSha256: await digest(content ?? ""),
        contentSizeBytes: (content ?? "").length,
        memoryStoreId,
        memoryVersionId: `ver_${sequence}`,
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
      };
      documents.set(path, memory);
      return { type: "created", memory };
    },
    async retrieveMemory() { return { type: "not_found" }; },
    async updateMemory() { return { type: "not_found" }; },
    async deleteMemory() { return { type: "not_found" }; },
  };
}

function session(access: "read_only" | "read_write"): Session {
  return {
    id: "session_memory_01",
    agent: {
      id: "agent_memory_01",
      description: null,
      mcpServers: [],
      model: { id: "model_memory" },
      multiagent: null,
      name: "Memory verifier",
      skills: [],
      system: null,
      tools: [],
      version: 1,
    },
    archivedAt: null,
    budget: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    environmentId: "env_memory_01",
    metadata: {},
    outcomeEvaluations: [],
    resources: [{
      type: "memory_store",
      memoryStoreId: "memstore_01",
      name: "project-notes",
      access,
    }],
    stats: {},
    status: "running",
    title: null,
    updatedAt: "2026-10-01T00:00:00.000Z",
    usage: {},
    vaultIds: [],
  } as unknown as Session;
}

function preparer(memories: MemoriesApplicationPort): NodeManagedSessionInputPreparer {
  return new NodeManagedSessionInputPreparer({
    files: { downloadFile: async () => { throw new Error("unexpected file download"); } },
    skillVersions: {
      listSkillVersions: async () => { throw new Error("unexpected skill listing"); },
      downloadSkillVersion: async () => { throw new Error("unexpected skill download"); },
      retrieveSkillVersion: async () => { throw new Error("unexpected skill retrieval"); },
    },
    repositoryCredentials: { findGithubToken: async () => null },
    memoryStores: { mode: "file_sync", memories },
  });
}

describe("Node control plane Memory Store mode", () => {
  it("follows the composed sandbox factory capability, file sync by default", () => {
    expect(nodeManagedMemoryStoreModeName({})).toBe("file_sync");
    expect(nodeManagedMemoryStoreModeName({ capabilities: {} })).toBe("file_sync");
    expect(nodeManagedMemoryStoreModeName({ capabilities: { preparedBase: true } })).toBe("file_sync");
    expect(nodeManagedMemoryStoreModeName({ capabilities: { nativeMemoryStoreMount: true } })).toBe("native");
  });

  it("file-syncs on a sandbox without mountMemoryStore: write-back, then a fresh sandbox reads it", async () => {
    const memories = memoriesApp();
    const sandboxA = await freshSandbox();
    const authorize = vi.fn(async () => true);
    await preparer(memories).prepare({
      workspaceId: "workspace_memory",
      session: session("read_write"),
      sandbox: sandboxA,
      authorizeMemoryMutation: authorize,
    });
    expect(await sandboxA.exec("printf saved > \"$OMA_MEMORY_PROJECT_NOTES/x.md\"")).toBe("");

    await synchronizeNodeManagedMemoryStores({
      session: session("read_write"),
      sandbox: sandboxA,
      memories,
      authorize,
      signal: new AbortController().signal,
    });
    expect(authorize).toHaveBeenCalled();
    expect(memories.documents.get("/x.md")?.content).toBe("saved");

    const sandboxB = await freshSandbox();
    await preparer(memories).prepare({
      workspaceId: "workspace_memory",
      session: session("read_write"),
      sandbox: sandboxB,
      authorizeMemoryMutation: authorize,
    });
    await expect(sandboxB.readFile("/mnt/memory/project-notes/x.md")).resolves.toBe("saved");
  });

  it("refuses a writable store without an execution fence", async () => {
    const sandbox = await freshSandbox();
    await expect(preparer(memoriesApp()).prepare({
      workspaceId: "workspace_memory",
      session: session("read_write"),
      sandbox,
    })).rejects.toThrow(/requires a Session execution fence/u);
  });

  it("copies a read-only store without a fence and without write permission", async () => {
    const memories = memoriesApp();
    await memories.createMemory({ memoryStoreId: "memstore_01", path: "/a.md", content: "canonical" });
    const sandbox = await freshSandbox();
    await preparer(memories).prepare({
      workspaceId: "workspace_memory",
      session: session("read_only"),
      sandbox,
    });

    await expect(sandbox.readFile("/mnt/memory/project-notes/a.md")).resolves.toBe("canonical");
    await expect(sandbox.exec("printf edit > /mnt/memory/project-notes/a.md"))
      .resolves.toMatch(/\[exit (exit=)?[1-9]\d*\]/u);
  });

  it("throws in native mode when the sandbox has no mountMemoryStore", async () => {
    const sandbox = await freshSandbox();
    const native = new NodeManagedSessionInputPreparer({
      files: { downloadFile: async () => { throw new Error("unexpected"); } },
      skillVersions: {
        listSkillVersions: async () => { throw new Error("unexpected"); },
        downloadSkillVersion: async () => { throw new Error("unexpected"); },
        retrieveSkillVersion: async () => { throw new Error("unexpected"); },
      },
      repositoryCredentials: { findGithubToken: async () => null },
      memoryStores: { mode: "native", snapshots: { materialize: vi.fn() } },
    });
    const withoutMount = Object.assign(Object.create(sandbox), { mountMemoryStore: undefined });

    await expect(native.prepare({
      workspaceId: "workspace_memory",
      session: session("read_only"),
      sandbox: withoutMount,
    })).rejects.toThrow(/does not implement mountMemoryStore/u);
  });
});
