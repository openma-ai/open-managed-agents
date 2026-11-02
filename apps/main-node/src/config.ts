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
import { EMPTY_SANDBOX_IMAGE_CATALOG, parseSandboxImageCatalog } from "@open-managed-agents/sandbox";

import {
  parseAllowHosts,
  type BlobBackendConfig,
  type DatabaseConfig,
  type NodeConfig,
  type NodeEnvironment,
  type NodeProcessMode,
  type RealtimeFanoutConfig,
} from "@open-managed-agents/control-plane-node";

import { resolveNodeProcessMode, validateNodeProcessEnvironment } from "./process-mode.js";
import { resolveRealtimeFanout } from "./realtime-fanout.js";

// The typed settings contract lives with the control plane; this module only
// fills it in from the environment.
export {
  redactNodeConfig,
  type BlobBackendConfig,
  type DatabaseConfig,
  type NodeConfig,
  type NodeEnvironment,
} from "@open-managed-agents/control-plane-node";

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
    const keyPrefix = env[`${prefix}_PREFIX`]?.trim();
    if (keyPrefix && (keyPrefix.startsWith("/") || !keyPrefix.endsWith("/") || keyPrefix.split("/").includes(".."))) {
      problems.push(`${prefix}_PREFIX must be a relative object-key prefix ending in /`);
    }
    const pathStyle = env[`${prefix}_FORCE_PATH_STYLE`];
    if (pathStyle !== undefined && pathStyle !== "0" && pathStyle !== "1") problems.push(`${prefix}_FORCE_PATH_STYLE must be 0 or 1`);
    const conditionalCreate = env[`${prefix}_CONDITIONAL_CREATE`];
    if (conditionalCreate !== undefined && conditionalCreate !== "if-none-match" && conditionalCreate !== "oss-forbid-overwrite") {
      problems.push(`${prefix}_CONDITIONAL_CREATE must be if-none-match or oss-forbid-overwrite`);
    }
    const checksum = env[`${prefix}_REQUEST_CHECKSUM_CALCULATION`];
    if (checksum !== undefined && checksum !== "WHEN_REQUIRED" && checksum !== "WHEN_SUPPORTED") {
      problems.push(`${prefix}_REQUEST_CHECKSUM_CALCULATION must be WHEN_REQUIRED or WHEN_SUPPORTED`);
    }
    return {
      kind: "s3" as const, endpoint, bucket, accessKey, secretKey, region: env[`${prefix}_REGION`] ?? "us-east-1",
      ...(keyPrefix && !keyPrefix.startsWith("/") && keyPrefix.endsWith("/") && !keyPrefix.split("/").includes("..") ? { prefix: keyPrefix } : {}),
      ...(pathStyle === undefined ? {} : { forcePathStyle: pathStyle === "1" }),
      ...(checksum === "WHEN_REQUIRED" || checksum === "WHEN_SUPPORTED" ? { requestChecksumCalculation: checksum as "WHEN_REQUIRED" | "WHEN_SUPPORTED" } : {}),
      ...(conditionalCreate === "oss-forbid-overwrite" ? { conditionalCreate: "oss-forbid-overwrite" as const } : {}),
    };
  };
  const memoryS3 = s3("MEMORY_S3");
  const memory: NodeConfig["blobs"]["memory"] = memoryS3 === null
    ? { kind: "localfs", dir: env.MEMORY_BLOB_DIR ?? "./data/memory-blobs" }
    : { ...memoryS3, pollIntervalMs: Math.max(5_000, integer("MEMORY_S3_POLL_INTERVAL_SEC", 30) * 1000) };
  const files: BlobBackendConfig = s3("FILES_S3") ?? { kind: "localfs", dir: env.FILES_BLOB_DIR ?? "./data/files-blobs" };
  const workspaceStrategy = env.OMA_WORKSPACE_STRATEGY ?? "ephemeral";
  if (workspaceStrategy !== "ephemeral" && workspaceStrategy !== "checkpoint_restore") {
    problems.push("OMA_WORKSPACE_STRATEGY must be ephemeral or checkpoint_restore");
  }
  if (workspaceStrategy === "checkpoint_restore" && files.kind !== "s3") {
    problems.push("FILES_S3_* shared storage is required for checkpoint_restore");
  }
  let matter: NodeConfig["http"]["matter"];
  if (env.MATTER_URL) {
    let url: URL | undefined;
    try {
      url = new URL(env.MATTER_URL);
    } catch {
      problems.push("MATTER_URL must be an absolute http(s) URL");
    }
    if (url !== undefined && url.protocol !== "http:" && url.protocol !== "https:") {
      problems.push("MATTER_URL must be an absolute http(s) URL");
    } else if (url !== undefined && !env.MATTER_PROXY_SECRET) {
      problems.push("MATTER_PROXY_SECRET is required with MATTER_URL");
    } else if (url !== undefined && env.MATTER_PROXY_SECRET) {
      matter = { url: url.href.replace(/\/+$/, ""), proxySecret: env.MATTER_PROXY_SECRET };
    }
  }
  const checkpointIntervalMs = integer("OMA_WORKSPACE_CHECKPOINT_INTERVAL_SEC", 60, { min: 1 }) * 1000;
  const sandboxLeaseTtlMs = integer("OMA_SANDBOX_LEASE_TTL_SEC", 1800, { min: 60 }) * 1000;

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

  const skillSourceAllowHosts = attempt<string[]>([], () => parseAllowHosts(env.SKILL_SOURCES_ALLOW_HOSTS));
  const sandboxImages = attempt(EMPTY_SANDBOX_IMAGE_CATALOG, () => parseSandboxImageCatalog(env.SANDBOX_IMAGES));

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
    dreamCurator: env.DREAM_CURATOR_MODE === "dedup" ? "dedup" : "model",
    execution: {
      ownerId: env.OMA_SESSION_EXECUTION_OWNER_ID ?? `node:${process.pid}:${nanoid()}`,
      concurrency: integer("OMA_SESSION_EXECUTION_CONCURRENCY", 8, { min: 1 }),
    },
    workspace: {
      strategy: workspaceStrategy === "checkpoint_restore" ? "checkpoint_restore" : "ephemeral",
      checkpointIntervalMs,
      sandboxLeaseTtlMs,
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
      brandingDir: env.CONSOLE_BRANDING_DIR,
      metricsToken: env.METRICS_BIND_TOKEN,
      apiKey: env.API_KEY,
      matter,
    },
    tunnels: { domainSuffix: env.TUNNEL_DOMAIN_SUFFIX ?? "tunnels.localhost" },
    skillSources: { allowHosts: skillSourceAllowHosts },
    integrationsInternalToken: env.INTEGRATIONS_INTERNAL_TOKEN,
    email,
    feishuWsRunner: flag("FEISHU_WS_RUNNER"),
    cron: {
      evalTick: cron("EVAL_TICK_CRON", "* * * * *"),
      memoryRetention: cron("MEMORY_RETENTION_CRON", "* * * * *"),
      webhookEventsRetention: cron("WEBHOOK_EVENTS_RETENTION_CRON", "* * * * *"),
      linearDispatch: cron("LINEAR_DISPATCH_CRON", "* * * * *"),
    },
    sandbox: { environment: env, images: sandboxImages },
  };

  if (problems.length > 0) throw new NodeConfigError(problems);
  return config;
}
