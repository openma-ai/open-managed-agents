
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

import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { OpenAIAgentsProtocolError } from "@open-managed-agents/openai-agents-api";
import { createArtifactsHandler, createManagedSessionMapping, createResourcesHandler, createSessionsHandler } from "@open-managed-agents/openai-agents-compat";

import { buildNodeOpenAIAgentsRoutes } from "../openai-agents.js";
import { createNodeOpenAIAgentsRuntime } from "../openai-managed-runtime.js";

import { requestMetrics, tracerMiddleware } from "@open-managed-agents/observability";

import { toFileRecord } from "@open-managed-agents/files-store";

import { listAuthProviders } from "@open-managed-agents/shared";

import { buildAgentRoutes as buildLegacyAgentRoutes, buildVaultRoutes as buildLegacyVaultRoutes, buildModelCardRoutes, buildEnvironmentRoutes as buildLegacyEnvironmentRoutes, buildSessionRoutes, buildMemoryRoutes as buildLegacyMemoryRoutes, buildDreamRoutes, buildTenantRoutes, buildMeRoutes, buildApiKeyRoutes, buildEvalRoutes, buildIntegrationsRoutes, buildIntegrationsGatewayRoutes, type InstallProxyForwarder, mintApiKeyOnStorage, sha256Hex } from "@open-managed-agents/http-routes";
import { buildAgentRoutes as buildManagedAgentRoutes, buildManagedSessionsApi } from "@open-managed-agents/managed-agents-api";
import { SessionRuntimeHistoryApplicationService, SessionRuntimeProjectionApplicationService } from "@open-managed-agents/managed-agents-application";

import { managedAgentsPortTokens } from "@open-managed-agents/app/managed-agents";

import { ingestEnvironmentWorkRuntimeEvents, authenticateEnvironmentWorkSessionBearer } from "@open-managed-agents/managed-agents-adapters-runtime";
import { isCurrentEnvironmentWorkClaim } from "@open-managed-agents/environment-work-store";

import { buildOmaModelsHttpRoutes } from "@open-managed-agents/managed-agents-adapters-http";
import { buildNodeRepos, SqlFeishuInstallationRepo, SqlFeishuPublicationRepo, SqlSlackInstallationRepo, SqlSlackPublicationRepo, SqlSlackAppRepo, CryptoIdGenerator, WorkerHttpClient, type NodeReposEnv } from "@open-managed-agents/integrations-adapters-node";
import { NodeInstallBridge, buildNodeProvidersForRequest } from "../lib/node-install-bridge.js";
import { OmaVaultResolver } from "@open-managed-agents/oma-cap-adapter";
import { NodeSessionRouter } from "../lib/node-session-router.js";
import { configureFeishuAgentTools, sqlSessionMetadataReader } from "../lib/feishu-agent-tools.js";
import { nodeOutputsAdapter } from "../lib/node-outputs-adapter.js";

import { createAuthMiddleware as buildAuthMw, type ApiKeyResolution } from "@open-managed-agents/auth";
import { ensureTenantSqlite } from "@open-managed-agents/auth-config";

import { relative } from "node:path";

import { buildNodeSkillsRoutes } from "../lib/node-skills-routes.js";

import { buildNodeHttpMcpProxyRoutes } from "../lib/http-mcp-proxy.js";
import { createNodeAccessLossRuntime } from "../lib/mcp-access-loss.js";

import { Disposables } from "../lifecycle.js";

import type { NodeRuntime } from "./node-runtime.js";
import type { NodeControlPlaneApp } from "./node-assembly.js";

export async function mountNodeHttp(runtime: NodeRuntime, disposables: Disposables): Promise<NodeControlPlaneApp> {
  const {
    config,
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
    agentsService,
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
    filesBlob,
    filesBlobDescription,
    newEventLog,
    hub,
    realtimeDescription,
    sessionRegistry,
    resolveNodeMcpProxyTarget,
    managedRuntimeRunner,
    managedRuntimeReaders,
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
    managedUserProfilesRoutes,
    services,
    apiKeyStorage,
  } = runtime;
  let feishuRunner: { stop: () => Promise<void> } | null = null;
  // ─── HTTP ───────────────────────────────────────────────────────────────

  const app = new Hono<{
    Variables: {
      tenant_id: string;
      user_id?: string;
      auth_credential?: ApiKeyResolution["credential"];
    };
  }>();

  // Observability middleware first so it captures auth failures, rate-limit
  // rejects, and unhandled exceptions. Mirrors apps/main's CF wiring.
  app.use("*", requestMetrics({ recorder: metrics }));
  app.use("*", tracerMiddleware({ tracer }));

  // Prometheus scrape endpoint. When METRICS_BIND_TOKEN is set, callers must
  // pass it in `x-metrics-token`; absent, the endpoint is open on the same
  // port (acceptable for self-host single-operator deploys, documented in
  // .env.example). For prod, ops should either set the token or front the
  // app with a reverse proxy that filters /metrics.
  const metricsToken = config.http.metricsToken;
  app.get("/metrics", async (c) => {
    if (metricsToken && c.req.header("x-metrics-token") !== metricsToken) {
      return c.text("forbidden", 403);
    }
    const text = await metrics.getPromText();
    return new Response(text, {
      headers: { "Content-Type": metrics.promContentType() },
    });
  });

  app.get("/health", (c) =>
    c.json({
      status: "ok",
      runtime: "node",
      pid: process.pid,
      uptime_s: Math.round(process.uptime()),
      auth: auth === null ? "disabled" : auth.description,
      backends: {
        agents: dialect,
        events: dialect,
        hub: realtimeDescription,
        memory_blobs: memoryBlobDescription,
        files_blobs: filesBlobDescription,
        v1_stream: managedSessionRuntimeStream === null ? "in-memory" : "sql-replicated",
        db: backendDescription,
      },
    }),
  );

  app.get("/auth-info", (c) =>
    c.json({
      providers: authDisabled
        ? []
        : listAuthProviders({
            emailOtp: config.auth.requireEmailVerify,
            googleClientId: config.auth.google.clientId,
            googleClientSecret: config.auth.google.clientSecret,
            githubClientId: config.auth.github.clientId,
            githubClientSecret: config.auth.github.clientSecret,
          }),
      turnstile_site_key: null,
    }),
  );

  if (auth) {
    app.on(["GET", "POST"], "/auth/*", (c) => auth.handler(c.req.raw));
  }

  // Auth middleware via packages/auth — same five-priority resolution as
  // apps/main on CF.
  const authMw = buildAuthMw({
    disabled: authDisabled,
    bypassPath: (path) => path === "/health" || path.startsWith("/auth/"),
    resolveSession: (headers) => auth ? auth.resolveSession(headers) : Promise.resolve(null),
    resolveApiKey: async (apiKey) => {
      if (config.http.apiKey && apiKey === config.http.apiKey) {
        return { tenantId: "default" };
      }
      const hash = await sha256Hex(apiKey);
      const rec = await apiKeyStorage.findByHash(hash);
      if (!rec) return null;
      return {
        tenantId: rec.tenant_id,
        userId: rec.user_id,
        credential: rec.credential,
      };
    },
    resolveBearerToken: async ({ token, method, path }) => {
      if (managedEnvironmentWorkSessionTokenCrypto === null) return null;
      const scoped = await authenticateEnvironmentWorkSessionBearer({
        token,
        method,
        path,
        crypto: managedEnvironmentWorkSessionTokenCrypto,
        now: () => new Date(),
        isCurrent: (claim) => isCurrentEnvironmentWorkClaim({
          store: managedEnvironmentWorkStore,
          now: () => new Date(),
        }, claim),
      });
      return scoped === null
        ? null
        : {
            tenantId: scoped.workspaceId,
            credential: {
              type: "environment_work_session",
              environmentId: scoped.environmentId,
              sessionId: scoped.sessionId,
              workId: scoped.workId,
              claimedAt: scoped.claimedAt,
              generation: scoped.generation,
            },
          };
    },
    defaultTenantForUser: async (userId) => {
      const row = await sql
        .prepare(
          `SELECT tenant_id FROM membership WHERE user_id = ? ORDER BY created_at ASC, tenant_id ASC LIMIT 1`,
        )
        .bind(userId)
        .first<{ tenant_id: string }>();
      return row?.tenant_id ?? null;
    },
    hasMembership: async (userId, tenantId) => {
      const row = await sql
        .prepare(
          `SELECT 1 AS one FROM membership WHERE user_id = ? AND tenant_id = ? LIMIT 1`,
        )
        .bind(userId, tenantId)
        .first<{ one: number }>();
      return row !== null;
    },
    ensureTenantForUser: (s) => ensureTenantSqlite(sql, s.userId, s.name, s.email),
  });

  const v1 = new Hono<{
    Variables: {
      tenant_id: string;
      user_id?: string;
      auth_credential?: ApiKeyResolution["credential"];
    };
  }>();
  v1.use("*", authMw);

  v1.post("/oma/sessions/:sessionId/runtime-events", async (c) => {
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
    const result = await ingestEnvironmentWorkRuntimeEvents({
      claim: {
        workspaceId: c.get("tenant_id"),
        environmentId: credential.environmentId,
        sessionId: credential.sessionId,
        workId: credential.workId,
        generation: credential.generation,
      },
      sessionId: c.req.param("sessionId"),
      body,
      projection: new SessionRuntimeProjectionApplicationService({
        workspaceId: c.get("tenant_id"),
        persistence: managedSessionsComposition.runtimeProjection,
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

  // Mount route bundles. Same paths CF uses; behavior preserved. Once a tenant
  // has configured model cards, agent model handles must resolve to an active
  // card; an empty card set keeps the legacy ANTHROPIC_API_KEY fallback usable.
  v1.route("/agents", buildManagedAgentRoutes((context) =>
    managedPlatform
      .app({
        workspaceId: (context.var as { tenant_id: string }).tenant_id,
      })
      .port(managedAgentsPortTokens.agents),
  ));
  v1.route("/oma/agents", buildLegacyAgentRoutes({
    services,
    validateModel: async (tenantId, model) => {
      const cards = await modelCardsService.list({ tenantId });
      const active = cards.filter((card) => card.archived_at === null);
      if (active.length === 0) return { valid: true };
      const modelId = typeof model === "string" ? model : model.id;
      if (!active.some((card) => card.model_id === modelId)) {
        return {
          valid: false,
          error: `No model card with model_id "${modelId}". Create a card with that handle, or set agent.model to an existing card's model_id.`,
        };
      }
      return { valid: true };
    },
  }));
  const sessionRouter = new NodeSessionRouter({
    sql,
    hub,
    registry: sessionRegistry,
    newEventLog,
  });
  v1.route("/sessions", buildManagedSessionsApi({
    sessions: (context) =>
      managedSessionsComposition.portsFor(
        (context.var as { tenant_id: string }).tenant_id,
      ).sessions,
    sessionEvents: (context) =>
      managedSessionsComposition.portsFor(
        (context.var as { tenant_id: string }).tenant_id,
      ).sessionEvents,
    sessionResources: (context) =>
      managedSessionsComposition.portsFor(
        (context.var as { tenant_id: string }).tenant_id,
      ).sessionResources,
    sessionThreads: (context) =>
      managedSessionsComposition.portsFor(
        (context.var as { tenant_id: string }).tenant_id,
      ).sessionThreads,
    sessionThreadEvents: (context) =>
      managedSessionsComposition.portsFor(
        (context.var as { tenant_id: string }).tenant_id,
      ).sessionThreadEvents,
  }, {
    outputs: {
      workspaceId: (context) =>
        (context.var as { tenant_id: string }).tenant_id,
      store: sessionOutputs,
    },
  }));
  v1.route("/oma/sessions", buildSessionRoutes({
    services,
    router: sessionRouter,
    outputs: nodeOutputsAdapter(outputsRoot),
    lifecycle: nodeSessionLifecycleHooks,
    // Node has no per-tenant cloud environments yet — every agent is treated
    // as a local runtime. The package's loadEnvironment hook returns a
    // synthetic snapshot so session create doesn't 404 on missing env_id.
    localRuntimeEnvId: "env-local-runtime",
    loadEnvironment: async ({ environmentId }) => {
      return {
        id: environmentId,
        runtime: "local",
        sandbox_template: null,
      } as unknown as import("@open-managed-agents/shared").EnvironmentConfig;
    },
  }));
  v1.route("/oma/mcp-proxy", buildNodeHttpMcpProxyRoutes({
    resolveTarget: resolveNodeMcpProxyTarget,
    accessLoss: await createNodeAccessLossRuntime(sql),
  }));
  v1.route("/vaults", managedVaultsRoutes);
  v1.route("/vaults", managedCredentialsRoutes);
  v1.route("/user_profiles", managedUserProfilesRoutes);
  v1.route("/oma/vaults", buildLegacyVaultRoutes({ services }));
  v1.route("/memory_stores", managedMemoryStoresRoutes);
  v1.route("/memory_stores", managedMemoriesRoutes);
  v1.route("/memory_stores", managedMemoryVersionsRoutes);
  v1.route("/models", managedModelsRoutes);
  v1.route("/oma/memory_stores", buildLegacyMemoryRoutes({ services }));
  v1.route("/skills", managedSkillsRoutes);
  v1.route("/skills", managedSkillVersionsRoutes);
  v1.route("/deployments", managedDeploymentsRoutes);
  v1.route("/deployment_runs", managedDeploymentRunsRoutes);
  v1.route("/environments", managedEnvironmentWorkRoutes);
  v1.route("/dreams", managedDreamsRoutes);
  v1.route("/oma/dreams", buildDreamRoutes({
    services,
    curatorEnv: {
      DREAM_CURATOR_MODE: config.dreamCurator === "dedup" ? "dedup" : undefined,
      ANTHROPIC_API_KEY: config.model.apiKey,
      ANTHROPIC_BASE_URL: config.model.baseUrl,
    },
  }));
  v1.route("/tunnels", managedTunnelsRoutes);
  v1.route("/tunnels", managedTunnelCertificateRoutes);
  v1.route("/oma/me", buildMeRoutes({
    services,
    authDisabled,
    loadTenant: async (tenantId) => {
      const r = await sql
        .prepare(`SELECT id, name FROM "tenant" WHERE id = ?`)
        .bind(tenantId)
        .first<{ id: string; name: string }>();
      return r ?? null;
    },
    listMemberships: async (userId) => {
      const r = await sql
        .prepare(
          `SELECT t.id AS id, t.name AS name, m.role AS role, m.created_at AS created_at
             FROM "membership" m JOIN "tenant" t ON t.id = m.tenant_id
            WHERE m.user_id = ? ORDER BY m.created_at ASC, t.id ASC`,
        )
        .bind(userId)
        .all<{ id: string; name: string; role: string; created_at: number }>();
      return r.results ?? [];
    },
    hasMembership: async (userId, tenantId) => {
      const row = await sql
        .prepare(
          `SELECT 1 AS one FROM membership WHERE user_id = ? AND tenant_id = ? LIMIT 1`,
        )
        .bind(userId, tenantId)
        .first<{ one: number }>();
      return row !== null;
    },
    mintApiKey: (input) => mintApiKeyOnStorage(apiKeyStorage, input),
  }));
  v1.route("/oma/tenants", buildTenantRoutes({ services, memberSql: sql, loadMemberUser: async (id) => {
    const user = auth ? await auth.findUser(id) : null;
    return user ? { name: user.name, email: user.email ?? undefined } : null;
  } }));
  v1.route("/oma/api_keys", buildApiKeyRoutes({ storage: apiKeyStorage }));
  v1.route("/oma/evals", buildEvalRoutes({
    evals: evalsService,
    agents: agentsService,
    environments: environmentsService,
  }));

  async function countManagedPages(
    load: (cursor?: string) => Promise<{
      items: readonly unknown[];
      nextCursor: string | null;
    }>,
  ): Promise<number> {
    let total = 0;
    let cursor: string | undefined;
    const visited = new Set<string>();

    for (;;) {
      const page = await load(cursor);
      total += page.items.length;
      if (page.nextCursor === null) return total;
      if (visited.has(page.nextCursor)) {
        throw new Error(`Managed stats pagination repeated cursor ${page.nextCursor}`);
      }
      visited.add(page.nextCursor);
      cursor = page.nextCursor;
    }
  }

  // OMA-only stubs used by the self-hosted console.
  v1.route("/oma/skills", buildNodeSkillsRoutes({ db: drizzleDb, blobs: filesBlob }));
  v1.get("/oma/runtimes", (c) => c.json({ data: [] }));
  v1.get("/oma/stats", async (c) => {
    const tenantId = c.get("tenant_id");
    const managedApp = managedPlatform.app({ workspaceId: tenantId });
    const managedAgents = managedApp.port(managedAgentsPortTokens.agents);
    const managedEnvironments = managedApp.port(managedAgentsPortTokens.environments);
    const managedSessions = managedSessionsComposition.portsFor(tenantId).sessions;
    const managedSkills = managedPlatform
      .app({ workspaceId: tenantId })
      .port(managedAgentsPortTokens.skills);
    const managedVaults = managedPlatform
      .app({ workspaceId: tenantId })
      .port(managedAgentsPortTokens.vaults);
    const [
      agents,
      sessions,
      environments,
      vaults,
      skills,
      modelCards,
      apiKeys,
    ] = await Promise.all([
      countManagedPages(async (cursor) => {
        const result = await managedAgents.listAgents({
          pageSize: 100,
          ...(cursor === undefined ? {} : { cursor }),
        });
        if (result.type !== "page") throw new Error(result.message);
        return { items: result.page.agents, nextCursor: result.page.nextCursor };
      }),
      countManagedPages(async (cursor) => {
        const result = await managedSessions.listSessions({
          pageSize: 100,
          ...(cursor === undefined ? {} : { cursor }),
        });
        if (result.type !== "page") throw new Error(result.message);
        return { items: result.page.sessions, nextCursor: result.page.nextCursor };
      }),
      countManagedPages(async (cursor) => {
        const result = await managedEnvironments.listEnvironments({
          pageSize: 100,
          ...(cursor === undefined ? {} : { cursor }),
        });
        if (result.type !== "page") throw new Error(result.message);
        return { items: result.page.environments, nextCursor: result.page.nextCursor };
      }),
      countManagedPages(async (cursor) => {
        const result = await managedVaults.listVaults({
          pageSize: 100,
          ...(cursor === undefined ? {} : { cursor }),
        });
        if (result.type !== "page") throw new Error(result.message);
        return { items: result.page.vaults, nextCursor: result.page.nextCursor };
      }),
      countManagedPages(async (cursor) => {
        const result = await managedSkills.listSkills({
          pageSize: 100,
          ...(cursor === undefined ? {} : { cursor }),
        });
        if (result.type !== "page") throw new Error(result.message);
        return { items: result.page.skills, nextCursor: result.page.nextCursor };
      }),
      modelCardsService.list({ tenantId }),
      apiKeyStorage.listByTenant(tenantId),
    ]);

    return c.json({
      agents,
      sessions,
      environments,
      vaults,
      skills,
      model_cards: modelCards.filter((card) => card.archived_at === null).length,
      api_keys: apiKeys.length,
    });
  });
  v1.route("/environments", managedEnvironmentsRoutes);
  v1.route("/oma/environments", buildLegacyEnvironmentRoutes({
    environments: environmentsService,
    sessions: sessionsService,
  }));
  v1.route("/files", managedFilesRoutes);
  v1.route("/oma/model_cards", buildModelCardRoutes({ modelCards: modelCardsService }));
  v1.route("/oma/models", buildOmaModelsHttpRoutes({
    fetch: (input, init) => fetch(input, init),
  }));
  v1.get("/oma/integrations/github/credentials", (c) => c.json({ data: [] }));
  v1.get("/oma/integrations/linear/credentials", (c) => c.json({ data: [] }));
  v1.get("/oma/integrations/slack/credentials", (c) => c.json({ data: [] }));

  // Real integration CRUD + lookup (linear/github/slack publications,
  // installations, dispatch rules). Active only when PLATFORM_ROOT_SECRET is
  // set — otherwise the routes 503 with a remediation message. Install-proxy
  // endpoints (start-a1 / credentials / handoff-link / personal-token) return
  // 503 because the OAuth/install gateway is not yet ported to Node (P4
  // follow-up); the read endpoints work standalone.
  // Real integration CRUD + lookup (linear/github/slack publications,
  // installations, dispatch rules). Active only when PLATFORM_ROOT_SECRET is
  // set — otherwise the routes 503 with a remediation message. The
  // install-proxy endpoints (start-a1 / credentials / handoff-link /
  // personal-token) call into the in-process InstallBridge, mirroring the
  // CF /linear/publications/* etc. wire shapes verbatim.
  const integrationsInternalToken = config.integrationsInternalToken ?? null;
  const gatewayOrigin = config.http.gatewayOrigin;
  let installBridge: NodeInstallBridge | null = null;
  if (platformRootSecret) {
    installBridge = new NodeInstallBridge({
      sql,
      db: drizzleDb,
      platformRootSecret,
      gatewayOrigin: gatewayOrigin.replace(/\/+$/, ""),
      vaults: vaultService,
      credentials: credentialService,
      sessions: sessionsService,
      agents: agentsService,
      resolveTenantId: async (userId) => {
        const row = await sql
          .prepare(
            `SELECT tenant_id FROM membership WHERE user_id = ? ORDER BY created_at ASC, tenant_id ASC LIMIT 1`,
          )
          .bind(userId)
          .first<{ tenant_id: string }>();
        return row?.tenant_id ?? null;
      },
      appendUserEvent: async (sessionId, _tenantId, _agentId, event) => {
        // Webhook → session-resume drives the same NodeSessionRouter the
        // public POST /v1/sessions/:id/events route uses, so the harness
        // wakes up via the existing event-driven runtime.
        await sessionRouter.appendEvent(sessionId, event);
      },
    });
  }

  // Feishu WebSocket long-connection runner — the production ingest path for
  // Feishu and the driver of the `credentials_filled / awaiting_install → live`
  // status flip. The bot dials OUT, so (unlike the legacy HTTP webhook) no
  // public URL is needed. Opt-in (`FEISHU_WS_RUNNER=1`) until it has been
  // exercised against real Feishu app credentials — otherwise a stale
  // publication with fake creds would dial out and backoff-loop on every boot.
  if (
    ownsLongLivedProcesses
    && platformRootSecret
    && installBridge
    && config.feishuWsRunner
  ) {
    try {
      const { startFeishuWsRunner } = await import("../lib/ws-feishu-runner.js");
      const feishuContainer = installBridge.buildContainers().feishu;
      const feishuProvider = buildNodeProvidersForRequest(installBridge, gatewayOrigin).feishu;
      // HTTP adapter for the automatic-egress send path (FeishuApiClient). One
      // instance serves all Feishu Apps; the client mints/caches its own token.
      const feishuHttp = new WorkerHttpClient();
      // Wire the live Feishu agent tools (send/read) into the harness tool map
      // for Feishu-backed sessions. Same publication repo + HTTP adapter as the
      // runner — the WS runner is the only ingest path that produces Feishu
      // sessions, so this is the only place that needs configuring.
      configureFeishuAgentTools({
        reader: sqlSessionMetadataReader(sql),
        pubs: feishuContainer.feishuPublications,
        http: feishuHttp,
      });
      feishuRunner = await startFeishuWsRunner({
        sql,
        pubs: feishuContainer.feishuPublications,
        installations: feishuContainer.feishuInstallations,
        webhookEvents: feishuContainer.webhookEvents,
        provider: feishuProvider,
        hub,
        http: feishuHttp,
      });
      disposables.add("feishu_runner", () => feishuRunner?.stop());
    } catch (err) {
      logger.warn(
        { err, op: "main-node.feishu_ws_runner_start_failed" },
        "feishu ws runner failed to start",
      );
    }
  }

  if (platformRootSecret) {
    const integrationsRepoEnv: NodeReposEnv = {
      sql,
      db: drizzleDb,
      PLATFORM_ROOT_SECRET: platformRootSecret,
    };
    v1.route(
      "/oma/integrations",
      buildIntegrationsRoutes({
        bags: () => {
          const repos = buildNodeRepos(integrationsRepoEnv);
          const slackCrypto = secrets!.cipherFor("integrations.tokens");
          const slackIds = new CryptoIdGenerator();
          return {
            linear: {
              installations: repos.linearInstallations,
              publications: repos.linearPublications,
              apps: repos.apps,
              dispatchRules: repos.dispatchRules,
            },
            github: {
              installations: repos.githubInstallations,
              publications: repos.githubPublications,
              githubApps: repos.githubApps,
            },
            slack: {
              installations: new SqlSlackInstallationRepo(drizzleDb, slackCrypto, slackIds),
              publications: new SqlSlackPublicationRepo(drizzleDb, slackIds, slackCrypto),
              apps: new SqlSlackAppRepo(drizzleDb, slackCrypto, slackIds),
            },
            feishu: {
              installations: new SqlFeishuInstallationRepo(drizzleDb, slackCrypto, slackIds),
              publications: new SqlFeishuPublicationRepo(drizzleDb, slackIds, slackCrypto),
            },
          };
        },
        installProxy: installBridge ? bridgeAsInstallProxy(installBridge) : null,
      }),
    );
  }

  // ── Files API (subset of apps/main/src/routes/files.ts) ──
  //
  // CF mounts a richer files surface with synthesized session-output ids
  // and multipart upload; Node ships the read-side equivalent so the SDK
  // + console can list, download, and delete files. Uploads still go via
  // POST /v1/sessions/:id/files (lifecycle.promoteSandboxFile) and the
  // CF-only POST /v1/files (multipart upload from the browser) — that
  // route can be ported when console upload UX needs it.
  v1.get("/oma/files", async (c) => {
    const t = c.var.tenant_id;
    const scopeId = c.req.query("scope_id") ?? undefined;
    const limitParam = c.req.query("limit");
    let requested = limitParam ? parseInt(limitParam, 10) : 100;
    if (isNaN(requested) || requested < 1) requested = 100;
    if (requested > 1000) requested = 1000;
    const rows = await filesService.list({
      tenantId: t,
      sessionId: scopeId,
      limit: requested,
    });
    return c.json({ data: rows.map(toFileRecord), has_more: false });
  });
  v1.get("/oma/files/:id/content", async (c) => {
    const id = c.req.param("id");
    const t = c.var.tenant_id;
    const row = await filesService.get({ tenantId: t, fileId: id });
    if (!row) return c.json({ error: "File not found" }, 404);
    if (!row.downloadable) return c.json({ error: "This file is not downloadable" }, 403);
    const obj = await filesBlob.get(row.r2_key);
    if (!obj) return c.json({ error: "File content not found" }, 404);
    return new Response(obj.body, {
      headers: { "Content-Type": row.media_type },
    });
  });
  v1.get("/oma/files/:id", async (c) => {
    const id = c.req.param("id");
    const t = c.var.tenant_id;
    const row = await filesService.get({ tenantId: t, fileId: id });
    if (!row) return c.json({ error: "File not found" }, 404);
    return c.json(toFileRecord(row));
  });
  v1.delete("/oma/files/:id", async (c) => {
    try {
      const deleted = await filesService.delete({
        tenantId: c.var.tenant_id,
        fileId: c.req.param("id"),
      });
      await filesBlob.delete(deleted.r2_key).catch(() => undefined);
      return c.json({ type: "file_deleted", id: deleted.id });
    } catch (err) {
      if ((err as { code?: string }).code === "file_not_found") {
        return c.json({ error: "File not found" }, 404);
      }
      throw err;
    }
  });

  // ── Session ↔ memory_store binding (Node-specific; not in package yet) ──
  v1.post("/oma/sessions/:id/memory_stores", async (c) => {
    const sid = c.req.param("id");
    const session = await sql
      .prepare(`SELECT id FROM sessions WHERE tenant_id = ? AND id = ?`)
      .bind(c.var.tenant_id, sid)
      .first();
    if (!session) return c.json({ error: "Session not found" }, 404);
    const body = await c.req.json<{ store_id: string; access?: string }>();
    if (!body.store_id) return c.json({ error: "store_id is required" }, 400);
    const store = await memoryService.getStore({
      tenantId: c.var.tenant_id,
      storeId: body.store_id,
    });
    if (!store) return c.json({ error: "Memory store not found" }, 404);
    const access = body.access === "read_only" ? "read_only" : "read_write";
    await sql
      .prepare(
        `INSERT INTO session_memory_stores (session_id, store_id, access, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id, store_id) DO UPDATE SET access = excluded.access`,
      )
      .bind(sid, body.store_id, access, Date.now())
      .run();
    return c.json({ session_id: sid, store_id: body.store_id, access }, 201);
  });
  v1.get("/oma/sessions/:id/memory_stores", async (c) => {
    const r = await sql
      .prepare(
        `SELECT store_id, access, created_at FROM session_memory_stores WHERE session_id = ?`,
      )
      .bind(c.req.param("id"))
      .all<{ store_id: string; access: string; created_at: number }>();
    return c.json({ data: r.results ?? [] });
  });

  app.route("/v1", v1);
  app.route("/openai", buildNodeOpenAIAgentsRoutes({
    authMiddleware: authMw,
    portFor: (workspaceId) => {
      const application = managedPlatform.app({ workspaceId });
      const credentialApplication = managedPlatform.app({ workspaceId });
      const native = managedSessionsComposition.portsFor(workspaceId);
      const agents = application.port(managedAgentsPortTokens.agents);
      const environments = application.port(managedAgentsPortTokens.environments);
      const files = application.port(managedAgentsPortTokens.files);
      const runtime = createNodeOpenAIAgentsRuntime({
        environments, sessions: native.sessions, secrets: openAIAgentsSecrets,
        connectedSandbox: sessionId => managedRuntimeRunner.connectedSandbox({ workspaceId, sessionId }),
      });
      const resources = createResourcesHandler({
        agents, environments, files, secrets: openAIAgentsSecrets, runtime: runtime.files,
        vaults: credentialApplication.port(managedAgentsPortTokens.vaults),
        credentials: credentialApplication.port(managedAgentsPortTokens.credentials),
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
        history: new SessionRuntimeHistoryApplicationService({ workspaceId, source: managedRuntimeReaders.history }),
        mapping: createManagedSessionMapping({ agents, environments, resources, secrets: openAIAgentsSecrets, runtime: runtime.mapping }),
        resources: { execute: artifacts },
      });
      return { execute: request => request.operation.startsWith("sessions.") ? sessions.execute(request) : resources(request) };
    },
  }));

  // ─── Integrations gateway (OAuth callbacks, setup pages, Linear MCP,
  // GitHub internal refresh, webhooks) — mounted on `app` (NOT under /v1)
  // because the upstream OAuth/webhook URLs are at /linear/oauth/...,
  // /linear-setup/..., /linear/webhook/..., etc. Active only when
  // PLATFORM_ROOT_SECRET is set (encryption requires it). The bridge
  // constructs providers per-request off the same Container builder used
  // by the read-side routes, so a write hits the same underlying tables.
  if (installBridge) {
    const containers = installBridge.buildContainers();
    app.route(
      "/",
      buildIntegrationsGatewayRoutes({
        installBridge,
        jwt: containers.linear.jwt,
        webhooks: {
          linear: (req) => buildNodeProvidersForRequest(installBridge!, gatewayOrigin).linear.handleWebhook(req),
          github: (req) => buildNodeProvidersForRequest(installBridge!, gatewayOrigin).github.handleWebhook(req),
          slack: (req) => buildNodeProvidersForRequest(installBridge!, gatewayOrigin).slack.handleWebhook(req),
        },
        internalSecret: integrationsInternalToken,
        // Node has no per-tenant rate-limit binding by default; soft-pass.
        rateLimit: undefined,
      }),
    );
  }

  // oma-cap-adapter wire — exposes a Resolver against the in-process vault
  // services so a future Node outbound proxy (mirroring CF's mcp-proxy) can
  // inject cap_cli credentials into sandbox traffic. Wired here at the
  // services construction site so the resolver is available even before
  // the outbound surface lands.
  const _capResolver = new OmaVaultResolver({
    sessions: {
      get: ({ tenantId, sessionId }) => sessionsService.get({ tenantId, sessionId }) as never,
    },
    credentials: {
      listByVaults: ({ tenantId, vaultIds }) =>
        credentialService.listByVaults({ tenantId, vaultIds }) as never,
      update: ({ tenantId, vaultId, credentialId, auth }) =>
        credentialService.update({ tenantId, vaultId, credentialId, auth }) as never,
      create: ({ tenantId, vaultId, displayName, auth }) =>
        credentialService.create({ tenantId, vaultId, displayName, auth }) as never,
    },
  });
  void _capResolver;

  // ── Console UI (optional) ──
  const consoleDir = config.http.consoleDir;
  if (consoleDir) {
    const cwd = process.cwd();
    const rootRel = consoleDir.startsWith("/")
      ? relative(cwd, consoleDir)
      : consoleDir;
    app.use("/*", serveStatic({ root: rootRel }));
    // SPA fallback for client-side routes ONLY. Never serve index.html for
    // API/auth/health paths — a missing /v1/* handler used to fall through
    // here and the console would fail with
    // `Unexpected token '<' ... is not valid JSON` (HTML parsed as JSON).
    app.get("/*", async (c, next) => {
      const p = c.req.path;
      if (
        p === "/health" ||
        p.startsWith("/v1/") ||
        p.startsWith("/auth") ||
        p.startsWith("/linear") ||
        p.startsWith("/github")
      ) {
        return next();
      }
      return serveStatic({ root: rootRel, path: "index.html" })(c, next);
    });
    logger.info({ op: "main-node.console_ui", dir: consoleDir, cwd_rel: rootRel }, "console UI served");
  }

  app.notFound((c) => c.json({ error: "not found" }, 404));
  app.onError((err, c) => {
    logger.error({ err, op: "main-node.unhandled" }, "unhandled error");
    return c.json({ error: "internal_error", message: err.message }, 500);
  });

  return app;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * In-process forwarder for the package's `installProxy` deps. Each subpath
 * (e.g. "linear/publications/start-a1") routes to bridge.startInstallation.
 * Mirrors apps/main/src/routes/integrations.ts but skips the
 * INTEGRATIONS.fetch hop.
 *
 * Linear's publication-first endpoints use distinct subpath shapes:
 *   - POST  linear/publications                       → mode='create-publication'
 *   - PATCH linear/publications/<id>/credentials      → mode='submit-credentials-pub'
 * Slack/GitHub continue using the legacy /start-a1, /credentials,
 * /handoff-link variants until they ship their own publication-first
 * refactors.
 */
function bridgeAsInstallProxy(bridge: NodeInstallBridge): InstallProxyForwarder {
  return {
    async forward({ subpath, body, method }) {
      // Linear publication-first endpoints first — they share a subpath
      // prefix with the legacy ones so order matters.
      const newPub = /^linear\/publications$/.exec(subpath);
      if (newPub && method === "POST") {
        const result = await bridge.startInstallation!({
          provider: "linear",
          mode: "create-publication",
          body: (body ?? {}) as Record<string, unknown>,
        });
        return new Response(JSON.stringify(result.body), {
          status: result.status,
          headers: { "content-type": "application/json" },
        });
      }
      const newCreds = /^linear\/publications\/([^/]+)\/credentials$/.exec(subpath);
      if (newCreds && (method === "PATCH" || method === "POST")) {
        const result = await bridge.startInstallation!({
          provider: "linear",
          mode: "submit-credentials-pub",
          body: { ...(body ?? {}), publicationId: newCreds[1] } as Record<string, unknown>,
        });
        return new Response(JSON.stringify(result.body), {
          status: result.status,
          headers: { "content-type": "application/json" },
        });
      }

      // Form-token reissue (wizard resume path): `<provider>/publications/<id>/form-token`.
      // Has a dynamic :id segment so it can't fold into the static-mode regex below —
      // handle it first and inject the id as body.publicationId (the bridge's
      // `form-token` mode reads it). Mounted for slack/github/feishu; linear returns
      // 410 inside the bridge.
      const formTokenRe = /^([^/]+)\/publications\/([^/]+)\/form-token$/.exec(subpath);
      // The http-routes forwarder omits `method` on this path; the CF
      // counterpart defaults to POST (apps/main/src/routes/integrations.ts)
      // — mirror that here so wizard refresh-resume works on Node.
      if (formTokenRe && (method ?? "POST") === "POST") {
        const result = await bridge.startInstallation!({
          provider: formTokenRe[1] as "linear" | "github" | "slack" | "feishu",
          mode: "form-token",
          body: {
            ...(body ?? {}),
            publicationId: formTokenRe[2],
          } as Record<string, unknown>,
        });
        return new Response(JSON.stringify(result.body), {
          status: result.status,
          headers: { "content-type": "application/json" },
        });
      }

      const m = /^([^/]+)\/publications\/(start-a1|credentials|handoff-link|personal-token)$/.exec(
        subpath,
      );
      if (!m) {
        return new Response(
          JSON.stringify({ error: `unsupported install proxy subpath: ${subpath}` }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      const [, provider, mode] = m;
      const result = await bridge.startInstallation!({
        provider: provider as "linear" | "github" | "slack" | "feishu",
        mode: mode as "start-a1" | "credentials" | "handoff-link" | "personal-token",
        body: (body ?? {}) as Record<string, unknown>,
      });
      return new Response(JSON.stringify(result.body), {
        status: result.status,
        headers: { "content-type": "application/json" },
      });
    },
  };
}
