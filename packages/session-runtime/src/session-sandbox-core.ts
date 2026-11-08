// The Session sandbox core over the Sandbox SDK v2 Ports
// (research/sandbox-sdk-v2-design.md §0.1), shared by the Cloudflare
// SessionDO and the Node Session runner (design §0.0 rule 15). Hosts keep
// talking to a SandboxExecutor; this class calls only SandboxPorts. Hosts
// only compose: createSandboxPorts + an adapter, and the infrastructure
// below (handle record, restore point, scope, plan).
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
// The fence is the Session execution attempt (design §0.0 rule 10):
// `execution()` is the attempt this owner runs (undefined between
// executions). Every Port call carries it as the RuntimeResourceFence
// (runtimeFenceOf); when it changes egress.attach runs again at the next
// exec boundary, so the binding carries the current attempt. Without
// `execution` the fence is SessionDO's single-writer placeholder (fenceFor).
// `isCurrent` is the live check, made before pause and before a new
// "changes" handle is recorded (§0.1 steps 2, 8, 9).
//
// Execution end and idle (§0.1 steps 7–9, §0.0 rules 11 and 16):
//   - endExecution: egress.revoke("completed") (a failure is only a
//     warning) → storage.sync("turn_end") → the handle is recorded → the
//     host's idle timer is scheduled `idle.pauseMs` out. The sandbox keeps
//     running; the next execution attaches to it.
//   - idlePause (the timer fired): skipped when an execution runs or the
//     window was renewed (any call or keepAlive); otherwise
//     storage.sync("before_stop") → storage.detach → isCurrent →
//     sandbox.pause → the new ResumeRef is recorded with the handle → the
//     old ref is discarded when it differs.
//   - failExecution: nothing is published; egress.revoke("failed") (a
//     warning), release, forget the handle; the next execution resumes from
//     the last recorded ResumeRef.
//   - a lost fence (isCurrent false): exit without writing back or pausing;
//     "fixed" never releases, "changes" releases only a sandbox this open
//     acquired whose handle was not recorded yet.

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
import { SandboxGoneError, parseExecResult } from "@open-managed-agents/sandbox";
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
  /** The Session's sandbox (running or paused); absent after a failed
   * execution released it. */
  handle?: SandboxHandle;
  stores: MemoryStoreBinding[];
  outputs: boolean;
  /** Start (epoch ms) of the sandbox's current continuous run. */
  runStartedAt?: number;
  /** Restore point recorded by the idle pause (design §0.1 step 8). */
  resumeRef?: ResumeRef;
  /** The idle pause stopped the sandbox: attaching wakes it and starts a new run. */
  paused?: boolean;
}

/** A Session execution attempt (managed_session_executions): the one fence
 * (design §0.0 rule 10). */
export interface SessionSandboxExecution {
  executionId: string;
  attemptId: string;
  ownerId: string;
  generation: number;
  /** Lease expiry (ISO); absent = not carried. */
  expiresAt?: string;
}

/** The host's idle timer (CF: a DO alarm; Node: a process timer). */
export interface SessionSandboxIdleTimer {
  /** idlePauseMs (design §0.0 rule 11). */
  pauseMs: number;
  /** Call idlePause() once, `delayMs` from now, replacing a pending one. */
  schedule(delayMs: number): void | Promise<void>;
  cancel(): void | Promise<void>;
}

/** The fence lost between check and record: the new sandbox was released. */
export class SessionSandboxFenceLostError extends Error {
  override readonly name = "SessionSandboxFenceLostError";
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
  /** Identifies what the egress binding carries (the current execution
   * attempt); egress.attach runs again at the next exec boundary when it
   * changes. Omitted = never. Ignored when `execution` is given. */
  egressKey?(): string;
  now?(): number;
  /** The Session execution attempt this owner runs; undefined between
   * executions. Omitted = SessionDO's single-writer placeholder fence. */
  execution?(): SessionSandboxExecution | undefined;
  /** Whether `execution` (undefined = the owner between executions) still
   * holds the Session (design §0.0 rule 10); checked before pause and
   * before a new "changes" handle is recorded. Default: always. */
  isCurrent?(execution: SessionSandboxExecution | undefined): Promise<boolean>;
  /** Idle pause (design §0.0 rule 11). Omitted = never pauses. */
  idle?: SessionSandboxIdleTimer;
  /** sandbox.keepAlive this often at exec boundaries (design §0.1 step 5,
   * a provider lease); null or omitted = never (Cloudflare: the alarm
   * calls renewActivityTimeout). */
  keepAliveMs?: number | null;
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
  private keptAliveAt = 0;
  private egressAttachedKey: string | undefined;
  /** egress.revoke ran since the last attach: the next call attaches again. */
  private egressRevoked = false;
  /** When the idle window started (endExecution, then any activity); null = no idle pause pending. */
  private idleSince: number | null = null;
  private markEgress(now: number): void {
    this.egressAttachedAt = now;
    this.egressAttachedKey = this.egressKey();
    this.egressRevoked = false;
  }
  private egressKey(): string | undefined {
    if (this.options.execution !== undefined) return executionKey(this.options.execution());
    return this.options.egressKey?.();
  }
  private fence(scope: RuntimeResourceScope): RuntimeResourceFence {
    const execution = this.options.execution?.();
    return execution === undefined ? fenceFor(scope) : runtimeFenceOf(scope, execution);
  }
  private current(execution: SessionSandboxExecution | undefined): Promise<boolean> {
    return this.options.isCurrent === undefined ? Promise.resolve(true) : this.options.isCurrent(execution);
  }
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

  /** The live runtime (opened if needed), for host operations outside the
   * executor (provider-specific file or git calls). Not counted as a call. */
  async runtime(): Promise<R> {
    await this.quiesce();
    this.throwRefreshError();
    return (await this.open()).runtime;
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
    await ports.storage.sync({ runtime: this.live.runtime, scope, fence: this.fence(scope), stores: this.stores, outputs: this.live.plan.outputs, reason, signal: new AbortController().signal });
    this.storageSyncedAt = this.now();
  }

  /** Execution end (design §0.1 step 7): egress.revoke("completed") (a
   * failure is only a warning, step 9) → storage.sync("turn_end") → the
   * handle is recorded → the idle pause is scheduled. The sandbox keeps
   * running. A lost fence exits without writing back. */
  async endExecution(): Promise<void> {
    await this.quiesce();
    if (!await this.current(this.options.execution?.())) {
      this.abandon();
      return;
    }
    const live = this.live;
    if (live !== null) await this.revokeEgress(live, "completed");
    await this.syncStorage("turn_end");
    if (this.live !== null) await this.saveState(this.live);
    await this.armIdle(this.options.idle?.pauseMs ?? 0);
  }

  /** The idle timer fired (design §0.1 step 8). Skipped while an execution
   * runs; rescheduled when the window was renewed. Otherwise
   * storage.sync("before_stop") → storage.detach → isCurrent → sandbox.pause
   * → the new ResumeRef is recorded with the handle → the old ref is
   * discarded when it differs. A sandbox the provider already stopped is
   * left alone. */
  async idlePause(): Promise<"paused" | "skipped"> {
    const idle = this.options.idle;
    await this.quiesce();
    if (idle === undefined || this.idleSince === null) return "skipped";
    if (this.options.execution?.() !== undefined) {
      this.idleSince = null;
      return "skipped";
    }
    const remaining = this.idleSince + idle.pauseMs - this.now();
    if (remaining > 0 || this.inFlight > 0) {
      await idle.schedule(Math.max(remaining, 1));
      return "skipped";
    }
    this.idleSince = null;
    const { ports } = await this.compose();
    const scope = this.options.scope();
    const signal = new AbortController().signal;
    const saved = await this.options.state.load();
    let target: { runtime: R; handle: SandboxHandle; outputs: SandboxPlan["outputs"] } | null = this.live === null ? null
      : { runtime: this.live.runtime, handle: this.live.handle, outputs: this.live.plan.outputs };
    if (target === null) {
      if (saved?.handle === undefined || saved.paused === true) return "skipped";
      const attached = await ports.sandbox.attach({ scope, handle: saved.handle, signal });
      if (attached === "gone") return "skipped";
      this.stores = mergeStores(saved.stores, this.stores);
      this.outputs ||= saved.outputs;
      const plan = await this.options.plan({ scope, generation: "", stores: this.stores });
      target = { ...attached, outputs: plan.outputs };
    }
    if (this.outputs || this.stores.length > 0) {
      await ports.storage.sync({ runtime: target.runtime, scope, fence: this.fence(scope), stores: this.stores, outputs: target.outputs, reason: "before_stop", signal });
    }
    await ports.storage.detach({ runtime: target.runtime, scope });
    if (!await this.current(undefined)) {
      this.abandon();
      return "skipped";
    }
    this.live = null;
    const ref = await ports.sandbox.pause({ scope, runtime: target.runtime, handle: target.handle, signal });
    if (!await this.current(undefined)) {
      // Not recorded, so nobody references it; discard never deletes the sandbox.
      await ports.sandbox.discard({ scope, ref }).catch((error) => this.options.warn(`sandbox_discard_failed ref=${ref.ref} error=${errorText(error)}`));
      return "skipped";
    }
    await this.options.state.save({ handle: target.handle, stores: this.stores, outputs: this.outputs, resumeRef: ref, paused: true });
    const previous = saved?.resumeRef;
    if (previous !== undefined && (previous.provider !== ref.provider || previous.ref !== ref.ref)) {
      await ports.sandbox.discard({ scope, ref: previous }).catch((error) => this.options.warn(`sandbox_discard_failed ref=${previous.ref} error=${errorText(error)}`));
    }
    return "paused";
  }

  /** A failed execution (design §0.0 rule 16, §0.1 step 9): nothing is
   * published. egress.revoke("failed") (a failure is only a warning),
   * release the sandbox, forget its handle; the next execution resumes from
   * the last recorded ResumeRef, else starts fresh. A lost fence exits
   * without touching the sandbox. */
  async failExecution(): Promise<void> {
    await this.quiesce();
    await this.disarmIdle();
    if (!await this.current(this.options.execution?.())) {
      this.abandon();
      return;
    }
    const { ports } = await this.compose();
    const scope = this.options.scope();
    const live = this.live;
    this.live = null;
    this.lost = false;
    this.refreshError = null;
    if (live !== null) await this.revokeEgress(live, "failed");
    const saved = await this.options.state.load();
    const handle = live?.handle ?? saved?.handle;
    if (handle !== undefined) {
      await ports.sandbox.release({ scope, handle }).catch((error) => this.options.warn(`sandbox_release_failed runtime=${handle.runtimeId} error=${errorText(error)}`));
    }
    await this.options.state.save({ stores: this.stores, outputs: this.outputs, ...(saved?.resumeRef === undefined ? {} : { resumeRef: saved.resumeRef }) });
  }

  /** The fence was lost (design §0.0 rule 10): exit. Nothing is written
   * back, paused or released; the new owner attaches the same sandbox. */
  abandon(): void {
    this.live = null;
    this.idleSince = null;
    void Promise.resolve(this.options.idle?.cancel()).catch(() => undefined);
  }

  /** keepAlive on the live sandbox (then the exec-boundary renewals), else
   * on the saved one (an alarm-only wake keeps a background task's sandbox
   * alive). */
  async renewActivityTimeout(): Promise<void> {
    const { ports } = await this.compose();
    await this.quiesce();
    this.touchIdle();
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
    if (saved?.handle === undefined || saved.paused === true) return;
    const attached = await ports.sandbox.attach({ scope: this.options.scope(), handle: saved.handle, signal: new AbortController().signal });
    if (attached !== "gone") await ports.sandbox.keepAlive(attached);
  }

  /** Session end: storage.detach, egress.revoke, release. */
  async destroy(): Promise<void> {
    const { ports } = await this.compose();
    await this.quiesce();
    await this.disarmIdle();
    const scope = this.options.scope();
    const live = this.live;
    this.live = null;
    if (live !== null) {
      await ports.storage.detach({ runtime: live.runtime, scope }).catch(() => undefined);
      await ports.egress.revoke({ runtime: live.runtime, scope, fence: this.fence(scope), reason: "completed" }).catch(() => undefined);
    }
    const saved = await this.options.state.load();
    const handle = live?.handle ?? saved?.handle;
    if (handle !== undefined) await ports.sandbox.release({ scope, handle });
    if (saved?.resumeRef !== undefined) await ports.sandbox.discard({ scope, ref: saved.resumeRef }).catch(() => undefined);
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

  private async saveState(live: Live<R>): Promise<void> {
    const saved = await this.options.state.load();
    await this.options.state.save({
      handle: live.handle, stores: this.stores, outputs: this.outputs, runStartedAt: live.runStartedAt,
      ...(saved?.resumeRef === undefined ? {} : { resumeRef: saved.resumeRef }),
    });
  }

  /** egress.revoke; on routes 1 / 3 / 4 a failure is only a warning
   * (design §0.1 step 9). The next call attaches again either way. */
  private async revokeEgress(live: Live<R>, reason: "completed" | "failed"): Promise<void> {
    const { ports } = await this.compose();
    const scope = this.options.scope();
    try {
      await ports.egress.revoke({ runtime: live.runtime, scope, fence: this.fence(scope), reason });
    } catch (error) {
      this.options.warn(`egress_revoke_failed reason=${reason} error=${errorText(error)}`);
    }
    this.egressRevoked = true;
  }

  private async armIdle(delayMs: number): Promise<void> {
    if (this.options.idle === undefined) return;
    this.idleSince = this.now();
    await this.options.idle.schedule(delayMs);
  }

  private async disarmIdle(): Promise<void> {
    if (this.idleSince === null) return;
    this.idleSince = null;
    await Promise.resolve(this.options.idle?.cancel()).catch(() => undefined);
  }

  /** Activity during the idle window pushes the pause out. */
  private touchIdle(): void {
    if (this.idleSince !== null) this.idleSince = this.now();
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
      await this.saveState(live);
      const { ports } = await this.compose();
      const scope = this.options.scope();
      await ports.storage.attach({ runtime: live.runtime, scope, fence: this.fence(scope), stores: this.stores, outputs: live.plan.outputs, signal: new AbortController().signal });
    } catch (error) {
      await this.rollback(live);
      throw error;
    }
  }

  private async call<T>(operation: (executor: SessionSandboxExecutor) => Promise<T>): Promise<T> {
    await this.quiesce();
    this.throwRefreshError();
    this.touchIdle();
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
      if (!await this.current(this.options.execution?.())) return;
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
      await this.saveState(next);
      if (Object.keys(this.env).length > 0) await next.executor.setEnvVars(this.env);
      const fence = this.fence(scope);
      await ports.egress.attach({ runtime: next.runtime, scope, fence, policy: live.plan.egress, signal });
      this.markEgress(now);
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
        await ports.storage.sync({ runtime: live.runtime, scope, fence: this.fence(scope), stores: this.stores, outputs: live.plan.outputs, reason: "interval", signal });
        this.storageSyncedAt = now;
      }
      const keepAliveMs = this.options.keepAliveMs ?? null;
      if (keepAliveMs !== null && now - this.keptAliveAt >= keepAliveMs) {
        if (await ports.sandbox.keepAlive(live) === "gone") {
          this.markLost();
          throw new SandboxGoneError("The sandbox is gone");
        }
        this.keptAliveAt = now;
      }
      const renew = this.options.egressRenewMs;
      const keyChanged = this.egressKey() !== this.egressAttachedKey;
      if ((renew !== null && now - this.egressAttachedAt >= renew) || keyChanged || this.egressRevoked) {
        const plan = await this.options.plan({ scope, generation: live.generation, stores: this.stores });
        await ports.egress.attach({ runtime: live.runtime, scope, fence: this.fence(scope), policy: plan.egress, signal });
        this.markEgress(now);
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
    if (saved?.handle !== undefined) {
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
    // (unknown = due); one the idle pause stopped wakes now. A resumed or
    // new one starts a run now.
    let runStartedAt = reused ? (saved?.paused === true ? this.now() : saved?.runStartedAt ?? 0) : 0;
    const execution = this.options.execution?.();
    let plan: SandboxPlan;
    try {
      plan = await this.options.plan({ scope, generation, stores: this.stores });
      this.stores = mergeStores(plan.stores, this.stores);
      if (opened === "gone") {
        const ref = saved?.resumeRef ?? await this.options.resumeRef();
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
        // A provider-assigned handle is recorded before the sandbox is used,
        // and only while this owner holds the fence: otherwise nobody would
        // know this sandbox, so it is released (design §0.1 step 2).
        if (ports.sandbox.handle === "changes") {
          if (!await this.current(execution)) {
            await ports.sandbox.release({ scope, handle: opened.handle }).catch(() => undefined);
            opened = "gone";
            this.abandon();
            throw new SessionSandboxFenceLostError("The Session execution fence was lost while its sandbox was opened");
          }
          await this.options.state.save({ handle: opened.handle, stores: this.stores, outputs: this.outputs, runStartedAt, ...(saved?.resumeRef === undefined ? {} : { resumeRef: saved.resumeRef }) });
        }
      }
    } catch (error) {
      if (opened !== "gone") await this.rollback(opened);
      throw error;
    }
    const live: Live<R> = { ...opened, executor: this.options.executor(opened.runtime), generation, plan, runStartedAt };
    try {
      if (Object.keys(this.env).length > 0) await live.executor.setEnvVars(this.env);
      const fence = this.fence(scope);
      await ports.egress.attach({ runtime: live.runtime, scope, fence, policy: plan.egress, signal });
      this.markEgress(this.now());
      if (this.outputs || this.stores.length > 0) {
        await ports.storage.attach({ runtime: live.runtime, scope, fence, stores: this.stores, outputs: plan.outputs, signal });
      }
      this.storageSyncedAt = this.now();
      this.keptAliveAt = this.now();
      if (!reused) await writeMarker(live.executor, generation);
      await this.options.state.save({ handle: live.handle, stores: this.stores, outputs: this.outputs, runStartedAt, ...(saved?.resumeRef === undefined ? {} : { resumeRef: saved.resumeRef }) });
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
    await ports.egress.revoke({ runtime: opened.runtime, scope, fence: this.fence(scope), reason: "failed" }).catch(() => undefined);
    await ports.sandbox.release({ scope, handle: opened.handle }).catch(() => undefined);
    await this.options.state.clear().catch(() => undefined);
  }
}

async function readMarker(executor: SessionSandboxExecutor): Promise<string | null> {
  try {
    const result = parseExecResult(await executor.exec(`cat ${SANDBOX_GENERATION_MARKER} 2>/dev/null`));
    const value = result.exitCode === 0 ? result.stdout.trim() : "";
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

async function writeMarker(executor: SessionSandboxExecutor, generation: string): Promise<void> {
  const out = await executor.exec(`echo ${generation} > ${SANDBOX_GENERATION_MARKER}`);
  if (parseExecResult(out).exitCode !== 0) throw new Error(`Writing ${SANDBOX_GENERATION_MARKER} failed: ${out.slice(0, 200)}`);
}

const NO_EXPIRY = "9999-12-31T00:00:00.000Z";

/** SessionDO is the single writer of its Session. */
export function fenceFor(scope: RuntimeResourceScope): RuntimeResourceFence {
  return { ...scope, ownerId: "session-do", generation: 1, token: "session-do", expiresAt: NO_EXPIRY };
}

/** The Session execution attempt as the Port fence: workId = executionId,
 * token = attemptId. executionOfFence reverses it. */
export function runtimeFenceOf(scope: RuntimeResourceScope, execution: SessionSandboxExecution): RuntimeResourceFence {
  return { ...scope, workId: execution.executionId, ownerId: execution.ownerId, generation: execution.generation, token: execution.attemptId, expiresAt: execution.expiresAt ?? NO_EXPIRY };
}

/** The attempt a Port fence carries; undefined for the placeholder (no attempt). */
export function executionOfFence(fence: RuntimeResourceFence): SessionSandboxExecution | undefined {
  if (fence.ownerId === "session-do" && fence.token === "session-do") return undefined;
  return { executionId: fence.workId, attemptId: fence.token, ownerId: fence.ownerId, generation: fence.generation, ...(fence.expiresAt === NO_EXPIRY ? {} : { expiresAt: fence.expiresAt }) };
}

export function executionKey(execution: SessionSandboxExecution | undefined): string {
  return execution === undefined ? "" : `${execution.executionId}/${execution.attemptId}/${execution.ownerId}/${execution.generation}`;
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}

function mergeStores(base: MemoryStoreBinding[], current: MemoryStoreBinding[]): MemoryStoreBinding[] {
  const byName = new Map(base.map((store) => [store.storeName, store]));
  for (const store of current) byName.set(store.storeName, store);
  return [...byName.values()];
}
