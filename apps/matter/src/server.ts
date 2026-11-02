/**
 * The Matter service process: configuration from the environment, one HTTP
 * listener for the MCP endpoint, the "Connect Feishu" and "Connect GitLab"
 * APIs and GitLab webhooks, and the host
 * that runs every connection (see `adapter.ts`).
 *
 * With `MATTER_DATABASE_URL` (MySQL) the process keeps no state of its own:
 * run as many replicas as needed behind one address; any replica serves any
 * request. Without it, one process keeps everything in SQLite files under
 * `MATTER_DATA_DIR`.
 */

import { mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { join } from "node:path";
import { createRepositoryCredentialHandler } from "./repository-credential.js";
import {
  createFeishuConnectHandler,
  FeishuConnectService,
  trustedProxyPrincipal,
  type FeishuConnection,
} from "./feishu-connect.js";
import type { FeishuLongConnectionOptions } from "@openma/matter-feishu/long-connection";
import { connectFeishuApp, createFeishuAdapter } from "./feishu-adapter.js";
import {
  connectGitLab,
  createGitLabAdapter,
  createGitLabBot,
  createGitLabConnectHandler,
  createGitLabWebhookHandler,
  parseBaseUrl,
  replaceGitLabToken,
} from "./gitlab-adapter.js";
import { createMatterHost, type MatterHost, type MatterHostOptions } from "./host.js";
import { createLoopApiHandler, migrateConnectionsToLoops } from "./loops-api.js";
import { createMatterMcpHandler } from "./mcp-server.js";
import { createOmaClient, type OmaClient } from "./oma-client.js";
import {
  createSecretBox,
  openMysqlMatterDatabase,
  openSqliteMatterDatabase,
  type MatterDatabase,
} from "./persistence.js";
import { OperationCallBridge } from "./tool-bridge.js";
import { matterTrustHeaders } from "./feishu-connect.js";

export interface MatterConfig {
  readonly host: string;
  readonly port: number;
  /** SQLite files when `databaseUrl` is unset. */
  readonly dataDir: string;
  /** `mysql://…`: the database every replica shares (`MATTER_DATABASE_URL`). */
  readonly databaseUrl?: string;
  /** How often a replica brings its connections in line with the saved
   * ones (`MATTER_RECONCILE_MS`, default 15 s). */
  readonly reconcileMs: number;
  /** Shared with the OpenMA control plane (`MATTER_PROXY_SECRET`). */
  readonly proxySecret: string;
  /** Seals app secrets at rest. */
  readonly secretKey: string;
  readonly omaUrl: string;
  /** A workspace API key (`OMA_API_KEY`): the service acts in that one
   * workspace. Unset, it acts in any workspace through the control plane's
   * trusted-proxy headers (the shared `MATTER_PROXY_SECRET`). */
  readonly omaApiKey?: string;
  /** The only workspace whose connections are accepted. Defaults to
   * `default` with an API key; unset without one (every workspace). */
  readonly omaTenantId?: string;
  /** The MCP endpoint as OpenMA reaches it. */
  readonly mcpUrl: string;
  /** The OpenMA environment new sessions run in; unset, each workspace's
   * newest environment. */
  readonly environmentId?: string;
  /** Where providers that call in (GitLab webhooks) reach this service;
   * unset, "Connect GitLab" returns the webhook path only. */
  readonly publicUrl?: string;
  /** GitLab instances offered when linking a Bond (`MATTER_GITLAB_URLS`,
   * comma-separated); users can still enter another address. */
  readonly gitlabUrls?: readonly string[];
}

export class MatterConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid Matter configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "MatterConfigError";
  }
}

export const loadMatterConfig = (env: NodeJS.ProcessEnv): MatterConfig => {
  const problems: string[] = [];
  const required = (key: string): string => {
    const value = env[key];
    if (value === undefined || value === "") problems.push(`${key} is required`);
    return value ?? "";
  };
  const url = (key: string, fallback?: string): string => {
    const value = env[key] || fallback;
    if (value === undefined) {
      problems.push(`${key} is required`);
      return "";
    }
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
    } catch {
      problems.push(`${key} must be an absolute http(s) URL`);
    }
    return value.replace(/\/+$/, "");
  };
  const portRaw = env.MATTER_PORT ?? "4720";
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    problems.push(`MATTER_PORT must be a port number; received ${JSON.stringify(portRaw)}`);
  }
  const host = env.MATTER_HOST || "127.0.0.1";
  const proxySecret = required("MATTER_PROXY_SECRET");
  const secretKey = required("MATTER_SECRET_KEY");
  if (secretKey !== "" && secretKey.length < 16) {
    problems.push("MATTER_SECRET_KEY must be at least 16 characters");
  }
  const databaseUrl = env.MATTER_DATABASE_URL || undefined;
  if (databaseUrl !== undefined && !/^mysql:\/\//.test(databaseUrl)) {
    problems.push("MATTER_DATABASE_URL must be a mysql:// URL");
  }
  const reconcileRaw = env.MATTER_RECONCILE_MS ?? "15000";
  const reconcileMs = Number(reconcileRaw);
  if (!Number.isInteger(reconcileMs) || reconcileMs < 1000) {
    problems.push(`MATTER_RECONCILE_MS must be at least 1000; received ${JSON.stringify(reconcileRaw)}`);
  }
  const gitlabUrls = (env.MATTER_GITLAB_URLS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "")
    .map((value) => {
      const parsed = parseBaseUrl(value);
      if (parsed === undefined) problems.push(`MATTER_GITLAB_URLS has an invalid URL: ${JSON.stringify(value)}`);
      return parsed ?? "";
    });
  const config: MatterConfig = {
    host,
    port,
    dataDir: env.MATTER_DATA_DIR || "./data/matter",
    ...(databaseUrl === undefined ? {} : { databaseUrl }),
    reconcileMs,
    proxySecret,
    secretKey,
    omaUrl: url("OMA_URL"),
    ...(env.OMA_API_KEY ? { omaApiKey: env.OMA_API_KEY } : {}),
    ...(env.OMA_TENANT_ID || env.OMA_API_KEY ? { omaTenantId: env.OMA_TENANT_ID || "default" } : {}),
    mcpUrl: url("MATTER_MCP_URL", `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}/mcp`),
    ...(env.OMA_ENVIRONMENT_ID ? { environmentId: env.OMA_ENVIRONMENT_ID } : {}),
    ...(env.MATTER_PUBLIC_URL ? { publicUrl: url("MATTER_PUBLIC_URL") } : {}),
    ...(gitlabUrls.length > 0 ? { gitlabUrls } : {}),
  };
  if (problems.length > 0) throw new MatterConfigError(problems);
  return config;
};

export interface MatterService {
  readonly fetch: (request: Request) => Promise<Response>;
  readonly host: MatterHost;
  readonly db: MatterDatabase;
  /** What the "Connect Feishu" flow calls with a registered app. */
  readonly connectFeishu: (connection: FeishuConnection) => Promise<void>;
  readonly feishuConnect: FeishuConnectService;
  /** Start every connection, then keep them in line with the database and
   * poll "Connect Feishu" registrations no replica holds. */
  start(): Promise<void>;
  close(): Promise<void>;
}

/** The Matter database `config` names: MySQL, or SQLite under `dataDir`. */
export const openConfiguredDatabase = async (
  config: Pick<MatterConfig, "dataDir" | "databaseUrl" | "secretKey">,
): Promise<MatterDatabase> => {
  const box = createSecretBox(config.secretKey);
  if (config.databaseUrl !== undefined) return openMysqlMatterDatabase({ url: config.databaseUrl, box });
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  return openSqliteMatterDatabase({
    filename: join(config.dataDir, "matter.sqlite"),
    connectionsDir: join(config.dataDir, "apps"),
    box,
  });
};

/** Everything but the listener, so tests drive it with plain Requests. */
export const createMatterService = async (
  config: MatterConfig,
  overrides: Partial<Pick<MatterHostOptions, "onError" | "onStarted" | "scheduleTimers">> & {
    /** Reaches the providers (Feishu, GitLab); tests pass a fake. */
    readonly fetch?: typeof fetch;
    readonly createWsClient?: FeishuLongConnectionOptions["createClient"];
    readonly omaFetch?: typeof fetch;
    readonly feishuConnectFetch?: typeof fetch;
    /** An open database instead of the configured one (tests). */
    readonly db?: MatterDatabase;
  } = {},
): Promise<MatterService> => {
  const db = overrides.db ?? (await openConfiguredDatabase(config));
  await migrateConnectionsToLoops(db);
  const omaFetch = overrides.omaFetch === undefined ? {} : { fetch: overrides.omaFetch };
  const accepts = (tenantId: string) => config.omaTenantId === undefined || tenantId === config.omaTenantId;
  const clients = new Map<string, OmaClient>();
  const clientFor = (tenantId: string): OmaClient | null => {
    if (!accepts(tenantId)) return null;
    let client = clients.get(tenantId);
    if (client === undefined) {
      client = createOmaClient({
        baseUrl: config.omaUrl,
        ...(config.omaApiKey === undefined
          ? { headers: matterTrustHeaders(config.proxySecret, tenantId) }
          : { apiKey: config.omaApiKey }),
        ...omaFetch,
      });
      clients.set(tenantId, client);
    }
    return client;
  };
  const environments = new Map<string, { id: string; until: number }>();
  const environmentFor = async (tenantId: string): Promise<string> => {
    if (config.environmentId !== undefined) return config.environmentId;
    const cached = environments.get(tenantId);
    if (cached !== undefined && cached.until > Date.now()) return cached.id;
    const client = clientFor(tenantId);
    if (client === null) throw new Error(`No OpenMA access for tenant ${tenantId}`);
    const found = (await client.listEnvironments()).find((e) => !e.archived_at);
    if (found === undefined) throw new Error("This workspace has no OpenMA environment; create one first");
    environments.set(tenantId, { id: found.id, until: Date.now() + 300_000 });
    return found.id;
  };
  const bridge = new OperationCallBridge({ store: db.calls });
  const providerFetch = overrides.fetch === undefined ? {} : { fetch: overrides.fetch };
  const gitlab = createGitLabAdapter({ db, ...providerFetch });
  const host = createMatterHost({
    db,
    bridge,
    clientFor,
    mcpServerUrl: config.mcpUrl,
    environmentId: environmentFor,
    adapters: [
      createFeishuAdapter({
        db,
        ...providerFetch,
        ...(overrides.createWsClient === undefined ? {} : { createWsClient: overrides.createWsClient }),
      }),
      gitlab,
    ],
    onError:
      overrides.onError ??
      ((error, key) =>
        console.error(`[matter] ${key}:`, error instanceof Error ? error.message : error)),
    onStarted: overrides.onStarted ?? ((_key, label) => console.log(`[matter] ${label}: started`)),
    ...(overrides.scheduleTimers === undefined ? {} : { scheduleTimers: overrides.scheduleTimers }),
  });
  const connectFeishu = connectFeishuApp(host, { db, ...providerFetch });
  const proxied = trustedProxyPrincipal(config.proxySecret);
  const feishuConnect = new FeishuConnectService({
    onRegistered: connectFeishu,
    store: db.registrations,
    ...(overrides.feishuConnectFetch === undefined ? {} : { fetch: overrides.feishuConnectFetch }),
  });
  const connect = createFeishuConnectHandler({
    service: feishuConnect,
    // Only the workspace this service can act in may connect apps.
    authorize: async (request) => {
      const principal = await proxied(request);
      return principal !== null && accepts(principal.tenantId) ? principal : null;
    },
  });
  const gitlabLink = {
    db,
    ...providerFetch,
    ...(config.publicUrl === undefined ? {} : { publicUrl: config.publicUrl }),
    ...(config.gitlabUrls === undefined ? {} : { presets: config.gitlabUrls }),
  };
  const connectGitLabHandler = createGitLabConnectHandler({
    connect: connectGitLab(host, gitlabLink),
    createBot: createGitLabBot(host, gitlabLink),
    replaceToken: replaceGitLabToken(host, gitlabLink),
    db,
    ...(config.gitlabUrls === undefined ? {} : { presets: config.gitlabUrls }),
    authorize: async (request) => {
      const principal = await proxied(request);
      return principal !== null && accepts(principal.tenantId) ? principal : null;
    },
  });
  const loopApi = createLoopApiHandler({
    db,
    host,
    feishuConnect,
    authorize: async (request) => {
      const principal = await proxied(request);
      return principal !== null && accepts(principal.tenantId) ? principal : null;
    },
    ...(config.publicUrl === undefined ? {} : { publicUrl: config.publicUrl }),
    ...providerFetch,
  });
  const gitlabWebhooks = createGitLabWebhookHandler(gitlab, (key) => host.ensure(gitlab.kind, key));
  const mcp = createMatterMcpHandler({ bridge, tokens: db.tokens });
  const repositoryCredential = createRepositoryCredentialHandler({ db, secret: config.proxySecret, accepts });

  const fetchHandler = async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (path === "/health") {
      return Response.json({ status: "ok", apps: host.running().length });
    }
    if (path === "/mcp") return mcp(request);
    return (
      (await repositoryCredential(request)) ??
      (await gitlabWebhooks(request)) ??
      (await connectGitLabHandler(request)) ??
      (await loopApi(request)) ??
      (await connect(request)) ??
      Response.json({ error: "not found" }, { status: 404 })
    );
  };

  const timers: ReturnType<typeof setInterval>[] = [];
  const every = (ms: number, task: () => Promise<unknown>) => {
    let busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      void task()
        .catch((error: unknown) =>
          console.error("[matter] background task failed:", error instanceof Error ? error.message : error),
        )
        .finally(() => {
          busy = false;
        });
    }, ms);
    timer.unref?.();
    timers.push(timer);
  };

  return {
    fetch: fetchHandler,
    host,
    db,
    connectFeishu,
    feishuConnect,
    start: async () => {
      await host.start();
      every(config.reconcileMs, () => host.reconcile());
      every(2_000, () => feishuConnect.sweep());
      every(3_600_000, () => db.calls.prune(Date.now() - 86_400_000));
    },
    close: async () => {
      for (const timer of timers.splice(0)) clearInterval(timer);
      await host.stop();
      await db.close();
    },
  };
};

const toRequest = async (req: IncomingMessage, origin: string): Promise<Request> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
  }
  const method = req.method ?? "GET";
  return new Request(new URL(req.url ?? "/", origin), {
    method,
    headers,
    ...(method === "GET" || method === "HEAD" ? {} : { body: Buffer.concat(chunks) }),
  });
};

/** Serve a MatterService on node:http. */
export const listen = (
  service: MatterService,
  config: Pick<MatterConfig, "host" | "port">,
): Promise<Server> =>
  new Promise((resolve) => {
    const origin = `http://${config.host}:${config.port}`;
    const server = createServer((req, res) => {
      void (async () => {
        try {
          const response = await service.fetch(await toRequest(req, origin));
          res.writeHead(response.status, Object.fromEntries(response.headers));
          res.end(Buffer.from(await response.arrayBuffer()));
        } catch (error) {
          console.error("[matter] request failed:", error instanceof Error ? error.message : error);
          if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
          res.end('{"error":"internal_error"}');
        }
      })();
    });
    server.listen(config.port, config.host, () => resolve(server));
  });
