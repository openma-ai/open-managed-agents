/**
 * Combine the foundation and official Managed Sessions stages, then assemble
 * the legacy route-service bundle and API-key storage. HTTP mounting and
 * lifecycle ownership belong to node-http.ts and node-assembly.ts.
 */
import { createManagedNodeRuntime } from "./node-managed.js";
import { createNodeFoundation } from "./node-foundation.js";

import { type Logger } from "@open-managed-agents/observability";

import type { SessionEvent } from "@open-managed-agents/shared";

import { type RouteServices, type ApiKeyStorage, type ApiKeyMeta, type ApiKeyRecord } from "@open-managed-agents/http-routes";

import { SqlKvStore } from "@open-managed-agents/kv-store/adapters/sql";

import { Disposables } from "../lifecycle.js";
import type { NodeComponents } from "../components.js";

export async function createNodeRuntime(
  components: NodeComponents,
  disposables: Disposables,
  log: { current: Logger | null },
) {
  const foundation = await createNodeFoundation(components, disposables, log);
  const {
    config,
    processMode,
    ownsLongLivedProcesses,
    logger,
    metrics,
    tracer,
    sql,
    dialect,
    drizzleDb,
    backendDescription,
    platformRootSecret,
    secrets,
    openAIAgentsSecrets,
    authDisabled,
    auth,
    agentStore,
    vaultService,
    credentialService,
    sessionsService,
    filesService,
    evalsService,
    environmentsService,
    modelCardsService,
    memoryBlobDescription,
    memoryService,
    dreamsService,
    outputsRoot,
    sessionOutputs,
    filesBlob,
    filesBlobDescription,
    newEventLog,
    hub,
    realtimeDescription,
    sessionRegistry,
  } = foundation;
  const { sharedSessionOutputs } = foundation;

  const managed = await createManagedNodeRuntime(foundation, components, disposables);
  const {
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
    managedUserProfilesRoutes,
  } = managed;

  // ─── Services bundle ────────────────────────────────────────────────────

  const kv = new SqlKvStore({ db: drizzleDb, tenantId: "default" });

  const services: RouteServices = {
    sql,
    agents: agentStore,
    vaults: vaultService,
    credentials: credentialService,
    memory: memoryService,
    sessions: sessionsService,
    dreams: dreamsService,
    kv,
    newEventLog,
    hub: {
      publish: (sid, ev) => hub.publish(sid, ev as SessionEvent),
      attach: (sid, writer) => hub.attach(sid, writer),
    },
    sessionRegistry: {
      enqueueUserMessage: (sid, tenantId, agentId, ev) => {
        void sessionRegistry
          .getOrCreate(sid, tenantId)
          .then((entry) =>
            entry.machine.runHarnessTurn(agentId, ev as import("@open-managed-agents/shared").UserMessageEvent),
          )
          .catch((err) => {
            logger.error(
              { err, op: "session.harness_turn.failed", session_id: sid, agent_id: agentId },
              "harness turn failed",
            );
            void newEventLog(sid).appendAsync({
              type: "session.error",
              error: "harness_turn_failed",
              message: err instanceof Error ? err.message : String(err),
            } as unknown as SessionEvent);
          });
      },
      interrupt: (sid) => {
        sessionRegistry.interrupt?.(sid);
      },
    },
    background: {
      run: (p) => {
        void p.catch((err) =>
          logger.error({ err, op: "main-node.background.failed" }, "background task failed"),
        );
      },
    },
    outputsRoot,
    logger,
    metrics,
    tracer,
  };

  // ─── API key storage (SQL) ──────────────────────────────────────────────

  const apiKeyStorage: ApiKeyStorage = {
    async insert({ id, hash, prefix, record }) {
      await sql
        .prepare(
          `INSERT INTO api_keys (
             id, tenant_id, user_id, name, prefix, hash,
             credential_type, environment_id, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          record.tenant_id,
          record.user_id ?? null,
          record.name,
          prefix,
          hash,
          record.credential?.type ?? "workspace",
          record.credential?.type === "environment"
            ? record.credential.environmentId
            : null,
          Date.parse(record.created_at),
        )
        .run();
    },
    async listByTenant(tenantId) {
      const r = await sql
        .prepare(
          `SELECT id, name, prefix, credential_type, environment_id, created_at FROM api_keys
            WHERE tenant_id = ? AND revoked_at IS NULL
            ORDER BY created_at DESC`,
        )
        .bind(tenantId)
        .all<{
          id: string;
          name: string;
          prefix: string;
          credential_type: string;
          environment_id: string | null;
          created_at: number;
        }>();
      return (r.results ?? []).map<ApiKeyMeta>((row) => ({
        id: row.id,
        name: row.name,
        prefix: row.prefix,
        created_at: new Date(row.created_at).toISOString(),
        credential: row.credential_type === "environment" && row.environment_id !== null
          ? { type: "environment", environmentId: row.environment_id }
          : { type: "workspace" },
      }));
    },
    async findByHash(hash) {
      const row = await sql
        .prepare(
          `SELECT id, tenant_id, user_id, name, credential_type, environment_id, created_at FROM api_keys
            WHERE hash = ? AND revoked_at IS NULL`,
        )
        .bind(hash)
        .first<{
          id: string;
          tenant_id: string;
          user_id: string | null;
          name: string;
          credential_type: string;
          environment_id: string | null;
          created_at: number;
        }>();
      if (!row) return null;
      const rec: ApiKeyRecord = {
        id: row.id,
        tenant_id: row.tenant_id,
        ...(row.user_id ? { user_id: row.user_id } : {}),
        name: row.name,
        created_at: new Date(row.created_at).toISOString(),
        credential: row.credential_type === "environment" && row.environment_id !== null
          ? { type: "environment", environmentId: row.environment_id }
          : { type: "workspace" },
      };
      return rec;
    },
    async deleteById(tenantId, id) {
      const r = await sql
        .prepare(
          `UPDATE api_keys SET revoked_at = ? WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL`,
        )
        .bind(Date.now(), tenantId, id)
        .run();
      return (r.meta?.changes ?? 0) > 0;
    },
  };

  return {
    config,
    processMode,
    ownsLongLivedProcesses,
    logger,
    metrics,
    tracer,
    sql,
    dialect,
    drizzleDb,
    backendDescription,
    platformRootSecret,
    secrets,
    openAIAgentsSecrets,
    authDisabled,
    auth,
    agentStore,
    vaultService,
    credentialService,
    sessionsService,
    filesService,
    evalsService,
    environmentsService,
    modelCardsService,
    memoryBlobDescription,
    memoryService,
    outputsRoot,
    sessionOutputs,
    sharedSessionOutputs,
    filesBlob,
    filesBlobDescription,
    newEventLog,
    hub,
    realtimeDescription,
    sessionRegistry,
    resolveDreamModelCredentials: foundation.resolveDreamModelCredentials,
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
    managedUserProfilesRoutes,
    kv,
    services,
    apiKeyStorage,
  };
}

export type NodeRuntime = Awaited<ReturnType<typeof createNodeRuntime>>;
