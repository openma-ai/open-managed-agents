import { afterEach, describe, expect, it } from "vitest";

import { CloudflareSandbox } from "../src/runtime/sandbox";
import { supportsDuplexProcess } from "@open-managed-agents/sandbox";
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
