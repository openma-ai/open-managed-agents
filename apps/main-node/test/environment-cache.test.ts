import { describe, expect, it } from "vitest";
import type { KvStore } from "@open-managed-agents/kv-store";
import type { SandboxLifecyclePort, SandboxPlan, SandboxPort } from "@open-managed-agents/sandbox";
import {
  createNodeEnvironmentCache,
  environmentCacheAcpInstall,
  NodeEnvironmentCache,
  redact,
  type EnvironmentCacheSetup,
} from "../../../packages/control-plane-node/src/lib/environment-cache.js";

const logger = () => {
  const warned: string[] = [];
  return { warned, logger: { info: () => undefined, warn: (_f: Record<string, unknown>, message: string) => { warned.push(message); } } };
};

function kv() {
  const data = new Map<string, string>();
  return { data, store: {
    get: async (key: string) => data.get(key) ?? null,
    put: async (key: string, value: string) => { data.set(key, value); },
    delete: async (key: string) => { data.delete(key); },
  } as unknown as KvStore };
}

function lifecycle(snapshots = true) {
  const froms: SandboxPlan["from"][] = [];
  let n = 0;
  const port = {
    handle: "changes", maxLifetimeMs: null,
    acquire: async ({ plan }: { plan: SandboxPlan }) => { froms.push(plan.from); return { runtime: {} as SandboxPort, handle: { provider: "x", runtimeId: "h" + ++n } }; },
    release: async () => undefined,
    ...(snapshots ? { snapshotEnvironment: async () => ({ adapter: "e2b", ref: "snap_" + ++n }) } : {}),
  } as unknown as SandboxLifecyclePort<SandboxPort>;
  return { port, froms };
}

const environment: EnvironmentCacheSetup["environment"] = { id: "env_1", config: { type: "cloud", packages: { pip: ["pandas"] } } };
const scope = (sessionId: string) => ({ workspaceId: "ws_1", environmentId: "env_1", sessionId, workId: sessionId });
const plan = (image: string) => ({ from: { image }, egress: null, stores: [], outputs: {}, idleMs: 1, labels: { workspaceId: "ws_1", sessionId: "s" } }) as unknown as SandboxPlan;

describe("environmentCacheAcpInstall", () => {
  it("pins ACP installs and refuses an unpinned one", () => {
    expect(environmentCacheAcpInstall(undefined)).toBeNull();
    expect(environmentCacheAcpInstall("claude-acp@0.94.0")).not.toBeNull();
    expect(() => environmentCacheAcpInstall("claude-acp@0.0.1")).toThrow(/not pinned/);
  });
});

describe("redact", () => {
  it("masks the pip index and URL credentials, and leaves host:port alone", () => {
    expect(redact("failed at https://i.example/simple", "https://i.example/simple")).toBe("failed at <pip-index-url>");
    expect(redact("https://user:pw@h.example/x", undefined)).toBe("https://***@h.example/x");
    expect(redact("connect http://localhost:8080/x", undefined)).toBe("connect http://localhost:8080/x");
  });
});

describe("createNodeEnvironmentCache", () => {
  const deps = () => ({ kvFor: () => kv().store, ...logger() });

  it("is on only for an adapter that can snapshot", () => {
    expect(createNodeEnvironmentCache({ environment: {} }, { name: "e2b", lifecycle: lifecycle().port }, deps())).toBeInstanceOf(NodeEnvironmentCache);
    expect(createNodeEnvironmentCache({ environment: {} }, { name: "x", lifecycle: lifecycle(false).port }, deps())).toBeUndefined();
    expect(createNodeEnvironmentCache({ environment: {} }, undefined, deps())).toBeUndefined();
  });

  it("warns when the expiry is configured on a path without a cache, and stays silent otherwise", () => {
    const configured = deps();
    createNodeEnvironmentCache({ environment: { SANDBOX_TEMPLATE_USED_TTL_MS: "60000" } }, undefined, configured);
    expect(configured.warned).toHaveLength(1);
    const plain = deps();
    createNodeEnvironmentCache({ environment: {} }, undefined, plain);
    expect(plain.warned).toEqual([]);
  });

  it("rejects an invalid TTL", () => {
    expect(() => createNodeEnvironmentCache({ environment: { SANDBOX_TEMPLATE_USED_TTL_MS: "soon" } }, { name: "e2b", lifecycle: lifecycle().port }, deps())).toThrow(/SANDBOX_TEMPLATE_USED_TTL_MS/);
  });
});

describe("NodeEnvironmentCache per Session", () => {
  function harness() {
    const store = kv();
    const life = lifecycle();
    const setups: string[] = [];
    const cache = new NodeEnvironmentCache({
      adapter: "e2b", lifecycle: life.port, kvFor: () => store.store, logger: logger().logger,
      setup: async (_r, _s, buildId) => { setups.push(buildId); },
    });
    const forSession = (setup: EnvironmentCacheSetup | null) => cache.forSession(() => setup, () => undefined);
    const run = async (id: string, image: string, setup: EnvironmentCacheSetup | null = { environment }) => {
      const session = forSession(setup);
      await session.acquire({ scope: scope(id), plan: plan(image), signal: new AbortController().signal });
      session.prepared(scope(id));
      await cache.idle();
    };
    return { store, life, setups, run };
  }

  it("misses, builds in the background under the KV prefix deployments already have, then hits", async () => {
    const h = harness();
    await h.run("s1", "base");
    expect([...h.store.data.keys()][0]).toMatch(/^sandbox_prepared_base:v1:e2b:[0-9a-f]{64}$/);
    expect(h.setups[0]).toMatch(/^env_snapshot_/);
    await h.run("s2", "base");
    expect(h.life.froms.at(-1)).toMatchObject({ environmentSnapshot: { adapter: "e2b" } });
  });

  it("a new image digest misses even though the old snapshot would still start", async () => {
    const h = harness();
    await h.run("s1", "img@sha256:1");
    await h.run("s2", "img@sha256:2");
    expect(h.life.froms.at(-1)).toEqual({ image: "img@sha256:2" });
    expect(h.store.data.size).toBe(2);
  });

  it("does nothing for a Session with no known setup", async () => {
    const h = harness();
    await h.run("s1", "base", null);
    expect(h.store.data.size).toBe(0);
    expect(h.setups).toEqual([]);
  });
});
