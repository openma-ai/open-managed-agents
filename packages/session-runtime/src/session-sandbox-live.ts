// The live state of one Session's sandbox: what is open, what is attached
// and when it was last renewed, plus the records every lifecycle step keeps
// (the handle record, the fence of the current execution, a lost sandbox).
// Each step (open, storage and egress, renewal, lifetime refresh, idle
// pause, execution end) works on this state; PortsSessionSandbox owns it.

import type { MemoryStoreBinding, ResumeRef, SandboxHandle, SandboxPlan, SandboxPorts } from "@open-managed-agents/sandbox";
import type { RuntimeResourceFence, RuntimeResourceScope } from "@open-managed-agents/runtime-resource-contract";
import { executionKey, fenceFor, runtimeFenceOf } from "./session-sandbox-fence";
import type { PortsSessionSandboxOptions, SessionSandboxExecution, SessionSandboxExecutor, SessionSandboxState } from "./session-sandbox-options";

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
  /** A call that may change the sandbox ran since the last snapshot. */
  dirty = false;
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

  /** Writes `next` as version `expected` + 1 if the record is still at
   * `expected` (design §0.0b A.10); false = another writer won, nothing written. */
  async commit(next: SessionSandboxState, expected: number): Promise<boolean> {
    const won = await this.options.state.save({ ...next, version: expected + 1 }, expected);
    if (!won) this.options.warn(`sandbox_state_conflict expected_version=${expected}: another writer changed the Session sandbox record; this result is dropped`);
    return won;
  }

  /** Records `open` as the Session's sandbox, keeping the recorded restore
   * points, against the version read here. The new version, or null when
   * another writer won. */
  async record(open: OpenSandbox<R>): Promise<number | null> {
    const saved = await this.options.state.load();
    const version = stateVersion(saved);
    const won = await this.commit({
      handle: open.handle, stores: this.stores, outputs: this.outputs, runStartedAt: open.runStartedAt,
      ...restorePoints(saved),
    }, version);
    return won ? version + 1 : null;
  }

  /** Cleans up a sandbox this writer started but could not record: released,
   * unless the record names it (the winner holds it). */
  async releaseOwn(handle: SandboxHandle): Promise<void> {
    const saved = await this.options.state.load().catch(() => undefined);
    if (sameHandle(saved?.handle, handle)) return;
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

/** What a new handle record carries over from the previous one: the pause
 * point, the latest snapshot and whether a restore is required. */
export function restorePoints(saved: SessionSandboxState | undefined): Pick<SessionSandboxState, "resumeRef" | "snapshotRef" | "restoreRequired"> {
  return {
    ...(saved?.resumeRef === undefined ? {} : { resumeRef: saved.resumeRef }),
    ...(saved?.snapshotRef === undefined ? {} : { snapshotRef: saved.snapshotRef }),
    ...(saved?.restoreRequired === true ? { restoreRequired: true } : {}),
  };
}

export function sameHandle(a: SandboxHandle | undefined, b: SandboxHandle | undefined): boolean {
  return a !== undefined && b !== undefined && a.provider === b.provider && a.runtimeId === b.runtimeId;
}

/** The record's version (design §0.0b A.10); none or an older record = 0. */
export function stateVersion(saved: SessionSandboxState | undefined): number {
  return saved?.version ?? 0;
}

export function sameRef(a: ResumeRef | undefined, b: ResumeRef | undefined): boolean {
  return a !== undefined && b !== undefined && a.provider === b.provider && a.ref === b.ref;
}

export function mergeStores(base: MemoryStoreBinding[], current: MemoryStoreBinding[]): MemoryStoreBinding[] {
  const byName = new Map(base.map((store) => [store.storeName, store]));
  for (const store of current) byName.set(store.storeName, store);
  return [...byName.values()];
}

export function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}
