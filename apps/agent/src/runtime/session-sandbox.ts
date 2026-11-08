// One Session sandbox runtime over the Sandbox SDK v2 Ports
// (research/sandbox-sdk-v2-design.md §0.1). SessionDO keeps talking to a
// SandboxExecutor; every adapter (SANDBOX_ADAPTER) reaches it through this
// class, which calls only SandboxPorts. Adapter composition
// (createSandboxPorts + the adapter) lives in cloudflare-session-sandbox.ts and
// e2b-session-sandbox.ts; session-sandbox-adapters.ts picks one.
//
// Opening a sandbox (lazily, on first use or prepare()):
//   1. attach the saved handle; its /tmp/.oma-warm marker is the generation
//      (the private Memory runtime generation and the recycle probe value);
//   2. otherwise mint a generation, plan, resume from the latest published
//      ref, else acquire; a "changes" handle is written before anything else;
//   3. egress.attach, then storage.attach, then the marker for a new sandbox.
// A failed step rolls back what this open did (egress.revoke, release,
// forget the handle) and the error is thrown.
//
// At every exec boundary (Workers cannot keep a timer), single-flight:
// storage.sync("interval") every STORAGE_SYNC_INTERVAL_MS (write back only;
// native mounts use it to renew temporary credentials), and egress.attach
// again every `egressRenewMs` when the composition's egress carries an
// expiring credential (E2B relay pass). A failure fails the call.
//
// A sandbox that disappears while Memory or outputs are attached (exec
// reports it gone, or keepAlive returns "gone") is remembered: the next
// syncStorage throws SandboxGoneError instead of publishing nothing
// (design §0.0 rule 16), once.
//
// Provider continuous-run cap (design §0.0 rule 11, sandbox.maxLifetimeMs;
// null = none, e.g. Cloudflare). The runtime records when this sandbox's
// current continuous run started (acquire / resume / its own refresh; kept
// with the handle so a new SessionDO instance knows it) and never trusts
// keepAlive: E2B silently truncates a renewal at the cap. Once the run
// passes maxLifetimeMs − MAX_TOOL_CALL_MS − LIFETIME_REFRESH_MARGIN_MS and
// no call is in flight (the model-inference gap), it refreshes in the
// background: fence check, sandbox.pause, sandbox.attach (wakes the paused
// sandbox), then egress.attach and storage.attach again. The next call
// waits for it; a failed refresh fails that call, once. Layer 2 (the
// provider pausing at the cap) is the adapter's (E2B onTimeout: pause).
//
// Not here yet (reported in #545): per-execution egress.revoke at turn end
// (a running background process keeps egress between turns, as before),
// core-driven idle pause (Cloudflare: OmaSandbox idle teardown backs up and
// stops; E2B: lease timeout), and a live fence (SessionDO is the single
// writer of its Session).

import type {
  Acquired,
  MemoryStoreBinding,
  ProcessHandle,
  ResumeRef,
  SandboxDuplexProcess,
  SandboxDuplexProcessSpec,
  SandboxExecutor,
  SandboxHandle,
  SandboxPlan,
  SandboxPorts,
} from "@open-managed-agents/sandbox";
import { SandboxGoneError } from "@open-managed-agents/sandbox";
import type { RuntimeResourceFence, RuntimeResourceScope } from "@open-managed-agents/runtime-resource-contract";

export const SANDBOX_GENERATION_MARKER = "/tmp/.oma-warm";
/** Interval write-back at exec boundaries (design §0.1 step 5, default 15 s). */
export const STORAGE_SYNC_INTERVAL_MS = 15_000;
/** The longest single tool call (bash MAX_BASH_TIMEOUT, harness/tools.ts). */
export const MAX_TOOL_CALL_MS = 10 * 60_000;
/** Headroom for the lifetime refresh itself (pause + attach). */
export const LIFETIME_REFRESH_MARGIN_MS = 5 * 60_000;

/** What SessionDO calls on a sandbox runtime. */
export type SessionSandboxExecutor = Pick<SandboxExecutor, "exec" | "readFile" | "writeFile"> & {
  startProcess(command: string): Promise<ProcessHandle | null>;
  spawnDuplexProcess(spec: SandboxDuplexProcessSpec): Promise<SandboxDuplexProcess>;
  writeFileBytes(path: string, bytes: Uint8Array): Promise<string>;
  setEnvVars(env: Record<string, string>): Promise<void>;
};

export interface SessionSandboxState {
  handle: SandboxHandle;
  stores: MemoryStoreBinding[];
  outputs: boolean;
  /** Start (epoch ms) of the sandbox's current continuous run. */
  runStartedAt?: number;
}

export interface PortsSessionSandboxOptions<R> {
  compose(): Promise<{ ports: SandboxPorts<R> }>;
  /** SessionDO's view of a runtime (exec output in the `exit=N\n...` shape). */
  executor(runtime: R): SessionSandboxExecutor;
  state: {
    load(): Promise<SessionSandboxState | undefined>;
    save(state: SessionSandboxState): Promise<void>;
    clear(): Promise<void>;
  };
  scope(): RuntimeResourceScope;
  /** `stores`: stores already mounted through this runtime. */
  plan(input: { scope: RuntimeResourceScope; generation: string; stores: MemoryStoreBinding[] }): Promise<SandboxPlan>;
  /** Latest published restore point, or null. */
  resumeRef(): Promise<ResumeRef | null>;
  warn(message: string): void;
  outputDurability(): { durability: "durable" | "best_effort" } | null;
  /** egress.attach again this often at exec boundaries (an expiring
   * credential in the egress, e.g. the E2B relay pass); null = never. */
  egressRenewMs: number | null;
  now?(): number;
  /** Whether this owner still holds the Session's fence (design §0.0 rule
   * 10); checked before the lifetime refresh pauses. Default: always
   * (SessionDO is the single writer of its Session). */
  isCurrent?(): Promise<boolean>;
}

interface Live<R> {
  runtime: R;
  handle: SandboxHandle;
  executor: SessionSandboxExecutor;
  generation: string;
  plan: SandboxPlan;
  /** Start of this sandbox's current continuous run (0 = unknown, treated as due). */
  runStartedAt: number;
}

export class PortsSessionSandbox<R> implements SandboxExecutor {
  private live: Live<R> | null = null;
  private opening: Promise<Live<R>> | null = null;
  private composed: Promise<{ ports: SandboxPorts<R> }> | null = null;
  private maintaining: Promise<void> | null = null;
  private env: Record<string, string> = {};
  private stores: MemoryStoreBinding[] = [];
  private outputs = false;
  /** The sandbox disappeared since the last turn-end sync: what it held was not published. */
  private lost = false;
  private storageSyncedAt = 0;
  private egressAttachedAt = 0;
  /** sandbox.maxLifetimeMs, known once composed. */
  private maxLifetimeMs: number | null = null;
  /** Calls (exec, process start, file I/O) currently in flight. */
  private inFlight = 0;
  private refreshing: Promise<void> | null = null;
  private refreshError: unknown = null;

  constructor(private readonly options: PortsSessionSandboxOptions<R>) {}

  async exec(command: string, timeout?: number): Promise<string> { return this.call((e) => e.exec(command, timeout)); }
  startProcess(command: string) { return this.call((e) => e.startProcess(command)); }
  spawnDuplexProcess(spec: SandboxDuplexProcessSpec): Promise<SandboxDuplexProcess> { return this.call((e) => e.spawnDuplexProcess(spec)); }
  readFile(path: string) { return this.call((e) => e.readFile(path)); }
  writeFile(path: string, content: string) { return this.call((e) => e.writeFile(path, content)); }
  writeFileBytes(path: string, bytes: Uint8Array) { return this.call((e) => e.writeFileBytes(path, bytes)); }

  async setEnvVars(env: Record<string, string>): Promise<void> {
    this.env = { ...this.env, ...env };
    await this.quiesce();
    if (this.live !== null) await this.live.executor.setEnvVars(env);
  }

  async mountMemoryStore(store: MemoryStoreBinding): Promise<void> {
    this.stores = mergeStores(this.stores, [store]);
    await this.attachStorage();
  }

  sessionOutputMountCapabilities(): { durability: "durable" | "best_effort" } | null {
    return this.options.outputDurability();
  }

  async mountSessionOutputs(): Promise<void> {
    this.outputs = true;
    await this.attachStorage();
  }

  /** Opens the sandbox again (attach, else resume, else acquire) and
   * returns its generation. A recycled sandbox is found here. */
  async prepare(): Promise<string> {
    await this.quiesce();
    this.live = null;
    return (await this.open()).generation;
  }

  /** Turn end / before stop: storage.sync (copy: Memory write-back + pull
   * and the outputs upload; native: credential renewal or a no-op). Any
   * failure, including a sandbox lost during the turn, is an error. */
  async syncStorage(reason: "turn_end" | "before_stop"): Promise<void> {
    await this.quiesce();
    this.throwRefreshError();
    if (this.lost) {
      this.lost = false;
      throw new SandboxGoneError("The sandbox was lost during the turn; its Memory and outputs changes were not published");
    }
    if (this.live === null || (!this.outputs && this.stores.length === 0)) return;
    const { ports } = await this.compose();
    const scope = this.options.scope();
    await ports.storage.sync({ runtime: this.live.runtime, scope, fence: fenceFor(scope), stores: this.stores, outputs: this.live.plan.outputs, reason, signal: new AbortController().signal });
    this.storageSyncedAt = this.now();
  }

  /** keepAlive on the live sandbox (then the exec-boundary renewals), else
   * on the saved one (an alarm-only wake keeps a background task's sandbox
   * alive). */
  async renewActivityTimeout(): Promise<void> {
    const { ports } = await this.compose();
    await this.quiesce();
    if (this.live !== null) {
      const live = this.live;
      if (await ports.sandbox.keepAlive(live) === "gone") {
        this.markLost();
        return;
      }
      await this.maintain(live);
      return;
    }
    const saved = await this.options.state.load();
    if (saved === undefined) return;
    const attached = await ports.sandbox.attach({ scope: this.options.scope(), handle: saved.handle, signal: new AbortController().signal });
    if (attached !== "gone") await ports.sandbox.keepAlive(attached);
  }

  /** Session end: storage.detach, egress.revoke, release. */
  async destroy(): Promise<void> {
    const { ports } = await this.compose();
    await this.quiesce();
    const scope = this.options.scope();
    const live = this.live;
    this.live = null;
    if (live !== null) {
      await ports.storage.detach({ runtime: live.runtime, scope }).catch(() => undefined);
      await ports.egress.revoke({ runtime: live.runtime, scope, fence: fenceFor(scope), reason: "completed" }).catch(() => undefined);
    }
    const handle = live?.handle ?? (await this.options.state.load())?.handle;
    if (handle !== undefined) await ports.sandbox.release({ scope, handle });
    await this.options.state.clear();
  }

  private compose() {
    return this.composed ??= this.options.compose().then((composed) => {
      this.maxLifetimeMs = composed.ports.sandbox.maxLifetimeMs;
      return composed;
    });
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private markLost(): void {
    this.live = null;
    if (this.outputs || this.stores.length > 0) this.lost = true;
  }

  private async attachStorage(): Promise<void> {
    const opened = this.live === null;
    const live = await this.open();
    // A fresh open already attached the current stores and outputs.
    if (opened) return;
    try {
      await this.options.state.save({ handle: live.handle, stores: this.stores, outputs: this.outputs, runStartedAt: live.runStartedAt });
      const { ports } = await this.compose();
      const scope = this.options.scope();
      await ports.storage.attach({ runtime: live.runtime, scope, fence: fenceFor(scope), stores: this.stores, outputs: live.plan.outputs, signal: new AbortController().signal });
    } catch (error) {
      await this.rollback(live);
      throw error;
    }
  }

  private async call<T>(operation: (executor: SessionSandboxExecutor) => Promise<T>): Promise<T> {
    await this.quiesce();
    this.throwRefreshError();
    let live = await this.open();
    // Past the threshold during idle time: refresh now, in this gap.
    if (this.inFlight === 0 && this.lifetimeDue(live)) {
      await this.refresh(live);
      this.throwRefreshError();
      live = await this.open();
    }
    this.inFlight += 1;
    try {
      await this.maintain(live);
      return await operation(live.executor);
    } catch (error) {
      const name = (error as { name?: unknown } | null)?.name;
      if (name === "SandboxGoneError" || name === "SandboxNotFoundError" || name === "SandboxNotRunningError") this.markLost();
      throw error;
    } finally {
      this.inFlight -= 1;
      // The last call returned: the model is thinking. Refresh in the background.
      const current = this.live;
      if (this.inFlight === 0 && current !== null && this.lifetimeDue(current)) void this.refresh(current);
    }
  }

  /** Waits for a lifetime refresh in progress (it never rejects). */
  private async quiesce(): Promise<void> {
    while (this.refreshing !== null) await this.refreshing;
  }

  /** A failed refresh fails the next call or turn-end sync, once. */
  private throwRefreshError(): void {
    if (this.refreshError === null) return;
    const error = this.refreshError;
    this.refreshError = null;
    throw error;
  }

  private lifetimeDue(live: Live<R>): boolean {
    const max = this.maxLifetimeMs;
    if (max === null) return false;
    return this.now() - live.runStartedAt >= max - MAX_TOOL_CALL_MS - LIFETIME_REFRESH_MARGIN_MS;
  }

  /** Design §0.0 rule 11 layer 1: pause → attach, single-flight. Only when
   * this owner still holds the fence (rule 10: a fenced-out owner does not
   * pause). Never rejects: a failure is kept for the next call. */
  private refresh(live: Live<R>): Promise<void> {
    return this.refreshing ??= (async () => {
      if (!await (this.options.isCurrent ?? (async () => true))()) return;
      const { ports } = await this.compose();
      const scope = this.options.scope();
      const signal = new AbortController().signal;
      // Nothing may use the runtime being paused; callers wait on `refreshing`.
      this.live = null;
      await ports.sandbox.pause({ scope, runtime: live.runtime, handle: live.handle, signal });
      const attached = await ports.sandbox.attach({ scope, handle: live.handle, signal });
      if (attached === "gone") {
        this.markLost();
        throw new SandboxGoneError("The sandbox did not come back after its lifetime refresh");
      }
      const now = this.now();
      const next: Live<R> = { ...attached, executor: this.options.executor(attached.runtime), generation: live.generation, plan: live.plan, runStartedAt: now };
      await this.options.state.save({ handle: next.handle, stores: this.stores, outputs: this.outputs, runStartedAt: now });
      if (Object.keys(this.env).length > 0) await next.executor.setEnvVars(this.env);
      const fence = fenceFor(scope);
      await ports.egress.attach({ runtime: next.runtime, scope, fence, policy: live.plan.egress, signal });
      this.egressAttachedAt = now;
      if (this.outputs || this.stores.length > 0) {
        await ports.storage.attach({ runtime: next.runtime, scope, fence, stores: this.stores, outputs: live.plan.outputs, signal });
      }
      this.live = next;
    })().catch((error: unknown) => {
      this.live = null;
      this.refreshError = error;
    }).finally(() => { this.refreshing = null; });
  }

  /** Exec-boundary renewals, single-flight; a failure fails the call. */
  private maintain(live: Live<R>): Promise<void> {
    return this.maintaining ??= (async () => {
      const now = this.now();
      const { ports } = await this.compose();
      const scope = this.options.scope();
      const signal = new AbortController().signal;
      if (now - this.storageSyncedAt >= STORAGE_SYNC_INTERVAL_MS && (this.outputs || this.stores.length > 0)) {
        await ports.storage.sync({ runtime: live.runtime, scope, fence: fenceFor(scope), stores: this.stores, outputs: live.plan.outputs, reason: "interval", signal });
        this.storageSyncedAt = now;
      }
      const renew = this.options.egressRenewMs;
      if (renew !== null && now - this.egressAttachedAt >= renew) {
        const plan = await this.options.plan({ scope, generation: live.generation, stores: this.stores });
        await ports.egress.attach({ runtime: live.runtime, scope, fence: fenceFor(scope), policy: plan.egress, signal });
        this.egressAttachedAt = now;
      }
    })().finally(() => { this.maintaining = null; });
  }

  private async open(): Promise<Live<R>> {
    await this.quiesce();
    if (this.live !== null) return this.live;
    return this.opening ??= this.start().finally(() => { this.opening = null; });
  }

  private async start(): Promise<Live<R>> {
    const { ports } = await this.compose();
    const scope = this.options.scope();
    const signal = new AbortController().signal;
    const saved = await this.options.state.load();
    if (saved !== undefined) {
      this.stores = mergeStores(saved.stores, this.stores);
      this.outputs ||= saved.outputs;
    }
    // Held by this open; released if a later step fails.
    let opened: Acquired<R> | "gone" = "gone";
    let generation = "";
    if (saved !== undefined) {
      opened = await ports.sandbox.attach({ scope, handle: saved.handle, signal });
      const marker = opened === "gone" ? null : await readMarker(this.options.executor(opened.runtime));
      if (marker === null) {
        opened = "gone";
        // A "fixed" handle is reused by the next acquire; a provider-assigned one would be orphaned.
        if (ports.sandbox.handle === "changes") await ports.sandbox.release({ scope, handle: saved.handle }).catch(() => undefined);
      } else {
        generation = marker;
      }
    }
    const reused = opened !== "gone";
    if (!reused) generation = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    // An attached sandbox may have kept running: keep the recorded start
    // (unknown = due). A resumed or new one starts a run now.
    let runStartedAt = reused ? saved?.runStartedAt ?? 0 : 0;
    let plan: SandboxPlan;
    try {
      plan = await this.options.plan({ scope, generation, stores: this.stores });
      this.stores = mergeStores(plan.stores, this.stores);
      if (opened === "gone") {
        const ref = await this.options.resumeRef();
        if (ref !== null) {
          const started = Date.now();
          opened = await ports.sandbox.resume({ scope, ref, plan, signal });
          this.options.warn(opened === "gone"
            ? `workspace_restore_failed backup_id=${ref.ref} elapsed_ms=${Date.now() - started} error=gone`
            : `workspace_restored backup_id=${ref.ref} elapsed_ms=${Date.now() - started}`);
        }
        if (opened === "gone") opened = await ports.sandbox.acquire({ scope, plan, signal });
        if (opened === "gone") throw new Error(`Sandbox source ${JSON.stringify(plan.from)} was not found`);
        runStartedAt = this.now();
        // A provider-assigned handle is recorded before the sandbox is used.
        if (ports.sandbox.handle === "changes") await this.options.state.save({ handle: opened.handle, stores: this.stores, outputs: this.outputs, runStartedAt });
      }
    } catch (error) {
      if (opened !== "gone") await this.rollback(opened);
      throw error;
    }
    const live: Live<R> = { ...opened, executor: this.options.executor(opened.runtime), generation, plan, runStartedAt };
    try {
      if (Object.keys(this.env).length > 0) await live.executor.setEnvVars(this.env);
      const fence = fenceFor(scope);
      await ports.egress.attach({ runtime: live.runtime, scope, fence, policy: plan.egress, signal });
      this.egressAttachedAt = this.now();
      if (this.outputs || this.stores.length > 0) {
        await ports.storage.attach({ runtime: live.runtime, scope, fence, stores: this.stores, outputs: plan.outputs, signal });
      }
      this.storageSyncedAt = this.now();
      if (!reused) await writeMarker(live.executor, generation);
      await this.options.state.save({ handle: live.handle, stores: this.stores, outputs: this.outputs, runStartedAt });
    } catch (error) {
      await this.rollback(live);
      throw error;
    }
    this.live = live;
    return live;
  }

  /** Undo an open: revoke egress, release the sandbox, forget the handle. */
  private async rollback(opened: { runtime: R; handle: SandboxHandle }): Promise<void> {
    this.live = null;
    const { ports } = await this.compose();
    const scope = this.options.scope();
    await ports.egress.revoke({ runtime: opened.runtime, scope, fence: fenceFor(scope), reason: "failed" }).catch(() => undefined);
    await ports.sandbox.release({ scope, handle: opened.handle }).catch(() => undefined);
    await this.options.state.clear().catch(() => undefined);
  }
}

async function readMarker(executor: SessionSandboxExecutor): Promise<string | null> {
  try {
    const out = await executor.exec(`cat ${SANDBOX_GENERATION_MARKER} 2>/dev/null`);
    const match = /^exit=(-?\d+)\n([\s\S]*)$/.exec(out);
    const value = match?.[1] === "0" ? match[2].trim() : "";
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

async function writeMarker(executor: SessionSandboxExecutor, generation: string): Promise<void> {
  const out = await executor.exec(`echo ${generation} > ${SANDBOX_GENERATION_MARKER}`);
  if (!out.startsWith("exit=0")) throw new Error(`Writing ${SANDBOX_GENERATION_MARKER} failed: ${out.slice(0, 200)}`);
}

/** SessionDO is the single writer of its Session. */
export function fenceFor(scope: RuntimeResourceScope): RuntimeResourceFence {
  return { ...scope, ownerId: "session-do", generation: 1, token: "session-do", expiresAt: "9999-12-31T00:00:00.000Z" };
}

function mergeStores(base: MemoryStoreBinding[], current: MemoryStoreBinding[]): MemoryStoreBinding[] {
  const byName = new Map(base.map((store) => [store.storeName, store]));
  for (const store of current) byName.set(store.storeName, store);
  return [...byName.values()];
}
