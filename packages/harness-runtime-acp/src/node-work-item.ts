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

export interface NodeManagedAcpWorkItemRunnerOptions {
  environment?: Readonly<Record<string, string | undefined>>;
  lifecycleClient?: ClaimedEnvironmentWorkLifecycleClient;
  supervisorApp?: NodeManagedAcpSupervisorApp;
  resolveExecutionChannels?: import("./node-supervisor.js").NodeManagedAcpSupervisorAppOptions["resolveExecutionChannels"];
  fetch?: typeof globalThis.fetch;
  harness?: { id: string; version: string };
  workspacePath?: string;
  outputPath?: string | null;
  heartbeatIntervalMs?: number;
  heartbeatTtlSeconds?: number;
  scheduler?: ClaimedEnvironmentWorkScheduler;
  checkpoint?(input: { sessionId: string; turnId?: string }): Promise<void>;
  onError?(error: unknown): void | Promise<void>;
}

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
  const supervisorApp = options.supervisorApp ?? createNodeManagedAcpSupervisorApp({
    environment,
    workspacePath,
    fetch: options.fetch,
    resolveExecutionChannels: options.resolveExecutionChannels,
    ...(environment.OPENMA_ACP_AGENT_ID?.trim()
      ? { agentId: environment.OPENMA_ACP_AGENT_ID.trim() }
      : {}),
  });
  const client = options.lifecycleClient ?? lifecycleClientFromEnvironment({capability,fetch:options.fetch});
  let suppressFinallyStop = false;
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
      stop: (...args) => suppressFinallyStop ? Promise.resolve({}) : client.stop(...args),
    },
    heartbeatIntervalMs: options.heartbeatIntervalMs,
    heartbeatTtlSeconds: options.heartbeatTtlSeconds,
    scheduler: options.scheduler,
    onError: options.onError,
  });

  return {
    async run(signal) {
      await lifecycle.run({
        environmentId,
        sessionId,
        workId,
        signal,
        execute: async (workSignal) => {
          suppressFinallyStop = true;
          let revision: number | undefined;
          let active: Awaited<ReturnType<NonNullable<Awaited<ReturnType<typeof supervisorApp.resolveHarness>>>["start"]>> | null = null;
          try {
            const boundary = await (await requestStartup("startup-boundary", {})).json() as {revision?: unknown};
            if (!Number.isSafeInteger(boundary.revision) || Number(boundary.revision) < 0) throw new Error("ACP startup boundary unavailable");
            revision = Number(boundary.revision);
            const resolved = await supervisorApp.resolveHarness(harness);
            if (resolved === null) throw new Error(`Harness ${harness.id}@${harness.version} is not installed`);

            active = await resolved.start({
              scope: {
                workspaceId: environment.OPENMA_WORKSPACE_ID?.trim() || "default",
                environmentId,
                sessionId,
                workId,
              },
              harness,
              workspacePath: "/workspace",
              outputPath: outputPath === null ? null : "/mnt/session/outputs",
              checkpoint: options.checkpoint ?? (async () => {}),
              signal: workSignal,
            });
            const result = await active.completed;
            workSignal.throwIfAborted();
            if (result.exitCode !== 0) {
              throw new Error(`ACP harness exited with code ${String(result.exitCode)}`);
            }
            await active.drain();
            suppressFinallyStop = false;
          } catch (error) {
            await active?.stop(workSignal.aborted ? "aborted" : "failed").catch(() => {});
            if (workSignal.aborted) {
              // Existing interrupt / lease_lost semantics belong to common.
              suppressFinallyStop = false;
            } else if (revision !== undefined) {
              const body = {revision,processedAt:new Date().toISOString()};
              try {
                // Same body on response loss: only exact committed facts may
                // be confirmed after the first request revoked Work authority.
                try { await requestStartup("startup-failed",body); }
                catch { await requestStartup("startup-failed",body); }
              } catch (settlementError) { await options.onError?.(settlementError); }
            }
            throw error;
          }
        },
      });
    },
  };
}
