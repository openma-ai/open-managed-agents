import { WorkVerifierExitUnconfirmedError } from "./node-work-verifier.js";
import { createDefaultWorkComposition, loadWorkRuntimeModules, type DefaultWorkCompositionOptions } from "./node-work-composition.js";
import { isDeepStrictEqual } from "node:util";
import { createWorkBootstrapHttpClient, type WorkBootstrapClaim, type WorkBootstrapRoot } from "./work-bootstrap-http.js";
import type { NodeManagedAcpSupervisorAppOptions } from "./node-supervisor.js";
import { createWorkFinalizationHttpClient, WorkFinalizationTransportError, type WorkFinalizationResult } from "./work-finalization-http.js";
import { NodeManagedAcpWorkItemFailure, type NodeManagedAcpWorkItemPhase } from "./work-item-failure.js";
import Anthropic from "@anthropic-ai/sdk";
import {
  createClaimedEnvironmentWorkRunner,
  type ClaimedEnvironmentWorkLifecycleClient,
  type ClaimedEnvironmentWorkScheduler,
} from "@open-managed-agents/managed-runtime-host";
import { managedMcpProxyFromWorkEnvironment } from "@open-managed-agents/acp-runtime/sandbox-agent";

import {
  createNodeManagedAcpSupervisorApp,
  type NodeManagedAcpSupervisorApp,
} from "./node-supervisor.js";

export type { NodeManagedAcpSupervisorApp } from "./node-supervisor.js";

export interface WorkRunnerCompositionContext {
  claim: WorkBootstrapClaim;
  root: WorkBootstrapRoot;
  revision: number;
  signal: AbortSignal;
  onTurnAdmitted(turnId: string): void;
  onTurnPublished(turnId: string): void;
}
export type WorkRunnerComposition = (context: WorkRunnerCompositionContext) => Promise<
  Omit<NodeManagedAcpSupervisorAppOptions, "environment" | "fetch" | "workClaim"> & {
    control: NonNullable<NodeManagedAcpSupervisorAppOptions["control"]> & { runtime: import("./work-control-runtime.js").WorkControlRuntime };
    finalization: NonNullable<NodeManagedAcpSupervisorAppOptions["finalization"]>;
    /** E2B uses the same verified runtime with its mandatory isolated spawner. */
    createAcpRuntime?(spawner: Awaited<ReturnType<typeof import("./node-e2b-work-item.js").loadE2BAgentSpawner>>): NonNullable<NodeManagedAcpSupervisorAppOptions["acpRuntime"]>;
  }
>;

export interface NodeManagedAcpWorkItemRunnerOptions {
  environment?: Readonly<Record<string, string | undefined>>;
  signal?: AbortSignal;
  bootstrapPollIntervalMs?: number;
  /** Sole runtime/drain composition boundary. Called only for an authoritative
   * run plan, never for idle or committed cleanup. No dynamic workspace loader. */
  composition?: WorkRunnerComposition;
  /** Trusted module/spawner/activity ports; defaults load the installed runtime. */
  runtime?: DefaultWorkCompositionOptions;
  lifecycleClient?: ClaimedEnvironmentWorkLifecycleClient;
  supervisorApp?: NodeManagedAcpSupervisorApp;
  /** Trusted bootstrap selection, before any harness resolution. Never derive
   * this from last idle or the last row of a paginated input stream. */
  recovery?: { resolveTurn(signal: AbortSignal): Promise<string> };
  /** Lazily composed after recovery; hooks carry only this process's admitted
   * turn, not authority. All persistence revalidates through work-recovery. */
  supervisorFactory?(hooks: { admitted(turnId: string): void; published(turnId: string): void }): NodeManagedAcpSupervisorApp;
  resolveExecutionChannels?: import("./node-supervisor.js").NodeManagedAcpSupervisorAppOptions["resolveExecutionChannels"];
  fetch?: typeof globalThis.fetch;
  harness?: { id: string; version: string };
  workspacePath?: string;
  outputPath?: string | null;
  heartbeatIntervalMs?: number;
  heartbeatTtlSeconds?: number;
  scheduler?: ClaimedEnvironmentWorkScheduler;
  /** Explicit legacy embedding barrier. Recovery-aware runners use the real
   * private checkpoint protocol by default; production supervisor owns the
   * common pre-terminal seam and may replace this callback with that same Port. */
  checkpoint?(input: { sessionId: string; turnId?: string }): Promise<void>;
  onError?(error: unknown): void | Promise<void>;
}

export { NodeManagedAcpWorkItemFailure, type NodeManagedAcpWorkItemPhase } from "./work-item-failure.js";

export interface NodeManagedAcpWorkItemRunner {
  run(signal?: AbortSignal): Promise<void>;
}

function required(
  environment: Readonly<Record<string, string | undefined>>,
  key: string,
): string {
  const value = environment[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${key} is required`);
  }
  return value;
}

function lifecycleClientFromEnvironment(input: {
  capability: { gatewayBaseUrl: string; sessionsToken: string };
  fetch?: typeof globalThis.fetch;
}): ClaimedEnvironmentWorkLifecycleClient {
  const client = new Anthropic({
    apiKey: null,
    authToken: input.capability.sessionsToken,
    baseURL: input.capability.gatewayBaseUrl,
    maxRetries: 0,
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
  });
  return client.beta.environments.work;
}

/**
 * Execute one ACP whole-brain session inside an already-created sandbox.
 *
 * The outer webhook/poll Function only reserves and dispatches Work. This
 * process ACKs it, owns the CAS heartbeat and terminal stop, and keeps the
 * Managed Session event stream alive for prompt, cancel, and ACP steer while
 * a turn is running. Only the Work-scoped sessions token leaves the control
 * plane; the environment standing key is deliberately ignored.
 */
export function createNodeManagedAcpWorkItemRunner(
  options: NodeManagedAcpWorkItemRunnerOptions = {},
): NodeManagedAcpWorkItemRunner {
  const environment = options.environment ?? process.env;
  const environmentId = required(environment, "ANTHROPIC_ENVIRONMENT_ID");
  const sessionId = required(environment, "ANTHROPIC_SESSION_ID");
  const workId = required(environment, "ANTHROPIC_WORK_ID");
  // Validate the scoped credential even when a lifecycle test double is
  // injected: the supervisor uses the same capability for Session/MCP calls.
  const capability = managedMcpProxyFromWorkEnvironment(environment);
  if (capability === null) {
    throw new TypeError("ANTHROPIC_WORK_SECRET must contain a scoped sessions_token and API base URL");
  }
  const harness = options.harness ?? {
    id: required(environment, "OPENMA_HARNESS_ID"),
    version: environment.OPENMA_HARNESS_VERSION?.trim() || "1",
  };
  const workspacePath = options.workspacePath ?? "/workspace";
  const outputPath = options.outputPath === undefined
    ? environment.OPENMA_OUTPUT_PATH?.trim() || "/mnt/session/outputs"
    : options.outputPath;
  let admittedTurn: string | undefined;
  const hooks = {
    admitted(turnId: string) {
      if (!turnId || (admittedTurn !== undefined && admittedTurn !== turnId)) throw new Error("Overlapping canonical Work turns");
      admittedTurn = turnId;
    },
    published(turnId: string) {
      if (admittedTurn !== turnId) throw new Error("Work publication identity mismatch");
      admittedTurn = undefined;
    },
  };
  let composed: NodeManagedAcpSupervisorAppOptions | undefined;
  let trustedClaim: WorkBootstrapClaim | undefined;
  const supervisor = () => options.supervisorApp ?? options.supervisorFactory?.(hooks) ?? createNodeManagedAcpSupervisorApp({
    ...composed, environment, workspacePath, fetch: options.fetch,
    ...(trustedClaim === undefined ? {} : { workClaim: trustedClaim }),
    onTurnAdmitted: composed?.onTurnAdmitted ?? hooks.admitted,
    onTurnPublished: composed?.onTurnPublished ?? hooks.published,
    resolveExecutionChannels: composed?.resolveExecutionChannels ?? options.resolveExecutionChannels,
    ...(environment.OPENMA_ACP_AGENT_ID?.trim() ? { agentId: environment.OPENMA_ACP_AGENT_ID.trim() } : {}),
  } as NodeManagedAcpSupervisorAppOptions);
  const bootstrap = createWorkBootstrapHttpClient({ apiBaseUrl: capability.gatewayBaseUrl, sessionId, environmentId, workId, sessionsToken: capability.sessionsToken, fetch: options.fetch });
  const bootstrapMode = options.recovery === undefined && !(options.supervisorApp && options.checkpoint);
  const recoveryAware = bootstrapMode || options.recovery !== undefined;
  const pollMs = options.bootstrapPollIntervalMs ?? 1000;
  if (!Number.isSafeInteger(pollMs) || pollMs < 1) throw new TypeError("Invalid bootstrap poll interval");
  const pause = options.scheduler?.sleep ?? abortableSleep;
  const finalization = createWorkFinalizationHttpClient({ apiBaseUrl: capability.gatewayBaseUrl, sessionId, sessionsToken: capability.sessionsToken, fetch: options.fetch });
  const rejected = (result: WorkFinalizationResult): Error => new Error(
    `Work finalization ${result.type}${"reason" in result ? ": " + result.reason : ""}`,
  );
  const publish = async (state: Extract<WorkFinalizationResult, {terminal: unknown}>, signal: AbortSignal) => {
    const { terminal, revision } = state;
    signal.throwIfAborted();
    try {
      const result = await finalization.publish({ turnId: terminal.turnId, revision, terminalEventId: terminal.eventId }, signal);
      if (result.type !== "published" || result.terminal.eventId !== terminal.eventId) throw rejected(result);
    } catch (error) {
      // Do not repeat a mutation on an unknown response. Record canonical truth
      // first; the next owner can retry the idempotent publisher, never model.
      if (error instanceof WorkFinalizationTransportError && !signal.aborted) {
        await finalization.recover(terminal.turnId, signal);
      }
      throw error;
    }
  };
  const settleFailure = async (turnId: string, phase: "run" | "finalization", signal: AbortSignal) => {
    let state = await finalization.recover(turnId, signal);
    if (state.type === "gap" && state.reason === "consumed_turn_without_terminal" && state.revision !== undefined) {
      try { state = await finalization.fail({ turnId, revision: state.revision, phase }, signal); }
      catch (error) {
        if (!(error instanceof WorkFinalizationTransportError) || signal.aborted) throw error;
        state = await finalization.recover(turnId, signal);
        if (state.type !== "committed" && state.type !== "parked") throw error;
      }
    }
    if (state.type !== "committed" && state.type !== "parked") throw rejected(state);
    await publish(state, signal);
  };
  const client = options.lifecycleClient ?? lifecycleClientFromEnvironment({capability,fetch:options.fetch});
  let suppressFinallyStop = true;
  let stopFailure: NodeManagedAcpWorkItemFailure | undefined;
  const requestStartup = async (action: string, body: unknown) => {
    const response = await (options.fetch ?? globalThis.fetch)(
      capability.gatewayBaseUrl.replace(/\/+$/u, "") + "/v1/oma/sessions/" + encodeURIComponent(sessionId) + "/" + action,
      {method:"POST",headers:{authorization:"Bearer " + capability.sessionsToken,"content-type":"application/json"},body:JSON.stringify(body)},
    );
    if (!response.ok) throw new Error("ACP startup settlement rejected: " + response.status);
    return response;
  };
  const lifecycle = createClaimedEnvironmentWorkRunner({
    client: {
      ack: (...args) => client.ack(...args),
      heartbeat: (...args) => client.heartbeat(...args),
      // common finally is cleanup, not authority to discard a failed turn.
      // The private settlement already stops Work, or leaves it recoverable.
      stop: async (...args) => {
        if (suppressFinallyStop) return {};
        try { return await client.stop(...args); }
        catch (error) {
          // common's finally catches through onError. Preserve a failed final
          // publication independently of whether that observer returns normally.
          stopFailure = new NodeManagedAcpWorkItemFailure("finalization", error);
          throw stopFailure;
        }
      },
    },
    heartbeatIntervalMs: options.heartbeatIntervalMs,
    heartbeatTtlSeconds: options.heartbeatTtlSeconds,
    scheduler: options.scheduler,
    onError: options.onError,
  });

  return {
    async run(signal) {
      // Refuse before ACK/model start until durable storage is composed.
      if (options.supervisorApp !== undefined && options.recovery === undefined && options.checkpoint === undefined && options.composition === undefined) {
        throw new Error("Work checkpoint recovery authority is not configured");
      }
      const checkpoint = options.checkpoint ?? (async (input: {sessionId: string; turnId?: string}) => {
        if (input.sessionId !== sessionId || !input.turnId || admittedTurn !== input.turnId) throw new Error("Canonical admitted Work turn required");
        const state = await finalization.recover(input.turnId, currentSignal!);
        if (state.type !== "gap" || state.reason !== "consumed_turn_without_terminal" || state.revision === undefined) throw rejected(state);
        const result = await finalization.checkpoint({turnId:input.turnId,revision:state.revision}, currentSignal!);
        if (result.type !== "prepared") throw rejected(result);
      });
      let currentSignal: AbortSignal | undefined;
      suppressFinallyStop = true;
      stopFailure = undefined;
      await lifecycle.run({
        environmentId,
        sessionId,
        workId,
        signal: signal ?? options.signal,
        execute: async (workSignal) => {
          suppressFinallyStop = true;
          currentSignal = workSignal;
          admittedTurn = undefined;
          let selectedTurn: string | undefined;
          let cleanupReceipt: import("./work-finalization-http.js").WorkTerminalReceipt | undefined;
          let runPlan: Extract<import("./work-bootstrap-http.js").WorkBootstrapPlan, {type:"run"}> | undefined;
          if (bootstrapMode) {
            while (true) {
              const plan = await bootstrap.read(workSignal);
              if (plan.type === "idle" || (plan.type === "rejected" && plan.reason === "authority_changed")) {
                await pause(pollMs, workSignal);
                continue;
              }
              if (!("claim" in plan)) throw new Error(`Work bootstrap ${plan.type}: ${plan.reason}`);
              trustedClaim = plan.claim;
              selectedTurn = plan.root.turnId;
              if (plan.type === "run") runPlan = plan;
              else cleanupReceipt = plan.terminal;
              break;
            }
          } else if (options.recovery !== undefined) selectedTurn = await options.recovery.resolveTurn(workSignal);
          if (selectedTurn !== undefined) {
            const state = await finalization.recover(selectedTurn, workSignal);
            if (state.type === "committed" || state.type === "parked") {
              if (cleanupReceipt !== undefined && !isDeepStrictEqual(cleanupReceipt, state.terminal)) throw new Error("Work bootstrap terminal receipt changed during recovery");
              await publish(state, workSignal);
              if (state.terminal.stopReason.type === "retries_exhausted") {
                throw new NodeManagedAcpWorkItemFailure("run", new Error(`Canonical turn ${selectedTurn} already ended with retries_exhausted`));
              }
              return;
            }
            if (state.type !== "run") throw rejected(state);
            workSignal.throwIfAborted();
            if (bootstrapMode) {
              if (!runPlan) throw new Error("Bootstrap cleanup receipt no longer matches recovery; replan required");
              const compose = options.composition ?? createDefaultWorkComposition({ ...options.runtime, workspacePath, environment, fetch: options.fetch, resolveExecutionChannels: options.resolveExecutionChannels });
              composed = await compose({ claim: runPlan.claim, root: runPlan.root, revision: state.revision,
                signal: workSignal, onTurnAdmitted: hooks.admitted, onTurnPublished: hooks.published });
              if (!composed?.control?.runtime || typeof composed.finalization?.drainTurn !== "function") {
                throw new Error("Work composition requires gated runtime and actual drainTurn capability");
              }
            }
          }
          let revision: number | undefined;
          let phase: NodeManagedAcpWorkItemPhase = "startup";
          let active: import("@open-managed-agents/harness-supervisor").HarnessSupervisorRun | null = null;
          try {
            const boundary = await (await requestStartup("startup-boundary", {})).json() as {revision?: unknown};
            if (!Number.isSafeInteger(boundary.revision) || Number(boundary.revision) < 0) throw new Error("ACP startup boundary unavailable");
            revision = Number(boundary.revision);
            const resolved = await supervisor().resolveHarness(harness);
            if (resolved === null) throw new Error(`Harness ${harness.id}@${harness.version} is not installed`);

            active = await resolved.start({
              scope: {
                workspaceId: trustedClaim?.workspaceId ?? (environment.OPENMA_WORKSPACE_ID?.trim() || "default"),
                environmentId,
                sessionId,
                workId,
              },
              harness,
              workspacePath: "/workspace",
              outputPath: outputPath === null ? null : "/mnt/session/outputs",
              checkpoint: async input => {
                try {
                  workSignal.throwIfAborted();
                  await checkpoint(input);
                  workSignal.throwIfAborted();
                } catch (error) {
                  throw new NodeManagedAcpWorkItemFailure("finalization", error);
                }
              },
              signal: workSignal,
            });
            phase = "run";
            const result = await active.completed;
            workSignal.throwIfAborted();
            if (result.exitCode !== 0) {
              throw new Error(`ACP harness exited with code ${String(result.exitCode)}`);
            }
            phase = "finalization";
            await active.drain();
            workSignal.throwIfAborted();
            // Recovery-aware resident consumers never stop a whole Work from
            // one turn's receipt. Legacy explicit test harness path retained.
            suppressFinallyStop = recoveryAware;
          } catch (error) {
            const failure = error instanceof NodeManagedAcpWorkItemFailure
              ? error : new NodeManagedAcpWorkItemFailure(
                isFinalizationFailure(error) ? "finalization" : phase, error,
              );
            const errors: unknown[] = [failure];
            try { await active?.stop(workSignal.aborted ? "aborted" : "failed"); }
            catch (cleanupError) { errors.push(cleanupError); }
            // Aborted, failed-run and failed-finalization paths keep Work
            // recoverable. Common finally cannot settle them, even when its
            // heartbeat has not yet observed a successor.
            if (!workSignal.aborted && errors.length === 1 && recoveryAware && failure.phase !== "startup" && !(error instanceof WorkVerifierExitUnconfirmedError) && !(isFinalizationFailure(error) && error.phase === "drain-turn")) {
              const completion = isFinalizationFailure(error) ? error.completion : undefined;
              const turnId = completion?.sessionId === sessionId ? completion.turnId : admittedTurn;
              try {
                if (!turnId) throw new Error("Current canonical Work turn unavailable for failure settlement");
                await settleFailure(turnId, failure.phase, workSignal);
              } catch (settlementError) { errors.push(settlementError); }
            }
            if (!workSignal.aborted && errors.length === 1 && failure.phase === "startup" && revision !== undefined) {
              const body = {revision,processedAt:new Date().toISOString()};
              try {
                // Exact replay confirms a response lost after authority ended.
                try { await requestStartup("startup-failed",body); }
                catch { await requestStartup("startup-failed",body); }
              } catch (settlementError) { errors.push(settlementError); }
            }
            if (errors.length > 1) {
              throw new AggregateError(errors, failure.message, { cause: failure });
            }
            throw failure;
          }
        },
      });
      if (stopFailure !== undefined) throw stopFailure;
    },
  };
}

function isFinalizationFailure(error: unknown): error is Error & {phase?: string;completion: {sessionId:string;turnId:string}} {
  if (!(error instanceof Error) || error.name !== "ManagedHarnessFinalizationError") return false;
  const completion = (error as {completion?: {sessionId?: unknown;turnId?: unknown}}).completion;
  return typeof completion?.sessionId === "string" && typeof completion.turnId === "string" && completion.turnId.length > 0;
}

/** Capability preflight only; default composition is built automatically. */
export async function assertDefaultWorkRuntime(): Promise<void> {
  await loadWorkRuntimeModules();
}
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, {once:true});
  });
}
