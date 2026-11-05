import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { createAcpRuntime } from "@open-managed-agents/acp-runtime/placement";
import { NodeSpawner } from "@open-managed-agents/acp-runtime/node-spawner";
import { createBoxLiteProvider } from "@open-managed-agents/managed-runtime-boxlite";
import { supportsDuplexProcess, supportsSandboxRuntime } from "@open-managed-agents/sandbox";
import type { SandboxFactoryEnv, SandboxPort, SandboxRuntimePort, SandboxDuplexProcessPort, SandboxRuntimeHandle } from "@open-managed-agents/sandbox";

export interface RuntimeAttachment {
  runtime_id: string;
  placement?: "host" | "sandbox";
  directories?: unknown;
}
export type RuntimeSandbox = SandboxPort & SandboxRuntimePort & SandboxDuplexProcessPort;

/** Attached Runtime sandboxes run embedded LiteBox on the daemon's machine.
 * Cloud/REST selection and host volumes are deliberately not accepted here. */
export function runtimeSandboxEnvironment(env: SandboxFactoryEnv) {
  if (env.BOXRUN_URL || (env.SANDBOX_PROVIDER && env.SANDBOX_PROVIDER !== "litebox")) {
    throw new Error("Runtime sandbox placement requires local embedded LiteBox; cloud/boxrun REST is not supported");
  }
  return {
    providerId: "litebox" as const,
    image: env.SANDBOX_IMAGE ?? "node:22-bookworm",
    connection: { type: "embedded" as const },
  };
}

// This adapter uses only local allocation, not the control-plane lease driver.
// Scope/fence identify this daemon acquisition; they grant no host mounts or
// credentials. The provider consumes the image and session-specific stable name.
function acquisition(sessionId: string, runtimeId: string, workspaceId: string, image: string) {
  const scope = { workspaceId, environmentId: runtimeId, sessionId, workId: sessionId };
  return {
    scope,
    fence: { ...scope, ownerId: runtimeId, generation: 1, token: sessionId, expiresAt: new Date(Date.now() + 60_000).toISOString() },
    plan: {
      workspaceStrategy: "retained_runtime" as const, outputStrategy: null, runtimeCheckpoint: null,
      driver: { type: "ama_worker" as const, process: { command: "worker" } },
    },
    workspace: { bindingId: sessionId, mountPath: "/workspace" as const },
    outputs: null, credentialEgress: null,
    environment: { type: "base" as const, identity: image, artifact: { type: "image" as const, reference: image } },
    signal: new AbortController().signal,
  };
}

/** Pure placement guard runs before any local cwd/binary lookup or allocation. */
export function runtimePlacement(attachment?: RuntimeAttachment, cwd?: string): "host" | "sandbox" {
  const placement = attachment?.placement ?? "host";
  if (placement !== "sandbox" && placement !== "host") throw new Error("Invalid Runtime placement");
  if (attachment && "directories" in attachment) throw new Error("Runtime custom directories are not yet supported");
  if (placement === "sandbox" && cwd !== undefined) {
    throw new Error("Sandbox placement forbids host cwd / GitHub local_path; clone repositories inside the sandbox");
  }
  return placement;
}

interface Ownership {
  sessionId: string;
  runtimeId: string;
  handle: SandboxRuntimeHandle;
}

/** Local, durable ownership registry. Never recreate a missing retained
 * LiteBox silently: that would lose ACP transcripts on resume. Retention,
 * lease renewal and automatic cleanup remain separate future work. */
export class RuntimeSandboxRegistry {
  readonly owned = new Map<string, { ownership: Ownership; sandbox: RuntimeSandbox }>();
  private readonly pending = new Map<string, Promise<RuntimeSandbox>>();

  async acquire(sessionId: string, runtimeId: string, scratchDir: string, env: SandboxFactoryEnv, workspaceId: string): Promise<RuntimeSandbox> {
    // Serialize same-session acquisition so concurrent starts cannot race the
    // durable ownership write. Different sessions always acquire separate boxes.
    const pending = this.pending.get(sessionId);
    if (pending) {
      await pending;
      return this.acquire(sessionId, runtimeId, scratchDir, env, workspaceId);
    }
    const work = this.acquireOwned(sessionId, runtimeId, scratchDir, env, workspaceId);
    this.pending.set(sessionId, work);
    try { return await work; }
    finally { this.pending.delete(sessionId); }
  }

  private async acquireOwned(sessionId: string, runtimeId: string, scratchDir: string, env: SandboxFactoryEnv, workspaceId: string): Promise<RuntimeSandbox> {
    if (!runtimeId) throw new Error("Sandbox placement requires runtime_id");
    const options = runtimeSandboxEnvironment(env);
    const active = this.owned.get(sessionId);
    if (active) {
      if (active.ownership.runtimeId !== runtimeId) throw new Error("Sandbox Runtime ownership mismatch");
      return active.sandbox;
    }
    const path = join(scratchDir, ".oma-runtime-sandbox.json");
    const saved = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    const ownership: Ownership | null = saved === null ? null : JSON.parse(saved);
    if (ownership && (ownership.sessionId !== sessionId || ownership.runtimeId !== runtimeId || ownership.handle.provider !== "litebox")) {
      throw new Error("Sandbox Runtime ownership mismatch");
    }
    const context = { sessionId, workdir: "/workspace" };
    const provider = createBoxLiteProvider(options);
    const allocation = acquisition(sessionId, runtimeId, workspaceId, options.image);
    const sandbox = ownership
      ? await provider.resume(ownership.handle, context, {}, allocation)
      : await provider.create(context, {}, allocation);
    if (!supportsDuplexProcess(sandbox) || !supportsSandboxRuntime(sandbox)) {
      throw new Error("LiteBox requires runtime and duplex process capabilities");
    }
    const record = ownership ?? { sessionId, runtimeId, handle: sandbox.runtimeHandle() };
    if (!ownership) {
      try {
        await writeFile(`${path}.tmp`, JSON.stringify(record), { mode: 0o600 });
        await rename(`${path}.tmp`, path);
      } catch (error) {
        await sandbox.destroy?.();
        throw error;
      }
    }
    this.owned.set(sessionId, { ownership: record, sandbox });
    return sandbox;
  }
}

export function resolvePlacementRuntime(sandbox?: RuntimeSandbox) {
  return sandbox
    ? createAcpRuntime({ type: "sandbox", sandbox })
    : createAcpRuntime({ type: "local", spawner: new NodeSpawner() });
}
