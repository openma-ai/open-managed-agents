import { SessionSandboxRuntime, type SessionSandboxMode } from "@open-managed-agents/session-runtime";
import {
  probeSandboxLiveness,
  withSandboxExecutionGuard,
  withSandboxRecovery,
  type SandboxExecutor,
  type SandboxLiveness,
  type SandboxRuntimeHandle,
} from "@open-managed-agents/sandbox";
import { randomUUID } from "node:crypto";
import { APICallError } from "ai";
import { hasProcessInvariantFailure, terminateForInvariant } from "./process-invariant";
import { readOnlyArtifactOutputs, type ReadOnlyArtifactPublicationInput } from "../openai-artifact-publication";
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
import { consumedListCostPico } from "@open-managed-agents/managed-agents-application";
import {
  abortedError,
  abortableDelay,
  linkAbort,
  untilAborted,
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
import {
  createSessionBudgetGate,
  type SessionBudgetGate,
} from "@open-managed-agents/domain/sessions";
import {
  registerNodeSessionBudgetGate,
} from "./node-session-budget-gates.js";
import type { ModelPricing } from "@open-managed-agents/api-types";
import type { WorkspaceBinding, WorkspacePersistencePort, RuntimeResourceScope } from "@open-managed-agents/runtime-resource-contract";
import type { NodeManagedWorkspaceCheckpoints } from "./node-managed-workspace-checkpoints.js";
import { ScopedSessionMap } from "./scoped-session-map.js";
import type { NodeSessionSandboxLifecycle } from "./node-session-sandbox-lifecycle.js";
import {
  ManagedNodeSubagents,
  managedEventThread,
  type ManagedNodeCreateSubagent,
  type ManagedNodeSubagentControl,
  type ManagedNodeSubagentPolicy,
  type ManagedNodeSubagentThreads,
} from "./node-managed-subagents.js";

export type { ManagedNodeSubagentControl } from "./node-managed-subagents.js";

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
import { answeredToolCallIds, asWireEvents,
  outstandingRequiresAction, stillPending } from "./requires-action.js";
export interface ExecuteManagedNodeConfirmedTool {
  workspaceId: string;
  session: Session;
  environment: Environment;
  sandbox: SandboxExecutor;
  confirmation: ManagedNodeToolConfirmation;
  toolUse: ManagedNodeConfirmableToolUse;
  abortSignal: AbortSignal;
  onOutcomeUnknown?(error: unknown): Promise<void>;
  assertCanDispatch?(): void;
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
  buildSandbox(input: ManagedRunnerContext & { signal?: AbortSignal; allocationId?: string }): Promise<SandboxExecutor>;
  /** Durable Session resource ownership; local clients are only a cache. */
  sandboxLifecycle?: NodeSessionSandboxLifecycle;
  resumeSandbox?(input: ManagedRunnerContext & { allocationId: string }, handle: SandboxRuntimeHandle): Promise<SandboxExecutor>;
  sandboxHandle?(sandbox: SandboxExecutor): SandboxRuntimeHandle;
  executionDispatches?: {
    begin(fence: SessionExecutionFence): Promise<boolean>;
    drained(fence: SessionExecutionFence): Promise<void>;
    recoverTerminal(fence: SessionExecutionFence, readOnlyPublication?: boolean): Promise<boolean>;
    publicationWrite(fence: SessionExecutionFence, confirmed: boolean): Promise<boolean>;
    finish(fence: SessionExecutionFence, unknown: boolean): Promise<void>;
  };
  /** Liveness probe used before reusing a warm sandbox and after a failed
   * sandbox operation. Default: the provider runtime Port's `status()`. */
  probeSandbox?(sandbox: SandboxExecutor): Promise<SandboxLiveness>;
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
    /** Rebuild client-local credentials/mount configuration, preserving files. */
    reattach?: boolean;
    authorizeResourceMutation?(): Promise<boolean>;
  }): Promise<void>;
  /** Refresh lightweight Session environment after preparation and on every
   * warm reuse, without restaging resources or rebuilding the sandbox. */
  refreshSandboxEnvironment?(input: ManagedRunnerContext & {
    sandbox: SandboxExecutor;
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
  /** Runs after all terminal facts have committed, while the execution still
   * owns its existing fence. Suitable for immutable output publication. */
  afterExecution?(input: ManagedRunnerContext & {
    sandbox: SandboxExecutor;
    runtimeGeneration: string;
    executionFence: SessionExecutionFence;
  }): Promise<void>;
  /** Trusted immutable artifact publisher. Receives only reads; every Files
   * write must use the durable write boundary. Never a general extension hook. */
  publishArtifacts?(input: ReadOnlyArtifactPublicationInput): Promise<void>;
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

/** A live Session owns its SDK handle. This is not provider identity or authority:
 * those remain in the durable resource binding and its fences. */
interface ManagedRunnerSession {
  sandbox?: SandboxExecutor;
  runtime?: SessionSandboxRuntime;
  generation?: string;
  fingerprint?: string;
  allocationId?: string;
  workspace?: ManagedWorkspaceState;
  closed?: boolean;
}

export class DefaultNodeManagedSessionRunner
  implements NodeManagedSessionRunner
{
  private readonly sessions = new ScopedSessionMap<ManagedRunnerSession>();
  private readonly abortControllers = new ScopedSessionMap<AbortController>();
  private readonly attemptIds = new ScopedSessionMap<string>();
  private readonly startupAborts = new ScopedSessionMap<AbortController>();
  private readonly sandboxStarts = new ScopedSessionMap<Promise<void>>();
  private readonly subagentExecutions = new ScopedSessionMap<ManagedNodeSubagents>();
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

  private sessionFor(input: { workspaceId: string; sessionId: string }): ManagedRunnerSession {
    let session = this.sessions.get(input);
    if (session === undefined) {
      session = {};
      this.sessions.set(input, session);
    }
    return session;
  }

  /** Drop only local ownership. Resource retirement/deletion belongs to lifecycle. */
  private releaseSession(input: { workspaceId: string; sessionId: string }): void {
    const session = this.sessions.get(input);
    if (session === undefined) return;
    session.closed = true;
    if (session.sandbox) this.sandboxRefreshes.get(session.sandbox)?.revoke.abort();
    delete session.sandbox;
    delete session.runtime;
    delete session.generation;
    delete session.fingerprint;
    delete session.allocationId;
    delete session.workspace;
    this.sessions.delete(input);
  }

  /** `lease_lost` means another owner will reclaim and re-run this execution:
   * the stale attempt must not tell the client its turn failed. */
  cancel(input: { workspaceId: string; sessionId: string; reason?: string; attemptId?: string }): void {
    if (input.attemptId !== undefined && this.attemptIds.get(input) !== input.attemptId) return;
    this.abortControllers.get(input)?.abort(input.reason ?? "cancelled");
    if (this.dependencies.sandboxLifecycle === undefined) this.startupAborts.get(input)?.abort(input.reason ?? "cancelled");
  }

  /** Returns only a prepared live runtime, scoped exactly like execution. */
  connectedSandbox(input: { workspaceId: string; sessionId: string }): SandboxExecutor | null {
    return this.sessions.get(input)?.sandbox ?? null;
  }

  async withSessionSandbox<T>(input: StartNodeManagedSessionRuntime, operation: (sandbox: SandboxExecutor) => Promise<T>): Promise<T> {
    const lifecycle = this.dependencies.sandboxLifecycle;
    if (lifecycle === undefined) throw new Error("Durable sandbox resource access is not configured");
    await this.startDurableSandbox(input);
    const allocationId = this.sessions.get(input)?.allocationId!;
    return lifecycle.operate({ scope: input, allocationId }, (sandbox, signal) =>
      operation(withSandboxExecutionGuard(sandbox, { signal })));
  }

  async sandboxAvailable(input: { workspaceId: string; sessionId: string }): Promise<boolean> {
    const lifecycle = this.dependencies.sandboxLifecycle;
    if (lifecycle === undefined) return this.connectedSandbox(input) !== null;
    const resource = await lifecycle.describe(input);
    return resource?.desiredState === "active" && resource.observedState === "ready" && resource.failure === null;
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
      environmentId: input.environment.id,
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
    let session = this.sessionFor(input);
    if (this.dependencies.sandboxLifecycle !== undefined &&
      await this.dependencies.sandboxMode?.(input) !== "none") {
      await this.startDurableSandbox(input);
      return;
    }
    const startup = new AbortController();
    const unlinkParent = linkAbort(input.signal, startup);
    const signal = startup.signal;
    this.startupAborts.set(input, startup);
    try {
      if (signal.aborted) throw abortedError(signal);
      this.assertSandboxDisposed(input);
      const fingerprint = this.sandboxFingerprint(input);
      const existing = this.sessions.get(input)?.sandbox;
      if (this.dependencies.workspaceCheckpoints !== undefined && input.executionFence === undefined) {
        throw new Error("Managed workspace checkpoint_restore requires a Session Execution fence");
      }
      const trusted = this.dependencies.workspaceCheckpoints === undefined || this.sessions.get(input)?.workspace?.trusted === true;
      let reusable = existing !== undefined
        && this.sessions.get(input)?.fingerprint === fingerprint
        && trusted;
      if (reusable && this.dependencies.isSandboxCurrent !== undefined) {
        reusable = await untilAborted(this.dependencies.isSandboxCurrent({
          workspaceId: input.workspaceId, session: input.session, environment: input.environment,
          runtimeGeneration: this.sessions.get(input)?.generation!,
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
          if (this.sessions.get(input)?.sandbox === existing) {
            await this.discardSandbox(input, { abortTurn: false }).catch(() => undefined);
          }
          throw failure;
        }
        return;
      }
      if (existing !== undefined) {
        await untilAborted(this.discardSandbox(input, { abortTurn: false }).catch(() => undefined), signal);
        session = this.sessionFor(input);
      }
      const acquired = await this.acquireSandbox(input, signal);
      this.installSandbox(input, acquired, fingerprint, session);
    } finally {
      unlinkParent();
      if (this.startupAborts.get(input) === startup) {
        this.startupAborts.delete(input);
      }
    }
  }

  private async startDurableSandbox(input: StartNodeManagedSessionRuntime): Promise<void> {
    const session = this.sessionFor(input);
    const lifecycle = this.dependencies.sandboxLifecycle!;
    const context = { workspaceId: input.workspaceId, session: input.session, environment: input.environment };
    const fingerprint = this.sandboxFingerprint(input);
    const acquired = await lifecycle.open({
      scope: input,
      configFingerprint: fingerprint,
      create: (allocationId, signal) => this.dependencies.buildSandbox({ ...context, allocationId, signal }),
      resume: (handle, allocationId) => {
        if (this.dependencies.resumeSandbox === undefined) throw new Error("Sandbox provider cannot rebind this Session resource");
        return this.dependencies.resumeSandbox({ ...context, allocationId }, handle);
      },
      handle: sandbox => {
        if (this.dependencies.sandboxHandle === undefined) throw new Error("Sandbox provider does not expose a durable resource handle");
        return this.dependencies.sandboxHandle(sandbox);
      },
      prepare: async (raw, allocationId, signal, { fresh, isCurrent, fence: management }) => {
        const sandbox = withSandboxExecutionGuard(raw, { signal });
        const checkpoints = this.dependencies.workspaceCheckpoints;
        if (fresh && checkpoints !== undefined) {
          const scope = { workspaceId: input.workspaceId, sessionId: input.sessionId,
            environmentId: input.environment.id, workId: allocationId };
          const active = await checkpoints.active(scope);
          const port = checkpoints.port(sandbox);
          // This port only restores immutable bytes; publication later still
          // requires the canonical Session Execution fence.
          const fence = { ...scope, ownerId: management.ownerId, generation: management.generation,
            token: allocationId, expiresAt: management.expiresAt };
          const binding = await port.materialize({ scope, fence, strategy: "checkpoint_restore",
            activeCheckpoint: active?.candidate ?? null, idempotencyKey: allocationId, signal });
          try {
            await port.attach({ scope, fence, strategy: "checkpoint_restore", binding,
              sandbox: this.dependencies.sandboxHandle!(raw), signal });
          } finally {
            await port.release({ scope, fence, binding });
          }
        }
        await this.dependencies.prepareSandbox?.({ ...context, sandbox, runtimeGeneration: allocationId,
          signal, reattach: !fresh, authorizeResourceMutation: isCurrent });
        await this.refreshSandboxEnvironment(context, raw, signal);
      },
    });
    const runtime = new SessionSandboxRuntime({ mode: () => "sandbox", create: () => acquired.sandbox });
    await runtime.acquire();
    this.installSandbox(input, { sandbox: acquired.sandbox, runtime, workspace: undefined,
      runtimeGeneration: acquired.allocationId, restoredFromMs: null }, fingerprint, session);
    this.sessionFor(input).allocationId = acquired.allocationId;
  }

  private assertSandboxDisposed(input: { workspaceId: string; sessionId: string }): void {
    if (this.pendingSandboxDisposals.get(input) !== undefined) {
      throw new Error("Sandbox cleanup is incomplete; refusing to reacquire the Session resource");
    }
  }

  private async refreshSandboxEnvironment(
    context: ManagedRunnerContext,
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
        return this.dependencies.buildSandbox({ ...context, signal,
          ...(this.dependencies.workspaceCheckpoints === undefined ? {} : { allocationId: runtimeGeneration }),
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
        await this.refreshSandboxEnvironment(context, sandbox, signal);
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
    session = this.sessionFor(input),
  ): void {
    if (session.closed || this.sessions.get(input) !== session) throw new Error("Session closed during sandbox startup");
    if (acquired.workspace !== undefined) session.workspace = acquired.workspace;
    else delete session.workspace;
    session.runtime = acquired.runtime;
    session.sandbox = acquired.sandbox;
    session.generation = acquired.runtimeGeneration;
    session.fingerprint = fingerprint;
  }

  /** ADR 0005 "Sandbox disappears": reacquire, restore the last committed
   * workspace and continue the turn from its in-process event history. */
  private async replaceLostSandbox(
    input: NodeManagedSessionRunnerAcceptInput,
    lost: SandboxExecutor,
    signal: AbortSignal,
  ): Promise<string> {
    const session = this.sessionFor(input);
    if (session.sandbox !== lost) return "";
    const fingerprint = this.sessions.get(input)?.fingerprint ?? "";
    const previousWorkspace = this.sessions.get(input)?.workspace;
    await this.disposeSandbox(input, lost, previousWorkspace).catch(() => undefined);
    const acquired = await this.acquireSandbox(input, signal);
    if (signal.aborted) {
      await this.disposeSandbox(input, acquired.sandbox, acquired.workspace).catch(() => undefined);
      throw abortedError(signal);
    }
    // Until this turn reaches its barrier the replacement is as dirty as every
    // sandbox a turn has written to.
    if (acquired.workspace !== undefined) acquired.workspace.trusted = false;
    this.installSandbox(input, acquired, fingerprint, session);
    if (acquired.workspace === undefined) {
      return "Files created in /workspace before the restart are gone.";
    }
    return acquired.restoredFromMs === null
      ? "/workspace is back to its initial state; files created before the restart are gone."
      : `/workspace is back to its state as of ${new Date(acquired.restoredFromMs).toISOString().slice(0, 19).replace("T", " ")} UTC; files created after that are gone.`;
  }

  async stop(input: StopNodeManagedSessionRuntime): Promise<void> {
    if (this.dependencies.sandboxLifecycle !== undefined) {
      // Stopping execution revokes the borrower. The Session still owns its
      // durable resource; neither cancellation nor lease loss is retirement.
      this.cancel(input);
      if (input.reason === "archived" || input.reason === "deleted") {
        this.releaseSession(input);
        await this.dependencies.sandboxLifecycle.closeSession(input);
      }
      return;
    }
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
    const allocationId = this.sessions.get(input)?.allocationId;
    if (this.dependencies.sandboxLifecycle !== undefined && allocationId !== undefined) {
      throw new Error("Session sandbox replacement requires durable retirement after its current use drains");
    }
    if (options.abortTurn !== false) {
      this.abortControllers.get(input)?.abort();
      this.abortControllers.delete(input);
    }
    const workspace = this.sessions.get(input)?.workspace;
    const sandbox = this.sessions.get(input)?.sandbox;
    this.releaseSession(input);
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
      active?.abort();
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
    const sessionOwner = this.sessionFor(input);
    const assertSessionOpen = () => {
      if (sessionOwner.closed || this.sessions.get(input) !== sessionOwner) {
        throw new Error("Session closed while execution was preparing");
      }
    };
    const deferred = this.canOverlapSandboxStartup(input);
    // Only the three execution primitives are needed by Pi's host-side tools.
    // Capability inspection must not allocate a provider resource.
    const unallocated: SandboxExecutor = {
      exec: async () => { throw new Error("Sandbox has not been acquired"); },
      readFile: async () => { throw new Error("Sandbox has not been acquired"); },
      writeFile: async () => { throw new Error("Sandbox has not been acquired"); },
    };
    const rawSandbox = this.sessions.get(input)?.sandbox ?? (deferred ? unallocated : undefined);
    if (rawSandbox === undefined) {
      throw new Error(`Session ${input.sessionId} sandbox was not started`);
    }
    const runtimeGeneration = this.sessions.get(input)?.generation
      ?? (deferred ? `pending_${randomUUID()}` : undefined);
    if (runtimeGeneration === undefined) {
      throw new Error(`Session ${input.sessionId} runtime generation was not started`);
    }
    const checkpointService = this.dependencies.workspaceCheckpoints;
    let workspace = this.sessions.get(input)?.workspace;
    const lifecycle = this.dependencies.sandboxLifecycle;
    if (lifecycle !== undefined && !deferred && this.sessions.get(input)?.allocationId !== undefined &&
      checkpointService !== undefined && input.executionFence !== undefined) {
      const fence = input.executionFence;
      const scope = { workspaceId: input.workspaceId, sessionId: input.sessionId,
        environmentId: input.environment.id, workId: fence.executionId };
      const active = await checkpointService.active(scope);
      assertSessionOpen();
      const port = checkpointService.port(rawSandbox);
      const binding = await port.materialize({ scope,
        fence: checkpointService.runtimeFence(fence, scope.environmentId), strategy: "checkpoint_restore",
        activeCheckpoint: active?.candidate ?? null, idempotencyKey: runtimeGeneration,
        signal: new AbortController().signal });
      try { assertSessionOpen(); }
      catch (failure) {
        try { await port.release({ scope, fence: checkpointService.runtimeFence(fence, scope.environmentId), binding }); }
        catch (cleanup) { throw new AggregateError([failure, cleanup], "Session closed and workspace release failed", { cause: failure }); }
        throw failure;
      }
      workspace = { port, binding, scope, fence, activeId: active?.candidate.id ?? null, trusted: true };
      sessionOwner.workspace = workspace;
    }
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
    assertSessionOpen();
    // Until the turn, Memory/output sync and due checkpoints all settle,
    // a replacement attempt must cold-restore rather than reuse dirty bytes.
    if (workspace !== undefined) workspace.trusted = false;
    const abortController = new AbortController();
    this.abortControllers.set(input, abortController);
    if (input.executionFence !== undefined) this.attemptIds.set(input, input.executionFence.attemptId);
    // The Node execution worker owns the durable fence and cancels this
    // controller when renewal fails. The guard keeps provider calls from a
    // stale runner from continuing after that cancellation; canonical frame
    // writes are fenced separately by DefaultNodeManagedSessionRuntimeDriver.
    // Tools see a sandbox that survives the provider reclaiming the real one:
    // a lost sandbox is replaced (workspace restored from the last checkpoint)
    // and only the operations that hit the loss fail, explicitly.
    let attemptSandbox = rawSandbox;
    const currentSandbox = () => attemptSandbox;
    let borrowedAllocation: string | undefined;
    let borrowing: Promise<void> | undefined;
    let providerOutcomeUnknown = false;
    let providerDispatched = false;
    let toolDispatched = false;
    let dispatchBegan = false;
    const providerOperations = new Set<Promise<unknown>>();
    const toolOperations = new Set<Promise<unknown>>();
    const liveProcesses = new Set<Promise<unknown>>();
    const quarantineExecution = async (_error: unknown): Promise<void> => {
      providerOutcomeUnknown = true;
      abortController.abort("operation_outcome_unknown");
      if (dispatchBegan && input.executionFence !== undefined) {
        await this.dependencies.executionDispatches?.finish(input.executionFence, true);
      }
    };
    const assertCanDispatch = (): void => {
      if (lifecycle !== undefined) assertSessionOpen();
      if (providerOutcomeUnknown) throw new Error("Sandbox operation outcome is unknown; further dispatch is suspended");
      if (input.executionFence !== undefined && Date.parse(input.executionFence.expiresAt) <= this.dependencies.clock.now().getTime()) {
        abortController.abort("lease_lost");
      }
      abortController.signal.throwIfAborted();
    };
    const guardTools = (tools: HarnessContext["tools"]): HarnessContext["tools"] => {
      if (this.dependencies.executionDispatches === undefined) return tools;
      return Object.fromEntries(Object.entries(tools).map(([name, tool]) => {
        if (typeof tool.execute !== "function") return [name, tool];
        const execute = tool.execute;
        return [name, { ...tool, execute: async (...args: Parameters<typeof execute>) => {
          assertCanDispatch();
          toolDispatched = true;
          const operation = Promise.resolve().then(() => execute(...args));
          toolOperations.add(operation);
          try { return await operation; }
          catch (error) {
            if (!(error instanceof Error && error.name === "ToolFailureError" &&
              "outcomeUnknown" in error && error.outcomeUnknown === false)) await quarantineExecution(error);
            throw error;
          } finally { toolOperations.delete(operation); }
        } }];
      })) as HarnessContext["tools"];
    };
    const borrowSandbox = (): Promise<void> => borrowing ??= (async () => {
      const allocationId = this.sessions.get(input)?.allocationId;
      if (lifecycle === undefined) return;
      assertSessionOpen();
      if (allocationId === undefined) throw new Error("Sandbox use requires the Session's durable allocation");
      if (input.executionFence === undefined) throw new Error("Sandbox use requires a canonical Session Execution lease");
      if (abortController.signal.aborted) throw abortedError(abortController.signal);
      await lifecycle.borrow({ executionFence: input.executionFence, allocationId });
      borrowedAllocation = allocationId;
      // Capture the exact client; a later start cannot redirect old callbacks.
      attemptSandbox = this.sessions.get(input)?.sandbox!;
      if (abortController.signal.aborted) throw abortedError(abortController.signal);
    })();
    /** The sandbox was lost and could not be replaced: nothing can be
     * synchronized from or published out of it. */
    let sandboxLost = false;
    const recovery = withSandboxRecovery({
      current: currentSandbox,
      probe: (candidate) => this.probe(candidate),
      replace: (lost, cause) => {
        if (lifecycle !== undefined) {
          // Failure can mean a command completed remotely. Never replace and
          // replay an operation with an unknown outcome inside this attempt.
          providerOutcomeUnknown = true;
          return Promise.reject(new Error("Sandbox operation outcome is unknown; resource reconciliation is required", { cause }));
        }
        console.warn(`[managed-runner] session ${input.sessionId}: sandbox lost, replacing:`, cause);
        return this.replaceLostSandbox(input, lost, abortController.signal).then(result => {
          attemptSandbox = this.sessions.get(input)?.sandbox ?? lost;
          return result;
        });
      },
      maxReplacements: this.dependencies.maxSandboxReplacements,
      onGiveUp: (error) => {
        console.warn(`[managed-runner] session ${input.sessionId}: ${error.message}`, error.cause);
        sandboxLost = true;
        abortController.abort(error);
      },
    });
    let sandboxReady = !deferred;
    const durableClient = new Proxy(rawSandbox, {
      get(_target, property) {
        if (["destroy", "renewLease", "suspend", "resume", "checkpoint", "runtimeHandle",
          "runtimeCapabilities", "renewActivityTimeout"].includes(String(property))) return undefined;
        const target = currentSandbox();
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const access = lifecycle === undefined ? recovery.sandbox : new Proxy(durableClient, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        if (["runtimeHandle", "runtimeCapabilities", "sessionOutputMountCapabilities", "registerCommandSecrets"].includes(String(property))) {
          return value.bind(target);
        }
        return async (...args: unknown[]) => {
          assertCanDispatch();
          await borrowSandbox();
          if (abortController.signal.aborted) throw abortedError(abortController.signal);
          providerDispatched = true;
          const operation = Promise.resolve().then(() => value.apply(target, args));
          providerOperations.add(operation);
          try {
            const result = await operation;
            if (property === "spawnDuplexProcess" && result?.exited instanceof Promise) {
              const exited: Promise<unknown> = result.exited;
              liveProcesses.add(exited);
              void exited.then(() => liveProcesses.delete(exited), () => { providerOutcomeUnknown = true; }).catch(() => {});
            }
            return result;
          } catch (error) {
            // A failed read cannot have executed the user's mutating command.
            // Preserve that fact through the tool's model-facing error wrapper.
            if (["readFile", "readFileBytes", "status"].includes(String(property))) {
              throw Object.assign(new Error(error instanceof Error ? error.message : String(error), { cause: error }),
                { outcomeUnknown: false });
            }
            await quarantineExecution(error);
            // Preserve uncertainty before an SDK/harness can turn this into a
            // normal tool error and ask the model to dispatch it again.
            if (borrowedAllocation !== undefined && input.executionFence !== undefined) {
              await lifecycle.release({ executionFence: input.executionFence,
                allocationId: borrowedAllocation, unknown: true });
            }
            throw error;
          } finally {
            providerOperations.delete(operation);
          }
        };
      },
    });
    const guardedSandbox = input.executionFence === undefined
      ? access
      : withSandboxExecutionGuard(access, {
          signal: abortController.signal,
          isValid: () => input.executionFence === undefined ||
            Date.parse(input.executionFence.expiresAt) > this.dependencies.clock.now().getTime(),
        });
    let acquisition: Promise<void> | undefined;
    const ensureSandbox = (): Promise<void> => acquisition ??= this.beginSandboxStartup({
      ...input,
      signal: abortController.signal,
    }).then(async () => {
      if (abortController.signal.aborted) throw abortedError(abortController.signal);
      // A prior text-only turn may still have been preparing an older
      // resource/environment snapshot when this turn began.
      if (this.sessions.get(input)?.fingerprint !== this.sandboxFingerprint(input)) {
        await this.beginSandboxStartup({ ...input, signal: abortController.signal });
      }
      if (abortController.signal.aborted) throw abortedError(abortController.signal);
      attemptSandbox = this.sessions.get(input)?.sandbox ?? rawSandbox;
      sandboxReady = true;
    }).catch((error) => {
      acquisition = undefined;
      throw error;
    });
    const sandbox: SandboxExecutor = deferred ? {
      exec: async (...args) => { await ensureSandbox(); return guardedSandbox.exec(...args); },
      readFile: async (...args) => { await ensureSandbox(); return guardedSandbox.readFile(...args); },
      writeFile: async (...args) => { await ensureSandbox(); return guardedSandbox.writeFile(...args); },
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
    });
    const parkedStill = (remainingAfterAnswers?.length ?? 0) > 0;
    let budgetGate: SessionBudgetGate | null = null as SessionBudgetGate | null;
    let releaseBudgetGate = () => {};
    let turnTools: HarnessContext["tools"] | undefined;
    let runFailed = false;
    let primaryFailure: SessionRetriesExhaustedError | undefined;
    let escapingFailure: Error | undefined;
    const retainFailure = (error: unknown): Error => {
      // Shared-state corruption cannot wait for potentially hung cleanup.
      if (hasProcessInvariantFailure(error)) terminateForInvariant(error);
      const next = error instanceof Error ? error : new Error(String(error));
      if (escapingFailure === undefined) escapingFailure = next;
      else if (escapingFailure !== next) {
        escapingFailure.cause = new AggregateError(
          [...(escapingFailure.cause === undefined ? [] : [escapingFailure.cause]), next],
          "Execution and cleanup failed",
        );
      }
      return escapingFailure;
    };
    let toolsAcquisition: Promise<HarnessContext["tools"]> | undefined;
    try {
      if (this.dependencies.executionDispatches !== undefined && input.executionFence !== undefined) {
        if (!await this.dependencies.executionDispatches.begin(input.executionFence)) {
          throw new Error("An earlier execution may have dispatched effects; reconcile its outcome before resuming this Session");
        }
        dispatchBegan = true;
      }
      if (!parkedStill) runtime.broadcastProducedEvent({ type: "session.status_running" });
      for (const event of input.events) {
        if (event.type !== "user.tool_confirmation") continue;
        assertCanDispatch();
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
              ...(this.dependencies.executionDispatches === undefined ? {} : { onOutcomeUnknown: quarantineExecution, assertCanDispatch }),
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
                runtime: childRuntime, model, tools: guardTools(childTools),
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
          delegateToAgent: async (agentId, message) => {
            const child = await subagents.create({ agentId, message });
            const result = (await subagents.wait({ threadIds: [child.threadId] })).subagents[0]!;
            if (result.status === "failed") throw new Error(`Subagent ${child.threadId} failed`);
            return result.output ?? "(sub-agent produced no text output)";
          },
        };
      }
      const toolsPromise = toolsAcquisition = this.dependencies
        .buildTools({ ...context, ...subagentContext, sandbox })
        .then((tools) => {
          turnTools = tools;
          return tools;
        });
      const [model, acquiredTools] = await Promise.all([
        this.dependencies.buildModel(context),
        toolsPromise,
      ]);
      const tools = guardTools(acquiredTools);
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
          const sessionBudget = input.session.budget ?? null;
          const pricing = sessionBudget === null
            ? null
            : await this.dependencies.resolveModelPricing?.(context) ?? null;
          // Domain gate; Node ListCostPicoStore persists session.usage.list_cost_pico.
          const store = {
            // Sessions persisted before list_cost_pico survived the runtime
            // boundary resume from their rounded cents rather than from 0.
            load: (): string => consumedListCostPico(input.session).toString(),
            save: (list_cost_pico: string): void => {
              const usage = { ...runtime.usageSnapshot(), list_cost_pico };
              if (input.session.usage) {
                input.session.usage.list_cost_pico = list_cost_pico;
              } else {
                input.session.usage = { list_cost_pico };
              }
              runtime.broadcastProducedEvent({ type: "session.usage", usage });
            },
          };
          harnessContext.budget = createSessionBudgetGate(
            sessionBudget === null
              ? null
              : { amount: sessionBudget.amountMinor, currency: sessionBudget.currency },
            pricing,
            store,
          );
        }
        budgetGate = harnessContext.budget ?? null;
        runtime.setBudgetGate(budgetGate);
        subagentContext.subagents?.setBudgetGate?.(budgetGate);
        // Harness-in-sandbox inference-proxy meters via the same gate.
        if (abortController.signal.aborted || (input.executionFence !== undefined &&
          Date.parse(input.executionFence.expiresAt) <= this.dependencies.clock.now().getTime())) throw abortedError(abortController.signal);
        releaseBudgetGate();
        releaseBudgetGate = registerNodeSessionBudgetGate(input, budgetGate);
        const retry = this.dependencies.harnessRetry ??
          { attempts: 3, delayMs: (attempt: number) => Math.min(30_000, 2_000 * 2 ** (attempt - 1)) };
        for (let attempt = 1; ; attempt += 1) {
          const agentEventsBefore = runtime.agentEventCount;
          try {
            await this.dependencies.buildHarness().run(harnessContext);
            if (providerOutcomeUnknown) throw new Error("Sandbox operation outcome is unknown; the execution requires reconciliation");
            return;
          } catch (error) {
            if (!(error instanceof Error)) throw error;
            const sideEffectFree = runtime.agentEventCount === agentEventsBefore && !providerDispatched && !toolDispatched
              && input.session.agent.openma?.harness !== "acp-sandbox";
            if (
              !sideEffectFree
              || attempt >= retry.attempts
              || abortController.signal.aborted
              || hasProcessInvariantFailure(error)
              || !APICallError.isInstance(error) || !error.isRetryable
            ) {
              throw error;
            }
            runtime.broadcastProducedEvent({
              type: "session.error",
              error: {
                type: "unknown_error",
                message: error instanceof Error ? error.message : String(error),
                retryStatus: "retrying",
              },
            });
            runtime.broadcastProducedEvent({ type: "session.status_rescheduled" });
            await abortableDelay(retry.delayMs(attempt), abortController.signal);
            if (abortController.signal.aborted) throw error;
          }
        }
      };
      if (!parkedStill) await runHarness();
      if (event.type === "user.define_outcome") {
        const maxIterations = Math.min(
          20,
          Math.max(1, event.maxIterations ?? 3),
        );
        for (let iteration = 0; iteration < maxIterations; iteration += 1) {
          const evaluationHistory = runtime.getApplicationHistoryEvents();
          const startId = runtime.broadcastProducedEvent({
            type: "span.outcome_evaluation_start",
            outcomeId: event.outcomeId,
            iteration,
          });
          runtime.broadcastProducedEvent({
            type: "span.outcome_evaluation_ongoing",
            outcomeId: event.outcomeId,
            iteration,
          });
          let evaluation: ManagedNodeOutcomeEvaluationResult;
          try {
            evaluation = await this.dependencies.outcomes.evaluate({
              workspaceId: input.workspaceId,
              session: input.session,
              environment: input.environment,
              outcome: event,
              historyEvents: evaluationHistory,
              iteration,
              abortSignal: abortController.signal,
            });
          } catch (error) {
            const interrupted = abortController.signal.aborted ||
              (error instanceof Error && error.name === "AbortError");
            evaluation = {
              result: "failed",
              explanation: interrupted
                ? "outcome evaluation interrupted by user"
                : `outcome evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
              usage: {
                cacheCreationInputTokens: 0,
                cacheReadInputTokens: 0,
                inputTokens: 0,
                outputTokens: 0,
              },
            };
            runtime.broadcastProducedEvent({
              type: "span.outcome_evaluation_end",
              outcomeId: event.outcomeId,
              outcomeEvaluationStartId: startId,
              iteration,
              result: interrupted ? "interrupted" : "failed",
              explanation: evaluation.explanation,
              usage: evaluation.usage,
            });
            break;
          }
          const needsRevision = evaluation.result === "needs_revision";
          const result = needsRevision && iteration === maxIterations - 1
            ? "max_iterations_reached"
            : evaluation.result;
          runtime.broadcastProducedEvent({
            type: "span.outcome_evaluation_end",
            outcomeId: event.outcomeId,
            outcomeEvaluationStartId: startId,
            iteration,
            result,
            explanation: evaluation.explanation,
            usage: evaluation.usage,
          });
          if (!needsRevision || result === "max_iterations_reached") break;
          runtime.appendOutcomeFeedback(iteration, evaluation.explanation);
          await runHarness();
        }
      }
      // The turn's sandbox work is done. A sandbox replaced after the agent's
      // last operation took this turn's unpublished changes with it, and the
      // agent was never told: the turn must not end as if they existed.
      const unreported = await recovery.close();
      if (unreported !== null) {
        throw new Error(`The environment restarted after the agent's last step. ${unreported.split(" Background processes")[0].replace(/^This tool call was interrupted because the environment restarted\. /, "")} The changes made in this turn were lost.`);
      }
    } catch (error) {
      runFailed = true;
      if (abortController.signal.reason === "lease_lost") retainFailure(error);
      else {
        primaryFailure = new SessionRetriesExhaustedError(error instanceof Error ? error.message : String(error));
        primaryFailure.cause = error;
        retainFailure(primaryFailure);
      }
      try { await recovery.close(); } catch (cleanup) { retainFailure(cleanup); }
      if (abortController.signal.reason === "lease_lost") throw escapingFailure;
      try { runtime.broadcastProducedEvent({
        type: "session.error",
        error: {
          type: "unknown_error",
          message: error instanceof Error ? error.message : String(error),
          // The turn may have produced side effects (tool calls), so it is not
          // retried automatically: CMA semantics for a dead turn are `exhausted`.
          retryStatus: "exhausted",
        },
      }); } catch (publication) { retainFailure(publication); }
      throw escapingFailure;
    } finally {
      try {
        let finalizationError: Error | undefined;
        const recordFinalizationError = (error: unknown) => {
          const next = error instanceof Error ? error : new Error(String(error));
          finalizationError = finalizationError === undefined ? next
            : new AggregateError([finalizationError, next], "Multiple finalization failures");
        };
        const subagents = this.subagentExecutions.get(input);
        try {
          if (runFailed) abortController.abort();
          await subagents?.drain();
        } catch (error) {
          recordFinalizationError(error);
        } finally {
          if (this.subagentExecutions.get(input) === subagents) this.subagentExecutions.delete(input);
        }
        try {
          // A model failure may race successful tool/MCP acquisition. Join the
          // acquisition before releasing so a late result never escapes cleanup.
          await toolsAcquisition?.catch(() => undefined);
          if (turnTools !== undefined) {
            await this.dependencies.disposeTools?.(turnTools);
          }
        } catch (error) {
          recordFinalizationError(error);
        }
        try {
          if (
            sandboxReady && !sandboxLost && (lifecycle === undefined || borrowedAllocation !== undefined) &&
            input.executionFence !== undefined &&
            this.dependencies.synchronizeSandbox !== undefined
          ) {
            const executionFence = input.executionFence;
            await this.sessions.get(input)?.runtime?.withSandbox(async () => {
              await this.dependencies.synchronizeSandbox!({
                workspaceId: input.workspaceId,
                session: input.session,
                environment: input.environment,
                sandbox: lifecycle === undefined ? currentSandbox() : access,
                runtimeGeneration: this.sessions.get(input)?.generation ?? runtimeGeneration,
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
        const turnWorkspace = this.sessions.get(input)?.workspace ?? workspace;
        if (!runFailed && finalizationError === undefined && (lifecycle === undefined || borrowedAllocation !== undefined) && checkpointService !== undefined && turnWorkspace !== undefined && input.executionFence !== undefined) {
          const workspace = turnWorkspace;
          try {
            const active = await checkpointService.active(workspace.scope);
            if (active?.candidate.id !== (workspace.activeId ?? undefined)) {
              throw new Error("Managed workspace checkpoint changed during execution");
            }
            if (checkpointService.due(active)) {
              const fence = input.executionFence;
              const candidate = await (lifecycle === undefined ? workspace.port : checkpointService.port(access)).checkpoint({
                scope: { ...workspace.scope, workId: fence.executionId },
                fence: checkpointService.runtimeFence(fence, workspace.scope.environmentId),
                strategy: "checkpoint_restore", binding: workspace.binding,
                sandbox: { provider: "node", runtimeId: this.sessions.get(input)?.generation ?? runtimeGeneration },
                idempotencyKey: `${fence.executionId}-${fence.attemptId}`,
                signal: abortController.signal,
              });
              if (!await checkpointService.publish({ fence, candidate, expectedId: workspace.activeId })) {
                throw new Error("Managed workspace checkpoint lost its Session Execution fence or canonical pointer");
              }
              workspace.activeId = candidate.id;
            }
          } catch (error) {
            recordFinalizationError(error);
          }
        }
        const leaseLost = abortController.signal.reason === "lease_lost";
        const opaque = input.session.agent.openma?.harness !== undefined &&
          !["default", "pi"].includes(input.session.agent.openma.harness);
        const operationsUnknown = providerOutcomeUnknown || providerOperations.size > 0 ||
          toolOperations.size > 0 || liveProcesses.size > 0 || (runFailed && opaque);
        // Release only positively drained use, then persist that evidence before
        // terminal publication. Idle alone never authorizes a takeover.
        if (!operationsUnknown && dispatchBegan && input.executionFence !== undefined) {
          if (lifecycle !== undefined && borrowedAllocation !== undefined) {
            await lifecycle.release({ executionFence: input.executionFence, allocationId: borrowedAllocation, unknown: false });
            borrowedAllocation = undefined;
            borrowing = undefined;
          }
          await this.dependencies.executionDispatches?.drained(input.executionFence);
        }
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
        if (
          !leaseLost && !runFailed && finalizationError === undefined
          && budgetGate?.reached === true
        ) {
          // Official budget stop: thread idle → usage → session idle (budget_reached).
          // requires_action parking is skipped: budget_reached outranks end_turn but
          // requires_action already short-circuits earlier when tools are pending.
          const stopReason = { type: "budget_reached" as const };
          runtime.broadcastProducedEvent({
            type: "session.thread_status_idle",
            agentName: input.session.agent.name,
            sessionThreadId: "sthr_primary",
            stopReason,
          });
          runtime.broadcastProducedEvent({
            type: "session.usage",
            usage: runtime.usageSnapshot(),
            budget: { amountMinor: budgetGate.maxListCost.amount, currency: "USD" },
          });
          runtime.broadcastProducedEvent({ type: "session.status_idle", stopReason });
        } else if (!leaseLost) {
          const failed = runFailed || finalizationError !== undefined;
          const parkIds = failed ? [] : parkedStill ? remainingAfterAnswers! : stillPending(
            runtime.pendingConfirmations,
            asWireEvents(runtime.history.getEvents()),
          );
          runtime.broadcastProducedEvent({
            type: "session.status_idle",
            stopReason: failed ? { type: "retries_exhausted" }
              : parkIds.length > 0 ? { type: "requires_action", eventIds: parkIds }
              : { type: "end_turn" },
          });
        }
          await runtime.drain();
          if (!operationsUnknown && sandboxReady && !sandboxLost &&
            input.executionFence !== undefined && (this.dependencies.afterExecution !== undefined || this.dependencies.publishArtifacts !== undefined)) {
            if (dispatchBegan && !await this.dependencies.executionDispatches?.recoverTerminal(input.executionFence, this.dependencies.publishArtifacts !== undefined)) {
              throw new Error("Post-terminal publication lost its execution authority");
            }
            if (this.dependencies.publishArtifacts !== undefined) {
              await this.publishReadOnlyArtifacts(input, currentSandbox(), input.executionFence, abortController.signal);
            } else await this.dependencies.afterExecution!({
              workspaceId: input.workspaceId,
              session: input.session,
              environment: input.environment,
              sandbox: lifecycle === undefined ? currentSandbox() : access,
              runtimeGeneration: this.sessions.get(input)?.generation ?? runtimeGeneration,
              executionFence: input.executionFence,
            });
          }
        if (finalizationError !== undefined) {
          throw finalizationError;
        }
        const finalWorkspace = this.sessions.get(input)?.workspace;
        if (finalWorkspace !== undefined && !runFailed && !abortController.signal.aborted) {
          finalWorkspace.trusted = true;
        }
      } catch (error) {
        retainFailure(error);
        // The post-terminal extension may perform work beyond sandbox calls.
        // A failed callback is not evidence that all its effects are absent.
        if (dispatchBegan && input.executionFence !== undefined) {
          try { await this.dependencies.executionDispatches?.finish(input.executionFence, true); }
          catch (cleanup) { retainFailure(cleanup); }
        }
        throw escapingFailure;
      } finally {
        let cleanupFailed = false;
        try { releaseBudgetGate(); } catch (error) { cleanupFailed = true; retainFailure(error); }
        // Release this attempt's access only; resource workers own leases.
        try {
          {
            if (lifecycle !== undefined && borrowedAllocation !== undefined && input.executionFence !== undefined) {
              try {
                await lifecycle.release({ executionFence: input.executionFence, allocationId: borrowedAllocation,
                  unknown: providerOutcomeUnknown || providerOperations.size > 0 || liveProcesses.size > 0 });
              } catch (error) { cleanupFailed = true; retainFailure(error); }
            }
            if (dispatchBegan && input.executionFence !== undefined) {
              const opaque = input.session.agent.openma?.harness !== undefined &&
                !["default", "pi"].includes(input.session.agent.openma.harness);
              try {
                await this.dependencies.executionDispatches?.finish(input.executionFence,
                  cleanupFailed || providerOutcomeUnknown || providerOperations.size > 0 || toolOperations.size > 0 ||
                  liveProcesses.size > 0 || (runFailed && opaque));
              } catch (error) { cleanupFailed = true; retainFailure(error); }
            }
          }
        } finally {
          if (this.abortControllers.get(input) === abortController) {
            this.abortControllers.delete(input);
            this.attemptIds.delete(input);
          }
        }
        if (cleanupFailed) throw escapingFailure;
      }

    }
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
    const dispatches = this.dependencies.executionDispatches;
    const readOnlyPublication = this.dependencies.publishArtifacts !== undefined;
    if (dispatches !== undefined && !await dispatches.recoverTerminal(executionFence, readOnlyPublication)) {
      throw new Error("Terminal execution has no durable evidence that its operations drained; reconciliation is required");
    }
    let completed = false;
    const lifecycle = this.dependencies.sandboxLifecycle;
    let allocationId: string | undefined;
    let pending = 0;
    let uncertain = false;
    let primary: Error | undefined;
    try {
      if (this.dependencies.afterExecution !== undefined || readOnlyPublication) {
        if (this.sessions.get(input)?.sandbox === undefined) await this.beginSandboxStartup(input);
        const sandbox = this.sessions.get(input)?.sandbox;
        const runtimeGeneration = this.sessions.get(input)?.generation;
        if (sandbox === undefined || runtimeGeneration === undefined) {
          throw new Error(`Session ${input.sessionId} sandbox was not started`);
        }
        const id = this.sessions.get(input)?.allocationId;
        if (!readOnlyPublication && lifecycle !== undefined && id !== undefined) {
          await lifecycle.borrow({ executionFence, allocationId: id });
          allocationId = id;
        }
        const guarded = new Proxy(sandbox, {
          get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver);
            if (typeof value !== "function") return value;
            if (["runtimeHandle", "runtimeCapabilities", "sessionOutputMountCapabilities", "registerCommandSecrets"].includes(String(property))) return value.bind(target);
            return async (...args: unknown[]) => {
              if (uncertain) throw new Error("Publication outcome requires reconciliation");
              pending++;
              try { return await value.apply(target, args); }
              catch (error) { uncertain = true; throw error; }
              finally { pending--; }
            };
          },
        });
        const signal = new AbortController().signal;
        const access = withSandboxExecutionGuard(guarded, { signal,
          isValid: () => Date.parse(executionFence.expiresAt) > this.dependencies.clock.now().getTime() });
        if (readOnlyPublication) await this.publishReadOnlyArtifacts(input, sandbox, executionFence, signal);
        else await this.dependencies.afterExecution!({ workspaceId: input.workspaceId, session: input.session,
          environment: input.environment, sandbox: access, runtimeGeneration, executionFence });
      }
      completed = true;
    } catch (error) {
      primary = error instanceof Error ? error : new Error(String(error));
      throw primary;
    } finally {
      const cleanup: unknown[] = [];
      try {
        if (lifecycle !== undefined && allocationId !== undefined) {
          await lifecycle.release({ executionFence, allocationId, unknown: uncertain || pending > 0 });
        }
      } catch (error) { cleanup.push(error); }
      try { await dispatches?.finish(executionFence, !completed || uncertain || pending > 0 || cleanup.length > 0); }
      catch (error) { cleanup.push(error); }
      if (cleanup.length > 0) {
        if (primary !== undefined) {
          primary.cause = new AggregateError([...(primary.cause === undefined ? [] : [primary.cause]), ...cleanup], "Publication cleanup failed");
          throw primary;
        }
        throw new AggregateError(cleanup, "Publication cleanup failed");
      }
    }
    // Settle with the outcome the original attempt would have reported.
    if (terminal.stopReason.type === "retries_exhausted") {
      throw new SessionRetriesExhaustedError(`Execution ${executionFence.executionId} already ended with retries_exhausted`);
    }
  }

  private async publishReadOnlyArtifacts(
    input: ManagedRunnerContext, sandbox: SandboxExecutor, fence: SessionExecutionFence, signal: AbortSignal,
  ): Promise<void> {
    const dispatches = this.dependencies.executionDispatches;
    let writeUncertain = false;
    let writeFailure: unknown;
    let writing = false;
    const guarded = withSandboxExecutionGuard(sandbox, { signal,
      isValid: () => !writeUncertain && Date.parse(fence.expiresAt) > this.dependencies.clock.now().getTime() });
    // Read-only operations hold no mutable resource use: losing their response
    // cannot change the workspace. The exact allocation stays Session-owned.
    await this.dependencies.publishArtifacts!({
      workspaceId: input.workspaceId, session: input.session, executionFence: fence,
      outputs: readOnlyArtifactOutputs(guarded),
      write: async operation => {
        if (writing || writeUncertain) throw new Error("Artifact write is pending or requires reconciliation");
        writing = true;
        try {
          signal.throwIfAborted();
          if (dispatches && !await dispatches.publicationWrite(fence, false)) throw new Error("Artifact write lost its execution authority");
          const result = await operation();
          if (dispatches && !await dispatches.publicationWrite(fence, true)) throw new Error("Artifact write confirmation lost its execution authority");
          return result;
        } catch (error) {
          writeUncertain = true;
          writeFailure = error;
          try { await dispatches?.finish(fence, true); }
          catch (cleanup) { throw new AggregateError([error, cleanup], "Artifact write and uncertainty persistence failed"); }
          throw error;
        } finally { writing = false; }
      },
    });
    if (writeUncertain || writing) throw new Error("Artifact write outcome requires reconciliation", { cause: writeFailure });
  }

  async archiveThread(
    input: ArchiveNodeManagedSessionThread,
  ): Promise<void> {
    await this.subagentExecutions.get(input)?.archiveThread(input.threadId);
  }
}
