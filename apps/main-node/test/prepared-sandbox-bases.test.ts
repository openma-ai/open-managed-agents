import { describe, expect, it } from "vitest";
import type { KvStore } from "@open-managed-agents/kv-store";
import {
  parseSandboxImageCatalog,
  type SandboxExecutor,
  type SandboxFactoryContext,
  type SandboxPreparedBaseHandle,
} from "@open-managed-agents/sandbox";
import type { Environment, Session } from "@open-managed-agents/managed-agents-application";
import {
  createPreparedSandboxBases,
  isPreparedBaseGone,
  preparedBaseName,
  preparedBaseAcpInstall,
  preparedBaseKey,
  prepareBuilderSandbox,
  PreparedSandboxBases,
  type PreparedBaseRequest,
  type PreparedBaseScope,
  type PreparedSandboxBasesDependencies,
} from "../../../packages/control-plane-node/src/lib/prepared-sandbox-bases.js";
import { createManagedSandboxBuilder } from "../../../packages/control-plane-node/src/lib/node-managed-sandbox-builder.js";

/** KvStore that records every access. */
function recordingKv() {
  const data = new Map<string, string>();
  const reads: string[] = [];
  const writes: Array<{ key: string; value: unknown }> = [];
  const kv: KvStore = {
    get: async (key) => {
      reads.push(key);
      return data.get(key) ?? null;
    },
    put: async (key, value) => {
      writes.push({ key, value: JSON.parse(value) });
      data.set(key, value);
    },
    delete: async (key) => { data.delete(key); },
    list: async () => ({ keys: [], list_complete: true }),
  };
  return { kv, data, reads, writes };
}

interface FakeSandbox extends SandboxExecutor {
  id: string;
  commands: string[];
  writes: string[];
  env: Record<string, string>;
  destroyed: number;
}

function fakeSandbox(id: string, options: { capture?: boolean; captureId?: string; captureError?: Error } = {}): FakeSandbox {
  const box: FakeSandbox = {
    id,
    commands: [],
    writes: [],
    env: {},
    destroyed: 0,
    exec: async (command: string) => {
      box.commands.push(command);
      if (command.startsWith("WARM=")) return "WARM=MISSING\nREST=MISSING";
      if (command.includes("OMA_ACP_INSTALL_OK")) return "OMA_ACP_LAUNCHER=/home/user/.oma/acp-launch.sh\nOMA_ACP_INSTALL_OK";
      if (command.startsWith("printf")) return "/usr/bin:/bin";
      return "";
    },
    readFile: async () => "",
    writeFile: async (path: string) => {
      box.writes.push(path);
      return path;
    },
    setEnvVars: async (vars: Record<string, string>) => { Object.assign(box.env, vars); },
    destroy: async () => { box.destroyed += 1; },
  };
  if (options.capture !== false) {
    Object.assign(box, {
      capturePreparedBase: async (input: { name: string }): Promise<SandboxPreparedBaseHandle> => {
        box.commands.push(`capture:${input.name}`);
        if (options.captureError) throw options.captureError;
        return { provider: "e2b", id: options.captureId ?? "snap_1" };
      },
    });
  }
  return box;
}

function logs() {
  const entries: Array<{ level: "info" | "warn"; fields: Record<string, unknown> }> = [];
  return {
    entries,
    paths: () => entries.map((entry) => entry.fields.path),
    logger: {
      info: (fields: Record<string, unknown>) => entries.push({ level: "info", fields }),
      warn: (fields: Record<string, unknown>) => entries.push({ level: "warn", fields }),
    },
  };
}

const environment: PreparedBaseRequest["environment"] = {
  id: "env_pb",
  config: { type: "cloud", packages: { apt: ["jq"], pip: ["pyodps"] } },
};
const scope: PreparedBaseScope = { workspaceId: "ws_pb", environmentId: "env_pb" };
const request: PreparedBaseRequest = { environment };

function harness(overrides: Partial<PreparedSandboxBasesDependencies> = {}, options: { builder?: () => FakeSandbox } = {}) {
  const store = recordingKv();
  const log = logs();
  let nowMs = 1_000_000;
  const builders: Array<{ sessionId: string; scope: PreparedBaseScope; sandbox: FakeSandbox }> = [];
  const bases = new PreparedSandboxBases({
    provider: "e2b",
    kvFor: (workspaceId) => {
      expect(workspaceId).toBe("ws_pb");
      return store.kv;
    },
    createBuilderSandbox: async (sessionId, builderScope) => {
      const sandbox = options.builder?.() ?? fakeSandbox(`builder_${builders.length}`);
      builders.push({ sessionId, scope: builderScope, sandbox });
      return sandbox;
    },
    logger: log.logger,
    clock: { now: () => nowMs },
    prepareBuilder: async (sandbox) => { await sandbox.exec("setup"); },
    ...overrides,
  });
  const created: Array<SandboxPreparedBaseHandle | undefined> = [];
  const createSession = (fail?: (base?: SandboxPreparedBaseHandle) => boolean, error = new Error("snapshot snap_1 not found")) =>
    (base?: SandboxPreparedBaseHandle) => {
      created.push(base);
      if (fail?.(base)) return Promise.reject(error);
      return Promise.resolve(fakeSandbox(`session_${created.length}`));
    };
  return { bases, store, log, builders, created, createSession, advance: (ms: number) => { nowMs += ms; } };
}

const kvKeyOf = (store: ReturnType<typeof recordingKv>) => [...store.data.keys()][0]!;

describe("preparedBaseKey", () => {
  const base = {
    provider: "e2b",
    packages: { apt: ["jq"], pip: ["pyodps", "pandas"] },
    acp: null,
  };

  it("is stable for the same setup and a sha256 hex digest", () => {
    expect(preparedBaseKey(base)).toBe(preparedBaseKey({ ...base, packages: { pip: ["pyodps", "pandas"], apt: ["jq"] } }));
    expect(preparedBaseKey(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes with everything the base contains", () => {
    const key = preparedBaseKey(base);
    const variants = [
      { ...base, provider: "daytona" },
      { ...base, image: { reference: "registry.example/analytics:1" } },
      { ...base, image: { alias: "analytics", reference: "registry.example/analytics:1" } },
      { ...base, image: { alias: "web", reference: "registry.example/analytics:1" } },
      { ...base, defaultImage: "code-interpreter" },
      { ...base, packages: { apt: ["jq"], pip: ["pandas", "pyodps"] } },
      { ...base, packages: { apt: ["jq", "curl"], pip: ["pyodps", "pandas"] } },
      { ...base, pipIndexUrl: "https://mirror.example/simple/" },
      { ...base, acp: { package: "@agentclientprotocol/claude-agent-acp@0.94.0", version: "0.94.0", nodeMajor: 22 } },
      { ...base, setupVersion: "next" },
    ];
    const keys = variants.map((variant) => preparedBaseKey(variant));
    for (const variant of keys) expect(variant).not.toBe(key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("hashes the pip index instead of embedding it", () => {
    const withIndex = preparedBaseKey({ ...base, pipIndexUrl: "https://user:secret@mirror.example/simple/" });
    expect(withIndex).not.toContain("secret");
    expect(withIndex).toBe(preparedBaseKey({ ...base, pipIndexUrl: " https://user:secret@mirror.example/simple/ " }));
  });

  it("is null when there is nothing to prepare", () => {
    expect(preparedBaseKey({ provider: "e2b", acp: null })).toBeNull();
    expect(preparedBaseKey({ provider: "e2b", packages: { pip: [], gem: ["rails"] }, acp: null })).toBeNull();
    expect(preparedBaseKey({ provider: "e2b", acp: { package: "p@1", version: "1", nodeMajor: 22 } })).not.toBeNull();
  });

  it("derives the ACP part from the pinned registry entry", () => {
    expect(preparedBaseAcpInstall(undefined)).toBeNull();
    const pinned = preparedBaseAcpInstall("claude-acp@0.94.0");
    expect(pinned).toMatchObject({ version: "0.94.0" });
    expect(pinned!.package.endsWith("@0.94.0")).toBe(true);
    expect(() => preparedBaseAcpInstall("claude-acp@0.0.1")).toThrow(/not pinned/);
  });
});

describe("PreparedSandboxBases", () => {
  it("passes the ready base to the factory on a hit and builds nothing", async () => {
    const h = harness();
    await h.bases.create(scope, request, h.createSession());
    await h.bases.idle();
    expect(h.builders).toHaveLength(1);

    const sandbox = await h.bases.create(scope, request, h.createSession());
    await h.bases.idle();
    expect(h.created).toEqual([undefined, { provider: "e2b", id: "snap_1" }]);
    expect((sandbox as FakeSandbox).id).toBe("session_2");
    expect(h.builders).toHaveLength(1);
    expect(h.log.paths()).toEqual(["miss", "build_ok", "hit"]);
    expect(h.log.entries.every((entry) => entry.fields.op === "main-node.prepared_base")).toBe(true);
    expect(h.log.entries.find((entry) => entry.fields.path === "hit")!.fields).toHaveProperty("durationMs");
  });

  it("starts exactly one background build for concurrent sessions with the same key", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = harness({ prepareBuilder: async () => gate });
    const sessions = await Promise.all([1, 2, 3].map(() => h.bases.create(scope, request, h.createSession())));
    expect(sessions).toHaveLength(3);
    expect(h.builders).toHaveLength(1);
    release();
    await h.bases.idle();
    expect(h.builders).toHaveLength(1);
    expect(h.log.entries.filter((entry) => entry.fields.path === "miss").map((entry) => entry.fields.build))
      .toEqual(["started", "in_progress", "in_progress"]);
    expect(h.store.writes.at(-1)!.value).toMatchObject({ state: "ready", handle: { provider: "e2b", id: "snap_1" } });
  });

  it("builds on a clean builder: synthetic session id, same scope, base name from the key, destroyed after", async () => {
    const h = harness();
    const image = { alias: "analytics", reference: "registry.example/analytics:1" };
    await h.bases.create({ ...scope, image }, { ...request, image }, h.createSession());
    await h.bases.idle();
    const [builder] = h.builders;
    expect(builder!.sessionId).toMatch(/^prepared_base_/);
    expect(builder!.scope).toEqual({ workspaceId: "ws_pb", environmentId: "env_pb", image });
    const key = kvKeyOf(h.store).split(":").at(-1)!;
    expect(builder!.sandbox.commands).toEqual(["setup", `capture:${preparedBaseName("ws_pb", key)}`]);
    expect(builder!.sandbox.destroyed).toBe(1);
    expect(kvKeyOf(h.store)).toMatch(/^sandbox_prepared_base:v1:e2b:[0-9a-f]{64}$/);
  });

  it("records a failed build, destroys the builder and does not retry within the backoff", async () => {
    const h = harness({}, { builder: () => fakeSandbox("builder", { captureError: new Error("quota exceeded for https://user:pw@api.example") }) });
    await h.bases.create(scope, request, h.createSession());
    await h.bases.idle();
    expect(h.builders).toHaveLength(1);
    expect(h.builders[0]!.sandbox.destroyed).toBe(1);
    const failed = h.store.writes.at(-1)!.value as { state: string; error: string; failedAtMs: number };
    expect(failed).toMatchObject({ state: "failed", failedAtMs: 1_000_000 });
    expect(failed.error).toContain("quota exceeded");
    expect(failed.error).not.toContain("pw@");
    expect(h.log.paths()).toEqual(["miss", "build_failed"]);

    h.advance(30 * 60_000);
    await h.bases.create(scope, request, h.createSession());
    await h.bases.idle();
    expect(h.builders).toHaveLength(1);
    expect(h.log.entries.at(-1)!.fields).toMatchObject({ path: "miss", build: "backoff" });

    h.advance(31 * 60_000);
    await h.bases.create(scope, request, h.createSession());
    await h.bases.idle();
    expect(h.builders).toHaveLength(2);
  });

  it("records a 404 from a provider without snapshot routes once, and never retries it per session", async () => {
    // What e2b@2.46.1 throws when an E2B-compatible provider lacks /sandboxes/{id}/snapshots.
    class SandboxError extends Error {
      override name = "SandboxError";
    }
    const h = harness({}, { builder: () => fakeSandbox("builder", { captureError: new SandboxError("404: route not found") }) });
    const sessions = await Promise.all([1, 2].map(() => h.bases.create(scope, request, h.createSession())));
    await h.bases.idle();
    expect(sessions.map((sandbox) => (sandbox as FakeSandbox).id)).toEqual(["session_1", "session_2"]);
    expect(h.builders).toHaveLength(1);
    expect(h.builders[0]!.sandbox.destroyed).toBe(1);
    expect(h.store.writes.at(-1)!.value).toMatchObject({ state: "failed", error: "404: route not found" });

    for (let index = 0; index < 5; index += 1) {
      h.advance(5 * 60_000);
      await h.bases.create(scope, request, h.createSession());
      await h.bases.idle();
    }
    expect(h.builders).toHaveLength(1);
    expect(h.created.every((base) => base === undefined)).toBe(true);
    const failures = h.log.entries.filter((entry) => entry.fields.path === "build_failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]!.level).toBe("warn");
    expect(h.log.entries.filter((entry) => entry.level === "warn")).toHaveLength(1);
    expect(h.log.entries.filter((entry) => entry.fields.build === "backoff")).toHaveLength(5);
  });

  it("keeps the backoff in process when the failure cannot be recorded in KV", async () => {
    const h = harness({}, { builder: () => fakeSandbox("builder", { captureError: new Error("404: route not found") }) });
    const put = h.store.kv.put;
    h.store.kv.put = async () => { throw new Error("database is locked"); };
    await h.bases.create(scope, request, h.createSession());
    await h.bases.idle();
    expect(h.log.paths()).toEqual(["miss", "build_failed", "record_failed"]);

    h.advance(10 * 60_000);
    await h.bases.create(scope, request, h.createSession());
    await h.bases.idle();
    expect(h.builders).toHaveLength(1);
    expect(h.log.entries.at(-1)!.fields).toMatchObject({ path: "miss", build: "backoff" });

    h.store.kv.put = put;
    h.advance(51 * 60_000);
    await h.bases.create(scope, request, h.createSession());
    await h.bases.idle();
    expect(h.builders).toHaveLength(2);
  });

  it("destroys the builder when the setup itself fails", async () => {
    const h = harness({ prepareBuilder: async () => { throw new Error("Environment env_pb setup failed at fresh: apt"); } });
    await h.bases.create(scope, request, h.createSession());
    await h.bases.idle();
    expect(h.builders[0]!.sandbox.destroyed).toBe(1);
    expect(h.builders[0]!.sandbox.commands).toEqual([]);
    expect(h.store.writes.at(-1)!.value).toMatchObject({ state: "failed", error: "Environment env_pb setup failed at fresh: apt" });
  });

  it("falls back to a cold sandbox when the base cannot be created, and records and logs it", async () => {
    const h = harness();
    await h.bases.create(scope, request, h.createSession());
    await h.bases.idle();

    const sandbox = await h.bases.create(scope, request, h.createSession((base) => base !== undefined));
    await h.bases.idle();
    expect(h.created).toEqual([undefined, { provider: "e2b", id: "snap_1" }, undefined]);
    expect((sandbox as FakeSandbox).id).toBe("session_3");
    const warn = h.log.entries.find((entry) => entry.fields.path === "hit_failed")!;
    expect(warn.level).toBe("warn");
    expect(warn.fields).toMatchObject({ op: "main-node.prepared_base", baseId: "snap_1", error: "snapshot snap_1 not found" });
    expect(warn.fields.key).toMatch(/^[0-9a-f]{64}$/);
    expect(h.store.writes.at(-1)!.value).toMatchObject({ state: "failed", error: "create_from_base_failed: snapshot snap_1 not found" });
    // The failed entry blocks a rebuild and a retry of the base within the backoff.
    await h.bases.create(scope, request, h.createSession());
    await h.bases.idle();
    expect(h.created.at(-1)).toBeUndefined();
    expect(h.builders).toHaveLength(1);
  });

  it("does not build for a provider whose sandboxes cannot capture", async () => {
    const h = harness();
    await h.bases.create(scope, request, () => Promise.resolve(fakeSandbox("plain", { capture: false })));
    await h.bases.idle();
    expect(h.builders).toEqual([]);
    expect(h.log.entries.at(-1)!.fields).toMatchObject({ path: "miss", build: "unsupported" });
  });

  it("touches neither KV nor builders for a setup with nothing to prepare", async () => {
    const h = harness();
    await h.bases.create(scope, { environment: { id: "env_pb", config: { type: "cloud", packages: { pip: [] } } } }, h.createSession());
    expect(h.store.reads).toEqual([]);
    expect(h.builders).toEqual([]);
  });

  it("never gives the builder Session inputs, vault variables or files", async () => {
    const h = harness({ prepareBuilder: undefined });
    await h.bases.create(scope, { ...request, acpRegistry: "claude-acp@0.94.0" }, h.createSession());
    await h.bases.idle();
    const builder = h.builders[0]!.sandbox;
    expect(builder.writes).toEqual([]);
    expect(Object.keys(builder.env)).toEqual(["PATH"]);
    // Same scripts a Session runs: the environment setup, then the ACP install.
    expect(builder.commands.some((command) => command.startsWith("(\nset -e") && command.includes("'pyodps'"))).toBe(true);
    const install = builder.commands.find((command) => command.includes("OMA_ACP_INSTALL_OK"))!;
    expect(install).toContain("npm exec --yes --package=");
    expect(install).toMatch(/env (-u \w+ )+npm exec/);
    expect(builder.commands.at(-1)).toMatch(/^capture:oma-base-/);
  });

  describe("robustness", () => {
    it("redacts before truncating, including a credential cut before its @", async () => {
      const secret = "s3cr3t-token-value";
      const padding = "x".repeat(480);
      const message = `${padding} https://user:${secret}@mirror.example/simple/ failed`;
      const h = harness({ pipIndexUrl: "https://other.example/simple/" }, { builder: () => fakeSandbox("builder", { captureError: new Error(message) }) });
      await h.bases.create(scope, request, h.createSession());
      await h.bases.idle();
      const logged = JSON.stringify(h.log.entries);
      const stored = JSON.stringify(h.store.writes);
      expect(logged).not.toContain("s3cr3t");
      expect(stored).not.toContain("s3cr3t");
      expect(logged).not.toContain("user:");
      expect((h.store.writes.at(-1)!.value as { error: string }).error.length).toBeLessThanOrEqual(500);
    });

    it("masks a userinfo tail without @ and leaves host:port alone", async () => {
      const h = harness({}, { builder: () => fakeSandbox("builder", { captureError: new Error("cannot reach https://user:hunter2 or https://registry.example:8443/v2") }) });
      await h.bases.create(scope, request, h.createSession());
      await h.bases.idle();
      const error = (h.store.writes.at(-1)!.value as { error: string }).error;
      expect(error).not.toContain("hunter2");
      expect(error).toContain("https://***");
      expect(error).toContain("https://registry.example:8443/v2");
    });

    it("logs only redacted strings on hit_failed and lookup failures, never raw error objects", async () => {
      const h = harness();
      await h.bases.create(scope, request, h.createSession());
      await h.bases.idle();
      await h.bases.create(scope, request, h.createSession((base) => base !== undefined, new Error("404 for https://user:topsecret@api.example")));
      const get = h.store.kv.get;
      h.store.kv.get = async () => { throw new Error("connect https://db:dbsecret@db.example failed"); };
      await h.bases.create(scope, request, h.createSession());
      h.store.kv.get = get;
      for (const entry of h.log.entries) {
        expect(entry.fields).not.toHaveProperty("err");
        for (const value of Object.values(entry.fields)) expect(value instanceof Error).toBe(false);
      }
      const logged = JSON.stringify(h.log.entries);
      expect(logged).not.toContain("topsecret");
      expect(logged).not.toContain("dbsecret");
    });

    it("heals a malformed entry: logged once as a miss, then a build overwrites it", async () => {
      const bads = ["{not json", JSON.stringify({ state: "weird" }), JSON.stringify({ state: "ready", handle: { provider: "daytona", id: "x" } })];
      for (const bad of bads) {
        const h = harness();
        const kvKey = `sandbox_prepared_base:v1:e2b:${preparedBaseKey({ provider: "e2b", packages: environment.config.packages, acp: null })}`;
        h.store.data.set(kvKey, bad);
        await h.bases.create(scope, request, h.createSession());
        await h.bases.create(scope, request, h.createSession());
        await h.bases.idle();
        expect(h.builders).toHaveLength(1);
        expect(JSON.parse(h.store.data.get(kvKey)!)).toMatchObject({ state: "ready" });
        const malformed = h.log.entries.filter((entry) => entry.fields.reason === "malformed_entry");
        expect(malformed).toHaveLength(1);
        expect(malformed[0]!.level).toBe("warn");
        expect(malformed[0]!.fields.path).toBe("miss");
        await h.bases.create(scope, request, h.createSession());
        expect(h.created.at(-1)).toEqual({ provider: "e2b", id: "snap_1" });
      }
    });

    it("keeps a KV read error cold and does not build", async () => {
      const h = harness();
      h.store.kv.get = async () => { throw new Error("database is locked"); };
      await h.bases.create(scope, request, h.createSession());
      await h.bases.idle();
      expect(h.builders).toEqual([]);
    });

    it("keeps the ready entry on a transient create-from-base error and backs off only in process", async () => {
      const h = harness();
      await h.bases.create(scope, request, h.createSession());
      await h.bases.idle();
      const writes = h.store.writes.length;
      await h.bases.create(scope, request, h.createSession((base) => base !== undefined, new Error("503 Service Unavailable")));
      expect(h.store.writes).toHaveLength(writes);
      expect(JSON.parse([...h.store.data.values()][0]!)).toMatchObject({ state: "ready" });
      expect(h.log.entries.find((entry) => entry.fields.path === "hit_failed")!.fields.baseGone).toBe(false);
      // This process backs off; another replica (fresh instance, same KV) still hits.
      await h.bases.create(scope, request, h.createSession());
      expect(h.created.at(-1)).toBeUndefined();
      const replica = new PreparedSandboxBases({ provider: "e2b", kvFor: () => h.store.kv, createBuilderSandbox: async () => fakeSandbox("b"), logger: logs().logger });
      const created: Array<SandboxPreparedBaseHandle | undefined> = [];
      await replica.create(scope, request, async (base) => { created.push(base); return fakeSandbox("r"); });
      expect(created).toEqual([{ provider: "e2b", id: "snap_1" }]);
    });

    it("classifies only a missing base as gone", () => {
      class NotFoundError extends Error { override name = "NotFoundError"; }
      expect(isPreparedBaseGone(new Error("404: route not found"))).toBe(true);
      expect(isPreparedBaseGone(Object.assign(new Error("x"), { status: 404 }))).toBe(true);
      expect(isPreparedBaseGone(new NotFoundError("gone"))).toBe(true);
      expect(isPreparedBaseGone(new Error("snapshot snap_1 not found"))).toBe(true);
      expect(isPreparedBaseGone(new Error("Template 'oma-base-1' not found"))).toBe(true);
      expect(isPreparedBaseGone(new Error("503 Service Unavailable"))).toBe(false);
      expect(isPreparedBaseGone(new Error("socket hang up"))).toBe(false);
      expect(isPreparedBaseGone(new Error("rate limited"))).toBe(false);
    });

    it("fails a hung build at its deadline, destroys the builder and frees the key", async () => {
      let resolveHang!: () => void;
      const hang = new Promise<void>((resolve) => { resolveHang = resolve; });
      const h = harness({ buildTimeoutMs: 20, prepareBuilder: async () => hang });
      await h.bases.create(scope, request, h.createSession());
      await h.bases.idle();
      expect(h.builders[0]!.sandbox.destroyed).toBe(1);
      expect(h.store.writes.at(-1)!.value).toMatchObject({ state: "failed", error: "prepared-base build exceeded its 20 ms deadline" });
      expect(h.log.entries.at(-1)!.fields).toMatchObject({ path: "build_failed" });
      resolveHang();
      await new Promise((resolve) => setTimeout(resolve, 5));
      // The late setup completion never captures.
      expect(h.builders[0]!.sandbox.commands.some((command) => command.startsWith("capture:"))).toBe(false);
    });

    it("destroys a builder whose creation finished after the deadline", async () => {
      let release!: () => void;
      const late = fakeSandbox("late");
      const h = harness({
        buildTimeoutMs: 10,
        createBuilderSandbox: async () => {
          await new Promise<void>((resolve) => { release = resolve; });
          return late;
        },
      });
      await h.bases.create(scope, request, h.createSession());
      await h.bases.idle();
      release();
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(late.destroyed).toBe(1);
      expect(late.commands).toEqual([]);
    });

    it("dispose() aborts in-flight builds, destroys builders, records nothing and starts no new builds", async () => {
      const h = harness({ prepareBuilder: async () => new Promise<void>(() => undefined) });
      await h.bases.create(scope, request, h.createSession());
      await new Promise((resolve) => setTimeout(resolve, 0));
      await h.bases.dispose();
      expect(h.builders[0]!.sandbox.destroyed).toBe(1);
      expect(h.store.writes).toEqual([]);
      expect(h.log.entries.at(-1)!.fields).toMatchObject({ path: "build_failed", reason: "shutdown" });
      await h.bases.create(scope, request, h.createSession());
      await h.bases.idle();
      expect(h.builders).toHaveLength(1);
    });

    it("survives a destroy() that throws synchronously", async () => {
      const box = fakeSandbox("sync-throw");
      box.destroy = (() => { throw new Error("not a promise"); }) as unknown as FakeSandbox["destroy"];
      const h = harness({}, { builder: () => box });
      await h.bases.create(scope, request, h.createSession());
      await h.bases.idle();
      expect(h.log.paths()).toEqual(["miss", "build_ok", "build_cleanup_failed"]);
    });

    it("names the provider snapshot per workspace", () => {
      const key = "a".repeat(64);
      expect(preparedBaseName("ws_a", key)).toMatch(/^oma-base-[0-9a-f]{32}$/);
      expect(preparedBaseName("ws_a", key)).not.toBe(preparedBaseName("ws_b", key));
      expect(preparedBaseName("ws_a", key)).not.toContain(key.slice(0, 32));
    });
  });
});

describe("prepareBuilderSandbox", () => {
  it("runs only the environment setup when there is no ACP registry agent", async () => {
    const box = fakeSandbox("b");
    await prepareBuilderSandbox(box, request, "prepared_base_x", { pipIndexUrl: "https://mirror.example/simple/" });
    expect(box.commands.some((command) => command.includes("UV_INDEX_URL='https://mirror.example/simple/'"))).toBe(true);
    expect(box.commands.some((command) => command.includes("OMA_ACP_INSTALL_OK"))).toBe(false);
  });
});

describe("SANDBOX_PREPARED_BASE wiring", () => {
  const session = { id: "session_pb", agent: { openma: { harness: "acp-sandbox", acp: { agent: { registry: "claude-acp@0.94.0" } } } } } as unknown as Session;
  const managedEnvironment = {
    id: "env_pb",
    archivedAt: null,
    config: { type: "cloud", networking: { type: "unrestricted" }, packages: { apt: [], cargo: [], gem: [], go: [], npm: [], pip: ["pyodps"] } },
    createdAt: "2026-10-24T00:00:00.000Z",
    description: null,
    metadata: {},
    name: "pb",
    updatedAt: "2026-10-24T00:00:00.000Z",
    openma: { sandboxImage: "analytics" },
  } as Environment;
  const images = parseSandboxImageCatalog(JSON.stringify({ analytics: { reference: "registry.example/analytics:1" } }));

  function builderWith(preparedBase: boolean) {
    const store = recordingKv();
    const contexts: SandboxFactoryContext[] = [];
    const bases = createPreparedSandboxBases(
      { preparedBase, environment: { SANDBOX_PROVIDER: "E2B" } },
      {
        kvFor: () => store.kv,
        createBuilderSandbox: async () => fakeSandbox("builder"),
        logger: logs().logger,
        prepareBuilder: async () => undefined,
      },
    );
    const build = createManagedSandboxBuilder({
      images,
      workdir: (sessionId) => `/sandboxes/${sessionId}`,
      build: async (sessionId, workdir, scope) => {
        contexts.push({ ...scope, sessionId, workdir });
        return fakeSandbox(`session_${contexts.length}`);
      },
      ...(bases === undefined ? {} : { preparedBases: bases }),
    });
    return { bases, store, contexts, build };
  }

  it("is off by default: no KV access and the factory context is unchanged", async () => {
    const { bases, store, contexts, build } = builderWith(false);
    expect(bases).toBeUndefined();
    await build({ workspaceId: "ws_pb", session, environment: managedEnvironment });
    expect(store.reads).toEqual([]);
    expect(contexts).toEqual([{
      sessionId: "session_pb",
      workdir: "/sandboxes/session_pb",
      workspaceId: "ws_pb",
      environmentId: "env_pb",
      image: { alias: "analytics", reference: "registry.example/analytics:1" },
    }]);
  });

  it("when on, keys on the Session's setup and hands the base to the factory on the next start", async () => {
    const { bases, store, contexts, build } = builderWith(true);
    await build({ workspaceId: "ws_pb", session, environment: managedEnvironment });
    await bases!.idle();
    expect(kvKeyOf(store)).toMatch(/^sandbox_prepared_base:v1:e2b:/);
    await build({ workspaceId: "ws_pb", session, environment: managedEnvironment });
    expect(contexts[0]).not.toHaveProperty("preparedBase");
    expect(contexts[1]).toEqual({
      sessionId: "session_pb",
      workdir: "/sandboxes/session_pb",
      workspaceId: "ws_pb",
      environmentId: "env_pb",
      image: { alias: "analytics", reference: "registry.example/analytics:1" },
      preparedBase: { provider: "e2b", id: "snap_1" },
    });
  });
});
