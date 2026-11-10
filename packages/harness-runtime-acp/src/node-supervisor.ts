import { InferenceProtocolUnsupportedError } from "@open-managed-agents/acp-runtime/inference-config";
import { NodeManagedAcpStartupConfigurationFailure, NodeManagedAcpWorkItemFailure } from "./work-item-failure.js";
import { createWorkTurnCoordinator, type WorkTurnCoordinator } from "./work-turn-coordinator.js";
import type { WorkControlRuntime, WorkFinalizationPort, WorkTurnCompletion } from "./work-control-runtime.js";
export type { WorkControlRuntime, WorkFinalizationPort, WorkTurnCompletion } from "./work-control-runtime.js";
import { parseInstalledHarnesses } from "@open-managed-agents/acp-runtime/installed-harnesses";
import { createExecutionChannelsHttpResolver } from "./execution-channels-http.js";
import {
  resolveAcpRelease, prepareAcpRelease, validateAcpRelease, acpReleaseMatchesSource,
  parseAcpReleaseSource, isPinnedAcpVersion, type AcpRelease, type AcpReleaseSource,
} from "@openma/common/acp-artifacts";
import type { ManagedAcpExecutionChannelsRequest, ManagedAcpExecutionChannelsResult, ManagedAcpExecutionChannels } from "@open-managed-agents/shared/acp-execution-channels-rpc";
import { sandboxTokenRandomPart } from "@open-managed-agents/sandbox-gateway";
import type { AcpRuntime } from "@open-managed-agents/acp-runtime";
import { posix, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { safeSkillArchivePath } from "@open-managed-agents/acp-runtime/skill-package";
import { unzipSync } from "fflate";
import { createAcpRuntime } from "@open-managed-agents/acp-runtime/placement";
import { resolveKnownAgent } from "@open-managed-agents/acp-runtime/registry";
import { NodeSpawner } from "@open-managed-agents/acp-runtime/node-spawner";
import {
  managedMcpProxyFromWorkEnvironment,
  projectAcpSandboxMcpServers,
} from "@open-managed-agents/acp-runtime/sandbox-agent";
import { wireHostedInferenceForAcpLaunch } from "@open-managed-agents/harness-inference-adapters";
import { bindAcpAgentState, type AcpStatefulAgentSpec } from "@open-managed-agents/acp-runtime/native-state";
import {
  serveHarnessSupervisorJsonl,
  type HarnessSupervisorHarness,
  type HarnessSupervisorScheduler,
} from "@open-managed-agents/harness-supervisor";

import {
  createManagedHarnessHttpRecoveryHistory,
  createManagedHarnessHttpSkillSource,
  type ManagedHarnessHttpScheduler,
  type ManagedHarnessHttpSkillSource,
  type ManagedHarnessWireSession,
} from "./http-control.js";
import {
  createAcpNativeSessionState,
  createNodeAcpHarnessStateIo,
  type NodeAcpHarnessStateIo,
} from "./node.js";
import {
  createManagedEventSemanticRecovery,
  type ManagedHarnessRecoveryHistoryPort,
} from "./semantic-recovery.js";

const CONTROL_PLANE_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_ENVIRONMENT_ID",
  "ANTHROPIC_ENVIRONMENT_KEY",
  "ANTHROPIC_SESSION_ID",
  "ANTHROPIC_WORK_ID",
  "ANTHROPIC_WORK_SECRET",
  "OPENMA_SANDBOX_TOKEN",
] as const;

/** main's Node startup retry: three attempts, 2s then 4s apart, capped at 30s. */
const ACP_STARTUP_RETRY = {
  attempts: 3,
  delayMs: (attempt: number): number => Math.min(30_000, 2_000 * 2 ** (attempt - 1)),
};

export interface ManagedAcpSessionAgentSnapshot {
  readonly id: string;
  readonly version: number;
  readonly model: Readonly<Record<string, unknown>> & { readonly id: string };
  readonly inference?: {
    readonly provider_id: string;
    readonly base_url: string | null;
    readonly protocol_endpoints?: readonly {
      readonly protocol: string;
      readonly proxy_path_segment: string;
      readonly upstream_base_url: string;
    }[];
  };
  readonly mcp_servers: readonly (
    | { readonly type: "url"; readonly name: string; readonly url: string }
    | {
        readonly type: "stdio";
        readonly name: string;
        readonly command: string;
        readonly args?: readonly string[];
        readonly env?: Readonly<Record<string, string>>;
      }
  )[];
  readonly skills: readonly ManagedAcpSkillSnapshot[];
  readonly system: string | null;
  readonly tools: readonly Readonly<Record<string, unknown>>[];
}

export interface ManagedAcpSkillSnapshot extends Readonly<Record<string, unknown>> {
  readonly type: string;
  readonly skill_id: string;
  readonly version: string;
}

export interface ManagedAcpSessionSnapshot extends ManagedHarnessWireSession {
  readonly agent: ManagedAcpSessionAgentSnapshot;
}

export interface NodeManagedAcpAgentResolverInput {
  harness: { id: string; version: string };
  session: ManagedAcpSessionSnapshot;
}

export interface NodeManagedAcpSupervisorAppOptions {
  /** Process environment injected by the outer Environment Worker. */
  environment?: Readonly<Record<string, string | undefined>>;
  /** Host path corresponding to protocol `/workspace`; defaults to `/workspace`. */
  workspacePath?: string;
  heartbeatIntervalMs?: number;
  fetch?: typeof globalThis.fetch;
  /** Existing control-plane authority; Work bearer never doubles as model/MCP. */
  resolveExecutionChannels?(request: ManagedAcpExecutionChannelsRequest): Promise<ManagedAcpExecutionChannelsResult>;
  acpRuntime?: AcpRuntime;
  /** Versioned release cache, independent of the environment image. */
  artifacts?: { root?: string; fetch?: typeof globalThis.fetch };
  stateIo?: NodeAcpHarnessStateIo;
  /** Fixed installed Agent selection for a generic `acp@1` harness. */
  agentId?: string;
  resolveAgent?(
    input: NodeManagedAcpAgentResolverInput,
  ): AcpStatefulAgentSpec | null | Promise<AcpStatefulAgentSpec | null>;
  /** Trusted Work claim returned by the host authority, never inferred from the bearer. */
  workClaim?: { generation: number; holder: string };
  /** Real turn activity drain and post-terminal publication. Required to start. */
  finalization?: Pick<WorkFinalizationPort, "drainTurn">;
  onTurnComplete?(turn: WorkTurnCompletion): Promise<void>;
  /** Local bookkeeping only; durable authority remains in the control plane. */
  onTurnAdmitted?(turnId: string): void;
  onTurnPublished?(turnId: string): void;
  control?: {
    /** Explicitly injected gated common runtime until the new API is published. */
    runtime?: WorkControlRuntime;
    pollIntervalMs?: number;
    scheduler?: ManagedHarnessHttpScheduler;
    retry?: { maxAttempts?: number };
  };
  supervisorScheduler?: HarnessSupervisorScheduler;
  recovery?: { maxCharacters?: number };
  lifecycle?: {
    drainDeadlineMs?: number;
    drainPollIntervalMs?: number;
    abortGraceMs?: number;
    /** Side-effect-free ACP start attempts before the run fails startup. */
    startupRetry?: { attempts: number; delayMs(attempt: number): number };
  };
}

export interface NodeManagedAcpSupervisorApp {
  resolveHarness(
    harness: { id: string; version: string },
  ): Promise<HarnessSupervisorHarness | null>;
  serve(input: {
    input: ReadableStream<Uint8Array>;
    output: WritableStream<Uint8Array>;
  }): Promise<void>;
}

interface ActiveRunContext {
  outputPath: string | null;
  channels: ManagedAcpExecutionChannels | null;
  history: ManagedHarnessRecoveryHistoryPort;
  skills: ManagedHarnessHttpSkillSource;
  /** Project one retrying startup attempt under this run's Work claim. */
  reportStartupRetry(id: string): Promise<void>;
}

/** One supervised run's startup fence; exhaustion fails only this run. */
interface StartupRun {
  signal: AbortSignal;
  nonce: string;
  exhausted(error: unknown): void;
}

/**
 * Production composition for a versioned or preinstalled ACP agent running as the whole
 * brain inside a Node-capable sandbox. Environment Work ownership remains in
 * the outer worker; this process accepts only its scoped supervisor command.
 */
export function createNodeManagedAcpSupervisorApp(
  options: NodeManagedAcpSupervisorAppOptions = {},
): NodeManagedAcpSupervisorApp {
  const environment = options.environment ?? process.env;
  const installedHarnesses = parseInstalledHarnesses(environment.OPENMA_ACP_HARNESSES);
  if (installedHarnesses !== null && (options.agentId !== undefined || options.resolveAgent !== undefined)) {
    throw new TypeError("OPENMA_ACP_HARNESSES cannot be combined with agentId or resolveAgent");
  }
  if (environment.OPENMA_ACP_SOURCES !== undefined && environment.OPENMA_ACP_PACKAGES !== undefined) {
    throw new TypeError("OPENMA_ACP_SOURCES and OPENMA_ACP_PACKAGES cannot be combined");
  }
  const sourceVariable = environment.OPENMA_ACP_SOURCES !== undefined ? "OPENMA_ACP_SOURCES" : "OPENMA_ACP_PACKAGES";
  const explicitSources = environment[sourceVariable] !== undefined;
  const sources = parseHarnessSources(environment[sourceVariable], sourceVariable);
  if (explicitSources && (
    installedHarnesses !== null || options.agentId !== undefined || options.resolveAgent !== undefined
  )) throw new TypeError(`${sourceVariable} cannot be combined with installed harness or agent overrides`);
  const workspacePath = options.workspacePath ?? "/workspace";
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5_000;
  const stateIo = options.stateIo ?? createNodeAcpHarnessStateIo({ workspacePath });
  const acpRuntime = options.acpRuntime ?? createAcpRuntime({
    type: "local",
    spawner: new NodeSpawner(),
  });

  const resolveHarness = async (
    harness: { id: string; version: string },
  ): Promise<HarnessSupervisorHarness | null> => {
    const installed = installedHarnesses?.find((entry) =>
      entry.id === harness.id && entry.version === harness.version);
    const publishedVersion = isPinnedAcpVersion(harness.version) && (explicitSources || harness.version.includes("."));
    const source = installedHarnesses === null && options.agentId === undefined && options.resolveAgent === undefined && publishedVersion
      ? (Object.hasOwn(sources, harness.id) ? sources[harness.id] : explicitSources ? undefined : { type: "registry" as const })
      : undefined;
    if (installedHarnesses !== null ? installed === undefined : source === undefined && harness.version !== "1") return null;
    if (explicitSources && source === undefined) return null;
    const identity: { id: string; version: string; digest?: string } | undefined =
      installed !== undefined || source !== undefined ? { ...harness } : undefined;
    let prepared: AcpStatefulAgentSpec | undefined;
    // `connect` establishes the transport context before the control channel
    // can emit session.start; onSessionLoaded establishes the Session snapshot
    // before that same command is exposed. Definite assignment models that
    // protocol ordering instead of carrying unreachable nullable branches.
    let active!: ActiveRunContext;
    let activeSession!: ManagedAcpSessionSnapshot;
    let startup!: StartupRun;
    let nativeStartAttempted = false;
    let turns!: WorkTurnCoordinator;
    const startupRetry = options.lifecycle?.startupRetry ?? ACP_STARTUP_RETRY;
    const sleep = options.supervisorScheduler?.sleep ?? abortableSleep;
    // A failed spawn/initialize leaves no ACP session and no agent output, so
    // main retries it with retrying + rescheduled facts. Exhaustion is a
    // startup failure for the Work item to settle atomically; this process
    // fences the run first so it never reports it as a turn error or prompts
    // a session that never started.
    const startupRetryingRuntime: AcpRuntime = {
      async start(sessionOptions) {
        const run = startup;
        nativeStartAttempted = true;
        for (let attempt = 1; ; attempt += 1) {
          try {
            const session = await acpRuntime.start(sessionOptions);
            turns.nativeReady(session);
            return session;
          } catch (error) {
            if (run.signal.aborted) throw error;
            let retry = attempt < startupRetry.attempts;
            if (retry) {
              retry = await active.reportStartupRetry(`${run.nonce}:${attempt}`).then(() => true, () => false);
            }
            if (!retry) {
              const startupFailure = new NodeManagedAcpWorkItemFailure("startup", error);
              run.exhausted(startupFailure);
              throw startupFailure;
            }
            await sleep(startupRetry.delayMs(attempt), run.signal).catch(() => undefined);
            if (run.signal.aborted) throw error;
          }
        }
      },
    };
    const sessionState = createAcpNativeSessionState({
      io: stateIo,
      ...(identity === undefined ? {} : { harness: identity }),
      resolveSession: async () => {
        const session = activeSession;
        const resolved: AcpStatefulAgentSpec | null = prepared ?? installed ?? (options.resolveAgent === undefined
          ? defaultAgentResolver(options.agentId ?? harness.id)
          : await options.resolveAgent({ harness, session }));
        if (resolved === null) {
          throw new Error(
            `No installed ACP agent is configured for ${harness.id}@${harness.version}`,
          );
        }
        const skillInstructions = await materializeSkills({
          io: stateIo,
          source: active.skills,
          skills: session.agent.skills,
        });
        const instructions = [
          session.agent.system?.trimEnd() ?? "",
          skillInstructions,
        ].filter((part) => part.length > 0).join("\n\n");
        if (instructions.length > 0) {
          await stateIo.writeFile("/workspace/AGENTS.md", `${instructions}\n`);
        }
        const scrubbedEnvironment = Object.fromEntries(
          CONTROL_PLANE_ENV_KEYS.map((key) => [key, undefined]),
        );
        turns.selectNativeHarness(resolved.id ?? options.agentId ?? harness.id);
        const baseAgent: AcpStatefulAgentSpec = {
          ...resolved,
          id: resolved.id ?? options.agentId ?? harness.id,
          cwd: resolved.cwd ?? "/workspace",
          env: {
            ...(resolved.env ?? {}),
            ...scrubbedEnvironment,
            ...(active.outputPath === null
              ? { OUTPUT_PATH: undefined }
              : { OUTPUT_PATH: active.outputPath }),
          },
        };
        const binding = bindAcpAgentState({
          sessionId: session.id,
          agent: baseAgent,
        });
        const modelHandle = typeof session.agent.model === "string"
          ? session.agent.model
          : session.agent.model.id;
        let agent: AcpStatefulAgentSpec = baseAgent;
        const inference = session.agent.inference;
        if ((inference?.provider_id || session.agent.mcp_servers.some(server => server.type === "url")) && active.channels === null) throw new Error("ACP execution channels authority is required; Work credentials cannot authorize model/MCP");
        if (active.channels !== null) {
          const hosted = (() => { try { return wireHostedInferenceForAcpLaunch({
            sessionId: session.id,
            gatewayBaseUrl: active.channels!.hostedInference.gatewayBaseUrl,
            sessionsToken: active.channels!.hostedInference.sessionsToken,
            env: baseAgent.env ?? {},
            agent: binding.agent,
            nativePath: binding.nativePath,
            model: {
              wireModel: active.channels!.hostedInference.model.wireModel ?? modelHandle,
              providerId: active.channels!.hostedInference.model.providerId,
              baseUrl: active.channels!.hostedInference.model.baseUrl,
              protocolEndpoints: active.channels!.hostedInference.model.protocolEndpoints,
            },
          });
          } catch (error) {
            if (error instanceof InferenceProtocolUnsupportedError && binding.agent.id === "claude-acp") {
              throw new NodeManagedAcpStartupConfigurationFailure("anthropic_protocol_required", error);
            }
            throw error;
          } })();
          for (const file of hosted.files) {
            await stateIo.writeFile(file.path, file.content);
          }
          agent = {
            ...baseAgent,
            env: hosted.env,
          };
        }
        return {
          agent,
          clientCallbacks: { requestPermission: request => turns.requestPermission(request) },
          mcpServers: projectAcpSandboxMcpServers({
            sessionId: session.id,
            gatewayBaseUrl: active.channels?.mcpProxy.gatewayBaseUrl,
            sessionsToken: active.channels?.mcpProxy.sessionsToken,
            servers: session.agent.mcp_servers,
          }),
          sessionRequestMeta: {
            openma: {
              session_id: session.id,
              agent_id: session.agent.id,
              agent_version: session.agent.version,
              model: session.agent.model,
              skills: session.agent.skills,
              tools: session.agent.tools,
            },
          },
        };
      },
    });
    const prepareBeforeNative = async <T>(prepare: () => Promise<T>): Promise<T> => {
      try { return await prepare(); }
      catch (error) {
        if (nativeStartAttempted || startup.signal.aborted) throw error;
        const failure = error instanceof NodeManagedAcpStartupConfigurationFailure ? error
          : new NodeManagedAcpWorkItemFailure("startup", error);
        startup.exhausted(failure);
        throw failure;
      }
    };
    const guardedSessionState = {
      beforeStart: (command: Parameters<typeof sessionState.beforeStart>[0]) => prepareBeforeNative(() => sessionState.beforeStart(command)),
      prepare: (command: Parameters<typeof sessionState.prepare>[0]) => prepareBeforeNative(() => sessionState.prepare(command)),
      onReady: sessionState.onReady.bind(sessionState),
      checkpoint: sessionState.checkpoint.bind(sessionState),
      release: sessionState.release.bind(sessionState),
    };
    const semanticRecovery = createManagedEventSemanticRecovery({
      history: {
        async list(sessionId) {
          return active.history.list(sessionId);
        },
      },
      maxCharacters: options.recovery?.maxCharacters,
    });
    const runtime = options.control?.runtime;
    // Installed 0.13.1 silently ignores the candidate input hooks. Refuse to
    // create a public-history runner rather than advertising unsafe support.
    if (!runtime) throw new Error("Work input dispatch runtime is unavailable; common capability injection required");
    const createSupervisor = runtime.createSupervisor;
    if (!options.finalization || typeof options.finalization.drainTurn !== "function") {
      throw new Error("Work finalization drainTurn port is required");
    }
    const finalization = options.finalization;
    turns = createWorkTurnCoordinator({
      runtime,
      fallbackHarnessId: options.agentId ?? harness.id,
      fetch: options.fetch,
      pollIntervalMs: options.control?.pollIntervalMs,
      scheduler: options.control?.scheduler,
      hasOutcomeEvaluator: options.onTurnComplete !== undefined,
      onTurnAdmitted: options.onTurnAdmitted,
      onTurnPublished: options.onTurnPublished,
      loadSession(session) {
        activeSession = decodeManagedAcpSessionSnapshot(session);
        return activeSession.agent.tools;
      },
      failRun: error => startup.exhausted(error),
    });
    const supervised = createSupervisor({
      finalization: {
        drainTurn: context => finalization.drainTurn(context),
        afterTerminal: context => turns.afterTerminal(context.command.turnId),
      },
      onTurnComplete: options.onTurnComplete,
      connect: async (input) => {
        assertClaimedScope(environment, input.scope);
        if (!runtime) throw new Error("Work input dispatch runtime is unavailable; common capability injection required");
        const claim = options.workClaim;
        if (!claim || !Number.isSafeInteger(claim.generation) || claim.generation < 1 || !claim.holder.trim()) {
          throw new Error("Trusted Work generation and holder are required");
        }
        turns.reset({ ...input.scope, ...claim }, input.signal);
        const proxy = managedMcpProxyFromWorkEnvironment(environment);
        if (proxy === null) {
          throw new Error("A valid scoped ANTHROPIC_WORK_SECRET is required");
        }
        if (source !== undefined) {
          const releasePath = `/workspace/.openma/harness-releases/${encodeURIComponent(input.scope.sessionId)}.json`;
          let release: AcpRelease;
          let saved: string | undefined;
          try { saved = await stateIo.readFile(releasePath); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          if (saved !== undefined) {
            release = validateAcpRelease(JSON.parse(saved));
            if (release.id !== harness.id || release.version !== harness.version || !acpReleaseMatchesSource(release, source)) {
              throw new Error("Session harness release does not match the selection; create a new Session");
            }
          } else {
            release = await resolveAcpRelease(harness, source, {
              fetch: options.artifacts?.fetch, signal: input.signal,
            });
            await stateIo.writeFile(releasePath, `${JSON.stringify(release)}\n`);
          }
          const artifact = await prepareAcpRelease(release, {
            root: options.artifacts?.root ?? environment.OPENMA_ACP_ARTIFACT_ROOT ?? join(homedir(), ".oma", "acp", "registry"),
            fetch: options.artifacts?.fetch, signal: input.signal,
          });
          identity!.digest = release.digest;
          prepared = { id: harness.id, command: artifact.command, args: artifact.args, env: artifact.env };
        }
        const history = createManagedHarnessHttpRecoveryHistory({
          apiBaseUrl: proxy.gatewayBaseUrl,
          sessionsToken: proxy.sessionsToken,
          fetch: options.fetch,
          retry: options.control?.retry,
          scheduler: options.control?.scheduler,
          signal: input.signal,
        });
        const skills = createManagedHarnessHttpSkillSource({
          apiBaseUrl: proxy.gatewayBaseUrl,
          sessionsToken: proxy.sessionsToken,
          fetch: options.fetch,
          retry: options.control?.retry,
          scheduler: options.control?.scheduler,
          signal: input.signal,
        });
        const resolveChannels = options.resolveExecutionChannels ?? (environment.OPENMA_SANDBOX_TOKEN
          ? createExecutionChannelsHttpResolver({apiBaseUrl:proxy.gatewayBaseUrl,fetch:options.fetch}) : undefined);
        const resolvedChannels = await resolveChannels?.({tenantId:input.scope.workspaceId,sessionId:input.scope.sessionId,
          sessionsToken:options.resolveExecutionChannels ? proxy.sessionsToken : environment.OPENMA_SANDBOX_TOKEN!});
        if (resolvedChannels?.type === "failed") {
          if (resolvedChannels.phase === "model_lookup" && resolvedChannels.code === "model_unavailable") {
            throw new NodeManagedAcpStartupConfigurationFailure("model_unavailable", new Error("Execution channels model lookup rejected"));
          }
          throw new Error(resolvedChannels.message);
        }
        if (resolvedChannels !== undefined) validateExecutionChannels(resolvedChannels, proxy.sessionsToken);
        active = {
          outputPath: input.outputPath,
          channels: resolvedChannels?.type === "ready" ? resolvedChannels.channels : null,
          history,
          skills,
          reportStartupRetry: (id) => publishStartupRetry({
            apiBaseUrl: proxy.gatewayBaseUrl,
            sessionsToken: proxy.sessionsToken,
            sessionId: input.scope.sessionId,
            id,
            fetch: options.fetch ?? globalThis.fetch,
            signal: input.signal,
          }),
        };
        return turns.connect({
          scope: input.scope,
          harness: input.harness,
          workspacePath: input.workspacePath,
          apiBaseUrl: proxy.gatewayBaseUrl,
          sessionsToken: proxy.sessionsToken,
          signal: input.signal,
        });
      },
      acpRuntime: startupRetryingRuntime,
      sessionPreparation: guardedSessionState,
      sessionState: guardedSessionState,
      semanticRecovery,
      drainDeadlineMs: options.lifecycle?.drainDeadlineMs,
      drainPollIntervalMs: options.lifecycle?.drainPollIntervalMs,
      abortGraceMs: options.lifecycle?.abortGraceMs,
    });
    return {
      async start(input) {
        nativeStartAttempted = false;
        const controller = new AbortController();
        const forwardAbort = () => controller.abort(input.signal.reason);
        if (input.signal.aborted) forwardAbort();
        else input.signal.addEventListener("abort", forwardAbort, { once: true });
        const release = () => input.signal.removeEventListener("abort", forwardAbort);
        let failStartup!: (error: unknown) => void;
        const startupFailed = new Promise<never>((_resolve, reject) => { failStartup = reject; });
        startupFailed.catch(() => undefined);
        startup = {
          signal: controller.signal,
          nonce: randomUUID(),
          exhausted(error) {
            controller.abort(error);
            failStartup(error);
          },
        };
        let run: Awaited<ReturnType<typeof supervised.start>>;
        try {
          run = await supervised.start({ ...input, signal: controller.signal,
            checkpoint: checkpoint => turns.checkpoint(checkpoint.turnId),
          });
        } catch (error) {
          release();
          throw error;
        }
        return {
          completed: Promise.race([run.completed, startupFailed]),
          async drain() { try { await run.drain(); } finally { release(); } },
          async stop(reason) {
            // Stop both common's run and this wrapper's startup/backoff. The
            // inner supervisor owns a separate controller, so stopping it alone
            // must not leave our retry loop able to launch another process.
            controller.abort(new Error(reason ?? "Managed ACP startup stopped"));
            try { await run.stop(reason); } finally { release(); }
          },
        };
      },
    };
  };

  return {
    resolveHarness,
    async serve(input) {
      await serveHarnessSupervisorJsonl({
        ...input,
        heartbeatIntervalMs,
        resolveHarness,
        scheduler: options.supervisorScheduler,
      });
    },
  };
}

/** main's retrying startup facts. Stable IDs/body across a lost response; no
 * provider exception text leaves the sandbox (same as the exhausted settlement). */
async function publishStartupRetry(input: {
  apiBaseUrl: string;
  sessionsToken: string;
  sessionId: string;
  id: string;
  fetch: typeof globalThis.fetch;
  signal: AbortSignal;
}): Promise<void> {
  const processedAt = new Date().toISOString();
  const id = `acp-startup:${input.id}`;
  const body = JSON.stringify({ events: [
    { id: `${id}:0`, type: "session.error", processed_at: processedAt,
      error: { type: "unknown_error", message: "ACP startup failed", retry_status: "retrying" } },
    { id: `${id}:1`, type: "session.status_rescheduled", processed_at: processedAt },
  ] });
  const send = () => input.fetch(
    `${input.apiBaseUrl.replace(/\/+$/u, "")}/v1/oma/sessions/${encodeURIComponent(input.sessionId)}/runtime-events`,
    { method: "POST", body, signal: input.signal,
      headers: { authorization: `Bearer ${input.sessionsToken}`, "content-type": "application/json" } },
  );
  let response: Response;
  try { response = await send(); }
  catch (error) {
    // Response loss only: the identical batch is confirmed or applied once.
    if (input.signal.aborted) throw error;
    response = await send();
  }
  if (!response.ok) throw new Error(`ACP startup retry projection rejected: ${response.status}`);
}

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Structural startup barrier only. The injected authority still owns live
 * claim/attempt and scope validation; token shape cannot establish ownership. */
function validateExecutionChannels(result: ManagedAcpExecutionChannelsResult, workToken: string): void {
  const invalid = () => { throw new Error("Invalid ACP execution channels capability"); };
  if (result?.type !== "ready") return invalid();
  const {mcpProxy,hostedInference} = result.channels ?? {};
  const token = mcpProxy?.sessionsToken;
  if (typeof token !== "string" || token === workToken || sandboxTokenRandomPart(token) === null
    || hostedInference?.sessionsToken !== token) return invalid();
  for (const raw of [mcpProxy.gatewayBaseUrl,hostedInference.gatewayBaseUrl]) {
    if (typeof raw !== "string" || !raw.trim()) return invalid();
    let url: URL; try { url = new URL(raw); } catch { return invalid(); }
    if (!["http:","https:"].includes(url.protocol) || url.username || url.password) return invalid();
  }
  const model = hostedInference.model;
  if (!model || typeof model.providerId !== "string" || !model.providerId.trim()
    || !(model.baseUrl === null || typeof model.baseUrl === "string" && model.baseUrl.trim())) return invalid();
}

export function decodeManagedAcpSessionSnapshot(
  value: ManagedHarnessWireSession,
): ManagedAcpSessionSnapshot {
  const agent = value.agent;
  if (!isRecord(agent)) throw invalidSession("agent");
  const model = agent.model;
  if (!isRecord(model) || !isNonEmptyString(model.id)) throw invalidSession("agent.model");
  if (!isNonEmptyString(agent.id)) throw invalidSession("agent.id");
  if (!Number.isSafeInteger(agent.version) || Number(agent.version) < 1) {
    throw invalidSession("agent.version");
  }
  if (agent.system !== null && typeof agent.system !== "string") {
    throw invalidSession("agent.system");
  }
  if (!Array.isArray(agent.mcp_servers)) throw invalidSession("agent.mcp_servers");
  const mcpServers = agent.mcp_servers.map((candidate, index) => {
    if (
      isRecord(candidate)
      && candidate.type === "stdio"
      && isNonEmptyString(candidate.name)
      && isNonEmptyString(candidate.command)
      && candidate.command.startsWith("/")
      && (candidate.args === undefined || stringArray(candidate.args) !== null)
      && (candidate.env === undefined || stringRecord(candidate.env) !== null)
    ) {
      return {
        type: "stdio" as const,
        name: candidate.name,
        command: candidate.command,
        ...(candidate.args === undefined ? {} : { args: stringArray(candidate.args)! }),
        ...(candidate.env === undefined ? {} : { env: stringRecord(candidate.env)! }),
      };
    }
    if (
      !isRecord(candidate)
      || candidate.type !== "url"
      || !isNonEmptyString(candidate.name)
      || !isNonEmptyString(candidate.url)
    ) throw invalidSession(`agent.mcp_servers[${index}]`);
    return { type: "url" as const, name: candidate.name, url: candidate.url };
  });
  const skills = skillArray(agent.skills);
  const tools = recordArray(agent.tools, "agent.tools");
  let inference: ManagedAcpSessionAgentSnapshot["inference"];
  if (isRecord(agent.inference) && isNonEmptyString(agent.inference.provider_id)) {
    const endpoints = agent.inference.protocol_endpoints;
    inference = {
      provider_id: agent.inference.provider_id,
      base_url: typeof agent.inference.base_url === "string"
        ? agent.inference.base_url
        : agent.inference.base_url === null
          ? null
          : null,
      ...(Array.isArray(endpoints) ? {
        protocol_endpoints: endpoints.map((entry, index) => {
          if (
            !isRecord(entry)
            || !isNonEmptyString(entry.protocol)
            || !isNonEmptyString(entry.proxy_path_segment)
            || !isNonEmptyString(entry.upstream_base_url)
          ) {
            throw invalidSession(`agent.inference.protocol_endpoints[${index}]`);
          }
          return {
            protocol: entry.protocol,
            proxy_path_segment: entry.proxy_path_segment,
            upstream_base_url: entry.upstream_base_url,
          };
        }),
      } : {}),
    };
  }
  return {
    ...value,
    agent: {
      id: agent.id,
      version: Number(agent.version),
      model: { ...model, id: model.id },
      mcp_servers: mcpServers,
      skills,
      system: agent.system,
      tools,
      ...(inference === undefined ? {} : { inference }),
    },
  };
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? [...value]
    : null;
}

function stringRecord(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  return Object.values(value).every((entry) => typeof entry === "string")
    ? { ...value } as Record<string, string>
    : null;
}

// This supervisor executes INSIDE the sandbox. Its scoped Work source serves
// concrete Session-attached versions. Host cache soft-links cannot cross that
// boundary; Runtime-owned sandbox cache mount/copy support is deferred. Share
// archive path validation with the host cache, retain jail-local materialization.
async function materializeSkills(input: {
  io: NodeAcpHarnessStateIo;
  source: ManagedHarnessHttpSkillSource;
  skills: readonly ManagedAcpSkillSnapshot[];
}): Promise<string> {
  const manifests: string[] = [];
  for (const skill of input.skills) {
    const archive = unzipSync(await input.source.download({
      skillId: skill.skill_id,
      version: skill.version,
    }));
    const root = `/workspace/.openma/skills/${encodeURIComponent(skill.skill_id)}/${encodeURIComponent(skill.version)}`;
    let foundManifest = false;
    for (const [rawPath, content] of Object.entries(archive)) {
      if (rawPath.endsWith("/")) continue;
      const path = safeSkillArchivePath(rawPath);
      await input.io.writeFileBytes(`${root}/${path}`, content);
      if (posix.basename(path) === "SKILL.md") {
        foundManifest = true;
        manifests.push(
          `- ${skill.skill_id}@${skill.version}: ${root}/${path}`,
        );
      }
    }
    if (!foundManifest) {
      throw new Error(
        `Managed Skill ${skill.skill_id}@${skill.version} archive has no SKILL.md`,
      );
    }
  }
  return manifests.length === 0
    ? ""
    : ["## OpenMA skills", "", ...manifests].join("\n");
}

function skillArray(value: unknown): ManagedAcpSkillSnapshot[] {
  const skills = recordArray(value, "agent.skills");
  return skills.map((skill, index) => {
    if (
      !isNonEmptyString(skill.type)
      || !isNonEmptyString(skill.skill_id)
      || !isNonEmptyString(skill.version)
    ) throw invalidSession(`agent.skills[${index}]`);
    return {
      ...skill,
      type: skill.type,
      skill_id: skill.skill_id,
      version: skill.version,
    };
  });
}

/** Optional operator allowlist; absent catalogs also accept official Registry ids. */
function parseHarnessSources(raw: string | undefined, variable: string): Record<string, AcpReleaseSource> {
  if (raw === undefined) return { "codex-acp": { type: "npm", package: "@agentclientprotocol/codex-acp" } };
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) throw new Error("must be a JSON object");
    const result = Object.create(null) as Record<string, AcpReleaseSource>;
    for (const [id, source] of Object.entries(value)) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) throw new Error("invalid harness id");
      result[id] = parseAcpReleaseSource(source);
    }
    return result;
  } catch (error) {
    throw new TypeError(`${variable}: ${error instanceof Error ? error.message : "invalid release sources"}`);
  }
}

function defaultAgentResolver(agentId: string): AcpStatefulAgentSpec | null {
  const entry = resolveKnownAgent(agentId);
  return entry === null ? null : { ...entry.spec, id: entry.id };
}

function assertClaimedScope(
  environment: Readonly<Record<string, string | undefined>>,
  scope: {
    environmentId: string;
    sessionId: string;
    workId: string;
  },
): void {
  if (
    environment.ANTHROPIC_ENVIRONMENT_ID !== scope.environmentId
    || environment.ANTHROPIC_SESSION_ID !== scope.sessionId
    || environment.ANTHROPIC_WORK_ID !== scope.workId
  ) {
    throw new Error("Supervisor scope does not match the claimed Work scope");
  }
}

function recordArray(value: unknown, path: string): Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value) || value.some((candidate) => !isRecord(candidate))) {
    throw invalidSession(path);
  }
  return value.map((candidate) => ({ ...candidate as Record<string, unknown> }));
}

function invalidSession(path: string): TypeError {
  return new TypeError(`Managed Session ${path} is invalid`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
