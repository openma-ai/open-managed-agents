// The control plane is a value, not a module side effect: two of them can be
// assembled in one process from different environments, each owns its own
// resources and lifecycle, and a deployment hands it the components it has
// already chosen instead of describing them through environment variables.

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SandboxFactory } from "@open-managed-agents/sandbox";
import type { BlobStore as MemoryBlobStore } from "@open-managed-agents/memory-store";
import { InMemoryBlobStore } from "@open-managed-agents/blob-store/adapters/in-memory";

import { loadNodeConfig } from "../src/config";
import { createNodeControlPlane, type NodeControlPlane } from "../src/control-plane";
import { nodeDefaults, type NodeComponentOverrides } from "../src/components";
import type { EventStreamHub } from "../src/lib/event-stream-hub";

const created: NodeControlPlane[] = [];
const dirs: string[] = [];

function environment(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const dir = mkdtempSync(join(tmpdir(), "oma-control-plane-"));
  dirs.push(dir);
  return {
    NODE_ENV: "test",
    AUTH_DISABLED: "1",
    OPENMA_TEST_SANDBOX_PROVIDER: "local-subprocess",
    MEMORY_QUEUE: "disabled",
    DATABASE_PATH: join(dir, "oma.db"),
    AUTH_DATABASE_PATH: join(dir, "auth.db"),
    SANDBOX_WORKDIR: join(dir, "sandboxes"),
    MEMORY_BLOB_DIR: join(dir, "memories"),
    FILES_BLOB_DIR: join(dir, "files"),
    SESSION_OUTPUTS_DIR: join(dir, "outputs"),
    ANTHROPIC_API_KEY: "unused",
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((cp) => cp.stop("test")));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function controlPlane(
  overridesFor?: NodeComponentOverrides,
  overrides?: Record<string, string | undefined>,
): Promise<NodeControlPlane> {
  const cp = await createNodeControlPlane(await nodeDefaults(loadNodeConfig(environment(overrides)), overridesFor));
  created.push(cp);
  return cp;
}

const beta = { "anthropic-beta": "managed-agents-2026-04-01" };
const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

async function health(cp: NodeControlPlane) {
  return (await cp.fetch(new Request("http://cp/health"))).json() as Promise<{
    status: string;
    backends: Record<string, string>;
  }>;
}

/** Create a cloud Environment + legacy Agent + legacy Session; return the session id. */
async function legacySession(cp: NodeControlPlane): Promise<string> {
  const env = await (await cp.fetch(new Request("http://cp/v1/environments", json({
    name: "cp-env",
    config: { type: "cloud", networking: { type: "unrestricted" } },
  }, beta)))).json() as { id: string };
  const agent = await (await cp.fetch(new Request("http://cp/v1/oma/agents", json({
    name: "cp", model: "claude-sonnet-4-6", system: "hi",
  })))).json() as { id: string };
  const session = await (await cp.fetch(new Request("http://cp/v1/oma/sessions", json({
    agent: agent.id, environment_id: env.id,
  })))).json() as { id: string };
  expect(session.id).toMatch(/^sess/);
  return session.id;
}

describe("createNodeControlPlane", () => {
  it("assembles two independent control planes in one process", async () => {
    const [a, b] = await Promise.all([controlPlane(), controlPlane()]);

    expect(a.backendDescription).not.toBe(b.backendDescription);
    const createdOnA = await a.fetch(new Request("http://cp/v1/oma/agents", json({
      name: "cp-test", model: "claude-sonnet-4-6", system: "hi",
    })));
    expect(createdOnA.status).toBe(201);

    const listOnB = await (await b.fetch(new Request("http://cp/v1/oma/agents"))).json() as { data: unknown[] };
    expect(listOnB.data).toHaveLength(0);
  });

  it("reports the assembled backends on /health without listening", async () => {
    const cp = await controlPlane();
    const body = await health(cp);
    expect(body.status).toBe("ok");
    expect(body.backends.db).toBe(cp.backendDescription);
    expect(body.backends.hub).toBe("in-process");
  });

  it("stops idempotently", async () => {
    const cp = await controlPlane();
    await cp.stop("first");
    await expect(cp.stop("second")).resolves.toBeUndefined();
  });
});

describe("createNodeControlPlane dependency injection", () => {
  it("runs legacy session turns through an injected sandbox factory instead of SANDBOX_PROVIDER", async () => {
    const sentinel = "injected sandbox factory was called";
    const calls: string[] = [];
    const sandboxFactory: SandboxFactory = async (ctx) => {
      calls.push(ctx.sessionId);
      throw new Error(sentinel);
    };
    // No SANDBOX_PROVIDER / OPENMA_TEST_SANDBOX_PROVIDER at all: with injection
    // the environment must not be consulted for a provider.
    const cp = await controlPlane({ sandbox: sandboxFactory }, { OPENMA_TEST_SANDBOX_PROVIDER: undefined });
    const sessionId = await legacySession(cp);

    const sent = await cp.fetch(new Request(`http://cp/v1/oma/sessions/${sessionId}/events`, json({
      events: [{ type: "user.message", content: [{ type: "text", text: "ping" }] }],
    })));
    expect(sent.status).toBeLessThan(300);

    let events: Array<{ type: string }> = [];
    for (let i = 0; i < 100 && !events.some((e) => e.type === "session.error"); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const page = await (await cp.fetch(new Request(`http://cp/v1/oma/sessions/${sessionId}/events`))).json() as { data: Array<{ type: string }> };
      events = page.data;
    }
    expect(calls).toEqual([sessionId]);
    expect(JSON.stringify(events)).toContain(sentinel);
  });

  it("attaches legacy event streams to an injected realtime hub and reports it on /health", async () => {
    const attached: string[] = [];
    const hub: EventStreamHub = {
      attach(sessionId) { attached.push(sessionId); return () => undefined; },
      publish() {},
      closeSession() {},
    };
    const cp = await controlPlane({ realtime: { hub, replicaSync: null, description: "custom" } });
    expect((await health(cp)).backends.hub).toBe("custom");

    const sessionId = await legacySession(cp);
    const abort = new AbortController();
    const stream = await cp.fetch(new Request(`http://cp/v1/oma/sessions/${sessionId}/events/stream`, { signal: abort.signal }));
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    await reader.read();
    abort.abort();
    await reader.cancel().catch(() => undefined);

    expect(attached).toEqual([sessionId]);
  });

  it("uses injected blob stores and reports them on /health", async () => {
    const memory = new Map<string, string>();
    const memoryStore: MemoryBlobStore = {
      head: async (key) => (memory.has(key) ? { etag: key, size: memory.get(key)!.length } : null),
      getText: async (key) => (memory.has(key) ? { text: memory.get(key)!, etag: key, size: memory.get(key)!.length } : null),
      list: async (prefix) => ({ keys: [...memory.keys()].filter((k) => k.startsWith(prefix)), nextCursor: null }),
      put: async (key, body) => { memory.set(key, body); return { etag: key, size: body.length }; },
      delete: async (key) => { memory.delete(key); },
    };
    const cp = await controlPlane({
      blobs: {
        memory: { store: memoryStore, description: "test memory store" },
        files: { store: new InMemoryBlobStore(), description: "test files store" },
      },
    });

    const body = await health(cp);
    expect(body.backends.memory_blobs).toBe("test memory store");
    expect(body.backends.files_blobs).toBe("test files store");
  });
});

describe("createNodeControlPlane dependency injection (official /v1 Sessions)", () => {
  it("runs v1 session turns through the injected sandbox factory as well", async () => {
    const calls: string[] = [];
    const sandboxFactory: SandboxFactory = async (ctx) => {
      calls.push(ctx.sessionId);
      throw new Error("injected sandbox factory was called");
    };
    const cp = await controlPlane({ sandbox: sandboxFactory }, { OPENMA_TEST_SANDBOX_PROVIDER: undefined });
    const env = await (await cp.fetch(new Request("http://cp/v1/environments", json({
      name: "cp-env", config: { type: "cloud", networking: { type: "unrestricted" } },
    }, beta)))).json() as { id: string };
    const agent = await (await cp.fetch(new Request("http://cp/v1/agents", json({
      name: "cp", model: "claude-sonnet-4-6", system: "hi",
    }, beta)))).json() as { id: string };
    const session = await (await cp.fetch(new Request("http://cp/v1/sessions", json({
      agent: agent.id, environment_id: env.id,
    }, beta)))).json() as { id: string };
    expect(session.id).toMatch(/^session_/);

    // v1 turns are claimed by the execution poller, which only runs after start().
    await cp.start();
    const sent = await cp.fetch(new Request(`http://cp/v1/sessions/${session.id}/events`, json({
      events: [{ type: "user.message", content: [{ type: "text", text: "ping" }] }],
    }, beta)));
    expect(sent.status).toBeLessThan(300);

    for (let i = 0; i < 150 && calls.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(calls).toEqual([session.id]);
  });
});
