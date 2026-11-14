// The live state of one Session's sandbox: what is open, what is attached
// and when it was last renewed, plus the records every lifecycle step keeps
// (the handle record, the fence of the current execution, a lost sandbox).
// Each step (open, storage and egress, renewal, lifetime refresh, idle
// pause, execution end) works on this state; PortsSessionSandbox owns it.

import type { MemoryStoreBinding, ResumeRef, SandboxHandle, SandboxPlan, SandboxPorts } from "@open-managed-agents/sandbox";
import type { RuntimeResourceFence, RuntimeResourceScope } from "@open-managed-agents/runtime-resource-contract";
import { executionKey, fenceFor, runtimeFenceOf } from "./session-sandbox-fence";
import type { PortsSessionSandboxOptions, SessionSandboxExecution, SessionSandboxExecutor } from "./session-sandbox-options";
import { initialSandboxState, referencesSnapshot, recordedHandle, isSnapshotRef, transition, type SandboxAction, type SessionSandboxState } from "./session-sandbox-state";

/** Another writer changed the Session sandbox record since this one read it
 * (design §0.0b A.10): this writer's result was dropped and what it started
 * cleaned up. */
export class SessionSandboxStateConflictError extends Error {
  override readonly name = "SessionSandboxStateConflictError";
}

/** An open sandbox. */
export interface OpenSandbox<R> {
  runtime: R;
  handle: SandboxHandle;
  executor: SessionSandboxExecutor;
  generation: string;
  plan: SandboxPlan;
  /** Start of this sandbox's current continuous run (0 = unknown, treated as due). */
  runStartedAt: number;
}

/** The provider reported that the sandbox is gone (anywhere in the cause
 * chain). This is the provider's own verdict, not a transport failure or an
 * unknown error, which are never evidence of absence. */
export function isSandboxLossError(error: unknown): boolean {
  for (let current = error, depth = 0; current !== null && typeof current === "object" && depth < 8; depth++) {
    const name = (current as { name?: unknown }).name;
    if (name === "SandboxGoneError" || name === "SandboxNotFoundError" || name === "SandboxNotRunningError") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Maintenance waits at most this long for the durable read/acknowledgement
 * after the provider confirms release. A slow provider is still allowed to
 * complete; a late read cannot publish an acknowledgement for that attempt. */
const MAINTENANCE_RELEASE_WAIT_MS = 1_000;

/** Owner wait for its own release outcome: longer than an adapter's bounded
 * managed-process exit confirmation (local subprocess: 2s), shorter than a
 * host's sandbox disposal cap (Node runner: 5s). */
const OWNED_RELEASE_WAIT_MS = 3_000;

export class LiveSessionSandbox<R> {
  /** The open sandbox; null before the first open and after a pause, release or loss. */
  current: OpenSandbox<R> | null = null;
  opening: Promise<OpenSandbox<R>> | null = null;
  /** A warm acquire at Session creation (session-sandbox-open warmSandbox). */
  warming: Promise<void> | null = null;
  maintaining: Promise<void> | null = null;
  refreshing: Promise<void> | null = null;
  refreshError: unknown = null;
  /** A snapshot in a tool-call gap (session-sandbox-snapshot); calls wait for it. */
  snapshotting: Promise<void> | null = null;
  /** Every checkpoint trigger shares this vendor-call single flight. */
  checkpointing: Promise<import("./session-sandbox-snapshot").SnapshotOutcome> | null = null;
  /** The open sandbox was started from a snapshot. */
  restored = false;
  /** A call that may change the sandbox ran since the last snapshot. */
  dirty = false;
  /** Duplex processes (an ACP harness child) started and not yet exited: they
   * change the sandbox without a call the core sees, so it stays changed. */
  liveProcesses = 0;
  /** The adapter's checkpoint returned the sandbox itself: it has no snapshots
   * (a bare v1 factory), so none are attempted again in this instance. */
  snapshotsUnsupported = false;
  /** When the last snapshot was taken, else when this instance first opened the sandbox (0 = neither yet). */
  snapshotAt = 0;
  env: Record<string, string> = {};
  stores: MemoryStoreBinding[] = [];
  outputs = false;
  /** The sandbox disappeared since the last turn-end sync: what it held was not published. */
  lost = false;
  storageSyncedAt = 0;
  egressAttachedAt = 0;
  keptAliveAt = 0;
  egressAttachedKey: string | undefined;
  /** egress.revoke ran since the last attach: the next call attaches again. */
  egressRevoked = false;
  /** When the idle window started (execution end); null = no idle pause
   * pending. Activity in the window does not move it (design §0.0b A.10). */
  idleSince: number | null = null;
  /** Record version observed when this instance armed the idle timer. */
  idleVersion: number | null = null;
  /** sandbox.maxLifetimeMs, known once composed. */
  maxLifetimeMs: number | null = null;
  /** Calls (exec, process start, file I/O) currently in flight. */
  inFlight = 0;
  private releasing: Promise<SessionSandboxState> | null = null;
  private readonly releaseInflight = new Map<string, Promise<SessionSandboxState>>();
  private releaseCursor = 0;
  private composed: Promise<{ ports: SandboxPorts<R> }> | null = null;

  constructor(readonly options: PortsSessionSandboxOptions<R>) {}

  compose(): Promise<{ ports: SandboxPorts<R> }> {
    return this.composed ??= this.options.compose().then((composed) => {
      this.maxLifetimeMs = composed.ports.sandbox.maxLifetimeMs;
      return composed;
    });
  }

  now(): number {
    return (this.options.now ?? Date.now)();
  }

  scope(): RuntimeResourceScope {
    return this.options.scope();
  }

  execution(): SessionSandboxExecution | undefined {
    return this.options.execution?.();
  }

  /** The Port fence: the current execution attempt, else the placeholder. */
  fence(scope: RuntimeResourceScope): RuntimeResourceFence {
    const execution = this.execution();
    return execution === undefined ? fenceFor(scope) : runtimeFenceOf(scope, execution);
  }

  isCurrent(execution: SessionSandboxExecution | undefined): Promise<boolean> {
    return this.options.isCurrent === undefined ? Promise.resolve(true) : this.options.isCurrent(execution);
  }

  /** Memory Stores or outputs are attached (storage Port calls are due). */
  get attachesStorage(): boolean {
    return this.outputs || this.stores.length > 0;
  }

  /** What the egress binding carries: the current execution attempt. */
  egressKey(): string {
    return executionKey(this.execution());
  }

  markEgress(now: number): void {
    this.egressAttachedAt = now;
    this.egressAttachedKey = this.egressKey();
    this.egressRevoked = false;
  }

  /** The sandbox is gone; if it held Memory or outputs the next turn-end sync fails once. */
  markLost(): void {
    this.current = null;
    if (this.attachesStorage) this.lost = true;
  }

  /** The fence was lost (design §0.0 rule 10): exit. Nothing is written
   * back, paused or released; the new owner attaches the same sandbox. */
  abandon(): void {
    this.current = null;
    this.idleSince = null;
    void Promise.resolve(this.options.idle?.cancel()).catch(() => undefined);
  }

  /** The record; a Session with none is in its initial state. */
  async load(): Promise<SessionSandboxState> {
    return (await this.options.state.load()) ?? initialSandboxState();
  }

  /** One transition = one compare-and-set (design §0.0b A.11): the next record
   * of `current` is written if the stored version is still `current`'s, then
   * the snapshots it no longer references are discarded. Null = another writer
   * won: nothing written, nothing discarded. An illegal transition throws
   * SessionSandboxTransitionError. */
  async apply(current: SessionSandboxState, action: SandboxAction): Promise<SessionSandboxState | null> {
    const next: SessionSandboxState = {
      ...transition(current, action),
      stores: mergeStores(current.stores, this.stores),
      outputs: current.outputs || this.outputs,
    };
    if (!await this.options.state.save(next, current.version)) {
      this.options.warn(`sandbox_state_conflict expected_version=${current.version} action=${action.type}: another writer changed the Session sandbox record; this result is dropped`);
      return null;
    }
    // The lifecycle CAS committed. Garbage collection cannot revoke that fact.
    try {
      const settled = await this.retryDiscards(next);
      if (settled.lifecycleRevision === next.lifecycleRevision) return settled;
    } catch (error) {
      this.options.warn(`sandbox_discard_ack_failed error=${errorText(error)}`);
    }
    return next;
  }

  /** Lost publication results are queued too: a failed discard cannot disappear. */
  async discard(ref: ResumeRef): Promise<void> {
    if (!isSnapshotRef(ref)) {
      const { ports } = await this.compose();
      await ports.sandbox.discard({ scope: this.scope(), ref });
      return;
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const saved = await this.load();
      if (await this.apply(saved, { type: "queueDiscard", ref }) !== null) return;
    }
    this.options.warn(`sandbox_discard_queue_failed ref=${ref.ref}: record CAS conflicted three times`);
  }

  /** Queue entries survive a vendor failure and process restart. A successful
   * deletion is acknowledged by CAS; a conflict leaves it safe to retry. */
  async retryDiscards(record?: SessionSandboxState): Promise<SessionSandboxState> {
    let saved = record ?? await this.load();
    const pending = saved.pendingDiscards ?? [];
    if (pending.length === 0) return saved;
    const { ports } = await this.compose();
    const deleted = [];
    for (const ref of pending) {
      try {
        if (referencesSnapshot(await this.load(), ref)) continue;
        await ports.sandbox.discard({ scope: this.scope(), ref });
        deleted.push(ref);
        this.options.info?.(`sandbox_snapshot_discarded ref=${ref.ref}`);
      } catch (error) {
        this.options.warn(`sandbox_discard_failed ref=${ref.ref} pending_count=${pending.length} error=${errorText(error)}`);
      }
    }
    if (deleted.length > 0) {
      const next = transition(saved, { type: "discarded", refs: deleted });
      if (await this.options.state.save(next, saved.version)) saved = next;
      else saved = await this.load();
    }
    this.options.info?.(`sandbox_snapshot_discards pending_count=${saved.pendingDiscards?.length ?? 0}`);
    return saved;
  }

  /** Records what is attached to `open`, the running sandbox of this record.
   * The record, or null when another writer moved it on (a pause, a new
   * sandbox): that writer's record stands. */
  async record(open: OpenSandbox<R>): Promise<SessionSandboxState | null> {
    const saved = await this.load();
    if (saved.phase !== "running" || !sameHandle(saved.handle, open.handle)) {
      this.options.warn(`sandbox_state_conflict phase=${saved.phase} runtime=${open.handle.runtimeId}: another writer changed the Session sandbox record; this result is dropped`);
      return null;
    }
    return this.apply(saved, { type: "attach", handle: open.handle, at: open.runStartedAt });
  }

  /** Retirement is an atomic claim against publication, not a read/fence
   * heuristic. Only provider-assigned handles can be permanently retired. */
  async releaseOwn(handle: SandboxHandle, execution = this.execution(), options: { awaitOutcome?: boolean } = {}): Promise<{ before: SessionSandboxState; after: SessionSandboxState } | undefined> {
    const { ports } = await this.compose();
    if (ports.sandbox.handle !== "changes") return;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!await this.isCurrent(execution)) { this.abandon(); return; }
      const saved = await this.load();
      if (sameHandle(recordedHandle(saved), handle)) return;
      if (!await this.isCurrent(execution)) { this.abandon(); return; }
      const next = transition(saved, { type: "retireHandle", handle });
      if (!await this.options.state.save(next, saved.version)) continue;
      // A local owner ending its runtime (Session end) waits for the real
      // release outcome; other retirements stay bounded maintenance.
      const pending = next.retiredHandles?.some(entry => sameHandle(entry.handle, handle) && !entry.released) ?? false;
      const after = options.awaitOutcome === true && pending
        ? await this.releaseRetiredOwned(next, handle, execution)
        : await this.retryReleases(next, execution);
      // A warm adoption may account for OUR two cleanup writes, never an
      // intervening lifecycle writer. Its initial v1 witness stays strict.
      if (after.version === saved.version + 1 || after.version === saved.version + 2) return { before: saved, after };
      return;
    }
    throw new SessionSandboxStateConflictError(`Could not retire runtime=${handle.runtimeId}: record CAS conflicted three times; provider cleanup was not authorized`);
  }

  /** Same durable record as snapshots; failures and a fence loss leave the
   * pending allocation for a new owner. Release is idempotent at the Port. */
  retryReleases(record: SessionSandboxState, execution = this.execution()): Promise<SessionSandboxState> {
    return this.releasing ??= this.releasePending(record, execution).finally(() => { this.releasing = null; });
  }

  private async releasePending(record: SessionSandboxState, execution: SessionSandboxExecution | undefined): Promise<SessionSandboxState> {
    const pending = (record.retiredHandles ?? []).filter(entry => !entry.released);
    if (pending.length === 0) return record;
    // Advance even on permanent failure. A hung item never monopolizes later ticks.
    const entry = pending[this.releaseCursor++ % pending.length]!;
    const operation = this.releaseOperation(record, entry.handle, execution, MAINTENANCE_RELEASE_WAIT_MS);
    // Deadline bounds caller waiting and this attempt's acknowledgement, NOT
    // the real provider/DB operation. The map retains that operation until it
    // truly settles (no assumed abort).
    // Maintenance never fails its caller: releaseEntry already warned, and the
    // durable retired entry stays pending for a later tick.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation, new Promise<SessionSandboxState>(resolve => {
        timer = setTimeout(() => resolve(record), MAINTENANCE_RELEASE_WAIT_MS);
      })]);
    } catch {
      return record;
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }

  /** The local owner releasing its own retired handle (execution failure /
   * destroy). Unlike a maintenance tick it waits for the provider's own
   * outcome, so an unconfirmed managed-process exit (the adapter's bounded
   * MANAGED_PROCESS_CLEANUP_FAILED) rejects and the caller retains ownership
   * to retry. The wait is bounded: a provider that does not answer (transport
   * hang on a dead handle) is not evidence of release or of absence, and it
   * must not gate a replacement. The entry then stays durably pending for
   * retired-handle maintenance and the orphan sweeper. Other release failures
   * are maintenance work too (warned, kept durably pending). */
  async releaseRetiredOwned(record: SessionSandboxState, handle: SandboxHandle, execution = this.execution()): Promise<SessionSandboxState> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([this.releaseOperation(record, handle, execution), new Promise<SessionSandboxState>(resolve => {
        timer = setTimeout(() => resolve(record), OWNED_RELEASE_WAIT_MS);
      })]);
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === "MANAGED_PROCESS_CLEANUP_FAILED") throw error;
      return record;
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }

  private releaseOperation(record: SessionSandboxState, handle: SandboxHandle, execution: SessionSandboxExecution | undefined, acknowledgementWindowMs?: number): Promise<SessionSandboxState> {
    const key = JSON.stringify(handle);
    let operation = this.releaseInflight.get(key);
    if (operation === undefined) {
      operation = this.releaseEntry(record, handle, execution, acknowledgementWindowMs);
      this.releaseInflight.set(key, operation);
      void operation.finally(() => { if (this.releaseInflight.get(key) === operation) this.releaseInflight.delete(key); }).catch(() => undefined);
    }
    return operation;
  }

  private async releaseEntry(record: SessionSandboxState, handle: SandboxHandle, execution: SessionSandboxExecution | undefined, acknowledgementWindowMs?: number): Promise<SessionSandboxState> {
    let saved = record;
    try {
      const { ports } = await this.compose();
      if (!await this.isCurrent(execution)) return saved;
      await ports.sandbox.release({ scope: this.scope(), handle });
      const acknowledgementDeadline = acknowledgementWindowMs === undefined ? undefined : this.now() + acknowledgementWindowMs;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (!await this.isCurrent(execution)) return saved;
        const current = await this.load();
        // Caller timeout is not authority loss. Late acknowledgement still
        // requires the current fence and an exact record CAS.
        if (acknowledgementDeadline !== undefined && this.now() >= acknowledgementDeadline) return saved;
        if (!await this.isCurrent(execution)) return saved;
        if (acknowledgementDeadline !== undefined && this.now() >= acknowledgementDeadline) return saved;
        const next = transition(current, { type: "handleReleased", handle });
        if (await this.options.state.save(next, current.version)) {
          saved = next;
          // The ack changes no running runtime. Keep an already armed idle
          // timer valid, without extending its original absolute deadline.
          if (this.idleSince !== null && this.idleVersion === current.version && this.options.idle !== undefined) {
            this.idleVersion = next.version;
            await this.options.idle.schedule(Math.max(0, this.idleSince + this.options.idle.pauseMs - this.now()), next.version);
          }
          break;
        }
      }
    } catch (error) {
      this.options.warn(`sandbox_release_failed runtime=${handle.runtimeId} error=${errorText(error)}`);
      throw error;
    }
    return saved;
  }

  /** Waits for a lifetime refresh or a gap snapshot in progress (neither rejects). */
  async quiesce(): Promise<void> {
    while (this.refreshing !== null || this.snapshotting !== null) await (this.refreshing ?? this.snapshotting);
  }

  /** A failed refresh fails the next call or turn-end sync, once. */
  throwRefreshError(): void {
    if (this.refreshError === null) return;
    const error = this.refreshError;
    this.refreshError = null;
    throw error;
  }
}

function sameOptionalHandle(a: SandboxHandle | undefined, b: SandboxHandle | undefined): boolean {
  return a === undefined && b === undefined || sameHandle(a, b);
}

export function sameHandle(a: SandboxHandle | undefined, b: SandboxHandle | undefined): boolean {
  return a !== undefined && b !== undefined && a.provider === b.provider && a.runtimeId === b.runtimeId;
}

export function mergeStores(base: MemoryStoreBinding[], current: MemoryStoreBinding[]): MemoryStoreBinding[] {
  const byName = new Map(base.map((store) => [store.storeName, store]));
  for (const store of current) byName.set(store.storeName, store);
  return [...byName.values()];
}

export function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}
