
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
import { createPreparedSandboxBases } from "../lib/prepared-sandbox-bases";
import { SqlKvStore } from "@open-managed-agents/kv-store/adapters/sql";
import { EMPTY_SANDBOX_IMAGE_CATALOG } from "@open-managed-agents/sandbox";
import { injectVaultEnvironment, vaultEnvironmentVariables } from "../lib/vault-environment";
import { resolveSessionSandboxMode, readManagedSessionMappingMetadata } from "@open-managed-agents/openai-agents-compat";
import { SqlSessionThreadStore } from "@open-managed-agents/session-thread-store-sql";
import { buildOpenAISubagentTools, nodeOpenAISubagentPolicy, openAISubagentSession } from "../openai-subagents.js";

import { createNodeOpenAIArtifactPublisher, withReportedArtifactPublication } from "../openai-artifact-publication.js";

import { buildTools, disposeTools } from "@open-managed-agents/agent/harness/tools";

import { generateText } from "ai";
import { composeSystemPrompt } from "@open-managed-agents/agent/harness/platform-guidance";
import { agentUsesAssemblySkillMount } from "@open-managed-agents/agent/harness/assembly/skill-config";
import type { HarnessContext } from "@open-managed-agents/agent/harness/interface";

import { createBuiltinCapDeviceFlow } from "@open-managed-agents/oma-cap-adapter";
import { buildMcpOAuthCliRoutes, buildMcpOAuthCliCallback, buildCapCliDeviceFlowRoutes, buildMcpOAuthRoutes, buildCredentialRoutes as buildManagedCredentialRoutes, buildDeploymentRoutes as buildManagedDeploymentRoutes, buildDeploymentRunRoutes as buildManagedDeploymentRunRoutes, buildDreamRoutes as buildManagedDreamRoutes, buildEnvironmentRoutes as buildManagedEnvironmentRoutes, buildEnvironmentWorkRoutes as buildManagedEnvironmentWorkRoutes, buildFileRoutes as buildManagedFileRoutes, buildMemoryStoreRoutes as buildManagedMemoryStoreRoutes, buildMemoryRoutes as buildManagedMemoryRoutes, buildMemoryVersionRoutes as buildManagedMemoryVersionRoutes, buildModelRoutes as buildManagedModelRoutes, buildSkillRoutes as buildManagedSkillRoutes, buildSkillVersionRoutes as buildManagedSkillVersionRoutes, buildTunnelCertificateRoutes as buildManagedTunnelCertificateRoutes, buildTunnelRoutes as buildManagedTunnelRoutes, buildVaultRoutes as buildManagedVaultRoutes, buildUserProfileRoutes as buildManagedUserProfileRoutes } from "@open-managed-agents/managed-agents-api";
import { McpOAuthCliService, CapCliDeviceFlowApplicationService, McpOAuthApplicationService, SessionRuntimeHistoryApplicationService, SessionRuntimeProjectionApplicationService, type MemoriesApplicationPort, type Session, type SessionEnvironmentSourcePort } from "@open-managed-agents/managed-agents-application";
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
import { SqlMcpOAuthCliStore, SqlDeploymentAgentSource, SqlDeploymentVaultSource, SqlEnvironmentPersistence, SqlFileMetadataPersistence, SqlMemoryStoreSource, SqlManagedSessionsComposition, SqlPersistedSessionEventStream, SqlReplicatedSessionEventStream, SqlSessionEnvironmentSource, SqlSessionSource, SqlSessionRuntimeProjectionPersistence } from "@open-managed-agents/managed-agents-adapters-sql";
import { createSqlSessionRuntimeReaders, ensureSessionExecutionClaimLockSchema, SqlSessionExecutionCoordinator } from "@open-managed-agents/session-runtime-sql";
import { MemorySessionRealtimeHub } from "@open-managed-agents/session-realtime-memory";
import { encodeRuntimeSessionEvent, AnthropicMessagesDreamCurator, ApplicationDreamMemoryWorkspace, ModelCardCatalogSource, CronDeploymentSchedulePlanner, EnvironmentAwareSessionEventDispatchRouter, EnvironmentAwareSessionEventStreamRouter, EnvironmentAwareSessionLifecycleRouter, TimerEnvironmentWorkAvailabilityWaiter, McpOAuthCredentialValidationProbe, inProcessDreamExecutionSchedulerModule, LocalTunnelProvisioner, SealedEnvironmentWorkSessionCredentialIssuer, StandardWebhookEnvironmentWorkWakeup, DeduplicatingDreamCurator, WebCryptoTunnelCertificateAuthority, WebCryptoTunnelTokenManager, WebCryptoMemoryContentDescriptor, ZipSkillPackageCompiler, synchronizeManagedSessionMemoryWorkspaces } from "@open-managed-agents/managed-agents-adapters-runtime";

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

import { readHarnessAgentModelSettings } from "@open-managed-agents/agent/harness/agent-model-settings";
import { createPiModelRuntime } from "@open-managed-agents/agent/harness/pi-provider";
import { resolveHarness } from "@open-managed-agents/agent/harness/registry";
import { allowAllLegacyHarnessTools, toLegacyHarnessAgentConfig, toLegacyHarnessEnvironmentConfig, resolveNodeManagedAuxiliaryToolModel } from "../lib/node-managed-agent-codec.js";
import { NodeManagedConfirmedToolExecutor } from "../lib/node-managed-confirmed-tool-executor.js";
import { NodeManagedOutcomeEvaluator } from "../lib/node-managed-outcome-evaluator.js";
import { ManagedCredentialResolver } from "@open-managed-agents/managed-credential-resolver";
import { HttpMcpOAuth, webCryptoMcpOAuthPkce, webCryptoMcpOAuthCliSecrets } from "@open-managed-agents/managed-agents-adapters-http";
import { builtinSpecs, createSpecRegistry } from "@open-managed-agents/cap";
import { applySandboxEgress, startSandboxEgressProxy, type SandboxEgress } from "../lib/sandbox-egress/index.js";
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
import { synchronizeNodeManagedMemoryStores } from "../lib/node-managed-memory-stores.js";
import { NodeSessionExecutionWorker } from "../lib/node-session-execution-worker.js";
import { createNodeMcpProxyBinding, type NodeMcpProxyTarget } from "../lib/http-mcp-proxy.js";
import { createNodeAccessLossRuntime } from "../lib/mcp-access-loss.js";

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

  async function resolveNodeMcpProxyTarget(input: {
    tenantId: string;
    sessionId: string;
    serverName: string;
    agentId?: string;
    agentVersion?: number;
  }): Promise<NodeMcpProxyTarget | null> {
    const managedContext = await managedRuntimeReaders.executionContext.find({
      workspaceId: input.tenantId,
      sessionId: input.sessionId,
    });
    if (managedContext !== null) {
      const root = managedContext.session.agent;
      const selected = input.agentId === undefined || (input.agentId === root.id && input.agentVersion === root.version)
        ? root
        : root.multiagent?.subagents.type === "enabled"
          ? root.multiagent.subagents.predefinedAgents.find(member => member.type === "agent" && member.id === input.agentId && member.version === input.agentVersion)
          : undefined;
      if (!selected || !("mcpServers" in selected)) return null;
      const server = selected.mcpServers.find(
        (candidate) => candidate.name === input.serverName,
      );
      if (server === undefined || server.type !== "url") return null;
      const target = await managedCredentialResolver.mcpTarget({
        workspaceId: input.tenantId,
        sessionId: input.sessionId,
        vaultIds: managedContext.session.vaultIds,
      }, server.url);
      if (target === null) return null;
      return {
        upstreamUrl: target.upstreamUrl,
        accessToken: target.upstreamToken,
        managed: {
          forward: (send) => managedCredentialResolver.forward(input.tenantId, target, send),
        },
      };
    }

    const session = await sessionsService.get({
      tenantId: input.tenantId,
      sessionId: input.sessionId,
    }).catch(() => null);
    if (session === null || session.archived_at) return null;
    const snapshot = session.agent_snapshot as import("@open-managed-agents/api-types").RuntimeAgentConfig | undefined;
    const selected = input.agentId === undefined || (snapshot?.id === input.agentId && snapshot.version === input.agentVersion)
      ? snapshot
      : snapshot?.multiagent?.subagents.type === "enabled"
        ? snapshot.multiagent.subagents.predefined_agents.find(member => member.id === input.agentId && member.version === input.agentVersion)
        : undefined;
    const server = selected?.mcp_servers?.find(candidate => candidate.name === input.serverName);
    if (server === undefined || !("url" in server) || !server.url) return null;
    if (server.authorization_token) {
      return {
        upstreamUrl: server.url,
        accessToken: server.authorization_token,
      };
    }
    const vaultIds = session.vault_ids ?? [];
    if (vaultIds.length === 0) return null;
    const groups = await credentialService.listByVaults({
      tenantId: input.tenantId,
      vaultIds,
    });
    for (const group of groups) {
      for (const credential of group.credentials) {
        if (credential.archived_at !== null) continue;
        const auth = credential.auth as {
          type?: string;
          mcp_server_url?: string;
          bearer_token?: string;
          token?: string;
          access_token?: string;
          refresh_token?: string;
          token_endpoint?: string;
          client_id?: string;
          client_secret?: string;
        };
        if (auth.mcp_server_url !== server.url) continue;
        const accessToken = auth.bearer_token ?? auth.token ?? auth.access_token;
        if (!accessToken) continue;
        const target: NodeMcpProxyTarget = {
          upstreamUrl: server.url,
          accessToken,
        };
        if (auth.type === "mcp_oauth" && auth.refresh_token && auth.token_endpoint) {
          target.refresh = {
            refreshToken: auth.refresh_token,
            tokenEndpoint: auth.token_endpoint,
            clientId: auth.client_id,
            clientSecret: auth.client_secret,
          };
          target.onRefreshed = async (tokens) => {
            await credentialService.refreshAuth({
              tenantId: input.tenantId,
              vaultId: group.vault_id,
              credentialId: credential.id,
              auth: {
                access_token: tokens.access_token,
                refresh_token: tokens.refresh_token,
              },
            });
          };
        }
        return target;
      }
    }
    return null;
  }

  async function resolveNodeInferenceUpstream(input: {
    tenantId: string;
    sessionId: string;
  }): Promise<import("../lib/http-inference-proxy.js").NodeInferenceUpstream | null> {
    const managedContext = await managedRuntimeReaders.executionContext.find({
      workspaceId: input.tenantId,
      sessionId: input.sessionId,
    });
    const agentModel = managedContext?.session.agent.model
      ?? (await sessionsService.get({
        tenantId: input.tenantId,
        sessionId: input.sessionId,
      }).catch(() => null))?.agent_snapshot?.model;
    if (!agentModel || managedContext?.session.archivedAt) return null;
    try {
      // Hosted sandboxes must never fall back to a platform environment key.
      return await resolveHostedModel(input.tenantId, agentModel);
    } catch {
      return null;
    }
  }

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
      protocolEndpoints: resolveProtocolEndpointsFromModelCard({ providerId: card.provider, baseUrl: card.base_url }),
    };
  }

  const nodeMcpProxyBinding = createNodeMcpProxyBinding({
    resolveTarget: resolveNodeMcpProxyTarget,
    accessLoss: await createNodeAccessLossRuntime(sql),
  });

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

  if (config.workspace.strategy === "checkpoint_restore") {
    await ensureSessionExecutionClaimLockSchema(sql, foundation.dialect);
  }
  const managedSessionExecutionCoordinator = new SqlSessionExecutionCoordinator(sql, {
    serializeSessionClaims: config.workspace.strategy === "checkpoint_restore",
    sweepIntervalMs: 5_000,
    onError: (error, op) => logger.error(
      { err: error, op },
      "session execution sweep failed",
    ),
  });

  async function isManagedSessionExecutionFenceActive(fence: {
    workspaceId: string;
    sessionId: string;
    executionId: string;
    attemptId: string;
    ownerId: string;
    generation: number;
    expiresAt: string;
  }): Promise<boolean> {
    if (Date.parse(fence.expiresAt) <= Date.now()) return false;
    const execution = await managedSessionExecutionCoordinator.find({
      workspaceId: fence.workspaceId,
      executionId: fence.executionId,
    });
    return execution?.state === "running"
      && execution.sessionId === fence.sessionId
      && execution.attempt?.id === fence.attemptId
      && execution.attempt.ownerId === fence.ownerId
      && execution.attempt.generation === fence.generation
      && Date.parse(execution.attempt.leaseExpiresAt) > Date.now();
  }

  const managedAcpCapabilities = createNodeManagedAcpCapabilities({
    crypto: secrets?.cipherFor("managed.node-acp.execution-token") ?? null,
    gatewayBaseUrl: config.http.publicBaseUrl,
    now: () => new Date(),
    findExecution: input => managedSessionExecutionCoordinator.find(input),
    findSession: async input => (await managedRuntimeReaders.executionContext.find(input))?.session ?? null,
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
  const preparedSandboxBases = createPreparedSandboxBases(config.sandbox, components.sandbox, {
    kvFor: (workspaceId) => new SqlKvStore({ db: foundation.drizzleDb, tenantId: workspaceId }),
    createBuilderSandbox: (sessionId, scope) =>
      foundation.buildPreparedBaseSandbox(sessionId, join(config.paths.sandboxWorkdir, sessionId), scope),
    logger,
  });
  if (preparedSandboxBases !== undefined) {
    disposables.add("prepared_sandbox_bases", () => preparedSandboxBases.dispose());
  }

  async function synchronizeNativeMemoryMounts(
    workspaceId: string,
    session: Session,
    runtimeGeneration: string,
    executionFence: Parameters<typeof isManagedSessionExecutionFenceActive>[0],
    memories: MemoriesApplicationPort,
  ): Promise<void> {
    const result = await synchronizeManagedSessionMemoryWorkspaces(
      { find: async () => session },
      memories,
      {
        getText: async (key) => (await memoryBlobs.getText(key))?.text ?? null,
        list: (prefix, cursor) => memoryBlobs.list(prefix, cursor),
        put: (key, content) => memoryBlobs.put(key, content),
        delete: (key) => memoryBlobs.delete(key),
      },
      {
        workspaceId,
        sessionId: session.id,
        runtimeGeneration,
        executionFence,
        isFenceActive: isManagedSessionExecutionFenceActive,
      },
    );
    if (result.type === "fence_lost") {
      throw new Error(
        `Managed Memory synchronization lost the execution fence for ${session.id}`,
      );
    }
    if (result.type === "not_found") {
      throw new Error(`Managed Session ${session.id} disappeared before Memory synchronization`);
    }
    if (result.recoveredWipes.length > 0) {
      throw new Error(
        `Writable Managed Memory workspace became distrusted: ${result.recoveredWipes.join(", ")}`,
      );
    }
    if (result.conflicts.length > 0) {
      logger.warn({
        conflicts: result.conflicts,
        op: "main-node.managed_memory.conflicts",
        sessionId: session.id,
        workspaceId,
      }, "Managed Memory synchronization kept canonical winners for conflicts");
    }
  }

  // One decision for the deployment: native mounts only when the composed
  // factory declares them; every other sandbox file-syncs Memory Stores.
  const memoryStoreMode = nodeManagedMemoryStoreModeName(components.sandbox);

  const managedRuntimeRunner = new DefaultNodeManagedSessionRunner({
    ...(workspaceCheckpoints === undefined ? {} : { workspaceCheckpoints }),
    ...(config.workspace.sandboxLeaseTtlMs === undefined
      ? {}
      : { sandboxLease: { ttlMs: config.workspace.sandboxLeaseTtlMs } }),
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
        });
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
    }),
    sandboxMode: ({ session }) => resolveSessionSandboxMode(session, openAIAgentsSecrets),
    buildSandbox: createManagedSandboxBuilder({
      images: config.sandbox.images,
      workdir: (sessionId) => join(config.paths.sandboxWorkdir, sessionId),
      build: buildSandbox,
      ...(preparedSandboxBases === undefined ? {} : { preparedBases: preparedSandboxBases }),
    }),
    ...(sharedSessionOutputs === undefined ? {} : {
      isSandboxCurrent: ({ workspaceId, session, runtimeGeneration }: { workspaceId: string; session: { id: string }; runtimeGeneration: string }) =>
        sharedSessionOutputs.isSandboxCurrent(workspaceId, session.id, runtimeGeneration),
    }),
    prepareSandbox: async ({
      workspaceId,
      session,
      environment,
      sandbox,
      runtimeGeneration,
      signal,
      executionFence,
    }) => {
      const memories = managedMemoriesApplicationForWorkspace(workspaceId)
        .port(managedAgentsPortTokens.memories);
      const preparer = new NodeManagedSessionInputPreparer({
        sharedOutputs: sharedSessionOutputs !== undefined,
        files: managedPlatform
          .app({ workspaceId })
          .port(managedAgentsPortTokens.files),
        skillVersions: managedPlatform
          .app({ workspaceId })
          .port(managedAgentsPortTokens.skillVersions),
        repositoryCredentials: managedSessionResourceSecrets,
        ...(config.http.matter === undefined
          ? {}
          : { repositoryBonds: matterRepositoryCredentials(config.http.matter) }),
        memoryStores: memoryStoreMode === "native"
          ? {
              mode: "native",
              snapshots: new NodeManagedMemorySnapshotMaterializer(memories, {
                getText: async (key) => (await memoryBlobs.getText(key))?.text ?? null,
                put: (key, content) => memoryBlobs.put(key, content),
              }),
            }
          : { mode: "file_sync", memories },
      });
      // Shared outputs are not a live mount: hydrate canonical files into a
      // fresh sandbox before inputs are staged, so input mounts under the
      // outputs directory win and the next turn can read prior outputs.
      await sharedSessionOutputs?.restoreToSandbox(workspaceId, session.id, sandbox, runtimeGeneration);
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
      // Vault `environment_variable` credentials, for the commands the Agent runs.
      // Whole-brain ACP receives only scoped service capabilities. Raw Vault
      // environment credentials belong to the host path, never this sandbox.
      const injected = session.agent.openma?.harness === "acp-sandbox" ? [] : await injectVaultEnvironment(
        sandbox,
        await vaultEnvironmentVariables(managedCredentialStore, workspaceId, session.vaultIds),
      );
      if (injected.length > 0) {
        logger.info({
          op: "main-node.vault_environment",
          sessionId: session.id,
          workspaceId,
          names: injected,
        }, "Vault environment variables set");
      }
      await preparer.prepare({
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
    // Cold preparation calls this last (after repository clones); warm reuse
    // calls it again to renew the pass and honor the current Vault bindings.
    refreshSandboxEnvironment: async ({ workspaceId, session, sandbox }) => {
      await applySandboxEgress({
        sandbox,
        scope: { workspaceId, sessionId: session.id, vaultIds: session.vaultIds },
        placeholders: (scope) => managedCredentialResolver.placeholderEnvironment(scope),
        egress: sandboxEgress,
        log: logger,
      });
    },
    synchronizeSandbox: async ({
      workspaceId,
      session,
      sandbox,
      runtimeGeneration,
      executionFence,
    }) => {
      const memories = managedMemoriesApplicationForWorkspace(workspaceId)
        .port(managedAgentsPortTokens.memories);
      if (memoryStoreMode === "file_sync") {
        await synchronizeNodeManagedMemoryStores({
          session,
          sandbox,
          memories,
          authorize: () => isManagedSessionExecutionFenceActive(executionFence),
          // The turn barrier runs after the turn's own signal may have fired;
          // the fence, not cancellation, decides whether it may write.
          signal: new AbortController().signal,
        });
      } else {
        await synchronizeNativeMemoryMounts(workspaceId, session, runtimeGeneration, executionFence, memories);
      }
      await managedSessionOutputCollector.synchronize({
        workspaceId,
        sessionId: session.id,
        sandbox,
        executionFence,
        runtimeGeneration,
      });
    },
    afterExecution: withReportedArtifactPublication(createNodeOpenAIArtifactPublisher({
      historyForWorkspace: workspaceId => new SessionRuntimeHistoryApplicationService({ workspaceId, source: managedRuntimeReaders.history }),
      filesForWorkspace: workspaceId => managedPlatform.app({ workspaceId }).port(managedAgentsPortTokens.files),
      secrets: openAIAgentsSecrets,
      isFenceActive: isManagedSessionExecutionFenceActive,
      environmentId: session => `oai_env_${session.id}`,
    }), (error, input) => {
      logger.error({
        err: error,
        op: "main-node.openai_agents.artifact_publication_failed",
        workspaceId: input.workspaceId,
        sessionId: input.session.id,
        executionId: input.executionFence.executionId,
      }, "Completed Session output could not be published as an Agents API artifact");
    }),
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
        acpRecoveryHistory = await loadNodeManagedAcpRecoveryHistory({
          sql, history: managedRuntimeReaders.history,
          fence: input.executionFence!, acceptedEvents: input.acceptedEvents,
        });
        sandboxEnv = {
          ANTHROPIC_API_KEY: "",
          mcpProxy: capability,
          hostedInference: { ...capability, model: { providerId: model.provider, baseUrl: model.baseURL ?? null, protocolEndpoints: model.protocolEndpoints } },
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
        ...(assemblySkills ? [] : buildNodeManagedSkillReminders(input.session)),
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
  const managedRuntimeEngine = new ApplicationBackedNodeManagedSessionRuntimeEngine({
    historyFor: (workspaceId) =>
      new SessionRuntimeHistoryApplicationService({
        workspaceId,
        source: managedRuntimeReaders.history,
      }),
    runner: managedRuntimeRunner,
  });
  const managedRuntimeDriver = new DefaultNodeManagedSessionRuntimeDriver({
    engine: managedRuntimeEngine,
    realtime: new MemorySessionRealtimeHub(),
    projectionFor: (workspaceId) =>
      new SessionRuntimeProjectionApplicationService({
        workspaceId,
        persistence: new SqlSessionRuntimeProjectionPersistence(sql),
      }),
  });
  const managedSessionExecutionWorker = new NodeSessionExecutionWorker({
    coordinator: managedSessionExecutionCoordinator,
    context: managedRuntimeReaders.executionContext,
    runtime: {
      run: async ({ executionId: _executionId, fence, ...input }) => {
        await managedRuntimeDriver.accept({ ...input, executionFence: fence });
      },
      cancel: async (input) => {
        managedRuntimeDriver.cancel({ workspaceId: input.workspaceId, sessionId: input.sessionId, reason: input.reason });
        managedRuntimeRunner.cancel({ workspaceId: input.workspaceId, sessionId: input.sessionId, reason: input.reason });
      },
    },
    ownerId: config.execution.ownerId,
    clock: { now: () => new Date() },
    ids: { nextAttemptId: () => `attempt_${nanoid()}` },
    leaseTtlMs: 30_000,
    heartbeatIntervalMs: 10_000,
    maxConcurrent: config.execution.concurrency,
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
    runtime: managedSessionRuntime,
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
  const managedSessionsComposition = new SqlManagedSessionsComposition({
    client: sql,
    executionOutbox: true,
    environments: nodeManagedEnvironments,
    lifecycle: managedSessionLifecycle,
    runtime: managedSessionRuntime,
    eventDispatch: new EnvironmentAwareSessionEventDispatchRouter({
      runtime: managedSessionRuntime,
    }),
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

  const managedFilesRoutes = buildManagedFileRoutes((context) =>
    managedPlatform
      .app({
        workspaceId: (context.var as { tenant_id: string }).tenant_id,
      })
      .port(managedAgentsPortTokens.files)
  );

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
    fetch: (request, init) => fetch(request, init),
    clock: { now: () => new Date() },
    log: { warn: (fields, message) => logger.warn(fields, message) },
  }, capSpecs);
  // Sandbox egress proxy: injects the Session's Vault credentials into
  // sandbox HTTPS egress (best effort, public by default; docs/self-host.md).
  const egressProxyConfig = config.sandbox.egressProxy;
  let sandboxEgress: SandboxEgress;
  if (egressProxyConfig.type === "unavailable") {
    sandboxEgress = egressProxyConfig;
    logger.warn(
      { op: "main-node.sandbox_egress.unavailable", reason: egressProxyConfig.reason },
      `Sandbox egress proxy unavailable (${egressProxyConfig.reason}): Sessions whose Vaults hold CLI credentials will fail to start`,
    );
  } else {
    if (platformRootSecret === undefined) throw new Error("PLATFORM_ROOT_SECRET is required for the sandbox egress proxy");
    const started = await startSandboxEgressProxy(egressProxyConfig, platformRootSecret, {
      credentials: managedCredentialResolver,
      findSession: async (input) => {
        const session = (await managedRuntimeReaders.executionContext.find(input))?.session;
        return session === undefined ? null : { vaultIds: session.vaultIds, archived: session.archivedAt !== null };
      },
      claimsHost: (hostname) => capSpecs.byHostname(hostname) !== null,
      log: logger,
    });
    disposables.add("sandbox_egress_proxy", () => started.close());
    sandboxEgress = { type: "enabled", settings: started.settings };
    logger.info(
      { op: "main-node.sandbox_egress.listening", port: started.port, public_url: started.settings.publicUrl },
      "Sandbox egress proxy listening (public; pass required)",
    );
  }
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
    resolveNodeMcpProxyTarget,
    resolveNodeInferenceUpstream,
    managedAcpCapabilities,
    managedRuntimeRunner,
    managedRuntimeReaders,
    managedSessionExecutionWorker,
    managedSessionRuntimeStream,
    nodeSessionLifecycleHooks,
    managedSessionsComposition,
    managedEnvironmentWorkSessionTokenCrypto,
    managedEnvironmentWorkStore,
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
