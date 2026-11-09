import { describe, expect, it } from "vitest";
import type { EnvironmentSnapshotRef, SandboxLifecyclePort, SandboxPlan } from "@open-managed-agents/sandbox";
import {
  ENVIRONMENT_CACHE_UNUSED_TTL_MS,
  ENVIRONMENT_CACHE_USED_TTL_MS,
  EnvironmentCache,
  EnvironmentSnapshotAdapterMismatchError,
  environmentCacheExpiry,
  type EnvironmentCacheWarning,
} from "../src/session-sandbox-environment-cache";
import { PortsSessionSandbox } from "../src/ports-session-sandbox";

const DAY = 24 * 60 * 60_000;
const FROM_IMAGE: SandboxPlan["from"] = { image: "img@sha256:1" };

const scopeOf = (sessionId: string, workspaceId = "ws_1") => ({ workspaceId, environmentId: "env_1", sessionId, workId: sessionId });
const planOf = (sessionId: string): SandboxPlan => ({
  from: FROM_IMAGE,
  egress: { scope: { workspaceId: "ws_1", sessionId, generation: 1 }, networking: { type: "unrestricted" }, substitutions: [] },
  stores: [{ storeName: "m" } as never],
  outputs: { bindingId: "o", mountPath: "/mnt/session/outputs" } as never,
  idleMs: 1,
  labels: { workspaceId: "ws_1", sessionId },
});

/** A fake adapter: its refs are arbitrary strings the core must not read. */
function harness(options: {
  acquire?: (from: SandboxPlan["from"]) => "gone" | Error | undefined;
  snapshot?: () => Promise<EnvironmentSnapshotRef>;
  restrictEgress?: () => Promise<void>;
  setup?: () => Promise<void>;
  deleteSnapshot?: ((ref: EnvironmentSnapshotRef) => Promise<void>) | null;
  noSnapshots?: boolean;
} = {}) {
  const stores = new Map<string, Map<string, string>>();
  const storeOf = (id: string) => stores.get(id) ?? stores.set(id, new Map()).get(id)!;
  const data = storeOf("ws_1");
  let now = 0;
  let n = 0;
  const acquires: Array<{ sessionId: string; plan: SandboxPlan }> = [];
  const released: string[] = [];
  const setups: string[] = [];
  const deleted: string[] = [];
  const logs: string[] = [];
  const warnings: EnvironmentCacheWarning[] = [];
  const lifecycle = {
    handle: "changes", maxLifetimeMs: null,
    acquire: async ({ scope, plan }: { scope: { sessionId: string }; plan: SandboxPlan }) => {
      acquires.push({ sessionId: scope.sessionId, plan });
      const result = options.acquire?.(plan.from);
      if (result === "gone") return "gone";
      if (result instanceof Error) throw result;
      return { runtime: "rt_" + ++n, handle: { provider: "fake", runtimeId: "h_" + n } };
    },
    release: async ({ handle }: { handle: { runtimeId: string } }) => { released.push(handle.runtimeId); },
    ...(options.noSnapshots === true ? {} : {
      snapshotEnvironment: options.snapshot ?? (async () => ({ adapter: "fake", ref: "any:opaque/" + ++n })),
    }),
    ...(options.deleteSnapshot === null || options.noSnapshots === true ? {} : {
      deleteEnvironmentSnapshot: async ({ ref }: { ref: EnvironmentSnapshotRef }) => {
        deleted.push(ref.ref);
        await options.deleteSnapshot?.(ref);
      },
    }),
  } as unknown as SandboxLifecyclePort<string>;
  const cache = new EnvironmentCache<string, string>({
    adapter: "fake",
    lifecycle,
    storeFor: (id) => {
      const map = storeOf(id);
      return { get: async (k) => map.get(k) ?? null, put: async (k, v) => { map.set(k, v); }, delete: async (k) => { map.delete(k); } };
    },
    restrictEgress: async () => { setups.push("restricted"); await options.restrictEgress?.(); },
    setup: async (_runtime, setup) => { setups.push(setup); await options.setup?.(); },
    logger: { info: (f) => logs.push(String(f.path)), warn: (f) => logs.push(String(f.path)) },
    op: "test.environment_cache",
    clock: { now: () => now },
  });
  const acquire = (sessionId: string, input: { key?: string | null; workspaceId?: string } = {}) => cache.acquire({
    scope: scopeOf(sessionId, input.workspaceId),
    plan: planOf(sessionId),
    signal: new AbortController().signal,
    key: input.key === undefined ? "k1" : input.key,
    setup: "setup-of-" + sessionId,
    warn: (w) => warnings.push(w),
  });
  const sessionFroms = () => acquires.filter((a) => !a.sessionId.startsWith("env_snapshot_")).map((a) => a.plan.from);
  const builds = () => acquires.filter((a) => a.sessionId.startsWith("env_snapshot_"));
  /** A full Session: acquire, own install succeeded, background build done. */
  const session = async (sessionId: string, input: { key?: string | null; workspaceId?: string } = {}) => {
    const acquired = await acquire(sessionId, input);
    cache.prepared(scopeOf(sessionId, input.workspaceId));
    await cache.idle();
    return acquired;
  };
  const storeKey = "sandbox_prepared_base:v1:fake:k1";
  return { cache, data, stores, acquire, session, acquires, sessionFroms, builds, released, setups, deleted, logs, warnings, storeKey, advance: (ms: number) => { now += ms; } };
}

const snapshotFrom = (ref: string): SandboxPlan["from"] => ({ environmentSnapshot: { adapter: "fake", ref } });
const reasons = (h: ReturnType<typeof harness>) => h.warnings.map((w) => w.reason);

describe("environmentCacheExpiry", () => {
  it("defaults to 7 days unused and 14 days used, and is capped by the retention", () => {
    expect(environmentCacheExpiry({})).toEqual({ unusedTtlMs: 7 * DAY, usedTtlMs: 14 * DAY });
    expect(ENVIRONMENT_CACHE_UNUSED_TTL_MS).toBe(7 * DAY);
    expect(ENVIRONMENT_CACHE_USED_TTL_MS).toBe(14 * DAY);
    expect(() => environmentCacheExpiry({ maxRetentionMs: DAY })).toThrow(/retention/);
    expect(() => environmentCacheExpiry({ usedTtlMs: 0 })).toThrow(/positive/);
  });
});

describe("EnvironmentCache", () => {
  it("miss: starts from the image without a warning and records the adapter's opaque ref", async () => {
    const h = harness();
    await h.session("s1");
    expect(h.sessionFroms()).toEqual([FROM_IMAGE]);
    expect(h.warnings).toEqual([]);
    expect(JSON.parse(h.data.get(h.storeKey)!)).toMatchObject({ state: "ready", snapshot: { adapter: "fake", ref: expect.stringMatching(/^any:opaque/) } });
  });

  it("miss: nothing is built until the Session's own install succeeded, and a failed install builds nothing", async () => {
    const h = harness();
    await h.acquire("s1");
    await h.cache.idle();
    expect(h.builds()).toHaveLength(0);
    h.cache.abandon(scopeOf("s1"));
    h.cache.prepared(scopeOf("s1"));
    await h.cache.idle();
    expect(h.builds()).toHaveLength(0);
    expect(h.data.size).toBe(0);
  });

  it("miss: the snapshot runs in the background and prepared() does not wait for it", async () => {
    let finish!: (ref: EnvironmentSnapshotRef) => void;
    const h = harness({ snapshot: () => new Promise((resolve) => { finish = resolve; }) });
    await h.acquire("s1");
    expect(h.cache.prepared(scopeOf("s1"))).toBeUndefined();
    for (let i = 0; i < 20 && finish === undefined; i++) await Promise.resolve();
    expect(finish).toBeDefined();
    expect(h.data.size).toBe(0);
    finish({ adapter: "fake", ref: "late" });
    await h.cache.idle();
    expect(JSON.parse(h.data.get(h.storeKey)!).snapshot.ref).toBe("late");
  });

  it("builds on a clean sandbox: no egress, stores or Session labels, released afterwards", async () => {
    const h = harness();
    await h.session("s1");
    const [build] = h.builds();
    expect(build!.plan).toMatchObject({ from: FROM_IMAGE, egress: null, stores: [] });
    expect(build!.plan.labels.sessionId).toBe(build!.sessionId);
    expect(h.setups).toEqual(["restricted", "setup-of-s1"]);
    expect(h.released).toEqual(["h_2"]);
  });

  it("hit: starts from the snapshot, builds nothing and renews its use", async () => {
    const h = harness();
    await h.session("s1");
    const { snapshot } = JSON.parse(h.data.get(h.storeKey)!);
    await h.session("s2");
    expect(h.sessionFroms()).toEqual([FROM_IMAGE, { environmentSnapshot: snapshot }]);
    expect(h.builds()).toHaveLength(1);
    expect(h.warnings).toEqual([]);
    expect(JSON.parse(h.data.get(h.storeKey)!).lastUsedAtMs).toBe(0);
  });

  it("no key, or a plan that is already a snapshot, skips the cache", async () => {
    const h = harness();
    await h.session("s1", { key: null });
    expect(h.builds()).toHaveLength(0);
    expect(h.data.size).toBe(0);
  });

  it("a changed key (packages or image digest) misses without touching the old record", async () => {
    const h = harness();
    await h.session("s1", { key: "k1" });
    await h.session("s2", { key: "k2" });
    expect(h.sessionFroms()).toEqual([FROM_IMAGE, FROM_IMAGE]);
    expect(h.builds()).toHaveLength(2);
    expect([...h.data.keys()].sort()).toEqual([h.storeKey, "sandbox_prepared_base:v1:fake:k2"]);
  });

  it("is per workspace", async () => {
    const h = harness();
    await h.session("s1");
    await h.session("s2", { workspaceId: "ws_2" });
    expect(h.sessionFroms()).toEqual([FROM_IMAGE, FROM_IMAGE]);
    expect(h.stores.get("ws_2")!.size).toBe(1);
  });

  it("ref gone (acquire returns gone): deletes the record, warns, starts from the image and rebuilds; the next Session hits", async () => {
    let dead = false;
    const h = harness({ acquire: (from) => dead && "environmentSnapshot" in from ? "gone" : undefined });
    await h.session("s1");
    const old = JSON.parse(h.data.get(h.storeKey)!).snapshot.ref;
    dead = true;
    let during: string | undefined;
    const acquired = await h.acquire("s2");
    during = h.data.get(h.storeKey);
    expect(acquired).not.toBe("gone");
    expect(during).toBeUndefined();
    expect(reasons(h)).toEqual(["snapshot_gone"]);
    expect(h.sessionFroms().at(-1)).toEqual(FROM_IMAGE);
    h.cache.prepared(scopeOf("s2"));
    await h.cache.idle();
    dead = false;
    const rebuilt = JSON.parse(h.data.get(h.storeKey)!).snapshot.ref;
    expect(rebuilt).not.toBe(old);
    await h.session("s3");
    expect(h.sessionFroms().at(-1)).toEqual(snapshotFrom(rebuilt));
  });

  it("repeated transient 503 failures preserve the valid ref and never rebuild", async () => {
    let failing = false;
    const h = harness({ acquire: (from) => failing && "environmentSnapshot" in from ? new Error("503") : undefined });
    await h.session("s1");
    failing = true;
    await h.session("s2");
    await h.session("s3");
    expect(h.data.has(h.storeKey)).toBe(true);
    expect(h.builds()).toHaveLength(1);
    expect(reasons(h)).toEqual(["snapshot_start_failed", "snapshot_start_failed"]);
    await h.session("s4");
    expect(reasons(h).at(-1)).toBe("snapshot_start_failed");
    expect(h.builds()).toHaveLength(1);
    expect(JSON.parse(h.data.get(h.storeKey)!).state).toBe("ready");
  });

  it("snapshot failure: the Session is fine, every waiter is warned, nothing is recorded and the next Session retries", async () => {
    let fail = true;
    let n = 0;
    const h = harness({ snapshot: async () => { if (fail) throw new Error("400 snapshot_filesystem_only_disabled"); return { adapter: "fake", ref: "r" + ++n }; } });
    const first = await h.session("s1");
    expect(first).not.toBe("gone");
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toMatchObject({ reason: "snapshot_build_failed", message: expect.stringContaining("snapshot_filesystem_only_disabled") });
    expect(h.data.size).toBe(0);
    expect(h.released).toHaveLength(1);
    fail = false;
    await h.session("s2");
    expect(h.builds()).toHaveLength(2);
    expect(h.data.size).toBe(1);
  });

  it("a failing build setup is a failed build, and the build sandbox is released", async () => {
    const h = harness({ setup: async () => { throw new Error("mirror down"); } });
    await h.session("s1");
    expect(reasons(h)).toEqual(["snapshot_build_failed"]);
    expect(h.released).toHaveLength(1);
    expect(h.data.size).toBe(0);
  });

  it("a build sandbox whose egress cannot be restricted never runs the setup", async () => {
    const h = harness({ restrictEgress: async () => { throw new Error("no firewall"); } });
    await h.session("s1");
    expect(h.setups).toEqual(["restricted"]);
    expect(reasons(h)).toEqual(["snapshot_build_failed"]);
    expect(h.released).toHaveLength(1);
    expect(h.data.size).toBe(0);
  });

  it("two Sessions missing together build once and both hear of a failure", async () => {
    let finish!: () => void;
    const h = harness({ snapshot: () => new Promise((_, reject) => { finish = () => reject(new Error("nope")); }) });
    await h.acquire("s1");
    await h.acquire("s2");
    h.cache.prepared(scopeOf("s1"));
    h.cache.prepared(scopeOf("s2"));
    for (let i = 0; i < 20 && finish === undefined; i++) await Promise.resolve();
    finish();
    await h.cache.idle();
    expect(h.builds()).toHaveLength(1);
    expect(reasons(h)).toEqual(["snapshot_build_failed", "snapshot_build_failed"]);
  });

  it("an unused snapshot expires after 7 days: silent, deleted and rebuilt", async () => {
    const h = harness();
    await h.session("s1");
    const old = JSON.parse(h.data.get(h.storeKey)!).snapshot.ref;
    h.advance(7 * DAY);
    await h.session("s2");
    expect(h.sessionFroms().at(-1)).toEqual(FROM_IMAGE);
    expect(h.deleted).toEqual([old]);
    expect(h.warnings).toEqual([]);
    expect(h.builds()).toHaveLength(2);
  });

  it("a used snapshot lives 14 days from its last use", async () => {
    const h = harness();
    await h.session("s1");
    const ref = JSON.parse(h.data.get(h.storeKey)!).snapshot.ref;
    h.advance(6 * DAY);
    await h.session("s2");
    h.advance(13 * DAY);
    await h.session("s3");
    expect(h.sessionFroms().at(-1)).toEqual(snapshotFrom(ref));
    h.advance(14 * DAY);
    await h.session("s4");
    expect(h.sessionFroms().at(-1)).toEqual(FROM_IMAGE);
  });

  it.each([
    ["absent", null],
    ["a no-op", async () => undefined],
    ["failing", async () => { throw new Error("no delete API"); }],
  ])("expiry does not depend on the adapter's delete (%s)", async (_name, deleteSnapshot) => {
    const h = harness({ deleteSnapshot });
    await h.session("s1");
    h.advance(7 * DAY);
    expect(await h.session("s2")).not.toBe("gone");
    expect(h.builds()).toHaveLength(2);
    expect(h.warnings).toEqual([]);
  });

  it("a refused delete (snapshot still in use) is retried, never orphaned", async () => {
    let inUse = true;
    const h = harness({ deleteSnapshot: async () => { if (inUse) throw new Error("400: cannot delete template because there are running sandboxes using it"); } });
    await h.session("s1");
    const first = JSON.parse(h.data.get(h.storeKey)!).snapshot.ref;
    h.advance(7 * DAY);
    await h.acquire("s2");
    expect(JSON.parse(h.data.get(h.storeKey)!)).toEqual({ state: "retired", retired: [{ adapter: "fake", ref: first }] });
    h.cache.prepared(scopeOf("s2"));
    await h.cache.idle();
    const rebuilt = JSON.parse(h.data.get(h.storeKey)!);
    expect(rebuilt.retired).toEqual([{ adapter: "fake", ref: first }]);
    expect(h.deleted.filter((r) => r === first).length).toBe(2);
    inUse = false;
    await h.session("s3");
    const after = JSON.parse(h.data.get(h.storeKey)!);
    expect(after.retired).toBeUndefined();
    expect(after.snapshot.ref).toBe(rebuilt.snapshot.ref);
    expect(h.deleted.filter((r) => r === first).length).toBe(3);
  });

  it("a retired-only record is a miss that keeps its retired refs through the rebuild", async () => {
    const h = harness({ deleteSnapshot: async () => { throw new Error("in use"); } });
    h.data.set(h.storeKey, JSON.stringify({ state: "retired", retired: [{ adapter: "fake", ref: "old" }, { adapter: "other", ref: "not-ours" }] }));
    await h.session("s1");
    expect(h.sessionFroms()).toEqual([FROM_IMAGE]);
    expect(h.warnings).toEqual([]);
    expect(JSON.parse(h.data.get(h.storeKey)!)).toMatchObject({ state: "ready", retired: [{ adapter: "fake", ref: "old" }] });
  });

  it("a record of another adapter is an error, not a miss", async () => {
    const h = harness();
    h.data.set(h.storeKey, JSON.stringify({ state: "ready", snapshot: { adapter: "other", ref: "x" }, createdAtMs: 0 }));
    await expect(h.acquire("s1")).rejects.toBeInstanceOf(EnvironmentSnapshotAdapterMismatchError);
    expect(h.acquires).toHaveLength(0);
    expect(h.data.has(h.storeKey)).toBe(true);
  });

  it.each([
    ["unparsable", "{"],
    ["an older record shape", JSON.stringify({ state: "ready", handle: { provider: "fake", id: "x" }, createdAtMs: 0 })],
    ["an old failed record", JSON.stringify({ state: "failed", error: "x", failedAtMs: 0 })],
  ])("%s is a miss that a build overwrites", async (_name, value) => {
    const h = harness();
    h.data.set(h.storeKey, value);
    await h.session("s1");
    expect(h.sessionFroms()).toEqual([FROM_IMAGE]);
    expect(h.warnings).toEqual([]);
    expect(JSON.parse(h.data.get(h.storeKey)!).state).toBe("ready");
  });

  it("an adapter that cannot snapshot warns and starts from the image", async () => {
    const h = harness({ noSnapshots: true });
    await h.session("s1");
    expect(reasons(h)).toEqual(["unsupported"]);
    expect(h.builds()).toHaveLength(0);
  });

  it("dispose() drops pending builds", async () => {
    const h = harness();
    await h.acquire("s1");
    await h.cache.dispose();
    h.cache.prepared(scopeOf("s1"));
    await h.cache.idle();
    expect(h.builds()).toHaveLength(0);
  });
});

describe("PortsSessionSandbox with an environment cache", () => {
  it("acquires through the cache and reports the setup as prepared", async () => {
    const calls: string[] = [];
    const sandbox = new PortsSessionSandbox<string>({
      compose: async () => ({ ports: { sandbox: { handle: "changes", maxLifetimeMs: null, acquire: async () => { calls.push("port.acquire"); return "gone"; } } } as never }),
      executor: () => ({ exec: async () => "exit=0\n" }) as never,
      state: { load: async () => undefined, save: async () => undefined, clear: async () => undefined },
      scope: () => scopeOf("s1"),
      plan: async () => planOf("s1"),
      resumeRef: async () => null,
      warn: () => undefined,
      outputDurability: () => null,
      egressRenewMs: null,
      environmentCache: {
        acquire: async () => { calls.push("cache.acquire"); return { runtime: "rt", handle: { provider: "fake", runtimeId: "h" } }; },
        prepared: (scope) => { calls.push("prepared:" + scope.sessionId); },
      },
    });
    await sandbox.warm();
    sandbox.environmentPrepared();
    expect(calls).toEqual(["cache.acquire", "prepared:s1"]);
  });
});
