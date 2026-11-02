// OMA Sandbox Durable Object for @cloudflare/sandbox 1.x.
// Legacy note: wires the @cloudflare/sandbox 0.8.x outbound
// handler API so vault credentials get injected into outbound requests
// (e.g. Bearer header for MCP server calls). The handler is bound at
// runtime via `sandbox.setOutboundHandler("inject_vault_creds", { ... })`
// — see apps/agent/src/runtime/session-do.ts for where that fires.
//
// Architectural property (mirrors Anthropic Managed Agents' "credential
// proxy outside the harness" pattern): this handler runs in the trusted
// agent Worker, outside the untrusted container. Its durable binding contains
// only the complete runtime scope + fence. A live lookup may return plaintext
// to this trusted handler long enough to construct the upstream request, but
// the credential is never placed in handler params, container memory, process
// env, checkpoints, or logs.
//
// Pre-refactor we passed `vault_credentials` directly to setOutboundHandler;
// CF Sandbox SDK then stashed them in container memory. A
// container-escape or prompt-injection-driven RCE could read them out.
// Post-refactor: container compromise cannot read the upstream credential.
// Compromise of the trusted Worker/control plane remains in the threat model
// and requires the platform's deployment isolation and secret controls.
//
// API reference: https://developers.cloudflare.com/changelog/post/2026-04-13-sandbox-outbound-workers-tls-auth/

import {
  DirectoryBackup,
  type DirectoryBackupRecord,
  Files,
  S3Mount,
} from "@cloudflare/sandbox";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "@open-managed-agents/shared";
import {
  buildCfTenantDbProvider,
  getCfServicesForTenant,
} from "@open-managed-agents/services";
import { recordBackup } from "./runtime/workspace-backups";

const BACKUP_TTL_SEC = 7 * 24 * 3600;
const BACKUP_CTX_KEY = "oma_backup_ctx";
// Per-container persistent storage of billing context — survives across
// onStart/onStop cycles within the same DO. We need both the (tenant,
// session, agent) tuple AND the start timestamp so onStop can compute
// elapsed seconds even after a DO restart.
const BILLING_CTX_KEY = "oma_billing_ctx";

interface BackupContext {
  tenantId: string;
  environmentId: string;
  sessionId: string;
}

interface BillingContext {
  tenantId: string;
  sessionId: string;
  agentId: string | null;
  /** Unix ms when the container most recently started (or first call landed). */
  startedAt: number;
}

// Match the SDK's OutboundHandlerContext shape (see @cloudflare/containers).
// We accept `unknown` env + cast at the boundary, so we don't need a direct
// import of the SDK's internal types.
interface SdkContext<P = unknown> {
  containerId: string;
  className: string;
  params: P;
}

export interface OutboundContextParams {
  tenantId?: string;
  environmentId?: string;
  sessionId?: string;
  workId?: string;
  ownerId?: string;
  generation?: number;
  fenceToken?: string;
  required?: boolean;
  /** Exact trusted API origin for the Work capability (scheme + host + port). */
  controlPlaneOrigin?: string;
}

interface RuntimeFenceLookupClaim {
  environmentId: string;
  workId: string;
  ownerId: string;
  generation: number;
  token: string;
}

function runtimeFenceClaim(params: OutboundContextParams): RuntimeFenceLookupClaim | null {
  if (
    typeof params.environmentId !== "string" || params.environmentId.length === 0
    || typeof params.workId !== "string" || params.workId.length === 0
    || typeof params.ownerId !== "string" || params.ownerId.length === 0
    || !Number.isSafeInteger(params.generation) || (params.generation ?? 0) < 1
    || typeof params.fenceToken !== "string" || params.fenceToken.length === 0
  ) {
    return null;
  }
  return {
    environmentId: params.environmentId,
    workId: params.workId,
    ownerId: params.ownerId,
    generation: params.generation!,
    token: params.fenceToken,
  };
}

/**
 * Headers we strip before forwarding upstream. CF Workers auto-adds some
 * of these when you invoke `fetch()` from a worker; if they're in the
 * upstream's SigV4-signed-headers list (boto3, aws-sdk, s3fs, awscli),
 * the signature mismatch produces a 403. The container's libcurl/sdk
 * never set these — they're CF artifacts of going through our handler.
 *
 * `host` is also problematic: container's libcurl set it to upstream's
 * host; if we forward via `new Request(url, { headers })` the runtime
 * may rewrite based on URL. We trust the runtime's auto-set Host
 * (matches URL) so we strip the explicit one to avoid header collision.
 */
const HOP_BY_HOP_OR_CF_HEADERS = new Set([
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "cf-worker",
  "cf-ew-via",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-real-ip",
  "x-amzn-trace-id",
  "host",
]);

const SANDBOX_CONTROL_HEADERS = [
  "x-api-key",
  "proxy-authorization",
  "cookie",
  "x-active-tenant",
] as const;

export const handleCredentialEgressRequest = async (
  request: Request,
  env: unknown,
  ctx: SdkContext<OutboundContextParams>,
): Promise<Response> => {
  const url = new URL(request.url);
  const params = ctx.params ?? {};
  const e = env as Env;

  // Look up credential metadata for this host. Lightweight RPC — only
  // the resolved bearer token crosses the wire. Body + response stay
  // local to the agent worker so transparent forwarding preserves all
  // HTTP semantics (HEAD Content-Length, SigV4 signed headers,
  // Transfer-Encoding: chunked, streaming, Trailer, etc).
  const required = params.required === true;
  const fence = runtimeFenceClaim(params);
  if (required && (
    !params.tenantId
    || !params.sessionId
    || fence === null
    || e.MAIN_MCP === undefined
  )) {
    return new Response("credential egress denied: invalid runtime binding", {
      status: 403,
    });
  }

  let cred: { type: "bearer"; token: string } | null = null;
  if (params.tenantId && params.sessionId && e.MAIN_MCP) {
    try {
      cred = await e.MAIN_MCP.lookupOutboundCredential({
        tenantId: params.tenantId,
        sessionId: params.sessionId,
        hostname: url.hostname,
        ...(fence === null ? {} : { runtimeFence: fence }),
      });
    } catch (err) {
      console.error(
        `[oma-sandbox] lookupOutboundCredential threw host=${url.hostname}: ${(err as Error)?.message ?? err}`,
      );
      if (required) {
        return new Response("credential egress unavailable", { status: 502 });
      }
    }
  }

  // Build outgoing request: clone with CF-internal headers stripped +
  // bearer token injected. Body handling:
  //   - GET / HEAD: no body
  //   - others: materialize body as ArrayBuffer so Workers fetch can
  //     compute and send Content-Length. Workers strips Content-Length
  //     from stream bodies and switches to chunked encoding, which R2
  //     presigned-URL PUTs reject with 411 "Length Required". Buffering
  //     is acceptable for our use case (workspace squashfs uploads
  //     are typically <100 MB; very large would need a streaming-with-
  //     known-length API, doesn't currently exist in Workers).
  const outHeaders = new Headers(request.headers);
  for (const h of HOP_BY_HOP_OR_CF_HEADERS) outHeaders.delete(h);
  for (const h of SANDBOX_CONTROL_HEADERS) outHeaders.delete(h);
  // In enforced mode an agent cannot smuggle a credential around Vault by
  // supplying its own Authorization value. Public destinations still pass,
  // but without sandbox-owned bearer material.
  if (required) outHeaders.delete("authorization");
  if (cred) {
    outHeaders.set("authorization", `Bearer ${cred.token}`);
  }

  let upstreamReq: Request;
  if (request.method === "GET" || request.method === "HEAD") {
    upstreamReq = new Request(request.url, {
      method: request.method,
      headers: outHeaders,
      redirect: "manual",
    });
  } else {
    // Materialize body — Workers needs a known-length body to set
    // Content-Length on the outbound request.
    const bodyBytes = await request.arrayBuffer();
    upstreamReq = new Request(request.url, {
      method: request.method,
      headers: outHeaders,
      body: bodyBytes,
      redirect: "manual",
    });
  }

  console.log(
    `[oma-sandbox] outbound host=${url.hostname} method=${request.method} cred=${cred ? "yes" : "no"}`,
  );

  // Return upstream Response unchanged — preserves status, headers,
  // body stream, all HTTP semantics. NO new Response() constructor
  // reconstruction (which is what was overwriting Content-Length on
  // HEAD responses for s3fs reading R2-mounted backup files).
  return fetch(upstreamReq);
};

export const denyCredentialEgressRequest = async (
  _request: Request,
  _env: unknown,
  _ctx: SdkContext<unknown>,
): Promise<Response> => new Response("credential egress binding revoked", {
  status: 403,
});

function isAllowedWorkCapabilityPath(
  pathname: string,
  params: OutboundContextParams,
): boolean {
  const parts = pathname.split("/").filter(Boolean).map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return "";
    }
  });
  if (
    parts.length === 5
    && parts[0] === "v1"
    && parts[1] === "oma"
    && parts[2] === "mcp-proxy"
    && parts[3] === params.sessionId
    && parts[4]!.length > 0
  ) return true;
  if (
    parts.length >= 5
    && parts[0] === "v1"
    && parts[1] === "oma"
    && parts[2] === "inference-proxy"
    && parts[3] === params.sessionId
    && parts[4]!.length > 0
  ) return true;
  if (
    parts.length >= 3
    && parts[0] === "v1"
    && parts[1] === "sessions"
    && parts[2] === params.sessionId
  ) return true;
  if (
    parts.length === 6
    && parts[0] === "v1"
    && parts[1] === "environments"
    && parts[2] === params.environmentId
    && parts[3] === "work"
    && parts[4] === params.workId
    && (parts[5] === "heartbeat" || parts[5] === "stop")
  ) return true;
  if (
    parts[0] === "v1"
    && parts[1] === "files"
    && parts[2]?.length
    && (parts.length === 3 || (parts.length === 4 && parts[3] === "content"))
  ) return true;
  return parts[0] === "v1"
    && (parts[1] === "skills" || parts[1] === "memory_stores");
}

/**
 * Explicit Layer-A exception for the current Work capability. The catch-all
 * Vault handler strips sandbox Authorization, so managed Work traffic needs a
 * narrower per-host handler. This function preserves only a sealed Work token,
 * only to the exact configured OpenMA origin, and only for Work-authorized API
 * families. The main API still decrypts the token and validates the live claim
 * on every request.
 */
export const handleOpenmaControlPlaneRequest = async (
  request: Request,
  _env: unknown,
  ctx: SdkContext<OutboundContextParams>,
): Promise<Response> => {
  const params = ctx.params ?? {};
  let expectedOrigin: string;
  try {
    expectedOrigin = new URL(params.controlPlaneOrigin ?? "").origin;
  } catch {
    return new Response("control-plane egress denied: invalid binding", { status: 403 });
  }
  const url = new URL(request.url);
  const authorization = request.headers.get("authorization") ?? "";
  if (
    url.origin !== expectedOrigin
    || !authorization.startsWith("Bearer sk-ant-req-v1.")
    || !isAllowedWorkCapabilityPath(url.pathname, params)
  ) {
    return new Response("control-plane egress denied", { status: 403 });
  }

  const headers = new Headers(request.headers);
  for (const name of HOP_BY_HOP_OR_CF_HEADERS) headers.delete(name);
  for (const name of SANDBOX_CONTROL_HEADERS) headers.delete(name);
  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: "manual",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.arrayBuffer();
  }
  return fetch(new Request(request.url, init));
};

const injectVaultCredsHandler = handleCredentialEgressRequest;


// Per-host bypass for R2 — createBackup / restoreBackup do raw S3-style
// PUT/GET/HEAD against `*.r2.cloudflarestorage.com` from inside the
// container, and so do agent-driven presigned PUTs from the
// /v1/oma/internal/sessions/:id/uploads/presign flow. Routing those through
// inject_vault_creds (which materializes bodies + uses Workers fetch)
// corrupts the squashfs blob — see cloudflare/sandbox-sdk#619 ("Failed
// to mount squashfs: This doesn't look like a squashfs image" when
// interceptHttps + custom handler). outboundByHost runs at line 217 of
// @cloudflare/containers/lib/container.js BEFORE the catch-all handler.
//
// PUT body shape: Workers fetch ignores user-set Content-Length and
// switches stream bodies to chunked encoding (per
// developers.cloudflare.com/workers/runtime-apis/request — "Any value
// manually set by user code in the Headers will be ignored"). R2 returns
// 411 MissingContentLength on chunked PUTs (sandbox-sdk#660). To
// preserve Content-Length, we materialize the body to ArrayBuffer for
// PUT/POST/PATCH/DELETE and let Workers fetch derive the size from a
// known-length source. GET/HEAD pass through unchanged so squashfs reads
// keep their byte-exact streaming behaviour.
const r2OutboundPassthrough = async (request: Request): Promise<Response> => {
  if (request.method === "GET" || request.method === "HEAD") {
    return fetch(request);
  }
  const bodyBytes = await request.arrayBuffer();
  // Strip the Cf-derived headers that confuse upstream signature-checks
  // when the request is replayed through Workers fetch.
  const outHeaders = new Headers(request.headers);
  for (const h of HOP_BY_HOP_OR_CF_HEADERS) outHeaders.delete(h);
  return fetch(
    new Request(request.url, {
      method: request.method,
      headers: outHeaders,
      body: bodyBytes,
      redirect: "manual",
    }),
  );
};

// Per-host network-layer GitHub credential injection (γ proxy).
//
// Sandbox containers fire plain HTTPS at github.com (smart-HTTP git
// protocol) and api.github.com (REST/GraphQL) with no Authorization
// header — neither ~/.git-credentials nor GITHUB_TOKEN env exists in the
// sandbox by design. Two-track credential resolution:
//
//   ① per-repo lookup (lookupGithubCredential): for sessions that
//     attached one or more github_repository resources. Most specific —
//     matches the request's owner/repo path, returns that resource's
//     scoped token.
//   ② vault fallback (lookupOutboundCredential → cap_cli cli_id="gh"):
//     for sessions whose vault has a cap_cli credential for gh but no
//     per-repo resource. Generic GitHub access via the user's vault.
//
// Per-repo wins over vault (more specific scope > less specific). When
// neither matches, fall through unauthenticated — same as before.
//
// Auth scheme is host-specific:
//   - github.com   → Basic base64("x-access-token:<token>") (smart-HTTP)
//   - api.github.com → Bearer <token> (REST/GraphQL)
//
// Multi-repo per-repo fallback: if the request URL doesn't match any
// mounted repo's owner/repo slug, lookupGithubCredential uses the first
// declared repo's token. Cross-token mutations (graphql to repo B with
// token A's scope) return GitHub's standard error envelope; we don't
// retry.
const githubAuthHandler = async (
  request: Request,
  env: unknown,
  ctx: SdkContext<OutboundContextParams>,
): Promise<Response> => {
  const url = new URL(request.url);
  const params = ctx.params ?? {};
  const e = env as Env;
  const required = params.required === true;
  const fence = runtimeFenceClaim(params);
  if (required && (
    !params.tenantId
    || !params.sessionId
    || fence === null
    || e.MAIN_MCP === undefined
  )) {
    return new Response("credential egress denied: invalid runtime binding", {
      status: 403,
    });
  }

  let cred: { scheme: "Basic" | "Bearer"; token: string; slug: string } | null = null;

  // ① per-repo first
  if (params.tenantId && params.sessionId && e.MAIN_MCP) {
    try {
      cred = await e.MAIN_MCP.lookupGithubCredential({
        tenantId: params.tenantId,
        sessionId: params.sessionId,
        hostname: url.hostname,
        pathname: url.pathname,
        ...(fence === null ? {} : { runtimeFence: fence }),
      });
    } catch (err) {
      console.error(
        `[oma-sandbox] lookupGithubCredential threw host=${url.hostname}: ${(err as Error)?.message ?? err}`,
      );
      if (required) {
        return new Response("credential egress unavailable", { status: 502 });
      }
    }
  }

  // ② vault fallback (cap_cli cli_id="gh")
  //
  // Always query at api.github.com (cap's gh spec endpoint) regardless of
  // the actual request host — same GitHub token serves both git protocol
  // and REST API, scheme is decided locally based on request host. cap's
  // spec model intentionally doesn't carry per-endpoint scheme config;
  // GitHub's dual-scheme quirk lives in this GitHub-specific handler.
  if (!cred && params.tenantId && params.sessionId && e.MAIN_MCP) {
    try {
      const fallback = await e.MAIN_MCP.lookupOutboundCredential({
        tenantId: params.tenantId,
        sessionId: params.sessionId,
        hostname: "api.github.com",
        ...(fence === null ? {} : { runtimeFence: fence }),
      });
      if (fallback) {
        cred = {
          scheme: url.hostname === "github.com" ? "Basic" : "Bearer",
          token: fallback.token,
          slug: "vault:gh",
        };
      }
    } catch (err) {
      console.error(
        `[oma-sandbox] cap fallback threw host=${url.hostname}: ${(err as Error)?.message ?? err}`,
      );
      if (required) {
        return new Response("credential egress unavailable", { status: 502 });
      }
    }
  }

  const outHeaders = new Headers(request.headers);
  for (const h of HOP_BY_HOP_OR_CF_HEADERS) outHeaders.delete(h);
  for (const h of SANDBOX_CONTROL_HEADERS) outHeaders.delete(h);
  if (required) outHeaders.delete("authorization");
  if (cred) {
    const value = cred.scheme === "Basic"
      ? `Basic ${btoa(`x-access-token:${cred.token}`)}`
      : `Bearer ${cred.token}`;
    outHeaders.set("authorization", value);
  }

  let upstreamReq: Request;
  if (request.method === "GET" || request.method === "HEAD") {
    upstreamReq = new Request(request.url, {
      method: request.method,
      headers: outHeaders,
      redirect: "manual",
    });
  } else {
    // Materialize body — Workers needs known-length to set Content-Length
    // (same constraint as injectVaultCredsHandler / r2OutboundPassthrough).
    const bodyBytes = await request.arrayBuffer();
    upstreamReq = new Request(request.url, {
      method: request.method,
      headers: outHeaders,
      body: bodyBytes,
      redirect: "manual",
    });
  }

  console.log(
    `[oma-sandbox] github host=${url.hostname} method=${request.method} cred=${cred ? cred.slug : "none"}`,
  );
  return fetch(upstreamReq);
};



const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;
const RULES_KEY = "OUTBOUND_CONFIGURATION";
const ACTIVE_MOUNTS_KEY = "oma_active_mounts";
const CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
const BUNDLE = "/etc/ssl/certs/ca-certificates.crt";
const SYSTEM_CA = "/etc/ssl/certs/ca-certificates.system.crt";
const CONTAINER_ENV = {
  NODE_EXTRA_CA_CERTS: CA,
  REQUESTS_CA_BUNDLE: BUNDLE,
};
const DEFAULT_BACKUP_TTL_SECONDS = BACKUP_TTL_SEC;
const metaKey = (id: string) => `backups/${id}.meta.json`;
const EXPIRY_MARGIN_MS = 60_000;

type HandlerRef = { method: string; params?: unknown };
type StoredRules = {
  outboundByHostOverrides?: Record<string, HandlerRef>;
  outboundHandlerOverride?: HandlerRef;
  allowedHosts?: string[];
  deniedHosts?: string[];
};

type OutboundHandlerFn = (
  request: Request,
  env: unknown,
  ctx: SdkContext<any>,
) => Response | Promise<Response>;

const HANDLERS: Record<string, OutboundHandlerFn> = {
  inject_vault_creds: handleCredentialEgressRequest,
  github_auth: githubAuthHandler,
  openma_control_plane: handleOpenmaControlPlaneRequest,
  deny_outbound: denyCredentialEgressRequest,
};

// Populated by live certification worker and tests that register extra handlers.
export function registerOmaOutboundHandler(name: string, fn: OutboundHandlerFn): void {
  HANDLERS[name] = fn;
}

const STATIC_OUTBOUND_BY_HOST: Record<string, HandlerRef | OutboundHandlerFn> = {
  "*.r2.cloudflarestorage.com": r2OutboundPassthrough,
};

function matches(pattern: string, hostname: string): boolean {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${escaped.join(".*")}$`).test(hostname);
}

function lookupHandler(
  handlers: Record<string, HandlerRef> | undefined,
  hostname: string,
): HandlerRef | undefined {
  if (!handlers) return undefined;
  if (handlers[hostname]) return handlers[hostname];
  const hit = Object.entries(handlers).find(([pattern]) => matches(pattern, hostname));
  return hit?.[1];
}

function lookupStaticHost(
  hostname: string,
): HandlerRef | OutboundHandlerFn | undefined {
  if (STATIC_OUTBOUND_BY_HOST[hostname]) return STATIC_OUTBOUND_BY_HOST[hostname];
  const hit = Object.entries(STATIC_OUTBOUND_BY_HOST).find(([pattern]) =>
    matches(pattern, hostname),
  );
  return hit?.[1];
}

/**
 * Outbound WorkerEntrypoint — replaces 0.x ContainerProxy + outboundByHost /
 * setOutboundHandler. Props carry runtime rules (session fence, handler names).
 */
export class OmaOutbound extends WorkerEntrypoint<Env, StoredRules> {
  async fetch(request: Request): Promise<Response> {
    const rules = this.ctx.props ?? {};
    const url = new URL(request.url);
    const hostname = url.hostname.replace(/\.+$/, "");
    const blocked = new Response("Origin is disallowed", { status: 520 });

    if (rules.deniedHosts?.some((p) => matches(p, hostname))) return blocked;
    if (rules.allowedHosts && !rules.allowedHosts.some((p) => matches(p, hostname))) {
      return blocked;
    }

    const staticHost = lookupStaticHost(hostname);
    if (typeof staticHost === "function") {
      return staticHost(request, this.env, {
        containerId: "oma",
        className: "Sandbox",
        params: {},
      });
    }

    const handler =
      lookupHandler(rules.outboundByHostOverrides, hostname) ??
      (typeof staticHost === "object" ? staticHost : undefined) ??
      rules.outboundHandlerOverride;

    if (handler && HANDLERS[handler.method]) {
      return HANDLERS[handler.method]!(request, this.env, {
        containerId: "oma",
        className: "Sandbox",
        params: (handler.params ?? {}) as OutboundContextParams,
      });
    }

    // enableInternet=false in 0.x OMA — block anything without a handler.
    return blocked;
  }
}

export class OmaSandbox extends DurableObject<Env> {
  private setup: Promise<void> | null = null;
  private processEnv: Record<string, string> = {};
  private readonly files = new Files(this.container);
  private readonly backups = new DirectoryBackup(
    this.container,
    (this.ctx.exports as unknown as { DirectoryBackupGateway: ConstructorParameters<typeof DirectoryBackup>[1] }).DirectoryBackupGateway,
    { binding: "BACKUP_BUCKET", prefix: "backups/" },
  );
  private readonly mounts = new S3Mount(
    this.container,
    (this.ctx.exports as unknown as { S3Gateway: ConstructorParameters<typeof S3Mount>[1] }).S3Gateway,
  );

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const container = ctx.container;
    if (container?.running) {
      void ctx.blockConcurrencyWhile(() =>
        container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS),
      );
    }
  }

  private get container(): Container {
    const container = this.ctx.container;
    if (!container) throw new Error("No container is configured");
    return container;
  }

  private rules(): StoredRules {
    return (this.ctx.storage.kv.get(RULES_KEY) as StoredRules | undefined) ?? {};
  }

  private async saveRules(next: StoredRules): Promise<void> {
    this.ctx.storage.kv.put(RULES_KEY, next);
  }

  private async intercept(): Promise<void> {
    // DirectoryBackup must register before the catch-all outbound intercept.
    await this.backups.intercept();
    const outbound = (this.ctx.exports as unknown as { OmaOutbound: (o: { props: StoredRules }) => Fetcher }).OmaOutbound({ props: this.rules() });
    await this.container.interceptAllOutboundHttp(outbound);
    await this.container.interceptOutboundHttps("*", outbound);
  }

  private async trustCa(): Promise<void> {
    const trust = await this.container.exec([
      "sh",
      "-c",
      `[ -e ${SYSTEM_CA} ] || { cp ${BUNDLE} ${SYSTEM_CA}.tmp && mv ${SYSTEM_CA}.tmp ${SYSTEM_CA}; }
timeout 10 sh -c 'until [ -s ${CA} ]; do sleep 0.1; done' && cat ${SYSTEM_CA} ${CA} >${BUNDLE}.tmp && mv ${BUNDLE}.tmp ${BUNDLE}`,
    ]);
    if ((await trust.exitCode) !== 0) {
      throw new Error("The container did not trust the intercept CA");
    }
  }

  private async startContainer(): Promise<void> {
    const newContainer = !this.container.running;
    if (newContainer) {
      this.container.start({
        image: this.container.images.sandbox,
        instance: "standard-1",
        env: { ...CONTAINER_ENV, ...this.processEnv },
        enableInternet: false,
      });
    }
    try {
      if (newContainer) {
        await this.ctx.storage.put(BILLING_CTX_KEY + ":started", Date.now());
      }
      await this.intercept();
      await this.trustCa();
      await this.container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
      this.watch();
    } catch (error) {
      await this.container.destroy().catch(() => {});
      throw error;
    }
  }

  private ensureRunning(): Promise<void> {
    if (this.setup === null || !this.container.running) {
      this.setup = this.startContainer().catch((error) => {
        this.setup = null;
        throw error;
      });
    }
    return this.setup;
  }

  private watch(): void {
    this.container.monitor().then(
      async () => {
        console.log("[oma-sandbox] container exited 0");
        await this.recordSandboxActiveOnStop();
      },
      async (error: unknown) => {
        console.error("[oma-sandbox] container stopped", error);
        await this.recordSandboxActiveOnStop();
      },
    );
  }

  /** 0.x-compatible: string command → bash -lc, return buffered result. */
  async exec(
    command: string,
    options?: { timeout?: number; cwd?: string; env?: Record<string, string> },
  ): Promise<{ stdout: string; stderr: string; exitCode: number; success: boolean }> {
    await this.ensureRunning();
    const env = { ...CONTAINER_ENV, ...this.processEnv, ...(options?.env ?? {}) };
    const timeoutMs = options?.timeout;
    const argv = ["/bin/bash", "-lc", command];
    const proc = await this.container.exec(argv, {
      cwd: options?.cwd ?? "/workspace",
      env,
      ...(timeoutMs ? { timeout: timeoutMs } : {}),
    } as any);
    const result = await proc.output();
    const stdout = new TextDecoder().decode(result.stdout ?? new Uint8Array());
    const stderr = new TextDecoder().decode(result.stderr ?? new Uint8Array());
    const exitCode = result.exitCode ?? 1;
    return { stdout, stderr, exitCode, success: exitCode === 0 };
  }

  async readFile(
    path: string,
    _options?: { encoding?: string },
  ): Promise<{ content: string; success: boolean }> {
    await this.ensureRunning();
    const response = await this.files.readFile(path, {
      cwd: path.startsWith("/") ? undefined : "/workspace",
    } as any);
    const content = await response.text();
    return { content, success: true };
  }

  async writeFile(
    path: string,
    content: string,
    options?: { encoding?: string },
  ): Promise<{ success: boolean }> {
    await this.ensureRunning();
    const abs = path.startsWith("/") ? path : `/workspace/${path}`;
    const parent = abs.slice(0, abs.lastIndexOf("/")) || "/";
    await this.files.mkdir(parent, { recursive: true }).catch(() => {});
    if (options?.encoding === "base64") {
      const bin = Uint8Array.from(atob(content), (c) => c.charCodeAt(0));
      await this.files.writeFile(abs, bin);
    } else {
      await this.files.writeFile(abs, content);
    }
    return { success: true };
  }

  async createBackup(options: {
    dir: string;
    name?: string;
    excludes?: string[];
    gitignore?: boolean;
    ttl?: number;
    localBucket?: boolean;
  }): Promise<{ id: string; dir: string; localBucket?: boolean; expiresAt?: number }> {
    await this.ensureRunning();
    const ttl = options.ttl ?? DEFAULT_BACKUP_TTL_SECONDS;
    const backup = await this.backups.backup({
      dir: options.dir,
      name: options.name,
      gitignore: options.gitignore,
      exclude: options.excludes?.map((pattern) =>
        pattern.includes("/") ? pattern : `**/${pattern}`,
      ),
    });
    const expiresAt = Date.now() + ttl * 1000;
    const bucket = (this.env as Env & { BACKUP_BUCKET?: R2Bucket }).BACKUP_BUCKET;
    if (bucket) {
      await bucket.put(metaKey(backup.id), JSON.stringify({ expiresAt }));
    }
    return {
      id: backup.id,
      dir: backup.dir,
      // 1.0 always uses the R2 binding; keep field for older callers.
      localBucket: options.localBucket,
      expiresAt,
    };
  }

  async restoreBackup(handle: {
    id: string;
    dir: string;
    localBucket?: boolean;
    sha256?: string;
    size?: number;
    format?: string;
    name?: string;
  }): Promise<{ success: boolean; dir: string; id: string }> {
    await this.ensureRunning();
    const bucket = (this.env as Env & { BACKUP_BUCKET?: R2Bucket }).BACKUP_BUCKET;
    if (bucket) {
      const meta = await bucket.get(metaKey(handle.id));
      if (meta) {
        const { expiresAt } = await meta.json<{ expiresAt: number }>();
        if (Date.now() + EXPIRY_MARGIN_MS > expiresAt) {
          throw new Error(`Backup ${handle.id} has expired`);
        }
      }
    }
    // DirectoryBackupRecord requires sha256/size/format when fully typed;
    // restore accepts the stored record. If only id+dir (OMA D1 handle),
    // attempt restore with a minimal record and let the SDK validate.
    const record = handle as unknown as DirectoryBackupRecord;
    await this.backups.restore(record);
    return { success: true, dir: handle.dir, id: handle.id };
  }

  async mountBucket(
    bucket: string,
    mountPath: string,
    options: {
      endpoint?: string;
      provider?: string;
      credentials?: { accessKeyId: string; secretAccessKey: string };
      prefix?: string;
      readOnly?: boolean;
      credentialProxy?: boolean;
      localBucket?: boolean;
    } = {},
  ): Promise<void> {
    await this.ensureRunning();
    if (options.localBucket) {
      // 1.0 cannot mount via R2 binding name alone. Fall back to mkdir so
      // wrangler-dev paths that previously used localBucket keep a writable dir.
      await this.exec(`mkdir -p ${JSON.stringify(mountPath)}`, { timeout: 10_000 });
      await this.trackMount(mountPath);
      return;
    }
    const endpoint = options.endpoint;
    const credentials = options.credentials;
    if (!endpoint || !credentials) {
      throw new Error("mountBucket requires endpoint and credentials in Sandbox SDK 1.0");
    }
    const keyPrefix = (options.prefix ?? "").replace(/^\/+/, "").replace(/\/+$/, "");
    await this.mounts.mount({
      mountPath,
      source: {
        type: "s3",
        endpoint,
        region: "auto",
        bucket,
        credentials: {
          type: "static",
          accessKeyId: credentials.accessKeyId,
          secretAccessKey: credentials.secretAccessKey,
        },
      },
      keyPrefix,
      access: options.readOnly ? "read-only" : "read-write",
    } as any);
    await this.trackMount(mountPath);
  }

  async unmountBucket(mountPath: string): Promise<void> {
    if (!this.container.running) {
      await this.untrackMount(mountPath);
      return;
    }
    try {
      await this.mounts.unmount(mountPath);
    } finally {
      await this.untrackMount(mountPath);
    }
  }

  private async trackMount(path: string): Promise<void> {
    const cur = ((await this.ctx.storage.get(ACTIVE_MOUNTS_KEY)) as string[] | undefined) ?? [];
    if (!cur.includes(path)) {
      await this.ctx.storage.put(ACTIVE_MOUNTS_KEY, [...cur, path]);
    }
  }

  private async untrackMount(path: string): Promise<void> {
    const cur = ((await this.ctx.storage.get(ACTIVE_MOUNTS_KEY)) as string[] | undefined) ?? [];
    await this.ctx.storage.put(
      ACTIVE_MOUNTS_KEY,
      cur.filter((p) => p !== path),
    );
  }

  private async unmountAllBuckets(): Promise<void> {
    const paths = ((await this.ctx.storage.get(ACTIVE_MOUNTS_KEY)) as string[] | undefined) ?? [];
    await Promise.all(
      paths.map((p) =>
        this.unmountBucket(p).catch((err: Error) =>
          console.warn(`[oma-sandbox] pre-stop unmount ${p} failed: ${err?.message ?? err}`),
        ),
      ),
    );
  }

  async setEnvVars(envVars: Record<string, string>): Promise<void> {
    Object.assign(this.processEnv, envVars);
  }

  async renewActivityTimeout(): Promise<void> {
    if (this.container.running) {
      await this.container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
    }
  }

  async setOutboundHandler(method: string, params?: unknown): Promise<void> {
    const cur = this.rules();
    await this.saveRules({
      ...cur,
      outboundHandlerOverride: { method, params },
    });
    if (this.container.running) await this.intercept();
  }

  async setOutboundByHost(
    host: string,
    method: string,
    params?: unknown,
  ): Promise<void> {
    const cur = this.rules();
    await this.saveRules({
      ...cur,
      outboundByHostOverrides: {
        ...(cur.outboundByHostOverrides ?? {}),
        [host]: { method, params },
      },
    });
    if (this.container.running) await this.intercept();
  }

  async setBackupContext(ctx: BackupContext): Promise<void> {
    await this.ctx.storage.put(BACKUP_CTX_KEY, ctx);
  }

  async setBillingContext(ctx: Omit<BillingContext, "startedAt">): Promise<void> {
    const existing = (await this.ctx.storage.get(BILLING_CTX_KEY)) as
      | BillingContext
      | undefined;
    if (existing && existing.sessionId === ctx.sessionId) return;
    await this.ctx.storage.put(BILLING_CTX_KEY, {
      tenantId: ctx.tenantId,
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      startedAt: Date.now(),
    });
  }

  async snapshotWorkspaceNow(): Promise<void> {
    try {
      const env = this.env as Env;
      const ctx = (await this.ctx.storage.get(BACKUP_CTX_KEY)) as
        | BackupContext
        | undefined;
      if (!ctx || !env.MAIN_DB) return;
      const startMs = Date.now();
      const backup = await this.createBackup({
        dir: "/workspace",
        name: `session-${ctx.sessionId}`,
        ttl: BACKUP_TTL_SEC,
        excludes: ["node_modules", ".cache", "__pycache__", ".next", "target"],
        gitignore: true,
      });
      const elapsedMs = Date.now() - startMs;
      if (!backup) return;
      const provider = buildCfTenantDbProvider(env);
      const backupDb = await provider.resolve(ctx.tenantId);
      await recordBackup(backupDb, {
        tenantId: ctx.tenantId,
        environmentId: ctx.environmentId,
        handle: { id: backup.id, dir: backup.dir, localBucket: backup.localBucket },
        nowMs: Date.now(),
        ttlSec: BACKUP_TTL_SEC,
        sessionId: ctx.sessionId,
      });
      console.log(
        `[oma-sandbox] backup recorded id=${backup.id} session=${ctx.sessionId.slice(0, 12)} elapsed_ms=${elapsedMs}`,
      );
    } catch (err) {
      console.error(
        `[oma-sandbox] snapshotWorkspaceNow failed: ${(err as Error).message ?? err}`,
      );
    }
  }

  async emitSandboxActiveNow(): Promise<void> {
    await this.recordSandboxActiveOnStop();
  }

  async destroy(): Promise<void> {
    try {
      await this.snapshotWorkspaceNow();
      await this.unmountAllBuckets();
    } catch {
      /* best-effort */
    }
    await this.recordSandboxActiveOnStop();
    if (this.container.running) {
      await this.container.destroy();
    }
    this.setup = null;
  }

  /**
   * Idle teardown — 1.0 has no onActivityExpired. Callers that previously
   * relied on sleepAfter should alarm; destroy() remains the explicit path.
   * Exposed for parity / tests.
   */
  async onActivityExpired(): Promise<void> {
    await this.snapshotWorkspaceNow();
    await this.unmountAllBuckets();
    const responsive = await this.probeShimAlive(5_000);
    if (!responsive) {
      console.warn(`[oma-sandbox] onActivityExpired: shim unresponsive, force-destroying`);
      try {
        await this.destroy();
      } catch (err) {
        console.warn(`[oma-sandbox] force-destroy failed:`, err);
      }
      return;
    }
    await this.destroy();
  }

  private async probeShimAlive(timeoutMs: number): Promise<boolean> {
    try {
      await this.exec("true", { timeout: timeoutMs });
      return true;
    } catch {
      return false;
    }
  }

  private async recordSandboxActiveOnStop(): Promise<void> {
    try {
      const env = this.env as Env;
      const ctx = (await this.ctx.storage.get(BILLING_CTX_KEY)) as
        | BillingContext
        | undefined;
      if (!ctx) return;
      const elapsedMs = Date.now() - ctx.startedAt;
      if (elapsedMs <= 0) return;
      const seconds = Math.floor(elapsedMs / 1000);
      if (seconds <= 0) return;
      const services = await getCfServicesForTenant(env, ctx.tenantId);
      await services.usage.recordUsage({
        tenantId: ctx.tenantId,
        sessionId: ctx.sessionId,
        agentId: ctx.agentId,
        kind: "sandbox_active_seconds",
        value: seconds,
      });
      await this.ctx.storage.delete(BILLING_CTX_KEY);
      console.log(
        `[oma-sandbox] usage emit sandbox_active_seconds=${seconds} session=${ctx.sessionId.slice(0, 12)}`,
      );
    } catch (err) {
      console.error(
        `[oma-sandbox] recordSandboxActiveOnStop failed: ${(err as Error).message ?? err}`,
      );
    }
  }

  /**
   * Minimal startProcess shim for duplex / ACP — background bash writing to
   * log files. Not a full 0.x Process port; enough for CloudflareSandbox
   * spawnDuplexProcess when wired. Returns null-shaped failure via throw.
   */
  async startProcess(
    command: string,
    options?: { env?: Record<string, string>; cwd?: string },
  ): Promise<{
    id: string;
    pid?: number;
    kill: (signal?: string) => Promise<void>;
    getLogs: () => Promise<{ stdout: string; stderr: string }>;
    getStatus: () => Promise<string>;
  }> {
    await this.ensureRunning();
    const id = crypto.randomUUID();
    const dir = `/tmp/oma-proc-${id}`;
    const env = { ...CONTAINER_ENV, ...this.processEnv, ...(options?.env ?? {}) };
    await this.exec(
      `mkdir -p ${dir} && nohup /bin/bash -lc ${JSON.stringify(command)} >${dir}/stdout 2>${dir}/stderr & echo $! >${dir}/pid`,
      { timeout: 30_000, cwd: options?.cwd ?? "/workspace", env },
    );
    const pidText = await this.readFile(`${dir}/pid`);
    const pid = Number.parseInt(pidText.content.trim(), 10) || undefined;
    return {
      id,
      pid,
      kill: async (signal = "SIGTERM") => {
        const sig = signal === "SIGKILL" ? "9" : "15";
        await this.exec(
          `kill -${sig} $(cat ${dir}/pid) 2>/dev/null || true`,
          { timeout: 10_000 },
        );
      },
      getLogs: async () => {
        const out = await this.readFile(`${dir}/stdout`).catch(() => ({ content: "" }));
        const err = await this.readFile(`${dir}/stderr`).catch(() => ({ content: "" }));
        return { stdout: out.content, stderr: err.content };
      },
      getStatus: async () => {
        const r = await this.exec(
          `kill -0 $(cat ${dir}/pid) 2>/dev/null && echo running || echo exited`,
          { timeout: 5_000 },
        );
        return r.stdout.includes("running") ? "running" : "exited";
      },
    };
  }
}
