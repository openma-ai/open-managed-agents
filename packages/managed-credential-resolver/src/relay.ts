import { egressRequestHeaders } from "./egress";
import type { ManagedCredentialResolver } from "./resolver";

export const EGRESS_RELAY_PATH = "/v1/oma/egress";
export interface EgressRelayClaims { workspaceId: string; sessionId: string; expiresAt: number }
export interface EgressRelayPasses {
  issue(input: { workspaceId: string; sessionId: string; ttlMs: number }): Promise<string>;
  verify(pass: string): Promise<EgressRelayClaims | null>;
}
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
const decode = (text: string) => Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), char => char.charCodeAt(0));

/** WebCrypto only: identical authority on Workers and Node, no platform storage. */
export function createEgressRelayPasses(secret: string, now: () => number): EgressRelayPasses {
  const key = crypto.subtle.importKey("raw", new TextEncoder().encode(`credential-relay.v1:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  return {
    async issue(input) {
      if (!input.workspaceId || !input.sessionId || input.ttlMs <= 0) throw new Error("Invalid relay scope");
      const payload = encode(new TextEncoder().encode(JSON.stringify({ workspaceId: input.workspaceId, sessionId: input.sessionId, expiresAt: now() + input.ttlMs })));
      return `${payload}.${encode(new Uint8Array(await crypto.subtle.sign("HMAC", await key, new TextEncoder().encode(payload))))}`;
    },
    async verify(pass) {
      try {
        const [payload, signature, extra] = pass.split(".");
        if (!payload || !signature || extra !== undefined || !await crypto.subtle.verify("HMAC", await key, decode(signature), new TextEncoder().encode(payload))) return null;
        const claims = JSON.parse(new TextDecoder().decode(decode(payload))) as EgressRelayClaims;
        return typeof claims.workspaceId === "string" && claims.workspaceId !== "" && typeof claims.sessionId === "string" && claims.sessionId !== "" && Number.isFinite(claims.expiresAt) && claims.expiresAt > now() ? claims : null;
      } catch { return null; }
    },
  };
}

const HOP = ["connection", "keep-alive", "proxy-connection", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"];
export function relayHeaders(inbound: Headers): Headers {
  const headers = new Headers(inbound);
  for (const name of (headers.get("connection") ?? "").split(",")) if (name.trim()) headers.delete(name.trim());
  for (const name of HOP) headers.delete(name);
  for (const name of [...headers.keys()]) if (name.startsWith("x-oma-egress-")) headers.delete(name);
  return headers;
}
export interface CredentialEgressRelayPorts {
  passes: EgressRelayPasses;
  findSession(claims: Pick<EgressRelayClaims, "workspaceId" | "sessionId">): Promise<{ vaultIds: readonly string[]; archivedAt: string | null } | null>;
  credentials: Pick<ManagedCredentialResolver, "outboundTarget" | "forward">;
  /** Direct HTTPS transport. Never use the sandbox's local proxy. */
  send(request: Request): Promise<Response>;
}
export interface CredentialEgressRelay { handle(action: "resolve" | "forward", request: Request): Promise<Response> }

/** Public metadata is in outer headers; original upstream headers are a separate JSON envelope. */
export function createCredentialEgressRelay(ports: CredentialEgressRelayPorts): CredentialEgressRelay {
  return { async handle(action, request) {
    const denied = (status: number) => new Response("Credential relay request denied", { status });
    const pass = /^Bearer (\S+)$/u.exec(request.headers.get("authorization") ?? "")?.[1];
    const claims = pass ? await ports.passes.verify(pass) : null;
    if (claims === null) return denied(401);
    const session = await ports.findSession(claims);
    if (session === null || session.archivedAt !== null) return denied(403);
    let targetUrl: URL;
    try {
      targetUrl = new URL(request.headers.get("x-oma-egress-target") ?? "");
      if (targetUrl.protocol !== "https:" || targetUrl.username || targetUrl.password || targetUrl.hash
        || targetUrl.pathname.startsWith(`${EGRESS_RELAY_PATH}/`)) return denied(400);
    } catch { return denied(400); }
    const scope = { workspaceId: claims.workspaceId, sessionId: claims.sessionId, vaultIds: session.vaultIds };
    const target = await ports.credentials.outboundTarget(scope, targetUrl.hostname);
    if (action === "resolve") return Response.json({ inject: target !== null });
    // A stale local interception may outlive a Vault removal. Never fall back
    // to sending the placeholder, or turn this endpoint into an open proxy.
    if (target === null) return denied(403);
    const method = request.headers.get("x-oma-egress-method") ?? "";
    if (!/^[A-Z]+$/u.test(method) || ["CONNECT", "TRACE"].includes(method)) return denied(400);
    let inbound: Headers;
    try {
      const envelope: unknown = JSON.parse(request.headers.get("x-oma-egress-headers") ?? "{}");
      if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)
        || Object.values(envelope).some(value => typeof value !== "string")) return denied(400);
      inbound = relayHeaders(new Headers(envelope as Record<string, string>));
    } catch { return denied(400); }
    const body = ["GET", "HEAD"].includes(method) ? null : await request.arrayBuffer();
    const send = (token: string) => ports.send(new Request(targetUrl, { method,
      headers: egressRequestHeaders(inbound, { token, stripAuthorization: true, ...(target.header ? { header: target.header } : {}) }),
      body, redirect: "manual",
    }));
    const { response } = await ports.credentials.forward(claims.workspaceId, target, send);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: relayHeaders(response.headers) });
  } };
}
