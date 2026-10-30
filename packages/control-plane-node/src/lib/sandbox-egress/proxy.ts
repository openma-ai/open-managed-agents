/**
 * Sandbox egress proxy (Node): an HTTP forward proxy that injects managed
 * Vault credentials into a Session sandbox's outbound HTTPS requests.
 *
 *   sandbox  --CONNECT host:443 + Proxy-Authorization(pass)-->  proxy
 *
 * The pass names the workspace and Session. For a host the shared resolver
 * has a credential for (cap spec host or managed MCP credential host) in the
 * Session's Vaults, the proxy terminates TLS with a leaf from the deployment
 * CA, rewrites each request's `Authorization` with the Vault token, and
 * refreshes once on a 401/403 through the resolver. Every other host is a
 * blind TCP tunnel. Plain-HTTP proxy requests are forwarded, never injected.
 *
 * Best effort: the sandbox can ignore HTTPS_PROXY, so this injects
 * credentials but does not confine egress.
 */
import { connect as tcpConnect, isIP, type Server as NetServer, type Socket } from "node:net";
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { createSecureContext, TLSSocket, type SecureContext } from "node:tls";
import { Readable } from "node:stream";
import type { Duplex } from "node:stream";
import {
  egressRequestHeaders,
  type ManagedCredentialTarget,
  type ManagedSessionScope,
} from "@open-managed-agents/managed-credential-resolver";
import type { EgressCertificateAuthority } from "./ca.js";
import { passFromProxyAuthorization, type EgressPassAuthority } from "./pass.js";

/** The resolver surface the proxy uses; the shared resolver satisfies it. */
export interface EgressCredentialSource {
  outboundTarget(scope: ManagedSessionScope, hostname: string): Promise<ManagedCredentialTarget | null>;
  forward(
    workspaceId: string,
    target: ManagedCredentialTarget,
    send: (token: string) => Promise<Response>,
  ): Promise<{ response: Response; refreshed: boolean; refreshFailed: boolean }>;
}

export interface EgressSessionRecord {
  vaultIds: readonly string[];
  archived: boolean;
}

export interface EgressProxyLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface SandboxEgressProxyDependencies {
  passes: EgressPassAuthority;
  ca: EgressCertificateAuthority;
  credentials: EgressCredentialSource;
  findSession(input: { workspaceId: string; sessionId: string }): Promise<EgressSessionRecord | null>;
  /** Whether a CLI spec claims the host (for "matched but no credential" logs). */
  claimsHost(hostname: string): boolean;
  log: EgressProxyLogger;
  /** Extra trust anchors for upstream TLS (tests). Default: Node's roots. */
  upstreamCa?: string | readonly string[];
}

export interface SandboxEgressProxy {
  listen(port: number, host: string): Promise<{ port: number }>;
  close(): Promise<void>;
}

interface TunnelContext {
  scope: ManagedSessionScope;
  hostname: string;
  port: number;
}

/** Hop-by-hop headers never replayed across the proxy (RFC 9110 §7.6.1). */
const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

function headersOf(incoming: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else headers.set(name, value);
  }
  for (const name of HOP_BY_HOP) headers.delete(name);
  headers.delete("content-length");
  return headers;
}

async function bodyOf(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** `host:port` or `[v6]:port` of a CONNECT request, or null. */
function parseAuthority(authority: string): { hostname: string; port: number } | null {
  const match = /^(?:\[([0-9a-fA-F:.]+)\]|([A-Za-z0-9.-]+)):(\d{1,5})$/u.exec(authority);
  if (match === null) return null;
  const port = Number(match[3]);
  if (port < 1 || port > 65535) return null;
  const hostname = (match[1] ?? match[2]!).toLowerCase();
  if (match[1] !== undefined && isIP(hostname) !== 6) return null;
  return { hostname, port };
}

function rejectSocket(socket: Duplex, status: number, reason: string, extra = ""): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\n${extra}content-length: 0\r\nconnection: close\r\n\r\n`);
}

export function createSandboxEgressProxy(dependencies: SandboxEgressProxyDependencies): SandboxEgressProxy {
  const { log } = dependencies;
  const tunnels = new WeakMap<object, TunnelContext>();
  const secureContexts = new Map<string, Promise<SecureContext>>();
  const openSockets = new Set<Socket | Duplex>();

  const track = (socket: Socket | Duplex) => {
    openSockets.add(socket);
    socket.once("close", () => openSockets.delete(socket));
  };

  type Rejection = { status: number; reason: string };

  /**
   * Session scope for a request, or the rejection to send. Every proxy use
   * passes here first: nothing is resolved or dialed before it succeeds.
   */
  async function authorize(
    header: string | undefined,
  ): Promise<{ scope: ManagedSessionScope } | Rejection> {
    const reject = (status: number, reason: string, fields: Record<string, unknown>): Rejection => {
      log.warn({ op: "sandbox_egress.pass_rejected", ...fields }, "sandbox egress pass rejected");
      return { status, reason };
    };
    const pass = passFromProxyAuthorization(header);
    if (pass === null) return reject(407, "Proxy Authentication Required", { reason: "missing" });
    const verified = dependencies.passes.verify(pass);
    if (verified.type !== "valid") return reject(407, "Proxy Authentication Required", { reason: verified.type });
    const { workspaceId, sessionId } = verified.claims;
    const session = await dependencies.findSession({ workspaceId, sessionId });
    if (session === null || session.archived) {
      return reject(403, "Forbidden", { reason: "session_inactive", tenant_id: workspaceId, session_id: sessionId });
    }
    return { scope: { workspaceId, sessionId, vaultIds: session.vaultIds } };
  }

  function secureContextFor(hostname: string): Promise<SecureContext> {
    let pending = secureContexts.get(hostname);
    if (pending === undefined) {
      pending = dependencies.ca.leafFor(hostname).then((leaf) => createSecureContext(leaf));
      secureContexts.set(hostname, pending);
      // Leaves renew; rebuild the context after a day.
      setTimeout(() => secureContexts.delete(hostname), 86_400_000).unref();
      pending.catch(() => secureContexts.delete(hostname));
    }
    return pending;
  }

  function tunnel(client: Duplex, head: Buffer, hostname: string, port: number): void {
    const upstream = tcpConnect({ host: hostname, port });
    track(upstream);
    upstream.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.once("error", (error) => {
      log.warn({ op: "sandbox_egress.tunnel_failed", host: hostname, port, error: error.message }, "sandbox egress tunnel failed");
      if (!client.destroyed) rejectSocket(client, 502, "Bad Gateway");
    });
    client.once("error", () => upstream.destroy());
    client.once("close", () => upstream.destroy());
  }

  /** One upstream HTTPS exchange as a web Response (body not decoded). */
  function sendUpstream(input: {
    hostname: string;
    port: number;
    method: string;
    path: string;
    headers: Headers;
    body: Buffer;
  }): Promise<Response> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string | string[]> = {};
      input.headers.forEach((value, name) => {
        headers[name] = name === "set-cookie" ? input.headers.getSetCookie() : value;
      });
      headers.host = input.port === 443 ? input.hostname : `${input.hostname}:${input.port}`;
      if (input.body.length > 0 || !["GET", "HEAD", "DELETE", "OPTIONS"].includes(input.method)) {
        headers["content-length"] = String(input.body.length);
      }
      const request = httpsRequest({
        host: input.hostname,
        port: input.port,
        servername: input.hostname,
        method: input.method,
        path: input.path,
        headers,
        ...(dependencies.upstreamCa === undefined ? {} : { ca: dependencies.upstreamCa as string | string[] }),
      }, (response) => {
        const responseHeaders = new Headers();
        for (let i = 0; i < response.rawHeaders.length; i += 2) {
          responseHeaders.append(response.rawHeaders[i]!, response.rawHeaders[i + 1]!);
        }
        const status = response.statusCode ?? 502;
        const nullBody = input.method === "HEAD" || status === 204 || status === 304;
        if (nullBody) response.resume();
        try {
          resolve(new Response(
            nullBody ? null : (Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>),
            { status, statusText: response.statusMessage ?? "", headers: responseHeaders },
          ));
        } catch (error) {
          response.destroy();
          reject(error);
        }
      });
      request.once("error", reject);
      request.end(input.body);
    });
  }

  async function writeResponse(response: Response, to: ServerResponse): Promise<void> {
    const headers: Record<string, string | string[]> = {};
    response.headers.forEach((value, name) => {
      if (HOP_BY_HOP.includes(name)) return;
      headers[name] = name === "set-cookie" ? response.headers.getSetCookie() : value;
    });
    to.writeHead(response.status, response.statusText, headers);
    if (response.body === null) {
      to.end();
      return;
    }
    const body = Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>);
    body.once("error", () => to.destroy());
    body.pipe(to);
  }

  function fail(to: ServerResponse, status: number, message: string): void {
    if (to.headersSent) {
      to.destroy();
      return;
    }
    to.writeHead(status, { "content-type": "text/plain" });
    to.end(message);
  }

  // Requests decrypted inside an intercepted tunnel.
  const intercepted: HttpServer = createHttpServer(async (request, response) => {
    const context = tunnels.get(request.socket);
    if (context === undefined) {
      fail(response, 500, "sandbox egress: tunnel context lost");
      return;
    }
    const { scope, hostname, port } = context;
    const method = request.method ?? "GET";
    const path = request.url ?? "/";
    const logFields = { tenant_id: scope.workspaceId, session_id: scope.sessionId, host: hostname, method };
    try {
      const body = await bodyOf(request);
      const inbound = headersOf(request.headers);
      // Live per request: a credential rotated, archived or added since the
      // tunnel opened is honored on the next request.
      const target = await dependencies.credentials.outboundTarget(scope, hostname);
      const send = (token: string | null) => sendUpstream({
        hostname,
        port,
        method,
        path,
        body,
        headers: egressRequestHeaders(inbound, { token, stripAuthorization: false }),
      });
      if (target === null) {
        log.warn({ op: "sandbox_egress.no_credential", ...logFields }, "no usable Vault credential; forwarded without injection");
        await writeResponse(await send(null), response);
        return;
      }
      const outcome = await dependencies.credentials.forward(scope.workspaceId, target, (token) => send(token));
      log.info(
        { op: "sandbox_egress.inject", ...logFields, status: outcome.response.status, refreshed: outcome.refreshed, refresh_failed: outcome.refreshFailed },
        "Vault credential injected into sandbox egress",
      );
      await writeResponse(outcome.response, response);
    } catch (error) {
      log.error(
        { op: "sandbox_egress.failed", ...logFields, error: error instanceof Error ? error.message : String(error) },
        "sandbox egress request failed",
      );
      fail(response, 502, "sandbox egress: credential injection failed");
    }
  });

  async function intercept(client: Duplex, head: Buffer, context: TunnelContext): Promise<void> {
    const secureContext = await secureContextFor(context.hostname);
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) client.unshift(head);
    const tls = new TLSSocket(client as Socket, {
      isServer: true,
      secureContext,
      ALPNProtocols: ["http/1.1"],
    });
    track(tls);
    tls.once("error", () => tls.destroy());
    tunnels.set(tls, context);
    intercepted.emit("connection", tls);
  }

  const front: HttpServer = createHttpServer(async (request, response) => {
    // Plain-HTTP proxying: forwarded, never injected (no TLS, no tokens).
    const authorized = await authorize(request.headers["proxy-authorization"]).catch((error: unknown) => {
      log.error({ op: "sandbox_egress.failed", error: error instanceof Error ? error.message : String(error) }, "sandbox egress authorization failed");
      return { status: 502, reason: "Bad Gateway" };
    });
    if (!("scope" in authorized)) {
      response.writeHead(authorized.status, authorized.status === 407 ? { "proxy-authenticate": "Basic realm=\"openma\"" } : {});
      response.end();
      return;
    }
    let url: URL;
    try {
      url = new URL(request.url ?? "");
      if (url.protocol !== "http:") throw new Error("not http");
    } catch {
      fail(response, 400, "sandbox egress: absolute http:// URL required");
      return;
    }
    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (value !== undefined && !HOP_BY_HOP.includes(name)) headers[name] = value;
    }
    const upstream = httpRequest({
      host: url.hostname.replace(/^\[(.*)\]$/u, "$1"),
      port: url.port === "" ? 80 : Number(url.port),
      method: request.method,
      path: `${url.pathname}${url.search}`,
      headers,
    }, (upstreamResponse) => {
      const out: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(upstreamResponse.headers)) {
        if (value !== undefined && !HOP_BY_HOP.includes(name)) out[name] = value;
      }
      response.writeHead(upstreamResponse.statusCode ?? 502, out);
      upstreamResponse.pipe(response);
    });
    upstream.once("error", () => fail(response, 502, "sandbox egress: upstream unreachable"));
    request.pipe(upstream);
  });

  front.on("connect", async (request: IncomingMessage, client: Duplex, head: Buffer) => {
    track(client);
    client.once("error", () => client.destroy());
    const authority = parseAuthority(request.url ?? "");
    if (authority === null) {
      rejectSocket(client, 400, "Bad Request");
      return;
    }
    const { hostname, port } = authority;
    let scope: ManagedSessionScope;
    let target: ManagedCredentialTarget | null;
    try {
      const authorized = await authorize(request.headers["proxy-authorization"]);
      if (!("scope" in authorized)) {
        rejectSocket(
          client,
          authorized.status,
          authorized.reason,
          authorized.status === 407 ? "proxy-authenticate: Basic realm=\"openma\"\r\n" : "",
        );
        return;
      }
      scope = authorized.scope;
      target = await dependencies.credentials.outboundTarget(scope, hostname);
    } catch (error) {
      log.error(
        { op: "sandbox_egress.failed", host: hostname, error: error instanceof Error ? error.message : String(error) },
        "sandbox egress could not resolve Vault credentials",
      );
      rejectSocket(client, 502, "Bad Gateway");
      return;
    }
    if (target === null) {
      if (dependencies.claimsHost(hostname)) {
        log.warn(
          { op: "sandbox_egress.no_credential", tenant_id: scope.workspaceId, session_id: scope.sessionId, host: hostname },
          "CLI host has no usable Vault credential in this Session; tunneled without injection",
        );
      }
      tunnel(client, head, hostname, port);
      return;
    }
    try {
      await intercept(client, head, { scope, hostname, port });
    } catch (error) {
      log.error(
        { op: "sandbox_egress.failed", host: hostname, error: error instanceof Error ? error.message : String(error) },
        "sandbox egress could not intercept TLS",
      );
      if (!client.destroyed) rejectSocket(client, 502, "Bad Gateway");
    }
  });
  front.on("connection", track);

  return {
    listen(port, host) {
      return new Promise((resolve, reject) => {
        front.once("error", reject);
        front.listen(port, host, () => {
          front.off("error", reject);
          resolve({ port: (front.address() as { port: number }).port });
        });
      });
    },
    async close() {
      for (const socket of openSockets) socket.destroy();
      await new Promise<void>((resolve) => (front as NetServer).close(() => resolve()));
      intercepted.close();
    },
  };
}
