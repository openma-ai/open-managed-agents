import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { SandboxTokenSession } from "@open-managed-agents/sandbox-gateway";
import type { R2EventMessage } from "@open-managed-agents/shared";
import { sandboxStorageRoutes } from "../src/routes/sandbox-storage";

type StoredObject = {
  bytes: Uint8Array;
  customMetadata: Record<string, string>;
  contentType: string;
  uploaded: Date;
};

function bucket(initial: Record<string, string>) {
  const values = new Map<string, StoredObject>(Object.entries(initial).map(([key, value]) => [key, {
    bytes: new TextEncoder().encode(value),
    customMetadata: {},
    contentType: "text/plain",
    uploaded: new Date("2026-01-01T00:00:00.000Z"),
  }]));
  const object = (key: string) => {
    const value = values.get(key);
    if (!value) return null;
    return {
      key,
      size: value.bytes.byteLength,
      etag: "etag",
      uploaded: value.uploaded,
      httpMetadata: { contentType: value.contentType },
      customMetadata: value.customMetadata,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(value.bytes);
          controller.close();
        },
      }),
    };
  };
  const port = {
    values,
    async head(key: string) { return object(key); },
    async get(key: string) { return object(key); },
    async put(key: string, body: ReadableStream<Uint8Array>, options?: { customMetadata?: Record<string, string>; httpMetadata?: { contentType?: string } }) {
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      values.set(key, {
        bytes,
        customMetadata: options?.customMetadata ?? {},
        contentType: options?.httpMetadata?.contentType ?? "application/octet-stream",
        uploaded: new Date(),
      });
      return object(key);
    },
    async delete(key: string) { values.delete(key); },
    async list(options: { prefix?: string; delimiter?: string } = {}) {
      const prefix = options.prefix ?? "";
      const objects: ReturnType<typeof object>[] = [];
      const delimitedPrefixes = new Set<string>();
      for (const key of values.keys()) {
        if (!key.startsWith(prefix)) continue;
        const remainder = key.slice(prefix.length);
        const slash = remainder.indexOf("/");
        if (slash >= 0 && options.delimiter === "/") delimitedPrefixes.add(`${prefix}${remainder.slice(0, slash + 1)}`);
        else if (object(key)) objects.push(object(key));
      }
      return { objects, delimitedPrefixes: [...delimitedPrefixes], truncated: false, cursor: "" };
    },
  };
  return port;
}

const session = {
  workspaceId: "tenant",
  sessionId: "sess",
  archivedAt: null,
  environmentId: "env",
  vaultIds: [],
  agent: { id: "agent", version: 1 },
  skills: [],
  fileIds: [],
  memoryStores: [{ memoryStoreId: "store", access: "read_write" as const }],
} satisfies SandboxTokenSession;

function appFor(storage: ReturnType<typeof bucket>, sent: R2EventMessage[] = []) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("tenant_id", "tenant");
    c.set("sandbox_session", session);
    await next();
  });
  app.route("/v1/oma/storage", sandboxStorageRoutes);
  return { app, env: { MEMORY_BUCKET: storage, MEMORY_QUEUE: { send: async (event: R2EventMessage) => { sent.push(event); } } } };
}

describe("sandbox storage gateway", () => {
  it("returns entries relative to the requested directory", async () => {
    const storage = bucket({ "store/dir/a.txt": "a", "store/dir/b.txt": "b", "store/root.txt": "r" });
    const { app, env } = appFor(storage);
    const response = await app.request("/v1/oma/storage/sessions/sess/objects/memory/store?prefix=dir", {}, env);
    expect(response.status).toBe(200);
    expect((await response.json()).entries).toMatchObject([
      { path: "a.txt", is_dir: false },
      { path: "b.txt", is_dir: false },
    ]);
  });

  it("persists SetModTime metadata through the File API", async () => {
    const storage = bucket({ "store/a.txt": "a" });
    const { app, env } = appFor(storage);
    const response = await app.request("/v1/oma/storage/sessions/sess/objects/memory/store/a.txt", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mod_time: "2026-02-03T04:05:06.000Z" }),
    }, env);
    expect(response.status).toBe(204);
    expect((await storage.head("store/a.txt"))?.customMetadata).toEqual({
      oma_mod_time: "2026-02-03T04:05:06.000Z",
      actor_type: "agent_session",
      actor_id: "sess",
    });
    const listing = await app.request("/v1/oma/storage/sessions/sess/objects/memory/store?prefix=", {}, env);
    const listingBody = await listing.json();
    expect(listing.status, JSON.stringify(listingBody)).toBe(200);
    expect(listingBody.entries).toMatchObject([{ path: "a.txt", mod_time: "2026-02-03T04:05:06.000Z" }]);
  });

  it("attributes direct Memory Store writes to the sandbox session", async () => {
    const storage = bucket({});
    const sent: R2EventMessage[] = [];
    const { app, env } = appFor(storage, sent);
    const response = await app.request("/v1/oma/storage/sessions/sess/objects/memory/store/a.txt", {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body: "from agent",
    }, env);
    expect(response.status).toBe(204);
    expect((await storage.head("store/a.txt"))?.customMetadata).toMatchObject({
      actor_type: "agent_session",
      actor_id: "sess",
    });
    expect(sent).toMatchObject([{ action: "PutObject", object: { key: "store/a.txt" }, actor: { type: "agent_session", id: "sess" } }]);
  });
});
