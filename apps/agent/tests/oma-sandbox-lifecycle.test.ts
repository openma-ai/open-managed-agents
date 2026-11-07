// Sandbox SDK 1.0 lifecycle of OmaSandbox against a recording Container.
// S3Mount routes register a hostname intercept each; the catch-all takes every
// hostname registered after it, so mount order is the property under test.
import { DirectoryBackup, S3Mount } from "@cloudflare/sandbox";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  OmaSandbox,
  OMA_SANDBOX_IDLE_TIMEOUT_MS,
  OMA_SANDBOX_WARM_MARKER_PATH,
  sandboxIdleTimeoutMs,
} from "../src/oma-sandbox";

const encoder = new TextEncoder();

// workerd's DurableObject base only accepts a runtime DurableObjectState.
// `super()` resolves the parent at call time, so give OmaSandbox a plain
// base that stores ctx/env for this file only.
class PlainDurableObject {
  constructor(readonly ctx: unknown, readonly env: unknown) {}
}
const durableObjectBase = Object.getPrototypeOf(OmaSandbox);
const durableObjectPrototype = Object.getPrototypeOf(OmaSandbox.prototype);
beforeAll(() => {
  Object.setPrototypeOf(OmaSandbox, PlainDurableObject);
  Object.setPrototypeOf(OmaSandbox.prototype, PlainDurableObject.prototype);
});
afterAll(() => {
  Object.setPrototypeOf(OmaSandbox, durableObjectBase);
  Object.setPrototypeOf(OmaSandbox.prototype, durableObjectPrototype);
});

class RecordingContainer {
  running = false;
  readonly images = { sandbox: "sandbox-image" };
  startOptions: { env?: Record<string, string> } | undefined;
  readonly execs: Array<{ argv: string[]; env?: Record<string, string> }> = [];
  private stopMonitor: (() => void) | undefined;
  constructor(private readonly log: string[]) {}
  start(options: { env?: Record<string, string> }): void {
    this.running = true;
    this.startOptions = options;
    this.log.push("start");
  }
  async interceptAllOutboundHttp(): Promise<void> { this.log.push("catch-all"); }
  async interceptOutboundHttps(): Promise<void> { this.log.push("catch-all-https"); }
  async interceptOutboundHttp(host: string): Promise<void> { this.log.push(`route:${host}`); }
  async setInactivityTimeout(ms: number): Promise<void> { this.log.push(`timeout:${ms}`); }
  async exec(argv: string[], options?: { env?: Record<string, string> }) {
    this.execs.push({ argv, env: options?.env });
    this.log.push(`exec:${argv[0]}`);
    return {
      exitCode: Promise.resolve(0),
      output: async () => ({ stdout: encoder.encode(""), stderr: new Uint8Array(), exitCode: 0 }),
    };
  }
  monitor(): Promise<void> {
    return new Promise((resolve) => { this.stopMonitor = resolve; });
  }
  async destroy(): Promise<void> {
    this.running = false;
    this.log.push("destroy");
    this.stopMonitor?.();
  }
  /** Platform stop (inactivity timeout, host restart). */
  stop(): void {
    this.running = false;
    this.stopMonitor?.();
  }
}

function durableObjectState(container: RecordingContainer) {
  const kv = new Map<string, unknown>();
  const storage = new Map<string, unknown>();
  let alarm: number | null = null;
  return {
    container,
    exports: {
      DirectoryBackupGateway: () => ({}),
      S3Gateway: () => ({}),
      OmaOutbound: () => ({}),
    },
    storage: {
      kv: {
        get: (key: string) => structuredClone(kv.get(key)),
        put: (key: string, value: unknown) => { kv.set(key, structuredClone(value)); },
        delete: (key: string) => kv.delete(key),
      },
      get: async (key: string) => storage.get(key),
      put: async (key: string, value: unknown) => { storage.set(key, value); },
      delete: async (key: string) => storage.delete(key),
      getAlarm: async () => alarm,
      setAlarm: async (at: number) => { alarm = at; },
    },
    blockConcurrencyWhile: async <T>(fn: () => Promise<T>) => fn(),
    raw: { kv, get alarm() { return alarm; } },
  };
}

function backupDb() {
  const inserts: unknown[][] = [];
  return {
    inserts,
    prepare(sql: string) {
      return {
        bind: (...args: unknown[]) => ({
          run: async () => {
            if (sql.includes("INSERT INTO workspace_backups")) inserts.push(args);
            return { meta: {} };
          },
          first: async () => null,
        }),
      };
    },
  };
}

const R2 = { endpoint: "https://account.r2.cloudflarestorage.com", credentials: { accessKeyId: "ak", secretAccessKey: "sk" } };
const original = {
  mount: S3Mount.prototype.mount,
  unmount: S3Mount.prototype.unmount,
  intercept: DirectoryBackup.prototype.intercept,
  backup: DirectoryBackup.prototype.backup,
  restore: DirectoryBackup.prototype.restore,
};

let log: string[];
let container: RecordingContainer;
let state: ReturnType<typeof durableObjectState>;
let db: ReturnType<typeof backupDb>;
const env = () => ({ R2_ACCESS_KEY_ID: "ak", R2_SECRET_ACCESS_KEY: "sk", MAIN_DB: db }) as never;
const sandbox = () => new OmaSandbox(state as never, env());

beforeEach(() => {
  log = [];
  container = new RecordingContainer(log);
  state = durableObjectState(container);
  db = backupDb();
  S3Mount.prototype.mount = async function (request: { mountPath: string; source: { credentials: unknown } }) {
    log.push(`mount:${request.mountPath}`);
    expect(request.source.credentials).toEqual({ type: "static", accessKeyId: "ak", secretAccessKey: "sk" });
  } as never;
  S3Mount.prototype.unmount = async function (path: string) { log.push(`unmount:${path}`); } as never;
  DirectoryBackup.prototype.intercept = async function () { log.push("backup-route"); } as never;
  DirectoryBackup.prototype.backup = async function (options: { dir: string; name?: string }) {
    log.push("backup");
    return { id: "b1", dir: options.dir, size: 42, sha256: "a".repeat(64), format: "tar+zstd/1", name: options.name };
  } as never;
  DirectoryBackup.prototype.restore = async function () { log.push("restore"); } as never;
});

afterEach(() => {
  Object.assign(S3Mount.prototype, { mount: original.mount, unmount: original.unmount });
  Object.assign(DirectoryBackup.prototype, {
    intercept: original.intercept,
    backup: original.backup,
    restore: original.restore,
  });
});

describe("OmaSandbox on Sandbox SDK 1.0", () => {
  it("attaches every planned mount before the catch-all outbound intercept", async () => {
    const box = sandbox();
    await box.mountBucket("files", "/mnt/session/outputs", { ...R2, prefix: "/t/x/session-outputs/s/" });
    await box.mountBucket("memory", "/mnt/memory/notes", { ...R2, prefix: "/store/", readOnly: true });
    expect(log).toEqual([]);

    await box.exec("true");

    const catchAll = log.indexOf("catch-all");
    expect(catchAll).toBeGreaterThan(0);
    expect(log.indexOf("start")).toBe(0);
    expect(log.indexOf("mount:/mnt/session/outputs")).toBeLessThan(catchAll);
    expect(log.indexOf("mount:/mnt/memory/notes")).toBeLessThan(catchAll);
    expect(log.indexOf("backup-route")).toBeLessThan(catchAll);
    // The Worker's own R2 secrets are resolved at start, never persisted.
    expect(JSON.stringify(state.raw.kv.get("oma_sandbox_plan"))).not.toContain("sk");
  });

  it("rejects a mount the running container did not start with and reuses a matching one", async () => {
    const box = sandbox();
    await box.mountBucket("files", "/mnt/session/outputs", R2);
    await box.exec("true");

    await expect(box.mountBucket("files", "/mnt/session/outputs", R2)).resolves.toBeUndefined();
    await expect(box.mountBucket("memory", "/mnt/memory/late", R2)).rejects.toThrow(/^MOUNT_AFTER_START:/);
  });

  it("records the incarnation and refuses to restart a stopped container it does not own", async () => {
    const box = sandbox();
    const first = await box.provision({
      incarnation: "inc-1",
      mounts: [{ bucket: "files", mountPath: "/mnt/session/outputs", options: R2 }],
      autoStart: false,
      env: {},
    });
    expect(first).toEqual({ incarnation: "inc-1", started: true, pendingMounts: [] });
    expect(container.execs.some(({ argv }) => argv.includes("inc-1") && argv.includes(OMA_SANDBOX_WARM_MARKER_PATH))).toBe(true);
    await expect(box.describe()).resolves.toEqual({ running: true, incarnation: "inc-1", mounts: ["/mnt/session/outputs"] });

    container.stop();
    await Promise.resolve();
    await expect(box.exec("ls")).rejects.toThrow(/^SANDBOX_NOT_RUNNING:/);
    await expect(box.describe()).resolves.toMatchObject({ running: false, incarnation: null });

    const second = await box.provision({ incarnation: "inc-2", mounts: [{ bucket: "files", mountPath: "/mnt/session/outputs", options: R2 }] });
    expect(second).toEqual({ incarnation: "inc-2", started: true, pendingMounts: [] });
  });

  it("reports a running container with the mounts it lacks", async () => {
    const box = sandbox();
    await box.provision({ incarnation: "inc-1", mounts: [{ bucket: "files", mountPath: "/mnt/session/outputs", options: R2 }] });
    const again = await box.provision({
      incarnation: "ignored",
      mounts: [
        { bucket: "files", mountPath: "/mnt/session/outputs", options: R2 },
        { bucket: "memory", mountPath: "/mnt/memory/late", options: R2 },
      ],
    });
    expect(again).toEqual({ incarnation: "inc-1", started: false, pendingMounts: ["/mnt/memory/late"] });
    expect(log.filter((entry) => entry === "start")).toHaveLength(1);
  });

  it("keeps mounts and process environment across a Durable Object restart", async () => {
    const first = sandbox();
    await first.mountBucket("files", "/mnt/session/outputs", R2);
    await first.exec("true");
    await first.setEnvVars({ OMA_OUTPUTS_DIR: "/mnt/session/outputs" });
    log.length = 0;

    const restarted = sandbox();
    await restarted.exec("echo hi");

    expect(log).not.toContain("start");
    expect(log.indexOf("mount:/mnt/session/outputs")).toBeLessThan(log.indexOf("catch-all"));
    expect(container.execs.at(-1)?.env).toMatchObject({ OMA_OUTPUTS_DIR: "/mnt/session/outputs" });
  });

  it("returns the full backup record and refuses handles written before 1.0", async () => {
    const box = sandbox();
    const backup = await box.createBackup({ dir: "/workspace", name: "session-s" });
    expect(backup).toMatchObject({ id: "b1", dir: "/workspace", size: 42, sha256: "a".repeat(64), format: "tar+zstd/1" });

    await expect(box.restoreBackup({ id: "old", dir: "/workspace", localBucket: false })).rejects.toThrow(/^LEGACY_BACKUP:/);
    await expect(box.restoreBackup(backup)).resolves.toEqual({ success: true, dir: "/workspace", id: "b1" });
    expect(log).toContain("restore");
  });

  it("snapshots a changed /workspace before the idle alarm stops the container", async () => {
    const box = sandbox();
    await box.setBackupContext({ tenantId: "default", environmentId: "env", sessionId: "s" });
    await box.exec("touch /workspace/a");
    state.storage.kv.put("oma_last_activity_ms", Date.now() - OMA_SANDBOX_IDLE_TIMEOUT_MS - 1);

    await box.alarm();

    expect(log).toContain("backup");
    expect(log.indexOf("backup")).toBeLessThan(log.indexOf("destroy"));
    expect(container.running).toBe(false);
    expect(JSON.parse(db.inserts[0]![2] as string)).toMatchObject({ id: "b1", size: 42, sha256: "a".repeat(64), format: "tar+zstd/1" });
  });

  it("moves the idle alarm while activity is recent and skips the snapshot of an unchanged /workspace", async () => {
    const box = sandbox();
    await box.setBackupContext({ tenantId: "default", environmentId: "env", sessionId: "s" });
    await box.readFile("/workspace/a");

    await box.alarm();
    expect(container.running).toBe(true);
    expect(state.raw.alarm).toBeGreaterThan(Date.now());

    state.storage.kv.put("oma_last_activity_ms", 0);
    await box.alarm();
    expect(container.running).toBe(false);
    expect(log).not.toContain("backup");
  });

  it("keeps a container with a live duplex process past the idle timeout", async () => {
    let exit!: (code: number) => void;
    container.exec = (async (argv: string[], options?: { env?: Record<string, string> }) => {
      container.execs.push({ argv, env: options?.env });
      log.push(`exec:${argv[0]}`);
      const long = argv.join(" ").includes("agent --acp");
      return {
        stdin: new WritableStream(),
        stdout: new ReadableStream(),
        stderr: new ReadableStream(),
        exitCode: long ? new Promise<number>((resolve) => { exit = resolve; }) : Promise.resolve(0),
        output: async () => ({ stdout: encoder.encode(""), stderr: new Uint8Array(), exitCode: 0 }),
      };
    }) as never;
    const box = sandbox();
    const process = await box.spawnDuplex({ command: "exec agent --acp" });
    state.storage.kv.put("oma_last_activity_ms", 0);

    await box.alarm();
    expect(container.running).toBe(true);
    expect(container.execs.at(-1)?.argv).toEqual(["/bin/bash", "-lc", "exec agent --acp"]);

    exit(0);
    await expect(process.wait()).resolves.toBe(0);
    state.storage.kv.put("oma_last_activity_ms", 0);
    await box.alarm();
    expect(container.running).toBe(false);
  });

  it("reads the idle timeout from SANDBOX_IDLE_TIMEOUT_MS", async () => {
    expect(sandboxIdleTimeoutMs({})).toBe(OMA_SANDBOX_IDLE_TIMEOUT_MS);
    expect(sandboxIdleTimeoutMs({ SANDBOX_IDLE_TIMEOUT_MS: "nope" })).toBe(OMA_SANDBOX_IDLE_TIMEOUT_MS);
    expect(sandboxIdleTimeoutMs({ SANDBOX_IDLE_TIMEOUT_MS: "60000" })).toBe(60_000);

    const box = new OmaSandbox(state as never, { ...(env() as object), SANDBOX_IDLE_TIMEOUT_MS: "60000" } as never);
    await box.readFile("/workspace/a");
    expect(log).toContain(`timeout:${60_000 + 5 * 60 * 1000}`);
    state.storage.kv.put("oma_last_activity_ms", Date.now() - 60_001);
    await box.alarm();
    expect(container.running).toBe(false);
  });

  it("never starts a stopped container to take a snapshot or to run a stale alarm", async () => {
    const box = sandbox();
    await box.setBackupContext({ tenantId: "default", environmentId: "env", sessionId: "s" });
    await box.snapshotWorkspaceNow();
    await box.alarm();
    expect(log).toEqual([]);
  });
});
