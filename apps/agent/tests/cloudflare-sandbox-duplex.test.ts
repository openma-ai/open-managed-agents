import { afterEach, describe, expect, it } from "vitest";

import { CloudflareSandbox } from "../src/runtime/sandbox";
import {
  supportsDuplexProcess,
  supportsSandboxRuntime,
} from "@open-managed-agents/sandbox";
import { setSandboxForTest } from "../../../test/sandbox-stub";

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let value = "";
  for (;;) {
    const item = await reader.read();
    if (item.done) return value + decoder.decode();
    value += decoder.decode(item.value, { stream: true });
  }
}

afterEach(() => setSandboxForTest(undefined));

describe("CloudflareSandbox duplex process", () => {
  it("exposes the live process capability required by SandboxSpawner", () => {
    const sandbox = new CloudflareSandbox({ SANDBOX: {} } as never, "sess-acp");

    expect(supportsDuplexProcess(sandbox)).toBe(true);
  });

  it("exposes lease and portable filesystem checkpoint lifecycle", async () => {
    const calls: unknown[] = [];
    setSandboxForTest({
      async renewActivityTimeout() { calls.push(["renewActivityTimeout"]); },
      async createBackup(options: unknown) {
        calls.push(["createBackup", options]);
        return { id: "backup-cf-01", dir: "/workspace", localBucket: true };
      },
      async restoreBackup(handle: unknown) {
        calls.push(["restoreBackup", handle]);
        return { success: true };
      },
      async destroy() { calls.push(["destroy"]); },
    });
    const sandbox = new CloudflareSandbox(
      { SANDBOX: {} } as never,
      "sess-lifecycle",
    );

    expect(supportsSandboxRuntime(sandbox)).toBe(true);
    if (!supportsSandboxRuntime(sandbox)) throw new Error("runtime port missing");
    expect(sandbox.runtimeHandle()).toEqual({
      provider: "cloudflare",
      runtimeId: "sess-lifecycle",
    });
    expect(sandbox.runtimeCapabilities()).toEqual({
      lease: true,
      suspend: ["filesystem"],
      checkpoint: ["filesystem"],
    });
    await sandbox.renewLease({ ttlMs: 90_000 });
    const checkpoint = await sandbox.checkpoint({
      kind: "filesystem",
      name: "turn-01",
    });
    expect(checkpoint).toEqual({
      provider: "cloudflare",
      checkpointId: "backup-cf-01",
      sourceRuntimeId: "sess-lifecycle",
      kind: "filesystem",
      scope: "portable",
      metadata: { dir: "/workspace", localBucket: true },
    });
    await sandbox.resume(checkpoint);
    const suspended = await sandbox.suspend({ kind: "filesystem" });
    expect(suspended).toMatchObject({
      provider: "cloudflare",
      kind: "filesystem",
      scope: "portable",
    });
    expect(calls.map((call) => (call as unknown[])[0])).toEqual([
      "renewActivityTimeout",
      "createBackup",
      "restoreBackup",
      "createBackup",
      "destroy",
    ]);
  });

  it("keeps ACP stdin open across frames and streams process output", async () => {
    let processOptions:
      | {
          onOutput?(stream: "stdout" | "stderr", data: string): void;
          onExit?(code: number | null): void;
          onError?(error: Error): void;
        }
      | undefined;
    setSandboxForTest({
      async exec(command: string) {
        const encoded = command.match(/'([A-Za-z0-9+/=]+)'\s*\|\s*base64\s+-d/)?.[1];
        if (encoded) {
          const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
          processOptions?.onOutput?.("stdout", new TextDecoder().decode(bytes));
        }
        return { stdout: "", stderr: "", exitCode: 0, success: true };
      },
      async startProcess(_command: string, options: typeof processOptions) {
        processOptions = options;
        return {
          id: "proc-acp",
          pid: 42,
          kill: async () => processOptions?.onExit?.(null),
          getLogs: async () => ({ stdout: "", stderr: "" }),
          getStatus: async () => "running",
        };
      },
    });
    const sandbox = new CloudflareSandbox({ SANDBOX: {} } as never, "sess-acp");

    const child = await sandbox.spawnDuplexProcess({
      command: "agent",
      args: ["--acp"],
      cwd: "/workspace",
      env: { MODEL: "test" },
    });
    const stdout = readAll(child.stdout);
    const stderr = readAll(child.stderr);
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode('{"id":1}\n'));
    await writer.write(new TextEncoder().encode('{"id":2}\n'));
    await writer.close();
    processOptions?.onOutput?.("stderr", "diagnostic");
    processOptions?.onExit?.(0);

    await expect(child.exited).resolves.toEqual({ code: 0, signal: null });
    await expect(stdout).resolves.toBe('{"id":1}\n{"id":2}\n');
    await expect(stderr).resolves.toBe("diagnostic");
  });

  it("settles exit and cleans up when kill has no callback", async () => {
    const commands: string[] = [];
    setSandboxForTest({
      async exec(command: string) {
        commands.push(command);
        return { stdout: "", stderr: "", exitCode: 0, success: true };
      },
      async startProcess() {
        return { kill: async () => {} };
      },
    });
    const sandbox = new CloudflareSandbox({ SANDBOX: {} } as never, "sess-acp");
    const child = await sandbox.spawnDuplexProcess({ command: "agent" });

    await child.kill("SIGKILL");

    await expect(child.exited).resolves.toEqual({
      code: null,
      signal: "SIGKILL",
    });
    expect(commands.some((command) => command.startsWith("rm -f "))).toBe(true);
  });
});
