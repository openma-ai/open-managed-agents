// @ts-nocheck
import { DurableObject } from "cloudflare:workers";
// Stub for @cloudflare/sandbox in vitest (SDK 1.0 helpers).
// The real module depends on workerd-native APIs.

export class Files {
  constructor() {}
  async readFile() { return new Response(""); }
  async writeFile() {}
  async mkdir() {}
  async remove() {}
  async rename() {}
  async readDirectory() { return []; }
  async stat() { return {}; }
}
export class S3Mount {
  constructor() {}
  async mount() {}
  async unmount() {}
}
export class DirectoryBackup {
  constructor() {}
  async intercept() {}
  async backup() {
    return { id: "stub", dir: "/workspace", size: 0, sha256: "", format: "tar+zstd/1" };
  }
  async restore() {}
  async delete() {}
}
export class DirectoryBackupGateway {}
export class S3Gateway {}
export class SandboxFileError extends Error {
  code;
  constructor(message, code) { super(message); this.code = code; }
}
export class SandboxS3MountError extends Error {}
export class SandboxBackupError extends Error {}
export class SandboxProtocolError extends Error {}

// DO stub for wrangler.test.jsonc SANDBOX binding. Newer workerd/vitest-pool
// requires a DurableObject subclass for RPC; miniflare has no containers so
// production OmaSandbox must not be exported from test-worker. A DO stub
// answers `typeof stub.anyMethod === "function"`, so this class implements
// the whole OmaSandbox RPC surface the runtime calls.
export class Sandbox extends DurableObject {
  incarnation = null;
  marker = null;
  mounts = [];
  env = {};

  constructor(ctx, env) {
    super(ctx, env);
    // A real container outlives eviction of its controlling DO instance.
    // Persist only the fixture's simulated physical state, not an SDK claim.
    ctx.blockConcurrencyWhile(async () => {
      const physical = await ctx.storage.get("physical");
      if (physical) Object.assign(this, physical);
    });
  }
  async persistPhysical() {
    await this.ctx.storage.put("physical", {
      incarnation: this.incarnation, marker: this.marker,
      mounts: this.mounts, env: this.env,
    });
  }
  async describe() {
    return {
      running: this.incarnation !== null,
      incarnation: this.incarnation,
      mounts: this.mounts.map((mount) => mount.mountPath),
    };
  }
  async provision(request = {}) {
    if (this.incarnation !== null) {
      const pendingMounts = (request.mounts ?? [])
        .map((mount) => mount.mountPath)
        .filter((path) => !this.mounts.some((mount) => mount.mountPath === path));
      return { incarnation: this.incarnation, started: false, pendingMounts };
    }
    this.incarnation = request.incarnation ?? crypto.randomUUID().slice(0, 12);
    this.mounts = [...(request.mounts ?? [])];
    this.env = { ...(request.env ?? {}) };
    await this.persistPhysical();
    return { incarnation: this.incarnation, started: true, pendingMounts: [] };
  }
  async exec(command, _opts) {
    const written = /^echo (\S+) > \/tmp\/\.oma-warm$/.exec(command);
    if (this.incarnation !== null && written) {
      this.marker = written[1];
      await this.persistPhysical();
    }
    if (this.incarnation !== null && /cat \/tmp\/\.oma-warm/.test(command)) {
      return { stdout: `${this.marker ?? this.incarnation}\n`, stderr: "", exitCode: 0, success: true };
    }
    return { stdout: "", stderr: "", exitCode: 0, success: true };
  }
  // No digest-pinned container image is available in the workerd test double.
  async sandboxImage() { return null; }
  async createContainerSnapshot() {
    if (this.incarnation === null) throw new Error("Cannot snapshot a stopped container");
    return { id: `stub-rootfs-${this.incarnation}`, size: 0 };
  }
  async renewActivityTimeout() {}
  async destroy() {
    this.incarnation = null;
    this.marker = null;
    this.mounts = [];
    this.env = {};
    await this.persistPhysical();
  }
  async startProcess(_command, _opts) {
    return {
      id: "stub-proc",
      pid: 1,
      kill: async () => {},
      getLogs: async () => ({ stdout: "", stderr: "" }),
      getStatus: async () => "exited",
    };
  }
  async readFile() { return { content: "" }; }
  async writeFile() { return { success: true }; }
  async mkdir() {}
  async mountBucket(bucket, mountPath, options = {}) {
    if (this.incarnation === null) {
      this.mounts = [...this.mounts.filter((mount) => mount.mountPath !== mountPath), { bucket, mountPath, options }];
      await this.persistPhysical();
      return;
    }
    if (!this.mounts.some((mount) => mount.mountPath === mountPath)) {
      throw new Error(`MOUNT_AFTER_START: ${mountPath} was not mounted when this container started`);
    }
  }
  async unmountBucket(mountPath) {
    this.mounts = this.mounts.filter((mount) => mount.mountPath !== mountPath);
    await this.persistPhysical();
  }
  async setEnvVars(envVars) {
    Object.assign(this.env, envVars);
    await this.persistPhysical();
  }
  async createBackup(options) {
    return { id: "stub", dir: options?.dir ?? "/workspace", size: 0, sha256: "0".repeat(64), format: "tar+zstd/1", expiresAt: Date.now() + 60_000 };
  }
  async restoreBackup(handle) {
    return { success: true, dir: handle.dir, id: handle.id };
  }
  async spawnDuplex() {
    throw new Error("The test Sandbox stub has no piped process; use setCloudflareSandboxForTest");
  }
  async setOutboundHandler() {}
  async setOutboundByHost() {}
  async clearOutbound() {}
  async setBackupContext() {}
  async setBillingContext() {}
  async snapshotWorkspaceNow() {}
  async emitSandboxActiveNow() {}
}
