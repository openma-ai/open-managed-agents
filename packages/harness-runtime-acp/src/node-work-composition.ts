import { createWorkVerifierExec } from "./node-work-verifier.js";
import { createExecutionChannelsHttpResolver } from "./execution-channels-http.js";
import { withUngatedPermissionProfiles } from "./ungated-permission-mode.js";
import { managedMcpProxyFromWorkEnvironment } from "@open-managed-agents/acp-runtime/sandbox-agent";
import type { ManagedAcpExecutionChannels } from "@open-managed-agents/shared/acp-execution-channels-rpc";
import type { AcpRuntime, AcpSession, Spawner, SessionOptions } from "@open-managed-agents/acp-runtime";
import { createAcpRuntime as createPlacedAcpRuntime } from "@open-managed-agents/acp-runtime/placement";
import { NodeSpawner } from "@open-managed-agents/acp-runtime/node-spawner";
import type { WorkControlRuntime, WorkFinalizationContext } from "./work-control-runtime.js";
import type { WorkRunnerComposition } from "./node-work-item.js";

/** Trusted code-only module seam for source validation. Never resolve paths from
 * the Work environment, agent metadata, or workspace. Production always loads
 * the published package exports. */
export interface WorkRuntimeModules {
  control: WorkControlRuntime;
  createAcpRuntime(spawner: Spawner): AcpRuntime;
}
export interface DefaultWorkCompositionOptions {
  modules?: WorkRuntimeModules;
  workspacePath?: string;
  environment?: Readonly<Record<string, string | undefined>>;
  fetch?: typeof globalThis.fetch;
  resolveExecutionChannels?: import("./node-supervisor.js").NodeManagedAcpSupervisorAppOptions["resolveExecutionChannels"];
  spawner?: Spawner;
  activities?: WorkTurnActivities;
  /** Host filesystem adapter (E2B supplies its isolated implementation). */
  stateIo?: import("./node.js").NodeAcpHarnessStateIo;
}

export async function loadWorkRuntimeModules(): Promise<WorkRuntimeModules> {
  const managed = await import("@openma/common/managed-runtime");
  const acp = await import("@openma/common/acp-runtime");
  const exports = managed as unknown as Record<string, unknown>;
  const permission = (acp as unknown as Record<string, unknown>).applyAcpPermissionMode;
  if (typeof exports.ManagedHarnessFinalizationError !== "function" || typeof permission !== "function"
    || typeof managed.createManagedAcpSupervisorHarness !== "function" || typeof managed.createManagedHarnessHttpControlChannel !== "function") {
    throw new Error("@openma/common lacks required gated dispatch/finalization and permission capabilities; install common >=0.14.0 before running Work");
  }
  return {
    control: {
      createSupervisor: managed.createManagedAcpSupervisorHarness as WorkControlRuntime["createSupervisor"],
      createControlChannel: managed.createManagedHarnessHttpControlChannel as WorkControlRuntime["createControlChannel"],
      applyPermissionMode: withUngatedPermissionProfiles(permission as WorkControlRuntime["applyPermissionMode"]),
    },
    createAcpRuntime: spawner => createPlacedAcpRuntime({ type: "local", spawner }),
  };
}

/** One registry per resident runner. It owns actual host completion promises,
 * not an event projector. ACP promptComplete proves only the prompt RPC ended.
 * Pinned adapters can prove foreground tool completion at prompt return.
 * Detached tool/subagent events NEVER substitute for a host-owned join. Such a
 * provider must register tool:<toolCallId> with its actual completion promise
 * before dispatch; otherwise finalization fails closed. Detached descendants
 * must be included in that promise (not merely the spawning tool's RPC).
 * There is intentionally no "mark drained" or agent-accessible registration. */
export class WorkTurnActivities {
  private turn: string | undefined;
  private closed = true;
  private drained = false;
  private prompts = 0;
  private completions = 0;
  private inFlightPrompts = 0;
  private joins = new Map<string, Promise<void>>();
  private opaque = new Set<string>();
  private nativeTools = new Map<string, { kind?: string; status?: string; detached: boolean; exited: boolean }>();
  private nativeContract = false;
  private terminalStatusProvesExit = false;
  private children = new Map<string, boolean>();
  private invalid: Error | undefined;
  private sequence = 0;

  admit(turnId: string): void {
    if (this.turn === turnId && !this.closed) return; // steer keeps original root
    if (this.turn !== undefined) throw new Error("Activity admission overlaps an unpublished turn");
    this.turn = turnId;
    this.closed = false;
    this.drained = false;
    this.prompts = this.completions = this.inFlightPrompts = 0;
    this.joins.clear(); this.opaque.clear(); this.nativeTools.clear(); this.children.clear(); this.invalid = undefined;
  }

  register(turnId: string, id: string, completion: Promise<unknown>): void {
    if (this.closed || this.turn !== turnId) throw new Error("Work activity admission is closed or belongs to another turn");
    if (!id || this.joins.has(id)) throw new Error("Duplicate Work activity identity");
    const joined = completion.then(() => undefined);
    // Observe immediately, retain failure for drain (never convert to success).
    void joined.catch(() => undefined);
    this.joins.set(id, joined);
  }

  published(turnId: string): void {
    if (this.turn !== turnId || !this.closed || !this.drained || this.invalid) throw new Error("Work activity publication without sealed drain");
    this.turn = undefined;
  }

  async drain(context: WorkFinalizationContext): Promise<void> {
    if (this.turn !== context.command.turnId) throw new Error("Work activity drain identity mismatch");
    this.closed = true;
    context.signal.throwIfAborted();
    if (this.inFlightPrompts || !this.prompts || this.prompts !== this.completions) {
      throw new Error("ACP prompt completion is unproven");
    }
    await abortableJoin(Promise.all(this.joins.values()), context.signal);
    if (this.invalid) throw this.invalid;
    for (const [id, tool] of this.nativeTools) {
      const synchronous = this.nativeContract && !tool.detached
        && (tool.status === "completed" || tool.status === "failed")
        && tool.kind !== undefined && (tool.kind !== "execute" || tool.exited || this.terminalStatusProvesExit);
      if (!synchronous && !this.joins.has(id)) throw new Error(`Work native activity completion unproven: ${id}`);
    }
    for (const [id, done] of this.children) {
      if (!done && !this.joins.has(`child:${id}`)) throw new Error(`Work native child completion unproven: ${id}`);
    }
    for (const id of this.opaque) {
      if (!this.joins.has(id)) throw new Error(`Work activity completion unproven: ${id}; provider must supply an actual tool/subagent join`);
    }
    context.signal.throwIfAborted();
    this.drained = true;
  }

  wrapRuntime(runtime: AcpRuntime): AcpRuntime {
    return { start: async options => {
      const callbacks = Object.fromEntries(Object.entries(options.clientCallbacks ?? {}).map(([name, callback]) => [name,
        (...args: unknown[]) => {
          if (!this.turn || this.closed) return Promise.reject(new Error("Work callback activity admission is closed"));
          // Register before invoking; callbacks can spawn further registered work.
          const operation = Promise.resolve().then(() => (callback as (...args: unknown[]) => unknown)(...args));
          this.register(this.turn, `callback:${name}:${++this.sequence}`, operation);
          // terminal/create returns a handle, NOT process exit. Without a
          // separately registered terminal exit join it cannot be checkpointed.
          if (["createTerminal", "extensionRequest", "extensionNotification", "messageMcp", "notifyMcp", "connectMcp"].includes(name)) {
            this.opaque.add(`opaque-callback:${name}:${this.sequence}`);
          }
          return operation;
        },
      ])) as SessionOptions["clientCallbacks"];
      const overlay = options.clientCapabilityOverlay ?? {};
      const meta = record(overlay._meta), jetbrains = record(meta.jetbrains), air = record(jetbrains.air);
      const session = await runtime.start({ ...options, clientCallbacks: callbacks,
        clientCapabilityOverlay: { ...overlay, _meta: { ...meta, jetbrains: { ...jetbrains, air: {
          ...air, version: 1, capabilities: [...new Set([...(Array.isArray(air.capabilities) ? air.capabilities : []), "asyncTasks"])],
        } } } },
        onOutOfBandSessionUpdate: event => { this.observe(event); options.onOutOfBandSessionUpdate?.(event); },
      });
      // Exact audited versions. New adapters must supply the same native
      // contract or actual host joins; a self-reported generic ACP version is
      // not enough to certify detached execution.
      const info = session.agentInfo;
      // @openma/pi-acp 0.1.8: pi's agent loop resolves a prompt only after
      // every tool execution ended, and its shell tool emits the terminal
      // tool_call_update only after waiting for the shell's exit (no exit_code
      // field is projected). A terminal execute status is therefore its exit.
      const pi = info?.version === "0.1.8" && info?.name === "openma-pi-acp";
      this.nativeContract = (["0.75.1", "0.94.0"].includes(info?.version ?? "") && ["claude-agent-acp", "@agentclientprotocol/claude-agent-acp"].includes(info?.name ?? ""))
        || (info?.version === "1.8.0" && ["codex-acp", "@agentclientprotocol/codex-acp"].includes(info?.name ?? ""))
        || pi;
      this.terminalStatusProvesExit = pi;
      const activities = this;
      return new Proxy(session, { get(target, property) {
        if (property === "steer") return async (...args: Parameters<AcpSession["steer"]>) => {
          if (!activities.turn || activities.closed) throw new Error("Work steer activity admission is closed");
          const operation = target.steer(...args).then(result => {
            if (result === "startedNewTurn") {
              activities.invalid = new Error("Detached ACP steer completion is unproven");
              throw activities.invalid;
            }
            return result;
          });
          activities.register(activities.turn, `steer:${++activities.sequence}`, operation);
          return operation;
        };
        if (property === "prompt") return async function*(...args: Parameters<AcpSession["prompt"]>) {
          if (!activities.turn || activities.closed) throw new Error("Work prompt activity admission is closed");
          activities.prompts++; activities.inFlightPrompts++;
          let completed = false;
          try {
            for await (const event of target.prompt(...args)) {
              activities.observe(event);
              if (record(event).type === "promptComplete") completed = true;
              yield event;
            }
            if (completed) activities.completions++;
          } finally { activities.inFlightPrompts--; }
        };
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      } });
    } };
  }

  private observe(value: unknown): void {
    const event = record(value);
    const update = record(event.update);
    const tool = typeof event.sessionUpdate === "string" ? event : update;
    const tag = tool.sessionUpdate;
    if (tag === "tool_call" || tag === "tool_call_update") {
      const id = typeof tool.toolCallId === "string" ? `tool:${tool.toolCallId}` : "unknown-tool";
      if (!this.turn || this.closed) this.invalid = new Error("Unproven activity arrived after admission closed");
      const previous = this.nativeTools.get(id) ?? { detached: false, exited: false };
      const input = record(tool.rawInput), output = record(tool.rawOutput), meta = record(tool._meta);
      const air = record(record(meta.jetbrains).air), codex = record(meta.codex);
      const collaboration = record(codex.collaboration), subagent = record(codex.subagent);
      const toolResponse = record(record(meta.claudeCode).toolResponse);
      const detached = toolResponse.isAsync === true || toolResponse.status === "async_launched" || input.run_in_background === true || input.background === true || output.isAsync === true
        || typeof output.backgroundTaskId === "string" || typeof output.task_id === "string"
        || record(air.asyncTasks).backgrounded === true;
      this.nativeTools.set(id, { kind: typeof tool.kind === "string" ? tool.kind : previous.kind,
        status: typeof tool.status === "string" ? tool.status : previous.status,
        detached: previous.detached || detached,
        exited: previous.exited || Number.isInteger(output.exit_code) || Number.isInteger(record(meta.terminal_exit).exit_code),
      });
      if (typeof subagent.threadId === "string") this.children.set(subagent.threadId, subagent.activity === "interrupted");
      const ids = collaboration.receiverThreadIds;
      if (Array.isArray(ids)) for (const child of ids) {
        if (typeof child !== "string") continue;
        const operation = collaboration.tool;
        if (["spawnAgent", "sendInput", "resumeAgent"].includes(String(operation))) this.children.set(child, false);
        if (tool.status === "completed" && operation === "closeAgent") this.children.set(child, true);
        if (tool.status === "completed" && operation === "wait") {
          const state = record(record(input.agentsStates ?? output.status)[child]);
          if (["completed", "failed", "errored", "cancelled", "interrupted"].includes(String(state.status))
            || state.completed !== undefined || state.failed !== undefined) this.children.set(child, true);
        }
      }
    } else if (typeof tag === "string" && tag.startsWith("subagent_")) {
      // Codex's portable child router can synthesize failed on a timeout;
      // display terminal state is not a native child-exit acknowledgement.
      this.opaque.add(`child:${String(tool.sessionId ?? tool.subagentSessionId)}`);
      if (!this.turn || this.closed) this.invalid = new Error("Unproven activity arrived after admission closed");
    } else if (typeof tag === "string" && tag.startsWith("async_task_")) {
      // Native async lifecycle is provider-owned. Until its exit join is wired,
      // never infer completion from the spawning tool or display task status.
      this.opaque.add(`async-task:${String(tool.asyncTaskId)}`);
      if (!this.turn || this.closed) this.invalid = new Error("Unproven activity arrived after admission closed");
    } else if (event.schema_version === "oma.event.v1" && record(event.data).kind === "agent") {
      this.opaque.add(`child:${String(event.work_item_id)}`);
      if (!this.turn || this.closed) this.invalid = new Error("Unproven activity arrived after admission closed");
    }
  }
}
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
async function abortableJoin(operation: Promise<unknown>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  let abort!: () => void;
  try {
    await Promise.race([operation, new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
    })]);
  } finally { signal.removeEventListener("abort", abort); }
}

export function createDefaultWorkComposition(options: DefaultWorkCompositionOptions = {}): WorkRunnerComposition {
  return async context => {
    const modules = options.modules ?? await loadWorkRuntimeModules();
    const environment = options.environment ?? process.env;
    const capability = managedMcpProxyFromWorkEnvironment(environment);
    let channels: ManagedAcpExecutionChannels | undefined;
    const resolve = options.resolveExecutionChannels ?? (capability && environment.OPENMA_SANDBOX_TOKEN
      ? createExecutionChannelsHttpResolver({ apiBaseUrl: capability.gatewayBaseUrl, fetch: options.fetch }) : undefined);
    let publishOutcomeEvents: import("./node-work-outcomes.js").WorkOutcomePublisher | undefined;
    const control: WorkControlRuntime = { ...modules.control, createControlChannel(controlOptions) {
      // Coordinator supplies its ordered root-proof writer as this fetch port.
      // Reuse that EXACT port rather than constructing a second unauthenticated
      // outcome HTTP writer. The canonical claim/approval/lane checks stay there.
      const write = controlOptions.fetch;
      if (write) publishOutcomeEvents = async events => {
        const response = await write(`${controlOptions.apiBaseUrl.replace(/\/+$/u, "")}/v1/oma/sessions/${encodeURIComponent(context.claim.sessionId)}/runtime-events`, {
          method: "POST", headers: { authorization: `Bearer ${controlOptions.sessionsToken}`, "content-type": "application/json" }, body: JSON.stringify({ events }),
        });
        if (!response.ok) { await response.body?.cancel(); throw new Error(`Outcome canonical publication rejected (${response.status})`); }
        const receipt = await response.json() as {recorded?: unknown};
        if (receipt.recorded !== events.length) throw new Error("Outcome canonical publication receipt invalid");
      };
      return modules.control.createControlChannel(controlOptions);
    } };
    const activities = options.activities ?? new WorkTurnActivities();
    let runExec = createWorkVerifierExec(options.spawner ?? new NodeSpawner(), options.workspacePath ?? "/workspace");
    const createAcpRuntime = (spawner: Spawner) => {
      runExec = createWorkVerifierExec(spawner, options.workspacePath ?? "/workspace");
      return activities.wrapRuntime(modules.createAcpRuntime(spawner));
    };
    return {
      stateIo: options.stateIo,
      ...(resolve ? { resolveExecutionChannels: async (request: Parameters<NonNullable<typeof resolve>>[0]) => {
        const result = await resolve({ ...request, sessionsToken: options.resolveExecutionChannels ? request.sessionsToken : environment.OPENMA_SANDBOX_TOKEN! });
        if (result.type === "ready") channels = result.channels;
        return result;
      } } : {}),
      onTurnComplete: async turn => {
        if (!turn.command.input?.outcome) return;
        if (!capability) throw new Error("Work outcome capability unavailable");
        const { createWorkOutcomeCompletion } = await import("./node-work-outcomes.js");
        const completeOutcome = createWorkOutcomeCompletion({ sessionId: context.claim.sessionId,
          apiBaseUrl: capability.gatewayBaseUrl, sessionsToken: capability.sessionsToken, channels: () => channels, fetch: options.fetch, runExec,
        });
        if (!publishOutcomeEvents) throw new Error("Outcome canonical publication capability unavailable");
        await completeOutcome({ ...turn, publishOutcomeEvents });
      },
      control: { runtime: control },
      acpRuntime: createAcpRuntime(options.spawner ?? new NodeSpawner()),
      createAcpRuntime,
      finalization: { drainTurn: value => activities.drain(value) },
      onTurnAdmitted(turnId) { activities.admit(turnId); context.onTurnAdmitted(turnId); },
      onTurnPublished(turnId) { activities.published(turnId); context.onTurnPublished(turnId); },
    };
  };
}
