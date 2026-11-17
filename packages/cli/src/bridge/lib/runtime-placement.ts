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
  /** Rejected at runtime until host custom directories ship. */
  directories?: ReadonlyArray<{ hostPath: string; mountPath: string }>;
}
export type RuntimeSandbox = SandboxPort & SandboxRuntimePort & SandboxDuplexProcessPort;

type RuntimeBoxLiteEnvironment = {
  providerId: "litebox" | "boxrun";
  image: string;
  cpus?: number;
  memoryMib?: number;
  connection:
    | { type: "embedded"; homeDir?: string }
    | { type: "rest"; url: string; apiKey?: string; pathPrefix?: string };
};

/** Resolve the two Runtime-owned BoxLite providers. Embedded LiteBox is the
 * default; BoxRun is the cloud/remote REST provider selected explicitly with
 * SANDBOX_PROVIDER=boxrun. */
export function runtimeSandboxEnvironment(env: SandboxFactoryEnv) {
  const selected = env.SANDBOX_PROVIDER?.trim().toLowerCase();
  const remoteUrl = env.BOXRUN_URL?.trim() || env.BOXLITE_URL?.trim();
  if (selected !== undefined && selected !== "" && selected !== "litebox" && selected !== "boxlite" && selected !== "boxrun") {
    throw new Error("Runtime sandbox placement supports SANDBOX_PROVIDER=litebox or boxrun");
  }
  if (selected === "boxrun" || remoteUrl !== undefined && remoteUrl !== "") {
    if (selected === "litebox" || selected === "boxlite") {
      throw new Error("SANDBOX_PROVIDER=litebox cannot be combined with BOXRUN_URL/BOXLITE_URL; use boxrun");
    }
    if (remoteUrl === undefined || remoteUrl === "") {
      throw new Error("SANDBOX_PROVIDER=boxrun requires BOXRUN_URL or BOXLITE_URL");
    }
    return {
      providerId: "boxrun" as const,
      image: env.SANDBOX_IMAGE ?? "node:22-bookworm",
      ...boxRunResources(env),
      connection: boxRunConnection(remoteUrl, env),
    } satisfies RuntimeBoxLiteEnvironment;
  }
  const homeDir = env.BOXLITE_HOME?.trim();
  return {
    providerId: "litebox" as const,
    image: env.SANDBOX_IMAGE ?? "node:22-bookworm",
    // Optional BOXLITE_HOME keeps the daemon out of another process's lock
    // (for example a co-located Cloud SANDBOX_PROVIDER=litebox main-node).
    connection: homeDir
      ? { type: "embedded" as const, homeDir }
      : { type: "embedded" as const },
  } satisfies RuntimeBoxLiteEnvironment;
}

function boxRunResources(env: SandboxFactoryEnv): { cpus?: number; memoryMib?: number } {
  const integer = (key: string): number | undefined => {
    const raw = env[key]?.trim();
    if (!raw) return undefined;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${key} must be a positive integer`);
    }
    return value;
  };
  const cpus = integer("BOXRUN_CPUS");
  const memoryMib = integer("BOXRUN_MEMORY_MIB");
  return {
    ...(cpus === undefined ? {} : { cpus }),
    ...(memoryMib === undefined ? {} : { memoryMib }),
  };
}

function boxRunConnection(
  rawUrl: string,
  env: SandboxFactoryEnv,
): RuntimeBoxLiteEnvironment["connection"] {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("BOXRUN_URL/BOXLITE_URL must be an absolute http(s) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("BOXRUN_URL/BOXLITE_URL must be an absolute http(s) URL");
  }

  const configuredPrefix = env.BOXRUN_PATH_PREFIX?.trim() || env.BOXLITE_PATH_PREFIX?.trim();
  let pathPrefix = configuredPrefix || undefined;
  const path = parsed.pathname.replace(/\/+$/, "");
  if (path === "/v1" || path.startsWith("/v1/")) {
    const urlPrefix = path.slice("/v1/".length);
    if (path !== "/v1") {
      let decodedPrefix: string;
      try {
        decodedPrefix = decodeURIComponent(urlPrefix);
      } catch {
        throw new Error("BOXRUN_URL/BOXLITE_URL contains an invalid encoded path prefix");
      }
      if (pathPrefix !== undefined && pathPrefix !== decodedPrefix) {
        throw new Error("BOXRUN_PATH_PREFIX conflicts with the /v1/<prefix> URL path");
      }
      pathPrefix = decodedPrefix;
    }
    parsed.pathname = "";
  }
  parsed.search = "";
  parsed.hash = "";
  const apiKey = env.BOXLITE_API_KEY?.trim() || env.BOXRUN_TOKEN?.trim() || undefined;
  return {
    type: "rest",
    url: parsed.toString().replace(/\/$/, ""),
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(pathPrefix === undefined || pathPrefix === "" ? {} : { pathPrefix }),
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

/** Durable ownership registry. Never recreate a missing retained BoxLite
 * runtime silently: that would lose ACP transcripts on resume. Retention,
 * lease renewal and automatic cleanup remain separate future work. */
export class RuntimeSandboxRegistry {
  readonly owned = new Map<string, { ownership: Ownership; sandbox: RuntimeSandbox }>();
  private readonly pending = new Map<string, Promise<RuntimeSandbox>>();
  /** Reuse one client per provider configuration. Creating an embedded provider
   * per acquire takes a second BOXLITE_HOME lock and deadlocks with a live box. */
  private provider: ReturnType<typeof createBoxLiteProvider> | undefined;
  private providerKey: string | undefined;

  private providerFor(env: SandboxFactoryEnv) {
    const options = runtimeSandboxEnvironment(env);
    const key = JSON.stringify(options);
    if (this.provider === undefined || this.providerKey !== key) {
      this.provider = createBoxLiteProvider(options);
      this.providerKey = key;
    }
    return { provider: this.provider, options };
  }

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
    const { provider, options } = this.providerFor(env);
    const active = this.owned.get(sessionId);
    if (active) {
      if (active.ownership.runtimeId !== runtimeId) throw new Error("Sandbox Runtime ownership mismatch");
      if (active.ownership.handle.provider !== options.providerId) {
        throw new Error("Sandbox Runtime provider mismatch");
      }
      return active.sandbox;
    }
    const path = join(scratchDir, ".oma-runtime-sandbox.json");
    const saved = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    const ownership: Ownership | null = saved === null ? null : JSON.parse(saved);
    if (ownership && (ownership.sessionId !== sessionId || ownership.runtimeId !== runtimeId || ownership.handle.provider !== options.providerId)) {
      throw new Error("Sandbox Runtime ownership mismatch");
    }
    const context = { sessionId, workdir: "/workspace" };
    const allocation = acquisition(sessionId, runtimeId, workspaceId, options.image);
    const sandbox = ownership
      ? await provider.resume(ownership.handle, context, {}, allocation)
      : await provider.create(context, {}, allocation);
    if (!supportsDuplexProcess(sandbox) || !supportsSandboxRuntime(sandbox)) {
      throw new Error("BoxLite requires runtime and duplex process capabilities");
    }
    if (sandbox.runtimeHandle().provider !== options.providerId) {
      await sandbox.destroy?.();
      throw new Error("BoxLite provider returned a runtime handle for the wrong provider");
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
