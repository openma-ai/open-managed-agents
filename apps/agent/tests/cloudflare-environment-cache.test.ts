// The environment cache on Cloudflare containers: the shared core
// (session-runtime EnvironmentCache) over the Cloudflare adapter, with a fake
// Sandbox Durable Object per id.
import { describe, expect, it } from "vitest";
import type { EnvironmentCacheStore, EnvironmentCacheWarning } from "@open-managed-agents/session-runtime";
import { createCloudflareSandboxAdapter, type CloudflareSandboxRuntime } from "../src/runtime/cloudflare-sandbox-ports";
import {
  createCloudflareEnvironmentCache,
  d1EnvironmentCacheStore,
  ENVIRONMENT_BUILD_HOSTS,
  environmentKey,
  type CloudflareEnvironmentSetup,
} from "../src/runtime/cloudflare-environment-cache";

const IMAGE = "registry.cloudflare.com/acct/sandbox@sha256:aaa";
const outputs = { bindingId: "out", mountPath: "/mnt/session/outputs" as const };
const signal = new AbortController().signal;
const setup: CloudflareEnvironmentSetup = { environmentId: "env", packages: { apt: ["jq"], pip: ["six"] } };
const scopeOf = (sessionId: string) => ({ workspaceId: "ws", environmentId: "env", sessionId, workId: sessionId });
const planOf = (sessionId: string, image = IMAGE) => ({
  from: { image }, egress: null, stores: [], outputs, idleMs: 1, labels: { workspaceId: "ws", sessionId },
});

function harness(options: { failSnapshot?: boolean; failInstall?: boolean } = {}) {
  const log: string[] = [];
  const gone = new Set<string>();
  let snapshots = 0;
  const runtimes = new Map<string, CloudflareSandboxRuntime>();
  const runtimeFor = (id: string): CloudflareSandboxRuntime => {
    let runtime = runtimes.get(id);
    if (runtime !== undefined) return runtime;
    runtime = {
      async describeSandbox() { return { running: true, incarnation: "i", mounts: [] }; },
      async provisionSandbox(input: { mounts: Array<{ mountPath: string }>; containerSnapshot?: { id: string } }) {
        const snapshot = input.containerSnapshot?.id;
        if (snapshot !== undefined && gone.has(snapshot)) throw new Error(`SNAPSHOT_GONE: container snapshot ${snapshot}: Snapshot "${snapshot}" was not found.`);
        log.push(`start:${id}:${snapshot ?? "image"}:mounts=${input.mounts.map((m) => m.mountPath).join(",")}`);
        return { incarnation: "i", started: true, pendingMounts: [] };
      },
      sessionOutputsMount: () => (id.startsWith("env_snapshot_") ? null : { bucket: "files", mountPath: "/mnt/session/outputs", options: {} }),
      memoryStoreMount: () => { throw new Error("no stores"); },
      async restrictOutboundToHosts(hosts: string[]) { log.push(`egress:${id}:${hosts.length === ENVIRONMENT_BUILD_HOSTS.length ? "package-sources" : hosts.join(",")}`); },
      async snapshotEnvironment() {
        if (options.failSnapshot) throw new Error("snapshot quota exceeded");
        snapshots += 1;
        log.push(`snapshot:${id}`);
        return { id: `snap-${snapshots}`, size: 46 };
      },
      async destroy() { log.push(`release:${id}`); runtimes.delete(id); },
    } as unknown as CloudflareSandboxRuntime;
    runtimes.set(id, runtime);
    return runtime;
  };
  const adapter = createCloudflareSandboxAdapter({ sandbox: runtimeFor, backups: { async delete() {} } });
  const rows = new Map<string, string>();
  const store: EnvironmentCacheStore = {
    get: async (key) => rows.get(key) ?? null,
    put: async (key, value) => { rows.set(key, value); },
    delete: async (key) => { rows.delete(key); },
  };
  const warnings: EnvironmentCacheWarning[] = [];
  const background: Promise<unknown>[] = [];
  const cache = createCloudflareEnvironmentCache({
    lifecycle: adapter.lifecycle,
    storeFor: () => store,
    setup: async () => setup,
    warn: (warning) => warnings.push(warning),
    waitUntil: (promise) => background.push(promise),
    build: async (runtime) => {
      const id = [...runtimes].find(([, r]) => r === runtime)![0];
      log.push(`install:${id}`);
      if (options.failInstall) throw new Error("apt_install_failed exit=100");
    },
  });
  /** A Session: acquire, then (as SessionDO does after its own install) prepared. */
  const session = async (id: string, image = IMAGE) => {
    const acquired = await cache.acquire({ scope: scopeOf(id), plan: planOf(id, image), signal });
    if (acquired === "gone") throw new Error("unexpected gone");
    log.push(`install:${id}`);
    cache.prepared(scopeOf(id));
    await Promise.all(background);
    return acquired;
  };
  return { log, gone, rows, warnings, background, cache, session };
}

describe("Cloudflare environment cache", () => {
  it("miss: starts from the image without a warning, then builds the snapshot in the background", async () => {
    const h = harness();
    await h.session("s1");
    expect(h.warnings).toEqual([]);
    expect(h.log[0]).toBe("start:s1:image:mounts=/mnt/session/outputs");
    expect(h.log[1]).toBe("install:s1");
    // The build sandbox: its own Durable Object, no Session outputs, egress
    // limited to package sources before the setup runs, then released.
    const build = h.log.slice(2);
    const buildId = build[0]!.split(":")[1]!;
    expect(buildId).toMatch(/^env_snapshot_/);
    expect(build).toEqual([
      `start:${buildId}:image:mounts=`,
      `egress:${buildId}:package-sources`,
      `install:${buildId}`,
      `snapshot:${buildId}`,
      `release:${buildId}`,
    ]);
    const [record] = [...h.rows.values()];
    expect(JSON.parse(record!)).toMatchObject({ state: "ready", snapshot: { adapter: "cloudflare", ref: "snap-1" } });
  });

  it("hit: the next Session starts from the snapshot and installs nothing new", async () => {
    const h = harness();
    await h.session("s1");
    h.log.length = 0;
    const acquired = await h.cache.acquire({ scope: scopeOf("s2"), plan: planOf("s2"), signal });
    expect(acquired).toMatchObject({ handle: { provider: "cloudflare", runtimeId: "s2" } });
    expect(h.log).toEqual(["start:s2:snap-1:mounts=/mnt/session/outputs"]);
    h.cache.prepared(scopeOf("s2"));
    await Promise.all(h.background);
    expect(h.log.some((entry) => entry.startsWith("snapshot:"))).toBe(false);
    expect(h.warnings).toEqual([]);
  });

  it("snapshot gone (not found / expired): a miss at the first failure with a warning, rebuilt, then hit again", async () => {
    const h = harness();
    await h.session("s1");
    h.gone.add("snap-1");
    h.log.length = 0;
    await h.session("s3");
    expect(h.warnings).toEqual([expect.objectContaining({ reason: "snapshot_gone" })]);
    expect(h.log[0]).toBe("start:s3:image:mounts=/mnt/session/outputs");
    expect(h.log.some((entry) => /^snapshot:env_snapshot_/.test(entry))).toBe(true);
    expect(JSON.parse([...h.rows.values()][0]!)).toMatchObject({ snapshot: { ref: "snap-2" } });
    // Containers cannot delete a snapshot: nothing is kept to retry.
    expect(JSON.parse([...h.rows.values()][0]!).retired).toBeUndefined();

    h.log.length = 0;
    await h.cache.acquire({ scope: scopeOf("s4"), plan: planOf("s4"), signal });
    expect(h.log).toEqual(["start:s4:snap-2:mounts=/mnt/session/outputs"]);
  });

  it("a new image digest is a different key: a plain miss, never the old image's snapshot", async () => {
    const h = harness();
    await h.session("s1");
    h.log.length = 0;
    await h.session("s5", "registry.cloudflare.com/acct/sandbox@sha256:bbb");
    expect(h.warnings).toEqual([]);
    expect(h.log[0]).toBe("start:s5:image:mounts=/mnt/session/outputs");
    expect(h.rows.size).toBe(2);
    expect(await environmentKey(setup, { image: IMAGE })).not.toBe(await environmentKey(setup, { image: "registry.cloudflare.com/acct/sandbox@sha256:bbb" }));
    expect(await environmentKey(setup, { image: "deployment" })).toBeNull();
  });

  it("snapshot fails: the Session is unaffected, warned, and the next Session builds again", async () => {
    const h = harness({ failSnapshot: true });
    await h.session("s1");
    expect(h.warnings).toEqual([expect.objectContaining({ reason: "snapshot_build_failed" })]);
    expect(h.rows.size).toBe(0);
    expect(h.log.filter((entry) => entry.startsWith("release:env_snapshot_"))).toHaveLength(1);
    h.warnings.length = 0;
    await h.session("s2");
    expect(h.log.filter((entry) => /^start:env_snapshot_/.test(entry))).toHaveLength(2);
  });

  it("an install that fails builds nothing and records nothing", async () => {
    const h = harness({ failInstall: true });
    await h.session("s1");
    expect(h.rows.size).toBe(0);
    expect(h.log.some((entry) => entry.startsWith("snapshot:"))).toBe(false);
    expect(h.warnings).toEqual([expect.objectContaining({ reason: "snapshot_build_failed" })]);
    // A Session whose own install failed never calls prepared: no build at all.
    const s = harness();
    await s.cache.acquire({ scope: scopeOf("s9"), plan: planOf("s9"), signal });
    await Promise.all(s.background);
    expect(s.log).toEqual(["start:s9:image:mounts=/mnt/session/outputs"]);
  });

  it("stores records in the tenant D1 kv_entries, scoped to the workspace", async () => {
    const calls: Array<{ sql: string; args: unknown[] }> = [];
    let row: { value: string; expires_at: number | null } | null = null;
    const db = {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          first: async () => { calls.push({ sql, args }); return row; },
          run: async () => { calls.push({ sql, args }); return {}; },
        }),
      }),
    } as unknown as D1Database;
    const store = d1EnvironmentCacheStore(db, "ws");
    expect(await store.get("k")).toBeNull();
    row = { value: "v", expires_at: null };
    expect(await store.get("k")).toBe("v");
    row = { value: "v", expires_at: 1 };
    expect(await store.get("k")).toBeNull();
    await store.put("k", "v2");
    await store.delete("k");
    expect(calls.every((call) => call.args[0] === "ws" && call.args[1] === "k")).toBe(true);
    expect(calls.at(-2)!.sql).toMatch(/ON CONFLICT \(tenant_id, key\) DO UPDATE/);
  });
});
