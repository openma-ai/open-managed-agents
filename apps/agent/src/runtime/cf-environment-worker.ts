import Anthropic from "@anthropic-ai/sdk";
import { createDispatchedManagedEnvironmentWorker, type DispatchedManagedEnvironmentWorkerClient } from "@open-managed-agents/managed-runtime-host";
import type { Env } from "@open-managed-agents/shared";
import { CF_WORK_DISPATCH_PATH, dispatchCfWorkRunnerRequest } from "./cf-work-runner-entry";

export interface CfEnvironmentWorkerConfig {
  environmentId: string;
  workspaceId: string;
  environmentKey: string;
  webhookKey?: string;
}
/** Existing EnvironmentWorker reserves Work; local HTTP handler invocation
 * replaces a self-fetch loop. All subsequent lifecycle runs inside sandbox. */
export function createCfDispatchedEnvironmentWorker(env: Env, config: CfEnvironmentWorkerConfig, client?: DispatchedManagedEnvironmentWorkerClient) {
  for (const value of [config.environmentId, config.workspaceId, config.environmentKey, env.PUBLIC_BASE_URL]) if (!value?.trim()) throw new TypeError("CF EnvironmentWorker configuration is incomplete");
  const origin = env.PUBLIC_BASE_URL!.replace(/\/+$/, "");
  const control = client ?? new Anthropic({ apiKey: null, authToken: config.environmentKey, baseURL: origin, maxRetries: 0 }) as unknown as DispatchedManagedEnvironmentWorkerClient;
  return createDispatchedManagedEnvironmentWorker({ client: control, environmentId: config.environmentId, workspaceId: config.workspaceId, environmentKey: config.environmentKey, webhookKey: config.webhookKey, sandboxApiBaseUrl: origin, maxWorkItemsPerDrain: 8,
    dispatch: {
      descriptor: () => ({ provider: "cloudflare", version: "1.0.0", strategy: "poll_unacked_then_dispatch" }),
      async dispatch(input) {
        input.signal.throwIfAborted();
        if (input.work.data.type !== "session" || !input.workspaceId?.trim() || !input.work.secret?.trim()) throw new TypeError("Claimed Session Work scope and secret required");
        const response = await dispatchCfWorkRunnerRequest(new Request("https://internal" + CF_WORK_DISPATCH_PATH, { method: "POST", headers: { "content-type": "application/json" }, signal: input.signal, body: JSON.stringify({ workspaceId: input.workspaceId, environmentId: input.work.environment_id, sessionId: input.work.data.id, workId: input.work.id, apiBaseUrl: input.apiBaseUrl, workSecret: input.work.secret }) }), env);
        if (!response.ok) throw new Error("CF Work dispatch unconfirmed (HTTP " + response.status + ")");
      },
    },
  });
}
export type CfWorkEnvironment = Env & { OPENMA_WORK_ENVIRONMENT_ID?: string; OPENMA_WORK_WORKSPACE_ID?: string; OPENMA_WORK_ENVIRONMENT_KEY?: string; OPENMA_WORK_WEBHOOK_KEY?: string };
const configuredWorkers = new WeakMap<object, ReturnType<typeof createCfDispatchedEnvironmentWorker>>();
export function configuredCfEnvironmentWorker(env: CfWorkEnvironment) {
  const existing = configuredWorkers.get(env); if (existing) return existing;
  if (!env.OPENMA_WORK_ENVIRONMENT_ID || !env.OPENMA_WORK_WORKSPACE_ID || !env.OPENMA_WORK_ENVIRONMENT_KEY) throw new Error("CF EnvironmentWorker is not configured");
  const worker = createCfDispatchedEnvironmentWorker(env, { environmentId: env.OPENMA_WORK_ENVIRONMENT_ID, workspaceId: env.OPENMA_WORK_WORKSPACE_ID, environmentKey: env.OPENMA_WORK_ENVIRONMENT_KEY, webhookKey: env.OPENMA_WORK_WEBHOOK_KEY });
  configuredWorkers.set(env, worker); return worker;
}
