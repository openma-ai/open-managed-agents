import type { SqlClient } from "@open-managed-agents/sql-client";

import { integrationAccessLossCatalogs } from "./catalog";
import {
  classifyUpstreamAccess,
  type AccessLossClassification,
  type UpstreamAccessObservation,
} from "./classify";
import {
  accessLossEffectId,
  applyAccessLossEffect,
  publicationIdFromMetadata,
  type AccessLossEffectPorts,
  type ApplyAccessLossResult,
} from "./effect";
import {
  cancelSqlSessionWakeups,
  closeIntegrationScope,
  createSqlAccessLossEffectStore,
  ensureAccessLossSchema,
  interruptScopedExecution,
  readMaxExecutionGeneration,
  readSessionMetadata,
  recordReauthorization,
} from "./sql";

export interface McpProxyFinalResult {
  status: number;
  bodyText: string;
  refreshed: boolean;
  refreshFailed: boolean;
  refreshFailureCode: string | null;
}

export interface ObserveMcpAccessInput {
  workspaceId: string;
  sessionId: string;
  serverName: string;
  generation: number;
  requestBody: string | null;
  result: McpProxyFinalResult;
}

export interface AccessLossRuntime {
  prepare(): Promise<void>;
  captureGeneration(input: { workspaceId: string; sessionId: string }): Promise<number>;
  observe(input: ObserveMcpAccessInput): Promise<ApplyAccessLossResult | { type: "retryable" }>;
}

export interface AccessLossRuntimeOptions {
  tenantSql: SqlClient;
  integrationsSql: SqlClient;
  /** Runtime-owned wakeup cancellation. Node uses the SQL table; Cloudflare
   * cancels SessionDO schedules and ignores this SQL fallback when it
   * supplies its own port. */
  cancelWakeups?: AccessLossEffectPorts["cancelWakeups"];
  notify?: AccessLossEffectPorts["notify"];
  now?: () => Date;
}

export function createAccessLossRuntime(options: AccessLossRuntimeOptions): AccessLossRuntime {
  const store = createSqlAccessLossEffectStore(options.tenantSql);
  const now = options.now ?? (() => new Date());
  const ports: AccessLossEffectPorts = {
    maxGeneration: (input) => readMaxExecutionGeneration(
      options.tenantSql,
      input.workspaceId,
      input.sessionId,
    ),
    closeScope: (input) => closeIntegrationScope(options.integrationsSql, input),
    cancelWakeups: options.cancelWakeups ?? ((input) => cancelSqlSessionWakeups(options.tenantSql, input)),
    stopExecution: async (input) => {
      await interruptScopedExecution(options.tenantSql, {
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        generation: input.generation,
        atMs: now().getTime(),
      });
    },
    pauseCredential: (effect) => recordReauthorization(options.tenantSql, effect),
    ...(options.notify ? { notify: options.notify } : {}),
  };

  return {
    prepare: () => ensureAccessLossSchema(options.tenantSql),
    captureGeneration: (input) => readMaxExecutionGeneration(
      options.tenantSql,
      input.workspaceId,
      input.sessionId,
    ),
    async observe(input) {
      const observation: UpstreamAccessObservation = {
        httpStatus: input.result.status,
        bodyText: input.result.bodyText,
        serverName: input.serverName,
        requestBody: input.requestBody,
        refreshed: input.result.refreshed,
        refreshFailed: input.result.refreshFailed,
        refreshFailureCode: input.result.refreshFailureCode,
      };
      const classification = classifyUpstreamAccess(observation, integrationAccessLossCatalogs);
      if (classification.class === "retryable") return { type: "retryable" };
      const metadata = await readSessionMetadata(
        options.tenantSql,
        input.workspaceId,
        input.sessionId,
      );
      const draft = {
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        serverName: input.serverName,
        provider: classification.provider,
        kind: classification.class,
        code: classification.code,
        publicationId: publicationIdFromMetadata(metadata, classification.provider),
        resource: classification.resource,
        generation: input.generation,
      };
      const effect = {
        ...draft,
        id: await accessLossEffectId(draft),
        createdAt: now().toISOString(),
      };
      return applyAccessLossEffect(effect, store, ports);
    },
  };
}

export interface McpAccessLossHooks {
  onFinal(result: McpProxyFinalResult): Promise<void>;
}

/** Capture the execution generation before the upstream call, then classify
 * the final response. Cleanup failures are logged and do not replace the
 * upstream tool error. */
export async function bindAccessLossHooks(
  runtime: AccessLossRuntime,
  input: { workspaceId: string; sessionId: string; serverName: string; requestBody: string | null },
): Promise<McpAccessLossHooks> {
  let generation = 0;
  try {
    generation = await runtime.captureGeneration({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
    });
  } catch {
    generation = 0;
  }
  return {
    async onFinal(result) {
      try {
        await runtime.observe({ ...input, generation, result });
      } catch (error) {
        console.warn(
          `mcp access-loss cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}

export function mcpRequestBodyText(body: BodyInit | null | undefined): string | null {
  if (body == null) return null;
  if (typeof body === "string") return body;
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  return null;
}
