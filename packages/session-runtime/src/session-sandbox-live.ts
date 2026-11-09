// The live state of one Session's sandbox: what is open, what is attached
// and when it was last renewed, plus the records every lifecycle step keeps
// (the handle record, the fence of the current execution, a lost sandbox).
// Each step (open, storage and egress, renewal, lifetime refresh, idle
// pause, execution end) works on this state; PortsSessionSandbox owns it.

import type { MemoryStoreBinding, SandboxHandle, SandboxPlan, SandboxPorts } from "@open-managed-agents/sandbox";
import type { RuntimeResourceFence, RuntimeResourceScope } from "@open-managed-agents/runtime-resource-contract";
import { executionKey, fenceFor, runtimeFenceOf } from "./session-sandbox-fence";
import type { PortsSessionSandboxOptions, SessionSandboxExecution, SessionSandboxExecutor } from "./session-sandbox-options";
import { initialSandboxState, recordedHandle, transition, type SandboxAction, type SessionSandboxState } from "./session-sandbox-state";

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
    return this.retryDiscards(next);
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

  /** Cleans up a sandbox this writer started but could not record: released,
   * unless the record names it (the winner holds it). */
  async releaseOwn(handle: SandboxHandle): Promise<void> {
    const saved = await this.load().catch(() => undefined);
    if (saved !== undefined && sameHandle(recordedHandle(saved), handle)) return;
    const { ports } = await this.compose();
    await ports.sandbox.release({ scope: this.scope(), handle }).catch((error) => {
      this.options.warn(`sandbox_release_failed runtime=${handle.runtimeId} error=${errorText(error)}`);
    });
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
