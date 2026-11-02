// @ts-nocheck
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

// Empty DO class for wrangler.test.jsonc SANDBOX binding. Vitest/miniflare
// has no containers; production uses OmaSandbox from apps/agent.
export class Sandbox {}

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
