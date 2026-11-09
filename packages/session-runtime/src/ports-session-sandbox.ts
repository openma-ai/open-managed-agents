// The Session sandbox core over the Sandbox SDK v2 Ports
// (research/sandbox-sdk-v2-design.md §0.1), shared by the Cloudflare
// SessionDO and the Node Session runner (design §0.0 rule 15). Hosts keep
// talking to a SandboxExecutor; this class calls only SandboxPorts. Hosts
// only compose (session-sandbox-options.ts): createSandboxPorts + an
// adapter, the handle record, scope, plan, fence and idle timer.
//
// The record and every transition of it are session-sandbox-state. Each
// lifecycle step is its own module: opening (session-sandbox-open),
// egress and storage (session-sandbox-storage-egress), exec-boundary
// renewals (session-sandbox-renewal), the lifetime refresh
// (session-sandbox-lifetime), the idle pause (session-sandbox-idle-pause)
// snapshots (session-sandbox-snapshot) and the execution end
// (session-sandbox-execution-end), over one
// LiveSessionSandbox state. A sandbox that disappears while Memory or
// outputs are attached is remembered: the next syncStorage throws
// SandboxGoneError instead of publishing nothing (design §0.0 rule 16).

import type { MemoryStoreBinding, SandboxDuplexProcess, SandboxDuplexProcessSpec, SandboxExecutor } from "@open-managed-agents/sandbox";
import { endExecution, failExecution } from "./session-sandbox-execution-end";
import { disarmIdle, idlePause } from "./session-sandbox-idle-pause";
import { lifetimeDue, refreshLifetime } from "./session-sandbox-lifetime";
import { LiveSessionSandbox, mergeStores, SessionSandboxStateConflictError } from "./session-sandbox-live";
import { openSandbox, rollbackOpen, warmSandbox } from "./session-sandbox-open";
import { recordedHandle } from "./session-sandbox-state";
import type { PortsSessionSandboxOptions, SessionSandboxExecutor } from "./session-sandbox-options";
import { renewActivityTimeout, renewAtExecBoundary } from "./session-sandbox-renewal";
import { snapshotDue, snapshotInGap } from "./session-sandbox-snapshot";
import { attachStorage, syncStorage } from "./session-sandbox-storage-egress";

export class PortsSessionSandbox<R> implements SandboxExecutor {
  private readonly state: LiveSessionSandbox<R>;

  constructor(options: PortsSessionSandboxOptions<R>) {
    this.state = new LiveSessionSandbox(options);
  }

  async exec(command: string, timeout?: number): Promise<string> { return this.call((e) => e.exec(command, timeout)); }
  startProcess(command: string) { return this.call((e) => e.startProcess(command)); }
  /** Counted until it exits: it changes the sandbox without calls (session-sandbox-snapshot). */
  spawnDuplexProcess(spec: SandboxDuplexProcessSpec): Promise<SandboxDuplexProcess> {
    const state = this.state;
    return this.call(async (e) => {
      const process = await e.spawnDuplexProcess(spec);
      const spawnedIn = state.current;
      const spawnedExecution = state.execution();
      state.liveProcesses += 1;
      const exited = () => { state.liveProcesses -= 1; };
      process.exited.then(exited, exited);
      return { ...process, confirmSandboxGone: async () => {
        const { ports } = await state.compose();
        const open = spawnedIn;
        if (open === null || (state.current !== null && state.current !== open) || spawnedExecution === undefined || state.execution()?.attemptId !== spawnedExecution.attemptId || state.execution()?.generation !== spawnedExecution.generation) return false;
        const result = await ports.sandbox.keepAlive(open);
        if (result !== "gone") return false;
        state.markLost();
        return true;
      } };
    });
  }
  readFile(path: string) { return this.call((e) => e.readFile(path), false); }
  writeFile(path: string, content: string) { return this.call((e) => e.writeFile(path, content)); }
  writeFileBytes(path: string, bytes: Uint8Array) { return this.call((e) => e.writeFileBytes(path, bytes)); }

  async setEnvVars(env: Record<string, string>): Promise<void> {
    const state = this.state;
    state.env = { ...state.env, ...env };
    await state.quiesce();
    if (state.current !== null) await state.current.executor.setEnvVars(env);
  }

  async mountMemoryStore(store: MemoryStoreBinding): Promise<void> {
    this.state.stores = mergeStores(this.state.stores, [store]);
    await this.mountStorage();
  }

  sessionOutputMountCapabilities(): { durability: "durable" | "best_effort" } | null {
    return this.state.options.outputDurability();
  }

  async mountSessionOutputs(): Promise<void> {
    this.state.outputs = true;
    await this.mountStorage();
  }

  /** The open runtime (opened if needed), for host operations outside the
   * executor (provider-specific file or git calls). Not counted as a call. */
  async runtime(): Promise<R> {
    await this.state.quiesce();
    this.state.throwRefreshError();
    return (await openSandbox(this.state)).runtime;
  }

  /** Opens the sandbox again (attach, else resume, else acquire) and
   * returns its generation. A recycled sandbox is found here. */
  async prepare(): Promise<string> {
    await this.state.quiesce();
    this.state.current = null;
    return (await openSandbox(this.state)).generation;
  }

  /** Session creation: acquire the sandbox and record its handle, without
   * an egress token or storage; the first execution attaches it. */
  warm(): Promise<void> { return warmSandbox(this.state); }
  /** The Environment setup succeeded on this sandbox (environment cache). */
  environmentPrepared(): void { this.state.options.environmentCache?.prepared(this.state.scope()); }
  /** Turn end / before stop write-back (session-sandbox-storage-egress). */
  syncStorage(reason: "turn_end" | "before_stop"): Promise<void> { return syncStorage(this.state, reason); }
  /** Execution end: the sandbox keeps running until the idle pause. */
  endExecution(): Promise<void> { return endExecution(this.state); }
  /** The idle timer fired. */
  idlePause(version?: number): Promise<"paused" | "skipped"> { return idlePause(this.state, version); }
  /** A failed execution: nothing published, the sandbox released. */
  failExecution(): Promise<void> { return failExecution(this.state); }
  /** This instance's last open started the sandbox from a snapshot. */
  restoredFromSnapshot(): boolean { return this.state.restored; }
  /** The fence was lost: exit without writing back, pausing or releasing. */
  abandon(): void { this.state.abandon(); }
  renewActivityTimeout(): Promise<void> { return renewActivityTimeout(this.state); }

  /** Session end: storage.detach, egress.revoke, release, then the release
   * transition (it discards the snapshots). Nothing opens again. */
  async destroy(): Promise<void> {
    const state = this.state;
    const { ports } = await state.compose();
    await state.quiesce();
    await disarmIdle(state);
    const scope = state.scope();
    const open = state.current;
    state.current = null;
    if (open !== null) {
      await ports.storage.detach({ runtime: open.runtime, scope }).catch(() => undefined);
      await ports.egress.revoke({ runtime: open.runtime, scope, fence: state.fence(scope), reason: "completed" }).catch(() => undefined);
    }
    const saved = await state.load();
    if (saved.phase === "released") { await state.retryDiscards(saved); return; }
    const handle = open?.handle ?? recordedHandle(saved);
    if (handle !== undefined) await ports.sandbox.release({ scope, handle });
    await state.apply(saved, { type: "release" });
  }

  /** A store or the outputs added to an open sandbox; a fresh open attaches them itself. */
  private async mountStorage(): Promise<void> {
    const state = this.state;
    const opening = state.current === null;
    const open = await openSandbox(state);
    if (opening) return;
    const execution = state.execution();
    const record = await state.record(open);
    if (record === null) {
      state.abandon();
      throw new SessionSandboxStateConflictError("Another writer changed the Session sandbox record while storage was mounted");
    }
    try {
      await attachStorage(state, open, new AbortController().signal);
    } catch (error) {
      await rollbackOpen(state, open, record, execution);
      throw error;
    }
  }

  /** `changes`: the call may change the sandbox (everything but reads), so it is due a snapshot. */
  private async call<T>(operation: (executor: SessionSandboxExecutor) => Promise<T>, changes = true): Promise<T> {
    const state = this.state;
    await state.quiesce();
    state.throwRefreshError();
    let open = await openSandbox(state);
    // Past the threshold during idle time: refresh now, in this gap (only
    // for an execution: idle activity renews nothing, design §0.0b A.10).
    if (state.inFlight === 0 && state.execution() !== undefined && lifetimeDue(state, open)) {
      await refreshLifetime(state, open);
      state.throwRefreshError();
      open = await openSandbox(state);
    }
    state.inFlight += 1;
    if (changes) state.dirty = true;
    try {
      await renewAtExecBoundary(state, open);
      return await operation(open.executor);
    } catch (error) {
      const name = (error as { name?: unknown } | null)?.name;
      if (name === "SandboxGoneError" || name === "SandboxNotFoundError" || name === "SandboxNotRunningError") state.markLost();
      throw error;
    } finally {
      state.inFlight -= 1;
      // The last call returned: the model is thinking. Refresh in the background.
      const current = state.current;
      if (state.inFlight === 0 && current !== null && state.execution() !== undefined && lifetimeDue(state, current)) void refreshLifetime(state, current);
      // ...and snapshot a changed sandbox once the interval passed (inside an
      // execution: nothing in the idle window touches the sandbox, design §0.0b A.10).
      else if (state.inFlight === 0 && current !== null && state.refreshing === null && state.execution() !== undefined && snapshotDue(state)) void snapshotInGap(state, current);
    }
  }
}
