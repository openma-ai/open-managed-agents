/**
 * apps/main-node — Node control-plane assembly for the Open Managed Agents API.
 *
 * createNodeControlPlane(components) is the composition root: it receives the
 * components a deployment chose (see components.ts — database, secrets, auth,
 * email, sandbox, realtime, blobs, store overrides — and the plain NodeConfig
 * from config.ts), builds the stores, Session runtimes and background
 * workers on top of them, mounts the route bundles from
 * @open-managed-agents/http-routes and the Managed Agents API, and returns a
 * handle that owns all of it. Route bodies live in packages/http-routes;
 * storage adapters in their respective packages.
 *
 * nodeDefaults(config) builds the components from configuration alone;
 * index.ts is the executable entrypoint (process.env, listen, signals).
 */

import { OpenAIAgentsProtocolError } from "@open-managed-agents/openai-agents-api";

import { createNodeLogger } from "@open-managed-agents/observability/logger/node";
import { createNodeMetricsRecorder, type NodeMetricsHandle } from "@open-managed-agents/observability/metrics/node";
import { createNodeTracer, type NodeTracerHandle } from "@open-managed-agents/observability/tracer/node";
import { setRootLogger, type Logger } from "@open-managed-agents/observability";
import { createSqliteAgentService } from "@open-managed-agents/agents-store";
import { createSqliteMemoryStoreService, SqlMemoryRepo } from "@open-managed-agents/memory-store";
import { createSqliteDreamService } from "@open-managed-agents/dreams-store";
import type { BlobStore } from "@open-managed-agents/blob-store";
import { createSqliteVaultService } from "@open-managed-agents/vaults-store";
import { createSqliteCredentialService } from "@open-managed-agents/credentials-store";
import { createSqliteSessionService } from "@open-managed-agents/sessions-store";
import { createSqliteFileService } from "@open-managed-agents/files-store";
import { createSqliteEvalRunService } from "@open-managed-agents/evals-store";
import { createSqliteEnvironmentService } from "@open-managed-agents/environments-store";
import { createSqliteModelCardService } from "@open-managed-agents/model-cards-store";

import { SqlEventLog } from "@open-managed-agents/event-log/sql";
import type { SessionEvent } from "@open-managed-agents/shared";
import { generateEventId } from "@open-managed-agents/shared";
import { registerCoreHarnesses } from "@open-managed-agents/agent/harness/builtins";
import { resolveHarness } from "@open-managed-agents/agent/harness/registry";
import { buildTools } from "@open-managed-agents/agent/harness/tools";
import { createPiModelRuntime, toAiSdkLanguageModel } from "@open-managed-agents/agent/harness/pi-provider";
import type { PiModelConfig } from "@open-managed-agents/agent/harness/pi-provider";

import { composeSystemPrompt } from "@open-managed-agents/agent/harness/platform-guidance";
import type { HarnessContext } from "@open-managed-agents/agent/harness/interface";
import { nodeToMarkdown } from "@open-managed-agents/markdown/adapters/node";

import { SqlAgentPersistence } from "@open-managed-agents/managed-agents-adapters-sql";

import { resolveFeishuAgentTools } from "../lib/feishu-agent-tools.js";
import { createLegacySessionMcpProxy } from "../lib/legacy-session-mcp-proxy.js";

import { NodeWorkspaceBackupService } from "../lib/node-workspace-backup.js";
import { NodeSharedSessionOutputs } from "../lib/node-shared-session-outputs.js";
import { nodeOutputsAdapter } from "../lib/node-outputs-adapter.js";
import { DefaultSandboxOrchestrator } from "@open-managed-agents/sandbox/orchestrator";

import { startMemoryBlobWatcher } from "../lib/memory-blob-watcher.js";

import { startNodeMemoryQueue } from "../lib/node-memory-queue.js";
import { mkdirSync } from "node:fs";

import type { EventStreamHub } from "../lib/event-stream-hub";
import { NodeHarnessRuntime } from "../lib/node-harness-runtime";
import { SessionRegistry } from "../registry.js";

import { redactNodeConfig } from "../config.js";
import { Disposables } from "../lifecycle.js";
import type { NodeComponents } from "../components.js";

import type { BlobStore as MemoryBlobStore } from "@open-managed-agents/memory-store";

registerCoreHarnesses();

export async function createNodeFoundation(
  components: NodeComponents,
  disposables: Disposables,
  log: { current: Logger | null },
) {
  const { config } = components;
  const { processMode } = config;
  const sandboxEnvironment = config.sandbox.environment;
  const ownsLongLivedProcesses = processMode === "standalone";

  const toMarkdownProvider = nodeToMarkdown();

  // ─── Observability bootstrap ─────────────────────────────────────────────
  //
  // Logger is constructed first so every later step can use it instead of
  // raw console.*. Metrics + tracer follow; both are no-ops by default and
  // only spin up real backends when the env opts in.
  //   - Prometheus metrics: always-on in-process registry; /metrics text
  //     endpoint mounted below.
  //   - OTel tracing: starts only when OTEL_EXPORTER_OTLP_ENDPOINT is set.
  const logger: Logger = await createNodeLogger({
    bindings: { service: "main-node", pid: process.pid },
  });
  setRootLogger(logger);
  log.current = logger;
  logger.info({ op: "main-node.config", config: redactNodeConfig(config) }, "effective configuration");

  const metrics: NodeMetricsHandle = await createNodeMetricsRecorder();
  const tracer: NodeTracerHandle = await createNodeTracer({
    serviceName: "oma-main-node",
  });
  disposables.add("tracer", () => tracer.shutdown());

  // ─── Bootstrap ───────────────────────────────────────────────────────────

  const { database } = components;
  const { sql, dialect, drizzle: drizzleDb, description: backendDescription } = database;
  if (database.stop) disposables.add("database", () => database.stop!());
  const managedAgentsPersistence = new SqlAgentPersistence(sql);

  // Integrations subsystem boot is gated on PLATFORM_ROOT_SECRET (used to
  // encrypt OAuth tokens etc.). Tables are part of the consolidated baseline
  // above so they're always created — the gate now only controls subsystem
  // wiring, not schema bootstrap.
  const platformRootSecret = config.platformRootSecret;
  const { secrets } = components;
  const openAIAgentsConfigurationCipher = secrets === null
    ? null
    : secrets.cipherFor("openai.agents.configuration");
  const openAIAgentsSecrets = {
    seal: async (plaintext: string) => {
      if (!openAIAgentsConfigurationCipher) throw new OpenAIAgentsProtocolError(503, "PLATFORM_ROOT_SECRET is required for confidential Agents API configuration", undefined, "configuration_unavailable");
      return openAIAgentsConfigurationCipher.encrypt(plaintext);
    },
    open: async (ciphertext: string) => {
      if (!openAIAgentsConfigurationCipher) throw new OpenAIAgentsProtocolError(503, "PLATFORM_ROOT_SECRET is required for confidential Agents API configuration", undefined, "configuration_unavailable");
      return openAIAgentsConfigurationCipher.decrypt(ciphertext);
    },
  };

  // ─── Auth ───────────────────────────────────────────────────────────────

  const authDisabled = components.auth === null;
  const auth = components.auth;
  if (auth?.stop) disposables.add("auth", () => auth.stop!());

  // ─── Stores ─────────────────────────────────────────────────────────────

  const agentsService = createSqliteAgentService({ db: drizzleDb });
  const vaultService = createSqliteVaultService({ db: drizzleDb });
  const credentialService = createSqliteCredentialService({ db: drizzleDb });
  const sessionsService = createSqliteSessionService({ db: drizzleDb });
  const filesService = createSqliteFileService({ db: drizzleDb });
  const evalsService = createSqliteEvalRunService({ db: drizzleDb });
  const environmentsService = createSqliteEnvironmentService({ db: drizzleDb });
  const modelCardsService = createSqliteModelCardService(
    { db: drizzleDb },
    {
      crypto: secrets === null ? undefined : secrets.cipherFor("model.cards.keys"),
    },
  );

  const memoryBlobs: MemoryBlobStore = components.blobs.memory.store;
  const memoryBlobDescription = components.blobs.memory.description;
  const memoryBlobLocalDir = components.blobs.memory.localDir ?? null;
  const s3MemoryConfig = components.blobs.memory.s3 ?? null;

  const memoryService = createSqliteMemoryStoreService({
    db: drizzleDb,
    blobs: memoryBlobs,
  });
  const dreamsService = createSqliteDreamService({
    client: sql,
    verifyMemoryStoreExists: async (tenantId, storeId) => {
      const row = await sql
        .prepare("SELECT 1 FROM memory_stores WHERE id = ? AND tenant_id = ?")
        .bind(storeId, tenantId)
        .first();
      return !!row;
    },
    verifySessionExists: async (tenantId, sessionId) => {
      const row = await sql
        .prepare("SELECT 1 FROM sessions WHERE id = ? AND tenant_id = ?")
        .bind(sessionId, tenantId)
        .first();
      return !!row;
    },
  });
  const memoryRepo = new SqlMemoryRepo(drizzleDb);
  // Memory blob watcher — wires chokidar fs events through
  // packages/queue's processMemoryEvent so CF + Node share one upsert
  // code path. Every SQL backend uses the same durable lease/fence contract.
  // Set MEMORY_QUEUE=disabled to skip wiring and fall back to the legacy
  // direct-call watcher.
  const useQueue = config.memoryQueue !== "disabled";
  const memoryWatcher = !ownsLongLivedProcesses
    ? { stop: async () => {} }
    : memoryBlobLocalDir && useQueue
    ? await startNodeMemoryQueue({
        mode: "sql",
        sql,
        sqlDialect: dialect,
        memoryRepo,
        memoryBlobs,
        memoryRoot: memoryBlobLocalDir,
      })
    : memoryBlobLocalDir
      ? startMemoryBlobWatcher({ memoryRoot: memoryBlobLocalDir, memoryRepo })
      : { stop: async () => {} };

  disposables.add("memory_watcher", () => memoryWatcher.stop());

  let s3Poller: { stop: () => Promise<void> } | null = null;
  if (ownsLongLivedProcesses && s3MemoryConfig) {
    // memory_blob_poller_lease lives in the consolidated baseline already; no
    // separate schema bootstrap needed here.
    const replicaId = `replica_${process.pid}_${Math.floor(Math.random() * 1e9).toString(36)}`;
    const { startS3MemoryPoller } = await import("../lib/s3-memory-poller.js");
    s3Poller = await startS3MemoryPoller({
      sql,
      sqlDialect: dialect,
      memoryRepo,
      replicaId,
      intervalMs: s3MemoryConfig.pollIntervalMs,
      s3: s3MemoryConfig,
    });
    disposables.add("s3_poller", () => s3Poller?.stop());
  }

  const outputsRoot = config.paths.sessionOutputs;
  mkdirSync(outputsRoot, { recursive: true });

  // ─── Files-store blob backend ────────────────────────────────────────
  //
  // Keyed off FILES_S3_* env vars; falls back to a local-FS adapter under
  // FILES_BLOB_DIR (default ./data/files-blobs). The blob store backs both
  // the files-store table content AND workspace_backups tar archives —
  // same single store, two key prefixes.

  const filesBlob: BlobStore = components.blobs.files.store;
  const filesBlobDescription = components.blobs.files.description;
  const sharedSessionOutputs = config.blobs.files.kind === "s3"
    ? new NodeSharedSessionOutputs({ sql, blobs: filesBlob })
    : undefined;
  await sharedSessionOutputs?.ensureSchema(dialect);
  const sessionOutputs = sharedSessionOutputs ?? nodeOutputsAdapter(outputsRoot);

  const workspaceBackups = new NodeWorkspaceBackupService({
    sql,
    blobs: filesBlob,
  });

  const sandboxOrchestrator = new DefaultSandboxOrchestrator({
    backups: workspaceBackups,
  });

  // ─── Hub + event log ────────────────────────────────────────────────────

  function newEventLog(sessionId: string): SqlEventLog {
    return new SqlEventLog(sql, sessionId, (e) => {
      const ev = e as SessionEvent & { id?: string; processed_at?: string };
      if (!ev.id) ev.id = `sevt_${generateEventId()}`;
      if (!ev.processed_at) ev.processed_at = new Date().toISOString();
    });
  }

  const hub: EventStreamHub = components.realtime.hub;
  const realtimeDescription = components.realtime.description;
  if (components.realtime.stop) disposables.add("realtime_hub", () => components.realtime.stop!());

  // ─── Sandbox factory ────────────────────────────────────────────────────

  async function buildSandbox(
    sessionId: string,
    workdir: string,
  ): Promise<import("@open-managed-agents/sandbox").SandboxExecutor> {
    return components.sandbox(
      {
        sessionId,
        workdir,
        memoryRoot: memoryBlobLocalDir ?? "",
        memoryWorkspace: {
          getText: (key) => memoryBlobs.getText(key),
          list: (prefix, cursor) => memoryBlobs.list(prefix, cursor),
          put: (key, content) => memoryBlobs.put(key, content),
          delete: (key) => memoryBlobs.delete(key),
        },
        outputsRoot,
      },
      sandboxEnvironment,
    );
  }

  // ─── Session registry ───────────────────────────────────────────────────

  /** Resolve agent.model (a model_id handle) → wire model + credentials.
   *  Prefer a matching model card; fall back to ANTHROPIC_* env vars. */
  async function resolveNodeModelCreds(
    tenantId: string,
    agentModel: string | {
      id: string;
      effort?: "low" | "medium" | "high" | "xhigh" | "max";
      speed?: string;
    },
  ): Promise<{
    wireModel: string;
    apiKey: string;
    baseURL?: string;
    provider?: string;
    customHeaders?: Record<string, string>;
    piConfig?: PiModelConfig;
  }> {
    const handle = typeof agentModel === "string" ? agentModel : agentModel.id;
    try {
      const card = await modelCardsService.findByModelId({ tenantId, modelId: handle });
      if (card && !card.archived_at) {
        const key = await modelCardsService.getApiKey({ tenantId, cardId: card.id });
        if (key) {
          return {
            wireModel: card.model,
            apiKey: key,
            baseURL: card.base_url ?? undefined,
            provider: card.provider,
            customHeaders: card.custom_headers ?? undefined,
            piConfig: card.pi_config
              ? card.pi_config as PiModelConfig
              : undefined,
          };
        }
      }
    } catch (err) {
      console.warn(
        `[model-card] lookup failed, falling back to env: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const apiKey = config.model.apiKey;
    if (!apiKey) {
      throw new Error(
        "No model card matched and ANTHROPIC_API_KEY is unset — configure a model card or set the env var",
      );
    }
    return {
      wireModel: handle,
      apiKey,
      baseURL: config.model.baseUrl,
      customHeaders: config.model.customHeaders,
    };
  }

  async function buildNodeLanguageModel(
    tenantId: string,
    agentModel: string | {
      id: string;
      effort?: "low" | "medium" | "high" | "xhigh" | "max";
      providerOptions?: Record<string, unknown>;
      provider_options?: Record<string, unknown>;
      speed?: string;
    },
  ) {
    const creds = await resolveNodeModelCreds(tenantId, agentModel);
    const configuredProviderOptions =
      typeof agentModel === "string"
        ? undefined
        : agentModel.providerOptions ?? agentModel.provider_options;
    const piProviderOptions = configuredProviderOptions?.pi;
    return toAiSdkLanguageModel(createPiModelRuntime({
      model: creds.wireModel,
      apiKey: creds.apiKey,
      provider: creds.provider,
      baseURL: creds.baseURL,
      customHeaders: creds.customHeaders,
      piConfig: creds.piConfig,
      providerOptions:
        piProviderOptions &&
        typeof piProviderOptions === "object" &&
        !Array.isArray(piProviderOptions)
          ? piProviderOptions as Record<string, unknown>
          : undefined,
      thinkingLevel: typeof agentModel === "string" ? undefined : agentModel.effort,
      speed: typeof agentModel === "string"
        ? undefined
        : agentModel.speed === "fast" ? "fast" : "standard",
    }));
  }

  const legacySessionMcpProxy = createLegacySessionMcpProxy({
    sessions: sessionsService,
    credentials: credentialService,
  });

  const sessionRegistry = new SessionRegistry({
    sql,
    hub,
    agentsService,
    memoryService,
    sandboxOrchestrator,
    newEventLog,
    buildSandbox,
    sandboxWorkdirRoot: config.paths.sandboxWorkdir,
    sqlDialect: dialect,
    buildModel: (agent, tenantId) => buildNodeLanguageModel(tenantId, agent.model),
    buildTools: async (agent, sandbox, tenantId, sessionId) => {
      const creds = await resolveNodeModelCreds(tenantId, agent.model);
      return buildTools(agent, sandbox, {
        ANTHROPIC_API_KEY: creds.apiKey,
        ANTHROPIC_BASE_URL: creds.baseURL,
        toMarkdown: toMarkdownProvider,
        tenantId,
        sessionId,
        mcpBinding: legacySessionMcpProxy,
      });
    },
    buildHarness: (agent) => {
      const h = resolveHarness(agent.harness);
      return {
        run: (ctx: unknown) => h.run(ctx as HarnessContext),
        ...(h.dispose ? {
          dispose: (reason: "replace" | "shutdown" | "destroy") => h.dispose!(reason),
        } : {}),
      };
    },
    buildHarnessContext: async (input) => {
      const creds = await resolveNodeModelCreds(input.tenantId, input.agent.model);
      const pi = createPiModelRuntime({
        model: creds.wireModel,
        apiKey: creds.apiKey,
        provider: creds.provider,
        baseURL: creds.baseURL,
        customHeaders: creds.customHeaders,
        piConfig: creds.piConfig,
        providerOptions:
          typeof input.agent.model !== "string" &&
          input.agent.model.provider_options?.pi &&
          typeof input.agent.model.provider_options.pi === "object" &&
          !Array.isArray(input.agent.model.provider_options.pi)
            ? input.agent.model.provider_options.pi as Record<string, unknown>
            : undefined,
        thinkingLevel:
          typeof input.agent.model === "string" ? undefined : input.agent.model.effort,
        speed:
          typeof input.agent.model === "string"
            ? undefined
            : input.agent.model.speed === "fast" ? "fast" : "standard",
      });
      const runtime = new NodeHarnessRuntime({
        sessionId: input.sessionId,
        log: input.eventLog,
        hub,
        sandbox: input.sandbox,
      });
      await runtime.refreshHistory();
      const rawSystemPrompt = input.agent.system ?? "";
      // Feishu-backed sessions get two live tools (mcp__feishu__im_message_send,
      // mcp__feishu__im_chat_read) wired straight to FeishuApiClient. Non-Feishu
      // sessions resolve to {} (a safe no-op spread). Token handling lives inside
      // FeishuApiClient — see lib/feishu-agent-tools.ts.
      const feishuTools = await resolveFeishuAgentTools(input.sessionId);
      return {
        agent: input.agent,
        userMessage: input.userMessage,
        session_id: input.sessionId,
        tools: {
          ...(input.tools as Record<string, unknown>),
          ...feishuTools,
        } as HarnessContext["tools"],
        model: input.model,
        pi,
        systemPrompt: composeSystemPrompt(rawSystemPrompt),
        rawSystemPrompt,
        env: {
          ANTHROPIC_API_KEY: creds.apiKey,
          ANTHROPIC_BASE_URL: creds.baseURL,
        },
        runtime,
      } satisfies HarnessContext;
    },
  });
  disposables.add("session_registry", () => sessionRegistry.shutdown());

  await sessionRegistry.bootstrap();

  return {
    config,
    processMode,
    ownsLongLivedProcesses,
    toMarkdownProvider,
    logger,
    metrics,
    tracer,
    sql,
    dialect,
    drizzleDb,
    backendDescription,
    managedAgentsPersistence,
    platformRootSecret,
    secrets,
    openAIAgentsSecrets,
    authDisabled,
    auth,
    agentsService,
    vaultService,
    credentialService,
    sessionsService,
    filesService,
    evalsService,
    environmentsService,
    modelCardsService,
    memoryBlobs,
    memoryBlobDescription,
    memoryService,
    dreamsService,
    outputsRoot,
    sessionOutputs,
    sharedSessionOutputs,
    filesBlob,
    filesBlobDescription,
    newEventLog,
    hub,
    realtimeDescription,
    buildSandbox,
    resolveNodeModelCreds,
    buildNodeLanguageModel,
    sessionRegistry,
  };
}

export type NodeFoundation = Awaited<ReturnType<typeof createNodeFoundation>>;
