import type { Tracer } from "@open-managed-agents/observability";
import { traceSandboxOperation } from "@open-managed-agents/session-runtime";
import { configureNodeNativeStorage, type NodeNativeBucket } from "./work-finalization-host/native-storage.js";
// The Node Session sandbox (research/sandbox-sdk-v2-design.md §0.0 rule 15,
// §0.7): composition only. The lifecycle is the shared core
// (PortsSessionSandbox, @open-managed-agents/session-runtime); this module
// injects its Ports and the Node infrastructure:
//   - lifecycle: the deployment's Sandbox SDK v2 adapter when it has one
//     (SANDBOX_PROVIDER=e2b: the native E2B adapter); else, when the
//     provider exports a v1 SandboxProviderPort, fromV1SandboxProvider, which
//     finds the sandbox again by its handle through the provider and starts
//     a new one from its snapshot (design §0.0b A.8); else the bare v1
//     factory through fromV1SandboxFactory, which only finds sandboxes this
//     process holds. New sandboxes always come from the managed builder
//     (images, prepared bases, allocation);
//   - environment cache: only with a v2 adapter that can snapshot;
//   - storage: Node's Memory Store and Session output implementations as
//     the storage Port; written back at turn end under the execution fence,
//     never at the interval (they rebase, which would overwrite files the
//     agent is editing);
//   - egress: createForwarderEgress to the existing /v1/oma/egress ingress
//     with a relay pass bound to the execution attempt; attached
//     repositories are platform channels under limited networking;
//   - the handle record (handle, pause point, latest snapshot) in SQL KV, so
//     it survives a restart (in process memory only for checkpoint_restore
//     allocations, which are per allocation); the idle pause on a process
//     timer.
// The facade is what the runner and the tools see (a SandboxPort). Calls the
// core does not own (bytes reads, git checkout, command secrets, the v1
// runtime Port the runner probes and heartbeats) go to the live runtime
// once it is open, and exist only when that runtime has them.

import {
  DEFAULT_WORKSPACE_ROOT,
  SANDBOX_LEASE_MARGIN_MS,
  assertLeaseCoversIdle,
  resolveSandboxImage,
  EMPTY_SANDBOX_IMAGE_CATALOG,
  supportsDuplexProcess,
  supportsSandboxRuntime,
  supportsSessionOutputMount,
  type SandboxManagedProcessSpec,
  type SandboxManagedProcessHandle,
  type SandboxManagedProcessPort,
  type SandboxDuplexProcess,
  type SandboxDuplexProcessSpec,
  type SandboxFactoryContext,
  type SandboxFactoryEnv,
  type SandboxImageCatalog,
  type SandboxProviderPort,
  type SandboxPort,
  type SandboxRuntimePort,
  type SandboxStoragePort,
  type Substitution,
} from "@open-managed-agents/sandbox";
import type { RuntimeResourceFence, RuntimeResourceScope } from "@open-managed-agents/runtime-resource-contract";
import {
  createSandboxPorts,
  fromV1SandboxFactory,
  fromV1SandboxProvider,
  repositoryChannels,
  sessionEgressPolicy,
  type SandboxAdapterPort,
} from "@open-managed-agents/sandbox-port-kit";
import {
  PortsSessionSandbox,
  executionOfFence,
  recordedHandle,
  stateVersion,
  type SessionSandboxExecutor,
  type SessionSandboxState,
} from "@open-managed-agents/session-runtime";
import type { SessionExecutionFence } from "@open-managed-agents/session-runtime-contract";
import type { Environment, Session } from "@open-managed-agents/managed-agents-application";
import { EGRESS_RELAY_PATH } from "@open-managed-agents/managed-credential-resolver";
import { UNFENCED_SANDBOX_TOKEN, type SessionExecutionAttemptRef } from "@open-managed-agents/sandbox-gateway";
import type { SessionLifecycleCommandPort } from "@open-managed-agents/session-runtime-contract";
import { toLegacyHarnessEnvironmentConfig } from "./node-managed-agent-codec.js";
import { sandboxOrphanReclaimMs, startSandboxOrphanReclaim } from "./node-sandbox-orphan-reclaim.js";
import { prepareEnvironmentBuildSandbox, type NodeEnvironmentCache, type EnvironmentCacheSetup } from "./environment-cache.js";
import { SqlSessionSandboxRecords, type NodeSessionSandboxRecords } from "./node-session-sandbox-records.js";
import type { SqlClient } from "@open-managed-agents/sql-client";

export { DEFAULT_SANDBOX_IDLE_PAUSE_MS, sandboxIdlePauseMs } from "@open-managed-agents/session-runtime";
import { DEFAULT_SANDBOX_IDLE_PAUSE_MS } from "@open-managed-agents/session-runtime";

/** SANDBOX_SNAPSHOT_INTERVAL_MS (a positive integer of milliseconds); unset = the core default. */
export function sandboxSnapshotIntervalMs(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const ms = Number(value);
  if (!Number.isInteger(ms) || ms <= 0) throw new Error(`SANDBOX_SNAPSHOT_INTERVAL_MS must be a positive integer of milliseconds, got ${JSON.stringify(value)}`);
  return ms;
}

/** Existing Work claim authority; no SessionExecution lease is fabricated. */
export interface NodeSandboxWorkAuthority {
  attempt: SessionExecutionAttemptRef;
  isCurrent(): Promise<boolean>;
  token(sandbox: object | string): Promise<string>;
  /** Existing issued holder hash, resolved after bootstrap; never issues a token. */
  holderHash?(): string | undefined;
}

export interface NodeWorkStorageInput extends NodeSessionSandboxContext {
  sandbox: SandboxPort;
  runtimeGeneration: string;
  workAuthority: Pick<NodeSandboxWorkAuthority, "attempt" | "isCurrent"> & { holderHash?: string };
}

export interface NodeSessionSandboxContext {
  workspaceId: string;
  session: Session;
  environment: Environment;
}

/** A provider module's v1 SandboxProviderPort; `name` is its runtimeHandle().provider. */
export interface NodeSessionSandboxProvider {
  name: string;
  provider: SandboxProviderPort<SandboxPort & SandboxRuntimePort>;
}

/** A deployment's Sandbox SDK v2 adapter for Session sandboxes (design §0.2). */
export interface NodeSessionSandboxAdapter {
  nativeWorkBucket?: NodeNativeBucket;
  /** GET-only provider attachment for finalization; no resume or renewal. */
  connectWorkReadonly?(runtimeId: string): Promise<SandboxPort & SandboxRuntimePort>;
  adapter: SandboxAdapterPort<SandboxPort>;
  /** plan.from.image: the Environment's catalog image, else the deployment default. */
  image(catalogImage: { alias: string; reference: string } | undefined): string;
  /** keepAlive at exec boundaries this often (below the provider's lease). */
  keepAliveMs: number;
}

export interface NodeSessionSandboxOptions {
  tracer?: Tracer;
  /** Omitted: the v1 provider bridge when `provider` is given, else the v1 factory (`createV1`) through the v1 bridge. */
  adapter?: NodeSessionSandboxAdapter;
  /** The v1 provider and the factory context / env it is called with. */
  provider?: NodeSessionSandboxProvider & {
    context(context: NodeSessionSandboxContext): SandboxFactoryContext;
    env: SandboxFactoryEnv;
  };
  /** The handle records survive the process (design §0.0b A.8): SQL kv_entries. */
  sql?: SqlClient;
  /** Other handle records (tests); with neither, process memory. */
  records?: NodeSessionSandboxRecords;
  /** SANDBOX_SNAPSHOT_INTERVAL_MS: tool-call-gap snapshots at most this often. */
  snapshotIntervalMs?: number;
  /** Lifecycle progress (snapshots, restores, idle pause). */
  info?(message: string, context: NodeSessionSandboxContext): void;
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
      authorizeMemoryMutation?(): Promise<boolean>;
      signal: AbortSignal;
    }): Promise<void>;
    /** Work turn barrier; separate authority, never a fabricated MA fence. */
    synchronizeWork?(input: NodeWorkStorageInput): Promise<void>;
    /** turn_end / before_stop under the execution fence: Memory write-back and outputs. */
    synchronize(input: NodeSessionSandboxContext & {
      sandbox: SandboxPort;
      runtimeGeneration: string;
      executionFence: SessionExecutionFence;
    }): Promise<void>;
  };
  /** The Session's sandbox substitutions: Vault environment_variable / cap_cli
   * credentials reach the sandbox only as placeholders, which the relay
   * substitutes (design §0.5, §8.8). */
  substitutions(context: NodeSessionSandboxContext): Promise<Substitution[]>;
  /** Shared token authority, independent of Vault/relay configuration. */
  token(attempt: SessionExecutionAttemptRef, harness: string | null | undefined, sandbox?: object | string): Promise<string>;
  /** Sandbox token issuer (#561) for an attempt — `harness` is the Session
   * agent's harness name, which fixes the scope — and the control plane's
   * public HTTPS origin; null = not configured. */
  relay(): { issue(attempt: SessionExecutionAttemptRef, harness: string | null | undefined, sandbox?: object | string): Promise<string>; endpoint: string } | null;
  isFenceActive(fence: SessionExecutionFence): Promise<boolean>;
  idlePauseMs: number;
  warn(message: string, context: NodeSessionSandboxContext): void | Promise<void>;
  /** Warm the sandbox at Session creation (design §0.0 rule 10); off under
   * checkpoint_restore, whose sandboxes are per allocation. */
  warmAtCreate?: boolean;
  /** The factory's mounts are fixed by its first exec
   * (SandboxFactoryCapabilities.mountsFixedAtCreate): mount the Session
   * outputs right after createV1, before the warm-up marker or the egress
   * step's exec, so the storage Port's attach finds them already mounted. */
  mountOutputsAtCreate?: boolean;
  /** Present only with a v2 adapter that can snapshot an environment. */
  environmentCache?: NodeEnvironmentCache;
  /** Writes a session.warning to the Session's event stream now. */
  sessionWarning?(context: NodeSessionSandboxContext, source: string, message: string): Promise<void>;
}

/** Node's only egress path for Vault sandbox credentials: the in-sandbox
 * forwarder to the control plane's relay, which needs the pass signer and
 * an HTTPS origin the sandbox can reach. Without it a Session holding such
 * credentials is refused at create (400) and never opened: placeholders
 * would leave the sandbox unsubstituted (design §0.7, §8.0). */
export function nodeCredentialEgress(relay: ReturnType<NodeSessionSandboxOptions["relay"]>): boolean {
  return relay !== null && relay.endpoint.startsWith("https://");
}

type ManagementDiscovery = { owner: NodeSessionSandbox; pending: ReturnType<NodeSessionSandbox["recoverManagedProcessSlot"]> };

const NO_CREDENTIAL_EGRESS = "Vault credential egress requires PLATFORM_ROOT_SECRET and the ordinary HTTPS PUBLIC_BASE_URL";

/** One facade per runner allocation, found again by the runner's hooks. */
export class NodeSessionSandboxes {
  private readonly current = new Map<string, NodeSessionSandbox>();
  /** Warm-ups at Session creation (in flight or done), until the first build adopts them. */
  private readonly warmed = new Map<string, Promise<SessionSandboxState | undefined>>();
  /** v1 runtimes this process holds, shared by every facade's bridge. */
  private readonly held = new Map<string, SandboxPort>();
  /** Only unresolved discovery RPCs; shared across claim facades, removed on settle. */
  private readonly managementDiscoveries = new Map<string, ManagementDiscovery>();

  private restoreCheckpoint?: (physical: Awaited<ReturnType<NodeSessionSandbox["captureWork"]>>) => Promise<void>;
  configureWorkCheckpointRestore(restore: (physical: Awaited<ReturnType<NodeSessionSandbox["captureWork"]>>) => Promise<void>): void { this.restoreCheckpoint = restore; }
  async restoreWorkCheckpoint(sandbox: NodeSessionSandbox, attempt: SessionExecutionAttemptRef): Promise<void> {
    await sandbox.restoreWorkCheckpoint(async () => {
      if (!this.restoreCheckpoint) throw new Error("Work checkpoint restore is not configured");
      await this.restoreCheckpoint(await sandbox.captureWork(attempt));
    });
  }

  constructor(private readonly options: NodeSessionSandboxOptions) {
    // Design §0.0b A.10: the provider's own reclaim must outlast the idle pause.
    if (options.adapter === undefined && options.provider !== undefined && options.v1LeaseTtlMs !== undefined) {
      assertLeaseCoversIdle("OMA_SANDBOX_LEASE_TTL_SEC", options.v1LeaseTtlMs, options.idlePauseMs);
    }
  }

  /** Session create admission (SandboxCredentialAdmission.substitutes). */
  credentialEgress(): boolean {
    return nodeCredentialEgress(this.options.relay());
  }

  build(input: NodeSessionSandboxContext & {
    allocationId?: string;
    runtimeGeneration?: string;
    executionFence?: SessionExecutionFence;
    workAuthority?: NodeSandboxWorkAuthority;
  }): NodeSessionSandbox {
    const key = keyOf(input.workspaceId, input.session.id);
    const context = { workspaceId: input.workspaceId, session: input.session, environment: input.environment };
    const warmed = input.allocationId === undefined ? this.warmed.get(key) : undefined;
    this.warmed.delete(key);
    const sandbox: NodeSessionSandbox = new NodeSessionSandbox(context, input.allocationId, this.options, this.held, () => {
      if (this.current.get(key) === sandbox) this.current.delete(key);
    }, warmed?.catch(() => undefined), undefined, this.managementDiscoveries);
    sandbox.bind({
      context,
      ...(input.runtimeGeneration === undefined ? {} : { runtimeGeneration: input.runtimeGeneration }),
      ...(input.executionFence === undefined ? {} : { executionFence: input.executionFence }),
      ...(input.workAuthority === undefined ? {} : { workAuthority: input.workAuthority }),
    });
    this.current.set(key, sandbox);
    return sandbox;
  }

  /** Exact reconnect only: no core.open(), storage hydration, token issuance or
   * provider allocation. The caller supplies server-read context and authority. */
  async reconnectWork(input: NodeSessionSandboxContext & {
    workAuthority: NodeSandboxWorkAuthority;
    sourceAttempt: SessionExecutionAttemptRef;
    terminal: boolean;
  }): Promise<NodeWorkStorageInput & { handle: NonNullable<ReturnType<typeof recordedHandle>> }> {
    const records = this.options.records ?? (this.options.sql ? new SqlSessionSandboxRecords(this.options.sql) : undefined);
    const state = await records?.load(input.workspaceId, input.session.id);
    const authority = input.workAuthority;
    const holderHash = authority.holderHash?.();
    if (!state || state.phase !== "running" || !holderHash || !await authority.isCurrent()) throw new Error("Current recorded Work runtime required");
    // E2B currently supplies the only trusted process-bound holder locator.
    // A local directory/provider.resume is not a process identity proof.
    const adapter = this.options.adapter?.adapter;
    if (state.handle.provider !== "e2b" || adapter?.name !== "e2b") throw new Error("Trusted Work process reconnect unsupported by provider");
    const read = this.options.adapter?.connectWorkReadonly;
    if (!read) throw new Error("Trusted Work read-only reconnect unsupported by provider");
    const attachedRuntime = await read(state.handle.runtimeId);
    if (this.options.adapter?.nativeWorkBucket) configureNodeNativeStorage(attachedRuntime,this.options.adapter.nativeWorkBucket);
    const attachedHandle = attachedRuntime.runtimeHandle();
    if (attachedHandle.provider !== state.handle.provider || attachedHandle.runtimeId !== state.handle.runtimeId) throw new Error("Work reconnect returned a different runtime");
    const runtime = attachedRuntime as SandboxPort & {
      inspectManagedProcessSlot?(): Promise<{sandboxId:string;id:string;epoch:string;pid:number;status:string;holderHash?:string;identity:{workspaceId:string;sessionId:string;workId:string;attemptId:string}}>;
      restoreManagedProcess?(locator: unknown): Promise<SandboxManagedProcessHandle>;
    };
    if (!runtime.inspectManagedProcessSlot || !runtime.restoreManagedProcess) throw new Error("Trusted Work process reconnect unsupported by runtime");
    const inspect = runtime.inspectManagedProcessSlot.bind(runtime);
    const locator = await inspect();
    const source = input.sourceAttempt;
    // Re-publishing an older generation's committed terminal from a relaunched
    // attempt: that attempt restored the canonical checkpoint taken at the
    // terminal, so its own live, holder-bound process is the proof. Never for
    // finalization (non-terminal), never for a different Work.
    const republish = input.terminal && source.generation < authority.attempt.generation
      && locator.identity.attemptId === authority.attempt.attemptId && locator.status === "running" && locator.holderHash === holderHash;
    if (source.executionId !== authority.attempt.executionId || source.generation > authority.attempt.generation
      || !locator.id || !locator.epoch || !Number.isSafeInteger(locator.pid) || locator.pid <= 0
      || !["running","exited"].includes(locator.status) || locator.sandboxId !== state.handle.runtimeId || locator.identity.workspaceId !== input.workspaceId
      || locator.identity.sessionId !== input.session.id || locator.identity.workId !== source.executionId
      || !/^[a-f0-9]{64}$/.test(locator.holderHash ?? "")
      || (!republish && (locator.identity.attemptId !== source.attemptId
        || (!input.terminal && locator.status !== "running")
        || (source.generation === authority.attempt.generation && locator.holderHash !== holderHash)
        || (source.generation !== authority.attempt.generation && (!input.terminal || locator.status !== "exited"))))) {
      throw new Error("Work process locator does not prove the authorized source attempt");
    }
    const handle = await runtime.restoreManagedProcess(locator);
    if (handle.id !== locator.id || handle.pid !== locator.pid) throw new Error("Restored Work process differs from locator");
    const fingerprint = (l: typeof locator) => JSON.stringify([l.sandboxId,l.id,l.epoch,l.pid,l.holderHash,l.identity]);
    const isCurrent = async () => {
      if (!await authority.isCurrent() || authority.holderHash?.() !== holderHash) return false;
      const saved = await records!.load(input.workspaceId,input.session.id);
      if (JSON.stringify(saved) !== JSON.stringify(state)) return false;
      const latest = await inspect();
      return fingerprint(latest) === fingerprint(locator)
        && (republish ? latest.status === "running"
          : input.terminal ? source.generation === authority.attempt.generation || latest.status === "exited" : latest.status === "running") && await authority.isCurrent();
    };
    if (!await isCurrent()) throw new Error("Work reconnect authority changed");
    const generation = (await runtime.readFile("/tmp/.oma-warm")).trim();
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(generation)) throw new Error("Recorded Work physical generation unavailable");
    return {...input,sandbox:runtime,runtimeGeneration:generation,handle:state.handle,
      workAuthority:{attempt:authority.attempt,holderHash,isCurrent}};
  }

  async synchronizeReconnectedWork(input: NodeWorkStorageInput): Promise<void> {
    if (!await input.workAuthority.isCurrent()) throw new Error("Work reconnect authority lost");
    if (!this.options.storage.synchronizeWork) throw new Error("Work storage synchronization unsupported");
    await this.options.storage.synchronizeWork(input);
    if (!await input.workAuthority.isCurrent()) throw new Error("Work reconnect authority lost");
  }

  /** Session creation (design §0.0 rule 10): acquire the sandbox and keep
   * its handle record for the runner's first build; no token, no storage. */
  async warm(context: NodeSessionSandboxContext): Promise<void> {
    const key = keyOf(context.workspaceId, context.session.id);
    if (this.current.has(key) || this.warmed.has(key)) return;
    let state: SessionSandboxState | undefined;
    const sandbox = new NodeSessionSandbox(context, undefined, this.options, this.held, () => undefined, undefined, (next) => { state = next; });
    // A build that starts meanwhile awaits this and adopts the sandbox.
    const warming = sandbox.warm().then(() => state);
    this.warmed.set(key, warming);
    await warming;
  }

  /** The Session ended (archived or deleted): its sandbox, a warmed one
   * included, is released and its snapshots discarded (design §0.1 step 10). */
  async releaseSession(context: NodeSessionSandboxContext): Promise<void> {
    const key = keyOf(context.workspaceId, context.session.id);
    const warming = this.warmed.get(key);
    this.warmed.delete(key);
    const state = await warming?.catch(() => undefined);
    await new NodeSessionSandbox(context, undefined, this.options, this.held, () => undefined, state === undefined ? undefined : Promise.resolve(state)).release();
  }

  /** `runtime` plus the warm-up at Session creation and the release of the
   * Session's sandbox when it stops. */
  warmingLifecycle(runtime: SessionLifecycleCommandPort, sandboxMode: (session: Session) => Promise<"none" | "sandbox">): SessionLifecycleCommandPort {
    if (this.options.warmAtCreate !== true) return runtime;
    return {
      sessionStarted: async (input) => {
        await runtime.sessionStarted(input);
        if (await sandboxMode(input.session) === "none") return;
        void this.warm(input).catch((error: unknown) => this.options.warn(`sandbox_warm_failed error=${error instanceof Error ? error.message : String(error)}`, input));
      },
      sessionStopped: async (input) => {
        await runtime.sessionStopped(input);
        if (await sandboxMode(input.session) === "none") return;
        const context = { workspaceId: input.workspaceId, session: input.session, environment: { id: input.session.environmentId } as Environment };
        await this.releaseSession(context).catch((error: unknown) => this.options.warn(`sandbox_release_failed error=${error instanceof Error ? error.message : String(error)}`, context));
      },
    };
  }

  /** The orphan reclaim timer (design §0.0 rule 14), with a v2 adapter only; returns its stop. */
  startOrphanReclaim(
    intervalMs: string | undefined,
    findSession: (labels: { workspaceId: string; sessionId: string }) => Promise<{ archivedAt: string | null } | null>,
    log: { warn(fields: Record<string, unknown>, message: string): void },
    options: { compareRecordedHandle?: boolean } = {},
  ): () => void {
    const adapter = this.options.adapter;
    if (adapter === undefined) return () => undefined;
    // checkpoint_restore allocations keep their record in memory, so the
    // durable Session record cannot prove that a labelled sandbox is replaced.
    const records = options.compareRecordedHandle !== true ? undefined
      : this.options.records ?? (this.options.sql ? new SqlSessionSandboxRecords(this.options.sql) : undefined);
    return startSandboxOrphanReclaim({
      lifecycle: adapter.adapter.lifecycle, findSession, intervalMs: sandboxOrphanReclaimMs(intervalMs),
      // Only a record that names a sandbox (running/paused) identifies a
      // replaced one; other phases are not compared (an in-flight open is
      // further protected by the shared minimum age).
      ...(records === undefined ? {} : { recordedHandle: async (labels: { workspaceId: string; sessionId: string }) => {
        const state = await records.load(labels.workspaceId, labels.sessionId);
        return state === undefined ? undefined : recordedHandle(state);
      } }),
      warn: (fields, message) => log.warn(fields, message),
    });
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
  private workAuthority: NodeSandboxWorkAuthority | undefined;
  private managedWorkProcess?: {handle: SandboxManagedProcessHandle; authority: NodeSandboxWorkAuthority; runtime: SandboxPort};
  private runtimeGeneration = "";
  /** Unsettled native calls stay single-flight; a caller timeout cannot cancel them. */
  private workRenewing: Promise<void> | undefined;
  private workSynchronizing: Promise<void> | undefined;
  /** The core open plan's warm-marker generation, never a Work claim generation. */
  private physicalGeneration = "";
  private acquiredWorkRuntime = false;
  private restoringWorkCheckpoint?: Promise<void>;
  async restoreWorkCheckpoint(restore: () => Promise<void>): Promise<void> {
    if (!this.acquiredWorkRuntime) return;
    await (this.restoringWorkCheckpoint ??= restore().then(() => { this.acquiredWorkRuntime = false; })
      .finally(() => { this.restoringWorkCheckpoint = undefined; }));
  }
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
    held: Map<string, SandboxPort>,
    private readonly onDestroyed: () => void,
    initialState?: Promise<SessionSandboxState | undefined>,
    onSaved?: (state: SessionSandboxState) => void,
    private readonly managementDiscoveries = new Map<string, ManagementDiscovery>(),
  ) {
    this.context = context;
    let adopting = initialState;
    const scope = () => ({ ...scopeOf(this.context), ...(this.workAuthority === undefined ? {} : { workId: this.workAuthority.attempt.executionId }) });
    // checkpoint_restore allocations are per allocation: their record stays in memory.
    const records = allocationId !== undefined ? undefined
      : options.records ?? (options.sql === undefined ? undefined : new SqlSessionSandboxRecords(options.sql));
    const create = async ({ signal }: { signal: AbortSignal }) => {
      const sandbox = await options.createV1({ ...this.context, ...(allocationId === undefined ? {} : { allocationId }), signal });
      if (options.mountOutputsAtCreate === true && supportsSessionOutputMount(sandbox)) {
        await sandbox.mountSessionOutputs({ tenantId: this.context.workspaceId, sessionId: this.context.session.id });
      }
      return sandbox;
    };
    const provider = allocationId === undefined ? options.provider : undefined;
    this.core = new PortsSessionSandbox<SandboxPort>({
      tracer: options.tracer,
      compose: async () => {
        const adapter = options.adapter?.adapter ?? (provider !== undefined
          ? fromV1SandboxProvider<SandboxPort & SandboxRuntimePort>({
              name: provider.name,
              provider: provider.provider,
              env: provider.env,
              context: () => provider.context(this.context),
              create: async (input) => {
                const sandbox = await create(input);
                if (!supportsSandboxRuntime(sandbox)) throw new Error(`${provider.name}: the sandbox has no runtime lifecycle to find it again`);
                return sandbox;
              },
              leaseTtlMs: options.v1LeaseTtlMs ?? options.idlePauseMs + SANDBOX_LEASE_MARGIN_MS,
              // Orphans are found through the persisted records, not by label.
              list: async () => [],
              readiness: { timeoutMs: 120_000, pollMs: 500 },
            }) as unknown as SandboxAdapterPort<SandboxPort>
          : fromV1SandboxFactory<SandboxPort>({
              name: "node",
              create,
              ...(options.v1LeaseTtlMs === undefined ? {} : { leaseTtlMs: options.v1LeaseTtlMs }),
              held,
            }));
        const lifecycle = adapter.lifecycle;
        const trackedAdapter = {...adapter,lifecycle:{...lifecycle,
          checkpoint: (input: Parameters<typeof lifecycle.checkpoint>[0]) => lifecycle.checkpoint(input),
          attach: async (input: Parameters<typeof lifecycle.attach>[0]) => {
            const result = await lifecycle.attach(input);
            if (result !== "gone") this.acquiredWorkRuntime = false;
            return result;
          },
          acquire: async (input: Parameters<typeof lifecycle.acquire>[0]) => {
            const result = await lifecycle.acquire(input);
            if (result !== "gone") this.acquiredWorkRuntime = true;
            return result;
          },
          resume: async (input: Parameters<typeof lifecycle.resume>[0]) => {
            const result = await lifecycle.resume(input);
            if (result !== "gone" && input.ref.kind === "snapshot") this.acquiredWorkRuntime = true;
            return result;
          },
        }};
        const { ports } = createSandboxPorts({ ...trackedAdapter, native: { ...adapter.native, storage: () => this.storagePort() } }, {
          // Storage is Node's own (native above), so the generic deps are never read.
          storage: {} as never,
          egress: {
            gateway: {
              endpoint: { url: options.relay()?.endpoint ?? "https://unavailable.invalid" },
              issueToken: async ({ attempt, sandbox }) => {
                // Warm-up (no attempt): a value every gateway refuses.
                if (attempt === null) return UNFENCED_SANDBOX_TOKEN;
                return this.workAuthority !== undefined
                  ? this.workAuthority.token(sandbox ?? this)
                  : options.token(attempt, this.context.session.agent.openma?.harness, sandbox);
              },
              authenticate: async () => null,
              handle: async () => new Response(`Credential egress is served by the control plane at ${EGRESS_RELAY_PATH}`, { status: 404 }),
            },
            channels: () => repositoryChannels(this.context.session.resources),
          },
        });
        return { ports };
      },
      executor: (runtime) => {
        if (this.workAuthority !== undefined && (!("startManagedProcess" in runtime) || typeof runtime.startManagedProcess !== "function")) {
          throw new Error("Sandbox lacks safe native management launch");
        }
        return this.track(runtime);
      },
      state: {
        load: async () => {
          if (adopting !== undefined) { const warmed = await adopting; adopting = undefined; this.state ??= warmed; }
          if (records === undefined) return this.state;
          return this.state = await records.load(this.context.workspaceId, this.context.session.id);
        },
        save: async (state, expected) => {
          if (adopting !== undefined) { const warmed = await adopting; adopting = undefined; this.state ??= warmed; }
          const won = records === undefined
            ? stateVersion(this.state) === expected
            : await records.save(this.context.workspaceId, this.context.session.id, state, expected);
          if (!won) return false;
          this.state = state;
          onSaved?.(state);
          return true;
        },
      },
      scope,
      plan: async ({ scope: s, generation, stores }) => {
        this.physicalGeneration = generation;
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
      // The latest snapshot is the handle record's; Node publishes none of its own.
      resumeRef: async () => null,
      ...(options.snapshotIntervalMs === undefined ? {} : { snapshotIntervalMs: options.snapshotIntervalMs }),
      warn: (message) => options.warn(message, this.context),
      info: (message) => options.info?.(message, this.context),
      outputDurability: () => null,
      // The sandbox token dies with its attempt; nothing to renew on a timer.
      egressRenewMs: null,
      keepAliveMs: options.adapter?.keepAliveMs ?? null,
      execution: () => {
        if (this.workAuthority !== undefined) return this.workAuthority.attempt;
        const fence = this.executionFence;
        return fence === undefined ? undefined
          : { executionId: fence.executionId, attemptId: fence.attemptId, ownerId: fence.ownerId, generation: fence.generation, expiresAt: fence.expiresAt };
      },
      isCurrent: async (execution) => {
        if (this.workAuthority !== undefined) {
          const held = this.workAuthority.attempt;
          return execution?.executionId === held.executionId && execution.attemptId === held.attemptId
            && execution.ownerId === held.ownerId && execution.generation === held.generation && await this.workAuthority.isCurrent();
        }
        if (execution === undefined) return this.executionFence === undefined;
        const fence = this.executionFence;
        return fence !== undefined && fence.attemptId === execution.attemptId && await options.isFenceActive(fence);
      },
      idle: {
        pauseMs: options.idlePauseMs,
        schedule: (delayMs, version) => this.scheduleIdle(delayMs, version),
        cancel: () => this.cancelIdle(),
      },
      ...(options.adapter === undefined || options.environmentCache === undefined ? {} : {
        environmentCache: (() => {
          const cache = options.environmentCache!.forSession(
          () => this.environmentSetup(),
          (warning) => {
            const message = `${warning.reason}: ${warning.message}`;
            options.warn(`environment_cache ${message}`, this.context);
            const context = this.context;
            void options.sessionWarning?.(context, "environment_cache", message).catch((error: unknown) => {
              options.warn(`session_warning_failed error=${error instanceof Error ? error.message : String(error)}`, context);
            });
          },
          );
          return {...cache,acquire:async (...args: Parameters<typeof cache.acquire>) => {
            const acquired = await cache.acquire(...args);
            if (acquired !== "gone") this.acquiredWorkRuntime = true;
            return acquired;
          }};
        })(),
      }),
    });
  }

  /** The runner's view of this Session: context, its runtime generation and the execution attempt. */
  bind(input: { context: NodeSessionSandboxContext; runtimeGeneration?: string; executionFence?: SessionExecutionFence; workAuthority?: NodeSandboxWorkAuthority }): void {
    if (input.executionFence !== undefined && input.workAuthority !== undefined) throw new Error("Sandbox requires exactly one execution authority");
    this.workAuthority = input.workAuthority;
    this.context = input.context;
    if (input.runtimeGeneration !== undefined) this.runtimeGeneration = input.runtimeGeneration;
    this.executionFence = input.executionFence;
  }

  /** Opens the sandbox: attach, else acquire; egress, then storage (design §0.1 steps 2-3). */
  async open(): Promise<void> {
    await traceSandboxOperation(this.options.tracer, "node.sandbox.open", {
      "session.id": this.context.session.id, "work.id": this.workAuthority?.attempt.executionId,
      "execution.generation": this.workAuthority?.attempt.generation,
    }, async () => this.core.mountSessionOutputs());
  }

  warm(): Promise<void> { return this.core.warm(); }

  /** The Environment's setup succeeded here: the cache may snapshot it. */
  environmentPrepared(): void { this.core.environmentPrepared(); }

  async prepareWorkEnvironment(options: { installedHarnesses?: string; pipIndexUrl?: string } = {}) {
    const setup = this.environmentSetup();
    if (!setup) throw new Error("Work Environment setup is unavailable");
    const prepared = await prepareEnvironmentBuildSandbox(this, setup, this.context.session.id,
      { ...options, agent: this.context.session.agent.openma?.acp?.agent,
        assertCurrent: async () => { if (this.workAuthority && !await this.workAuthority.isCurrent()) throw new Error("Work claim lost during Environment setup"); } });
    if (this.workAuthority && !await this.workAuthority.isCurrent()) throw new Error("Work claim lost during Environment setup");
    this.environmentPrepared();
    return prepared;
  }

  /** Execution end (design §0.1 step 7); the sandbox keeps running until the idle pause. */
  async endExecution(): Promise<void> {
    const authority = this.workAuthority;
    try {
      if (authority !== undefined && !await this.isCurrentWork(authority)) throw new Error("Work claim lost before finalization");
      await this.core.endExecution();
      if (authority !== undefined && !await this.isCurrentWork(authority)) throw new Error("Work claim lost during finalization");
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
  async workToken(): Promise<string> {
    const authority = this.workAuthority;
    if (authority === undefined || !await authority.isCurrent()) throw new Error("Current Work claim required");
    return authority.token(await this.core.runtime());
  }
  /** Management launch only; native adapter must replace env before exec. */
  async startManagedProcess(spec: SandboxManagedProcessSpec): Promise<SandboxManagedProcessHandle> {
    const authority = this.workAuthority;
    if (authority === undefined || !await authority.isCurrent()) throw new Error("Current Work claim required for management launch");
    if (this.managedWorkProcess?.authority === authority) throw new Error("Work management process already launched for this attempt");
    const runtime = await this.core.runtime();
    if (!("startManagedProcess" in runtime) || typeof runtime.startManagedProcess !== "function") throw new Error("Sandbox lacks safe native management launch");
    if (authority !== this.workAuthority || !await authority.isCurrent()) throw new Error("Work claim lost before launch");
    const identity = { workspaceId: authority.attempt.workspaceId, sessionId: authority.attempt.sessionId,
      workId: authority.attempt.executionId, attemptId: authority.attempt.attemptId };
    const handle = await (runtime as SandboxPort & { startManagedProcess(spec: SandboxManagedProcessSpec, trustedIdentity: typeof identity): Promise<SandboxManagedProcessHandle> }).startManagedProcess(spec, identity);
    // Until returned, this wrapper owns cleanup even when authority lookup throws.
    let transferred = false;
    try {
      if (authority !== this.workAuthority || !await authority.isCurrent()) throw new Error("Work claim lost during launch");
      this.managedWorkProcess = {handle,authority,runtime};
      transferred = true;
      return handle;
    } finally {
      if (!transferred) await handle.kill("SIGKILL");
    }
  }
  /** E2B's trusted Files management channel only; not a general sandbox Port.
   * Discovery grants no kill authority. The dispatcher must prove the located
   * Work attempt is obsolete and use its ordinary exact-handle handoff. */
  async recoverManagedProcessSlot(): Promise<Awaited<ReturnType<NodeSessionSandbox["discoverManagedProcessSlot"]>>> {
    // Do not cancel or duplicate an uncancellable Files RPC. Its late result
    // stays bound to the original authority checks in discoverManagedProcessSlot.
    const runtime = await this.core.runtime();
    const physical = this.state && recordedHandle(this.state);
    const generation = this.physicalGeneration; // core.runtime() above confirmed this open.
    if (!physical || !generation) throw new Error("Recorded physical sandbox required for management discovery");
    const key = JSON.stringify([this.context.workspaceId, this.context.session.id, physical.provider, physical.runtimeId, generation]);
    let discovery = this.managementDiscoveries.get(key);
    if (!discovery) {
      discovery = { owner: this, pending: this.discoverManagedProcessSlot(runtime, generation) };
      this.managementDiscoveries.set(key, discovery);
      const exact = discovery;
      void exact.pending.finally(() => { if (this.managementDiscoveries.get(key) === exact) this.managementDiscoveries.delete(key); }).catch(() => {});
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([discovery.pending, new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Management discovery wait timed out; native outcome remains pending")), 1_000);
      })]);
      if (this.live !== runtime || this.physicalGeneration !== generation) throw new Error("Physical sandbox changed during management discovery");
      if (discovery.owner !== this) throw new Error("Prior management discovery settled; current claim must rediscover");
      return result;
    } finally { if (timeout !== undefined) clearTimeout(timeout); }
  }
  private async discoverManagedProcessSlot(runtime: SandboxPort, generation: string) {
    const authority = this.workAuthority;
    if (!authority || !await authority.isCurrent()) throw new Error("Current Work claim required for management discovery");
    type Locator = { sandboxId: string; id: string; epoch: string; pid: number;
      identity: {workspaceId: string; sessionId: string; workId: string; attemptId: string}; status: "running" | "exited" };
    const managed = runtime as SandboxPort & { inspectManagedProcessSlot?(): Promise<Locator>; restoreManagedProcess?(locator: Locator): Promise<SandboxManagedProcessHandle> };
    if (typeof managed.inspectManagedProcessSlot !== "function" || typeof managed.restoreManagedProcess !== "function") throw new Error("Trusted management discovery unsupported");
    // Bind both capabilities now: late RPC completion cannot switch launchers.
    const inspect = managed.inspectManagedProcessSlot.bind(managed);
    const restore = managed.restoreManagedProcess.bind(managed);
    const locator = await inspect();
    if (this.live !== runtime || this.physicalGeneration !== generation || authority !== this.workAuthority || !await authority.isCurrent()) throw new Error("Work claim lost during management discovery");
    if (locator.identity.workspaceId !== authority.attempt.workspaceId || locator.identity.sessionId !== authority.attempt.sessionId) throw new Error("Management slot scope mismatch");
    const handle = await restore(locator);
    if (this.live !== runtime || this.physicalGeneration !== generation || authority !== this.workAuthority || !await authority.isCurrent()) throw new Error("Work claim lost during management restore");
    return {locator, handle};
  }
  setEnvVars(env: Record<string, string>): Promise<void> { return this.core.setEnvVars(env); }
  spawnDuplexProcess(spec: SandboxDuplexProcessSpec): Promise<SandboxDuplexProcess> { return this.core.spawnDuplexProcess(spec); }
  renewActivityTimeout(): Promise<void> {
    const authority = this.workAuthority;
    if (authority === undefined) return this.core.renewActivityTimeout();
    return this.workRenewing ??= (async () => {
      if (!await this.isCurrentWork(authority)) throw new Error("Work claim lost before provider renewal");
      await this.core.renewActivityTimeout();
      if (!await this.isCurrentWork(authority)) throw new Error("Work claim lost during provider renewal");
    })().finally(() => { this.workRenewing = undefined; });
  }

  /** A trusted runner calls this after draining a turn, before Work stop/settlement.
   * Keep the Work alive through this barrier; never use the polling timer. */
  async synchronizeWork(attempt: SessionExecutionAttemptRef): Promise<void> {
    const authority = this.workAuthority;
    if (authority === undefined || !sameWorkAttempt(attempt, authority.attempt) || !await this.isCurrentWork(authority)) {
      throw new Error("Current Work claim required for storage synchronization");
    }
    await this.core.syncStorage("turn_end");
    if (!await this.isCurrentWork(authority)) throw new Error("Work claim lost during storage synchronization");
  }

  /** Identity only (no authority read): was this facade built for exactly this
   * Work attempt? A facade left behind by a lost/older claim is not. */
  boundToWorkAttempt(attempt: SessionExecutionAttemptRef): boolean {
    return this.workAuthority !== undefined && sameWorkAttempt(attempt, this.workAuthority.attempt);
  }

  /** Capture the already-open physical runtime under its issued Work authority.
   * Never open/rebind here: a finalizer must not create a replacement runtime. */
  async captureWork(attempt: SessionExecutionAttemptRef, requireProcess = false): Promise<NodeWorkStorageInput & { handle: NonNullable<ReturnType<typeof recordedHandle>> }> {
    const authority = this.workAuthority;
    const runtime = this.live;
    const generation = this.physicalGeneration;
    const holderHash = authority?.holderHash?.();
    const handle = this.state && recordedHandle(this.state);
    if (!authority || !runtime || !generation || !holderHash || !handle
      || !sameWorkAttempt(attempt, authority.attempt) || !await this.isCurrentWork(authority)) {
      throw new Error("Current physical Work runtime and issued holder required");
    }
    const process = this.managedWorkProcess;
    const processCurrent = async () => !requireProcess || !!process && this.managedWorkProcess === process
      && process.authority === authority && process.runtime === runtime && await process.handle.getStatus() === "running";
    if (!await processCurrent()) throw new Error("Current exact Work management process required");
    return { ...this.context, sandbox: runtime, runtimeGeneration: generation, handle,
      workAuthority: { attempt: authority.attempt, holderHash, isCurrent: async () =>
        this.live === runtime && this.physicalGeneration === generation
        && authority.holderHash?.() === holderHash && await this.isCurrentWork(authority) && await processCurrent() },
    };
  }

  private async isCurrentWork(authority: NodeSandboxWorkAuthority): Promise<boolean> {
    return authority === this.workAuthority && await authority.isCurrent() && authority === this.workAuthority;
  }

  async resolveWorkspaceRoot(): Promise<string> {
    return (await (await this.core.runtime()).resolveWorkspaceRoot?.()) ?? DEFAULT_WORKSPACE_ROOT;
  }

  /** The runner gives this sandbox up (lost, replaced, its allocation over);
   * the Session goes on: the sandbox is released, its latest snapshot stays
   * for the next open. A lost fence leaves it to the new owner. */
  async destroy(): Promise<void> {
    this.cancelIdle();
    await this.core.failExecution();
    this.executionFence = undefined;
    this.live = null;
    this.onDestroyed();
  }

  /** The Session ended: nothing opens again (design §0.1 step 10). */
  async release(): Promise<void> {
    this.cancelIdle();
    await this.core.destroy();
    this.live = null;
    this.onDestroyed();
  }

  /** What the environment cache snapshots for this Session; null = no setup known. */
  private environmentSetup(): EnvironmentCacheSetup | null {
    const { environment, session } = this.context;
    if (environment.config === undefined) return null;
    const openma = session.agent?.openma;
    const acp = openma?.harness === "acp-sandbox" ? openma.acp?.agent.registry : undefined;
    return {
      environment: { id: environment.id, config: environment.config, ...(environment.openma === undefined ? {} : { openma: environment.openma }) },
      ...(acp === undefined ? {} : { acpRegistry: acp }),
    };
  }

  /** The current sandbox was started from a snapshot by this instance. */
  restoredFromSnapshot(): boolean {
    return this.core.restoredFromSnapshot();
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
        const authority = this.workAuthority;
        if (authority !== undefined) this.runtimeGeneration = this.physicalGeneration;
        await this.options.storage.attach({
          ...this.context, sandbox: runtime, runtimeGeneration: this.runtimeGeneration, signal,
          ...(executionFence === undefined ? {} : { executionFence }),
          ...(authority === undefined ? {} : { authorizeMemoryMutation: () => this.isCurrentWork(authority) }),
        });
      },
      sync: async ({ runtime, fence, reason }) => {
        // Node's Memory sync rebases the store directories: only at turn boundaries.
        if (reason === "interval" || reason === "checkpoint") return;
        const authority = this.workAuthority;
        if (authority !== undefined) {
          const execution = executionOfFence(fence);
          if (execution === undefined || !sameWorkAttempt(execution, authority.attempt) || !await this.isCurrentWork(authority)) {
            throw new Error("Work claim lost before storage synchronization");
          }
          const synchronize = this.options.storage.synchronizeWork;
          if (synchronize === undefined) throw new Error("Work storage synchronization is not configured");
          await (this.workSynchronizing ??= synchronize({
            ...this.context, sandbox: runtime, runtimeGeneration: this.runtimeGeneration,
            workAuthority: { attempt: authority.attempt, isCurrent: () => this.isCurrentWork(authority),
              ...(authority.holderHash?.() === undefined ? {} : { holderHash: authority.holderHash!()! }) },
          }).finally(() => { this.workSynchronizing = undefined; }));
          if (!await this.isCurrentWork(authority)) throw new Error("Work claim lost during storage synchronization");
          return;
        }
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
      if (this.options.adapter?.nativeWorkBucket) configureNodeNativeStorage(runtime,this.options.adapter.nativeWorkBucket);
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
    // The runner's lease heartbeat goes through the core: it renews only
    // inside an execution (design §0.0b A.10), never in the idle window.
    this.renewLease = async () => { await this.renewActivityTimeout(); };
    this.suspend = async (input) => (port() ?? runtime).suspend(input);
    this.resume = async (checkpoint) => (port() ?? runtime).resume(checkpoint);
    this.checkpoint = async (input) => (port() ?? runtime).checkpoint(input);
  }

  private scheduleIdle(delayMs: number, version?: number): void {
    this.cancelIdle();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      void this.core.idlePause(version).catch((error: unknown) => {
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

function sameWorkAttempt(a: SessionExecutionAttemptRef | Omit<SessionExecutionAttemptRef, "workspaceId" | "sessionId">, b: SessionExecutionAttemptRef): boolean {
  return a.executionId === b.executionId && a.attemptId === b.attemptId
    && a.ownerId === b.ownerId && a.generation === b.generation
    && (!("workspaceId" in a) || a.workspaceId === b.workspaceId)
    && (!("sessionId" in a) || a.sessionId === b.sessionId);
}
