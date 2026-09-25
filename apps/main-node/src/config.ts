// The only place the Node control plane reads environment variables.
//
// loadNodeConfig(env) turns the flat string bag into typed data once, applies
// the documented defaults, and reports every problem in a single error, so a
// misconfigured deployment fails at startup with the complete list instead of
// at the first line that happens to need a value. createNodeControlPlane()
// receives the result and never sees the environment again.
//
// Two namespaces stay env-shaped on purpose, because their public contracts
// are: the sandbox provider's own keys (SandboxFactory takes a
// SandboxFactoryEnv), and nothing else.

import { nanoid } from "nanoid";

import { resolveNodeProcessMode, validateNodeProcessEnvironment, type NodeProcessMode } from "./process-mode.js";
import { resolveRealtimeFanout, type RealtimeFanoutConfig } from "./realtime-fanout.js";

export type NodeEnvironment = Readonly<Record<string, string | undefined>>;

export type DatabaseConfig =
  | { kind: "sqlite"; path: string }
  | { kind: "postgres"; url: string }
  | { kind: "mysql"; url: string };

export type BlobBackendConfig =
  | { kind: "localfs"; dir: string }
  | {
      kind: "s3";
      endpoint: string;
      bucket: string;
      accessKey: string;
      secretKey: string;
      region: string;
    };

export interface NodeConfig {
  processMode: NodeProcessMode;
  database: DatabaseConfig;
  auth: {
    disabled: boolean;
    /** Better Auth's SQLite file; unused for Postgres/MySQL, which share the main database. */
    databasePath: string;
    /** Missing means "generate a per-process secret and warn", as before. */
    secret: string | undefined;
    cookieDomain: string | undefined;
    requireEmailVerify: boolean;
    google: { clientId: string | undefined; clientSecret: string | undefined };
    github: { clientId: string | undefined; clientSecret: string | undefined };
  };
  /** Root key for platform-owned ciphers (model cards, integrations). */
  platformRootSecret: string | undefined;
  blobs: {
    memory: BlobBackendConfig & { pollIntervalMs?: number };
    files: BlobBackendConfig;
  };
  /** MEMORY_QUEUE: "disabled" turns off the SQL-backed memory ingestion queue. */
  memoryQueue: "auto" | "disabled";
  realtime: RealtimeFanoutConfig;
  model: {
    apiKey: string | undefined;
    baseUrl: string | undefined;
    customHeaders: Record<string, string> | undefined;
  };
  dreamCurator: "model" | "dedup";
  execution: { ownerId: string; concurrency: number };
  managedWebhooks: {
    url: string | undefined;
    signingKey: string | undefined;
    organizationId: string | undefined;
  };
  paths: { sandboxWorkdir: string; sessionOutputs: string };
  http: {
    host: string;
    port: number;
    publicBaseUrl: string | undefined;
    gatewayOrigin: string;
    consoleDir: string | undefined;
    metricsToken: string | undefined;
    /** Legacy static API key accepted alongside per-tenant keys. */
    apiKey: string | undefined;
  };
  tunnels: { domainSuffix: string };
  integrationsInternalToken: string | undefined;
  email: {
    host: string;
    port: number;
    secure: boolean;
    user: string | undefined;
    pass: string | undefined;
    fromAddress: string | undefined;
  } | null;
  feishuWsRunner: boolean;
  cron: {
    evalTick: string;
    memoryRetention: string;
    webhookEventsRetention: string;
    linearDispatch: string;
  };
  sandbox: {
    /**
     * The provider's own configuration namespace (SANDBOX_PROVIDER, E2B_*,
     * DAYTONA_*, …). Opaque to the control plane: it is handed to the
     * selected SandboxFactory, whose contract is env-shaped.
     */
    environment: NodeEnvironment;
  };
}

export class NodeConfigError extends TypeError {
  constructor(readonly problems: readonly string[]) {
    super(
      problems.length === 1
        ? problems[0]
        : `Invalid configuration (${problems.length} problems):\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );
    this.name = "NodeConfigError";
  }
}

export function loadNodeConfig(env: NodeEnvironment): NodeConfig {
  const problems: string[] = [];
  const attempt = <T>(fallback: T, read: () => T): T => {
    try {
      return read();
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
      return fallback;
    }
  };
  const integer = (key: string, fallback: number, options: { min?: number; max?: number } = {}): number => {
    const raw = env[key];
    if (raw === undefined || raw.trim() === "") return fallback;
    const value = Number(raw);
    const inRange = (options.min === undefined || value >= options.min)
      && (options.max === undefined || value <= options.max);
    if (!Number.isFinite(value) || !Number.isInteger(value) || !inRange) {
      const range = options.min !== undefined && options.max !== undefined
        ? ` between ${options.min} and ${options.max}`
        : options.min !== undefined ? ` >= ${options.min}` : "";
      problems.push(`${key} must be an integer${range}; received ${JSON.stringify(raw)}`);
      return fallback;
    }
    return value;
  };
  const flag = (key: string): boolean => env[key] === "1";

  let processMode: NodeProcessMode = "standalone";
  attempt(undefined, () => {
    processMode = resolveNodeProcessMode(env);
    validateNodeProcessEnvironment(env);
  });

  const dbUrl = env.DATABASE_URL ?? "";
  const database: DatabaseConfig =
    dbUrl.startsWith("postgres://") || dbUrl.startsWith("postgresql://")
      ? { kind: "postgres", url: dbUrl }
      : dbUrl.startsWith("mysql://") || dbUrl.startsWith("mysql2://")
        ? { kind: "mysql", url: dbUrl }
        : { kind: "sqlite", path: env.DATABASE_PATH ?? "./data/oma.db" };

  const realtime = attempt<RealtimeFanoutConfig>(
    { mode: "memory", pollIntervalMs: 300 },
    () => resolveRealtimeFanout(env, database.kind),
  );

  const s3 = (prefix: "MEMORY_S3" | "FILES_S3") => {
    const endpoint = env[`${prefix}_ENDPOINT`];
    const bucket = env[`${prefix}_BUCKET`];
    const accessKey = env[`${prefix}_ACCESS_KEY`];
    const secretKey = env[`${prefix}_SECRET_KEY`];
    if (!endpoint || !bucket || !accessKey || !secretKey) return null;
    return { kind: "s3" as const, endpoint, bucket, accessKey, secretKey, region: env[`${prefix}_REGION`] ?? "us-east-1" };
  };
  const memoryS3 = s3("MEMORY_S3");
  const memory: NodeConfig["blobs"]["memory"] = memoryS3 === null
    ? { kind: "localfs", dir: env.MEMORY_BLOB_DIR ?? "./data/memory-blobs" }
    : { ...memoryS3, pollIntervalMs: Math.max(5_000, integer("MEMORY_S3_POLL_INTERVAL_SEC", 30) * 1000) };
  const files: BlobBackendConfig = s3("FILES_S3") ?? { kind: "localfs", dir: env.FILES_BLOB_DIR ?? "./data/files-blobs" };

  const memoryQueueRaw = env.MEMORY_QUEUE ?? "auto";
  const memoryQueue: NodeConfig["memoryQueue"] = memoryQueueRaw === "disabled" ? "disabled" : "auto";

  const email: NodeConfig["email"] = env.SMTP_HOST
    ? (() => {
        const port = integer("SMTP_PORT", 587);
        return {
          host: env.SMTP_HOST!,
          port,
          secure: env.SMTP_SECURE === "1" || port === 465,
          user: env.SMTP_USER,
          pass: env.SMTP_PASS,
          fromAddress: env.SMTP_FROM,
        };
      })()
    : null;

  const cron = (key: string, fallback: string): string => {
    const value = env[key];
    return value && value.trim() ? value : fallback;
  };

  const config: NodeConfig = {
    processMode,
    database,
    auth: {
      disabled: flag("AUTH_DISABLED"),
      databasePath: env.AUTH_DATABASE_PATH ?? "./data/auth.db",
      secret: env.BETTER_AUTH_SECRET,
      cookieDomain: env.AUTH_COOKIE_DOMAIN,
      requireEmailVerify: flag("AUTH_REQUIRE_EMAIL_VERIFY"),
      google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
      github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET },
    },
    platformRootSecret: env.PLATFORM_ROOT_SECRET,
    blobs: { memory, files },
    memoryQueue,
    realtime,
    model: {
      apiKey: env.ANTHROPIC_API_KEY,
      baseUrl: env.ANTHROPIC_BASE_URL,
      customHeaders: parseCustomHeaders(env.ANTHROPIC_CUSTOM_HEADERS),
    },
    dreamCurator: env.DREAM_CURATOR_MODE === "dedup" ? "dedup" : "model",
    execution: {
      ownerId: env.OMA_SESSION_EXECUTION_OWNER_ID ?? `node:${process.pid}:${nanoid()}`,
      concurrency: integer("OMA_SESSION_EXECUTION_CONCURRENCY", 8, { min: 1 }),
    },
    managedWebhooks: {
      url: env.OMA_MANAGED_AGENTS_WEBHOOK_URL,
      signingKey: env.OMA_MANAGED_AGENTS_WEBHOOK_SIGNING_KEY,
      organizationId: env.OMA_MANAGED_AGENTS_ORGANIZATION_ID,
    },
    paths: {
      sandboxWorkdir: env.SANDBOX_WORKDIR ?? "./data/sandboxes",
      sessionOutputs: env.SESSION_OUTPUTS_DIR ?? "./data/session-outputs",
    },
    http: {
      host: env.HOST ?? "0.0.0.0",
      // 0 asks the OS for an ephemeral port (tests and local tooling rely on it).
      port: integer("PORT", 8787, { min: 0, max: 65535 }),
      publicBaseUrl: env.PUBLIC_BASE_URL,
      gatewayOrigin: env.GATEWAY_ORIGIN ?? env.PUBLIC_BASE_URL ?? "http://localhost:8787",
      consoleDir: env.CONSOLE_DIR,
      metricsToken: env.METRICS_BIND_TOKEN,
      apiKey: env.API_KEY,
    },
    tunnels: { domainSuffix: env.TUNNEL_DOMAIN_SUFFIX ?? "tunnels.localhost" },
    integrationsInternalToken: env.INTEGRATIONS_INTERNAL_TOKEN,
    email,
    feishuWsRunner: flag("FEISHU_WS_RUNNER"),
    cron: {
      evalTick: cron("EVAL_TICK_CRON", "* * * * *"),
      memoryRetention: cron("MEMORY_RETENTION_CRON", "* * * * *"),
      webhookEventsRetention: cron("WEBHOOK_EVENTS_RETENTION_CRON", "* * * * *"),
      linearDispatch: cron("LINEAR_DISPATCH_CRON", "* * * * *"),
    },
    sandbox: { environment: env },
  };

  if (problems.length > 0) throw new NodeConfigError(problems);
  return config;
}

/**
 * The effective configuration with every secret removed, for startup logs
 * and diagnostics. Credentials inside URLs are masked; the sandbox provider's
 * namespace is dropped entirely because the control plane cannot know which
 * of its keys are secrets.
 */
export function redactNodeConfig(config: NodeConfig): Record<string, unknown> {
  const mask = (value: string | undefined): string | undefined => (value === undefined ? undefined : "***");
  const maskUrl = (url: string): string => {
    try {
      const parsed = new URL(url);
      if (parsed.password) parsed.password = "***";
      return parsed.toString();
    } catch {
      return "***";
    }
  };
  const blob = (backend: BlobBackendConfig & { pollIntervalMs?: number }) =>
    backend.kind === "localfs"
      ? backend
      : { ...backend, accessKey: mask(backend.accessKey), secretKey: mask(backend.secretKey) };
  const { sandbox: _sandbox, ...rest } = config;
  return {
    ...rest,
    database: config.database.kind === "sqlite" ? config.database : { ...config.database, url: maskUrl(config.database.url) },
    auth: {
      ...config.auth,
      secret: mask(config.auth.secret),
      google: { ...config.auth.google, clientSecret: mask(config.auth.google.clientSecret) },
      github: { ...config.auth.github, clientSecret: mask(config.auth.github.clientSecret) },
    },
    platformRootSecret: mask(config.platformRootSecret),
    blobs: { memory: blob(config.blobs.memory), files: blob(config.blobs.files) },
    model: { ...config.model, apiKey: mask(config.model.apiKey) },
    managedWebhooks: { ...config.managedWebhooks, signingKey: mask(config.managedWebhooks.signingKey) },
    http: { ...config.http, metricsToken: mask(config.http.metricsToken), apiKey: mask(config.http.apiKey) },
    integrationsInternalToken: mask(config.integrationsInternalToken),
    email: config.email === null ? null : { ...config.email, pass: mask(config.email.pass) },
  };
}

function parseCustomHeaders(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  const out: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const [name, ...rest] = part.split(":");
    if (!name || rest.length === 0) continue;
    out[name.trim()] = rest.join(":").trim();
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
