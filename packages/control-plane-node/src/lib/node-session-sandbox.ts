// The Node Session sandbox (research/sandbox-sdk-v2-design.md §0.0 rule 15,
// §0.7): composition only. The lifecycle is the shared core
// (PortsSessionSandbox, @open-managed-agents/session-runtime); this module
// injects its Ports and the Node infrastructure:
//   - lifecycle: the deployment's Sandbox SDK v2 adapter when it has one
//     (SANDBOX_PROVIDER=e2b: the native E2B adapter), else the v1 factory
//     through fromV1SandboxFactory (images, prepared bases and allocation
//     stay the managed builder's);
//   - storage: Node's Memory Store and Session output implementations as
//     the storage Port; written back at turn end under the execution fence,
//     never at the interval (they rebase, which would overwrite files the
//     agent is editing);
//   - egress: createForwarderEgress to the existing /v1/oma/egress ingress
//     with a relay pass bound to the execution attempt; attached
//     repositories are platform channels under limited networking;
//   - the handle record in process memory; the idle pause on a process timer.
// The facade is what the runner and the tools see (a SandboxPort). Calls the
// core does not own (bytes reads, git checkout, command secrets, the v1
// runtime Port the runner probes and heartbeats) go to the live runtime
// once it is open, and exist only when that runtime has them.

import {
  DEFAULT_WORKSPACE_ROOT,
  resolveSandboxImage,
  EMPTY_SANDBOX_IMAGE_CATALOG,
  supportsDuplexProcess,
  supportsSandboxRuntime,
  type SandboxDuplexProcess,
  type SandboxDuplexProcessSpec,
  type SandboxImageCatalog,
  type SandboxPort,
  type SandboxRuntimePort,
  type SandboxStoragePort,
  type Substitution,
} from "@open-managed-agents/sandbox";
import type { RuntimeResourceFence, RuntimeResourceScope } from "@open-managed-agents/runtime-resource-contract";
import {
  createSandboxPorts,
  fromV1SandboxFactory,
  repositoryChannels,
  sessionEgressPolicy,
  type SandboxAdapterPort,
} from "@open-managed-agents/sandbox-port-kit";
import {
  PortsSessionSandbox,
  executionOfFence,
  type SessionSandboxExecutor,
  type SessionSandboxState,
} from "@open-managed-agents/session-runtime";
import type { SessionExecutionFence } from "@open-managed-agents/session-runtime-contract";
import type { Environment, Session } from "@open-managed-agents/managed-agents-application";
import { EGRESS_RELAY_PATH } from "@open-managed-agents/managed-credential-resolver";
import { issueSandboxRelayPass } from "@open-managed-agents/sandbox-gateway";
import { toLegacyHarnessEnvironmentConfig } from "./node-managed-agent-codec.js";

/** Lifetime of a relay pass; the relay is re-attached with a new one after half. */
export const NODE_RELAY_PASS_TTL_MS = 60 * 60_000;
/** idlePauseMs (design §0.0 rule 11) when SANDBOX_IDLE_PAUSE_MS is unset. */
export const DEFAULT_SANDBOX_IDLE_PAUSE_MS = 5 * 60_000;

/** SANDBOX_IDLE_PAUSE_MS (a positive integer of milliseconds), else the default. */
export function sandboxIdlePauseMs(value: string | undefined): number {
  if (value === undefined || value === "") return DEFAULT_SANDBOX_IDLE_PAUSE_MS;
  const ms = Number(value);
  if (!Number.isInteger(ms) || ms <= 0) throw new Error(`SANDBOX_IDLE_PAUSE_MS must be a positive integer of milliseconds, got ${JSON.stringify(value)}`);
  return ms;
}

export interface NodeSessionSandboxContext {
  workspaceId: string;
  session: Session;
  environment: Environment;
}

/** A deployment's Sandbox SDK v2 adapter for Session sandboxes (design §0.2). */
export interface NodeSessionSandboxAdapter {
  adapter: SandboxAdapterPort<SandboxPort>;
  /** plan.from.image: the Environment's catalog image, else the deployment default. */
  image(catalogImage: { alias: string; reference: string } | undefined): string;
  /** keepAlive at exec boundaries this often (below the provider's lease). */
  keepAliveMs: number;
}

export interface NodeSessionSandboxOptions {
  /** Omitted: the v1 factory (`createV1`) through the v1 bridge. */
  adapter?: NodeSessionSandboxAdapter;
  images?: SandboxImageCatalog;
  /** The v1 sandbox for a Session (the managed builder). */
  createV1(input: NodeSessionSandboxContext & { allocationId?: string; signal: AbortSignal }): Promise<SandboxPort>;
  /** Lease the v1 bridge renews on keepAlive (config.workspace.sandboxLeaseTtlMs). */
  v1LeaseTtlMs?: number;
  storage: {
    /** Every open (design §0.1 step 3): outputs and Memory Stores in. */
    attach(input: NodeSessionSandboxContext & {
      sandbox: SandboxPort;
      runtimeGeneration: string;
      executionFence?: SessionExecutionFence;
      signal: AbortSignal;
    }): Promise<void>;
    /** turn_end / before_stop under the execution fence: Memory write-back and outputs. */
    synchronize(input: NodeSessionSandboxContext & {
      sandbox: SandboxPort;
      runtimeGeneration: string;
      executionFence: SessionExecutionFence;
    }): Promise<void>;
  };
  /** The Session's sandbox substitutions (Vault environment_variable / cap_cli placeholders). */
  substitutions(context: NodeSessionSandboxContext): Promise<Substitution[]>;
  /** Relay pass signer and the control plane's public HTTPS origin; null = not configured. */
  relay(): { issue(input: Parameters<Parameters<typeof issueSandboxRelayPass>[0]>[0]): Promise<string>; endpoint: string } | null;
  isFenceActive(fence: SessionExecutionFence): Promise<boolean>;
  idlePauseMs: number;
  warn(message: string, context: NodeSessionSandboxContext): void;
}

/** Node's only egress path for Vault sandbox credentials: the in-sandbox
 * forwarder to the control plane's relay, which needs the pass signer and
 * an HTTPS origin the sandbox can reach. Without it a Session holding such
 * credentials is refused at create (400) and never opened: placeholders
 * would leave the sandbox unsubstituted (design §0.7, §8.0). */
export function nodeCredentialEgress(relay: ReturnType<NodeSessionSandboxOptions["relay"]>): boolean {
  return relay !== null && relay.endpoint.startsWith("https://");
}

const NO_CREDENTIAL_EGRESS = "Vault credential egress requires PLATFORM_ROOT_SECRET and the ordinary HTTPS PUBLIC_BASE_URL";

/** One facade per runner allocation, found again by the runner's hooks. */
export class NodeSessionSandboxes {
  private readonly current = new Map<string, NodeSessionSandbox>();

  constructor(private readonly options: NodeSessionSandboxOptions) {}

  /** Session create admission (SandboxCredentialAdmission.substitutes). */
  credentialEgress(): boolean {
    return nodeCredentialEgress(this.options.relay());
  }

  build(input: NodeSessionSandboxContext & {
    allocationId?: string;
    runtimeGeneration?: string;
    executionFence?: SessionExecutionFence;
  }): NodeSessionSandbox {
    const key = keyOf(input.workspaceId, input.session.id);
    const context = { workspaceId: input.workspaceId, session: input.session, environment: input.environment };
    const sandbox: NodeSessionSandbox = new NodeSessionSandbox(context, input.allocationId, this.options, () => {
      if (this.current.get(key) === sandbox) this.current.delete(key);
    });
    sandbox.bind({
      context,
      ...(input.runtimeGeneration === undefined ? {} : { runtimeGeneration: input.runtimeGeneration }),
      ...(input.executionFence === undefined ? {} : { executionFence: input.executionFence }),
    });
    this.current.set(key, sandbox);
    return sandbox;
  }

  get(input: { workspaceId: string; session: { id: string } }): NodeSessionSandbox {
    const sandbox = this.current.get(keyOf(input.workspaceId, input.session.id));
    if (sandbox === undefined) throw new Error(`Session ${input.session.id} has no sandbox`);
    return sandbox;
  }
}

export class NodeSessionSandbox implements SandboxPort {
  private readonly core: PortsSessionSandbox<SandboxPort>;
  private context: NodeSessionSandboxContext;
  private executionFence: SessionExecutionFence | undefined;
  private runtimeGeneration = "";
  private state: SessionSandboxState | undefined;
  /** The runtime the core last opened (kept after an idle pause for probes). */
  private live: SandboxPort | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly commandSecrets = new Map<string, Record<string, string>>();

  readFileBytes?: (path: string) => Promise<Uint8Array>;
  gitCheckout?: SandboxPort["gitCheckout"];
  registerCommandSecrets?: (commandPrefix: string, secrets: Record<string, string>) => void;
  runtimeHandle?: SandboxRuntimePort["runtimeHandle"];
  runtimeCapabilities?: SandboxRuntimePort["runtimeCapabilities"];
  status?: SandboxRuntimePort["status"];
  renewLease?: SandboxRuntimePort["renewLease"];
  suspend?: SandboxRuntimePort["suspend"];
  resume?: SandboxRuntimePort["resume"];
  checkpoint?: SandboxRuntimePort["checkpoint"];

  constructor(
    context: NodeSessionSandboxContext,
    allocationId: string | undefined,
    private readonly options: NodeSessionSandboxOptions,
    private readonly onDestroyed: () => void,
  ) {
    this.context = context;
    const scope = () => scopeOf(this.context);
    this.core = new PortsSessionSandbox<SandboxPort>({
      compose: async () => {
        const adapter = options.adapter?.adapter ?? fromV1SandboxFactory<SandboxPort>({
          name: "node",
          create: ({ signal }) => options.createV1({ ...this.context, ...(allocationId === undefined ? {} : { allocationId }), signal }),
          ...(options.v1LeaseTtlMs === undefined ? {} : { leaseTtlMs: options.v1LeaseTtlMs }),
        });
        const { ports } = createSandboxPorts({ ...adapter, native: { ...adapter.native, storage: () => this.storagePort() } }, {
          // Storage is Node's own (native above), so the generic deps are never read.
          storage: {} as never,
          egress: {
            gateway: {
              endpoint: { url: options.relay()?.endpoint ?? "https://unavailable.invalid" },
              issueToken: async ({ scope: s, fence }) => {
                const relay = options.relay();
                if (relay === null || !nodeCredentialEgress(relay)) throw new Error(NO_CREDENTIAL_EGRESS);
                const execution = executionOfFence(fence);
                return issueSandboxRelayPass((claims) => relay.issue(claims), execution === undefined ? null
                  : { workspaceId: s.workspaceId, sessionId: s.sessionId, ...execution }, NODE_RELAY_PASS_TTL_MS);
              },
              authenticate: async () => null,
              handle: async () => new Response(`Credential egress is served by the control plane at ${EGRESS_RELAY_PATH}`, { status: 404 }),
            },
            channels: () => repositoryChannels(this.context.session.resources),
          },
        });
        return { ports };
      },
      executor: (runtime) => this.track(runtime),
      state: {
        load: async () => this.state,
        save: async (state) => { this.state = state; },
        clear: async () => { this.state = undefined; },
      },
      scope,
      plan: async ({ scope: s, stores }) => {
        const substitutions = await options.substitutions(this.context);
        if (substitutions.length > 0 && !nodeCredentialEgress(options.relay())) throw new Error(NO_CREDENTIAL_EGRESS);
        return {
          from: { image: this.image() },
          egress: sessionEgressPolicy(s, toLegacyHarnessEnvironmentConfig(this.context.environment).networking, substitutions),
          stores,
          outputs: { bindingId: `outputs:${s.sessionId}`, mountPath: "/mnt/session/outputs" },
          idleMs: options.idlePauseMs,
          labels: { workspaceId: s.workspaceId, sessionId: s.sessionId },
        };
      },
      // Restore points are the provider's (an E2B pause is the sandbox itself).
      resumeRef: async () => null,
      warn: (message) => options.warn(message, this.context),
      outputDurability: () => null,
      egressRenewMs: NODE_RELAY_PASS_TTL_MS / 2,
      keepAliveMs: options.adapter?.keepAliveMs ?? null,
      execution: () => {
        const fence = this.executionFence;
        return fence === undefined ? undefined
          : { executionId: fence.executionId, attemptId: fence.attemptId, ownerId: fence.ownerId, generation: fence.generation, expiresAt: fence.expiresAt };
      },
      isCurrent: async (execution) => {
        if (execution === undefined) return true;
        const fence = this.executionFence;
        return fence !== undefined && fence.attemptId === execution.attemptId && await options.isFenceActive(fence);
      },
      idle: {
        pauseMs: options.idlePauseMs,
        schedule: (delayMs) => this.scheduleIdle(delayMs),
        cancel: () => this.cancelIdle(),
      },
    });
  }

  /** The runner's view of this Session: context, its runtime generation and the execution attempt. */
  bind(input: { context: NodeSessionSandboxContext; runtimeGeneration?: string; executionFence?: SessionExecutionFence }): void {
    this.context = input.context;
    if (input.runtimeGeneration !== undefined) this.runtimeGeneration = input.runtimeGeneration;
    this.executionFence = input.executionFence;
  }

  /** Opens the sandbox: attach, else acquire; egress, then storage (design §0.1 steps 2-3). */
  async open(): Promise<void> {
    await this.core.mountSessionOutputs();
  }

  /** Execution end (design §0.1 step 7); the sandbox keeps running until the idle pause. */
  async endExecution(): Promise<void> {
    try {
      await this.core.endExecution();
    } finally {
      this.executionFence = undefined;
    }
  }

  /** A failed execution (design §0.0 rule 16): nothing published, the sandbox released. */
  async failExecution(): Promise<void> {
    try {
      await this.core.failExecution();
    } finally {
      this.executionFence = undefined;
    }
  }

  /** The idle timer fired (exposed for tests and the timer). */
  idlePause(): Promise<"paused" | "skipped"> {
    return this.core.idlePause();
  }

  exec(command: string, timeout?: number): Promise<string> { return this.core.exec(command, timeout); }
  readFile(path: string): Promise<string> { return this.core.readFile(path); }
  writeFile(path: string, content: string): Promise<string> { return this.core.writeFile(path, content); }
  writeFileBytes(path: string, bytes: Uint8Array): Promise<string> { return this.core.writeFileBytes(path, bytes); }
  startProcess(command: string) { return this.core.startProcess(command); }
  setEnvVars(env: Record<string, string>): Promise<void> { return this.core.setEnvVars(env); }
  spawnDuplexProcess(spec: SandboxDuplexProcessSpec): Promise<SandboxDuplexProcess> { return this.core.spawnDuplexProcess(spec); }
  renewActivityTimeout(): Promise<void> { return this.core.renewActivityTimeout(); }

  async resolveWorkspaceRoot(): Promise<string> {
    return (await (await this.core.runtime()).resolveWorkspaceRoot?.()) ?? DEFAULT_WORKSPACE_ROOT;
  }

  async destroy(): Promise<void> {
    this.cancelIdle();
    try {
      await this.core.destroy();
    } finally {
      this.live = null;
      this.onDestroyed();
    }
  }

  private image(): string {
    const adapter = this.options.adapter;
    if (adapter === undefined) return "v1";
    const environment = this.context.environment;
    return adapter.image(resolveSandboxImage(this.options.images ?? EMPTY_SANDBOX_IMAGE_CATALOG, environment.openma?.sandboxImage, environment.id));
  }

  private storagePort(): SandboxStoragePort<SandboxPort> {
    return {
      attach: async ({ runtime, fence, signal }) => {
        const executionFence = this.fenceOf(fence);
        await this.options.storage.attach({
          ...this.context, sandbox: runtime, runtimeGeneration: this.runtimeGeneration, signal,
          ...(executionFence === undefined ? {} : { executionFence }),
        });
      },
      sync: async ({ runtime, fence, reason }) => {
        // Node's Memory sync rebases the store directories: only at turn boundaries.
        if (reason === "interval" || reason === "checkpoint") return;
        // Without the attempt nothing may be written back (design §0.0 rule 10).
        const executionFence = this.fenceOf(fence);
        if (executionFence === undefined) return;
        await this.options.storage.synchronize({ ...this.context, sandbox: runtime, runtimeGeneration: this.runtimeGeneration, executionFence });
      },
      detach: async () => undefined,
    };
  }

  private fenceOf(fence: RuntimeResourceFence): SessionExecutionFence | undefined {
    const execution = executionOfFence(fence);
    const current = this.executionFence;
    return execution !== undefined && current !== undefined && current.attemptId === execution.attemptId ? current : undefined;
  }

  /** The core opened `runtime`: expose what it can do and replay command secrets. */
  private track(runtime: SandboxPort): SessionSandboxExecutor {
    if (this.live !== runtime) {
      this.live = runtime;
      for (const [prefix, secrets] of this.commandSecrets) runtime.registerCommandSecrets?.(prefix, secrets);
      this.expose(runtime);
    }
    return {
      exec: (command, timeout) => runtime.exec(command, timeout),
      readFile: (path) => runtime.readFile(path),
      writeFile: (path, content) => runtime.writeFile(path, content),
      writeFileBytes: async (path, bytes) => {
        if (runtime.writeFileBytes === undefined) throw new Error("The sandbox cannot write binary files");
        return runtime.writeFileBytes(path, bytes);
      },
      startProcess: async (command) => runtime.startProcess === undefined ? null : runtime.startProcess(command),
      spawnDuplexProcess: async (spec) => {
        if (!supportsDuplexProcess(runtime)) throw new Error("The sandbox cannot spawn duplex processes");
        return runtime.spawnDuplexProcess(spec);
      },
      setEnvVars: async (env) => { await runtime.setEnvVars?.(env); },
    };
  }

  private expose(runtime: SandboxPort): void {
    const opened = async () => this.core.runtime();
    this.readFileBytes = runtime.readFileBytes === undefined ? undefined
      : async (path) => {
          const current = await opened();
          if (current.readFileBytes === undefined) throw new Error("The sandbox cannot read binary files");
          return current.readFileBytes(path);
        };
    this.gitCheckout = runtime.gitCheckout === undefined ? undefined
      : async (repoUrl, options) => {
          const current = await opened();
          if (current.gitCheckout === undefined) throw new Error("The sandbox has no native git checkout");
          return current.gitCheckout(repoUrl, options);
        };
    this.registerCommandSecrets = runtime.registerCommandSecrets === undefined ? undefined
      : (prefix, secrets) => {
          this.commandSecrets.set(prefix, secrets);
          this.live?.registerCommandSecrets?.(prefix, secrets);
        };
    if (!supportsSandboxRuntime(runtime)) {
      this.runtimeHandle = this.runtimeCapabilities = this.status = this.renewLease = undefined;
      this.suspend = this.resume = this.checkpoint = undefined;
      return;
    }
    const port = () => this.live as (SandboxPort & SandboxRuntimePort) | null;
    this.runtimeHandle = () => (port() ?? runtime).runtimeHandle();
    this.runtimeCapabilities = () => (port() ?? runtime).runtimeCapabilities();
    this.status = async () => port()?.status() ?? "unknown";
    this.renewLease = async (input) => { await port()?.renewLease(input); };
    this.suspend = async (input) => (port() ?? runtime).suspend(input);
    this.resume = async (checkpoint) => (port() ?? runtime).resume(checkpoint);
    this.checkpoint = async (input) => (port() ?? runtime).checkpoint(input);
  }

  private scheduleIdle(delayMs: number): void {
    this.cancelIdle();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      void this.core.idlePause().catch((error: unknown) => {
        this.options.warn(`sandbox_idle_pause_failed error=${error instanceof Error ? error.message : String(error)}`, this.context);
      });
    }, delayMs);
    this.idleTimer.unref?.();
  }

  private cancelIdle(): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }
}

function scopeOf(context: NodeSessionSandboxContext): RuntimeResourceScope {
  return { workspaceId: context.workspaceId, environmentId: context.environment.id, sessionId: context.session.id, workId: context.session.id };
}

function keyOf(workspaceId: string, sessionId: string): string {
  return `${workspaceId}\u0000${sessionId}`;
}
