import { describe, expect, it, vi } from "vitest";

import * as nodeRuntimeModule from "../src/index";

const scope = {
  workspaceId: "workspace_1",
  environmentId: "environment_1",
  sessionId: "session_1",
  workId: "work_1",
};
const fence = {
  ...scope,
  ownerId: "worker_1",
  generation: 3,
  token: "secret-fence",
  expiresAt: "2026-09-03T12:00:00.000Z",
};

function DockerAdapter(): new (options: any) => any {
  const candidate = (nodeRuntimeModule as Record<string, unknown>)[
    "DockerManagedRuntimeAdapter"
  ];
  expect(candidate).toBeTypeOf("function");
  return candidate as new (options: any) => any;
}

describe("DockerManagedRuntimeAdapter", () => {
  it("binds declared workspace/output paths and never exposes the fence token", async () => {
    const calls: string[][] = [];
    const docker = {
      run: vi.fn(async (args: string[]) => {
        calls.push(args);
        if (args[0] === "create") return { stdout: "container-123\n", stderr: "", exitCode: 0 };
        if (args[0] === "start") return { stdout: "", stderr: "", exitCode: 0 };
        if (args[0] === "rm") return { stdout: "", stderr: "", exitCode: 0 };
        throw new Error(`Unexpected docker command: ${args.join(" ")}`);
      }),
    };
    const adapter = new (DockerAdapter())({
      docker,
      image: "example/managed-hand:test",
    });
    const controller = new AbortController();
    const lease = await adapter.acquire({
      scope,
      fence,
      plan: {
        workspaceStrategy: "checkpoint_restore",
        outputStrategy: "final_collect",
        runtimeCheckpoint: null,
        driver: {
          type: "ama_worker",
          process: {
            command: "/bin/sh",
            args: ["-c", "echo done"],
          },
        },
      },
      workspace: {
        bindingId: "workspace-binding",
        mountPath: "/workspace",
        metadata: { hostPath: "/tmp/openma/workspace" },
      },
      outputs: {
        bindingId: "output-binding",
        mountPath: "/mnt/session/outputs",
        metadata: { hostPath: "/tmp/openma/outputs" },
      },
      signal: controller.signal,
    });
    await expect(
      adapter.run({
        scope,
        fence,
        sandbox: lease,
        workspacePath: "/workspace",
        outputPath: "/mnt/session/outputs",
        signal: controller.signal,
      }),
    ).resolves.toEqual({ type: "completed" });
    await adapter.terminate({ scope, fence, lease, reason: "completed" });

    expect(lease).toEqual({ provider: "docker", runtimeId: "container-123" });
    expect(calls[0]).toEqual(
      expect.arrayContaining([
        "create",
        "--mount",
        "type=bind,src=/tmp/openma/workspace,dst=/workspace",
        "type=bind,src=/tmp/openma/outputs,dst=/mnt/session/outputs",
        "example/managed-hand:test",
      ]),
    );
    expect(calls.flat().join(" ")).not.toContain(fence.token);
    expect(calls[1]).toEqual(["start", "--attach", "container-123"]);
    expect(calls[2]).toEqual(["rm", "--force", "container-123"]);
  });

  it("reports a disappeared container as a lost sandbox lease", async () => {
    const docker = {
      run: vi.fn(async (args: string[]) => {
        if (args[0] === "inspect") {
          return { stdout: "", stderr: "not found", exitCode: 1 };
        }
        return { stdout: "container-456\n", stderr: "", exitCode: 0 };
      }),
    };
    const adapter = new (DockerAdapter())({
      docker,
      image: "example/managed-hand:test",
    });
    const lease = { provider: "docker", runtimeId: "container-456" };

    await expect(adapter.heartbeat({ scope, fence, lease })).resolves.toEqual({
      type: "lost",
    });
    await expect(adapter.inspect(lease)).resolves.toEqual({ state: "stopped" });
  });

  it("reaps a serialized orphan lease and treats an already-missing container as success", async () => {
    let removals = 0;
    const docker = {
      run: vi.fn(async (args: string[]) => {
        if (args[0] !== "rm") throw new Error(`unexpected:${args.join(" ")}`);
        removals += 1;
        if (removals === 1) {
          return { stdout: "", stderr: "daemon partitioned", exitCode: 1 };
        }
        return {
          stdout: "",
          stderr: removals === 3 ? "No such container" : "",
          exitCode: removals === 3 ? 1 : 0,
        };
      }),
    };
    const adapter = new (DockerAdapter())({
      docker,
      image: "example/managed-hand:test",
    });
    const lease = { provider: "docker", runtimeId: "orphan-container" };

    await expect(
      adapter.reap({ scope, lease, reason: "lease_lost" }),
    ).rejects.toThrow(/daemon partitioned/i);
    await expect(
      adapter.reap({ scope, lease, reason: "lease_lost" }),
    ).resolves.toBeUndefined();
    await expect(
      adapter.reap({ scope, lease, reason: "lease_lost" }),
    ).resolves.toBeUndefined();
  });
});
