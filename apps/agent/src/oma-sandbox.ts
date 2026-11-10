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
// only the Session and the digest of the current sandbox token (#561; the
// binding is stored, so never the token). Every injection checks that token
// like the E2B / Node relay's does. A live lookup may return plaintext
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
  EGRESS_HOP_HEADERS,
  EGRESS_SANDBOX_CONTROL_HEADERS,
  egressRequestHeaders,
} from "@open-managed-agents/managed-credential-resolver";
import { carriesVaultPlaceholder } from "@open-managed-agents/sandbox-gateway/vault-substitution";
import {
  DirectoryBackup,
  type DirectoryBackupRecord,
  Files,
  S3Mount,
} from "@cloudflare/sandbox";
import { DurableObject, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
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
  sessionId?: string;
  /** Routing only: the Work a Work runtime binding serves (control-plane paths). */
  environmentId?: string;
  workId?: string;
  /** SHA-256 of the current sandbox token (sandboxTokenSha256): the only
   * authority for Vault and GitHub injection. Absent between turns. */
  tokenSha256?: string;
  /** Provider-enforced egress: without a bound token nothing leaves. */
  required?: boolean;
  /** Exact trusted API origin for the Work capability (scheme + host + port). */
  controlPlaneOrigin?: string;
}

/** What main checks the binding by; null with no token bound (between turns). */
function boundToken(params: OutboundContextParams, env: Env): { tenantId: string; sessionId: string; tokenSha256: string } | null {
  return params.tenantId && params.sessionId && params.tokenSha256 && env.MAIN_MCP !== undefined
    ? { tenantId: params.tenantId, sessionId: params.sessionId, tokenSha256: params.tokenSha256 }
    : null;
}

/**
 * Headers stripped before forwarding upstream, shared with every Vault
 * egress proxy. CF Workers auto-adds some of these when invoking `fetch()`;
 * if they are in an upstream SigV4 signed-headers list (boto3, aws-sdk,
 * s3fs, awscli) the signature mismatch produces a 403. `host` is left to the
 * runtime, which derives it from the URL.
 */
const HOP_BY_HOP_OR_CF_HEADERS = EGRESS_HOP_HEADERS;
const SANDBOX_CONTROL_HEADERS = EGRESS_SANDBOX_CONTROL_HEADERS;

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
  const bound = boundToken(params, e);
  if (required && bound === null) {
    return new Response("credential egress denied: no sandbox token bound", { status: 403 });
  }
  // Materialize body — Workers needs a known-length body to set
  // Content-Length on the outbound request.
  const bodyBytes = request.method === "GET" || request.method === "HEAD" ? null : await request.arrayBuffer();
  const placeholder = carriesVaultPlaceholder(request.headers, bodyBytes);

  // Native interception shares the ordinary relay application. The binding
  // returns only forwarding results/metadata, never the upstream token.
  // Vault credentials are only ever injected over HTTPS (the relay rejects
  // any other scheme with 400), so plain HTTP (e.g. apt mirrors) skips the
  // lookup and is forwarded below with sandbox authorization stripped.
  // No token bound (between turns, before the first turn) → no Vault.
  const injectable = url.protocol === "https:";
  if (injectable && bound !== null) {
    try {
      const resolved = await e.MAIN_MCP!.credentialEgress(bound, "resolve", new Request(request.url));
      if (!resolved.ok) {
        // Only a token that is no longer current (401: a background process
        // after its turn) keeps ordinary egress; a request carrying a Vault
        // placeholder, a required binding, or any other failure is refused.
        if (resolved.status !== 401 || placeholder || required) return resolved;
      } else if ((await resolved.json() as { inject: boolean }).inject) {
        return e.MAIN_MCP!.credentialEgress(bound, "forward", new Request(request.url, {
          method: request.method, headers: request.headers, ...(bodyBytes === null ? {} : { body: bodyBytes }), redirect: "manual",
        }));
      }
    } catch {
      return new Response("credential egress unavailable", { status: 502 });
    }
  }
  const outHeaders = egressRequestHeaders(request.headers, { token: null, stripAuthorization: required || !injectable });
  // A Vault placeholder the gateway did not take (wrong host, plain HTTP, no
  // current token) is refused, never sent on (design §8.4 rule 2).
  if (placeholder) {
    console.warn(`[oma-sandbox] vault placeholder refused host=${url.hostname} rule=credential_host_mismatch`);
    return new Response("Credential relay request denied: credential_host_mismatch", { status: 403 });
  }

  const upstreamReq = new Request(request.url, {
    method: request.method,
    headers: outHeaders,
    ...(bodyBytes === null ? {} : { body: bodyBytes }),
    redirect: "manual",
  });

  console.log(
    `[oma-sandbox] outbound passthrough host=${url.hostname} method=${request.method}`,
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
  // The sandbox token as Bearer / Basic; the sealed Work token (ADR 0005)
  // only on a Work runtime's binding. The main API checks the credential,
  // its Session and its scope on every request.
  const sandboxToken = authorization.startsWith("Bearer oma_sbx_") || authorization.startsWith("Basic ");
  const workToken = typeof params.workId === "string" && params.workId.length > 0 && authorization.startsWith("Bearer sk-ant-req-v1.");
  if (url.origin === expectedOrigin && workToken && /^\/v1\/oma\/(?:mcp-proxy|inference-proxy)\//u.test(url.pathname)) {
    return new Response("sandbox gateway requires a sandbox token", { status: 401 });
  }
  if (
    url.origin !== expectedOrigin
    || !(sandboxToken || workToken)
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
//   ② Vault requests forwarded to the shared credential relay:
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
export const githubAuthHandler = async (
  request: Request,
  env: unknown,
  ctx: SdkContext<OutboundContextParams>,
): Promise<Response> => {
  const url = new URL(request.url);
  const params = ctx.params ?? {};
  const e = env as Env;
  const required = params.required === true;
  const bound = boundToken(params, e);
  if (required && bound === null) {
    return new Response("credential egress denied: no sandbox token bound", { status: 403 });
  }

  let cred: { scheme: "Basic" | "Bearer"; token: string; slug: string } | null = null;

  // ① per-repo first, only for a current sandbox token (none bound or not
  // current: null, and the Vault handler below decides). A token that
  // cannot be checked fails the request.
  if (bound !== null) {
    try {
      cred = await e.MAIN_MCP!.lookupGithubCredential({ ...bound, hostname: url.hostname, pathname: url.pathname });
    } catch (err) {
      console.error(
        `[oma-sandbox] lookupGithubCredential threw host=${url.hostname}: ${(err as Error)?.message ?? err}`,
      );
      return new Response("credential egress unavailable", { status: 502 });
    }
  }

  // Vault credentials never cross to the native handler. Repository-resource
  // credentials retain their existing adapter; Vault traffic uses the relay.
  if (!cred) return handleCredentialEgressRequest(request, env, ctx);

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



/** Idle reclaim backstop: snapshot and stop a container after this long
 * without a Durable Object request. The core's idle pause (5 min, design
 * §0.0b A.1) stops it first; this only runs if that pause never did, so it is
 * idlePauseMs + SANDBOX_LEASE_MARGIN_MS. Override with the
 * SANDBOX_IDLE_TIMEOUT_MS variable. */
export const OMA_SANDBOX_IDLE_TIMEOUT_MS = 20 * 60 * 1000;
/** Extra time before the platform stops a container whose idle alarm could
 * not run. Cloudflare counts Durable Object requests, not container traffic,
 * as activity. */
const CONTAINER_BACKSTOP_GRACE_MS = 5 * 60 * 1000;

export function sandboxIdleTimeoutMs(env: { SANDBOX_IDLE_TIMEOUT_MS?: string }): number {
  const configured = Number(env.SANDBOX_IDLE_TIMEOUT_MS);
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : OMA_SANDBOX_IDLE_TIMEOUT_MS;
}
const RULES_KEY = "OUTBOUND_CONFIGURATION";
const PLAN_KEY = "oma_sandbox_plan";
const PROCESS_ENV_KEY = "oma_process_env";
const LAST_ACTIVITY_KEY = "oma_last_activity_ms";
const DIRTY_KEY = "oma_workspace_dirty";
/** Written once per container incarnation; SessionDO probes it to detect a
 * replaced container. */
export const OMA_SANDBOX_WARM_MARKER_PATH = "/tmp/.oma-warm";
const HEALTH_PROBE_TIMEOUT_MS = 5_000;
/** Stable prefixes: Workers RPC keeps an error's message, not its class. */
export const OMA_SANDBOX_NOT_RUNNING = "SANDBOX_NOT_RUNNING";
export const OMA_SANDBOX_MOUNT_AFTER_START = "MOUNT_AFTER_START";
export const OMA_SANDBOX_LEGACY_BACKUP = "LEGACY_BACKUP";
/** A container snapshot to start from is gone (expired, deleted or never
 * existed): start() does not throw for it, the container's monitor rejects. */
export const OMA_SANDBOX_SNAPSHOT_GONE = "SNAPSHOT_GONE";
/** First exec after a snapshot start, measured 0.2-5 s (cross-DO probe). */
const SNAPSHOT_READY_TIMEOUT_MS = 120_000;
const CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
const BUNDLE = "/etc/ssl/certs/ca-certificates.crt";
const SYSTEM_CA = "/etc/ssl/certs/ca-certificates.system.crt";
/** bash -l rereads /etc/profile, which resets PATH: a PATH set through
 * setEnvVars is exported again after it. No PATH leaves the command as is. */
export function loginCommand(command: string, env: Record<string, string>): string {
  return env.PATH === undefined ? command : `export PATH='${env.PATH.replaceAll("'", "'\\''")}'; ${command}`;
}

// OpenSSL clients (python urllib, curl builds without a compiled-in path)
// read SSL_CERT_FILE; the bundle already carries the container CA.
const CONTAINER_ENV = {
  NODE_EXTRA_CA_CERTS: CA,
  SSL_CERT_FILE: BUNDLE,
  REQUESTS_CA_BUNDLE: BUNDLE,
};
const DEFAULT_BACKUP_TTL_SECONDS = BACKUP_TTL_SEC;
const metaKey = (id: string) => `backups/${id}.meta.json`;
const EXPIRY_MARGIN_MS = 60_000;

/** Credentials for one planned mount. `worker_env` resolves the Worker's
 * R2 secrets when the container starts, so they are never persisted. */
export type OmaMountCredentials =
  | { source: "worker_env" }
  | { source: "inline"; accessKeyId: string; secretAccessKey: string };

/** A mount attached when the container starts, before the catch-all
 * outbound intercept. Without `endpoint` it is a local, non-durable
 * directory (wrangler dev without R2 keys). */
export interface OmaPlannedMount {
  mountPath: string;
  bucket: string;
  /** No leading or trailing slash. */
  keyPrefix: string;
  access: "read-only" | "read-write";
  endpoint?: string;
  credentials?: OmaMountCredentials;
}

interface OmaSandboxPlan {
  /** Identity of the running container; null while stopped. */
  incarnation: string | null;
  mounts: OmaPlannedMount[];
  /** false: only provision() starts a stopped container. */
  autoStart: boolean;
}

/** Same arguments as `mountBucket()`. */
export interface OmaMountBucketRequest {
  bucket: string;
  mountPath: string;
  options: OmaMountBucketOptions;
}

export interface OmaMountBucketOptions {
  endpoint?: string;
  provider?: string;
  credentials?: { accessKeyId: string; secretAccessKey: string };
  prefix?: string;
  readOnly?: boolean;
  credentialProxy?: boolean;
  localBucket?: boolean;
}

export interface OmaProvisionRequest {
  /** Identity to give a new container. Ignored when one is already running. */
  incarnation?: string;
  /** Complete mount set for a new container. Omit to keep planned mounts. */
  mounts?: OmaMountBucketRequest[];
  /** Process environment. Replaces it for a new container, merges otherwise. */
  env?: Record<string, string>;
  autoStart?: boolean;
  /** Full native filesystem snapshot, never a DirectoryBackup. */
  containerSnapshot?: ContainerSnapshotRestoreParams;
}

export interface OmaProvisionResult {
  incarnation: string;
  /** true when this call started a new container. */
  started: boolean;
  /** Requested mount paths the already-running container does not have. */
  pendingMounts: string[];
}

export interface OmaSandboxDescription {
  running: boolean;
  incarnation: string | null;
  mounts: string[];
}

function sameMount(a: OmaPlannedMount, b: OmaPlannedMount): boolean {
  return a.mountPath === b.mountPath
    && a.bucket === b.bucket
    && a.keyPrefix === b.keyPrefix
    && a.access === b.access
    && a.endpoint === b.endpoint;
}

function newIncarnation(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 12);
}

function isFullBackupRecord(handle: {
  sha256?: unknown;
  size?: unknown;
  format?: unknown;
}): boolean {
  return typeof handle.sha256 === "string"
    && handle.sha256.length > 0
    && typeof handle.size === "number"
    && typeof handle.format === "string";
}

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

/** Public package sources for an environment snapshot build sandbox: the
 * request as sent, no Vault credential and no platform gateway. */
const packageSourcePassthrough: OutboundHandlerFn = async (request) => {
  const headers = new Headers(request.headers);
  for (const h of HOP_BY_HOP_OR_CF_HEADERS) headers.delete(h);
  for (const h of SANDBOX_CONTROL_HEADERS) headers.delete(h);
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
  return fetch(new Request(request.url, { method: request.method, headers, body, redirect: "manual" }));
};
HANDLERS.package_source_passthrough = packageSourcePassthrough;

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

/** Live stdio of one container process, returned over Durable Object RPC.
 * Sandbox SDK 1.0 `exec()` pipes stdin, so no FIFO relay is needed. */
export class OmaDuplexProcess extends RpcTarget {
  readonly #process: ExecProcess;
  readonly #exited: Promise<number | null>;

  constructor(process: ExecProcess, exited: Promise<number | null>) {
    super();
    this.#process = process;
    this.#exited = exited;
  }

  get stdin(): WritableStream {
    return this.#process.stdin!;
  }

  get stdout(): ReadableStream {
    return this.#process.stdout!;
  }

  get stderr(): ReadableStream {
    return this.#process.stderr!;
  }

  /** Exit code, or null when the process could not report one. */
  wait(): Promise<number | null> {
    return this.#exited;
  }

  kill(signal: number): void {
    this.#process.kill(signal);
  }
}

export class OmaSandbox extends DurableObject<Env> {
  private setup: Promise<void> | null = null;
  private setupPending = false;
  /** In-flight RPCs; the idle alarm never stops a container under one. */
  private inflight = 0;
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
      // A restarted Durable Object starts without an inactivity timeout.
      void ctx.blockConcurrencyWhile(() =>
        container.setInactivityTimeout(sandboxIdleTimeoutMs(env) + CONTAINER_BACKSTOP_GRACE_MS),
      );
    }
  }

  private idleTimeoutMs(): number {
    return sandboxIdleTimeoutMs(this.env);
  }

  private backstopTimeoutMs(): number {
    return this.idleTimeoutMs() + CONTAINER_BACKSTOP_GRACE_MS;
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

  private plan(): OmaSandboxPlan {
    const stored = this.ctx.storage.kv.get(PLAN_KEY) as Partial<OmaSandboxPlan> | undefined;
    return {
      incarnation: stored?.incarnation ?? null,
      mounts: stored?.mounts ?? [],
      autoStart: stored?.autoStart ?? true,
    };
  }

  private savePlan(plan: OmaSandboxPlan): void {
    this.ctx.storage.kv.put(PLAN_KEY, plan);
  }

  private processEnv(): Record<string, string> {
    return (this.ctx.storage.kv.get(PROCESS_ENV_KEY) as Record<string, string> | undefined) ?? {};
  }

  /** First registration for a new container: the backup gateway and every
   * mount route must exist before the catch-all, which takes each hostname
   * registered after it. */
  private async intercept(): Promise<void> {
    await this.backups.intercept();
    await this.interceptOutbound();
  }

  /** Re-registering the catch-all keeps routes registered before it. */
  private async interceptOutbound(): Promise<void> {
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

  private async writeWarmMarker(incarnation: string): Promise<void> {
    const write = await this.container.exec([
      "sh",
      "-c",
      'printf "%s\\n" "$1" > "$2"',
      "sh",
      incarnation,
      OMA_SANDBOX_WARM_MARKER_PATH,
    ]);
    if ((await write.exitCode) !== 0) {
      throw new Error("The container did not record its incarnation marker");
    }
  }

  private mountCredentials(mount: OmaPlannedMount): { accessKeyId: string; secretAccessKey: string } {
    if (mount.credentials?.source === "inline") {
      return {
        accessKeyId: mount.credentials.accessKeyId,
        secretAccessKey: mount.credentials.secretAccessKey,
      };
    }
    const accessKeyId = this.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = this.env.R2_SECRET_ACCESS_KEY;
    if (!accessKeyId || !secretAccessKey) {
      throw new Error(`Mount ${mount.mountPath} requires R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY`);
    }
    return { accessKeyId, secretAccessKey };
  }

  private async attachMounts(mounts: readonly OmaPlannedMount[]): Promise<void> {
    for (const mount of mounts) {
      if (mount.endpoint === undefined) {
        // Local directory only: there is no bucket behind it.
        await this.files.mkdir(mount.mountPath, { recursive: true });
        continue;
      }
      const credentials = this.mountCredentials(mount);
      await this.mounts.mount({
        mountPath: mount.mountPath,
        source: {
          type: "s3",
          endpoint: mount.endpoint,
          region: "auto",
          bucket: mount.bucket,
          credentials: { type: "static", ...credentials },
        },
        keyPrefix: mount.keyPrefix,
        access: mount.access,
      } as any);
    }
  }

  private async startContainer(requestedIncarnation?: string, snapshot?: ContainerSnapshotRestoreParams): Promise<void> {
    const newContainer = !this.container.running;
    const plan = this.plan();
    const fromSnapshot = newContainer && snapshot !== undefined;
    if (newContainer) {
      this.container.start({
        ...(snapshot === undefined ? { image: this.container.images.sandbox } : { containerSnapshot: snapshot }),
        instance: "standard-1",
        env: { ...CONTAINER_ENV, ...this.processEnv() },
        enableInternet: false,
      });
    }
    try {
      // A missing snapshot is reported by the monitor only; without this the
      // mount below would wait on a container that never runs.
      if (fromSnapshot) await this.awaitSnapshotStart(snapshot.id);
      const incarnation = !newContainer && plan.incarnation !== null
        ? plan.incarnation
        : requestedIncarnation ?? newIncarnation();
      if (newContainer) {
        await this.ctx.storage.put(BILLING_CTX_KEY + ":started", Date.now());
        this.ctx.storage.kv.delete(DIRTY_KEY);
      }
      // A restarted Durable Object repeats this for a running container:
      // mount() reuses a matching mount and re-registers its route.
      await this.attachMounts(plan.mounts);
      await this.intercept();
      await this.trustCa();
      if (newContainer || plan.incarnation !== incarnation) {
        await this.writeWarmMarker(incarnation);
      }
      this.savePlan({ ...this.plan(), incarnation });
      await this.container.setInactivityTimeout(this.backstopTimeoutMs());
      this.watch(incarnation);
      this.recordActivity(false);
    } catch (error) {
      this.savePlan({ ...this.plan(), incarnation: null });
      await this.container.destroy().catch(() => {});
      throw error;
    }
  }

  private startSetup(incarnation?: string, snapshot?: ContainerSnapshotRestoreParams): Promise<void> {
    this.setupPending = true;
    const setup = this.startContainer(incarnation, snapshot).then(
      () => {
        this.setupPending = false;
      },
      (error) => {
        this.setupPending = false;
        if (this.setup === setup) this.setup = null;
        throw error;
      },
    );
    this.setup = setup;
    return setup;
  }

  private ensureRunning(): Promise<void> {
    if (this.setup !== null && (this.setupPending || this.container.running)) {
      return this.setup;
    }
    if (!this.container.running && !this.plan().autoStart) {
      return Promise.reject(new Error(
        `${OMA_SANDBOX_NOT_RUNNING}: the sandbox container is stopped; provision it again`,
      ));
    }
    return this.startSetup();
  }

  private watch(incarnation: string): void {
    this.container.monitor().then(
      async () => {
        console.log("[oma-sandbox] container exited 0");
        await this.onContainerStopped(incarnation);
      },
      async (error: unknown) => {
        console.error("[oma-sandbox] container stopped", error);
        await this.onContainerStopped(incarnation);
      },
    );
  }

  private async onContainerStopped(incarnation: string): Promise<void> {
    if (!this.setupPending) this.setup = null;
    const plan = this.plan();
    if (plan.incarnation === incarnation) {
      this.savePlan({ ...plan, incarnation: null });
    }
    await this.recordSandboxActiveOnStop();
  }

  private recordActivity(dirty: boolean): void {
    const now = Date.now();
    this.ctx.storage.kv.put(LAST_ACTIVITY_KEY, now);
    if (dirty) this.ctx.storage.kv.put(DIRTY_KEY, true);
    void this.scheduleIdleCheck(now + this.idleTimeoutMs()).catch((error: unknown) => {
      console.warn(`[oma-sandbox] idle alarm scheduling failed: ${(error as Error)?.message ?? error}`);
    });
  }

  private async scheduleIdleCheck(at: number): Promise<void> {
    // The alarm reads the latest activity when it fires and moves itself.
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(at);
    }
  }

  /** Counts as Durable Object activity; dirty operations may change
   * /workspace. Dirt is recorded afterwards: the operation may have started
   * the container, which begins clean. */
  private async track<T>(dirty: boolean, operation: () => Promise<T>): Promise<T> {
    this.inflight += 1;
    this.recordActivity(false);
    try {
      return await operation();
    } finally {
      this.inflight -= 1;
      this.recordActivity(dirty && this.ctx.container?.running === true);
    }
  }

  /** Idle reclaim. Sandbox SDK 1.0 has no onActivityExpired hook. This also
   * absorbs an alarm the 0.12 Container class left behind at the switch. */
  async alarm(): Promise<void> {
    if (!this.ctx.container?.running) return;
    if (this.inflight > 0) {
      await this.ctx.storage.setAlarm(Date.now() + this.idleTimeoutMs());
      return;
    }
    const last = (this.ctx.storage.kv.get(LAST_ACTIVITY_KEY) as number | undefined) ?? 0;
    const due = last + this.idleTimeoutMs();
    if (Date.now() < due) {
      await this.ctx.storage.setAlarm(due);
      return;
    }
    await this.onActivityExpired();
  }

  /** Starts a container with its complete mount set, or reports the running
   * one. Mounts cannot be added to a running container in Sandbox SDK 1.0. */
  async provision(request: OmaProvisionRequest = {}): Promise<OmaProvisionResult> {
    const requested = request.mounts?.map((mount) =>
      this.plannedMount(mount.bucket, mount.mountPath, mount.options));
    return this.track(false, async () => {
      const autoStart = request.autoStart ?? this.plan().autoStart;
      if (this.container.running) {
        await this.ensureRunning();
        if (await this.probeShimAlive(HEALTH_PROBE_TIMEOUT_MS)) {
          const current = this.plan();
          this.savePlan({ ...current, autoStart });
          if (request.env) this.mergeProcessEnv(request.env);
          const pendingMounts = (requested ?? [])
            .filter((mount) => !current.mounts.some((existing) => sameMount(existing, mount)))
            .map((mount) => mount.mountPath);
          return { incarnation: current.incarnation!, started: false, pendingMounts };
        }
        console.warn("[oma-sandbox] provision: running container is unresponsive; replacing it");
        await this.discardContainer();
      }
      const previous = this.plan();
      this.savePlan({
        incarnation: null,
        mounts: requested ?? previous.mounts,
        autoStart,
      });
      if (request.env) this.ctx.storage.kv.put(PROCESS_ENV_KEY, { ...request.env });
      await this.startSetup(request.incarnation, request.containerSnapshot);
      return { incarnation: this.plan().incarnation!, started: true, pendingMounts: [] };
    });
  }

  /** Waits for the first exec of a container started from a snapshot. A
   * monitor rejection naming the snapshot means it is gone. */
  private async awaitSnapshotStart(id: string): Promise<void> {
    let monitorError: unknown;
    const stopped = this.container.monitor().then(
      () => { monitorError = new Error("the container exited during start"); },
      (error: unknown) => { monitorError = error; },
    );
    const deadline = Date.now() + SNAPSHOT_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const ready = await Promise.race([
        stopped.then(() => false),
        (async () => {
          try {
            const proc = await this.container.exec(["true"]);
            return (await proc.exitCode) === 0;
          } catch {
            return false;
          }
        })(),
      ]);
      if (monitorError !== undefined) {
        const message = monitorError instanceof Error ? monitorError.message : String(monitorError);
        if (/snapshot/i.test(message) && /not found|expired|does not exist/i.test(message)) {
          throw new Error(`${OMA_SANDBOX_SNAPSHOT_GONE}: container snapshot ${id}: ${message}`);
        }
        throw new Error(`Starting from container snapshot ${id} failed: ${message}`);
      }
      if (ready) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Container snapshot ${id} did not start within ${SNAPSHOT_READY_TIMEOUT_MS} ms`);
  }

  /** Environment cache: snapshot this container's root filesystem (not
   * mounts, memory, processes or /run). Never starts a container. Waits for
   * no other call: the build sandbox runs only its setup, then this. */
  async snapshotEnvironment(input: { name: string }): Promise<{ id: string; size: number }> {
    if (!this.ctx.container?.running) {
      throw new Error(`${OMA_SANDBOX_NOT_RUNNING}: there is no running container to snapshot`);
    }
    if (this.inflight > 0) throw new Error("The container is busy; an environment snapshot needs it idle");
    this.recordActivity(false);
    const snapshot = await this.container.snapshotContainer({ name: input.name });
    this.recordActivity(false);
    return { id: snapshot.id, size: snapshot.size };
  }

  /** The digest-pinned reference of the image this class starts, or null
   * (a class without a durable_object images map). */
  async sandboxImage(): Promise<string | null> {
    const image = (this.ctx.container as { images?: Record<string, string | undefined> } | undefined)?.images?.sandbox;
    return typeof image === "string" && image.length > 0 ? image : null;
  }

  /** Environment snapshot build sandbox: only these hosts, passed through
   * without credentials; everything else is blocked (R2 included). */
  async restrictOutboundToHosts(hosts: string[]): Promise<void> {
    await this.saveRules({
      allowedHosts: [...hosts],
      outboundHandlerOverride: { method: "package_source_passthrough" },
    });
    if (this.container.running) await this.interceptOutbound();
  }

  /** Full filesystem only; memory/processes are not captured. Errors propagate. */
  async createContainerSnapshot(options?: ContainerSnapshotOptions): Promise<ContainerSnapshot> {
    if (!this.container.running) throw new Error("Cannot snapshot a stopped container");
    return this.container.snapshotContainer(options);
  }

  async describe(): Promise<OmaSandboxDescription> {
    const plan = this.plan();
    const running = this.ctx.container?.running === true;
    return {
      running,
      incarnation: running ? plan.incarnation : null,
      mounts: plan.mounts.map((mount) => mount.mountPath),
    };
  }

  /** 0.x-compatible: string command → bash -lc, return buffered result. */
  async exec(
    command: string,
    options?: { timeout?: number; cwd?: string; env?: Record<string, string>; environmentMode?: "replace" },
  ): Promise<{ stdout: string; stderr: string; exitCode: number; success: boolean }> {
    return this.track(true, async () => {
      await this.ensureRunning();
      const replace = options?.environmentMode === "replace";
      const env = { ...CONTAINER_ENV, ...(replace ? {} : this.processEnv()), ...(options?.env ?? {}) };
      const timeoutMs = options?.timeout;
      // env -i also drops image/init-process inheritance before bash starts.
      const argv = replace
        ? ["/usr/bin/env", "-i", ...Object.entries(env).map(([key, value]) => `${key}=${value}`), "/bin/bash", "--noprofile", "--norc", "-c", command]
        : ["/bin/bash", "-lc", loginCommand(command, env)];
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
    });
  }

  async readFile(
    path: string,
    _options?: { encoding?: string },
  ): Promise<{ content: string; success: boolean }> {
    return this.track(false, async () => {
      await this.ensureRunning();
      const response = await this.files.readFile(path, {
        cwd: path.startsWith("/") ? undefined : "/workspace",
      } as any);
      const content = await response.text();
      return { content, success: true };
    });
  }

  async writeFile(
    path: string,
    content: string,
    options?: { encoding?: string },
  ): Promise<{ success: boolean }> {
    return this.track(true, async () => {
      await this.ensureRunning();
      const abs = path.startsWith("/") ? path : `/workspace/${path}`;
      const parent = abs.slice(0, abs.lastIndexOf("/")) || "/";
      // Sandbox SDK 1.0 writeFile no longer creates parent directories.
      await this.files.mkdir(parent, { recursive: true }).catch(() => {});
      if (options?.encoding === "base64") {
        const bin = Uint8Array.from(atob(content), (c) => c.charCodeAt(0));
        await this.files.writeFile(abs, bin);
      } else {
        await this.files.writeFile(abs, content);
      }
      return { success: true };
    });
  }

  /** Returns the full Sandbox SDK 1.0 record; restore needs size, sha256
   * and format, so callers must persist all of it. */
  async createBackup(options: {
    dir: string;
    name?: string;
    excludes?: string[];
    gitignore?: boolean;
    ttl?: number;
    localBucket?: boolean;
  }): Promise<DirectoryBackupRecord & { localBucket?: boolean; expiresAt: number }> {
    return this.track(false, async () => {
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
        ...backup,
        // 1.0 always uses the R2 binding; the field stays for older callers.
        ...(options.localBucket !== undefined ? { localBucket: options.localBucket } : {}),
        expiresAt,
      };
    });
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
    if (!isFullBackupRecord(handle)) {
      // Handles written before Sandbox SDK 1.0 carry only {id, dir}; their
      // squashfs archives are not tar+zstd and cannot be restored by 1.0.
      throw new Error(
        `${OMA_SANDBOX_LEGACY_BACKUP}: backup ${handle.id} predates Sandbox SDK 1.0 and cannot be restored`,
      );
    }
    return this.track(false, async () => {
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
      const record: DirectoryBackupRecord = {
        id: handle.id,
        dir: handle.dir,
        size: handle.size!,
        sha256: handle.sha256!,
        format: handle.format as DirectoryBackupRecord["format"],
        ...(handle.name !== undefined ? { name: handle.name } : {}),
      };
      await this.backups.restore(record);
      // /workspace now equals the backup; nothing new to snapshot yet.
      this.ctx.storage.kv.delete(DIRTY_KEY);
      return { success: true, dir: handle.dir, id: handle.id };
    });
  }

  /** On a stopped container this only plans the mount: it is attached when
   * the container starts, before the catch-all intercept. On a running
   * container it succeeds only when the same mount was attached at start. */
  async mountBucket(
    bucket: string,
    mountPath: string,
    options: OmaMountBucketOptions = {},
  ): Promise<void> {
    const mount = this.plannedMount(bucket, mountPath, options);
    if (!this.container.running) {
      const plan = this.plan();
      this.savePlan({
        ...plan,
        mounts: [...plan.mounts.filter((existing) => existing.mountPath !== mount.mountPath), mount],
      });
      return;
    }
    await this.ensureRunning();
    if (this.plan().mounts.some((existing) => sameMount(existing, mount))) return;
    throw new Error(
      `${OMA_SANDBOX_MOUNT_AFTER_START}: ${mount.mountPath} was not mounted when this container started; Sandbox SDK 1.0 cannot add a mount to a running container`,
    );
  }

  private plannedMount(
    bucket: string,
    mountPath: string,
    options: OmaMountBucketOptions,
  ): OmaPlannedMount {
    if (!mountPath.startsWith("/")) {
      throw new TypeError("mountPath must be an absolute path");
    }
    const keyPrefix = (options.prefix ?? "").replace(/^\/+/, "").replace(/\/+$/, "");
    const access = options.readOnly ? "read-only" : "read-write";
    if (options.localBucket) {
      return { mountPath, bucket, keyPrefix, access };
    }
    const { endpoint, credentials } = options;
    if (!endpoint || !credentials) {
      throw new Error("mountBucket requires endpoint and credentials in Sandbox SDK 1.0");
    }
    const workerCredentials = credentials.accessKeyId === this.env.R2_ACCESS_KEY_ID
      && credentials.secretAccessKey === this.env.R2_SECRET_ACCESS_KEY;
    return {
      mountPath,
      bucket,
      keyPrefix,
      access,
      endpoint,
      credentials: workerCredentials
        ? { source: "worker_env" }
        : { source: "inline", accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey },
    };
  }

  async unmountBucket(mountPath: string): Promise<void> {
    const plan = this.plan();
    const mount = plan.mounts.find((existing) => existing.mountPath === mountPath);
    this.savePlan({
      ...plan,
      mounts: plan.mounts.filter((existing) => existing.mountPath !== mountPath),
    });
    if (mount?.endpoint === undefined || !this.container.running) return;
    await this.mounts.unmount(mountPath);
  }

  /** Pre-stop: let s3fs flush. Plans stay so a restart mounts them again. */
  private async unmountAllBuckets(): Promise<void> {
    const remote = this.plan().mounts.filter((mount) => mount.endpoint !== undefined);
    await Promise.all(
      remote.map((mount) =>
        this.mounts.unmount(mount.mountPath).catch((err: Error) =>
          console.warn(`[oma-sandbox] pre-stop unmount ${mount.mountPath} failed: ${err?.message ?? err}`),
        ),
      ),
    );
  }

  private mergeProcessEnv(envVars: Record<string, string>): void {
    this.ctx.storage.kv.put(PROCESS_ENV_KEY, { ...this.processEnv(), ...envVars });
  }

  /** Persisted: Sandbox SDK 1.0 has no container env API, so each exec gets
   * these, and a restarted Durable Object must still have them. */
  async setEnvVars(envVars: Record<string, string>): Promise<void> {
    this.mergeProcessEnv(envVars);
  }

  async renewActivityTimeout(): Promise<void> {
    this.recordActivity(false);
    if (this.container.running) {
      await this.container.setInactivityTimeout(this.backstopTimeoutMs());
    }
  }

  async setOutboundHandler(method: string, params?: unknown): Promise<void> {
    const cur = this.rules();
    await this.saveRules({
      ...cur,
      outboundHandlerOverride: { method, params },
    });
    if (this.container.running) await this.interceptOutbound();
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
    if (this.container.running) await this.interceptOutbound();
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

  /** Best-effort /workspace snapshot. Never starts a container: backing up
   * a fresh, empty /workspace would replace the session's real backup. */
  async snapshotWorkspaceNow(): Promise<void> {
    try {
      if (!this.ctx.container?.running) return;
      if (this.ctx.storage.kv.get(DIRTY_KEY) !== true) return;
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
      const provider = buildCfTenantDbProvider(env);
      const backupDb = await provider.resolve(ctx.tenantId);
      await recordBackup(backupDb, {
        tenantId: ctx.tenantId,
        environmentId: ctx.environmentId,
        handle: {
          id: backup.id,
          dir: backup.dir,
          size: backup.size,
          sha256: backup.sha256,
          format: backup.format,
          ...(backup.name !== undefined ? { name: backup.name } : {}),
        },
        nowMs: Date.now(),
        ttlSec: BACKUP_TTL_SEC,
        sessionId: ctx.sessionId,
      });
      this.ctx.storage.kv.delete(DIRTY_KEY);
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
    if (this.ctx.container?.running) {
      try {
        await this.snapshotWorkspaceNow();
        await this.unmountAllBuckets();
      } catch {
        /* best-effort */
      }
    }
    await this.discardContainer();
  }

  /** Stops without a snapshot; used for an unresponsive container. */
  private async discardContainer(): Promise<void> {
    await this.recordSandboxActiveOnStop();
    if (this.ctx.container?.running) {
      await this.container.destroy();
    }
    if (!this.setupPending) this.setup = null;
    this.savePlan({ ...this.plan(), incarnation: null });
    this.ctx.storage.kv.delete(DIRTY_KEY);
  }

  /** Idle teardown: snapshot changed /workspace, then stop the container. */
  async onActivityExpired(): Promise<void> {
    console.log(`[oma-sandbox] idle for ${this.idleTimeoutMs()}ms; stopping container`);
    if (!(await this.probeShimAlive(HEALTH_PROBE_TIMEOUT_MS))) {
      console.warn("[oma-sandbox] onActivityExpired: shim unresponsive, discarding without snapshot");
      await this.discardContainer();
      return;
    }
    await this.destroy();
  }

  private async probeShimAlive(timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const probe = (async () => {
        const proc = await this.container.exec(["true"]);
        return (await proc.exitCode) === 0;
      })();
      const timeout = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      });
      return await Promise.race([probe, timeout]);
    } catch {
      return false;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
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

  /** Starts a process with piped stdio for ACP-style protocols. The idle
   * alarm treats it as in flight until it exits. */
  async spawnDuplex(spec: {
    command: string;
    cwd?: string;
    env?: Record<string, string>;
  }): Promise<OmaDuplexProcess> {
    await this.ensureRunning();
    this.inflight += 1;
    this.recordActivity(false);
    let process: ExecProcess;
    try {
      const env = { ...CONTAINER_ENV, ...this.processEnv(), ...(spec.env ?? {}) };
      process = await this.container.exec(["/bin/bash", "-lc", loginCommand(spec.command, env)], {
        cwd: spec.cwd ?? "/workspace",
        env,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (error) {
      this.inflight -= 1;
      throw error;
    }
    const exited = process.exitCode.then(
      (code) => code,
      () => null,
    ).finally(() => {
      this.inflight -= 1;
      this.recordActivity(this.ctx.container?.running === true);
    });
    return new OmaDuplexProcess(process, exited);
  }

  /**
   * Minimal startProcess shim for duplex / ACP — background bash writing to
   * log files. Not a full 0.x Process port; enough for CloudflareSandbox
   * spawnDuplexProcess when wired. Returns null-shaped failure via throw.
   */
  async startProcess(
    command: string,
    options?: { env?: Record<string, string>; cwd?: string; environmentMode?: "replace" },
  ): Promise<{
    id: string;
    pid?: number;
    kill: (signal?: string) => Promise<void>;
    getLogs: () => Promise<{ stdout: string; stderr: string }>;
    getStatus: () => Promise<string>;
  }> {
    await this.ensureRunning();
    this.recordActivity(true);
    const id = crypto.randomUUID();
    const dir = `/tmp/oma-proc-${id}`;
    const replace = options?.environmentMode === "replace";
    const env = { ...CONTAINER_ENV, ...(replace ? {} : this.processEnv()), ...(options?.env ?? {}) };
    await this.exec(
      `mkdir -p ${dir} && nohup /bin/bash ${replace ? "--noprofile --norc -c" : "-lc"} ${JSON.stringify(loginCommand(command, env))} >${dir}/stdout 2>${dir}/stderr & echo $! >${dir}/pid`,
      { timeout: 30_000, cwd: options?.cwd ?? "/workspace", env, ...(replace ? { environmentMode: "replace" as const } : {}) },
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

/** Kept for operator container classes written against #544
 * (operator-sandboxes.ts). With Sandbox SDK 1.0 outbound interception is an
 * instance-level OmaOutbound entrypoint bound in intercept(), so a subclass
 * of OmaSandbox already inherits the Vault egress and R2 routes; there are
 * no per-class static registries to copy. */
export function withOmaOutbound<T extends abstract new (...args: never[]) => OmaSandbox>(cls: T): T {
  return cls;
}
