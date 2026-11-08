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
import type { RuntimeResourceFence, RuntimeResourceScope } from "@open-managed-agents/runtime-resource-contract";

export const SANDBOX_GENERATION_MARKER = "/tmp/.oma-warm";

/** What SessionDO calls on a sandbox runtime. */
export type SessionSandboxExecutor = Pick<SandboxExecutor, "exec" | "readFile" | "writeFile"> & {
  startProcess(command: string): Promise<ProcessHandle | null>;
  spawnDuplexProcess(spec: SandboxDuplexProcessSpec): Promise<SandboxDuplexProcess>;
  writeFileBytes(path: string, bytes: Uint8Array): Promise<string>;
  setEnvVars(env: Record<string, string>): Promise<void>;
};

export interface SessionSandboxState { handle: SandboxHandle; stores: MemoryStoreBinding[]; outputs: boolean }

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
}

interface Live<R> { runtime: R; handle: SandboxHandle; executor: SessionSandboxExecutor; generation: string; plan: SandboxPlan }

export class PortsSessionSandbox<R> implements SandboxExecutor {
  private live: Live<R> | null = null;
  private opening: Promise<Live<R>> | null = null;
  private composed: Promise<{ ports: SandboxPorts<R> }> | null = null;
  private env: Record<string, string> = {};
  private stores: MemoryStoreBinding[] = [];
  private outputs = false;

  constructor(private readonly options: PortsSessionSandboxOptions<R>) {}

  async exec(command: string, timeout?: number): Promise<string> { return this.call((e) => e.exec(command, timeout)); }
  startProcess(command: string) { return this.call((e) => e.startProcess(command)); }
  spawnDuplexProcess(spec: SandboxDuplexProcessSpec): Promise<SandboxDuplexProcess> { return this.call((e) => e.spawnDuplexProcess(spec)); }
  readFile(path: string) { return this.call((e) => e.readFile(path)); }
  writeFile(path: string, content: string) { return this.call((e) => e.writeFile(path, content)); }
  writeFileBytes(path: string, bytes: Uint8Array) { return this.call((e) => e.writeFileBytes(path, bytes)); }

  async setEnvVars(env: Record<string, string>): Promise<void> {
    this.env = { ...this.env, ...env };
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
    this.live = null;
    return (await this.open()).generation;
  }

  /** Turn end / before stop: storage.sync. Native mounts make it a no-op. */
  async syncStorage(reason: "turn_end" | "before_stop"): Promise<void> {
    if (this.live === null || (!this.outputs && this.stores.length === 0)) return;
    const { ports } = await this.compose();
    const scope = this.options.scope();
    await ports.storage.sync({ runtime: this.live.runtime, scope, fence: fenceFor(scope), stores: this.stores, outputs: this.live.plan.outputs, reason, signal: new AbortController().signal });
  }

  /** keepAlive on the live sandbox, else on the saved one (an alarm-only
   * wake keeps a background task's sandbox alive). */
  async renewActivityTimeout(): Promise<void> {
    const { ports } = await this.compose();
    if (this.live !== null) {
      if (await ports.sandbox.keepAlive(this.live) === "gone") this.live = null;
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
    return this.composed ??= this.options.compose();
  }

  private async attachStorage(): Promise<void> {
    const opened = this.live === null;
    const live = await this.open();
    // A fresh open already attached the current stores and outputs.
    if (opened) return;
    try {
      await this.options.state.save({ handle: live.handle, stores: this.stores, outputs: this.outputs });
      const { ports } = await this.compose();
      const scope = this.options.scope();
      await ports.storage.attach({ runtime: live.runtime, scope, fence: fenceFor(scope), stores: this.stores, outputs: live.plan.outputs, signal: new AbortController().signal });
    } catch (error) {
      await this.rollback(live);
      throw error;
    }
  }

  private async call<T>(operation: (executor: SessionSandboxExecutor) => Promise<T>): Promise<T> {
    const live = await this.open();
    try {
      return await operation(live.executor);
    } catch (error) {
      const name = (error as { name?: unknown } | null)?.name;
      if (name === "SandboxGoneError" || name === "SandboxNotFoundError" || name === "SandboxNotRunningError") this.live = null;
      throw error;
    }
  }

  private open(): Promise<Live<R>> {
    if (this.live !== null) return Promise.resolve(this.live);
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
        // A provider-assigned handle is recorded before the sandbox is used.
        if (ports.sandbox.handle === "changes") await this.options.state.save({ handle: opened.handle, stores: this.stores, outputs: this.outputs });
      }
    } catch (error) {
      if (opened !== "gone") await this.rollback(opened);
      throw error;
    }
    const live: Live<R> = { ...opened, executor: this.options.executor(opened.runtime), generation, plan };
    try {
      if (Object.keys(this.env).length > 0) await live.executor.setEnvVars(this.env);
      const fence = fenceFor(scope);
      await ports.egress.attach({ runtime: live.runtime, scope, fence, policy: plan.egress, signal });
      if (this.outputs || this.stores.length > 0) {
        await ports.storage.attach({ runtime: live.runtime, scope, fence, stores: this.stores, outputs: plan.outputs, signal });
      }
      if (!reused) await writeMarker(live.executor, generation);
      await this.options.state.save({ handle: live.handle, stores: this.stores, outputs: this.outputs });
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
