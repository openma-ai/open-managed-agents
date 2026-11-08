import {
  classifyTurnFailure,
  decideTurnStop,
  planTurnFailure,
  reportTurnFailure,
  SessionSandboxRuntime,
  type SessionSandboxMode,
  type TurnFailureClass,
  type TurnFailureEventsPort,
} from "@open-managed-agents/session-runtime";
import { abortableDelay, abortedError, linkAbort, untilAborted } from "@open-managed-agents/session-runtime-contract";
import {
  answeredToolCallIds,
  asWireEvents,
  outstandingRequiresAction,
  stillPending,
} from "@open-managed-agents/session-runtime-contract/requires-action";
import {
  probeSandboxLiveness,
  startSandboxHeartbeat,
  withSandboxExecutionGuard,
  withSandboxRecovery,
  workspaceRootOf,
  type SandboxExecutor,
  type SandboxLiveness,
} from "@open-managed-agents/sandbox";
import { randomUUID } from "node:crypto";
import { SessionRetriesExhaustedError } from "@open-managed-agents/session-runtime-contract/coordination";
import type {
  HarnessContext,
  HarnessInterface,
} from "@open-managed-agents/agent/harness/interface";
import type {
  Environment,
  Session,
  SessionEventView,
  SpanModelUsageView,
  ToolResultContentBlock,
} from "@open-managed-agents/managed-agents-application";
import { budgetReachedStopEvents, openSessionBudgetGate } from "@open-managed-agents/managed-agents-application";
import {
  type NodeManagedSessionRunner,
  type NodeManagedSessionRunnerAcceptInput,
  type StartNodeManagedSessionRuntime,
  type StopNodeManagedSessionRuntime,
  type ArchiveNodeManagedSessionThread,
  type CommittedExecutionTerminal,
} from "./node-managed-session-runtime.js";
import type { SessionExecutionFence } from "@open-managed-agents/session-runtime-contract/coordination";
import { ManagedNodeHarnessRuntime } from "./node-managed-harness-runtime.js";
import { interruptRequiresActionClosure } from "@open-managed-agents/agent/runtime/history";
import { encodeRuntimeHistoryEvent } from "@open-managed-agents/managed-agents-adapters-runtime";
import type { SessionEvent } from "@open-managed-agents/api-types";
import type { SessionBudgetGate } from "@open-managed-agents/domain/sessions";
import {
  clearNodeSessionBudgetGate,
  registerNodeSessionBudgetGate,
} from "./node-session-budget-gates.js";
import type { ModelPricing } from "@open-managed-agents/api-types";
import type { WorkspaceBinding, WorkspacePersistencePort, RuntimeResourceScope } from "@open-managed-agents/runtime-resource-contract";
import type { NodeManagedWorkspaceCheckpoints } from "./node-managed-workspace-checkpoints.js";
import { ScopedSessionMap } from "./scoped-session-map.js";
import { createSessionOutcomes } from "@open-managed-agents/session-outcomes";
import {
  ManagedNodeSubagents,
  managedEventThread,
  type ManagedNodeCreateSubagent,
  type ManagedNodeSubagentControl,
  type ManagedNodeSubagentPolicy,
  type ManagedNodeSubagentThreads,
} from "./node-managed-subagents.js";

export type { ManagedNodeSubagentControl } from "./node-managed-subagents.js";

/** Abort reason of a turn ended by user.interrupt (worker cancel and accept). */
const INTERRUPT_REQUESTED = "interrupt_requested";

interface ManagedRunnerSubagentContext {
  subagents?: ManagedNodeSubagentControl;
  delegateToAgent?: (agentId: string, message: string) => Promise<string>;
}

interface ManagedRunnerContext {
  workspaceId: string;
  session: Session;
  environment: Environment;
}

interface AcquiredSandbox {
  sandbox: SandboxExecutor;
  runtime: SessionSandboxRuntime;
  workspace: ManagedWorkspaceState | undefined;
  runtimeGeneration: string;
  /** When the restored workspace checkpoint was published; null if none. */
  restoredFromMs: number | null;
}

interface ManagedWorkspaceState {
  port: WorkspacePersistencePort;
  binding: WorkspaceBinding;
  scope: RuntimeResourceScope;
  fence: SessionExecutionFence;
  activeId: string | null;
  /** A failed/interrupted turn may leave bytes that were never published. */
  trusted: boolean;
}

export type ManagedNodeToolConfirmation = Extract<
  NodeManagedSessionRunnerAcceptInput["events"][number],
  { type: "user.tool_confirmation" }
>;

export type ManagedNodeConfirmableToolUse = Extract<
  SessionEventView,
  { type: "agent.tool_use" | "agent.mcp_tool_use" }
>;

import { processSessionClocks, type SessionClockRegistry } from "./session-clocks.js";
export interface ExecuteManagedNodeConfirmedTool {
  workspaceId: string;
  session: Session;
  environment: Environment;
  sandbox: SandboxExecutor;
  confirmation: ManagedNodeToolConfirmation;
  toolUse: ManagedNodeConfirmableToolUse;
  abortSignal: AbortSignal;
}

export interface ManagedNodeConfirmedToolExecutionResult {
  content?: ToolResultContentBlock[];
  isError?: boolean | null;
}

export interface ManagedNodeConfirmedToolExecutionPort {
  execute(
    input: ExecuteManagedNodeConfirmedTool,
  ): Promise<ManagedNodeConfirmedToolExecutionResult>;
}

export type ManagedNodeDefinedOutcome = Extract<
  NodeManagedSessionRunnerAcceptInput["events"][number],
  { type: "user.define_outcome" }
>;

export interface EvaluateManagedNodeOutcome {
  workspaceId: string;
  session: Session;
  environment: Environment;
  outcome: ManagedNodeDefinedOutcome;
  historyEvents: SessionEventView[];
  iteration: number;
  abortSignal: AbortSignal;
}

export interface ManagedNodeOutcomeEvaluationResult {
  result: "satisfied" | "needs_revision" | "failed";
  explanation: string;
  usage: SpanModelUsageView;
}

export interface ManagedNodeOutcomeEvaluationPort {
  evaluate(
    input: EvaluateManagedNodeOutcome,
  ): Promise<ManagedNodeOutcomeEvaluationResult>;
}

export interface DefaultNodeManagedSessionRunnerDependencies {
  /** Shared per-session processed_at clocks (#398); defaults to process-wide. */
  sessionClocks?: SessionClockRegistry;
  /**
   * In-place retry of a harness failure while the turn has produced no
   * `agent.*` event (e.g. the model call failed before producing output). Each
   * retry emits `session.error{retrying}` + `session.status_rescheduled`.
   * Default: 3 attempts, backoff min(30s, 2s * 2^(n-1)).
   */
  harnessRetry?: { attempts: number; delayMs(attempt: number): number };
  subagentThreads?: ManagedNodeSubagentThreads;
  subagentPolicy?(input: ManagedRunnerContext): ManagedNodeSubagentPolicy | Promise<ManagedNodeSubagentPolicy>;
  resolveSubagentSession?(input: ManagedRunnerContext & { request: ManagedNodeCreateSubagent }): Promise<Session>;
  confirmedTools: ManagedNodeConfirmedToolExecutionPort;
  outcomes: ManagedNodeOutcomeEvaluationPort;
  sandboxMode?(input: ManagedRunnerContext): SessionSandboxMode | Promise<SessionSandboxMode>;
  /** Start Pi's sandbox alongside the model; only sandbox operations wait for readiness. */
  backgroundPiSandbox?: boolean;
  /** `runtimeGeneration` and `executionFence`: the allocation and execution this sandbox opens for. */
  buildSandbox(input: ManagedRunnerContext & {
    signal?: AbortSignal;
    allocationId?: string;
    runtimeGeneration?: string;
    executionFence?: SessionExecutionFence;
  }): Promise<SandboxExecutor>;
  /** Liveness probe used before reusing a warm sandbox and after a failed
   * sandbox operation. Default: the provider runtime Port's `status()`. */
  probeSandbox?(sandbox: SandboxExecutor): Promise<SandboxLiveness>;
  /** Provider lease renewed while a turn runs (ADR 0005 sandbox heartbeat).
   * After the turn the sandbox lives at most `ttlMs` idle; the next turn
   * then cold-restores. Omit to leave the provider's own lifetime alone. */
  sandboxLease?: { ttlMs: number; intervalMs?: number };
  /** Lost sandboxes replaced within one turn before it fails (default 3). */
  maxSandboxReplacements?: number;
  /** Optional checkpoint_restore workspace. Ordinary OSS mounts are a different strategy. */
  workspaceCheckpoints?: NodeManagedWorkspaceCheckpoints;
  prepareSandbox?(input: ManagedRunnerContext & {
    sandbox: SandboxExecutor;
    runtimeGeneration: string;
    signal?: AbortSignal;
    /** The execution this sandbox is acquired for; absent outside a claim. */
    executionFence?: SessionExecutionFence;
  }): Promise<void>;
  /** Refresh lightweight Session environment after preparation and on every
   * warm reuse, without restaging resources or rebuilding the sandbox. */
  refreshSandboxEnvironment?(input: ManagedRunnerContext & {
    sandbox: SandboxExecutor;
    /** The execution the sandbox serves; its relay pass binds to it (design §0.0 rule 10). */
    executionFence?: SessionExecutionFence;
    /** Cleanup receives the raw, allocation-bound sandbox after refresh drains. */
    registerCleanup(cleanup: (sandbox: SandboxExecutor) => Promise<void>): void;
  }): Promise<void>;
  /** Fenced turn barrier for provider-neutral writable state reconciliation. */
  /** Extra runtime-state check before reusing a warm sandbox (for example
   * shared Session outputs advanced by another replica). */
  isSandboxCurrent?(input: ManagedRunnerContext & { runtimeGeneration: string }): Promise<boolean>;
  synchronizeSandbox?(input: ManagedRunnerContext & {
    sandbox: SandboxExecutor;
    runtimeGeneration: string;
    executionFence: SessionExecutionFence;
  }): Promise<void>;
  /** A failed (not aborted) execution: replaces `synchronizeSandbox` so
   * nothing is published (design §0.0 rule 16). Omitted: synchronizeSandbox. */
  failSandbox?(input: ManagedRunnerContext & {
    sandbox: SandboxExecutor;
    runtimeGeneration: string;
    executionFence: SessionExecutionFence;
  }): Promise<void>;
  /** Runs after all terminal facts have committed, while the execution still
   * owns its existing fence. Suitable for immutable output publication. */
  afterExecution?(input: ManagedRunnerContext & {
    sandbox: SandboxExecutor;
    runtimeGeneration: string;
    executionFence: SessionExecutionFence;
  }): Promise<void>;
  buildModel(input: ManagedRunnerContext): Promise<HarnessContext["model"]>;
  /** List prices of the session's model card; null = unpriced. Session
   * budgets are enforced only when this AND `session.budget` are set. */
  resolveModelPricing?(input: ManagedRunnerContext): Promise<ModelPricing | null>;
  buildTools(
    input: ManagedRunnerContext & ManagedRunnerSubagentContext & { sandbox: SandboxExecutor },
  ): Promise<HarnessContext["tools"]>;
  disposeTools?(tools: HarnessContext["tools"]): Promise<void>;
  buildHarness(): HarnessInterface;
  buildHarnessContext(input: ManagedRunnerContext & ManagedRunnerSubagentContext & {
    acceptedEvents: NodeManagedSessionRunnerAcceptInput["events"];
    executionFence?: SessionExecutionFence;
    sandbox: SandboxExecutor;
    runtime: ManagedNodeHarnessRuntime;
    model: HarnessContext["model"];
    tools: HarnessContext["tools"];
  }): Promise<HarnessContext>;
  clock: { now(): Date };
  ids: { nextEventId(): string };
  runtimeGenerations?: { next(): string };
}

function findLastMatching<T, S extends T>(
  values: readonly T[],
  predicate: (value: T) => value is S,
): S | undefined;
function findLastMatching<T>(
  values: readonly T[],
  predicate: (value: T) => boolean,
): T | undefined;
function findLastMatching<T>(
  values: readonly T[],
  predicate: (value: T) => boolean,
): T | undefined {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (value !== undefined && predicate(value)) return value;
  }
  return undefined;
}

export class DefaultNodeManagedSessionRunner
  implements NodeManagedSessionRunner
{
  private readonly sandboxRuntimes = new ScopedSessionMap<SessionSandboxRuntime>();
  private readonly sandboxes = new ScopedSessionMap<SandboxExecutor>();
  private readonly runtimeGenerations = new ScopedSessionMap<string>();
  private readonly sandboxConfigurationFingerprints = new ScopedSessionMap<string>();
  private readonly abortControllers = new ScopedSessionMap<AbortController>();
  private readonly startupAborts = new ScopedSessionMap<AbortController>();
  private readonly sandboxStarts = new ScopedSessionMap<Promise<void>>();
  private readonly subagentExecutions = new ScopedSessionMap<ManagedNodeSubagents>();
  private readonly workspaces = new ScopedSessionMap<ManagedWorkspaceState>();
  private readonly pendingSandboxDisposals = new ScopedSessionMap<Promise<void>>();
  private readonly sandboxRefreshes = new WeakMap<SandboxExecutor, {
    sandbox: SandboxExecutor;
    revoke: AbortController;
    pending?: Promise<void>;
    cleanups: Set<(sandbox: SandboxExecutor) => Promise<void>>;
  }>();

  constructor(
    private readonly dependencies: DefaultNodeManagedSessionRunnerDependencies,
  ) {}

  /** `lease_lost` means another owner will reclaim and re-run this execution:
   * the stale attempt must not tell the client its turn failed. */
  cancel(input: { workspaceId: string; sessionId: string; reason?: string }): void {
    this.abortControllers.get(input)?.abort(input.reason ?? "cancelled");
    this.startupAborts.get(input)?.abort(input.reason ?? "cancelled");
  }

  /** Returns only a prepared live runtime, scoped exactly like execution. */
  connectedSandbox(input: { workspaceId: string; sessionId: string }): SandboxExecutor | null {
    return this.sandboxes.get(input) ?? null;
  }

  async start(input: StartNodeManagedSessionRuntime): Promise<void> {
    const startup = this.beginSandboxStartup(input);
    if (this.canOverlapSandboxStartup(input)) {
      // Keep provisioning after a text-only turn finishes. A later sandbox
      // operation awaits startup (or retries it), while text can stream now.
      void startup.catch((error) => {
        console.warn(`[managed-runner] session ${input.sessionId}: background sandbox startup failed:`, error);
      });
      return;
    }
    await startup;
  }

  private canOverlapSandboxStartup(input: ManagedRunnerContext): boolean {
    return this.dependencies.backgroundPiSandbox === true
      && input.session.agent.openma?.harness === "pi"
      && this.dependencies.workspaceCheckpoints === undefined;
  }

  private sandboxFingerprint(input: ManagedRunnerContext): string {
    return JSON.stringify({
      resources: input.session.resources,
      skills: input.session.agent.skills,
      environment: input.environment.config,
      // A different catalog image needs a different sandbox, like packages.
      sandboxImage: input.environment.openma?.sandboxImage ?? null,
    });
  }

  private beginSandboxStartup(input: StartNodeManagedSessionRuntime): Promise<void> {
    const pending = this.sandboxStarts.get(input);
    if (pending !== undefined) return pending;
    const startup = this.startSandbox(input).finally(() => {
      if (this.sandboxStarts.get(input) === startup) this.sandboxStarts.delete(input);
    });
    this.sandboxStarts.set(input, startup);
    return startup;
  }

  private async startSandbox(input: StartNodeManagedSessionRuntime): Promise<void> {
    const startup = new AbortController();
    const unlinkParent = linkAbort(input.signal, startup);
    const signal = startup.signal;
    this.startupAborts.set(input, startup);
    try {
      if (signal.aborted) throw abortedError(signal);
      this.assertSandboxDisposed(input);
      const fingerprint = this.sandboxFingerprint(input);
      const existing = this.sandboxes.get(input);
      if (this.dependencies.workspaceCheckpoints !== undefined && input.executionFence === undefined) {
        throw new Error("Managed workspace checkpoint_restore requires a Session Execution fence");
      }
      const trusted = this.dependencies.workspaceCheckpoints === undefined || this.workspaces.get(input)?.trusted === true;
      let reusable = existing !== undefined
        && this.sandboxConfigurationFingerprints.get(input) === fingerprint
        && trusted;
      if (reusable && this.dependencies.isSandboxCurrent !== undefined) {
        reusable = await untilAborted(this.dependencies.isSandboxCurrent({
          workspaceId: input.workspaceId, session: input.session, environment: input.environment,
          runtimeGeneration: this.runtimeGenerations.get(input)!,
        }), signal);
      }
      // A warm sandbox may have been reclaimed by its provider since the last
      // turn (lifetime expiry, eviction). Never hand a lost sandbox to a turn.
      if (reusable && existing !== undefined) {
        reusable = await untilAborted(this.probe(existing), signal) !== "lost";
      }
      if (reusable && existing !== undefined) {
        try {
          await this.refreshSandboxEnvironment(input, existing, signal);
        } catch (error) {
          const failure = signal.aborted ? abortedError(signal) : error;
          // A successful status probe does not prove the command channel works.
          // Fail this start explicitly; only a later attempt may cold-restore.
          if (this.sandboxes.get(input) === existing) {
            await this.discardSandbox(input, { abortTurn: false }).catch(() => undefined);
          }
          throw failure;
        }
        return;
      }
      if (existing !== undefined) {
        await untilAborted(this.discardSandbox(input, { abortTurn: false }).catch(() => undefined), signal);
      }
      const acquired = await this.acquireSandbox(input, signal);
      this.installSandbox(input, acquired, fingerprint);
    } finally {
      unlinkParent();
      if (this.startupAborts.get(input) === startup) {
        this.startupAborts.delete(input);
      }
    }
  }

  private assertSandboxDisposed(input: { workspaceId: string; sessionId: string }): void {
    if (this.pendingSandboxDisposals.get(input) !== undefined) {
      throw new Error("Sandbox cleanup is incomplete; refusing to reacquire the Session resource");
    }
  }

  private async refreshSandboxEnvironment(
    context: ManagedRunnerContext & { executionFence?: SessionExecutionFence },
    sandbox: SandboxExecutor,
    signal: AbortSignal,
  ): Promise<void> {
    let refresh = this.sandboxRefreshes.get(sandbox);
    if (refresh === undefined) {
      const revoke = new AbortController();
      refresh = {
        sandbox: withSandboxExecutionGuard(sandbox, { isValid: () => !revoke.signal.aborted }),
        revoke, cleanups: new Set(),
      };
      this.sandboxRefreshes.set(sandbox, refresh);
    }
    // Keep proxy identity stable for sandbox-local credential lifecycle state.
    const unlink = linkAbort(signal, refresh.revoke);
    const pending = Promise.resolve().then(() => {
      if (signal.aborted) throw abortedError(signal);
      return this.dependencies.refreshSandboxEnvironment?.({
        ...context, sandbox: refresh.sandbox,
        registerCleanup: (cleanup) => { refresh.cleanups.add(cleanup); },
      });
    });
    refresh.pending = pending;
    try {
      await untilAborted(pending, signal);
    } finally {
      unlink();
    }
  }

  private probe(sandbox: SandboxExecutor): Promise<SandboxLiveness> {
    return (this.dependencies.probeSandbox ?? probeSandboxLiveness)(sandbox);
  }

  /** Acquire a sandbox, restore the canonical workspace and prepare Session
   * inputs. A sandbox is exposed only after all of it succeeded. */
  private async acquireSandbox(
    input: Pick<StartNodeManagedSessionRuntime, "workspaceId" | "sessionId" | "session" | "environment" | "executionFence">,
    signal: AbortSignal,
  ): Promise<AcquiredSandbox> {
    this.assertSandboxDisposed(input);
    const runtimeGeneration = this.dependencies.runtimeGenerations?.next()
      ?? `runtime_${randomUUID()}`;
    const context = { workspaceId: input.workspaceId, session: input.session, environment: input.environment };
    const runtime = new SessionSandboxRuntime({
      mode: () => this.dependencies.sandboxMode?.(context) ?? "sandbox",
      create: () => {
        if (signal.aborted) throw abortedError(signal);
        return this.dependencies.buildSandbox({ ...context, signal, runtimeGeneration,
          ...(this.dependencies.workspaceCheckpoints === undefined ? {} : { allocationId: runtimeGeneration }),
          ...(input.executionFence === undefined ? {} : { executionFence: input.executionFence }),
        });
      },
      prepare: async (sandbox) => {
        if (signal.aborted) throw abortedError(signal);
        await this.dependencies.prepareSandbox?.({
          ...context,
          sandbox,
          runtimeGeneration,
          signal,
          ...(input.executionFence === undefined ? {} : { executionFence: input.executionFence }),
        });
        if (signal.aborted) throw abortedError(signal);
        await this.refreshSandboxEnvironment({
          ...context,
          ...(input.executionFence === undefined ? {} : { executionFence: input.executionFence }),
        }, sandbox, signal);
      },
    });
    const allocation = runtime.acquire();
    const sandbox = await untilAborted(allocation, signal, async (created) => {
      await created.destroy?.().catch(() => undefined);
    });
    let workspace: ManagedWorkspaceState | undefined;
    let restoredFromMs: number | null = null;
    try {
      const checkpoints = this.dependencies.workspaceCheckpoints;
      if (checkpoints !== undefined) {
        const fence = input.executionFence!;
        const scope = {
          workspaceId: input.workspaceId,
          environmentId: input.environment.id,
          sessionId: input.sessionId,
          workId: fence.executionId,
        };
        const active = await untilAborted(checkpoints.active(scope), signal);
        restoredFromMs = active?.publishedAtMs ?? null;
        const port = checkpoints.port(sandbox);
        const runtimeFence = checkpoints.runtimeFence(fence, scope.environmentId);
        const binding = await untilAborted(port.materialize({
          scope, fence: runtimeFence, strategy: "checkpoint_restore",
          activeCheckpoint: active?.candidate ?? null,
          idempotencyKey: runtimeGeneration,
          signal,
        }), signal);
        workspace = { port, binding, scope, fence, activeId: active?.candidate.id ?? null, trusted: true };
        // A missing/corrupt published archive is a hard failure. Session
        // inputs and the harness must never observe an empty replacement.
        await untilAborted(port.attach({
          scope, fence: runtimeFence, strategy: "checkpoint_restore", binding,
          sandbox: { provider: "node", runtimeId: runtimeGeneration },
          signal,
        }), signal);
      }
      await untilAborted(runtime.prepare(), signal);
    } catch (error) {
      await this.disposeSandbox(input, sandbox, workspace).catch(() => undefined);
      throw error;
    }
    return { sandbox, runtime, workspace, runtimeGeneration, restoredFromMs };
  }

  private installSandbox(
    input: { workspaceId: string; sessionId: string },
    acquired: AcquiredSandbox,
    fingerprint: string,
  ): void {
    if (acquired.workspace !== undefined) this.workspaces.set(input, acquired.workspace);
    else this.workspaces.delete(input);
    this.sandboxRuntimes.set(input, acquired.runtime);
    this.sandboxes.set(input, acquired.sandbox);
    this.runtimeGenerations.set(input, acquired.runtimeGeneration);
    this.sandboxConfigurationFingerprints.set(input, fingerprint);
  }

  /** ADR 0005 "Sandbox disappears": reacquire, restore the last committed
   * workspace and continue the turn from its in-process event history. */
  private async replaceLostSandbox(
    input: NodeManagedSessionRunnerAcceptInput,
    lost: SandboxExecutor,
    signal: AbortSignal,
  ): Promise<string> {
    if (this.sandboxes.get(input) !== lost) return "";
    const fingerprint = this.sandboxConfigurationFingerprints.get(input) ?? "";
    const previousWorkspace = this.workspaces.get(input);
    await this.disposeSandbox(input, lost, previousWorkspace).catch(() => undefined);
    const acquired = await this.acquireSandbox(input, signal);
    if (signal.aborted) {
      await this.disposeSandbox(input, acquired.sandbox, acquired.workspace).catch(() => undefined);
      throw abortedError(signal);
    }
    // Until this turn reaches its barrier the replacement is as dirty as every
    // sandbox a turn has written to.
    if (acquired.workspace !== undefined) acquired.workspace.trusted = false;
    this.installSandbox(input, acquired, fingerprint);
    const root = await workspaceRootOf(acquired.sandbox);
    if (acquired.workspace === undefined) {
      return `Files created in ${root} before the restart are gone.`;
    }
    return acquired.restoredFromMs === null
      ? `${root} is back to its initial state; files created before the restart are gone.`
      : `${root} is back to its state as of ${new Date(acquired.restoredFromMs).toISOString().slice(0, 19).replace("T", " ")} UTC; files created after that are gone.`;
  }

  async stop(input: StopNodeManagedSessionRuntime): Promise<void> {
    this.startupAborts.get(input)?.abort();
    await this.sandboxStarts.get(input)?.catch(() => undefined);
    await this.discardSandbox(input);
  }

  /**
   * @param abortTurn cancel the Session turn that owns `abortControllers`.
   * Sandbox startup passes `false`: with `backgroundPiSandbox` the turn is
   * already running and is the caller awaiting this startup, so cancelling it
   * here would abort the very turn that is waiting for the sandbox.
   */
  private async discardSandbox(
    input: { workspaceId: string; sessionId: string },
    options: { abortTurn?: boolean } = {},
  ): Promise<void> {
    if (options.abortTurn !== false) {
      this.abortControllers.get(input)?.abort();
      this.abortControllers.delete(input);
    }
    const workspace = this.workspaces.get(input);
    this.workspaces.delete(input);
    const sandbox = this.sandboxes.get(input);
    this.sandboxes.delete(input);
    this.sandboxRuntimes.delete(input);
    this.runtimeGenerations.delete(input);
    this.sandboxConfigurationFingerprints.delete(input);
    await this.disposeSandbox(input, sandbox, workspace);
  }

  private async disposeSandbox(
    input: { workspaceId: string; sessionId: string },
    sandbox: SandboxExecutor | undefined,
    workspace?: ManagedWorkspaceState,
  ): Promise<void> {
    const refresh = sandbox === undefined ? undefined : this.sandboxRefreshes.get(sandbox);
    refresh?.revoke.abort();
    const release = async () => {
      if (workspace === undefined) return;
      // Release only the old binding; the published blob is immutable.
      await workspace.port.release({
        scope: workspace.scope,
        fence: this.dependencies.workspaceCheckpoints!.runtimeFence(workspace.fence, workspace.scope.environmentId),
        binding: workspace.binding,
      });
    };
    const previous = this.pendingSandboxDisposals.get(input);
    let physicallyDeleted = false;
    const destroy = previous ?? (async () => {
      // Revocation blocks late calls, but an already-started provider call may
      // still finish. Drain refresh before deleting a deterministic resource.
      await refresh?.pending?.catch(() => undefined);
      try {
        if (sandbox !== undefined && refresh !== undefined) {
          const cleanups = await Promise.allSettled([...refresh.cleanups].map((cleanup) => cleanup(sandbox)));
          for (const result of cleanups) if (result.status === "rejected") throw result.reason;
        }
      } finally {
        await sandbox?.destroy?.();
        physicallyDeleted = true;
      }
    })();
    if (previous === undefined && sandbox !== undefined) {
      this.pendingSandboxDisposals.set(input, destroy);
      const clearIfDeleted = () => {
        // Ancillary cleanup errors still reach the caller, but a successful
        // physical deletion cannot threaten the next allocation.
        if (physicallyDeleted && this.pendingSandboxDisposals.get(input) === destroy) this.pendingSandboxDisposals.delete(input);
      };
      void destroy.then(clearIfDeleted, clearIfDeleted);
    }
    // Bound the caller's wait, not the provider lifecycle. Keep the allocation
    // gate closed until deletion succeeds, including after timeout or rejection.
    const cleanup = new AbortController();
    const timeout = setTimeout(() => cleanup.abort(), 5_000);
    try {
      const results = await untilAborted(Promise.allSettled([release(), destroy]), cleanup.signal);
      for (const result of results) {
        if (result.status === "rejected") throw result.reason;
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  async accept(input: NodeManagedSessionRunnerAcceptInput): Promise<void> {
    if (input.events.some((event) => event.type === "user.interrupt")) {
      const active = this.abortControllers.get(input);
      active?.abort(INTERRUPT_REQUESTED);
      if (active === undefined) {
        // Official CMA: interrupt against an already-idle session is a no-op
        // (including idle requires_action). interruptRequiresActionClosure
        // returns no frames; pending event_ids stay outstanding.
        const wire = input.historyEvents.map((event) => encodeRuntimeHistoryEvent(event) as SessionEvent);
        for (const frame of interruptRequiresActionClosure(wire)) {
          await input.output({
            ...frame,
            id: this.dependencies.ids.nextEventId(),
            processed_at: (this.dependencies.sessionClocks ?? processSessionClocks)
              .forSession(input.workspaceId, input.sessionId)
              .stampIso(this.dependencies.clock.now().getTime()),
          });
        }
      }
      return;
    }
    const event = findLastMatching(
      input.events,
      (candidate) => candidate.type !== "system.message",
    );
    if (event === undefined) {
      throw new Error("Managed Node runner received no actionable event");
    }
    if (
      event.type !== "user.message" &&
      event.type !== "user.custom_tool_result" &&
      event.type !== "user.tool_result" &&
      event.type !== "user.tool_confirmation" &&
      event.type !== "user.define_outcome" &&
      // A budget update that lifted a budget_reached pause: continue the
      // harness from history with no new user input.
      !(event.type === "session.updated" && event.resume === true)
    ) {
      throw new Error(
        `Managed Node runner does not yet support ${event.type}`,
      );
    }
    if (input.committedTerminal !== undefined && input.executionFence !== undefined) {
      await this.finishCommittedExecution(input, input.executionFence, input.committedTerminal);
      return;
    }
    // requires_action answers (CMA): only answers to the parked idle's
    // outstanding calls have effect. A late answer to a closed call is a
    // no-effect (already stamped processed_at on accept); a partial batch
    // re-announces the remaining ids without sampling.
    let remainingAfterAnswers: string[] | null = null;
    const actionable = input.events.filter((candidate) => candidate.type !== "system.message");
    if (actionable.length > 0 && actionable.every((candidate) =>
      candidate.type === "user.custom_tool_result" || candidate.type === "user.tool_confirmation")) {
      const batchIds = new Set(input.events.map((candidate) => candidate.id));
      const priorWire = asWireEvents(input.historyEvents
        .filter((candidate) => !batchIds.has(candidate.id))
        .map((candidate) => encodeRuntimeHistoryEvent(candidate)));
      const before = outstandingRequiresAction(priorWire);
      const closedBefore = answeredToolCallIds(priorWire);
      const answeredNow = new Set(actionable.map((candidate) =>
        candidate.type === "user.custom_tool_result" ? candidate.customToolUseId
          : candidate.type === "user.tool_confirmation" ? candidate.toolUseId : ""));
      // Every call in the batch was already closed (interrupt/steer/earlier
      // answer): no effect, nothing resumes.
      if ([...answeredNow].every((id) => closedBefore.has(id))) return;
      if (before !== null) {
        if (![...answeredNow].some((id) => before.includes(id))) return;
        remainingAfterAnswers = before.filter((id) => !answeredNow.has(id));
      }
    }
    const deferred = this.canOverlapSandboxStartup(input);
    // Only the three execution primitives are needed by Pi's host-side tools.
    // Capability inspection must not allocate a provider resource.
    const unallocated: SandboxExecutor = {
      exec: async () => { throw new Error("Sandbox has not been acquired"); },
      readFile: async () => { throw new Error("Sandbox has not been acquired"); },
      writeFile: async () => { throw new Error("Sandbox has not been acquired"); },
    };
    const rawSandbox = this.sandboxes.get(input) ?? (deferred ? unallocated : undefined);
    if (rawSandbox === undefined) {
      throw new Error(`Session ${input.sessionId} sandbox was not started`);
    }
    const runtimeGeneration = this.runtimeGenerations.get(input)
      ?? (deferred ? `pending_${randomUUID()}` : undefined);
    if (runtimeGeneration === undefined) {
      throw new Error(`Session ${input.sessionId} runtime generation was not started`);
    }
    const checkpointService = this.dependencies.workspaceCheckpoints;
    const workspace = this.workspaces.get(input);
    if (checkpointService !== undefined) {
      if (input.executionFence === undefined || workspace === undefined) {
        throw new Error("Managed workspace checkpoint_restore requires a prepared fenced sandbox");
      }
      const current = await checkpointService.active(workspace.scope);
      if (current?.candidate.id !== (workspace.activeId ?? undefined)) {
        // Another replica published since this sandbox was prepared. Never
        // execute against a stale workspace; a new sandbox must cold-restore.
        await this.discardSandbox(input);
        throw new Error("Managed workspace checkpoint changed; reacquire the sandbox");
      }
    }
    // Until the turn, Memory/output sync and due checkpoints all settle,
    // a replacement attempt must cold-restore rather than reuse dirty bytes.
    if (workspace !== undefined) workspace.trusted = false;
    const abortController = new AbortController();
    this.abortControllers.set(input, abortController);
    // The Node execution worker owns the durable fence and cancels this
    // controller when renewal fails. The guard keeps provider calls from a
    // stale runner from continuing after that cancellation; canonical frame
    // writes are fenced separately by DefaultNodeManagedSessionRuntimeDriver.
    // Tools see a sandbox that survives the provider reclaiming the real one:
    // a lost sandbox is replaced (workspace restored from the last checkpoint)
    // and only the operations that hit the loss fail, explicitly.
    const currentSandbox = () => this.sandboxes.get(input) ?? rawSandbox;
    /** The sandbox was lost and could not be replaced: nothing can be
     * synchronized from or published out of it. */
    let sandboxLost = false;
    const recovery = withSandboxRecovery({
      current: currentSandbox,
      probe: (candidate) => this.probe(candidate),
      replace: (lost, cause) => {
        console.warn(`[managed-runner] session ${input.sessionId}: sandbox lost, replacing:`, cause);
        return this.replaceLostSandbox(input, lost, abortController.signal);
      },
      maxReplacements: this.dependencies.maxSandboxReplacements,
      onGiveUp: (error) => {
        console.warn(`[managed-runner] session ${input.sessionId}: ${error.message}`, error.cause);
        sandboxLost = true;
        abortController.abort(error);
      },
    });
    let sandboxReady = !deferred;
    let stopHeartbeat: () => Promise<void> = async () => undefined;
    const beginHeartbeat = () => {
      if (this.dependencies.sandboxLease === undefined) return;
      stopHeartbeat = startSandboxHeartbeat(currentSandbox, {
        ...this.dependencies.sandboxLease,
        onRenewFailed: (renewed, error) => recovery.check(renewed, error),
      });
    };
    if (!deferred) beginHeartbeat();
    const guardedSandbox = input.executionFence === undefined
      ? recovery.sandbox
      : withSandboxExecutionGuard(recovery.sandbox, {
          signal: abortController.signal,
        });
    let acquisition: Promise<void> | undefined;
    const ensureSandbox = (): Promise<void> => acquisition ??= this.beginSandboxStartup({
      ...input,
      signal: abortController.signal,
    }).then(async () => {
      if (abortController.signal.aborted) throw abortedError(abortController.signal);
      // A prior text-only turn may still have been preparing an older
      // resource/environment snapshot when this turn began.
      if (this.sandboxConfigurationFingerprints.get(input) !== this.sandboxFingerprint(input)) {
        await this.beginSandboxStartup({ ...input, signal: abortController.signal });
      }
      if (abortController.signal.aborted) throw abortedError(abortController.signal);
      sandboxReady = true;
      beginHeartbeat();
    }).catch((error) => {
      acquisition = undefined;
      throw error;
    });
    const sandbox: SandboxExecutor = deferred ? {
      exec: async (...args) => { await ensureSandbox(); return guardedSandbox.exec(...args); },
      readFile: async (...args) => { await ensureSandbox(); return guardedSandbox.readFile(...args); },
      writeFile: async (...args) => { await ensureSandbox(); return guardedSandbox.writeFile(...args); },
      resolveWorkspaceRoot: async () => { await ensureSandbox(); return workspaceRootOf(guardedSandbox); },
    } : guardedSandbox;
    const runtime = new ManagedNodeHarnessRuntime({
      initialEvents: input.initialEvents,
      events: input.historyEvents.filter((event) => managedEventThread(event) === "sthr_primary"),
      sandbox,
      abortSignal: abortController.signal,
      output: input.output,
      clock: this.dependencies.clock,
      ids: this.dependencies.ids,
      sessionScope: { workspaceId: input.workspaceId, sessionId: input.sessionId },
      sessionClocks: this.dependencies.sessionClocks,
      ...(input.takeSteeringInputs !== undefined && { takeSteeringInputs: input.takeSteeringInputs }),
      usage: input.session.usage,
    });
    const parkedStill = (remainingAfterAnswers?.length ?? 0) > 0;
    if (!parkedStill) runtime.broadcastProducedEvent({ type: "session.status_running" });
    let budgetGate: SessionBudgetGate | null = null as SessionBudgetGate | null;
    let turnTools: HarnessContext["tools"] | undefined;
    let runFailed = false;
    // user.interrupt ended the turn (abort reason INTERRUPT_REQUESTED).
    let interrupted = false;
    try {
      for (const event of input.events) {
        if (event.type !== "user.tool_confirmation") continue;
        if (remainingAfterAnswers !== null && answeredToolCallIds(asWireEvents(input.historyEvents
          .filter((candidate) => candidate.id !== event.id)
          .map((candidate) => encodeRuntimeHistoryEvent(candidate))))
          .has(event.toolUseId)) continue;
        const toolUse = findLastMatching(
          input.historyEvents,
          (candidate): candidate is ManagedNodeConfirmableToolUse =>
            (candidate.type === "agent.tool_use" ||
              candidate.type === "agent.mcp_tool_use") &&
            candidate.id === event.toolUseId,
        );
        if (toolUse === undefined) {
          throw new Error(
            `Tool use ${event.toolUseId} was not found in session history`,
          );
        }
        const result = event.result === "deny"
          ? {
              content: [{
                type: "text" as const,
                text: `Denied: ${event.denyMessage ?? "Tool execution was denied by the user."}`,
              }],
              isError: true,
            }
          : await this.dependencies.confirmedTools.execute({
              workspaceId: input.workspaceId,
              session: input.session,
              environment: input.environment,
              sandbox,
              confirmation: event,
              toolUse,
              abortSignal: abortController.signal,
            });
        runtime.broadcastProducedEvent(
          toolUse.type === "agent.mcp_tool_use"
            ? {
                type: "agent.mcp_tool_result",
                mcpToolUseId: toolUse.id,
                ...result,
              }
            : {
                type: "agent.tool_result",
                toolUseId: toolUse.id,
                ...result,
              },
        );
      }
      const context = {
        workspaceId: input.workspaceId,
        session: input.session,
        environment: input.environment,
      };
      const policy = await this.dependencies.subagentPolicy?.(context);
      let subagentContext: ManagedRunnerSubagentContext = {};
      if (policy?.enabled && this.dependencies.subagentThreads !== undefined) {
        const subagents = new ManagedNodeSubagents({
          ...context,
          parentThreadId: "sthr_primary",
          sandbox,
          abortSignal: abortController.signal,
          executionFence: input.executionFence,
          historyEvents: input.historyEvents,
          threads: this.dependencies.subagentThreads,
          policy,
          resolveSession: this.dependencies.resolveSubagentSession === undefined ? undefined :
            (request) => this.dependencies.resolveSubagentSession!({ ...context, request }),
          run: async ({ session, runtime: childRuntime, sandbox: childSandbox }) => {
            const childContext = { ...context, session };
            let childTools: HarnessContext["tools"] | undefined;
            try {
              const model = await this.dependencies.buildModel(childContext);
              childTools = await this.dependencies.buildTools({ ...childContext, sandbox: childSandbox });
              const harnessContext = await this.dependencies.buildHarnessContext({
                ...childContext, acceptedEvents: [], sandbox: childSandbox,
                runtime: childRuntime, model, tools: childTools,
              });
              // One session egress meter: child model calls are gated and
              // recorded by the same gate instance as the parent's.
              harnessContext.budget = budgetGate;
              childRuntime.setBudgetGate(budgetGate);
              await this.dependencies.buildHarness().run(harnessContext);
            } finally {
              if (childTools !== undefined) await this.dependencies.disposeTools?.(childTools);
            }
          },
          output: input.output,
          clock: this.dependencies.clock,
          ids: this.dependencies.ids,
        });
        this.subagentExecutions.set(input, subagents);
        subagentContext = {
          subagents,
          delegateToAgent: (agentId, message) => subagents.delegate({ agentId, message }),
        };
      }
      const toolsPromise = this.dependencies
        .buildTools({ ...context, ...subagentContext, sandbox })
        .then((tools) => {
          turnTools = tools;
          return tools;
        });
      const [model, tools] = await Promise.all([
        this.dependencies.buildModel(context),
        toolsPromise,
      ]);
      const runHarness = async (): Promise<void> => {
        const harnessContext = await this.dependencies.buildHarnessContext({
          ...context,
          ...subagentContext,
          acceptedEvents: input.events,
          executionFence: input.executionFence,
          sandbox,
          runtime,
          model,
          tools,
        });
        if (harnessContext.budget === undefined) {
          // Application gate opener; the Node ListCostPicoStore persists
          // session.usage.list_cost_pico and publishes each save.
          harnessContext.budget = await openSessionBudgetGate({
            session: input.session,
            pricing: async () => await this.dependencies.resolveModelPricing?.(context) ?? null,
            store: {
              load: (): string | null => input.session.usage?.list_cost_pico ?? null,
              save: (list_cost_pico: string): void => {
                const usage = { ...runtime.usageSnapshot(), list_cost_pico };
                if (input.session.usage) {
                  input.session.usage.list_cost_pico = list_cost_pico;
                } else {
                  input.session.usage = { list_cost_pico };
                }
                runtime.broadcastProducedEvent({ type: "session.usage", usage });
              },
            },
          });
        }
        budgetGate = harnessContext.budget ?? null;
        runtime.setBudgetGate(budgetGate);
        subagentContext.subagents?.setBudgetGate?.(budgetGate);
        // Harness-in-sandbox inference-proxy meters via the same gate.
        registerNodeSessionBudgetGate(input.session.id, budgetGate);
        const retry = this.dependencies.harnessRetry ??
          { attempts: 3, delayMs: (attempt: number) => Math.min(30_000, 2_000 * 2 ** (attempt - 1)) };
        for (let attempt = 1; ; attempt += 1) {
          const agentEventsBefore = runtime.agentEventCount;
          try {
            await this.dependencies.buildHarness().run(harnessContext);
            return;
          } catch (error) {
            if (!(error instanceof Error)) throw error;
            const sideEffectFree = runtime.agentEventCount === agentEventsBefore;
            const plan = planTurnFailure({
              cancelled: abortController.signal.aborted,
              failureClass: nodeTurnFailureClass(error, !sideEffectFree),
              attempt,
              maxAttempts: retry.attempts,
              delayMs: retry.delayMs,
            });
            // Exhausted and cancelled turns are settled by the outer catch.
            if (plan.type !== "retry") throw error;
            reportTurnFailure(plan, error.message, nodeTurnFailureEvents(runtime));
            await abortableDelay(plan.delayMs, abortController.signal);
            if (abortController.signal.aborted) throw error;
          }
        }
      };
      if (!parkedStill) await runHarness();
      if (event.type === "user.define_outcome") {
        await this.evaluateOutcome({
          input, event, runtime, runHarness, abortSignal: abortController.signal,
        });
      }
      // The turn's sandbox work is done. A sandbox replaced after the agent's
      // last operation took this turn's unpublished changes with it, and the
      // agent was never told: the turn must not end as if they existed.
      const unreported = await recovery.close();
      if (unreported !== null) {
        throw new Error(`The environment restarted after the agent's last step. ${unreported.split(" Background processes")[0].replace(/^This tool call was interrupted because the environment restarted\. /, "")} The changes made in this turn were lost.`);
      }
    } catch (error) {
      await recovery.close();
      if (abortController.signal.reason === INTERRUPT_REQUESTED) {
        // Official CMA: user.interrupt "pauses agent execution and returns
        // control to the user" (BetaManagedAgentsUserInterruptEvent). It is
        // not an execution error (no session.error type covers it) and not
        // retries_exhausted ("repeated errors exhausted the retry budget");
        // the turn ends idle end_turn, as on Cloudflare.
        interrupted = true;
      } else {
        runFailed = true;
        if (abortController.signal.reason === "lease_lost") throw error;
        // The turn may have produced side effects (tool calls), so it is not
        // retried automatically: CMA semantics for a dead turn are `exhausted`.
        reportTurnFailure(
          { type: "exhausted" },
          error instanceof Error ? error.message : String(error),
          nodeTurnFailureEvents(runtime),
        );
        throw new SessionRetriesExhaustedError(
          error instanceof Error ? error.message : String(error),
        );
      }
    } finally {
      let finalizationError: Error | undefined;
      // An interrupted or fenced-out turn is not a failed one.
      const executionFailed = runFailed && !abortController.signal.aborted;
      const subagents = this.subagentExecutions.get(input);
      try {
        if (runFailed) abortController.abort();
        await subagents?.drain();
      } catch (error) {
        finalizationError = error instanceof Error ? error : new Error(String(error));
      } finally {
        if (this.subagentExecutions.get(input) === subagents) this.subagentExecutions.delete(input);
      }
      try {
        if (turnTools !== undefined) {
          await this.dependencies.disposeTools?.(turnTools);
        }
      } catch (error) {
        finalizationError = error instanceof Error ? error : new Error(String(error));
      }
      try {
        const barrier = executionFailed
          ? this.dependencies.failSandbox ?? this.dependencies.synchronizeSandbox
          : this.dependencies.synchronizeSandbox;
        if (
          sandboxReady && !sandboxLost &&
          input.executionFence !== undefined &&
          barrier !== undefined
        ) {
          const executionFence = input.executionFence;
          await this.sandboxRuntimes.get(input)?.withSandbox(async () => {
            await barrier.call(this.dependencies, {
              workspaceId: input.workspaceId,
              session: input.session,
              environment: input.environment,
              sandbox: currentSandbox(),
              runtimeGeneration: this.runtimeGenerations.get(input) ?? runtimeGeneration,
              executionFence,
            });
          });
        }
      } catch (error) {
        finalizationError ??= error instanceof Error ? error : new Error(String(error));
      }
      // Turn completion is a safe point: all harness/subagent activity has
      // drained. The interval is a target between such points, not a timer
      // that snapshots files while tools are still writing.
      // A lost sandbox replaced mid-turn brings its own workspace binding.
      const turnWorkspace = this.workspaces.get(input) ?? workspace;
      if (!runFailed && finalizationError === undefined && checkpointService !== undefined && turnWorkspace !== undefined && input.executionFence !== undefined) {
        const workspace = turnWorkspace;
        try {
          const active = await checkpointService.active(workspace.scope);
          if (active?.candidate.id !== (workspace.activeId ?? undefined)) {
            throw new Error("Managed workspace checkpoint changed during execution");
          }
          if (checkpointService.due(active)) {
            const fence = input.executionFence;
            const candidate = await workspace.port.checkpoint({
              scope: { ...workspace.scope, workId: fence.executionId },
              fence: checkpointService.runtimeFence(fence, workspace.scope.environmentId),
              strategy: "checkpoint_restore", binding: workspace.binding,
              sandbox: { provider: "node", runtimeId: this.runtimeGenerations.get(input) ?? runtimeGeneration },
              idempotencyKey: `${fence.executionId}-${fence.attemptId}`,
              signal: abortController.signal,
            });
            if (!await checkpointService.publish({ fence, candidate, expectedId: workspace.activeId })) {
              throw new Error("Managed workspace checkpoint lost its Session Execution fence or canonical pointer");
            }
            workspace.activeId = candidate.id;
          }
        } catch (error) {
          finalizationError = error instanceof Error ? error : new Error(String(error));
        }
      }
      const leaseLost = abortController.signal.reason === "lease_lost";
      if (finalizationError !== undefined && !runFailed && !leaseLost) {
        runtime.broadcastProducedEvent({
          type: "session.error",
          error: {
            type: "unknown_error",
            message: finalizationError instanceof Error
              ? finalizationError.message
              : String(finalizationError),
            retryStatus: "exhausted",
          },
        });
      }
      if (!leaseLost) {
        const failed = runFailed || finalizationError !== undefined;
        const parkIds = failed || interrupted ? [] : parkedStill ? remainingAfterAnswers! : stillPending(
          runtime.pendingConfirmations,
          asWireEvents(runtime.history.getEvents()),
        );
        const stop = decideTurnStop({
          parkedOnClient: parkIds.length > 0,
          budgetReached: !failed && budgetGate?.reached === true,
        });
        if (stop === "budget_reached") {
          // Official budget stop: thread idle → usage → session idle (budget_reached).
          // Usage source on Node: the primary runtime's meter.
          for (const event of budgetReachedStopEvents({
            agentName: input.session.agent.name,
            sessionThreadId: "sthr_primary",
            usage: runtime.usageSnapshot(),
            budget: budgetGate!.maxListCost,
          })) {
            runtime.broadcastProducedEvent(event);
          }
        } else {
          runtime.broadcastProducedEvent({
            type: "session.status_idle",
            stopReason: failed ? { type: "retries_exhausted" }
              : stop === "requires_action" ? { type: "requires_action", eventIds: parkIds }
              : { type: "end_turn" },
          });
        }
      }
      try {
        await runtime.drain();
        if (sandboxReady && !sandboxLost && input.executionFence !== undefined) {
          await this.dependencies.afterExecution?.({
            workspaceId: input.workspaceId,
            session: input.session,
            environment: input.environment,
            sandbox: currentSandbox(),
            runtimeGeneration: this.runtimeGenerations.get(input) ?? runtimeGeneration,
            executionFence: input.executionFence,
          });
        }
      } finally {
        clearNodeSessionBudgetGate(input.session.id);
        // ADR 0005: keep the sandbox lease through drain, checkpoint and
        // output publication, not only while the harness runs.
        await stopHeartbeat();
        if (this.abortControllers.get(input) === abortController) {
          this.abortControllers.delete(input);
        }
      }
      if (finalizationError !== undefined && !runFailed) {
        throw finalizationError;
      }
      const finalWorkspace = this.workspaces.get(input);
      if (finalWorkspace !== undefined && !runFailed && !abortController.signal.aborted) {
        finalWorkspace.trusted = true;
      }
    }
  }

  /** The `user.define_outcome` grader loop (#545 §0.7: one implementation in
   * @open-managed-agents/session-outcomes). Node supplies the per-iteration
   * evaluation Port, the persisted span events and the revision turn. The
   * history snapshot is taken before each start span so the evaluator judges
   * the turn, not its own spans. Node keeps no outcome state across turns. */
  private async evaluateOutcome(turn: {
    input: NodeManagedSessionRunnerAcceptInput;
    event: ManagedNodeDefinedOutcome;
    runtime: ManagedNodeHarnessRuntime;
    runHarness(): Promise<void>;
    abortSignal: AbortSignal;
  }): Promise<void> {
    const { input, event, runtime } = turn;
    let lastStartId: string | null = null;
    const outcomes = createSessionOutcomes<SessionEventView[]>({
      snapshot: () => runtime.getApplicationHistoryEvents(),
      evaluator: {
        prepare: async ({ outcome }) => ({
          type: "ready",
          outcome,
          evaluator: {
            evaluate: async ({ iteration, abortSignal, snapshot }) => {
              const evaluation = await this.dependencies.outcomes.evaluate({
                workspaceId: input.workspaceId,
                session: input.session,
                environment: input.environment,
                outcome: event,
                historyEvents: snapshot ?? [],
                iteration,
                abortSignal,
              });
              return {
                result: evaluation.result,
                explanation: evaluation.explanation,
                usage: {
                  input_tokens: evaluation.usage.inputTokens,
                  output_tokens: evaluation.usage.outputTokens,
                  cache_creation_input_tokens: evaluation.usage.cacheCreationInputTokens,
                  cache_read_input_tokens: evaluation.usage.cacheReadInputTokens,
                },
              };
            },
          },
        }),
      },
      events: {
        evaluationStarted: ({ outcomeId, iteration }) => {
          lastStartId = runtime.broadcastProducedEvent({
            type: "span.outcome_evaluation_start",
            outcomeId,
            iteration,
          });
          return { startEventId: lastStartId };
        },
        evaluationOngoing: ({ outcomeId, iteration }) => {
          runtime.broadcastProducedEvent({
            type: "span.outcome_evaluation_ongoing",
            outcomeId,
            iteration,
          });
        },
        evaluationEnded: ({ verdict, started }) => {
          // The Node end span requires a start link; a verdict without its
          // own start span (crashed revision) links the last evaluation.
          const startId = started?.startEventId ?? lastStartId;
          if (startId === null) return;
          runtime.broadcastProducedEvent({
            type: "span.outcome_evaluation_end",
            outcomeId: verdict.outcomeId,
            outcomeEvaluationStartId: startId,
            iteration: verdict.iteration,
            result: verdict.result,
            explanation: verdict.explanation,
            usage: {
              cacheCreationInputTokens: verdict.usage?.cache_creation_input_tokens ?? 0,
              cacheReadInputTokens: verdict.usage?.cache_read_input_tokens ?? 0,
              inputTokens: verdict.usage?.input_tokens ?? 0,
              outputTokens: verdict.usage?.output_tokens ?? 0,
            },
          });
        },
      },
      progress: { persist: () => undefined },
      revision: {
        revise: async ({ feedback }) => {
          runtime.appendOutcomeFeedback(feedback);
          await turn.runHarness();
        },
      },
    });
    await outcomes.evaluate({
      outcome: {
        outcomeId: event.outcomeId,
        description: event.description,
        rubric: event.rubric,
        maxIterations: event.maxIterations,
      },
      abortSignal: turn.abortSignal,
    });
  }

  /** Recovery of an execution whose terminal idle committed before its
   * process died: the turn already answered, so the harness must not run
   * again. Only the post-terminal step remains — output publication, which
   * is idempotent by path + content — and then the worker settles. */
  private async finishCommittedExecution(
    input: NodeManagedSessionRunnerAcceptInput,
    executionFence: SessionExecutionFence,
    terminal: CommittedExecutionTerminal,
  ): Promise<void> {
    if (this.dependencies.afterExecution !== undefined) {
      if (this.sandboxes.get(input) === undefined) await this.beginSandboxStartup(input);
      const sandbox = this.sandboxes.get(input);
      const runtimeGeneration = this.runtimeGenerations.get(input);
      if (sandbox === undefined || runtimeGeneration === undefined) {
        throw new Error(`Session ${input.sessionId} sandbox was not started`);
      }
      const stopHeartbeat = this.dependencies.sandboxLease === undefined
        ? async () => undefined
        : startSandboxHeartbeat(() => this.sandboxes.get(input) ?? sandbox, this.dependencies.sandboxLease);
      try {
        await this.dependencies.afterExecution({
          workspaceId: input.workspaceId,
          session: input.session,
          environment: input.environment,
          sandbox: this.sandboxes.get(input) ?? sandbox,
          runtimeGeneration,
          executionFence,
        });
      } finally {
        await stopHeartbeat();
      }
    }
    // Settle with the outcome the original attempt would have reported.
    if (terminal.stopReason.type === "retries_exhausted") {
      throw new SessionRetriesExhaustedError(`Execution ${executionFence.executionId} already ended with retries_exhausted`);
    }
  }

  async archiveThread(
    input: ArchiveNodeManagedSessionThread,
  ): Promise<void> {
    await this.subagentExecutions.get(input)?.archiveThread(input.threadId);
  }
}

/** Non-retryable harness failures use ConfigError (detected by error.name). */
function nodeTurnFailureEvents(runtime: ManagedNodeHarnessRuntime): TurnFailureEventsPort {
  return {
    sessionError: (message, retryStatus) => {
      runtime.broadcastProducedEvent({
        type: "session.error",
        error: { type: "unknown_error", message, retryStatus },
      });
    },
    rescheduled: () => {
      runtime.broadcastProducedEvent({ type: "session.status_rescheduled" });
    },
  };
}

/** Node has no terminated Session state yet, so a session-terminal failure
 * ends only this turn (exhausted). */
function nodeTurnFailureClass(error: Error, producedAgentEvents: boolean): TurnFailureClass {
  if (error.name === "ConfigError") return "turn_dead";
  const failureClass = classifyTurnFailure(error, producedAgentEvents);
  return failureClass === "session_terminal" ? "turn_dead" : failureClass;
}
