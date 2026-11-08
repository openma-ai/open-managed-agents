import { describe, expect, it, vi } from "vitest";
import type {
  SessionMemoryAccessPort,
  SessionMemoryDocument,
} from "@open-managed-agents/runtime-resource-contract";

import {
  SessionMemoryWorkspaceLifecycle,
  type SessionMemoryWorkspaceFilePort,
} from "../src/session-memory-workspace";

const scope = {
  workspaceId: "workspace_1",
  environmentId: "environment_1",
  sessionId: "session_1",
  workId: "work_1",
};
const fence = {
  ...scope,
  ownerId: "owner_1",
  generation: 7,
  token: "secret",
  expiresAt: "2026-09-10T12:00:00.000Z",
};

async function digest(content: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(content),
  )), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

class MemoryFiles implements SessionMemoryWorkspaceFilePort {
  readonly files = new Map<string, string>();

  async scan(root: string) {
    const prefix = `${root.replace(/\/+$/u, "")}/`;
    const entries = [...this.files]
      .filter(([path]) => path.startsWith(prefix))
      .map(([path, content]) => [path.slice(prefix.length), content] as const);
    return entries.length === 0 ? null : new Map(entries);
  }

  async read(path: string) {
    return this.files.get(path) ?? null;
  }

  async write(path: string, content: string) {
    this.files.set(path, content);
  }

  async replace(root: string, entries: ReadonlyMap<string, string>) {
    const prefix = `${root.replace(/\/+$/u, "")}/`;
    for (const path of [...this.files.keys()]) {
      if (path.startsWith(prefix)) this.files.delete(path);
    }
    for (const [path, content] of entries) this.files.set(`${prefix}${path}`, content);
  }
}

async function memoryAccess(initial: Record<string, string>) {
  let sequence = 0;
  const remote = new Map<string, SessionMemoryDocument>();
  for (const [path, content] of Object.entries(initial)) {
    sequence += 1;
    remote.set(path, {
      id: `mem_${sequence}`,
      path,
      content,
      contentSha256: await digest(content),
    });
  }
  const list = vi.fn(async ({ projection }: { projection: "basic" | "full" }) =>
    [...remote.values()].map((item) => projection === "full"
      ? { ...item }
      : { id: item.id, path: item.path, contentSha256: item.contentSha256 }));
  const create = vi.fn(async (input: {
    path: string;
    content: string;
  }) => {
    if (remote.has(input.path)) return { type: "conflict" as const };
    sequence += 1;
    const memory = {
      id: `mem_${sequence}`,
      path: input.path,
      content: input.content,
      contentSha256: await digest(input.content),
    };
    remote.set(input.path, memory);
    return { type: "applied" as const, memory };
  });
  const update = vi.fn(async (input: {
    memoryId: string;
    path: string;
    content: string;
    expectedContentSha256: string;
  }) => {
    const current = [...remote.values()].find(({ id }) => id === input.memoryId);
    if (current === undefined) return { type: "not_found" as const };
    if (current.contentSha256 !== input.expectedContentSha256) {
      return { type: "conflict" as const };
    }
    remote.delete(current.path);
    const memory = {
      ...current,
      path: input.path,
      content: input.content,
      contentSha256: await digest(input.content),
    };
    remote.set(input.path, memory);
    return { type: "applied" as const, memory };
  });
  const remove = vi.fn(async (input: {
    memoryId: string;
    expectedContentSha256: string;
  }) => {
    const current = [...remote.values()].find(({ id }) => id === input.memoryId);
    if (current === undefined) return { type: "not_found" as const };
    if (current.contentSha256 !== input.expectedContentSha256) {
      return { type: "conflict" as const };
    }
    remote.delete(current.path);
    return { type: "applied" as const };
  });
  return {
    port: { list, create, update, delete: remove } satisfies SessionMemoryAccessPort,
    remote,
    list,
    create,
    update,
    remove,
  };
}

function input(access: SessionMemoryAccessPort, authorize = vi.fn(async () => true)) {
  const signal = new AbortController().signal;
  return {
    scope,
    fence,
    session: {
      id: scope.sessionId,
      environmentId: scope.environmentId,
      metadata: {},
      resources: [{
        type: "memory_store",
        memory_store_id: "memstore_1",
        mount_path: "/workspace/memory",
        access: "read_write",
      }],
    },
    sandbox: { provider: "fake", runtimeId: "runtime_1" },
    resourceOwnership: { memoryStore: "materializer" as const },
    access: { downloadFile: vi.fn(), memories: access },
    authorize,
    signal,
  };
}

const manifestKey = "/workspace/.openma/session-inputs/session_1/memory/memstore_1.json";

describe("SessionMemoryWorkspaceLifecycle.writeBack (interval / checkpoint)", () => {
  it("writes local changes back without pulling or rewriting the directory", async () => {
    const files = new MemoryFiles();
    const canonical = await memoryAccess({ "/a.md": "a0", "/b.md": "b0", "/gone.md": "g0" });
    const lifecycle = new SessionMemoryWorkspaceLifecycle(files);
    await lifecycle.materialize(input(canonical.port));

    // Agent edits a, deletes gone, creates new; another Session edits b.
    files.files.set("/workspace/memory/a.md", "a1");
    files.files.delete("/workspace/memory/gone.md");
    files.files.set("/workspace/memory/new.md", "n1");
    canonical.remote.set("/b.md", { ...canonical.remote.get("/b.md")!, content: "b-remote", contentSha256: await digest("b-remote") });
    const replace = vi.spyOn(files, "replace");

    await lifecycle.writeBack(input(canonical.port));

    expect(replace).not.toHaveBeenCalled();
    expect(canonical.remote.get("/a.md")?.content).toBe("a1");
    expect(canonical.remote.get("/new.md")?.content).toBe("n1");
    expect(canonical.remote.has("/gone.md")).toBe(false);
    // No pull: the remote edit to b stays remote only.
    expect(files.files.get("/workspace/memory/b.md")).toBe("b0");

    const manifest = JSON.parse(files.files.get(manifestKey)!) as { baseline: Array<{ path: string; sha256: string }> };
    const byPath = new Map(manifest.baseline.map((item) => [item.path, item.sha256]));
    expect(byPath.get("/a.md")).toBe(await digest("a1"));
    expect(byPath.get("/new.md")).toBe(await digest("n1"));
    expect(byPath.has("/gone.md")).toBe(false);
    // b keeps its old ancestor so the next full sync pulls the remote edit.
    expect(byPath.get("/b.md")).toBe(await digest("b0"));

    await lifecycle.synchronize(input(canonical.port));
    expect(files.files.get("/workspace/memory/b.md")).toBe("b-remote");
    expect(canonical.remote.get("/a.md")?.content).toBe("a1");
  });

  it("checks the fence before every mutation and skips untrusted or read-only stores", async () => {
    const files = new MemoryFiles();
    const canonical = await memoryAccess({ "/a.md": "a0" });
    const lifecycle = new SessionMemoryWorkspaceLifecycle(files);
    await lifecycle.materialize(input(canonical.port));
    files.files.set("/workspace/memory/a.md", "a1");

    await expect(lifecycle.writeBack(input(canonical.port, vi.fn(async () => false))))
      .rejects.toThrow("Session Memory resource fence lost");
    expect(canonical.update).not.toHaveBeenCalled();

    files.files.delete("/workspace/memory/.openma-memory-store");
    await lifecycle.writeBack(input(canonical.port));
    expect(canonical.update).not.toHaveBeenCalled();

    const readOnly = input(canonical.port);
    readOnly.session.resources = [{ ...readOnly.session.resources[0]!, access: "read_only" }];
    const listed = canonical.list.mock.calls.length;
    await lifecycle.writeBack(readOnly);
    expect(canonical.list.mock.calls.length).toBe(listed);
  });
});
