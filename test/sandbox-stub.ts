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
// production OmaSandbox must not be exported from test-worker.
export class Sandbox extends DurableObject {
  async exec(_command, _opts) {
    return { stdout: "", stderr: "", exitCode: 0, success: true };
  }
  async renewActivityTimeout() {}
  async destroy() {}
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
  async writeFile() {}
  async mkdir() {}
  async setOutboundHandler() {}
  async setOutboundByHost() {}
  async clearOutbound() {}
}

// Legacy test override still used by older helpers; CloudflareSandbox now
// uses setCloudflareSandboxForTest from runtime/sandbox.ts.
let sandboxOverride;
export function setSandboxForTest(sandbox) {
  sandboxOverride = sandbox;
}
export function getSandbox() {
  if (sandboxOverride) return sandboxOverride;
  return {
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0, success: true }),
    readFile: async () => ({ content: "" }),
    writeFile: async () => {},
    mkdir: async () => {},
  };
}
export function proxyToSandbox() {
  return new Response("stub");
}
