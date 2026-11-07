import Anthropic, {
  type ClientOptions as AnthropicClientOptions,
} from "@anthropic-ai/sdk";
import { OmaResources } from "./oma.js";
import type { OpenMaBeta } from "./agents.js";

export type {
  OpenMaAgentAcp,
  OpenMaAgentAcpParams,
  OpenMaAgentExtension,
  OpenMaAgentExtensionParams,
  OpenMaAgentModelParams,
  OpenMaAgent,
  OpenMaAgentCreateParams,
  OpenMaAgentUpdateParams,
  OpenMaAgentMultiagentParams,
  OpenMaAgentMultiagent,
  OpenMaMultiagent,
  OpenMaSessionThreadAgent,
  OpenMaSessionAgent,
  OpenMaSession,
  OpenMaAgents,
  OpenMaSessions,
  OpenMaBeta,
  OpenMaMcpServer,
  OpenMaMcpServerParams,
  OpenMaStdioMcpServer,
  OpenMaStdioMcpServerParams,
  OpenMaAgentRuntimeBindingParams,
  OpenMaJsonValue,
  OpenMaProviderOptions,
} from "./agents.js";

export {
  OmaModelsResource,
  OmaModelCardsResource,
  OmaHarnessesResource,
  type OmaHarnessCatalog,
  type OmaHarnessDescriptor,
  type OmaHarnessExecutionPlacement,
  OmaResources,
  type OmaModelCard,
  type OmaModelCardCreateParams,
  type OmaModelCardDeleted,
  type OmaModelCardListParams,
  type OmaModelCardListResponse,
  type OmaModelCardUpdateParams,
  type OmaModelListParams,
  type OmaModelListResponse,
  type OmaModelProvider,
  type OmaPiModelConfig,
  type OmaProviderModel,
  type OmaHTTPMethod,
  type OmaPath,
  type OmaRequestParams,
} from "./oma.js";
export {
  EvalsResource,
  EvalBenchmarksResource,
  EvalCasesResource,
  EvalRunsResource,
  EVAL_RUN_TERMINAL_STATUSES,
  type AddEvalCasesRequest,
  type BuiltinEvalBenchmark,
  type BuiltinEvalBenchmarkListResponse,
  type CreateEvalBenchmarkRequest,
  type CreateEvalRunRequest,
  type CreateEvalRunResponse,
  type EvalArchiveUpload,
  type EvalBenchmark,
  type EvalBenchmarkDeleted,
  type EvalBenchmarkKind,
  type EvalBenchmarkListResponse,
  type EvalBenchmarkRetrieveParams,
  type EvalBenchmarkRevision,
  type EvalCase,
  type EvalCaseDeleted,
  type EvalCaseDetail,
  type EvalCaseRetrieveParams,
  type EvalRun,
  type EvalRunDeleted,
  type EvalRunListParams,
  type EvalRunListResponse,
  type EvalRunStatus,
  type EvalRunTask,
  type EvalSourcePin,
  type EvalTrial,
  type EvalTrialPhase,
  type HarborCaseSource,
  type HarborEvalCase,
  type MessagesCaseInput,
  type MessagesEvalCase,
  type ReplaceEvalCaseRequest,
  type SyncEvalBenchmarkRequest,
  type SyncEvalBenchmarkResponse,
  type SyncUploadEvalBenchmarkParams,
  type UpdateEvalBenchmarkRequest,
  type UploadEvalBenchmarkParams,
  type WaitForEvalRunOptions,
} from "./evals.js";
export { Anthropic };

export type { AnthropicClientOptions };
export interface OpenMAOptions extends AnthropicClientOptions {
  /** @deprecated Use the official SDK spelling, `baseURL`. */
  baseUrl?: string;
  /** @deprecated Use the official SDK spelling, `authToken`. */
  bearer?: string;
  /** Active OpenMA workspace. Sent as `x-active-tenant`. */
  activeTenantId?: string;
  /** Optional legacy User-Agent override. */
  userAgent?: string;
}

/** @deprecated Use `OpenMAOptions`. */
export type ClientOptions = OpenMAOptions;

type HeaderValue = string | readonly string[] | null | undefined;

function mergeDefaultHeaders(
  defaultHeaders: AnthropicClientOptions["defaultHeaders"],
  additions: Record<string, HeaderValue>,
): Record<string, HeaderValue> {
  const merged: Record<string, HeaderValue> = {};
  const set = (name: string, value: HeaderValue) => {
    merged[name.toLowerCase()] = value;
  };

  for (const [name, value] of Object.entries(additions)) set(name, value);

  if (defaultHeaders instanceof Headers) {
    defaultHeaders.forEach((value, name) => set(name, value));
    return merged;
  }

  if (Array.isArray(defaultHeaders)) {
    for (const entry of defaultHeaders) {
      if (entry.length >= 2) set(String(entry[0]), entry[1] as HeaderValue);
    }
    return merged;
  }

  if (defaultHeaders && typeof defaultHeaders === "object") {
    const nullable = defaultHeaders as {
      values?: unknown;
      nulls?: unknown;
    };
    if (nullable.values instanceof Headers && nullable.nulls instanceof Set) {
      nullable.values.forEach((value, name) => set(name, value));
      for (const name of nullable.nulls) set(String(name), null);
      return merged;
    }
    for (const [name, value] of Object.entries(defaultHeaders)) {
      set(name, value as HeaderValue);
    }
  }

  return merged;
}

export class OpenMA {
  readonly anthropic: Anthropic;
  readonly beta: OpenMaBeta;
  readonly oma: OmaResources;

  constructor(options: OpenMAOptions = {}) {
    const {
      activeTenantId,
      apiKey,
      baseUrl,
      bearer,
      defaultHeaders,
      userAgent,
      ...anthropicOptions
    } = options;

    // Anthropic TS SDK 1.x sends apiKey as Authorization Bearer. OpenMA's
    // control-plane auth still uses the tenant x-api-key header, so hand-set
    // X-Api-Key and explicitly omit Authorization (SDK validates either).
    // OpenMA callers pass a string key today. Function setters would still
    // emit Bearer under SDK 1.x, so only string keys are remapped to X-Api-Key.
    const openMaApiKey =
      typeof apiKey === "string" && apiKey.length > 0 ? apiKey : null;

    const authToken = options.authToken ?? bearer ?? null;
    this.anthropic = new Anthropic({
      ...anthropicOptions,
      // Prevent SDK 1.x from emitting Authorization: Bearer for the OpenMA key.
      apiKey: null,
      baseURL: options.baseURL ?? baseUrl ?? "https://app.openma.ai",
      authToken,
      defaultHeaders: mergeDefaultHeaders(defaultHeaders, {
        ...(openMaApiKey ? { "X-Api-Key": openMaApiKey } : {}),
        // Omit Authorization only when we are not using authToken Bearer auth.
        ...(openMaApiKey && !authToken ? { Authorization: null } : {}),
        ...(activeTenantId ? { "x-active-tenant": activeTenantId } : {}),
        ...(userAgent ? { "user-agent": userAgent } : {}),
      }),
    });
    // Keep the official resources and transport intact; do not normalize patches.
    this.beta = this.anthropic.beta as unknown as OpenMaBeta;
    this.oma = new OmaResources(this.anthropic);
  }
}
