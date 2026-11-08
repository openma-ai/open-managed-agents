// The live state of one Session's sandbox: what is open, what is attached
// and when it was last renewed, plus the records every lifecycle step keeps
// (the handle record, the fence of the current execution, a lost sandbox).
// Each step (open, storage and egress, renewal, lifetime refresh, idle
// pause, execution end) works on this state; PortsSessionSandbox owns it.

import type { MemoryStoreBinding, SandboxHandle, SandboxPlan, SandboxPorts } from "@open-managed-agents/sandbox";
import type { RuntimeResourceFence, RuntimeResourceScope } from "@open-managed-agents/runtime-resource-contract";
import { executionKey, fenceFor, runtimeFenceOf } from "./session-sandbox-fence";
import type { PortsSessionSandboxOptions, SessionSandboxExecution, SessionSandboxExecutor } from "./session-sandbox-options";

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
  /** When the idle window started (execution end, then any activity); null = no idle pause pending. */
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

  /** Records `open` as the Session's sandbox, keeping the recorded restore point. */
  async record(open: OpenSandbox<R>): Promise<void> {
    const saved = await this.options.state.load();
    await this.options.state.save({
      handle: open.handle, stores: this.stores, outputs: this.outputs, runStartedAt: open.runStartedAt,
      ...(saved?.resumeRef === undefined ? {} : { resumeRef: saved.resumeRef }),
    });
  }

  /** Waits for a lifetime refresh in progress (it never rejects). */
  async quiesce(): Promise<void> {
    while (this.refreshing !== null) await this.refreshing;
  }

  /** A failed refresh fails the next call or turn-end sync, once. */
  throwRefreshError(): void {
    if (this.refreshError === null) return;
    const error = this.refreshError;
    this.refreshError = null;
    throw error;
  }
}

export function mergeStores(base: MemoryStoreBinding[], current: MemoryStoreBinding[]): MemoryStoreBinding[] {
  const byName = new Map(base.map((store) => [store.storeName, store]));
  for (const store of current) byName.set(store.storeName, store);
  return [...byName.values()];
}

export function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}
