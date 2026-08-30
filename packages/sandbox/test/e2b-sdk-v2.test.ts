import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  create: vi.fn(async () => ({
    commands: { run: vi.fn() },
    files: { read: vi.fn(), write: vi.fn() },
    kill: vi.fn(),
  })),
}));

vi.mock("e2b", () => ({
  Sandbox: { create: sdk.create },
}));

import { sandboxFactory } from "../src/adapters/e2b";
import { E2BSandboxExecutor } from "../src/adapters/e2b";

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

describe("E2B SDK v2 adapter", () => {
  beforeEach(() => sdk.create.mockClear());

  it("passes the template and self-hosted endpoints using the official v2 shape", async () => {
    await sandboxFactory(
      { sessionId: "session_e2b", workdir: "/tmp/unused" },
      {
        E2B_API_KEY: "local",
        E2B_API_URL: "http://127.0.0.1:3000",
        E2B_SANDBOX_URL: "http://127.0.0.1:3002",
        E2B_DOMAIN: "localhost",
        SANDBOX_IMAGE: "code-interpreter",
      },
    );

    expect(sdk.create).toHaveBeenCalledWith("code-interpreter", {
      apiKey: "local",
      apiUrl: "http://127.0.0.1:3000",
      sandboxUrl: "http://127.0.0.1:3002",
      domain: "localhost",
    });
  });

  it("uses the official live-stdin command channel for ACP", async () => {
    let commandOptions:
      | {
          background?: boolean;
          stdin?: boolean;
          timeoutMs?: number;
          cwd?: string;
          envs?: Record<string, string>;
          onStdout?(data: string): void;
          onStderr?(data: string): void;
        }
      | undefined;
    let finish!: (result: { stdout: string; stderr: string; exitCode: number }) => void;
    const wait = new Promise<{ stdout: string; stderr: string; exitCode: number }>(
      (resolve) => { finish = resolve; },
    );
    const handle = {
      pid: 73,
      async sendStdin(data: Uint8Array) {
        commandOptions?.onStdout?.(new TextDecoder().decode(data));
      },
      async closeStdin() {},
      async kill() { return true; },
      wait: () => wait,
    };
    const adapter = new E2BSandboxExecutor({
      commands: {
        async run(_command: string, options: typeof commandOptions) {
          commandOptions = options;
          return handle;
        },
      },
      files: { async read() { return ""; }, async write() {} },
      async kill() {},
    } as never, {});

    const child = await adapter.spawnDuplexProcess({
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
    commandOptions?.onStderr?.("diagnostic");
    finish({ stdout: "", stderr: "", exitCode: 0 });

    expect(commandOptions).toMatchObject({
      background: true,
      stdin: true,
      timeoutMs: 0,
      cwd: "/workspace",
      envs: { MODEL: "test" },
    });
    await expect(child.exited).resolves.toEqual({ code: 0, signal: null });
    await expect(stdout).resolves.toBe('{"id":1}\n{"id":2}\n');
    await expect(stderr).resolves.toBe("diagnostic");
  });
});
