import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalSubprocessSandbox } from "@open-managed-agents/sandbox/adapters/local-subprocess";
import type {
  SessionMemoryAccessPort,
  SessionMemoryDocument,
} from "@open-managed-agents/runtime-resource-contract";

import {
  sandboxMemoryStoreSync,
  type SessionMemoryWorkspaceContext,
} from "../src/session-memory-workspace";

// The shared Memory Store file sync end to end over a real sandbox: real
// shell commands, real exit statuses, real file permissions.

const roots: string[] = [];
const sandboxes: LocalSubprocessSandbox[] = [];

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((sandbox) => sandbox.destroy()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function freshSandbox(): Promise<LocalSubprocessSandbox> {
  const root = await mkdtemp(join(tmpdir(), "openma-memory-sync-"));
  roots.push(root);
  const sandbox = new LocalSubprocessSandbox({ workdir: join(root, "sandbox") });
  sandboxes.push(sandbox);
  return sandbox;
}

async function digest(content: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(content),
  )), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A canonical Memory Store shared by every sandbox in a test. */
function canonicalStore() {
  const documents = new Map<string, SessionMemoryDocument>();
  let sequence = 0;
  const mutations: string[] = [];
  const port: SessionMemoryAccessPort = {
    async list({ projection }) {
      return [...documents.values()].map((item) => projection === "full"
        ? { ...item }
        : { id: item.id, path: item.path, contentSha256: item.contentSha256 });
    },
    async create({ path, content }) {
      mutations.push(`create ${path}`);
      if (documents.has(path)) return { type: "conflict" };
      sequence += 1;
      documents.set(path, { id: `mem_${sequence}`, path, content, contentSha256: await digest(content) });
      return { type: "applied" };
    },
    async update({ memoryId, path, content, expectedContentSha256 }) {
      mutations.push(`update ${path}`);
      const current = [...documents.values()].find(({ id }) => id === memoryId);
      if (current === undefined) return { type: "not_found" };
      if (current.contentSha256 !== expectedContentSha256) return { type: "conflict" };
      documents.delete(current.path);
      documents.set(path, { ...current, path, content, contentSha256: await digest(content) });
      return { type: "applied" };
    },
    async delete({ memoryId, expectedContentSha256 }) {
      const current = [...documents.values()].find(({ id }) => id === memoryId);
      if (current === undefined) return { type: "not_found" };
      if (current.contentSha256 !== expectedContentSha256) return { type: "conflict" };
      mutations.push(`delete ${current.path}`);
      documents.delete(current.path);
      return { type: "applied" };
    },
  };
  return { documents, mutations, port };
}

function context(
  memories: SessionMemoryAccessPort,
  options: { access?: "read_only" | "read_write"; authorize?: () => Promise<boolean> } = {},
): SessionMemoryWorkspaceContext {
  return {
    session: {
      id: "session_1",
      resources: [{
        type: "memory_store",
        memory_store_id: "memstore_1",
        mount_path: "/mnt/memory/notes",
        access: options.access ?? "read_write",
      }],
    },
    resourceOwnership: { memoryStore: "materializer" },
    access: { memories },
    authorize: options.authorize ?? (async () => true),
    signal: new AbortController().signal,
  };
}

describe("Memory Store file sync on a real LocalSubprocessSandbox", () => {
  it("writes a sandbox edit back at the barrier and a fresh sandbox reads it", async () => {
    const store = canonicalStore();
    const sandboxA = await freshSandbox();
    const syncA = sandboxMemoryStoreSync(sandboxA);
    await syncA.materialize(context(store.port));

    // The Agent writes through the shell, as a tool would.
    const written = await sandboxA.exec("mkdir -p /mnt/memory/notes/dir && printf 'remember me' > /mnt/memory/notes/dir/x.md");
    expect(written).toBe("");
    await syncA.synchronize(context(store.port));

    expect(store.documents.get("/dir/x.md")?.content).toBe("remember me");

    const sandboxB = await freshSandbox();
    await sandboxMemoryStoreSync(sandboxB).materialize(context(store.port));
    await expect(sandboxB.readFile("/mnt/memory/notes/dir/x.md")).resolves.toBe("remember me");
    await expect(sandboxB.exec("cat /mnt/memory/notes/dir/x.md")).resolves.toBe("remember me");
  });

  it("copies a read-only store without write permission and never writes it back", async () => {
    const store = canonicalStore();
    await store.port.create({ memoryStoreId: "memstore_1", path: "/a.md", content: "canonical", signal: new AbortController().signal });
    store.mutations.length = 0;
    const sandbox = await freshSandbox();
    const sync = sandboxMemoryStoreSync(sandbox);
    const readOnly = context(store.port, { access: "read_only", authorize: async () => false });
    await sync.materialize(readOnly);

    await expect(sandbox.readFile("/mnt/memory/notes/a.md")).resolves.toBe("canonical");
    await expect(sandbox.writeFile("/mnt/memory/notes/a.md", "edit")).rejects.toThrow();
    const denied = await sandbox.exec("printf edit > /mnt/memory/notes/b.md");
    expect(denied).toMatch(/\[exit (exit=)?[1-9]\d*\]/u);

    await sync.synchronize(readOnly);
    expect(store.mutations).toEqual([]);
    await expect(sandbox.readFile("/mnt/memory/notes/a.md")).resolves.toBe("canonical");
  });

  it("refuses to write back a writable store when the fence is not held", async () => {
    const store = canonicalStore();
    const sandbox = await freshSandbox();
    const sync = sandboxMemoryStoreSync(sandbox);
    await sync.materialize(context(store.port));
    await sandbox.exec("printf local > /mnt/memory/notes/x.md");

    await expect(sync.synchronize(context(store.port, { authorize: async () => false })))
      .rejects.toThrow(/fence lost/u);
    expect(store.documents.size).toBe(0);
  });

  it("surfaces a failing sandbox command as an error", async () => {
    const store = canonicalStore();
    const sandbox = await freshSandbox();
    const sync = sandboxMemoryStoreSync(sandbox);
    await sync.materialize(context(store.port));
    await sandbox.exec("printf local > /mnt/memory/notes/x.md && chmod 000 /mnt/memory/notes");

    try {
      await expect(sync.synchronize(context(store.port))).rejects.toThrow(/Session Memory .* failed \(exit [1-9]\d*\)/u);
      expect(store.documents.size).toBe(0);
    } finally {
      await sandbox.exec("chmod 755 /mnt/memory/notes");
    }
  });
});
