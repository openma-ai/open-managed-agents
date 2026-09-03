import { spawn } from "node:child_process";
import type {
  ManagedSandboxLease,
  ManagedSandboxPort,
  SandboxHarnessDriverPort,
  SandboxObservation,
} from "@open-managed-agents/runtime-resource-contract";

import { safeMetadataPath, sha256 } from "./filesystem";

export interface DockerCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface DockerCommandPort {
  run(
    args: readonly string[],
    options?: { signal?: AbortSignal },
  ): Promise<DockerCommandResult>;
}

export class DockerCliPort implements DockerCommandPort {
  constructor(private readonly executable = "docker") {}

  run(
    args: readonly string[],
    options: { signal?: AbortSignal } = {},
  ): Promise<DockerCommandResult> {
    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(options.signal.reason);
        return;
      }
      const child = spawn(this.executable, [...args], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const onAbort = () => child.kill("SIGTERM");
      options.signal?.addEventListener("abort", onAbort, { once: true });
      child.once("error", reject);
      child.once("close", (code) => {
        options.signal?.removeEventListener("abort", onAbort);
        resolve({ stdout, stderr, exitCode: code ?? 1 });
      });
    });
  }
}

export interface DockerManagedRuntimeOptions {
  image: string;
  network?: string;
  docker?: DockerCommandPort;
}

/**
 * Real Docker Engine transport for the reference Node runtime. The host owns
 * lifecycle/fencing; this adapter only creates, observes, starts and destroys
 * one container with the already-materialized resource bindings.
 */
export class DockerManagedRuntimeAdapter
  implements ManagedSandboxPort, SandboxHarnessDriverPort
{
  readonly #docker: DockerCommandPort;
  readonly #options: DockerManagedRuntimeOptions;
  readonly #known = new Set<string>();

  constructor(options: DockerManagedRuntimeOptions) {
    this.#options = options;
    this.#docker = options.docker ?? new DockerCliPort();
  }

  async capabilities() {
    return {
      suspendResume: "unsupported",
      hardTerminate: "supported",
      runtimeCheckpoints: [],
    } as const;
  }

  async driverCapabilities() {
    return { drivers: ["ama_worker"] as const };
  }

  async acquire(
    input: Parameters<ManagedSandboxPort["acquire"]>[0],
  ): Promise<ManagedSandboxLease> {
    input.signal.throwIfAborted();
    const workspace = this.#mount(
      safeMetadataPath(input.workspace.metadata?.hostPath, "workspace binding"),
      input.workspace.mountPath,
    );
    const args = [
      "create",
      "--name",
      `oma-${sha256(`${input.scope.workId}:${input.fence.generation}`).slice(0, 24)}`,
      "--label",
      `dev.openma.work=${sha256(input.scope.workId).slice(0, 32)}`,
      "--mount",
      workspace,
    ];
    if (input.outputs !== null) {
      args.push(
        "--mount",
        this.#mount(
          safeMetadataPath(input.outputs.metadata?.hostPath, "output binding"),
          input.outputs.mountPath,
        ),
      );
    }
    if (this.#options.network !== undefined) {
      args.push("--network", this.#options.network);
    }
    if (input.plan.driver.type !== "ama_worker") {
      throw new Error(
        `Docker direct adapter cannot run ${input.plan.driver.type}; install a supervisor driver`,
      );
    }
    const process = input.plan.driver.process;
    if (process.cwd !== undefined) args.push("--workdir", process.cwd);
    for (const [name, value] of Object.entries(process.env ?? {})) {
      args.push("--env", `${name}=${value}`);
    }
    args.push("--entrypoint", process.command);
    args.push(this.#options.image, ...(process.args ?? []));
    const result = await this.#docker.run(args, { signal: input.signal });
    if (result.exitCode !== 0) {
      throw new Error(`docker create failed (${result.exitCode}): ${result.stderr.trim()}`);
    }
    const runtimeId = result.stdout.trim();
    if (runtimeId.length === 0) throw new Error("docker create returned no container id");
    this.#known.add(runtimeId);
    return { provider: "docker", runtimeId };
  }

  async heartbeat(input: Parameters<ManagedSandboxPort["heartbeat"]>[0]) {
    const observation = await this.inspect(input.lease);
    return observation.state === "running" || observation.state === "suspended"
      ? ({ type: "alive" } as const)
      : ({ type: "lost" } as const);
  }

  async suspend(
    _input: Parameters<ManagedSandboxPort["suspend"]>[0],
  ): Promise<ManagedSandboxLease> {
    throw new Error("Docker reference adapter does not support suspend/resume");
  }

  async terminate(input: Parameters<ManagedSandboxPort["terminate"]>[0]): Promise<void> {
    await this.#remove(input.lease);
  }

  async reap(input: Parameters<ManagedSandboxPort["reap"]>[0]): Promise<void> {
    await this.#remove(input.lease);
  }

  async #remove(lease: ManagedSandboxLease): Promise<void> {
    this.#assertLease(lease);
    const result = await this.#docker.run(["rm", "--force", lease.runtimeId]);
    this.#known.delete(lease.runtimeId);
    if (result.exitCode !== 0 && !/no such container|not found/i.test(result.stderr)) {
      throw new Error(`docker rm failed (${result.exitCode}): ${result.stderr.trim()}`);
    }
  }

  async inspect(lease: ManagedSandboxLease): Promise<SandboxObservation> {
    this.#assertLease(lease);
    const result = await this.#docker.run([
      "inspect",
      "--format",
      "{{.State.Status}}",
      lease.runtimeId,
    ]);
    if (result.exitCode !== 0) return { state: "stopped" };
    const state = result.stdout.trim();
    if (state === "running" || state === "created" || state === "restarting") {
      return { state: "running" };
    }
    if (state === "paused") return { state: "suspended" };
    if (state === "exited" || state === "dead" || state === "removing") {
      return { state: "stopped" };
    }
    return { state: "unknown" };
  }

  async run(
    input: Parameters<SandboxHarnessDriverPort["run"]>[0],
  ): Promise<{ type: "completed" } | { type: "aborted" }> {
    this.#assertLease(input.sandbox);
    const killOnAbort = () => {
      void this.#docker.run(["kill", input.sandbox.runtimeId]).catch(() => {});
    };
    input.signal.addEventListener("abort", killOnAbort, { once: true });
    try {
      const result = await this.#docker.run(
        ["start", "--attach", input.sandbox.runtimeId],
        { signal: input.signal },
      );
      if (input.signal.aborted) return { type: "aborted" };
      if (result.exitCode !== 0) {
        throw new Error(`docker start failed (${result.exitCode}): ${result.stderr.trim()}`);
      }
      return { type: "completed" };
    } finally {
      input.signal.removeEventListener("abort", killOnAbort);
    }
  }

  #assertLease(lease: ManagedSandboxLease): void {
    if (lease.provider !== "docker" || lease.runtimeId.length === 0) {
      throw new Error("Docker adapter received an incompatible sandbox lease");
    }
  }

  #mount(source: string, destination: string): string {
    if (source.includes(",") || destination.includes(",")) {
      throw new Error("Docker bind mount paths cannot contain commas");
    }
    return `type=bind,src=${source},dst=${destination}`;
  }
}
