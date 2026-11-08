// The Session sandbox core over the Sandbox SDK v2 Ports
// (research/sandbox-sdk-v2-design.md §0.1), shared by the Cloudflare
// SessionDO and the Node Session runner (design §0.0 rule 15). Hosts keep
// talking to a SandboxExecutor; this class calls only SandboxPorts. Hosts
// only compose (session-sandbox-options.ts): createSandboxPorts + an
// adapter, the handle record, scope, plan, fence and idle timer.
//
// Each lifecycle step is its own module: opening (session-sandbox-open),
// egress and storage (session-sandbox-storage-egress), exec-boundary
// renewals (session-sandbox-renewal), the lifetime refresh
// (session-sandbox-lifetime), the idle pause (session-sandbox-idle-pause)
// and the execution end (session-sandbox-execution-end), over one
// LiveSessionSandbox state. A sandbox that disappears while Memory or
// outputs are attached is remembered: the next syncStorage throws
// SandboxGoneError instead of publishing nothing (design §0.0 rule 16).

import type { MemoryStoreBinding, SandboxDuplexProcess, SandboxDuplexProcessSpec, SandboxExecutor } from "@open-managed-agents/sandbox";
import { endExecution, failExecution } from "./session-sandbox-execution-end";
import { disarmIdle, idlePause, touchIdle } from "./session-sandbox-idle-pause";
import { lifetimeDue, refreshLifetime } from "./session-sandbox-lifetime";
import { LiveSessionSandbox, mergeStores } from "./session-sandbox-live";
import { openSandbox, rollbackOpen } from "./session-sandbox-open";
import type { PortsSessionSandboxOptions, SessionSandboxExecutor } from "./session-sandbox-options";
import { renewActivityTimeout, renewAtExecBoundary } from "./session-sandbox-renewal";
import { attachStorage, syncStorage } from "./session-sandbox-storage-egress";

export class PortsSessionSandbox<R> implements SandboxExecutor {
  private readonly state: LiveSessionSandbox<R>;

  constructor(options: PortsSessionSandboxOptions<R>) {
    this.state = new LiveSessionSandbox(options);
  }

  async exec(command: string, timeout?: number): Promise<string> { return this.call((e) => e.exec(command, timeout)); }
  startProcess(command: string) { return this.call((e) => e.startProcess(command)); }
  spawnDuplexProcess(spec: SandboxDuplexProcessSpec): Promise<SandboxDuplexProcess> { return this.call((e) => e.spawnDuplexProcess(spec)); }
  readFile(path: string) { return this.call((e) => e.readFile(path)); }
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

  /** Turn end / before stop write-back (session-sandbox-storage-egress). */
  syncStorage(reason: "turn_end" | "before_stop"): Promise<void> { return syncStorage(this.state, reason); }
  /** Execution end: the sandbox keeps running until the idle pause. */
  endExecution(): Promise<void> { return endExecution(this.state); }
  /** The idle timer fired. */
  idlePause(): Promise<"paused" | "skipped"> { return idlePause(this.state); }
  /** A failed execution: nothing published, the sandbox released. */
  failExecution(): Promise<void> { return failExecution(this.state); }
  /** The fence was lost: exit without writing back, pausing or releasing. */
  abandon(): void { this.state.abandon(); }
  renewActivityTimeout(): Promise<void> { return renewActivityTimeout(this.state); }

  /** Session end: storage.detach, egress.revoke, release, discard the restore point. */
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
    const saved = await state.options.state.load();
    const handle = open?.handle ?? saved?.handle;
    if (handle !== undefined) await ports.sandbox.release({ scope, handle });
    if (saved?.resumeRef !== undefined) await ports.sandbox.discard({ scope, ref: saved.resumeRef }).catch(() => undefined);
    await state.options.state.clear();
  }

  /** A store or the outputs added to an open sandbox; a fresh open attaches them itself. */
  private async mountStorage(): Promise<void> {
    const state = this.state;
    const opening = state.current === null;
    const open = await openSandbox(state);
    if (opening) return;
    try {
      await state.record(open);
      await attachStorage(state, open, new AbortController().signal);
    } catch (error) {
      await rollbackOpen(state, open);
      throw error;
    }
  }

  private async call<T>(operation: (executor: SessionSandboxExecutor) => Promise<T>): Promise<T> {
    const state = this.state;
    await state.quiesce();
    state.throwRefreshError();
    touchIdle(state);
    let open = await openSandbox(state);
    // Past the threshold during idle time: refresh now, in this gap.
    if (state.inFlight === 0 && lifetimeDue(state, open)) {
      await refreshLifetime(state, open);
      state.throwRefreshError();
      open = await openSandbox(state);
    }
    state.inFlight += 1;
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
      if (state.inFlight === 0 && current !== null && lifetimeDue(state, current)) void refreshLifetime(state, current);
    }
  }
}
