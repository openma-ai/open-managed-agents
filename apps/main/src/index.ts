import { normalizeOpenAIAgentsErrorResponse } from '@open-managed-agents/openai-agents-api';
import { buildOpenAIAgentsProtocolApi, OpenAIAgentsProtocolError } from "@open-managed-agents/openai-agents-api";
import { createResourcesHandler, createArtifactsHandler, createSessionsHandler, createManagedSessionMapping, createSandboxOptionalSessionMapping, resolveSessionSandboxMode, createOpenAIArtifactPublisher, outputPathsFromManifest, readManagedSessionMappingMetadata } from "@open-managed-agents/openai-agents-compat";
import { CapCliDeviceFlowApplicationService, McpOAuthCliService, McpOAuthApplicationService, SessionRuntimeHistoryApplicationService } from "@open-managed-agents/managed-agents-application";
import { SqlSessionRuntimeHistorySource } from "@open-managed-agents/managed-agents-adapters-sql";
import { Hono } from "hono";
import type { Context } from "hono";
import { WorkerEntrypoint, env as workerEnv } from "cloudflare:workers";
import type { Env } from "@open-managed-agents/shared";
import {
  buildCfTenantDbProvider,
  servicesMiddleware,
  tenantDbMiddleware,
  getCfServicesForTenant,
} from "@open-managed-agents/services";
import {
  buildAgentRoutes as buildLegacyAgentRoutes,
  buildVaultRoutes as buildLegacyVaultRoutes,
  buildSessionRoutes,
  buildApiKeyRoutes,
  buildMeRoutes,
  buildTenantRoutes,
  mintApiKeyOnStorage,
  buildSandboxImageRoutes,
} from "@open-managed-agents/http-routes";
import {
  buildAgentRoutes as buildManagedAgentRoutes,
  buildCapCliDeviceFlowRoutes,
  buildMcpOAuthRoutes,
  buildMcpOAuthCliRoutes,
  buildMcpOAuthCliCallback,
  buildCredentialRoutes as buildManagedCredentialRoutes,
  buildDeploymentRoutes as buildManagedDeploymentRoutes,
  buildDeploymentRunRoutes as buildManagedDeploymentRunRoutes,
  buildDreamRoutes as buildManagedDreamRoutes,
  buildEnvironmentRoutes as buildManagedEnvironmentRoutes,
  buildEnvironmentWorkRoutes as buildManagedEnvironmentWorkRoutes,
  buildFileRoutes as buildManagedFileRoutes,
  buildMemoryStoreRoutes as buildManagedMemoryStoreRoutes,
  buildMemoryRoutes as buildManagedMemoryRoutes,
  buildMemoryVersionRoutes as buildManagedMemoryVersionRoutes,
  buildModelRoutes as buildManagedModelRoutes,
  buildSkillRoutes as buildManagedSkillRoutes,
  buildSkillVersionRoutes as buildManagedSkillVersionRoutes,
  buildTunnelCertificateRoutes as buildManagedTunnelCertificateRoutes,
  buildTunnelRoutes as buildManagedTunnelRoutes,
  buildVaultRoutes as buildManagedVaultRoutes,
  buildUserProfileRoutes as buildManagedUserProfileRoutes,
  buildManagedSessionsApi,
} from "@open-managed-agents/managed-agents-api";
import { buildCredentialEgressRoutes } from "@open-managed-agents/managed-agents-adapters-http";
import {
  SessionRuntimeProjectionApplicationService,
  type SessionEnvironmentSourcePort,
} from "@open-managed-agents/managed-agents-application";
import { bindPort, defineAppModule, providePort } from "@open-managed-agents/app";
import { managedAgentsPortTokens } from "@open-managed-agents/app/managed-agents";
import {
  deploymentAgentSourcePort,
  deploymentEnvironmentSourcePort,
  deploymentFileSourcePort,
  deploymentMemoryStoreSourcePort,
  deploymentSchedulePlannerPort,
  deploymentSessionLauncherPort,
  deploymentVaultSourcePort,
} from "@open-managed-agents/app/modules/deployments";
import {
  dreamCuratorPort,
  dreamExecutionModule,
  dreamMemoryStoreSourcePort,
  dreamMemoryWorkspacePort,
  dreamSessionSourcePort,
} from "@open-managed-agents/app/modules/dreams";
import {
  environmentSessionWorkEnqueuerPort,
  environmentWorkAvailabilityWaiterPort,
  environmentWorkEnqueuerModule,
  environmentWorkEnvironmentSourcePort,
  environmentWorkSessionCredentialIssuerPort,
  environmentWorkWakeupPort,
} from "@open-managed-agents/app/modules/environment-work";
import {
  memoryContentDescriptorPort,
  memoryStoreForMemorySourcePort,
  memoryVersionActorPort,
} from "@open-managed-agents/app/modules/memories";
import { modelCatalogSourcePort } from "@open-managed-agents/app/modules/models";
import {
  skillPackageCompilerPort,
} from "@open-managed-agents/app/modules/skills";
import {
  tunnelCertificateAuthorityPort,
  tunnelProvisionerPort,
  tunnelTokenManagerPort,
} from "@open-managed-agents/app/modules/tunnels";
import {
  userProfileEnrollmentIssuerPort,
} from "@open-managed-agents/app/modules/user-profiles";
import { resolveManagedSkillArchive } from "./lib/managed-skill-source";
import {
  downloadManagedSessionInputFile,
  materializeManagedSessionMemorySnapshot,
  resolveManagedSessionInputs,
  withMissingManagedSessionSchemaFallback,
} from "./lib/managed-session-runtime-source";
import {
  createCloudflareManagedAgentsApp,
} from "@open-managed-agents/platform-cloudflare";
import {
  HttpMcpOAuth,
  buildOmaModelsHttpRoutes,
  mcpOAuthPresetsFromEnvironment,
  parseConsoleOrigins,
  webCryptoMcpOAuthPkce,
  webCryptoMcpOAuthCliSecrets,
} from "@open-managed-agents/managed-agents-adapters-http";
import type { CredentialDocumentCipher } from "@open-managed-agents/credential-store-sql";
import type { DeploymentResourceSecretCipher } from "@open-managed-agents/deployment-store-sql";
import type { EnvironmentWorkSecretCipher } from "@open-managed-agents/environment-work-store-sql";
import {
  SqlMcpOAuthCliStore,
  SqlDeploymentAgentSource,
  SqlDeploymentVaultSource,
  SqlFileMetadataPersistence,
  SqlMemoryStoreSource,
  SqlManagedSessionsComposition,
  SqlPersistedSessionEventStream,
  SqlSessionEnvironmentSource,
  SqlSessionResourceSecretSource,
  SqlSessionSource,
  SqlSessionRuntimeProjectionPersistence,
  SqlSessionEventPersistence,
} from "@open-managed-agents/managed-agents-adapters-sql";
import { BlobFileContentStore } from "@open-managed-agents/managed-agents-adapters-blob";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import { SqlRuntimeResourceFencePort } from "@open-managed-agents/runtime-resource-fence-sql";
import { authenticateSandboxEgress, authorizeEnvironmentWorkEgress, authorizeSandboxEgress, isEnvironmentWorkFenceCurrent, issueSandboxToken, legacyRelayPassCheck, sandboxHarnessPlacement, sandboxTokenScopeFor, type EnvironmentWorkFenceRef, type SandboxGatewayStores, type SessionExecutionAttemptRef } from "@open-managed-agents/sandbox-gateway";
import { createSqlSandboxGatewayStore } from "@open-managed-agents/sandbox-gateway-sql";
import { issueCfAcpExecutionChannels } from "./lib/cf-acp-execution-capability";
import { cfSandboxTokenStore } from "./lib/cf-sandbox-token-store";
import { isSessionExecutionFenceActive } from "@open-managed-agents/session-runtime/execution-lease";
import { createSqlSessionExecutionLeases } from "@open-managed-agents/session-runtime-sql/execution-lease";
import {
  createCfShardPoolService,
  createCfTenantShardDirectoryService,
} from "@open-managed-agents/tenant-dbs-store";
import {
  fileR2Key,
  LOCAL_RUNTIME_ENV_ID,
  listAuthProviders,
} from "@open-managed-agents/shared";
import { toEnvironmentConfig } from "@open-managed-agents/environments-store";
import { authMiddleware } from "./auth";
import { rateLimitMiddleware, authRateLimitMiddleware } from "./rate-limit";
import { cfRouteServices } from "./lib/cf-route-services";
import { cfDreamCredentialResolver } from "./lib/workspace-model-credentials";
import { cfApiKeyStorage } from "./lib/cf-api-key-storage";
import { CfSessionRouter } from "./lib/cf-session-router";
import { CfManagedRuntimeFetcher } from "./lib/cf-managed-runtime-fetcher";
import { CfManagedSessionRuntimeAdapter } from "./lib/cf-managed-session-runtime";
import { buildCfManagedSandboxExecRoutes, execCfManagedSandbox } from "./lib/cf-managed-sandbox-exec";
import { registerCfEvalDeps } from "./eval-runner";
import { createManagedEvalRuntime, EvalBenchmarkStore } from "@open-managed-agents/evals-runner";
import { cfSandboxImageCatalog } from "./lib/cf-sandbox-images";
import { CfManagedSessionSecretSealer } from "./lib/cf-managed-session-secret-sealer";
import { synchronizeManagedSessionMemoryWorkspaces } from "./lib/managed-memory-workspace-sync";
import {
  AnthropicMessagesDreamCurator,
  ApplicationDreamMemoryWorkspace,
  ModelCardCatalogSource,
  decodeRuntimeProducedSessionEvent,
  CronDeploymentSchedulePlanner,
  EnvironmentAwareSessionEventDispatchRouter,
  EnvironmentAwareSessionEventStreamRouter,
  EnvironmentAwareSessionLifecycleRouter,
  ingestEnvironmentWorkRuntimeEvents,
  TimerEnvironmentWorkAvailabilityWaiter,
  McpOAuthCredentialValidationProbe,
  inProcessDreamExecutionSchedulerModule,
  LocalTunnelProvisioner,
  ManagedMemorySnapshotMaterializer,
  SealedEnvironmentWorkSessionCredentialIssuer,
  StandardWebhookEnvironmentWorkWakeup,
  DeduplicatingDreamCurator,
  WebCryptoTunnelCertificateAuthority,
  WebCryptoTunnelTokenManager,
  WebCryptoMemoryContentDescriptor,
  ZipSkillPackageCompiler,
} from "@open-managed-agents/managed-agents-adapters-runtime";
import type { ApiKeyResolution } from "@open-managed-agents/auth";
import { WebCryptoAesGcm } from "@open-managed-agents/integrations-adapters-cf";
import {
  cfSessionLifecycle,
  cfOutputsAdapter,
  fetchVaultCredentials,
} from "./lib/cf-session-lifecycle";
import { cfSessionCreateAdmission } from "./lib/cf-session-create-admission";
import { cfSessionWorkAdmission } from "./lib/cf-session-work-admission";
import type { KvStore } from "@open-managed-agents/kv-store";
import { validateAgentLimits } from "./lib/limits";
import { listMemberships, hasMembership } from "./auth-config";
import legacyEnvironmentsRoutes from "./routes/environments";
import capCliOauthRoutes from "./routes/cap-cli-oauth";
import legacyMemoryRoutes from "./routes/memory";
import dreamsRoutes from "./routes/dreams";
import legacyFilesRoutes from "./routes/files";
import legacySkillsRoutes from "./routes/skills";
import modelCardsRoutes from "./routes/model-cards";
import clawhubRoutes from "./routes/clawhub";
import evalsRoutes from "./routes/evals";
import costReportRoutes from "./routes/cost-report";
import internalRoutes from "./routes/internal";
import integrationsRoutes from "./routes/integrations";
import { runtimesRoutes, runtimeDaemonRoutes, authenticateRuntimeToken } from "./routes/runtimes";
import statsRoutes from "./routes/stats";
import inferenceProxyRoutes from "./routes/inference-proxy";
import mcpProxyRoutes, { cfMcpProxyPorts } from "./routes/mcp-proxy";
import { createManagedCredentialResolver } from "./lib/managed-credential-resolver";
import {
  createMcpProxyBinding,
  forwardMcpProxyRequest,
  type McpProxyPorts,
} from "@open-managed-agents/http-routes/proxy";
import { createBuiltinCapDeviceFlow } from "@open-managed-agents/oma-cap-adapter";
import {
  resolveGithubCredentials,
  resolveManagedGithubCredentials,
} from "./lib/github-creds";
import { buildCfScheduler } from "./lib/cf-scheduler-jobs";
import { buildCfMemoryQueue, dispatchCfMemoryQueueBatch } from "./lib/cf-queue-handlers";
import { logError, logWarn, recordEvent, errFields } from "@open-managed-agents/shared";
import { globalErrorHandler, requestMetricsMiddleware } from "./lib/observability";
import { errorEnvelopeMiddleware } from "./lib/error-envelope";
import type { R2EventMessage } from "@open-managed-agents/shared";

// Main worker: CRUD + routing layer.
// SessionDO and Sandbox are in per-environment sandbox workers.
// Environment builds are triggered via GitHub Actions.

// --- HTTP app ---
const app = new Hono<{ Bindings: Env }>();

// Request-level observability — must be the FIRST middleware so it
// captures every request including auth failures, rate-limit rejects,
// and unhandled exceptions. Pairs with globalErrorHandler below.
app.use("*", requestMetricsMiddleware);

// Normalize all 4xx/5xx JSON bodies into the Anthropic-compatible error
// envelope (`{type:"error", error:{type,message}, request_id}`) so callers
// of the official @anthropic-ai/sdk can `catch (e) { if (e.error?.error?.type
// === 'authentication_error') ... }`. Runs second so it sees the response
// body produced by every downstream middleware/handler. See lib/error-envelope.ts.
app.use("*", (c, next) => c.req.path.startsWith("/openai/") ? next() : errorEnvelopeMiddleware(c, next));

// Catch-all for anything that escapes per-route try/catch. Logs +
// records to AE before returning a clean 500 (no internal leak in body).
app.onError(globalErrorHandler);

// Hono's default notFound is a plain "404 Not Found" body — wrap it in the
// Anthropic envelope so SDK callers can `if (e.error?.error?.type ===
// 'not_found_error')` instead of relying on raw status codes. Returning a
// JSON body here makes errorEnvelopeMiddleware's already-canonical short
// path kick in.
app.notFound((c) =>
  c.json(
    {
      type: "error" as const,
      error: {
        type: "not_found_error",
        message: `No route matched ${c.req.method} ${c.req.path}`,
      },
    },
    404,
  ),
);

app.get("/health", (c) => c.json({ status: "ok" }));

// Auth routes (public — no authMiddleware, but rate-limited per-IP and
// per-email so a stranger can't spam OTP sends and burn the mail budget).
// Lazy import to avoid crashing workerd in test environments
app.use("/auth/*", authRateLimitMiddleware);
app.on(["GET", "POST"], "/auth/*", async (c) => {
  if (!c.env.MAIN_DB) return c.json({ error: "Auth not configured" }, 503);
  const { createAuth } = await import("./auth-config");
  return createAuth(c.env).handler(c.req.raw);
});

// Auth info endpoint (public — tells the frontend which providers are enabled
// and surfaces the Turnstile site key so the Login page can render the widget).
app.get("/auth-info", (c) => {
  const providers = listAuthProviders({
    emailOtp: true,
    googleClientId: c.env.GOOGLE_CLIENT_ID,
    googleClientSecret: c.env.GOOGLE_CLIENT_SECRET,
    githubClientId: c.env.GITHUB_CLIENT_ID,
    githubClientSecret: c.env.GITHUB_CLIENT_SECRET,
  });
  return c.json({
    providers,
    turnstile_site_key: c.env.TURNSTILE_SITE_KEY ?? null,
  });
});

// A sealed CLI flow alone can finish the provider callback. All other
// callback states fall through to normal Console authentication below.
app.use("/v1/oma/oauth/callback", buildMcpOAuthCliCallback((context) => managedMcpOAuthCliFor((context as AppCtx).env)));

// Session-scoped credential relay authenticates the sandbox token
// (Basic <sessionId>:<token>, scope all or egress), never ambient API credentials.
app.route("/v1/oma/egress", buildCredentialEgressRoutes(async context => {
  const env = (context as AppCtx).env;
  if (!env.PLATFORM_ROOT_SECRET) throw new Error("Credential relay is not configured");
  const { createCredentialEgressRelay } = await import("@open-managed-agents/managed-credential-resolver");
  const store = cfSandboxTokenStore(env);
  // DEPLOY TRANSITION ONLY: pre-#561 HMAC relay passes, verify-only, next release removes.
  const legacyPass = legacyRelayPassCheck(env.PLATFORM_ROOT_SECRET, cfSandboxGatewayStores(env));
  return createCredentialEgressRelay({
    authenticate: authorization => authenticateSandboxEgress(store, authorization, { legacyPass }),
    credentials: {
      outboundTarget: async (scope, hostname) => createManagedCredentialResolver(env, await buildCfTenantDbProvider(env).resolve(scope.workspaceId)).outboundTarget(scope, hostname),
      forward: async (workspaceId, target, send) => createManagedCredentialResolver(env, await buildCfTenantDbProvider(env).resolve(workspaceId)).forward(workspaceId, target, send),
      sandboxEgress: async (scope, hostname) => createManagedCredentialResolver(env, await buildCfTenantDbProvider(env).resolve(scope.workspaceId)).sandboxEgress(scope, hostname),
    },
    send: request => fetch(request),
    log: { warn: (fields, message) => logWarn(fields, message) },
  });
}));

// API routes (require authentication)
app.use("/v1/*", authMiddleware);
app.use("/v1/*", rateLimitMiddleware);
// Resolve the per-tenant D1 database for this request. Phase 1: returns the
// shared MAIN_DB for every tenant (zero behaviour change). Phase 4: routes
// to per-tenant bindings published by the CICD sync script.
app.use("/v1/*", tenantDbMiddleware);
// Build the platform-agnostic service container once per request and stash it
// on c.var.services. Wiring (CF / Postgres / SQLite) lives in
// packages/services — routes only see the abstract Services interface.
app.use("/v1/*", servicesMiddleware);

// Build agent / vault / api-keys / me / tenants from
// `@open-managed-agents/http-routes`. Per-request `RouteServices` is
// resolved off `c.var.services` so the per-tenant D1 binding flows
// through; CF-only callbacks (model card validation, field-size limits,
// shard assignment, KV-backed api-key storage, MAIN_DB membership reads)
// get plumbed in here. Each mount is a Hono sub-app whose handler builds
// a one-shot package app per request — cheap (~µs of route registration)
// and keeps the per-tenant + per-request callbacks correctly scoped
// without leaking globals.

// Build agent / vault / api-keys / me / tenants / sessions from
// `@open-managed-agents/http-routes`. Per-request `RouteServices` is
// resolved off `c.var.services` so the per-tenant D1 binding flows
// through; CF-only callbacks (model card validation, field-size limits,
// shard assignment, KV-backed api-key storage, MAIN_DB membership reads,
// refresh + GitHub fast-path lifecycle hooks) get plumbed
// in via closures over `c` so they always see the per-request services
// container without leaking globals.

type AppCtx = import("hono").Context<{
  Bindings: Env;
  Variables: {
    tenant_id: string;
    user_id?: string;
    auth_credential?: ApiKeyResolution["credential"];
    services: import("@open-managed-agents/services").Services;
    tenantDb: D1Database;
  };
}>;

const cfRouteServicesFromCtx = (c: AppCtx) =>
  cfRouteServices(c as never);

const legacyAgentsRoutes = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; user_id?: string };
}>().all("*", (c) => {
  const ctx = c as unknown as AppCtx;
  const services = ctx.var.services;
  const app = buildLegacyAgentRoutes({
    application: managedCoreApplicationFor(ctx).port(managedAgentsPortTokens.agents),
    services: () => cfRouteServicesFromCtx(ctx),
    validateModel: async (tenantId, model) => {
      const cards = await services.modelCards.list({ tenantId });
      const active = cards.filter((card) => card.archived_at === null);
      if (active.length === 0) return { valid: true };
      const modelId = typeof model === "string" ? model : model.id;
      const match = active.find((card) => card.model_id === modelId);
      if (!match) {
        return {
          valid: false,
          error: `No model card with model_id "${modelId}". Create a card with that handle, or set agent.model to an existing card's model_id.`,
        };
      }
      return { valid: true };
    },
    validateAgentLimits: (body) =>
      validateAgentLimits(body as Parameters<typeof validateAgentLimits>[0]),
    hasActiveSessionsByAgent: async (tenantId, agentId) =>
      await services.sessions.hasActiveByAgent({ tenantId, agentId }) ||
      (await new CfD1SqlClient(ctx.var.tenantDb).prepare("SELECT id FROM managed_sessions WHERE workspace_id = ? AND agent_id = ? AND archived_at IS NULL LIMIT 1").bind(tenantId, agentId).first()) !== null,
    hasActiveEvalsByAgent: (tenantId, agentId) =>
      services.evals.hasActiveByAgent({ tenantId, agentId }),
  });
  return invokePackage(c, app);
});

function managedCoreApplicationFor(context: { var: unknown }) {
  const request = context.var as {
    tenant_id: string;
    tenantDb: D1Database;
  };
  return createCloudflareManagedAgentsApp({
    workspaceId: request.tenant_id,
    sql: new CfD1SqlClient(request.tenantDb),
  }, {
    features: {
      preset: "none",
      agents: true,
      environments: true,
      memoryStores: true,
      userProfiles: true,
    },
    clock: { now: () => new Date() },
    ids: {
      next: (namespace) =>
        `${namespace === "environment" ? "env" : namespace === "memory_store" ? "memstore" : namespace === "user-profile" ? "uprof" : namespace}_${crypto.randomUUID().replaceAll("-", "")}`,
    },
    modules: () => [
      providePort(userProfileEnrollmentIssuerPort, {
        issue: async () => ({
          type: "conflict" as const,
          message: "User Profile enrollment is unavailable in self-hosted mode",
        }),
      }),
    ],
  });
}

const managedAgentsRoutes = buildManagedAgentRoutes((context) => {
  return managedCoreApplicationFor(context)
    .port(managedAgentsPortTokens.agents);
});

/** Operator SANDBOX_IMAGES catalog (apps/main/src/lib/cf-sandbox-images.ts).
 * Worker bindings are per-isolate constants, so the module-level `env`
 * import is the same value every request sees. */
function workerSandboxImages() {
  return cfSandboxImageCatalog(workerEnv as unknown as { SANDBOX_IMAGES?: string });
}

const managedEnvironmentsRoutes = buildManagedEnvironmentRoutes((context) => {
  return managedCoreApplicationFor(context)
    .port(managedAgentsPortTokens.environments);
}, { sandboxImages: { has: (alias) => workerSandboxImages().has(alias) } });

function managedFilesApplicationFor(input: {
  workspaceId: string;
  tenantDb: D1Database;
  blobs: NonNullable<import("@open-managed-agents/services").Services["filesBlob"]>;
}) {
  return createCloudflareManagedAgentsApp({
    workspaceId: input.workspaceId,
    sql: new CfD1SqlClient(input.tenantDb),
    fileContent: new BlobFileContentStore(input.blobs),
  }, {
    features: { preset: "none", files: true },
    clock: { now: () => new Date() },
    ids: {
      next: (namespace) =>
        `${namespace}_${crypto.randomUUID().replaceAll("-", "")}`,
    },
  }).port(managedAgentsPortTokens.files);
}

const managedFilesRoutes = buildManagedFileRoutes((context) => {
  const request = context.var as {
    tenant_id: string;
    tenantDb: D1Database;
    services: import("@open-managed-agents/services").Services;
  };
  const blobs = request.services.filesBlob;
  if (blobs === null) {
    throw new Error("FILES_BUCKET binding is required for managed Files");
  }
  return managedFilesApplicationFor({
    workspaceId: request.tenant_id,
    tenantDb: request.tenantDb,
    blobs,
  });
});

const managedMemoryStoresRoutes = buildManagedMemoryStoreRoutes((context) => {
  return managedCoreApplicationFor(context)
    .port(managedAgentsPortTokens.memoryStores);
});

const managedMemoryContent = new WebCryptoMemoryContentDescriptor();
function managedMemoryActor(userId: string | undefined) {
  return userId === undefined
    ? { kind: "api" as const, apiKeyId: "self_hosted" }
    : { kind: "user" as const, userId };
}
const managedMemoriesRoutes = buildManagedMemoryRoutes((context) => {
  return managedMemoriesApplicationFor(context as unknown as AppCtx)
    .port(managedAgentsPortTokens.memories);
});
const managedMemoryVersionsRoutes = buildManagedMemoryVersionRoutes((context) => {
  return managedMemoriesApplicationFor(context as unknown as AppCtx)
    .port(managedAgentsPortTokens.memoryVersions);
});

function managedMemoriesApplicationFor(ctx: AppCtx) {
  return managedMemoriesApplication(
    ctx.var.tenant_id,
    ctx.var.tenantDb,
    ctx.var.user_id,
  );
}

function managedMemoriesApplication(
  workspaceId: string,
  tenantDb: D1Database,
  userId?: string,
) {
  const client = new CfD1SqlClient(tenantDb);
  return createCloudflareManagedAgentsApp({
    workspaceId,
    sql: client,
  }, {
    features: {
      preset: "none",
      memories: true,
      memoryVersions: true,
    },
    clock: { now: () => new Date() },
    ids: {
      next: (namespace) => `${
        namespace === "memory"
          ? "mem"
          : namespace === "memory-version"
            ? "memver"
            : namespace
      }_${crypto.randomUUID().replaceAll("-", "")}`,
    },
    modules: () => [
      providePort(
        memoryStoreForMemorySourcePort,
        new SqlMemoryStoreSource(client),
      ),
      providePort(memoryContentDescriptorPort, managedMemoryContent),
      providePort(
        memoryVersionActorPort,
        managedMemoryActor(userId),
      ),
    ],
  });
}

const managedSkillCompiler = new ZipSkillPackageCompiler();
let lastManagedSkillVersion = 0n;
function nextManagedSkillVersion(): string {
  const now = BigInt(Date.now()) * 1_000n;
  lastManagedSkillVersion = now > lastManagedSkillVersion
    ? now
    : lastManagedSkillVersion + 1n;
  return lastManagedSkillVersion.toString();
}
function managedSkillsApplication(
  workspaceId: string,
  tenantDb: D1Database,
) {
  const client = new CfD1SqlClient(tenantDb);
  return createCloudflareManagedAgentsApp({
    workspaceId,
    sql: client,
  }, {
    features: {
      preset: "none",
      skills: true,
      skillVersions: true,
    },
    clock: { now: () => new Date() },
    ids: {
      next: (namespace) =>
        namespace === "skill-version-value"
          ? nextManagedSkillVersion()
          : `${namespace === "skill-version" ? "skv" : namespace}_${crypto.randomUUID().replaceAll("-", "")}`,
    },
    modules: () => [
      providePort(skillPackageCompilerPort, managedSkillCompiler),
    ],
  });
}
function managedSkillsApplicationFor(ctx: AppCtx) {
  return managedSkillsApplication(ctx.var.tenant_id, ctx.var.tenantDb);
}
const managedSkillsRoutes = buildManagedSkillRoutes((context) =>
  managedSkillsApplicationFor(context as unknown as AppCtx)
    .port(managedAgentsPortTokens.skills),
);
const managedSkillVersionsRoutes = buildManagedSkillVersionRoutes((context) =>
  managedSkillsApplicationFor(context as unknown as AppCtx)
    .port(managedAgentsPortTokens.skillVersions),
);

const legacyVaultsRoutes = new Hono<{ Bindings: Env; Variables: { tenant_id: string } }>().all("*", (c) => {
  const ctx = c as unknown as AppCtx;
  const app = buildLegacyVaultRoutes({ services: () => cfRouteServicesFromCtx(ctx) });
  return invokePackage(c, app);
});

function managedVaultsPortFor(context: AppCtx) {
  const request = context.var as {
    tenant_id: string;
    tenantDb: D1Database;
  };
  return createCloudflareManagedAgentsApp({
    workspaceId: request.tenant_id,
    sql: new CfD1SqlClient(request.tenantDb),
  }, {
    features: { preset: "none", vaults: true },
    clock: { now: () => new Date() },
    ids: {
      next: (namespace) =>
        `${namespace === "vault" ? "vlt" : namespace}_${crypto.randomUUID().replaceAll("-", "")}`,
    },
  }).port(managedAgentsPortTokens.vaults);
}

const managedVaultsRoutes = buildManagedVaultRoutes(context => managedVaultsPortFor(context as AppCtx));

const managedCredentialValidation = new McpOAuthCredentialValidationProbe();
function managedCredentialsPortFor(context: AppCtx) {
  const request = context.var as { tenant_id: string; tenantDb: D1Database };
  return managedCredentialsPortOn(context.env, request.tenant_id, request.tenantDb);
}
function managedCredentialsPortOn(env: Env, workspaceId: string, tenantDb: D1Database) {
  const credentialCrypto = env.PLATFORM_ROOT_SECRET === undefined
    ? null
    : new WebCryptoAesGcm(
        env.PLATFORM_ROOT_SECRET,
        "managed.vault.credentials",
      );
  const cipher: CredentialDocumentCipher = {
    seal: async ({ plaintext }) => {
      if (credentialCrypto === null) {
        throw new Error(
          "PLATFORM_ROOT_SECRET is required for managed Vault credentials",
        );
      }
      return { ciphertext: await credentialCrypto.encrypt(plaintext) };
    },
    open: async ({ ciphertext }) => {
      if (credentialCrypto === null) {
        throw new Error(
          "PLATFORM_ROOT_SECRET is required for managed Vault credentials",
        );
      }
      return { plaintext: await credentialCrypto.decrypt(ciphertext) };
    },
  };
  return createCloudflareManagedAgentsApp({
    workspaceId,
    sql: new CfD1SqlClient(tenantDb),
    credentialCipher: cipher,
    credentialValidation: managedCredentialValidation,
  }, {
    features: { preset: "none", credentials: true },
    clock: { now: () => new Date() },
    ids: {
      next: (namespace) =>
        `${namespace === "credential" ? "vcrd" : namespace}_${crypto.randomUUID().replaceAll("-", "")}`,
    },
  }).port(managedAgentsPortTokens.credentials);
}

const managedCredentialsRoutes = buildManagedCredentialRoutes(context => managedCredentialsPortFor(context as AppCtx));

// OpenMA extension: OAuth device flow that ends in a managed cap_cli credential.
const capCliDeviceFlow = createBuiltinCapDeviceFlow({
  fetch: (input, init) => fetch(input, init),
});
const managedCapCliDeviceFlowRoutes = buildCapCliDeviceFlowRoutes((context) => {
  const ctx = context as AppCtx;
  const secret = ctx.env.PLATFORM_ROOT_SECRET;
  if (secret === undefined) {
    throw new Error("PLATFORM_ROOT_SECRET is required for managed Vault credentials");
  }
  return new CapCliDeviceFlowApplicationService({
    workspaceId: (ctx.var as { tenant_id: string }).tenant_id,
    credentials: managedCredentialsPortFor(ctx),
    deviceFlow: capCliDeviceFlow,
    cipher: new WebCryptoAesGcm(secret, "managed.vault.cap_cli_device_flow"),
    clock: { now: () => new Date() },
  });
});

// OpenMA extension: browser MCP OAuth that ends in a managed mcp_oauth credential.
function managedMcpOAuthOn(env: Env, workspaceId: string, tenantDb: D1Database) {
  const secret = env.PLATFORM_ROOT_SECRET;
  if (secret === undefined) {
    throw new Error("PLATFORM_ROOT_SECRET is required for managed Vault credentials");
  }
  return new McpOAuthApplicationService({
    workspaceId,
    credentials: managedCredentialsPortOn(env, workspaceId, tenantDb),
    oauth: new HttpMcpOAuth({
      fetch: (input, init) => fetch(input, init),
      clock: { now: () => new Date() },
      presets: mcpOAuthPresetsFromEnvironment(env as unknown as Record<string, string | undefined>),
      log: { warn: (fields, message) => logWarn(fields, message) },
    }),
    pkce: webCryptoMcpOAuthPkce,
    cipher: new WebCryptoAesGcm(secret, "managed.vault.mcp_oauth_state"),
    clock: { now: () => new Date() },
    log: { warn: (fields, message) => logWarn(fields, message) },
  });
}
const managedMcpOAuthRoutes = buildMcpOAuthRoutes((context) => {
  const ctx = context as AppCtx;
  return managedMcpOAuthOn(ctx.env, ctx.var.tenant_id, ctx.var.tenantDb);
}, { consoleOrigins: (context) => parseConsoleOrigins((context as AppCtx).env.CONSOLE_ORIGINS) });
function managedMcpOAuthCliFor(env: Env) {
  if (!env.PLATFORM_ROOT_SECRET) throw new Error("PLATFORM_ROOT_SECRET is required for MCP OAuth");
  return new McpOAuthCliService({
    store: new SqlMcpOAuthCliStore(new CfD1SqlClient(env.MAIN_DB), { now: () => new Date() }),
    application: async (workspaceId) => managedMcpOAuthOn(env, workspaceId, await buildCfTenantDbProvider(env).resolve(workspaceId)),
    cipher: new WebCryptoAesGcm(env.PLATFORM_ROOT_SECRET, "managed.vault.mcp_oauth_cli"),
    secrets: webCryptoMcpOAuthCliSecrets,
    clock: { now: () => new Date() },
  });
}
const managedMcpOAuthCliRoutes = buildMcpOAuthCliRoutes((context) => managedMcpOAuthCliFor((context as AppCtx).env), webCryptoMcpOAuthCliSecrets);

const managedUserProfilesRoutes = buildManagedUserProfileRoutes((context) => {
  return managedCoreApplicationFor(context)
    .port(managedAgentsPortTokens.userProfiles);
});

const apiKeysRoutes = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; user_id?: string };
}>().all("*", (c) => {
  const ctx = c as unknown as AppCtx;
  const services = ctx.var.services;
  const app = buildApiKeyRoutes({ storage: cfApiKeyStorage(services.kv) });
  return invokePackage(c, app);
});

const meRoutes = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; user_id?: string };
}>().all("*", (c) => {
  const ctx = c as unknown as AppCtx;
  const env = ctx.env;
  const services = ctx.var.services;
  const app = buildMeRoutes({
    services: () => cfRouteServicesFromCtx(ctx),
    authDisabled: false,
    loadUser: async (userId) => {
      if (!env.MAIN_DB) return null;
      const r = await env.MAIN_DB
        .prepare(`SELECT id, email, name FROM "user" WHERE id = ?`)
        .bind(userId)
        .first<{ id: string; email: string; name: string | null }>();
      return r ?? null;
    },
    loadTenant: async (tenantId) => {
      if (!env.MAIN_DB) return null;
      const r = await env.MAIN_DB
        .prepare(`SELECT id, name FROM tenant WHERE id = ?`)
        .bind(tenantId)
        .first<{ id: string; name: string }>();
      return r ?? null;
    },
    listMemberships: (userId) => listMemberships(env.MAIN_DB, userId),
    hasMembership: (userId, tenantId) => hasMembership(env.MAIN_DB, userId, tenantId),
    mintApiKey: (input) =>
      mintApiKeyOnStorage(cfApiKeyStorage(services.kv), input),
  });
  return invokePackage(c, app);
});

const tenantsRoutes = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; user_id?: string };
}>().all("*", (c) => {
  const ctx = c as unknown as AppCtx;
  const env = ctx.env;
  const app = buildTenantRoutes({
    memberSql: new CfD1SqlClient(env.MAIN_DB),
    loadMemberUser: (id) => env.MAIN_DB.prepare('SELECT name, email FROM "user" WHERE id = ?').bind(id).first<{ name: string; email: string }>(),
    services: () => cfRouteServicesFromCtx(ctx),
    createTenantAndMembership: async ({ tenantId, name, userId }) => {
      const now = Math.floor(Date.now() / 1000);
      await env.MAIN_DB.batch([
        env.MAIN_DB
          .prepare("INSERT INTO tenant (id, name, createdAt, updatedAt) VALUES (?, ?, ?, ?)")
          .bind(tenantId, name, now, now),
        env.MAIN_DB
          .prepare(
            "INSERT INTO membership (user_id, tenant_id, role, created_at) VALUES (?, ?, 'owner', ?)",
          )
          .bind(userId, tenantId, now),
      ]);
    },
    assignShard: async (tenantId) => {
      const controlPlaneDb = env.ROUTER_DB ?? env.MAIN_DB;
      const shardPool = createCfShardPoolService({ controlPlaneDb });
      const tenantShardDirectory = createCfTenantShardDirectoryService({ controlPlaneDb });
      const pick = await shardPool.pickShardForNewTenant();
      const bindingName = pick?.bindingName ?? "AUTH_DB_00";
      await tenantShardDirectory.assign({ tenantId, bindingName });
      await shardPool.incrementTenantCount(bindingName);
    },
  });
  return invokePackage(c, app);
});

/**
 * OMA queue extension for Managed sessions: remove one queued user.message
 * before it is absorbed. Mid-run accept already steers into the current turn
 * at the next LLM/tool-call boundary (no explicit /pending/.../steer).
 * The SessionDO owns the queue; it updates the D1 execution outbox and
 * broadcasts `system.user_message_cancelled` (and steered frames from
 * takeSteeringInputs) that openma-common decodes into OpenMA queue-lifecycle
 * events.
 */
const managedSessionQueueRoutes = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; tenantDb: D1Database };
}>();
async function forwardManagedQueueCancel(
  c: Context<{ Bindings: Env; Variables: { tenant_id: string; tenantDb: D1Database } }>,
): Promise<Response> {
  const sessionId = c.req.param("sessionId") ?? "";
  const eventId = c.req.param("eventId") ?? "";
  const workspaceId = c.var.tenant_id;
  const row = await c.var.tenantDb
    .prepare("SELECT id FROM managed_sessions WHERE workspace_id = ? AND id = ? LIMIT 1")
    .bind(workspaceId, sessionId)
    .first();
  if (!row) return c.json({ error: "Session not found" }, 404);
  const res = await new CfManagedRuntimeFetcher(c.env).fetch(
    `https://managed-runtime/sessions/${encodeURIComponent(sessionId)}/pending/${encodeURIComponent(eventId)}`,
    { method: "DELETE", headers: { "x-oma-workspace-id": workspaceId } },
  );
  return new Response(await res.text(), {
    status: res.status,
    headers: { "content-type": "application/json" },
  });
}
managedSessionQueueRoutes.delete("/:sessionId/pending/:eventId", (c) =>
  forwardManagedQueueCancel(c));

const legacySessionsRoutes = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; user_id?: string };
}>().all("*", (c) => {
  const ctx = c as unknown as AppCtx;
  const env = ctx.env;
  const services = ctx.var.services;
  const tenantId = ctx.var.tenant_id;
  const router = new CfSessionRouter({ env, services, tenantId });
  const app = buildSessionRoutes({
    services: () => cfRouteServicesFromCtx(ctx),
    router,
    localRuntimeEnvId: LOCAL_RUNTIME_ENV_ID,
    loadEnvironment: async ({ tenantId, environmentId }) => {
      if (environmentId === LOCAL_RUNTIME_ENV_ID) return null;
      const row = await services.environments.get({ tenantId, environmentId });
      return row ? toEnvironmentConfig(row) : null;
    },
    fetchVaultCredentials: ({ tenantId, vaultIds }) =>
      fetchVaultCredentials(services, tenantId, vaultIds),
    outputs: cfOutputsAdapter(env),
    debugRecoveryToken: (env as { DEBUG_TOKEN?: string }).DEBUG_TOKEN,
    lifecycle: cfSessionLifecycle(c as never),
  });
  return invokePackage(c, app);
});

function managedSessionEnvironmentSource(
  client: CfD1SqlClient,
): SessionEnvironmentSourcePort {
  const persistedEnvironments = new SqlSessionEnvironmentSource(client);
  return {
    find: (input) => {
      if (input.environmentId !== LOCAL_RUNTIME_ENV_ID) {
        return persistedEnvironments.find(input);
      }
      return Promise.resolve({
        id: input.environmentId,
        archivedAt: null,
        config: {
          type: "cloud" as const,
          networking: { type: "unrestricted" as const },
          packages: { apt: [], cargo: [], gem: [], go: [], npm: [], pip: [] },
        },
        createdAt: "1970-01-01T00:00:00.000Z",
        description: "Cloudflare local runtime",
        metadata: {},
        name: "Local runtime",
        updatedAt: "1970-01-01T00:00:00.000Z",
      });
    },
  };
}

function managedSessionsCompositionFor(ctx: AppCtx): SqlManagedSessionsComposition {
  const client = new CfD1SqlClient(ctx.var.tenantDb);
  const environments = managedSessionEnvironmentSource(client);
  const runtime = new CfManagedSessionRuntimeAdapter(
    new CfManagedRuntimeFetcher(ctx.env),
    () => cfSandboxImageCatalog(ctx.env as unknown as { SANDBOX_IMAGES?: string }),
  );
  const workspaceId = ctx.var.tenant_id;
  const selfHostedWork = managedEnvironmentWorkApplicationFor(ctx)
    .port(environmentSessionWorkEnqueuerPort);
  const sessionLifecycleHooks = cfSessionLifecycle(ctx as never);
  const services = (ctx.var as unknown as { services: { kv: KvStore } }).services;
  return new SqlManagedSessionsComposition({
    client,
    // Rate limit + daily cap + optional usage-meter port, evaluated by the shared
    // Sessions application before any Session row or work is persisted.
    admission: cfSessionCreateAdmission(ctx.env, services.kv),
    // Optional generic host hook for new turns on existing Sessions.
    workAdmission: cfSessionWorkAdmission(ctx.env),
    // Event acceptance and runtime work admission must share one D1 batch.
    // SessionDO is only an execution host; a failed service-binding wakeup
    // therefore cannot erase already accepted work.
    executionOutbox: true,
    environments,
    lifecycle: new EnvironmentAwareSessionLifecycleRouter({
      environments,
      runtime,
      selfHostedWork,
      cleanupSession: async ({ workspaceId, sessionId }) => {
        await sessionLifecycleHooks.cascadeDeleteFiles?.({
          tenantId: workspaceId,
          sessionId,
        });
      },
    }),
    runtime,
    eventDispatch: new EnvironmentAwareSessionEventDispatchRouter({ runtime }),
    eventStream: new EnvironmentAwareSessionEventStreamRouter({
      environments,
      runtime,
      selfHosted: new SqlPersistedSessionEventStream(client),
    }),
    sealer: new CfManagedSessionSecretSealer(ctx.env.PLATFORM_ROOT_SECRET),
    clock: { now: () => new Date() },
    ids: {
      nextSessionId: () =>
        `session_${crypto.randomUUID().replaceAll("-", "")}`,
      nextEventId: () =>
        `sevt_${crypto.randomUUID().replaceAll("-", "")}`,
      nextOutcomeId: () =>
        `outc_${crypto.randomUUID().replaceAll("-", "")}`,
      nextResourceId: () =>
        `sesrsc_${crypto.randomUUID().replaceAll("-", "")}`,
    },
  });
}

// OMA evals on managed Sessions. A scheduled tick has no request, so the same
// factories run against a minimal context: env + tenant id/db/services.
registerCfEvalDeps(async (env, tenantId, request) => {
  const [tenantDb, services] = await Promise.all([
    buildCfTenantDbProvider(env).resolve(tenantId),
    getCfServicesForTenant(env, tenantId),
  ]);
  // The factories below read the request origin (self-hosted environment
  // credentials) and executionCtx. A cron tick has neither: it gets an origin
  // nothing can call back, and self-hosted environments are rejected below.
  const ctx = {
    env,
    var: { tenant_id: tenantId, tenantDb, services },
    req: { url: request?.origin ?? "https://evals.invalid" },
    executionCtx: { waitUntil: request?.waitUntil ?? ((task: Promise<unknown>) => { void task.catch(() => undefined); }) },
  } as unknown as AppCtx;
  const core = managedCoreApplicationFor(ctx);
  const ports = managedSessionsCompositionFor(ctx).portsFor(tenantId);
  const fetcher = new CfManagedRuntimeFetcher(env);
  const imageCatalog = cfSandboxImageCatalog(env as unknown as { SANDBOX_IMAGES?: string });
  const runtime = createManagedEvalRuntime({
    agents: core.port(managedAgentsPortTokens.agents),
    environments: core.port(managedAgentsPortTokens.environments),
    sessions: ports.sessions,
    sessionEvents: ports.sessionEvents,
    images: imageCatalog.entries,
    // The operator declares the image WORKDIR in the catalog and the container
    // is built FROM the task image, so its ENV is already in every exec. No
    // registry read: Docker Hub rate-limits Workers' shared egress (HTTP 429).
    imageRuntime: (alias) => {
      const placement = imageCatalog.placement(alias);
      return placement ? { workdir: placement.workdir ?? null, env: {} } : null;
    },
    exec: (sessionId, command, timeoutMs) => execCfManagedSandbox(fetcher, tenantId, sessionId, command, timeoutMs),
    // SessionDO /exec creates the container on first use; it then sleeps
    // after 5 idle minutes on its own (sleepAfter), so nothing to release.
    ensureSandbox: async () => true,
    selfHostedUnsupported: "Evals on Cloudflare run in cloud environments only; this environment is self_hosted",
  });
  return {
    runtime,
    benchmarks: new EvalBenchmarkStore(services.kv, tenantId),
    async readUpload(fileId) {
      if (!services.filesBlob) return null;
      const found = await managedFilesApplicationFor({ workspaceId: tenantId, tenantDb, blobs: services.filesBlob })
        .downloadFile({ fileId });
      if (found.type !== "found") return null;
      return { bytes: found.file.content, ...(found.file.filename ? { filename: found.file.filename } : {}) };
    },
  };
});

async function mcpProxyPortsFor(env: Env, workspaceId: string): Promise<McpProxyPorts> {
  return cfMcpProxyPorts(
    env,
    await buildCfTenantDbProvider(env).resolve(workspaceId),
    await getCfServicesForTenant(env, workspaceId),
  );
}

const managedSessionsRoutes = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; user_id?: string };
}>().all("*", (c) => {
  const ctx = c as unknown as AppCtx;
  const composition = managedSessionsCompositionFor(ctx);
  const ports = composition.portsFor(ctx.var.tenant_id);
  return invokePackage(
    c,
    buildManagedSessionsApi({
      sessions: () => ports.sessions,
      sessionEvents: () => ports.sessionEvents,
      sessionResources: () => ports.sessionResources,
      sessionThreads: () => ports.sessionThreads,
      sessionThreadEvents: () => ports.sessionThreadEvents,
    }, {
      outputs: {
        workspaceId: () => ctx.var.tenant_id,
        store: cfOutputsAdapter(ctx.env),
      },
    }),
  );
});

const managedRuntimeIngressRoutes = new Hono<{
  Bindings: Env;
  Variables: {
    tenant_id: string;
    tenantDb: D1Database;
    auth_credential?: ApiKeyResolution["credential"];
  };
}>().post("/:sessionId/runtime-events", async (c) => {
  const credential = c.get("auth_credential");
  if (credential?.type !== "environment_work_session") {
    return c.json({ error: "Environment Work session credential required" }, 403);
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Request body must be valid JSON" }, 400);
  }
  const ctx = c as unknown as AppCtx;
  const composition = managedSessionsCompositionFor(ctx);
  const result = await ingestEnvironmentWorkRuntimeEvents({
    claim: {
      workspaceId: ctx.var.tenant_id,
      environmentId: credential.environmentId,
      sessionId: credential.sessionId,
      workId: credential.workId,
      generation: credential.generation,
    },
    sessionId: c.req.param("sessionId"),
    body,
    projection: new SessionRuntimeProjectionApplicationService({
      workspaceId: ctx.var.tenant_id,
      persistence: composition.runtimeProjection,
    }),
    publish: async () => {},
  });
  if (result.type === "recorded") {
    return c.json({ data: result.eventIds.map((id) => ({ id })) }, 200);
  }
  if (result.type === "invalid_request") {
    return c.json({ error: result.message }, 400);
  }
  if (result.type === "not_found") return c.json({ error: "Session not found" }, 404);
  if (result.type === "forbidden") return c.json({ error: "Forbidden" }, 403);
  return c.json({ error: result.type }, 409);
});

const managedDeploymentSchedulePlanner = new CronDeploymentSchedulePlanner();
const managedEnvironmentWorkAvailability =
  new TimerEnvironmentWorkAvailabilityWaiter();

function managedDeploymentCipherFor(ctx: AppCtx): DeploymentResourceSecretCipher {
  const deploymentCrypto = ctx.env.PLATFORM_ROOT_SECRET === undefined
    ? null
    : new WebCryptoAesGcm(
        ctx.env.PLATFORM_ROOT_SECRET,
        "managed.deployments.resources",
      );
  return {
    seal: async ({ plaintext }) => {
      if (deploymentCrypto === null) {
        throw new Error(
          "PLATFORM_ROOT_SECRET is required for managed Deployment resource credentials",
        );
      }
      return { ciphertext: await deploymentCrypto.encrypt(plaintext) };
    },
    open: async ({ ciphertext }) => {
      if (deploymentCrypto === null) {
        throw new Error(
          "PLATFORM_ROOT_SECRET is required for managed Deployment resource credentials",
        );
      }
      return { plaintext: await deploymentCrypto.decrypt(ciphertext) };
    },
  };
}

function managedEnvironmentWorkCipherFor(
  ctx: AppCtx,
): EnvironmentWorkSecretCipher {
  const workCrypto = ctx.env.PLATFORM_ROOT_SECRET === undefined
    ? null
    : new WebCryptoAesGcm(
        ctx.env.PLATFORM_ROOT_SECRET,
        "managed.environment-work.secret",
      );
  return {
    seal: async ({ plaintext }) => {
      if (workCrypto === null) {
        throw new Error(
          "PLATFORM_ROOT_SECRET is required for managed Environment Work credentials",
        );
      }
      return { ciphertext: await workCrypto.encrypt(plaintext) };
    },
    open: async ({ ciphertext }) => {
      if (workCrypto === null) {
        throw new Error(
          "PLATFORM_ROOT_SECRET is required for managed Environment Work credentials",
        );
      }
      return { plaintext: await workCrypto.decrypt(ciphertext) };
    },
  };
}

function managedEnvironmentWorkApplicationFor(ctx: AppCtx) {
  const client = new CfD1SqlClient(ctx.var.tenantDb);
  const platformRootSecret = ctx.env.PLATFORM_ROOT_SECRET;
  if (!platformRootSecret) {
    throw new Error(
      "PLATFORM_ROOT_SECRET is required for managed Environment Work credentials",
    );
  }
  const webhookUrl = ctx.env.OMA_MANAGED_AGENTS_WEBHOOK_URL;
  const webhookKey = ctx.env.OMA_MANAGED_AGENTS_WEBHOOK_SIGNING_KEY;
  const webhookWakeup = webhookUrl !== undefined && webhookKey !== undefined
    ? new StandardWebhookEnvironmentWorkWakeup({
        endpoint: webhookUrl,
        signingKey: webhookKey,
        organizationId: ({ workspaceId }) =>
          ctx.env.OMA_MANAGED_AGENTS_ORGANIZATION_ID ?? workspaceId,
        nextEventId: () => `whe_${crypto.randomUUID().replaceAll("-", "")}`,
      })
    : null;
  return createCloudflareManagedAgentsApp({
    workspaceId: ctx.var.tenant_id,
    sql: client,
    environmentWorkCipher: managedEnvironmentWorkCipherFor(ctx),
  }, {
    features: { preset: "none", environmentWork: true },
    clock: { now: () => new Date() },
    ids: {
      next: (namespace) =>
        `${namespace === "environment-work" ? "work" : namespace}_${crypto.randomUUID().replaceAll("-", "")}`,
    },
    modules: () => [
      providePort(
        environmentWorkEnvironmentSourcePort,
        managedSessionEnvironmentSource(client),
      ),
      providePort(
        environmentWorkAvailabilityWaiterPort,
        managedEnvironmentWorkAvailability,
      ),
      providePort(
        environmentWorkSessionCredentialIssuerPort,
        new SealedEnvironmentWorkSessionCredentialIssuer({
          crypto: new WebCryptoAesGcm(
            platformRootSecret,
            "managed.environment-work.session-token",
          ),
          now: () => new Date(),
          apiBaseUrl: new URL(ctx.req.url).origin,
        }),
      ),
      providePort(environmentWorkWakeupPort, {
        notifyRunStarted: async (input) => {
          if (webhookWakeup === null) return;
          ctx.executionCtx.waitUntil(
            webhookWakeup.notifyRunStarted(input).catch((err) => {
              logError(
                { op: "environment_work.webhook_failed", err },
                "Managed Agents webhook wake-up failed; poll fallback remains active",
              );
            }),
          );
        },
      }),
      environmentWorkEnqueuerModule(),
    ],
  });
}

function managedDeploymentsApplicationFor(ctx: AppCtx) {
  const client = new CfD1SqlClient(ctx.var.tenantDb);
  const workspaceId = ctx.var.tenant_id;
  const sessions = managedSessionsCompositionFor(ctx).portsFor(workspaceId);
  return createCloudflareManagedAgentsApp({
    workspaceId,
    sql: client,
    deploymentCipher: managedDeploymentCipherFor(ctx),
    modules: [
      providePort(deploymentAgentSourcePort, new SqlDeploymentAgentSource(client)),
      providePort(
        deploymentEnvironmentSourcePort,
        managedSessionEnvironmentSource(client),
      ),
      providePort(deploymentFileSourcePort, new SqlFileMetadataPersistence(client)),
      providePort(deploymentMemoryStoreSourcePort, new SqlMemoryStoreSource(client)),
      providePort(deploymentSchedulePlannerPort, managedDeploymentSchedulePlanner),
      providePort(deploymentSessionLauncherPort, sessions.deploymentSessionLauncher),
      providePort(deploymentVaultSourcePort, new SqlDeploymentVaultSource(client)),
    ],
  }, {
    features: {
      preset: "none",
      deploymentRuns: true,
      deployments: true,
    },
    clock: { now: () => new Date() },
    ids: {
      next: (namespace) =>
        `${namespace === "deployment" ? "depl" : namespace === "deployment-run" ? "drun" : namespace}_${crypto.randomUUID().replaceAll("-", "")}`,
    },
  });
}

const managedDeploymentsRoutes = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; user_id?: string };
}>().all("*", (c) => {
  const ctx = c as unknown as AppCtx;
  const port = managedDeploymentsApplicationFor(ctx)
    .port(managedAgentsPortTokens.deployments);
  return invokePackage(c, buildManagedDeploymentRoutes(() => port));
});

const managedDeploymentRunsRoutes = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; user_id?: string };
}>().all("*", (c) => {
  const ctx = c as unknown as AppCtx;
  const port = managedDeploymentsApplicationFor(ctx)
    .port(managedAgentsPortTokens.deploymentRuns);
  return invokePackage(c, buildManagedDeploymentRunRoutes(() => port));
});

const managedEnvironmentWorkRoutes = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; user_id?: string };
}>().all("*", (c) => {
  const ctx = c as unknown as AppCtx;
  const port = managedEnvironmentWorkApplicationFor(ctx)
    .port(managedAgentsPortTokens.environmentWork);
  return invokePackage(c, buildManagedEnvironmentWorkRoutes(() => port));
});

function managedDreamCuratorFor(ctx: AppCtx) {
  // No platform model key: each curation resolves the Dream workspace's own
  // model card for dream.model, exactly like a Session turn.
  return ctx.env.DREAM_CURATOR_MODE === "dedup"
    ? new DeduplicatingDreamCurator()
    : new AnthropicMessagesDreamCurator({
        resolveCredentials: cfDreamCredentialResolver(ctx.env),
      });
}
function managedDreamsApplicationFor(ctx: AppCtx) {
  const client = new CfD1SqlClient(ctx.var.tenantDb);
  const workspaceId = ctx.var.tenant_id;
  const memoryStoreSource = new SqlMemoryStoreSource(client);
  return createCloudflareManagedAgentsApp({
    workspaceId,
    sql: client,
  }, {
    features: {
      preset: "none",
      dreams: true,
      memories: true,
      memoryStores: true,
    },
    clock: { now: () => new Date() },
    ids: {
      next: (namespace) => `${
        namespace === "memory_store"
          ? "memstore"
          : namespace === "memory"
            ? "mem"
            : namespace === "memory-version"
              ? "memver"
              : "dream"
      }_${crypto.randomUUID().replaceAll("-", "")}`,
    },
    modules: () => [
      providePort(dreamMemoryStoreSourcePort, memoryStoreSource),
      providePort(memoryStoreForMemorySourcePort, memoryStoreSource),
      providePort(memoryContentDescriptorPort, managedMemoryContent),
      providePort(memoryVersionActorPort, {
        kind: "service_account",
        serviceAccountId: "dream_executor",
      }),
      providePort(dreamSessionSourcePort, new SqlSessionSource(client)),
      providePort(dreamCuratorPort, managedDreamCuratorFor(ctx)),
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
              workspaceId,
              memoryStores: port(managedAgentsPortTokens.memoryStores),
              memories: port(managedAgentsPortTokens.memories),
            }),
          )],
        }),
      }),
      dreamExecutionModule(),
      inProcessDreamExecutionSchedulerModule({
        defer: (task) => ctx.executionCtx.waitUntil(task),
      }),
    ],
  });
}

const managedDreamsRoutes = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; user_id?: string };
}>().all("*", (c) => {
  const ctx = c as unknown as AppCtx;
  const port = managedDreamsApplicationFor(ctx)
    .port(managedAgentsPortTokens.dreams);
  return invokePackage(c, buildManagedDreamRoutes(() => port));
});

const managedModelsRoutes = buildManagedModelRoutes((context) => {
  const request = context.var as AppCtx["var"];
  return createCloudflareManagedAgentsApp({
    workspaceId: request.tenant_id,
    sql: new CfD1SqlClient(request.tenantDb),
  }, {
    features: { preset: "none", models: true },
    modules: () => [providePort(
      modelCatalogSourcePort,
      new ModelCardCatalogSource(request.services.modelCards),
    )],
  }).port(managedAgentsPortTokens.models);
});

function managedTunnelsApplicationFor(ctx: AppCtx) {
  const provisioner = new LocalTunnelProvisioner({
      domainSuffix:
        (ctx.env as Env & { TUNNEL_DOMAIN_SUFFIX?: string })
          .TUNNEL_DOMAIN_SUFFIX ?? "tunnels.localhost",
      nextTokenId: () =>
        `ttok_${crypto.randomUUID().replaceAll("-", "")}`,
    });
  const tokens = new WebCryptoTunnelTokenManager({
      rootSecret: ctx.env.PLATFORM_ROOT_SECRET,
      nextTokenId: () =>
        `ttok_${crypto.randomUUID().replaceAll("-", "")}`,
    });
  const certificateAuthority = new WebCryptoTunnelCertificateAuthority();
  return createCloudflareManagedAgentsApp({
    workspaceId: ctx.var.tenant_id,
  }, {
    features: {
      preset: "none",
      tunnelCertificates: true,
      tunnels: true,
    },
    sql: new CfD1SqlClient(ctx.var.tenantDb),
    clock: { now: () => new Date() },
    ids: {
      next: (namespace) =>
        `${namespace === "tunnel" ? "tnl" : "tcrt"}_${crypto.randomUUID().replaceAll("-", "")}`,
    },
    modules: () => [
      providePort(tunnelProvisionerPort, provisioner),
      providePort(tunnelTokenManagerPort, tokens),
      providePort(tunnelCertificateAuthorityPort, certificateAuthority),
    ],
  });
}

const managedTunnelsRoutes = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; user_id?: string };
}>().all("*", (c) => {
  const ctx = c as unknown as AppCtx;
  const application = managedTunnelsApplicationFor(ctx);
  const tunnels = application.port(managedAgentsPortTokens.tunnels);
  const certificates = application.port(
    managedAgentsPortTokens.tunnelCertificates,
  );

  const packageApp = new Hono();
  packageApp.route("/", buildManagedTunnelRoutes(() => tunnels));
  packageApp.route(
    "/",
    buildManagedTunnelCertificateRoutes(() => certificates),
  );
  return invokePackage(c, packageApp);
});

/**
 * Forward the outer Hono request into a freshly-built package app while
 * preserving (a) auth/tenant vars set by middleware (passed via per-call
 * middleware injected on the inner app), and (b) the relative URL the
 * package routes expect (`/`, `/:id`, etc.) — Hono's `app.route` only
 * strips the prefix when matching, not from `req.url`.
 */
function invokePackage(
  c: import("hono").Context,
  packageApp: { fetch: (req: Request, env?: unknown, ctx?: ExecutionContext) => Response | Promise<Response> },
): Promise<Response> | Response {
  const url = new URL(c.req.url);
  // Strip the outer mount prefix so e.g. `/v1/agents/abc` becomes `/abc`
  // before the package's `app.get("/:id")` sees it.
  const knownPrefixes = ["/v1/oma/", "/v1/"];
  let stripped = url.pathname;
  for (const p of knownPrefixes) {
    if (stripped.startsWith(p)) {
      // Drop the next path segment (resource name like "agents", "sessions").
      const rest = stripped.slice(p.length);
      const slashIdx = rest.indexOf("/");
      stripped = slashIdx === -1 ? "/" : rest.slice(slashIdx);
      break;
    }
  }
  url.pathname = stripped || "/";

  // Carry the outer auth vars (tenant_id, user_id) over the request via
  // headers so the inner app's middleware can re-hydrate them. Header
  // names are namespaced so they can't collide with user-controlled
  // headers; a stray client-supplied `x-oma-tenant-id` is overwritten.
  const headers = new Headers(c.req.raw.headers);
  const tenantId = (c.var as { tenant_id?: string }).tenant_id;
  const userId = (c.var as { user_id?: string }).user_id;
  if (tenantId) headers.set("x-oma-internal-tenant-id", tenantId);
  if (userId) headers.set("x-oma-internal-user-id", userId);

  // One-shot middleware: re-hydrate vars on the inner context.
  const wrapped = new Hono();
  wrapped.use("*", async (innerC, next) => {
    const t = headers.get("x-oma-internal-tenant-id");
    const u = headers.get("x-oma-internal-user-id");
    if (t) innerC.set("tenant_id" as never, t as never);
    if (u) innerC.set("user_id" as never, u as never);
    await next();
  });
  wrapped.route("/", packageApp as Parameters<typeof wrapped.route>[1]);

  return wrapped.fetch(
    new Request(url, {
      method: c.req.method,
      headers,
      body: ["GET", "HEAD"].includes(c.req.method) ? null : c.req.raw.body,
    }),
    c.env,
    c.executionCtx,
  );
}
app.route("/v1/agents", managedAgentsRoutes);
app.route("/v1/oma/agents", legacyAgentsRoutes);
app.route("/v1/environments", managedEnvironmentsRoutes);
app.route("/v1/environments", managedEnvironmentWorkRoutes);
app.route("/v1/oma/environments", legacyEnvironmentsRoutes);
// OpenAI compatibility shares the same tenant-scoped application ports as /v1.
// Keep API requests ahead of the Console asset fallback.
app.use("/openai/*", async (c, next) => {
  await next();
  c.res = await normalizeOpenAIAgentsErrorResponse(c.res);
});
app.use("/openai/*", authMiddleware);
app.use("/openai/*", rateLimitMiddleware);
app.use("/openai/*", tenantDbMiddleware);
app.use("/openai/*", servicesMiddleware);
app.route("/openai", buildOpenAIAgentsProtocolApi(context => {
  const ctx = context as unknown as AppCtx;
  const workspaceId = ctx.var.tenant_id;
  if (!workspaceId) throw new OpenAIAgentsProtocolError(401, "Authentication required");
  const credential = ctx.var.auth_credential;
  if (credential && credential.type !== "workspace") throw new OpenAIAgentsProtocolError(403, "This credential cannot access the Agents API");
  const application = managedCoreApplicationFor(ctx);
  const agents = application.port(managedAgentsPortTokens.agents);
  const environments = application.port(managedAgentsPortTokens.environments);
  const native = managedSessionsCompositionFor(ctx).portsFor(workspaceId);
  const secrets = new CfManagedSessionSecretSealer(ctx.env.PLATFORM_ROOT_SECRET);
  const blobs = ctx.var.services.filesBlob;
  if (!blobs) throw new OpenAIAgentsProtocolError(503, "File storage is unavailable");
  const files = managedFilesApplicationFor({ workspaceId, tenantDb: ctx.var.tenantDb, blobs });
  const resources = createResourcesHandler({
    agents, environments, files, secrets,
    vaults: managedVaultsPortFor(ctx), credentials: managedCredentialsPortFor(ctx),
  });
  const artifacts = createArtifactsHandler({
    files,
    requireSession: async sessionId => {
      const found = await native.sessions.retrieveSession({ sessionId });
      if (found.type !== "found") throw new OpenAIAgentsProtocolError(404, "Session not found");
    },
  });
  const sessions = createSessionsHandler({
    workspaceId, sessions: native.sessions, sessionEvents: native.sessionEvents,
    history: new SessionRuntimeHistoryApplicationService({ workspaceId, source: new SqlSessionRuntimeHistorySource(new CfD1SqlClient(ctx.var.tenantDb)) }),
    mapping: createManagedSessionMapping({ agents, environments, resources, secrets, runtime: createSandboxOptionalSessionMapping(environments) }),
    resources: { execute: artifacts },
  });
  return { execute: request => request.operation.startsWith("sessions.") ? sessions.execute(request) : resources(request) };
}));
app.all("/openai/*", c => c.json({ error: {
  message: "Unknown API endpoint", type: "invalid_request_error", param: null, code: "resource_not_found",
} }, 404));

app.route("/v1/sessions", managedSessionsRoutes);
// Managed Session sandbox exec (same contract as Node): evaluation grades in
// the Session's own sandbox after the agent's turn. Mounted ahead of the
// legacy /v1/oma/sessions routes, whose `/:id/exec` stays separate.
app.route("/v1/oma/sessions", buildCfManagedSandboxExecRoutes({
  workspaceId: (c) => (c as unknown as AppCtx).var.tenant_id,
  retrieveSession: async (c, sessionId) => {
    const ctx = c as unknown as AppCtx;
    const found = await managedSessionsCompositionFor(ctx)
      .portsFor(ctx.var.tenant_id).sessions.retrieveSession({ sessionId });
    return found.type === "found" ? found.session : null;
  },
  environmentType: async (c, environmentId) => {
    const ctx = c as unknown as AppCtx;
    const environment = await managedSessionEnvironmentSource(new CfD1SqlClient(ctx.var.tenantDb))
      .find({ workspaceId: ctx.var.tenant_id, environmentId });
    return environment === null ? null : environment.config.type;
  },
  fetcher: (c) => new CfManagedRuntimeFetcher((c as unknown as AppCtx).env),
}));
app.route("/v1/oma/sessions", managedRuntimeIngressRoutes);
app.route("/v1/oma/sessions", managedSessionQueueRoutes);
app.route("/v1/oma/sessions", legacySessionsRoutes);
app.route("/v1/vaults", managedVaultsRoutes);
app.route("/v1/vaults", managedCredentialsRoutes);
app.route("/v1/user_profiles", managedUserProfilesRoutes);
// OpenMA extension, mounted ahead of the legacy catch-all Vault router.
app.route("/v1/oma/vaults", managedCapCliDeviceFlowRoutes);
app.route("/v1/oma/vaults", legacyVaultsRoutes);
app.route("/v1/oma/cap-cli/oauth", capCliOauthRoutes);
app.route("/v1/memory_stores", managedMemoryStoresRoutes);
app.route("/v1/memory_stores", managedMemoriesRoutes);
app.route("/v1/memory_stores", managedMemoryVersionsRoutes);
app.route("/v1/oma/memory_stores", legacyMemoryRoutes);
app.route("/v1/skills", managedSkillsRoutes);
app.route("/v1/skills", managedSkillVersionsRoutes);
app.route("/v1/deployments", managedDeploymentsRoutes);
app.route("/v1/deployment_runs", managedDeploymentRunsRoutes);
app.route("/v1/dreams", managedDreamsRoutes);
app.route("/v1/oma/dreams", dreamsRoutes);
app.route("/v1/tunnels", managedTunnelsRoutes);
app.route("/v1/models", managedModelsRoutes);
app.route("/v1/files", managedFilesRoutes);
app.route("/v1/oma/files", legacyFilesRoutes);
app.route("/v1/oma/skills", legacySkillsRoutes);
app.route("/v1/oma/models", buildOmaModelsHttpRoutes({
  fetch: (input, init) => fetch(input, init),
}));
app.route("/v1/oma/stats", statsRoutes);

// HTTP MCP gateway accepts either the local bridge's workspace bearer or the
// current Work-scoped sessions_token. authMiddleware resolves both; the route
// then validates that the requested server belongs to the same Session.
app.route("/v1/oma/mcp-proxy", mcpProxyRoutes);
app.route("/v1/oma/inference-proxy", inferenceProxyRoutes);

// /v1/oma/* aliases — OMA-only namespaces re-mounted under an `oma/` prefix
// so the public surface can grow into a clean two-tier API:
//   /v1/<resource>      — Anthropic-compatible (agents, sessions, vaults, ...)
//   /v1/oma/<resource>  — OMA-specific extensions (oauth, tenants, evals, ...)
//
// New code (and external callers) should prefer the /v1/oma/* paths.
// Internal Console/CLI keep using the bare paths until follow-up cleanup
// (the bare mounts above stay live for now). New OMA-only endpoints should
// be added here only, not above.
app.route("/v1/oma/clawhub", clawhubRoutes);
app.route("/v1/oma/api_keys", apiKeysRoutes);
app.route("/v1/oma/me", meRoutes);
app.route("/v1/oma/tenants", tenantsRoutes);
app.route("/v1/oma/evals", evalsRoutes);
app.route("/v1/oma/cost_report", costReportRoutes);
app.route("/v1/oma/integrations", integrationsRoutes);
app.route("/v1/oma/runtimes", runtimesRoutes);
app.route("/v1/oma/oauth/cli", managedMcpOAuthCliRoutes);
app.route("/v1/oma/oauth", managedMcpOAuthRoutes);
app.route("/v1/oma/model_cards", modelCardsRoutes);
// Operator SANDBOX_IMAGES catalog: each alias is a container class the
// operator declared in apps/agent/wrangler.jsonc (docs/cloudflare-sandbox-images.md).
// Empty when unset, in which case `_oma.sandbox_image` is rejected.
app.route("/v1/oma/sandbox_images", buildSandboxImageRoutes({ list: () => workerSandboxImages().list() }));
// /v1/oma/mcp-proxy is intentionally NOT aliased: auth.ts path-prefix skip is
// scoped to that exact prefix, and the proxy does its own session-ownership
// check downstream. Re-mounting under /v1/oma/mcp-proxy would route through
// the standard authMiddleware and break the ACP child's transport.
// Daemon-facing routes — outside /v1/* so authMiddleware doesn't run.
// Apply tenantDbMiddleware + servicesMiddleware so daemon endpoints (like
// /agents/runtime/sessions/:sid/bundle) can use c.get("services").
app.use("/agents/runtime/*", tenantDbMiddleware);
app.use("/agents/runtime/*", servicesMiddleware);
app.route("/agents/runtime", runtimeDaemonRoutes);

// /agents/runtime/_attach — WebSocket upgrade for `oma bridge daemon`. We
// validate the runtime bearer token here, then forward to the RuntimeRoom
// DO with x-runtime-id / x-runtime-user headers it trusts.
app.get("/agents/runtime/_attach", async (c) => {
  if (c.req.header("Upgrade") !== "websocket") {
    return c.text("WebSocket only", 400);
  }
  if (!c.env.RUNTIME_ROOM) return c.text("RUNTIME_ROOM binding missing", 503);
  const auth = c.req.header("authorization") ?? "";
  const ok = await authenticateRuntimeToken(c.env, auth);
  if (!ok) return c.text("unauthorized", 401);
  const stub = c.env.RUNTIME_ROOM.get(c.env.RUNTIME_ROOM.idFromName(ok.runtime_id));
  const fwd = new Request(c.req.raw);
  fwd.headers.set("x-attach-role", "daemon");
  fwd.headers.set("x-runtime-id", ok.runtime_id);
  fwd.headers.set("x-runtime-user", ok.user_id);
  return stub.fetch(fwd);
});

// Internal endpoints (NOT auth-middleware'd; secured by header secret inside
// the route file). Called only by the integrations gateway worker via service
// binding.
app.route("/v1/oma/internal", internalRoutes);

// Proxy public integrations gateway paths to the INTEGRATIONS service binding
// so Linear/GitHub can hit the OAuth callback / webhook URLs at this worker's
// host. (Local dev convenience: avoids running integrations on a separate port.)
app.all("/linear/*", async (c) => {
  if (!c.env.INTEGRATIONS) return c.json({ error: "INTEGRATIONS binding missing" }, 503);
  return c.env.INTEGRATIONS.fetch(c.req.raw);
});
app.all("/linear-setup/*", async (c) => {
  if (!c.env.INTEGRATIONS) return c.json({ error: "INTEGRATIONS binding missing" }, 503);
  return c.env.INTEGRATIONS.fetch(c.req.raw);
});
app.all("/github/*", async (c) => {
  if (!c.env.INTEGRATIONS) return c.json({ error: "INTEGRATIONS binding missing" }, 503);
  return c.env.INTEGRATIONS.fetch(c.req.raw);
});
app.all("/github-setup/*", async (c) => {
  if (!c.env.INTEGRATIONS) return c.json({ error: "INTEGRATIONS binding missing" }, 503);
  return c.env.INTEGRATIONS.fetch(c.req.raw);
});

export default {
  fetch: app.fetch,
  // Cron entry — wrangler `triggers.crons` ticks every minute (`* * * * *`).
  // We rebuild the scheduler per tick (CF isolates are short-lived; the
  // builder is cheap), then dispatch by matching `controller.cron`.
  // Each registered handler runs under ctx.waitUntil so a slow tick
  // doesn't block the runtime.
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const scheduler = buildCfScheduler(env);
    for (const job of scheduler.list()) {
      if (job.cron !== controller.cron) continue;
      ctx.waitUntil(
        Promise.resolve(job.handler()).catch((err) => {
          logError({ op: `cron.${job.name}`, err }, `cron job ${job.name} failed`);
          recordEvent(env.ANALYTICS, {
            op: `cron.${job.name}.failed`,
            ...errFields(err),
          });
        }),
      );
    }
  },
  // Cloudflare Queue consumer for R2 Event Notifications on MEMORY_BUCKET.
  // The runtime-agnostic dispatcher routes to the main consumer or the
  // DLQ subscriber based on `batch.queue`. Handler bodies live in
  // packages/queue/handlers/* (main) and lib/cf-queue-handlers.ts (DLQ
  // notification + AE recording, which is CF-specific plumbing).
  async queue(batch: MessageBatch<R2EventMessage>, env: Env, _ctx: ExecutionContext): Promise<void> {
    const q = buildCfMemoryQueue(env);
    await dispatchCfMemoryQueueBatch(batch, q);
  },
};

// DO classes must be re-exported from the worker entry so wrangler can find
// them by class_name in durable_objects.bindings + migrations.
export { RuntimeRoom } from "./runtime-room";

/** Tenant D1 behind @open-managed-agents/sandbox-gateway (design §0.7). */
function cfSandboxGatewayStores(env: Env): SandboxGatewayStores {
  return async (workspaceId) => createSqlSandboxGatewayStore(new CfD1SqlClient(await buildCfTenantDbProvider(env).resolve(workspaceId)));
}

/** True while `fence` still owns its running execution in tenant D1. Main
 * revalidates this before every fenced mutation requested by a SessionDO.
 * The shared check (design §0.0 rule 10), scoped to the calling Session. */
async function cfExecutionFenceActive(
  client: CfD1SqlClient,
  scope: { tenantId: string; sessionId: string },
  fence: import("@open-managed-agents/session-runtime-contract/coordination").SessionExecutionFence,
): Promise<boolean> {
  if (fence.workspaceId !== scope.tenantId || fence.sessionId !== scope.sessionId) return false;
  return isSessionExecutionFenceActive(createSqlSessionExecutionLeases(client), fence);
}

/**
 * RPC entrypoint for the agent worker (cloud agent path) to forward MCP
 * requests through main's credential-injection layer without exposing the
 * vault to the agent's DO.
 *
 * Mirrors Anthropic Managed Agents' "credential proxy outside the harness"
 * design: the agent worker (the harness) only knows session_id +
 * server_name; the actual vault lookup, token injection, and upstream call
 * happen here in main, where the secrets already live. This means a
 * cloud-side prompt-injection attack against the agent's DO cannot read
 * any vault credential because the DO doesn't hold one.
 *
 * Auth model: this class is reachable only via wrangler service-binding
 * declarations — Workers without an explicit `services[].entrypoint` block
 * pointing at "McpProxyRpc" cannot invoke `mcpForward`. The binding itself
 * is the authentication primitive; no shared secret needed. The agent
 * worker passes `tenantId` because it has it from the SessionDO context;
 * we trust it the same way we'd trust any in-process function call from
 * sibling code, since the binding scope establishes that the caller is
 * our own deployment.
 *
 * Local-runtime path (claude-agent-acp daemon) keeps using the public
 * /v1/oma/mcp-proxy/<sid>/<server> HTTP endpoint with apiKey auth — the
 * daemon doesn't have a service binding, so it has to authenticate the
 * old way. Both paths run the same gateway, `@open-managed-agents/http-routes/proxy`
 * (composed for Cloudflare in routes/mcp-proxy.ts).
 */
export class McpProxyRpc extends WorkerEntrypoint<Env> {
  async resolveManagedSessionInputs(opts: {
    tenantId: string;
    sessionId: string;
  }) {
    const tenantDb = await buildCfTenantDbProvider(this.env).resolve(opts.tenantId);
    const canonical = await withMissingManagedSessionSchemaFallback(
      () => resolveManagedSessionInputs(
        new SqlSessionSource(new CfD1SqlClient(tenantDb)),
        { workspaceId: opts.tenantId, sessionId: opts.sessionId },
      ),
      async () => ({ type: "not_found" as const }),
    );
    if (canonical.type === "found") {
      const sandboxMode = await resolveSessionSandboxMode(
        { ...canonical.session, metadata: { ...canonical.session.metadata } },
        new CfManagedSessionSecretSealer(this.env.PLATFORM_ROOT_SECRET),
      );
      return { ...canonical, session: { ...canonical.session, sandboxMode } };
    }

    // Compatibility lane for `/v1/oma` Sessions. The fallback remains in
    // the main control plane; the sandbox worker never reads D1/KV directly.
    const services = await getCfServicesForTenant(this.env, opts.tenantId);
    const legacy = await services.sessions
      .get({ tenantId: opts.tenantId, sessionId: opts.sessionId })
      .catch(() => null);
    if (legacy === null || legacy.archived_at !== null) {
      return { type: "not_found" as const };
    }
    const rows = await services.sessions.listResourcesBySession({
      sessionId: opts.sessionId,
    });
    const metadata = Object.fromEntries(
      Object.entries(legacy.metadata ?? {}).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    return {
      type: "found" as const,
      session: {
        id: legacy.id,
        environmentId: legacy.environment_id ?? "",
        metadata,
        resources: rows.map((row) => ({
          ...row.resource,
          id: row.id,
        })),
      },
    };
  }

  /**
   * CLI placeholder environment (cap spec `bootstrap.env`) for a v1 managed
   * Session's sandbox, from the session's managed `environment_variable` and
   * `cap_cli` credentials. Per-Session placeholders only; real values stay
   * here and are substituted at egress (design §0.1, §8.4).
   * `not_found` means the session is not a managed one.
   */
  async resolveManagedCapCliEnvironment(opts: {
    tenantId: string;
    sessionId: string;
  }): Promise<{ type: "found"; env: Record<string, string> } | { type: "not_found" }> {
    const tenantDb = await buildCfTenantDbProvider(this.env).resolve(opts.tenantId);
    // Look the session up before touching the managed credential store, so a
    // legacy `/v1/oma` Session never depends on managed-only configuration
    // (PLATFORM_ROOT_SECRET) and keeps its previous warmup behaviour.
    const session = await withMissingManagedSessionSchemaFallback(
      () => new SqlSessionSource(new CfD1SqlClient(tenantDb))
        .find({ workspaceId: opts.tenantId, sessionId: opts.sessionId }),
      async () => null,
    );
    if (session === null || session.archivedAt !== null) {
      return { type: "not_found" };
    }
    if (session.vaultIds.length === 0) return { type: "found", env: {} };
    return {
      type: "found",
      env: await createManagedCredentialResolver(this.env, tenantDb).placeholderEnvironment({
        workspaceId: opts.tenantId,
        sessionId: opts.sessionId,
        vaultIds: session.vaultIds,
      }),
    };
  }

  async downloadManagedSessionFile(opts: {
    tenantId: string;
    sessionId: string;
    fileId: string;
  }) {
    const tenantDb = await buildCfTenantDbProvider(this.env).resolve(opts.tenantId);
    const services = await getCfServicesForTenant(this.env, opts.tenantId);
    const filesBlob = services.filesBlob;
    if (filesBlob === null) {
      throw new Error("FILES_BUCKET binding is required for managed Files");
    }
    const client = new CfD1SqlClient(tenantDb);
    const canonical = await withMissingManagedSessionSchemaFallback(
      () => downloadManagedSessionInputFile(
        new SqlSessionSource(client),
        managedFilesApplicationFor({
          workspaceId: opts.tenantId,
          tenantDb,
          blobs: filesBlob,
        }),
        {
          workspaceId: opts.tenantId,
          sessionId: opts.sessionId,
          fileId: opts.fileId,
        },
      ),
      async () => ({ type: "not_found" as const }),
    );
    if (canonical.type === "found") return canonical;

    const legacyResources = await services.sessions
      .listResources({ tenantId: opts.tenantId, sessionId: opts.sessionId })
      .catch(() => []);
    if (!legacyResources.some(
      (row) => row.resource.type === "file"
        && row.resource.file_id === opts.fileId,
    )) {
      return { type: "not_found" as const };
    }
    const object = await filesBlob.get(
      fileR2Key(opts.tenantId, opts.fileId),
    );
    if (object === null) return { type: "not_found" as const };
    return {
      type: "found" as const,
      content: await object.bytes(),
      mimeType: object.httpMetadata?.contentType ?? "application/octet-stream",
    };
  }

  async materializeManagedMemorySnapshot(opts: {
    tenantId: string;
    sessionId: string;
    memoryStoreId: string;
    access: "read_only" | "read_write";
    runtimeGeneration?: string;
  }) {
    const tenantDb = await buildCfTenantDbProvider(this.env).resolve(opts.tenantId);
    const client = new CfD1SqlClient(tenantDb);
    const sessionSource = new SqlSessionSource(client);
    const canonicalSession = await withMissingManagedSessionSchemaFallback(
      () => resolveManagedSessionInputs(sessionSource, {
        workspaceId: opts.tenantId,
        sessionId: opts.sessionId,
      }),
      async () => ({ type: "not_found" as const }),
    );
    if (canonicalSession.type === "found") {
      if (this.env.MEMORY_BUCKET === undefined) {
        throw new Error("MEMORY_BUCKET binding is required for Managed Memory snapshots");
      }
      const memories = managedMemoriesApplication(opts.tenantId, tenantDb)
        .port(managedAgentsPortTokens.memories);
      const snapshots = new ManagedMemorySnapshotMaterializer(memories, {
        getText: async (key) => {
          const object = await this.env.MEMORY_BUCKET!.get(key);
          return object === null ? null : object.text();
        },
        put: async (key, content) => {
          const object = await this.env.MEMORY_BUCKET!.put(key, content);
          return object ?? { key };
        },
      });
      return materializeManagedSessionMemorySnapshot(
        sessionSource,
        snapshots,
        {
          workspaceId: opts.tenantId,
          sessionId: opts.sessionId,
          memoryStoreId: opts.memoryStoreId,
          access: opts.access,
          ...(opts.runtimeGeneration === undefined
            ? {}
            : { runtimeGeneration: opts.runtimeGeneration }),
        },
      );
    }

    // Legacy `/v1/oma` Memory Stores already use their mutable R2 prefix as
    // bytes-of-truth, so no canonical snapshot projection is required.
    const services = await getCfServicesForTenant(this.env, opts.tenantId);
    const resources = await services.sessions
      .listResources({ tenantId: opts.tenantId, sessionId: opts.sessionId })
      .catch(() => []);
    return resources.some(
      (row) => row.resource.type === "memory_store"
        && row.resource.memory_store_id === opts.memoryStoreId,
    )
      ? { type: "found" as const, mountStoreId: opts.memoryStoreId }
      : { type: "not_found" as const };
  }

  async synchronizeManagedMemorySnapshots(opts: {
    tenantId: string;
    sessionId: string;
    runtimeGeneration: string;
    executionFence: import("@open-managed-agents/session-runtime-contract/coordination").SessionExecutionFence;
  }) {
    if (this.env.MEMORY_BUCKET === undefined) {
      throw new Error("MEMORY_BUCKET binding is required for Managed Memory synchronization");
    }
    const tenantDb = await buildCfTenantDbProvider(this.env).resolve(opts.tenantId);
    const client = new CfD1SqlClient(tenantDb);
    const memories = managedMemoriesApplication(opts.tenantId, tenantDb)
      .port(managedAgentsPortTokens.memories);
    const bucket = this.env.MEMORY_BUCKET;
    return synchronizeManagedSessionMemoryWorkspaces(
      new SqlSessionSource(client),
      memories,
      {
        getText: async (key) => {
          const object = await bucket.get(key);
          return object === null ? null : object.text();
        },
        list: async (prefix, cursor) => {
          const page = await bucket.list({
            prefix,
            limit: 1_000,
            ...(cursor === undefined ? {} : { cursor }),
          });
          return {
            keys: page.objects.map((object) => object.key),
            nextCursor: page.truncated ? page.cursor : null,
          };
        },
        put: async (key, content) => (await bucket.put(key, content)) ?? { key },
        delete: async (key) => bucket.delete(key),
      },
      {
        workspaceId: opts.tenantId,
        sessionId: opts.sessionId,
        runtimeGeneration: opts.runtimeGeneration,
        executionFence: opts.executionFence,
        isFenceActive: (fence) => cfExecutionFenceActive(client, opts, fence),
      },
    );
  }

  /** ACP model / MCP channels for one SessionDO execution (design §0.6). */
  async issueManagedAcpExecutionChannels(opts: Parameters<typeof issueCfAcpExecutionChannels>[1]) {
    return issueCfAcpExecutionChannels(this.env, opts);
  }

  /** A sandbox token for the in-sandbox egress forwarder (#561) of the
   * SessionDO's current execution attempt. `harness` is the agent's harness
   * name: it fixes the scope (sandboxHarnessPlacement). */
  async issueSandboxEgressToken(opts: { tenantId: string; sessionId: string; attempt: SessionExecutionAttemptRef; harness: string | null }): Promise<string> {
    if (opts.attempt.workspaceId !== opts.tenantId || opts.attempt.sessionId !== opts.sessionId) {
      throw new Error("Sandbox token fence does not name this Session");
    }
    return issueSandboxToken(cfSandboxTokenStore(this.env), opts.attempt, {
      scope: sandboxTokenScopeFor(sandboxHarnessPlacement(opts.harness)),
    });
  }

  async resolveManagedSkillVersion(opts: {
    tenantId: string;
    skillId: string;
    requestedVersion: string;
  }) {
    const tenantDb = await buildCfTenantDbProvider(this.env).resolve(opts.tenantId);
    const versions = managedSkillsApplication(opts.tenantId, tenantDb)
      .port(managedAgentsPortTokens.skillVersions);
    return resolveManagedSkillArchive(versions, opts);
  }

  /**
   * Agents API artifact publication for a SessionDO execution whose terminal
   * just committed, while it still holds its fence (same contract as the
   * Node runner's `afterExecution`). Runs here because only main can open
   * the Session's sealed Agents API mapping; the DO passes its sandbox's
   * `/workspace/outputs` as RPC callbacks, read only for unpublished paths.
   */
  async publishManagedSessionArtifacts(opts: {
    tenantId: string;
    sessionId: string;
    executionFence: import("@open-managed-agents/session-runtime-contract/coordination").SessionExecutionFence;
    /** `find ./outputs -type f -print0 | base64` run in `/workspace`. */
    outputManifest: () => Promise<string>;
    readOutput: (path: string) => Promise<Uint8Array>;
  }): Promise<{ type: "published" } | { type: "not_found" }> {
    const tenantDb = await buildCfTenantDbProvider(this.env).resolve(opts.tenantId);
    const client = new CfD1SqlClient(tenantDb);
    const session = await new SqlSessionSource(client).find({ workspaceId: opts.tenantId, sessionId: opts.sessionId });
    if (session === null) return { type: "not_found" };
    const blobs = (await getCfServicesForTenant(this.env, opts.tenantId)).filesBlob;
    if (blobs === null) throw new Error("FILES_BUCKET binding is required for Agents API artifacts");
    const secrets = new CfManagedSessionSecretSealer(this.env.PLATFORM_ROOT_SECRET);
    await createOpenAIArtifactPublisher({
      historyForWorkspace: (workspaceId) => new SessionRuntimeHistoryApplicationService({ workspaceId, source: new SqlSessionRuntimeHistorySource(client) }),
      filesForWorkspace: (workspaceId) => managedFilesApplicationFor({ workspaceId, tenantDb, blobs }),
      environmentType: async (candidate) => (await readManagedSessionMappingMetadata(candidate, secrets))?.environment.type ?? null,
      isFenceActive: (fence) => cfExecutionFenceActive(client, opts, fence),
      environmentId: (candidate) => `oai_env_${candidate.id}`,
    })({
      workspaceId: opts.tenantId,
      session,
      executionFence: opts.executionFence,
      // Main validates the DO-supplied manifest: paths stay in /workspace/outputs.
      outputs: { listPaths: async () => outputPathsFromManifest(await opts.outputManifest()), read: (path) => opts.readOutput(path) },
    });
    return { type: "published" };
  }

  async managedSessionEventProduced(opts: {
    workspaceId: string;
    sessionId: string;
    event: string;
    executionFence?: import("@open-managed-agents/session-runtime-contract/coordination").SessionExecutionFence;
  }): Promise<
    | { type: "recorded" }
    | { type: "ignored" }
    | { type: "not_found" }
    | { type: "execution_fence_lost" }
    | { type: "version_conflict" }
  > {
    let raw: unknown;
    try {
      raw = JSON.parse(opts.event);
    } catch {
      return { type: "ignored" };
    }
    const event = decodeRuntimeProducedSessionEvent(raw);
    if (event === null) return { type: "ignored" };
    const tenantDb = await buildCfTenantDbProvider(this.env).resolve(
      opts.workspaceId,
    );
    const persistence = new SqlSessionRuntimeProjectionPersistence(
      new CfD1SqlClient(tenantDb),
    );
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await new SessionRuntimeProjectionApplicationService({
        workspaceId: opts.workspaceId,
        persistence,
      }).recordSessionRuntimeEvents({
        sessionId: opts.sessionId,
        events: [event],
        ...(opts.executionFence !== undefined && {
          executionFence: opts.executionFence,
        }),
      });
      if (result.type === "recorded") return { type: "recorded" };
      if (result.type === "not_found") return { type: "not_found" };
      if (result.type === "execution_fence_lost") return { type: "execution_fence_lost" };
      // Shared keep-first semantics: the first recorded body stands and the
      // replay is a no-op (persistence already logged the collision).
      if (result.type === "event_id_collision") return { type: "ignored" };
    }
    return { type: "version_conflict" };
  }

  async managedSessionEventsMarkProcessed(opts: {
    workspaceId: string;
    sessionId: string;
    eventIds: string[];
    processedAt: string;
    consumedByExecutionId?: string;
  }): Promise<
    | { type: "marked"; events: unknown[] }
    | { type: "not_found" }
  > {
    const tenantDb = await buildCfTenantDbProvider(this.env).resolve(
      opts.workspaceId,
    );
    const store = new SqlSessionEventPersistence(new CfD1SqlClient(tenantDb));
    const marked = await store.markProcessed(opts);
    return { type: "marked", events: marked };
  }

  async mcpForward(opts: {
    tenantId: string;
    sessionId: string;
    serverName: string;
    method: string;
    /** Inbound headers from the MCP client. The Authorization header here is
     *  the agent worker's own token (or empty); we always overwrite it with
     *  the upstream credential before forwarding. */
    headers: Record<string, string>;
    /** Stringified JSON-RPC body for POST. Empty / null for GET. */
    body: string | null;
  }): Promise<{
    status: number;
    headers: Record<string, string>;
    body: string;
  }> {
    const res = await forwardMcpProxyRequest(await mcpProxyPortsFor(this.env, opts.tenantId), {
      workspaceId: opts.tenantId,
      sessionId: opts.sessionId,
      serverName: opts.serverName,
      method: opts.method,
      headers: new Headers(opts.headers),
      body: async () => opts.body,
      callerKind: "rpc-mcp",
    });
    const respHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      respHeaders[k] = v;
    });
    return {
      status: res.status,
      headers: respHeaders,
      body: await res.text(),
    };
  }

  /**
   * Transparent HTTP proxy for cloud agent MCP traffic. Agent's tools.ts
   * gives the official MCP HTTP adapter a custom fetch that calls
   * `env.MAIN_MCP.fetch(req)` after stamping three metadata headers:
   *   - `x-oma-tenant`
   *   - `x-oma-session`
   *   - `x-oma-mcp-server`
   * The shared gateway resolves the Vault credential by `serverName`
   * (inline `authorization_token` still works), withholds the metadata and
   * the caller's own credentials, injects the upstream bearer, and forwards.
   * Body / response status / response headers (including rotated
   * `Mcp-Session-Id`) stream through unchanged.
   *
   * Vault credentials remain main-only — agent worker only sees the
   * Response. The official SDK transport handles Streamable-HTTP session
   * id rotation, SSE response framing, retries — none of that lives
   * in this Worker anymore. The hand-rolled BindingMCPTransport that
   * preceded this dropped session ids and broke session-ful servers
   * (Notion's tools/list never returned, hanging the whole turn).
   *
   * A 401 from a refreshable credential is refreshed and retried once, with
   * the request body buffered up front so the retry can replay it.
   */
  async fetch(request: Request): Promise<Response> {
    return createMcpProxyBinding((workspaceId) => mcpProxyPortsFor(this.env, workspaceId)).fetch(request);
  }

  /** Native outbound adapter transport for the shared HTTPS relay core.
   * The fenced binding is the caller's authority, so no relay pass is minted.
   * Only requests and responses cross this boundary, never Vault tokens. */
  async credentialEgress(scope: {
    tenantId: string; sessionId: string;
    runtimeFence?: { environmentId: string; workId: string; ownerId: string; generation: number; token: string };
    executionFence?: { executionId: string; attemptId: string; ownerId: string; generation: number };
  }, action: "resolve" | "forward", request: Request): Promise<Response> {
    const { createCredentialEgressCore, credentialEgressDenied } = await import("@open-managed-agents/managed-credential-resolver");
    if (!this.env.PLATFORM_ROOT_SECRET) return new Response("Credential relay unavailable", { status: 503 });
    const db = await buildCfTenantDbProvider(this.env).resolve(scope.tenantId);
    let authorize: () => Promise<{ vaultIds: readonly string[] } | null>;
    if (scope.runtimeFence !== undefined) {
      // Self-hosted Environment Work has no execution attempt (ADR 0005, the
      // exception in design §0.0 rule 10): its fence is the authority.
      const fence: EnvironmentWorkFenceRef = { workspaceId: scope.tenantId, sessionId: scope.sessionId, ...scope.runtimeFence };
      const fences = new SqlRuntimeResourceFencePort(new CfD1SqlClient(this.env.MAIN_DB));
      if (!await isEnvironmentWorkFenceCurrent(fences, fence)) return new Response("Credential relay denied", { status: 403 });
      const sessions = new SqlSessionSource(new CfD1SqlClient(db));
      authorize = () => authorizeEnvironmentWorkEgress(fences, (input) => sessions.find(input), fence);
    } else {
      // A Session sandbox: only while its execution attempt is current. No
      // attempt (between turns, warmup before the first turn) → no Vault.
      const fence = scope.executionFence === undefined ? null : { workspaceId: scope.tenantId, sessionId: scope.sessionId, ...scope.executionFence };
      const stores = cfSandboxGatewayStores(this.env);
      authorize = () => authorizeSandboxEgress(stores, fence);
      if (await authorize() === null) return credentialEgressDenied(403);
    }
    const body = action === "forward" && !["GET", "HEAD"].includes(request.method) ? await request.arrayBuffer() : null;
    // Re-check after buffering, immediately before injecting.
    const session = await authorize();
    if (session === null) return credentialEgressDenied(403);
    const core = createCredentialEgressCore({ credentials: createManagedCredentialResolver(this.env, db), send: req => fetch(req), log: { warn: (fields, message) => logWarn(fields, message) } });
    const egressScope = { workspaceId: scope.tenantId, sessionId: scope.sessionId, vaultIds: session.vaultIds };
    return action === "resolve"
      ? core.resolve(egressScope, request.url)
      : core.forward(egressScope, { target: request.url, method: request.method, headers: request.headers, body });
  }

  /**
   * Per-repo GitHub credential lookup for the network-layer proxy.
   *
   * Returns:
   *   - null  → no credential available (caller passes through unauth'd):
   *             host isn't a GitHub host we route, OR session is gone /
   *             archived, OR session has no github_repository resources
   *   - {...} → the chosen token + scheme + owner/repo slug. Slug is for
   *             log correlation; the token never lands in any log.
   *
   * Pick rule: path-matched resource if the request URL has owner/repo
   * AND it matches a resource; otherwise the first declared resource's
   * token. See `resolveGithubCredentials` for the trade-off rationale.
   */
  async lookupGithubCredential(opts: {
    tenantId: string;
    sessionId: string;
    hostname: string;
    pathname: string;
    runtimeFence?: {
      environmentId: string;
      workId: string;
      ownerId: string;
      generation: number;
      token: string;
    };
    executionFence?: { executionId: string; attemptId: string; ownerId: string; generation: number };
  }): Promise<{ scheme: "Basic" | "Bearer"; token: string; slug: string } | null> {
    // A Session sandbox gets GitHub credentials only while its execution
    // attempt is current (design §0.0 rule 10); ManagedRuntimeHost below.
    if (opts.runtimeFence === undefined && await authorizeSandboxEgress(
      cfSandboxGatewayStores(this.env),
      opts.executionFence === undefined ? null : { workspaceId: opts.tenantId, sessionId: opts.sessionId, ...opts.executionFence },
    ) === null) return null;
    const fence: EnvironmentWorkFenceRef | null = opts.runtimeFence === undefined
      ? null
      : { workspaceId: opts.tenantId, sessionId: opts.sessionId, ...opts.runtimeFence };
    const runtimeFences = fence === null
      ? null
      : new SqlRuntimeResourceFencePort(new CfD1SqlClient(this.env.MAIN_DB));
    if (fence !== null && !await isEnvironmentWorkFenceCurrent(runtimeFences!, fence)) {
      throw new Error("stale runtime credential-egress fence");
    }
    const tenantDb = await buildCfTenantDbProvider(this.env).resolve(opts.tenantId);
    const client = new CfD1SqlClient(tenantDb);
    const sessionSource = new SqlSessionSource(client);
    const canonicalSession = await withMissingManagedSessionSchemaFallback(
      () => sessionSource.find({
        workspaceId: opts.tenantId,
        sessionId: opts.sessionId,
      }),
      async () => null,
    );
    const credential = canonicalSession === null
      ? await resolveGithubCredentials(
          await getCfServicesForTenant(this.env, opts.tenantId),
          opts.tenantId,
          opts.sessionId,
          opts.hostname,
          opts.pathname,
        )
      : await resolveManagedGithubCredentials(
          { find: async () => canonicalSession },
          new SqlSessionResourceSecretSource(
            client,
            new CfManagedSessionSecretSealer(this.env.PLATFORM_ROOT_SECRET),
          ),
          {
            workspaceId: opts.tenantId,
            sessionId: opts.sessionId,
            hostname: opts.hostname,
            pathname: opts.pathname,
          },
        );
    if (fence !== null && !await isEnvironmentWorkFenceCurrent(runtimeFences!, fence)) {
      throw new Error("stale runtime credential-egress fence");
    }
    return credential;
  }


}
