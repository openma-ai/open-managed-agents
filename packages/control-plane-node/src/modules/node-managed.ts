import { nodePublishedSessionFiles } from "../lib/node-published-session-files";

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

import { createNodeManagedAcpCapabilities } from "../lib/node-managed-acp-capability.js";
import { loadNodeManagedAcpRecoveryHistory } from "../lib/node-managed-acp-recovery.js";
import { resolveProtocolEndpointsFromModelCard } from "@open-managed-agents/inference-proxy";
import { resolveManagedSubagentSession } from "../lib/node-managed-subagents.js";
import { installEnvironmentPackages } from "../lib/environment-packages";
import { createManagedSandboxBuilder } from "../lib/node-managed-sandbox-builder";
import { createNodeEnvironmentCache } from "../lib/environment-cache";
import { SqlKvStore } from "@open-managed-agents/kv-store/adapters/sql";
import { nodeSessionSandboxWarning } from "../lib/node-session-sandbox-warning";
import { EMPTY_SANDBOX_IMAGE_CATALOG } from "@open-managed-agents/sandbox";
import { resolveSessionSandboxMode, readManagedSessionMappingMetadata } from "@open-managed-agents/openai-agents-compat";
import { SqlSessionThreadStore } from "@open-managed-agents/session-thread-store-sql";
import { buildOpenAISubagentTools, nodeOpenAISubagentPolicy, openAISubagentSession } from "../openai-subagents.js";

import { createNodeOpenAIArtifactPublisher, withReportedArtifactPublication } from "../openai-artifact-publication.js";

import {
  buildTools, disposeTools, composeSystemPrompt, agentUsesAssemblySkillMount, type HarnessContext,
  readHarnessAgentModelSettings, createPiModelRuntime, resolveHarness,
} from "@open-managed-agents/agent-harness";

import { generateText } from "ai";

import { createBuiltinCapDeviceFlow } from "@open-managed-agents/oma-cap-adapter";
import { buildMcpOAuthCliRoutes, buildMcpOAuthCliCallback, buildCapCliDeviceFlowRoutes, buildMcpOAuthRoutes, buildCredentialRoutes as buildManagedCredentialRoutes, buildDeploymentRoutes as buildManagedDeploymentRoutes, buildDeploymentRunRoutes as buildManagedDeploymentRunRoutes, buildDreamRoutes as buildManagedDreamRoutes, buildEnvironmentRoutes as buildManagedEnvironmentRoutes, buildEnvironmentWorkRoutes as buildManagedEnvironmentWorkRoutes, buildFileRoutes as buildManagedFileRoutes, buildMemoryStoreRoutes as buildManagedMemoryStoreRoutes, buildMemoryRoutes as buildManagedMemoryRoutes, buildMemoryVersionRoutes as buildManagedMemoryVersionRoutes, buildModelRoutes as buildManagedModelRoutes, buildSkillRoutes as buildManagedSkillRoutes, buildSkillVersionRoutes as buildManagedSkillVersionRoutes, buildTunnelCertificateRoutes as buildManagedTunnelCertificateRoutes, buildTunnelRoutes as buildManagedTunnelRoutes, buildVaultRoutes as buildManagedVaultRoutes, buildUserProfileRoutes as buildManagedUserProfileRoutes } from "@open-managed-agents/managed-agents-api";
import { activeModelCardPricing, McpOAuthCliService, CapCliDeviceFlowApplicationService, McpOAuthApplicationService, SandboxCredentialAdmission, SessionCreateAdmissionService, SessionRuntimeHistoryApplicationService, SessionRuntimeProjectionApplicationService, type SessionEnvironmentSourcePort } from "@open-managed-agents/managed-agents-application";
import { bindPort, defineAppModule, providePort } from "@open-managed-agents/app";
import { managedAgentsPortTokens } from "@open-managed-agents/app/managed-agents";
import { deploymentAgentSourcePort, deploymentEnvironmentSourcePort, deploymentFileSourcePort, deploymentMemoryStoreSourcePort, deploymentSchedulePlannerPort, deploymentSessionLauncherPort, deploymentVaultSourcePort } from "@open-managed-agents/app/modules/deployments";
import { dreamCuratorPort, dreamExecutionModule, dreamMemoryStoreSourcePort, dreamMemoryWorkspacePort, dreamSessionSourcePort } from "@open-managed-agents/app/modules/dreams";
import { environmentSessionWorkEnqueuerPort, environmentWorkAvailabilityWaiterPort, environmentWorkEnqueuerModule, environmentWorkEnvironmentSourcePort, environmentWorkSessionCredentialIssuerPort, environmentWorkWakeupPort } from "@open-managed-agents/app/modules/environment-work";
import { memoryContentDescriptorPort, memoryStoreForMemorySourcePort, memoryVersionActorPort } from "@open-managed-agents/app/modules/memories";
import { modelCatalogSourcePort } from "@open-managed-agents/app/modules/models";
import { skillPackageCompilerPort } from "@open-managed-agents/app/modules/skills";
import { tunnelCertificateAuthorityPort, tunnelProvisionerPort, tunnelTokenManagerPort } from "@open-managed-agents/app/modules/tunnels";
import { userProfileEnrollmentIssuerPort } from "@open-managed-agents/app/modules/user-profiles";
import { createNodeManagedAgentsApp, createNodePlatform } from "@open-managed-agents/platform-node";
import { SqlFileStore } from "@open-managed-agents/file-store-sql";
import { SqlCredentialStore, type CredentialDocumentCipher } from "@open-managed-agents/credential-store-sql";
import { SqlVaultStore } from "@open-managed-agents/vault-store-sql";
import { SqlDeploymentStore, type DeploymentResourceSecretCipher } from "@open-managed-agents/deployment-store-sql";
import { SqlDeploymentRunStore } from "@open-managed-agents/deployment-run-store-sql";
import { SqlDreamStore } from "@open-managed-agents/dream-store-sql";
import { SqlMemoryStoreStore } from "@open-managed-agents/memory-store-store-sql";
import { SqlMemoryDocumentStore } from "@open-managed-agents/memory-document-store-sql";
import { SqlSkillStore } from "@open-managed-agents/skill-store-sql";
import { SqlTunnelStore } from "@open-managed-agents/tunnel-store-sql";
import { SqlUserProfileStore } from "@open-managed-agents/user-profile-store-sql";
import { SqlEnvironmentWorkStore, type EnvironmentWorkSecretCipher } from "@open-managed-agents/environment-work-store-sql";
import { ensureMysqlWorkInputsSchema, SqlMcpOAuthCliStore, SqlDeploymentAgentSource, SqlDeploymentVaultSource, SqlEnvironmentPersistence, SqlFileMetadataPersistence, SqlMemoryStoreSource, SqlManagedSessionsComposition, SqlPersistedSessionEventStream, SqlReplicatedSessionEventStream, SqlSessionEnvironmentSource, SqlSessionSource, SqlSessionRuntimeProjectionPersistence, SqlSessionEventPersistence } from "@open-managed-agents/managed-agents-adapters-sql";
import { createSqlSessionRuntimeReaders, ensureSessionExecutionClaimLockSchema, ensureSessionExecutionCoordinatorSchema, SqlSessionExecutionCoordinator } from "@open-managed-agents/session-runtime-sql";
import { MemorySessionRealtimeHub } from "@open-managed-agents/session-realtime-memory";
import { encodeRuntimeSessionEvent, AnthropicMessagesDreamCurator, ApplicationDreamMemoryWorkspace, ModelCardCatalogSource, CronDeploymentSchedulePlanner, EnvironmentAwareSessionEventDispatchRouter, EnvironmentAwareSessionEventStreamRouter, EnvironmentAwareSessionLifecycleRouter, TimerEnvironmentWorkAvailabilityWaiter, McpOAuthCredentialValidationProbe, inProcessDreamExecutionSchedulerModule, LocalTunnelProvisioner, SealedEnvironmentWorkSessionCredentialIssuer, StandardWebhookEnvironmentWorkWakeup, DeduplicatingDreamCurator, WebCryptoTunnelCertificateAuthority, WebCryptoTunnelTokenManager, WebCryptoMemoryContentDescriptor, ZipSkillPackageCompiler } from "@open-managed-agents/managed-agents-adapters-runtime";

import { BlobFileContentStore } from "@open-managed-agents/managed-agents-adapters-blob";

import { resolveFeishuAgentTools } from "../lib/feishu-agent-tools.js";
import { NodeManagedSessionOutputCollector } from "../lib/node-managed-session-outputs.js";
import { NodeManagedWorkspaceCheckpoints } from "../lib/node-managed-workspace-checkpoints.js";
import { nodeSessionLifecycle } from "../lib/node-session-lifecycle.js";
import { matterRepositoryCredentials } from "../lib/matter-repository-credentials.js";
import { SqlSessionResourceSecretSource } from "@open-managed-agents/session-resource-store-sql";

import { rm } from "node:fs/promises";
import { join } from "node:path";
import { nanoid } from "nanoid";

import { allowAllLegacyHarnessTools, toLegacyHarnessAgentConfig, toLegacyHarnessEnvironmentConfig, resolveNodeManagedAuxiliaryToolModel } from "../lib/node-managed-agent-codec.js";
import { NodeManagedConfirmedToolExecutor } from "../lib/node-managed-confirmed-tool-executor.js";
import { NodeManagedOutcomeEvaluator } from "../lib/node-managed-outcome-evaluator.js";
import { ManagedCredentialResolver, createCredentialEgressRelay } from "@open-managed-agents/managed-credential-resolver";
import { authenticateSandboxEgress, createVaultPlaceholders } from "@open-managed-agents/sandbox-gateway";
import { isSessionExecutionFenceActive, sessionExecutionLeasesFrom, type SessionExecutionAttemptRef } from "@open-managed-agents/session-runtime/execution-lease";
import { HttpMcpOAuth, webCryptoMcpOAuthPkce, webCryptoMcpOAuthCliSecrets } from "@open-managed-agents/managed-agents-adapters-http";
import { builtinSpecs, createSpecRegistry } from "@open-managed-agents/cap";
import { createNodeRepositoryEgress } from "../lib/node-repository-egress.js";
import { sendDirectHttps } from "@open-managed-agents/sandbox-egress/direct-https";
import { buildCredentialEgressRoutes } from "@open-managed-agents/managed-agents-adapters-http";
import { ApplicationBackedNodeManagedSessionRuntimeEngine, DefaultNodeManagedSessionRuntimeDriver, NodeManagedSessionRuntimeAdapter } from "../lib/node-managed-session-runtime.js";
import { DefaultNodeManagedSessionRunner } from "../lib/node-managed-session-runner.js";
import {
  buildNodeManagedSkillReminders,
  resolveNodeManagedSkillMounts,
  buildNodeManagedAppendablePromptReminders,
  NodeManagedSessionInputPreparer,
  nodeManagedMemoryStoreModeName,
} from "../lib/node-managed-session-inputs.js";
import { NodeManagedMemorySnapshotMaterializer } from "../lib/node-managed-memory-snapshots.js";
import { NodeSessionSandboxes, sandboxIdlePauseMs, sandboxSnapshotIntervalMs } from "../lib/node-session-sandbox.js";
import { createNodeSessionStorage } from "../lib/node-session-storage.js";
import { NodeSessionExecutionWorker } from "../lib/node-session-execution-worker.js";
import {
  createMcpProxyBinding,
  type InferenceProxyPorts,
  type McpProxyPorts,
} from "@open-managed-agents/http-routes/proxy";
import { createNodeAccessLossRuntime } from "../lib/mcp-access-loss.js";
import { nodeSessionModelEgress } from "../lib/node-session-budget-gates.js";

import { Disposables } from "../lifecycle.js";
import type { NodeComponents } from "../components.js";
import { createManagedIdGenerator } from "../managed-ids.js";

import type { NodeFoundation } from "./node-foundation.js";

export async function createManagedNodeRuntime(
  foundation: NodeFoundation,
  components: NodeComponents,
  disposables: Disposables,
) {
  const {
    config,
    toMarkdownProvider,
    logger,
    sql,
    managedAgentsPersistence,
    platformRootSecret,
    secrets,
    openAIAgentsSecrets,
    credentialService,
    sessionsService,
    filesService,
    modelCardsService,
    memoryBlobs,
    outputsRoot,
    sessionOutputs,
    sharedSessionOutputs,
    filesBlob,
    buildSandbox,
    resolveNodeModelCreds,
    resolveDreamModelCredentials,
    buildNodeLanguageModel,
  } = foundation;
  // ─── Official Managed Sessions composition ─────────────────────────────

  async function resolveHostedModel(tenantId: string, model: string | { id: string }) {
    const handle = typeof model === "string" ? model : model.id;
    const card = await modelCardsService.findByModelId({ tenantId, modelId: handle });
    if (!card || card.archived_at) throw new Error(`Node ACP sandbox requires an active workspace model card for "${handle}"`);
    const apiKey = await modelCardsService.getApiKey({ tenantId, cardId: card.id });
    if (!apiKey) throw new Error(`Node ACP sandbox model card "${handle}" has no credential`);
    return {
      wireModel: card.model, apiKey, provider: card.provider,
      baseURL: card.base_url ?? undefined,
      customHeaders: card.custom_headers ?? undefined,
      protocolEndpoints: resolveProtocolEndpointsFromModelCard({ providerId: card.provider, baseUrl: card.base_url, wireModel: card.model, piConfig: card.pi_config ?? undefined }),
    };
  }

  // The sandbox MCP and inference gateways (design §0.7), shared with
  // Cloudflare: v1 and legacy Sessions, Vaults and model cards in this
  // control plane's database.
  const proxyLog = {
    info: (fields: Record<string, unknown>, message: string) => logger.info(fields, message),
    warn: (fields: Record<string, unknown>, message: string) => logger.warn(fields, message),
  };
  const proxySessions = { managed: new SqlSessionSource(sql), legacy: sessionsService };
  const mcpProxyPorts: McpProxyPorts = {
    sessions: proxySessions,
    legacyCredentials: credentialService,
    managedCredentials: () => managedCredentialResolver,
    accessLoss: await createNodeAccessLossRuntime(sql),
    log: proxyLog,
  };
  const inferenceProxyPorts: InferenceProxyPorts = {
    sessions: proxySessions,
    modelCards: modelCardsService,
    log: proxyLog,
    budget: nodeSessionModelEgress,
  };
  const nodeMcpProxyBinding = createMcpProxyBinding(() => mcpProxyPorts);

  const managedSessionResourceSecrets = new SqlSessionResourceSecretSource(sql, {
    open: async (value) => {
      if (managedResourceCipher === null) {
        throw new Error(
          "PLATFORM_ROOT_SECRET is required for managed Session repository credentials",
        );
      }
      return managedResourceCipher.decrypt(value);
    },
  });
  const repositorySources = { repositoryCredentials: managedSessionResourceSecrets, ...(config.http.matter ? { repositoryBonds: matterRepositoryCredentials(config.http.matter) } : {}) };
  const repositoryEgress = createNodeRepositoryEgress({ ...repositorySources, secret: platformRootSecret, findSession: async (s) => (await managedRuntimeReaders.executionContext.find(s))?.session ?? null });

  // Ensure held_after_exhausted_ms before claim SQL (older Drizzle baselines).
  await ensureSessionExecutionCoordinatorSchema(sql, foundation.dialect);
  if (config.workspace.strategy === "checkpoint_restore") {
    await ensureSessionExecutionClaimLockSchema(sql, foundation.dialect);
  }
  const managedSessionExecutionCoordinator = new SqlSessionExecutionCoordinator(sql, {
    serializeSessionClaims: config.workspace.strategy === "checkpoint_restore",
    sweepIntervalMs: 5_000,
    onFailedExecution: execution => managedRuntimeDriver.finalizeDeadExecution(execution),
    onError: (error, op) => logger.error(
      { err: error, op },
      "session execution sweep failed",
    ),
  });

  // The one Session execution fence check (design §0.0 rule 10): the lease
  // row is the authority; a fence snapshot's own expiresAt is not.
  const managedSessionExecutionLeases = sessionExecutionLeasesFrom(input => managedSessionExecutionCoordinator.find(input));
  async function isManagedSessionExecutionFenceActive(fence: SessionExecutionAttemptRef & { expiresAt: string }): Promise<boolean> {
    return isSessionExecutionFenceActive(managedSessionExecutionLeases, fence);
  }

  const managedAcpCapabilities = createNodeManagedAcpCapabilities({
    gatewayBaseUrl: config.http.publicBaseUrl,
    now: () => new Date(),
    sql,
  });

  const managedSessionOutputCollector = new NodeManagedSessionOutputCollector({
    outputsRoot,
    isFenceActive: isManagedSessionExecutionFenceActive,
    ...(sharedSessionOutputs === undefined ? {} : { shared: sharedSessionOutputs }),
  });
  const workspaceCheckpoints = config.workspace.strategy === "checkpoint_restore"
    ? new NodeManagedWorkspaceCheckpoints({
        sql, blobs: filesBlob, intervalMs: config.workspace.checkpointIntervalMs,
      })
    : undefined;
  await workspaceCheckpoints?.ensureSchema();
  const environmentCache = createNodeEnvironmentCache(config.sandbox, components.sessionSandboxAdapter?.adapter, {
    kvFor: (workspaceId) => new SqlKvStore({ db: foundation.drizzleDb, tenantId: workspaceId }),
    logger,
  });
  if (environmentCache !== undefined) disposables.add("environment_cache", () => environmentCache.dispose());

  // One decision for the deployment: native mounts only when the composed
  // factory declares them; every other sandbox file-syncs Memory Stores.
  const memoryStoreMode = nodeManagedMemoryStoreModeName(components.sandbox);
  const managedMemoriesFor = (workspaceId: string) =>
    managedMemoriesApplicationForWorkspace(workspaceId).port(managedAgentsPortTokens.memories);
  const managedSessionInputs = (workspaceId: string) => new NodeManagedSessionInputPreparer({
    sharedOutputs: sharedSessionOutputs !== undefined,
    files: managedPlatform.app({ workspaceId }).port(managedAgentsPortTokens.files),
    skillVersions: managedPlatform.app({ workspaceId }).port(managedAgentsPortTokens.skillVersions),
    ...repositorySources, repositoryPlaceholder: repositoryEgress.placeholder,
    memoryStores: memoryStoreMode === "native"
      ? {
          mode: "native",
          snapshots: new NodeManagedMemorySnapshotMaterializer(managedMemoriesFor(workspaceId), {
            getText: async (key) => (await memoryBlobs.getText(key))?.text ?? null,
            put: (key, content) => memoryBlobs.put(key, content),
          }),
        }
      : { mode: "file_sync", memories: managedMemoriesFor(workspaceId) },
  });
  // The Session sandbox is the shared core (design §0.0 rule 15); Node
  // injects its adapter, storage, egress relay and fence here.
  const sessionSandboxes = new NodeSessionSandboxes({
    ...(components.sessionSandboxAdapter === undefined ? {} : { adapter: components.sessionSandboxAdapter }),
    ...(foundation.sessionSandboxProvider === undefined ? {} : { provider: foundation.sessionSandboxProvider }),
    sql, snapshotIntervalMs: sandboxSnapshotIntervalMs(config.sandbox.environment.SANDBOX_SNAPSHOT_INTERVAL_MS),
    info: (message, { workspaceId, session }) => logger.info({ op: "main-node.session_sandbox", workspaceId, sessionId: session.id }, message),
    images: config.sandbox.images,
    createV1: createManagedSandboxBuilder({
      capabilities: components.sandbox.capabilities,
      images: config.sandbox.images,
      workdir: (sessionId) => join(config.paths.sandboxWorkdir, sessionId),
      build: buildSandbox,
    }),
    ...(environmentCache === undefined ? {} : { environmentCache }),
    sessionWarning: ({ workspaceId, session }, source, message) => managedRuntimeDriver.publishSessionWarning({ workspaceId, sessionId: session.id, source, message }),
    ...(config.workspace.sandboxLeaseTtlMs === undefined ? {} : { v1LeaseTtlMs: config.workspace.sandboxLeaseTtlMs }),
    storage: createNodeSessionStorage({
      memoryStoreMode,
      memories: managedMemoriesFor,
      memoryBlobs: {
        getText: async (key) => (await memoryBlobs.getText(key))?.text ?? null,
        list: (prefix, cursor) => memoryBlobs.list(prefix, cursor),
        put: (key, content) => memoryBlobs.put(key, content),
        delete: (key) => memoryBlobs.delete(key),
      },
      ...(sharedSessionOutputs === undefined ? {} : { sharedOutputs: sharedSessionOutputs }),
      outputs: managedSessionOutputCollector,
      workOutputs: { synchronize: input => managedSessionOutputCollector.synchronizeWork(input) },
      inputs: managedSessionInputs,
      isFenceActive: isManagedSessionExecutionFenceActive,
      warn: (fields, message) => logger.warn(fields, message),
    }),
    substitutions: (context) => repositoryEgress.substitutions(context, () => managedCredentialResolver),
    token: (attempt, harness, sandbox) => managedAcpCapabilities.issueEgress(attempt, harness, sandbox),
    relay: () => !platformRootSecret || !config.http.publicBaseUrl ? null
      : { issue: (attempt, harness, sandbox) => managedAcpCapabilities.issueEgress(attempt, harness, sandbox), endpoint: config.http.publicBaseUrl },
    isFenceActive: isManagedSessionExecutionFenceActive,
    idlePauseMs: sandboxIdlePauseMs(config.sandbox.environment.SANDBOX_IDLE_PAUSE_MS),
    warmAtCreate: config.workspace.strategy !== "checkpoint_restore", mountOutputsAtCreate: sharedSessionOutputs === undefined && components.sandbox.capabilities?.mountsFixedAtCreate === true,
    warn: nodeSessionSandboxWarning(sql, logger, foundation.dialect),
  });
  const managedRuntimeRunner = new DefaultNodeManagedSessionRunner({
    backgroundPiSandbox: true,
    ...(workspaceCheckpoints === undefined ? {} : { workspaceCheckpoints }),
    ...(config.workspace.sandboxLeaseTtlMs === undefined
      ? {}
      : { sandboxLease: { ttlMs: config.workspace.sandboxLeaseTtlMs } }),
    isExecutionFenceActive: isManagedSessionExecutionFenceActive,
    subagentThreads: new SqlSessionThreadStore(sql),
    subagentPolicy: ({ session }) => nodeOpenAISubagentPolicy(session, openAIAgentsSecrets),
    resolveSubagentSession: async ({ session, request }) => {
      const saved = await readManagedSessionMappingMetadata(session, openAIAgentsSecrets);
      if (saved) return openAISubagentSession(session, request);
      return resolveManagedSubagentSession(session, request);
    },
    confirmedTools: new NodeManagedConfirmedToolExecutor({
      buildExecutableTools: async ({ workspaceId, session, environment, sandbox }) => {
        const agent = allowAllLegacyHarnessTools(
          toLegacyHarnessAgentConfig(session),
        );
        const creds = await resolveNodeModelCreds(workspaceId, agent.model);
        const auxiliary = await resolveNodeManagedAuxiliaryToolModel(
          session,
          (model) => buildNodeLanguageModel(workspaceId, model),
        );
        return buildTools(agent, sandbox, {
          ANTHROPIC_API_KEY: creds.apiKey,
          ANTHROPIC_BASE_URL: creds.baseURL,
          toMarkdown: toMarkdownProvider,
          tenantId: workspaceId,
          sessionId: session.id,
          mcpBinding: nodeMcpProxyBinding,
          environmentConfig: toLegacyHarnessEnvironmentConfig(environment),
          auxModel: auxiliary?.model,
          auxModelInfo: auxiliary?.modelInfo,
          auxProviderOptions: auxiliary?.providerOptions,
        }, { enforcePermissions: false });
      },
    }),
    outcomes: new NodeManagedOutcomeEvaluator({
      buildModel: ({ workspaceId, session }) =>
        buildNodeLanguageModel(workspaceId, session.agent.model),
      judge: async ({ model, system, prompt, abortSignal }) => {
        const result = await generateText({
          model,
          system,
          prompt,
          abortSignal,
        });
        return {
          text: result.text,
          usage: {
            inputTokens: result.usage.inputTokens ?? 0,
            outputTokens: result.usage.outputTokens ?? 0,
          },
        };
      },
      rubricFiles: (workspaceId) => ({
        read: async ({ fileId }) => {
          const download = await managedPlatform
            .app({ workspaceId })
            .port(managedAgentsPortTokens.files)
            .downloadFile({ fileId });
          return download.type === "found"
            ? { type: "found", text: new TextDecoder().decode(download.file.content) }
            : { type: "not_found" };
        },
      }),
    }),
    sandboxMode: ({ session }) => resolveSessionSandboxMode(session, openAIAgentsSecrets),
    buildSandbox: async (input) => sessionSandboxes.build(input),
    ...(sharedSessionOutputs === undefined ? {} : {
      isSandboxCurrent: ({ workspaceId, session, runtimeGeneration }: { workspaceId: string; session: { id: string }; runtimeGeneration: string }) =>
        sharedSessionOutputs.isSandboxCurrent(workspaceId, session.id, runtimeGeneration),
    }),
    prepareSandbox: async ({ workspaceId, session, environment, sandbox, runtimeGeneration, signal, executionFence }) => {
      const sessionSandbox = sessionSandboxes.get({ workspaceId, session });
      sessionSandbox.bind({ context: { workspaceId, session, environment }, runtimeGeneration, ...(executionFence === undefined ? {} : { executionFence }) });
      // Attach or acquire, egress, then outputs and Memory Stores (the storage Port).
      await sessionSandbox.open();
      // After the workspace is restored, so packages it carries count.
      await installEnvironmentPackages(sandbox, environment, {
        pipIndexUrl: config.sandbox.environment.SANDBOX_PIP_INDEX_URL,
        log: (result) => logger.info({
          op: "main-node.environment_packages",
          sessionId: session.id,
          workspaceId,
          environmentId: environment.id,
          path: result.path,
          durationMs: result.durationMs,
        }, "Environment packages ready"),
      });
      sessionSandbox.environmentPrepared();
      await managedSessionInputs(workspaceId).prepareInputs({
        workspaceId,
        session,
        sandbox,
        runtimeGeneration,
        ...(executionFence === undefined
          ? {}
          : { authorizeMemoryMutation: () => isManagedSessionExecutionFenceActive(executionFence) }),
        ...(signal === undefined ? {} : { signal }),
      });
    },
    // Cold preparation calls this last; warm reuse calls it for each new
    // execution: the core re-attaches egress with a sandbox token bound to it.
    refreshSandboxEnvironment: async ({ workspaceId, session, environment, executionFence }) => {
      if (session.vaultIds.length > 0 && (!platformRootSecret || !config.http.publicBaseUrl)) {
        throw new Error("Vault credential egress requires PLATFORM_ROOT_SECRET and the ordinary HTTPS PUBLIC_BASE_URL");
      }
      sessionSandboxes.get({ workspaceId, session }).bind({
        context: { workspaceId, session, environment },
        ...(executionFence === undefined ? {} : { executionFence }),
      });
    },
    // Execution end (design §0.1 step 7): revoke, fenced write-back, idle pause armed.
    synchronizeSandbox: async ({ workspaceId, session }) => {
      await sessionSandboxes.get({ workspaceId, session }).endExecution();
    },
    // A failed execution publishes nothing and releases the sandbox (design §0.0 rule 16).
    failSandbox: async ({ workspaceId, session }) => {
      await sessionSandboxes.get({ workspaceId, session }).failExecution();
    },
    afterExecution: withReportedArtifactPublication(createNodeOpenAIArtifactPublisher({
      historyForWorkspace: workspaceId => new SessionRuntimeHistoryApplicationService({ workspaceId, source: managedRuntimeReaders.history }),
      filesForWorkspace: workspaceId => managedPlatform.app({ workspaceId }).port(managedAgentsPortTokens.files),
      secrets: openAIAgentsSecrets,
      isFenceActive: isManagedSessionExecutionFenceActive,
      environmentId: session => `oai_env_${session.id}`,
      logger,
    }), async (_error, input) => {
      await managedRuntimeDriver.publishSessionWarning({
        workspaceId: input.workspaceId, sessionId: input.session.id,
        executionFence: input.executionFence, source: "agents_api.artifact_publication",
        message: "The derived Agents API Files publication failed. This does not establish loss of the underlying managed output bytes.",
      });
      logger.warn({ op: "main-node.openai_agents.artifact_publication_failed",
        sessionId: input.session.id, executionId: input.executionFence.executionId }, "Derived artifact publication failed; durable warning recorded");
    }),
    resolveModelPricing: async ({ workspaceId, session }) => {
      const model = session.agent.model as string | { id: string };
      const handle = typeof model === "string" ? model : model.id;
      const card = await modelCardsService.findByModelId({ tenantId: workspaceId, modelId: handle });
      return activeModelCardPricing(card);
    },
    buildModel: async ({ workspaceId, session }) => {
      if (session.agent.openma?.harness === "acp-sandbox") {
        await resolveHostedModel(workspaceId, session.agent.model);
      }
      return buildNodeLanguageModel(workspaceId, session.agent.model);
    },
    buildTools: async ({ workspaceId, session, environment, sandbox, subagents, delegateToAgent }) => {
      const agent = toLegacyHarnessAgentConfig(session);
      // ACP owns its tool clients inside the sandbox; do not eagerly open
      // a second host-side MCP connection or resolve unrelated tool models.
      if (agent.harness === "acp-sandbox") return {};
      const creds = await resolveNodeModelCreds(workspaceId, agent.model);
      const auxiliary = await resolveNodeManagedAuxiliaryToolModel(
        session,
        (model) => buildNodeLanguageModel(workspaceId, model),
      );
      const tools = await buildTools(agent, sandbox, {
        ANTHROPIC_API_KEY: creds.apiKey,
        ANTHROPIC_BASE_URL: creds.baseURL,
        toMarkdown: toMarkdownProvider,
        tenantId: workspaceId,
        sessionId: session.id,
        mcpBinding: nodeMcpProxyBinding,
        environmentConfig: toLegacyHarnessEnvironmentConfig(environment),
        auxModel: auxiliary?.model,
        auxModelInfo: auxiliary?.modelInfo,
        auxProviderOptions: auxiliary?.providerOptions,
        delegateToAgent,
      });
      if (subagents && (await readManagedSessionMappingMetadata(session, openAIAgentsSecrets))?.agent.multi_agent?.enabled) {
        for (const [name, definition] of Object.entries(buildOpenAISubagentTools(subagents))) {
          let available = name;
          while (Object.hasOwn(tools, available)) available = `openma_${available}`;
          tools[available] = definition;
        }
      }
      return tools;
    },
    disposeTools,
    buildHarness: () => ({
      run: async (ctx) => {
        const harness = resolveHarness(ctx.agent.harness);
        try {
          if (ctx.agent.harness === "acp-sandbox") await harness.onSessionInit?.(ctx, ctx.runtime);
          await harness.run(ctx);
        } finally {
          // A Node execution owns this process; retain native state for the
          // next attempt but never retain a process with an expired bearer.
          if (ctx.agent.harness === "acp-sandbox") await harness.dispose?.("shutdown");
        }
      },
    }),
    buildHarnessContext: async (input) => {
      const agent = toLegacyHarnessAgentConfig(input.session);
      let sandboxEnv: HarnessContext["env"] | undefined;
      let acpRecoveryHistory: HarnessContext["acpRecoveryHistory"];
      if (agent.harness === "acp-sandbox") {
        const model = await resolveHostedModel(input.workspaceId, agent.model);
        const capability = await managedAcpCapabilities.issue(input);
        acpRecoveryHistory = input.runtime.sessionThreadId !== "sthr_primary" ? input.runtime.history.getEvents() : await loadNodeManagedAcpRecoveryHistory({
          sql, history: managedRuntimeReaders.history,
          fence: input.executionFence!, acceptedEvents: input.acceptedEvents,
        });
        sandboxEnv = {
          ANTHROPIC_API_KEY: "",
          mcpProxy: capability,
          hostedInference: { ...capability, model: { providerId: model.provider, baseUrl: model.baseURL ?? null, wireModel: model.wireModel, protocolEndpoints: model.protocolEndpoints } },
        };
      }
      const creds = await resolveNodeModelCreds(input.workspaceId, agent.model);
      const modelSettings = readHarnessAgentModelSettings(agent.model);
      const pi = createPiModelRuntime({
        model: creds.wireModel,
        apiKey: creds.apiKey,
        provider: creds.provider,
        baseURL: creds.baseURL,
        customHeaders: creds.customHeaders,
        piConfig: creds.piConfig,
        modelMaxTokens: modelSettings?.maxTokens,
        providerOptions:
          typeof agent.model !== "string" &&
          agent.model.provider_options?.pi &&
          typeof agent.model.provider_options.pi === "object" &&
          !Array.isArray(agent.model.provider_options.pi)
            ? agent.model.provider_options.pi as Record<string, unknown>
            : undefined,
        thinkingLevel: typeof agent.model === "string" ? undefined : agent.model.effort,
        speed: typeof agent.model === "string" ? undefined : agent.model.speed === "fast" ? "fast" : "standard",
      });
      const rawSystemPrompt = input.session.agent.system ?? "";
      const assemblySkills = agentUsesAssemblySkillMount(agent);
      const skillMounts = assemblySkills
        ? await resolveNodeManagedSkillMounts(
          input.session,
          managedPlatform
            .app({ workspaceId: input.workspaceId })
            .port(managedAgentsPortTokens.skillVersions),
        )
        : undefined;
      const platformReminders = [
        ...(assemblySkills ? [] : await buildNodeManagedSkillReminders(
          input.session,
          managedPlatform
            .app({ workspaceId: input.workspaceId })
            .port(managedAgentsPortTokens.skillVersions),
        )),
        ...buildNodeManagedAppendablePromptReminders(input.session),
      ];
      const feishuTools = await resolveFeishuAgentTools(input.session.id);
      return {
        agent,
        acpRecoveryHistory,
        // History may already include later queued executions. Consume only
        // this execution's accepted messages, in order, without dropping any.
        userMessage: {
          type: "user.message",
          content: input.acceptedEvents.filter(event => event.type === "user.message").flatMap(event =>
            (encodeRuntimeSessionEvent(event) as import("@open-managed-agents/shared").UserMessageEvent).content),
        },
        session_id: input.session.id,
        tenant_id: input.workspaceId,
        tools: { ...input.tools, ...feishuTools },
        model: input.model,
        pi,
        systemPrompt: composeSystemPrompt(rawSystemPrompt, platformReminders),
        rawSystemPrompt,
        platformReminders,
        ...(skillMounts?.length ? { skillMounts } : {}),
        env: sandboxEnv ?? {
          ANTHROPIC_API_KEY: creds.apiKey,
          ANTHROPIC_BASE_URL: creds.baseURL,
        },
        runtime: input.runtime,
      } satisfies HarnessContext;
    },
    clock: { now: () => new Date() },
    ids: { nextEventId: () => `sevt_${nanoid()}` },
    runtimeGenerations: { next: () => `runtime_${nanoid()}` },
  });

  const managedRuntimeReaders = createSqlSessionRuntimeReaders(sql);
  disposables.add("sandbox_orphan_reclaim", sessionSandboxes.startOrphanReclaim(config.sandbox.environment.SANDBOX_ORPHAN_RECLAIM_MS, async (labels) => (await managedRuntimeReaders.executionContext.find(labels))?.session ?? null, logger));
  const managedRuntimeEngine = new ApplicationBackedNodeManagedSessionRuntimeEngine({
    historyFor: (workspaceId) =>
      new SessionRuntimeHistoryApplicationService({
        workspaceId,
        source: managedRuntimeReaders.history,
      }),
    runner: managedRuntimeRunner,
  });
  // Shared with /v1/oma/sessions pending cancel/steer so Console dock frames
  // land on the same hub the managed event stream reads.
  const managedSessionRealtime = new MemorySessionRealtimeHub();
  const managedRuntimeDriver = new DefaultNodeManagedSessionRuntimeDriver({
    engine: managedRuntimeEngine,
    realtime: managedSessionRealtime,
    projectionFor: (workspaceId) =>
      new SessionRuntimeProjectionApplicationService({
        workspaceId,
        persistence: new SqlSessionRuntimeProjectionPersistence(sql, { dialect: foundation.dialect }),
      }),
    eventProcessing: {
      storeFor: () => new SqlSessionEventPersistence(sql),
    },
  });
  const managedSessionExecutionWorker = new NodeSessionExecutionWorker({
    coordinator: managedSessionExecutionCoordinator,
    context: managedRuntimeReaders.executionContext,
    runtime: {
      run: async ({ executionId: _executionId, fence, ...input }, hooks) => {
        await managedRuntimeDriver.accept({
          ...input,
          executionFence: fence,
          ...(hooks !== undefined && { takeSteeringInputs: () => hooks.takeSteeringInputs() }),
        });
      },
      cancel: async (input) => {
        managedRuntimeDriver.cancel({
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          reason: input.reason,
          attemptId: input.fence.attemptId,
        });
        managedRuntimeRunner.cancel({ workspaceId: input.workspaceId, sessionId: input.sessionId, reason: input.reason });
      },
    },
    ownerId: config.execution.ownerId,
    clock: { now: () => new Date() },
    ids: { nextAttemptId: () => `attempt_${nanoid()}` },
    leaseTtlMs: config.execution.leaseTtlMs,
    maxConcurrent: config.execution.concurrency,
    eventProcessing: {
      storeFor: () => new SqlSessionEventPersistence(sql),
    },
    onError: (err) => logger.error(
      { err, op: "main-node.session_execution.background_failed" },
      "managed Session execution background operation failed",
    ),
  });
  const managedSessionRuntime = new NodeManagedSessionRuntimeAdapter(
    managedRuntimeDriver,
    managedSessionExecutionWorker,
  );
  // The Session Execution lease can land on any replica, so the official
  // stream must also tail the canonical projection unless this is a single
  // in-memory replica.
  const replicaSync = components.realtime.replicaSync;
  const managedSessionRuntimeStream = replicaSync === null
    ? null
    : new SqlReplicatedSessionEventStream(sql, managedSessionRuntime, {
      pollIntervalMs: replicaSync.pollIntervalMs,
    });
  disposables.add("managed_session_runtime_stream", () => managedSessionRuntimeStream?.stop());

  const persistedManagedEnvironments = new SqlSessionEnvironmentSource(sql);
  const nodeManagedEnvironments: SessionEnvironmentSourcePort = {
    find: async (input) => {
      if (input.environmentId !== "env-local-runtime") {
        return persistedManagedEnvironments.find(input);
      }
      return {
        id: input.environmentId,
        archivedAt: null,
        config: {
          type: "cloud",
          networking: { type: "unrestricted" },
          packages: { apt: [], cargo: [], gem: [], go: [], npm: [], pip: [] },
        },
        createdAt: "1970-01-01T00:00:00.000Z",
        description: "Node self-hosted runtime",
        metadata: {},
        name: "Local runtime",
        updatedAt: "1970-01-01T00:00:00.000Z",
      };
    },
  };
  const nodeSessionLifecycleHooks = nodeSessionLifecycle({
    files: filesService,
    filesBlob,
    outputs: sessionOutputs,
  });
  const managedSessionLifecycle = new EnvironmentAwareSessionLifecycleRouter({
    environments: nodeManagedEnvironments,
    runtime: sessionSandboxes.warmingLifecycle(managedSessionRuntime, (session) => resolveSessionSandboxMode(session, openAIAgentsSecrets)),
    selfHostedWork: {
      enqueue: (input) =>
        managedEnvironmentWorkEnqueuerFor(input.workspaceId).enqueue(input),
      stop: (input) =>
        managedEnvironmentWorkEnqueuerFor(input.workspaceId).stop(input),
    },
    cleanupSession: async ({ workspaceId, sessionId }) => {
      await nodeSessionLifecycleHooks.cascadeDeleteFiles?.({
        tenantId: workspaceId,
        sessionId,
      });
      await rm(
        join(config.paths.sandboxWorkdir, sessionId),
        { recursive: true, force: true },
      );
    },
  });
  const managedResourceCipher = secrets === null
    ? null
    : secrets.cipherFor("managed.sessions.resources");
  if (foundation.dialect === "mysql") await ensureMysqlWorkInputsSchema(sql);
  const managedSessionsComposition = new SqlManagedSessionsComposition({
    client: sql,
    workInputs: { sourcePositionsValidated: true, dialect: foundation.dialect },
    // Same shared admission policy as Cloudflare. Self-hosted Node has no
    // rate-limit, quota or billing adapters, so every create is admitted,
    // except Vault sandbox credentials without the forwarder gateway (400).
    admission: new SandboxCredentialAdmission(new SessionCreateAdmissionService({ clock: { now: () => new Date() } }), {
      substitutes: () => sessionSandboxes.credentialEgress(),
      credentialIds: (scope) => managedCredentialResolver.sandboxCredentialIds(scope),
    }),
    executionOutbox: true,
    environments: nodeManagedEnvironments,
    lifecycle: managedSessionLifecycle,
    runtime: managedSessionRuntime,
    eventDispatch: EnvironmentAwareSessionEventDispatchRouter.forWorkspace(managedSessionRuntime, managedEnvironmentWorkEnqueuerFor),
    eventStream: new EnvironmentAwareSessionEventStreamRouter({
      environments: nodeManagedEnvironments,
      runtime: managedSessionRuntimeStream ?? managedSessionRuntime,
      selfHosted: new SqlPersistedSessionEventStream(sql),
    }),
    sealer: {
      seal: async (value) => {
        if (managedResourceCipher === null) {
          throw new Error(
            "PLATFORM_ROOT_SECRET is required for managed Session resource credentials",
          );
        }
        return managedResourceCipher.encrypt(value);
      },
    },
    clock: { now: () => new Date() },
    ids: {
      nextSessionId: () => `session_${nanoid()}`,
      nextEventId: () => `sevt_${nanoid()}`,
      nextOutcomeId: () => `outc_${nanoid()}`,
      nextResourceId: () => `sesrsc_${nanoid()}`,
    },
  });
  disposables.add("managed_sessions", () => managedSessionsComposition.stopAll());

  const managedDeploymentCrypto = secrets === null
    ? null
    : secrets.cipherFor("managed.deployments.resources");
  const managedDeploymentCipher: DeploymentResourceSecretCipher = {
    seal: async ({ plaintext }) => {
      if (managedDeploymentCrypto === null) {
        throw new Error(
          "PLATFORM_ROOT_SECRET is required for managed Deployment resource credentials",
        );
      }
      return { ciphertext: await managedDeploymentCrypto.encrypt(plaintext) };
    },
    open: async ({ ciphertext }) => {
      if (managedDeploymentCrypto === null) {
        throw new Error(
          "PLATFORM_ROOT_SECRET is required for managed Deployment resource credentials",
        );
      }
      return { plaintext: await managedDeploymentCrypto.decrypt(ciphertext) };
    },
  };
  const managedDeploymentSchedulePlanner = new CronDeploymentSchedulePlanner();
  const managedEnvironmentWorkAvailability =
    new TimerEnvironmentWorkAvailabilityWaiter();
  const managedEnvironmentWorkCrypto = secrets === null
    ? null
    : secrets.cipherFor("managed.environment-work.secret");
  const managedEnvironmentWorkCipher: EnvironmentWorkSecretCipher = {
    seal: async ({ plaintext }) => {
      if (managedEnvironmentWorkCrypto === null) {
        throw new Error(
          "PLATFORM_ROOT_SECRET is required for managed Environment Work credentials",
        );
      }
      return {
        ciphertext: await managedEnvironmentWorkCrypto.encrypt(plaintext),
      };
    },
    open: async ({ ciphertext }) => {
      if (managedEnvironmentWorkCrypto === null) {
        throw new Error(
          "PLATFORM_ROOT_SECRET is required for managed Environment Work credentials",
        );
      }
      return {
        plaintext: await managedEnvironmentWorkCrypto.decrypt(ciphertext),
      };
    },
  };
  const managedEnvironmentWorkSessionTokenCrypto = secrets === null
    ? null
    : secrets.cipherFor("managed.environment-work.session-token");
  const managedEnvironmentWorkCredentials =
    managedEnvironmentWorkSessionTokenCrypto === null
      ? {
          issue: async () => ({
            type: "rejected" as const,
            message: "PLATFORM_ROOT_SECRET is required for managed Environment Work credentials",
          }),
          bindToClaim: async () => {
            throw new Error(
              "PLATFORM_ROOT_SECRET is required for managed Environment Work credentials",
            );
          },
        }
      : new SealedEnvironmentWorkSessionCredentialIssuer({
          crypto: managedEnvironmentWorkSessionTokenCrypto,
          now: () => new Date(),
          ...(config.http.publicBaseUrl !== undefined && {
            apiBaseUrl: config.http.publicBaseUrl,
          }),
        });
  const managedEnvironmentWebhookUrl = config.managedWebhooks.url;
  const managedEnvironmentWebhookKey =
    config.managedWebhooks.signingKey;
  const managedEnvironmentWebhook =
    managedEnvironmentWebhookUrl !== undefined
    && managedEnvironmentWebhookKey !== undefined
      ? new StandardWebhookEnvironmentWorkWakeup({
          endpoint: managedEnvironmentWebhookUrl,
          signingKey: managedEnvironmentWebhookKey,
          organizationId: ({ workspaceId }) =>
            config.managedWebhooks.organizationId ?? workspaceId,
          nextEventId: () => `whe_${nanoid()}`,
        })
      : null;
  const managedEnvironmentWorkStore = new SqlEnvironmentWorkStore(
    sql,
    managedEnvironmentWorkCipher,
  );
  function managedEnvironmentWorkEnqueuerFor(
    workspaceId: string,
  ) {
    return managedPlatform
      .app({ workspaceId })
      .port(environmentSessionWorkEnqueuerPort);
  }
  const managedDeploymentsRoutes = buildManagedDeploymentRoutes((context) => {
    const workspaceId = (context.var as { tenant_id: string }).tenant_id;
    return managedPlatform
      .app({ workspaceId })
      .port(managedAgentsPortTokens.deployments);
  });
  const managedDeploymentRunsRoutes = buildManagedDeploymentRunRoutes((context) => {
    const workspaceId = (context.var as { tenant_id: string }).tenant_id;
    return managedPlatform
      .app({ workspaceId })
      .port(managedAgentsPortTokens.deploymentRuns);
  });

  const managedEnvironmentsRoutes = buildManagedEnvironmentRoutes(
    (context) =>
      managedPlatform
        .app({
          workspaceId: (context.var as { tenant_id: string }).tenant_id,
        })
        .port(managedAgentsPortTokens.environments),
    { sandboxImages: config.sandbox.images ?? EMPTY_SANDBOX_IMAGE_CATALOG },
  );

  const managedEnvironmentWorkRoutes = buildManagedEnvironmentWorkRoutes(
    (context) =>
      managedPlatform
        .app({ workspaceId: (context.var as { tenant_id: string }).tenant_id })
        .port(managedAgentsPortTokens.environmentWork),
  );

  // No platform model key: each curation resolves the Dream workspace's own
  // model card for dream.model, exactly like a Session turn.
  const managedDreamCurator = config.dreamCurator === "dedup"
    ? new DeduplicatingDreamCurator()
    : new AnthropicMessagesDreamCurator({
        resolveCredentials: resolveDreamModelCredentials,
      });
  const managedDreamsRoutes = buildManagedDreamRoutes((context) =>
    managedPlatform
      .app({
        workspaceId: (context.var as { tenant_id: string }).tenant_id,
      })
      .port(managedAgentsPortTokens.dreams),
  );

  const managedModelsRoutes = buildManagedModelRoutes((context) =>
    createNodeManagedAgentsApp({
      workspaceId: (context.var as { tenant_id: string }).tenant_id,
      features: { preset: "none", models: true },
      modules: () => [providePort(
        modelCatalogSourcePort,
        new ModelCardCatalogSource(modelCardsService),
      )],
    }).port(managedAgentsPortTokens.models)
  );

  const managedTunnelProvisioner = new LocalTunnelProvisioner({
    domainSuffix: config.tunnels.domainSuffix,
    nextTokenId: () => `ttok_${nanoid()}`,
  });
  const managedTunnelTokens = new WebCryptoTunnelTokenManager({
    rootSecret: platformRootSecret,
    nextTokenId: () => `ttok_${nanoid()}`,
  });
  const managedTunnelCertificates = new WebCryptoTunnelCertificateAuthority();
  const managedTunnelsRoutes = buildManagedTunnelRoutes((context) =>
    managedPlatform.app({
      workspaceId: (context.var as { tenant_id: string }).tenant_id,
    }).port(managedAgentsPortTokens.tunnels),
  );
  const managedTunnelCertificateRoutes = buildManagedTunnelCertificateRoutes(
    (context) => managedPlatform.app({
      workspaceId: (context.var as { tenant_id: string }).tenant_id,
    }).port(managedAgentsPortTokens.tunnelCertificates),
  );

  const managedFilesRoutes = buildManagedFileRoutes((context) => {
    const workspaceId = (context.var as { tenant_id: string }).tenant_id;
    const files = managedPlatform.app({ workspaceId }).port(managedAgentsPortTokens.files);
    const outputs = sharedSessionOutputs ?? sessionOutputs;
    return nodePublishedSessionFiles(files, workspaceId, filesService, outputs);
  });

  const managedMemoryStoresRoutes = buildManagedMemoryStoreRoutes((context) =>
    managedPlatform
      .app({
        workspaceId: (context.var as { tenant_id: string }).tenant_id,
      })
      .port(managedAgentsPortTokens.memoryStores),
  );

  const managedMemoryContent = new WebCryptoMemoryContentDescriptor();
  const managedMemoryDocuments = new SqlMemoryDocumentStore(sql);
  function managedMemoryActor(userId: string | undefined) {
    return userId === undefined
      ? { kind: "api" as const, apiKeyId: "self_hosted" }
      : { kind: "user" as const, userId };
  }
  function managedMemoriesApplicationFor(context: unknown) {
    const request = (context as {
      var: { tenant_id: string; user_id?: string };
    }).var;
    return managedMemoriesApplicationForWorkspace(
      request.tenant_id,
      request.user_id,
    );
  }
  function managedMemoriesApplicationForWorkspace(
    workspaceId: string,
    userId?: string,
  ) {
    return createNodeManagedAgentsApp({
      workspaceId,
      features: {
        preset: "none",
        memories: true,
        memoryVersions: true,
      },
      stores: {
        memoryStores: new SqlMemoryStoreStore(sql),
        memories: managedMemoryDocuments,
      },
      clock: { now: () => new Date() },
      ids: {
        next: (namespace) => `${
          namespace === "memory"
            ? "mem"
            : namespace === "memory-version"
              ? "memver"
              : namespace
        }_${nanoid()}`,
      },
      modules: () => [
        providePort(
          memoryStoreForMemorySourcePort,
          new SqlMemoryStoreSource(sql),
        ),
        providePort(memoryContentDescriptorPort, managedMemoryContent),
        providePort(
          memoryVersionActorPort,
          managedMemoryActor(userId),
        ),
      ],
    });
  }
  const managedMemoriesRoutes = buildManagedMemoryRoutes((context) =>
    managedMemoriesApplicationFor(context)
      .port(managedAgentsPortTokens.memories),
  );
  const managedMemoryVersionsRoutes = buildManagedMemoryVersionRoutes((context) =>
    managedMemoriesApplicationFor(context)
      .port(managedAgentsPortTokens.memoryVersions),
  );

  const managedSkillCompiler = new ZipSkillPackageCompiler();
  const managedSkillsRoutes = buildManagedSkillRoutes((context) =>
    managedPlatform.app({
      workspaceId: (context.var as { tenant_id: string }).tenant_id,
    }).port(managedAgentsPortTokens.skills),
  );
  const managedSkillVersionsRoutes = buildManagedSkillVersionRoutes((context) =>
    managedPlatform.app({
      workspaceId: (context.var as { tenant_id: string }).tenant_id,
    }).port(managedAgentsPortTokens.skillVersions),
  );

  const managedCredentialCrypto = secrets === null
    ? null
    : secrets.cipherFor("managed.vault.credentials");
  const managedCredentialCipher: CredentialDocumentCipher = {
    seal: async ({ plaintext }) => {
      if (managedCredentialCrypto === null) {
        throw new Error(
          "PLATFORM_ROOT_SECRET is required for managed Vault credentials",
        );
      }
      return { ciphertext: await managedCredentialCrypto.encrypt(plaintext) };
    },
    open: async ({ ciphertext }) => {
      if (managedCredentialCrypto === null) {
        throw new Error(
          "PLATFORM_ROOT_SECRET is required for managed Vault credentials",
        );
      }
      return { plaintext: await managedCredentialCrypto.decrypt(ciphertext) };
    },
  };
  const managedCredentialValidation = new McpOAuthCredentialValidationProbe();
  const managedCredentialStore = new SqlCredentialStore(sql, managedCredentialCipher);
  const capSpecs = createSpecRegistry(builtinSpecs);
  const managedCredentialResolver = new ManagedCredentialResolver({
    credentials: managedCredentialStore,
    vaults: new SqlVaultStore(sql),
    fetch: (request, init) => fetch(request, init),
    clock: { now: () => new Date() },
    log: { warn: (fields, message) => logger.warn(fields, message) },
    ...(platformRootSecret ? { placeholders: createVaultPlaceholders(platformRootSecret) } : {}),
  }, capSpecs);
  const managedCredentialEgressRoutes = buildCredentialEgressRoutes(() => {
    if (!platformRootSecret) throw new Error("Credential relay is not configured");
    return createCredentialEgressRelay({
      credentials: repositoryEgress.relayCredentials(managedCredentialResolver),
      authenticate: authorization => authenticateSandboxEgress(managedAcpCapabilities.tokens, authorization),
      send: sendDirectHttps,
      log: { warn: (fields, message) => logger.warn(fields, message) },
    });
  });
  // One managed platform graph per process. Every official application
  // module is installed on the same workspace App, so a workspace has one
  // App, one clock, one id generator and one set of stores. `modules` runs on
  // the first `.app()` call for a workspace, after this assembly has finished,
  // which is why it may reference values declared below it.
  const managedPlatform = createNodePlatform({
    features: {
      preset: "none",
      agents: true,
      credentials: true,
      deploymentRuns: true,
      deployments: true,
      dreams: true,
      environmentWork: true,
      environments: true,
      files: true,
      memories: true,
      memoryStores: true,
      skillVersions: true,
      skills: true,
      tunnelCertificates: true,
      tunnels: true,
      userProfiles: true,
      vaults: true,
    },
    stores: {
      agents: managedAgentsPersistence,
      credentials: managedCredentialStore,
      deploymentRuns: new SqlDeploymentRunStore(sql),
      deployments: new SqlDeploymentStore(sql, managedDeploymentCipher),
      dreams: new SqlDreamStore(sql),
      environmentWork: managedEnvironmentWorkStore,
      environments: new SqlEnvironmentPersistence(sql),
      files: new SqlFileStore(sql),
      memories: new SqlMemoryDocumentStore(sql),
      memoryStores: new SqlMemoryStoreStore(sql),
      skills: new SqlSkillStore(sql),
      tunnels: new SqlTunnelStore(sql),
      userProfiles: new SqlUserProfileStore(sql),
      vaults: new SqlVaultStore(sql),
      ...components.stores,
    },
    fileContent: () => new BlobFileContentStore(filesBlob),
    credentialValidation: managedCredentialValidation,
    clock: { now: () => new Date() },
    ids: createManagedIdGenerator(),
    modules: (scope) => {
      const memoryStoreSource = new SqlMemoryStoreSource(sql);
      return [
        providePort(userProfileEnrollmentIssuerPort, {
          issue: async () => ({
            type: "conflict" as const,
            message: "User Profile enrollment is unavailable in self-hosted mode",
          }),
        }),
        providePort(environmentWorkEnvironmentSourcePort, nodeManagedEnvironments),
        providePort(
          environmentWorkAvailabilityWaiterPort,
          managedEnvironmentWorkAvailability,
        ),
        providePort(
          environmentWorkSessionCredentialIssuerPort,
          managedEnvironmentWorkCredentials,
        ),
        providePort(environmentWorkWakeupPort, {
          notifyRunStarted: async (input) => {
            if (managedEnvironmentWebhook === null) return;
            void managedEnvironmentWebhook.notifyRunStarted(input).catch((err) => {
              logger.error(
                { err, op: "main-node.environment_work.webhook_failed" },
                "Managed Agents webhook wake-up failed; poll fallback remains active",
              );
            });
          },
        }),
        environmentWorkEnqueuerModule(),
        providePort(deploymentAgentSourcePort, new SqlDeploymentAgentSource(sql)),
        providePort(deploymentEnvironmentSourcePort, nodeManagedEnvironments),
        providePort(deploymentFileSourcePort, new SqlFileMetadataPersistence(sql)),
        providePort(deploymentMemoryStoreSourcePort, memoryStoreSource),
        providePort(deploymentSchedulePlannerPort, managedDeploymentSchedulePlanner),
        providePort(
          deploymentSessionLauncherPort,
          managedSessionsComposition.portsFor(scope.workspaceId)
            .deploymentSessionLauncher,
        ),
        providePort(deploymentVaultSourcePort, new SqlDeploymentVaultSource(sql)),
        providePort(dreamMemoryStoreSourcePort, memoryStoreSource),
        providePort(memoryStoreForMemorySourcePort, memoryStoreSource),
        providePort(memoryContentDescriptorPort, managedMemoryContent),
        providePort(memoryVersionActorPort, {
          kind: "service_account",
          serviceAccountId: "dream_executor",
        }),
        providePort(dreamSessionSourcePort, new SqlSessionSource(sql)),
        providePort(dreamCuratorPort, managedDreamCurator),
        defineAppModule({
          name: "managed-agents:dream-memory-workspace",
          provides: [dreamMemoryWorkspacePort],
          requires: [
            managedAgentsPortTokens.memoryStores,
            managedAgentsPortTokens.memories,
          ],
          setup: ({ port }) => ({
            ports: [bindPort(
              dreamMemoryWorkspacePort,
              new ApplicationDreamMemoryWorkspace({
                workspaceId: scope.workspaceId,
                memoryStores: port(managedAgentsPortTokens.memoryStores),
                memories: port(managedAgentsPortTokens.memories),
              }),
            )],
          }),
        }),
        dreamExecutionModule(),
        inProcessDreamExecutionSchedulerModule({
          defer: (task) => {
            void task;
          },
        }),
        providePort(tunnelProvisionerPort, managedTunnelProvisioner),
        providePort(tunnelTokenManagerPort, managedTunnelTokens),
        providePort(tunnelCertificateAuthorityPort, managedTunnelCertificates),
        providePort(skillPackageCompilerPort, managedSkillCompiler),
      ];
    },
  });
  disposables.add("managed_platform", () => managedPlatform.stopAll());
  const managedVaultsRoutes = buildManagedVaultRoutes((context) =>
    managedPlatform
      .app({ workspaceId: (context.var as { tenant_id: string }).tenant_id })
      .port(managedAgentsPortTokens.vaults),
  );
  const managedCredentialsRoutes = buildManagedCredentialRoutes((context) =>
    managedPlatform
      .app({ workspaceId: (context.var as { tenant_id: string }).tenant_id })
      .port(managedAgentsPortTokens.credentials),
  );

  // OpenMA extension: OAuth device flow that ends in a managed cap_cli credential.
  const managedCapCliFlowCipher = secrets === null
    ? null
    : secrets.cipherFor("managed.vault.cap_cli_device_flow");
  const capCliDeviceFlow = createBuiltinCapDeviceFlow({
    fetch: (input, init) => globalThis.fetch(input, init),
  });
  const managedCapCliDeviceFlowRoutes = buildCapCliDeviceFlowRoutes((context) => {
    if (managedCapCliFlowCipher === null) {
      throw new Error("PLATFORM_ROOT_SECRET is required for managed Vault credentials");
    }
    const workspaceId = (context.var as { tenant_id: string }).tenant_id;
    return new CapCliDeviceFlowApplicationService({
      workspaceId,
      credentials: managedPlatform
        .app({ workspaceId })
        .port(managedAgentsPortTokens.credentials),
      deviceFlow: capCliDeviceFlow,
      cipher: managedCapCliFlowCipher,
      clock: { now: () => new Date() },
    });
  });

  // OpenMA extension: browser MCP OAuth that ends in a managed mcp_oauth credential.
  const managedMcpOAuthStateCipher = secrets === null
    ? null
    : secrets.cipherFor("managed.vault.mcp_oauth_state");
  const mcpOAuth = new HttpMcpOAuth({
    fetch: (input, init) => globalThis.fetch(input, init),
    clock: { now: () => new Date() },
    presets: config.mcpOAuthPresets,
    log: { warn: (fields, message) => logger.warn(fields, message) },
  });
  const managedMcpOAuthFor = (workspaceId: string) => {
    if (managedMcpOAuthStateCipher === null) {
      throw new Error("PLATFORM_ROOT_SECRET is required for managed Vault credentials");
    }
    return new McpOAuthApplicationService({
      workspaceId,
      credentials: managedPlatform
        .app({ workspaceId })
        .port(managedAgentsPortTokens.credentials),
      oauth: mcpOAuth,
      pkce: webCryptoMcpOAuthPkce,
      cipher: managedMcpOAuthStateCipher,
      clock: { now: () => new Date() },
      log: { warn: (fields, message) => logger.warn(fields, message) },
    });
  };
  const managedMcpOAuthRoutes = buildMcpOAuthRoutes((context) => managedMcpOAuthFor((context.var as { tenant_id: string }).tenant_id), { consoleOrigins: config.http.consoleOrigins });
  const managedMcpOAuthCli = () => {
    if (!secrets) throw new Error("PLATFORM_ROOT_SECRET is required for MCP OAuth");
    return new McpOAuthCliService({
      store: new SqlMcpOAuthCliStore(sql, { now: () => new Date() }),
      application: managedMcpOAuthFor,
      cipher: secrets.cipherFor("managed.vault.mcp_oauth_cli"),
      secrets: webCryptoMcpOAuthCliSecrets,
      clock: { now: () => new Date() },
    });
  };
  const managedMcpOAuthCliRoutes = buildMcpOAuthCliRoutes(managedMcpOAuthCli, webCryptoMcpOAuthCliSecrets);
  const managedMcpOAuthCliCallback = buildMcpOAuthCliCallback(managedMcpOAuthCli);

  const managedUserProfilesRoutes = buildManagedUserProfileRoutes((context) =>
    managedPlatform
      .app({ workspaceId: (context.var as { tenant_id: string }).tenant_id })
      .port(managedAgentsPortTokens.userProfiles),
  );

  return {
    managedCredentialEgressRoutes,
    mcpProxyPorts,
    inferenceProxyPorts,
    managedAcpCapabilities,
    managedRuntimeRunner,
    managedRuntimeReaders,
    managedSessionExecutionWorker,
    managedSessionExecutionCoordinator,
    managedSessionRealtime,
    managedSessionRuntimeStream,
    nodeSessionLifecycleHooks,
    managedSessionsComposition,
    managedEnvironmentWorkSessionTokenCrypto,
    managedEnvironmentWorkStore,
    sessionSandboxes,
    managedDeploymentsRoutes,
    managedDeploymentRunsRoutes,
    managedEnvironmentsRoutes,
    managedEnvironmentWorkRoutes,
    managedDreamsRoutes,
    managedModelsRoutes,
    managedTunnelsRoutes,
    managedTunnelCertificateRoutes,
    managedFilesRoutes,
    managedMemoryStoresRoutes,
    managedMemoriesRoutes,
    managedMemoryVersionsRoutes,
    managedSkillsRoutes,
    managedSkillVersionsRoutes,
    managedPlatform,
    managedVaultsRoutes,
    managedCredentialsRoutes,
    managedCapCliDeviceFlowRoutes,
    managedMcpOAuthRoutes,
    managedMcpOAuthCliRoutes,
    managedMcpOAuthCliCallback,
    managedUserProfilesRoutes,
  };
}
