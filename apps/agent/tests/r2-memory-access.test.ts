import { describe, expect, it } from "vitest";
import { sandboxMemoryStoreSync } from "@open-managed-agents/managed-runtime-sandbox";
import { createR2MemoryPrefixAccess, type MemoryPrefixBucket } from "../src/runtime/r2-memory-access";

const signal = new AbortController().signal;

function fakeBucket(initial: Record<string, string> = {}) {
  const objects = new Map(Object.entries(initial).map(([key, text]) => [key, { text, etag: crypto.randomUUID() }]));
  const bucket = {
    async get(key: string) {
      const object = objects.get(key);
      return object === undefined ? null : { etag: object.etag, text: async () => object.text };
    },
    async head(key: string) { return objects.has(key) ? { key } : null; },
    async put(key: string, value: string, options?: { onlyIf?: { etagMatches?: string } }) {
      const current = objects.get(key);
      if (options?.onlyIf?.etagMatches !== undefined && current?.etag !== options.onlyIf.etagMatches) return null;
      objects.set(key, { text: value, etag: crypto.randomUUID() });
      return { key };
    },
    async delete(key: string) { objects.delete(key); },
    async list({ prefix }: { prefix: string }) {
      return { objects: [...objects.keys()].filter((key) => key.startsWith(prefix)).sort().map((key) => ({ key })), truncated: false };
    },
  };
  return { bucket: bucket as unknown as MemoryPrefixBucket, objects };
}

const sha = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), (b) => b.toString(16).padStart(2, "0")).join("");

describe("createR2MemoryPrefixAccess", () => {
  it("lists a store prefix as Memory documents and ignores directory placeholders and other stores", async () => {
    const { bucket } = fakeBucket({ "st/a.md": "one", "st/dir/": "", "st/dir/b.md": "two", "other/x.md": "no" });
    const access = createR2MemoryPrefixAccess(bucket);
    expect(await access.list({ memoryStoreId: "st", projection: "full", signal })).toEqual([
      { id: "st/a.md", path: "/a.md", contentSha256: await sha("one"), content: "one" },
      { id: "st/dir/b.md", path: "/dir/b.md", contentSha256: await sha("two"), content: "two" },
    ]);
    expect((await access.list({ memoryStoreId: "st", projection: "basic", signal }))[0]).not.toHaveProperty("content");
  });

  it("creates, updates, renames and deletes with content-sha CAS", async () => {
    const { bucket, objects } = fakeBucket({ "st/a.md": "one" });
    const access = createR2MemoryPrefixAccess(bucket);
    expect(await access.create({ memoryStoreId: "st", path: "/a.md", content: "x", signal })).toEqual({ type: "conflict" });
    expect(await access.create({ memoryStoreId: "st", path: "/new.md", content: "n", signal })).toEqual({ type: "applied" });
    expect(await access.update({ memoryStoreId: "st", memoryId: "st/a.md", path: "/a.md", content: "two", expectedContentSha256: "stale", signal })).toEqual({ type: "conflict" });
    expect(await access.update({ memoryStoreId: "st", memoryId: "st/a.md", path: "/a.md", content: "two", expectedContentSha256: await sha("one"), signal })).toEqual({ type: "applied" });
    expect(objects.get("st/a.md")?.text).toBe("two");
    expect(await access.update({ memoryStoreId: "st", memoryId: "st/a.md", path: "/b.md", content: "two", expectedContentSha256: await sha("two"), signal })).toEqual({ type: "applied" });
    expect([...objects.keys()].sort()).toEqual(["st/b.md", "st/new.md"]);
    expect(await access.update({ memoryStoreId: "st", memoryId: "st/gone.md", path: "/gone.md", content: "", expectedContentSha256: "x", signal })).toEqual({ type: "not_found" });
    expect(await access.delete({ memoryStoreId: "st", memoryId: "st/b.md", expectedContentSha256: "stale", signal })).toEqual({ type: "conflict" });
    expect(await access.delete({ memoryStoreId: "st", memoryId: "st/b.md", expectedContentSha256: await sha("two"), signal })).toEqual({ type: "applied" });
    expect(await access.delete({ memoryStoreId: "st", memoryId: "other/x.md", expectedContentSha256: "x", signal })).toEqual({ type: "not_found" });
    await expect(access.create({ memoryStoreId: "st", path: "/../escape", content: "", signal })).rejects.toThrow(/Unsafe/);
    await expect(access.list({ memoryStoreId: "../x", projection: "basic", signal })).rejects.toThrow(/Unsafe/);
  });

  it("accepts the writable runtime mount id (a nested prefix) and still rejects unsafe segments", async () => {
    // materializeManagedMemorySnapshot: read_write stores mount `.openma-managed-memory-workspaces/<ws>/<session>/<generation>/<store>/data`.
    const mount = ".openma-managed-memory-workspaces/default/sess/gen1/memstore_1/data";
    const { bucket, objects } = fakeBucket({ [`${mount}/seed.md`]: "seed" });
    const access = createR2MemoryPrefixAccess(bucket);
    expect(await access.list({ memoryStoreId: mount, projection: "full", signal })).toEqual([
      { id: `${mount}/seed.md`, path: "/seed.md", contentSha256: await sha("seed"), content: "seed" },
    ]);
    expect(await access.create({ memoryStoreId: mount, path: "/new.md", content: "n", signal })).toEqual({ type: "applied" });
    expect(objects.has(`${mount}/new.md`)).toBe(true);
    for (const bad of ["", "a//b", "a/../b", "./a", "a/", "/a"]) {
      await expect(access.list({ memoryStoreId: bad, projection: "basic", signal })).rejects.toThrow(/Unsafe Memory Store id/);
    }
  });

  it("drives the shared Memory file sync: copy in, write back, pull", async () => {
    const { bucket, objects } = fakeBucket({ "st/a.md": "one" });
    const files = new Map<string, string>();
    const q = (cmd: string) => [...cmd.matchAll(/'([^']*)'/gu)].map((m) => m[1]!);
    const sandbox = {
      async exec(cmd: string) {
        if (cmd.includes("find . -type f")) {
          const root = q(cmd)[0]!;
          const names = [...files.keys()].filter((p) => p.startsWith(`${root}/`)).map((p) => `./${p.slice(root.length + 1)}`);
          return `exit=0\n${names.length ? btoa(names.join("\0") + "\0") : ""}`;
        }
        if (cmd.startsWith("if [ -f ")) return `exit=0\n${files.has(q(cmd)[0]!) ? "1" : "0"}`;
        if (cmd.includes("rm -rf -- ")) { const root = q(cmd).at(-2)!; for (const k of [...files.keys()]) if (k.startsWith(`${root}/`)) files.delete(k); }
        return "exit=0\n";
      },
      async readFile(path: string) { return files.get(path)!; },
      async writeFile(path: string, content: string) { files.set(path, content); return path; },
    };
    const sync = sandboxMemoryStoreSync(sandbox);
    const context = {
      session: { id: "sess", resources: [{ type: "memory_store", memory_store_id: "st", mount_path: "/mnt/memory/notes", access: "read_write" }] },
      resourceOwnership: { memoryStore: "materializer" as const },
      access: { memories: createR2MemoryPrefixAccess(bucket) },
      authorize: async () => true,
      signal,
    };
    await sync.materialize(context);
    expect(files.get("/mnt/memory/notes/a.md")).toBe("one");
    files.set("/mnt/memory/notes/a.md", "edited");
    files.set("/mnt/memory/notes/b.md", "added");
    objects.set("st/c.md", { text: "from-another-session", etag: "e" });
    await sync.synchronize(context);
    expect(objects.get("st/a.md")?.text).toBe("edited");
    expect(objects.get("st/b.md")?.text).toBe("added");
    expect(files.get("/mnt/memory/notes/c.md")).toBe("from-another-session");
  });
});
