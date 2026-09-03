import { describe, expect, it, vi } from "vitest";

import * as runtimeHostModule from "../src/index";

const scope = {
  workspaceId: "workspace_1",
  environmentId: "environment_1",
  sessionId: "session_1",
  workId: "work_1",
};
const fence = {
  ...scope,
  ownerId: "worker_1",
  generation: 8,
  token: "must-not-enter-sandbox",
  expiresAt: "2026-09-03T12:00:00.000Z",
};
const declaration = {
  type: "openma_supervised" as const,
  protocol: "openma-harness-supervisor-v1" as const,
  supervisor: { command: "openma-harness-supervisor" },
  harness: { id: "pi", version: "1.2.3" },
  readyTimeoutMs: 5_000,
  heartbeatTimeoutMs: 10_000,
  drainTimeoutMs: 5_000,
};

function SupervisorDriver(): new (options: any) => any {
  const candidate = (runtimeHostModule as Record<string, unknown>)[
    "SupervisedSandboxHarnessDriver"
  ];
  expect(candidate).toBeTypeOf("function");
  return candidate as new (options: any) => any;
}

describe("SupervisedSandboxHarnessDriver", () => {
  it("performs ready, heartbeat, completion and drain without exposing the fence token", async () => {
    const commands: unknown[] = [];
    const channel = {
      send: vi.fn(async (command: unknown) => commands.push(command)),
      events: vi.fn(async function* () {
        yield { type: "ready", protocol: "openma-harness-supervisor-v1" };
        yield { type: "heartbeat", sequence: 1 };
        yield { type: "completed", exitCode: 0 };
        yield { type: "drained" };
      }),
      close: vi.fn(async () => {}),
    };
    const driver = new (SupervisorDriver())({
      transport: { open: vi.fn(async () => channel) },
    });

    await expect(
      driver.run({
        scope,
        fence,
        sandbox: { provider: "fake", runtimeId: "runtime_1" },
        workspacePath: "/workspace",
        outputPath: "/mnt/session/outputs",
        driver: declaration,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ type: "completed" });

    expect(commands).toEqual([
      {
        type: "start",
        scope,
        harness: declaration.harness,
        workspacePath: "/workspace",
        outputPath: "/mnt/session/outputs",
      },
      { type: "drain" },
    ]);
    expect(JSON.stringify(commands)).not.toContain(fence.token);
    expect(channel.close).toHaveBeenCalledOnce();
  });

  it("sends a bounded stop when the Runtime Host aborts it", async () => {
    const commands: Array<{ type: string }> = [];
    let ready!: () => void;
    const readySeen = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const channel = {
      send: vi.fn(async (command: { type: string }) => commands.push(command)),
      events: vi.fn(async function* (signal: AbortSignal) {
        yield { type: "ready", protocol: "openma-harness-supervisor-v1" };
        ready();
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      }),
      close: vi.fn(async () => {}),
    };
    const controller = new AbortController();
    const driver = new (SupervisorDriver())({
      transport: { open: vi.fn(async () => channel) },
    });
    const running = driver.run({
      scope,
      fence,
      sandbox: { provider: "fake", runtimeId: "runtime_1" },
      workspacePath: "/workspace",
      outputPath: null,
      driver: declaration,
      signal: controller.signal,
    });
    await readySeen;
    controller.abort(new Error("lease lost"));

    await expect(running).resolves.toEqual({ type: "aborted" });
    expect(commands).toContainEqual({ type: "stop", reason: "aborted" });
    expect(channel.close).toHaveBeenCalledOnce();
  });
});
