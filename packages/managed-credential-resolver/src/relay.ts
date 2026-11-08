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
export interface CredentialEgressScope { workspaceId: string; sessionId: string; vaultIds: readonly string[] }
export interface CredentialEgressForward { target: string; method: string; headers: Headers; body: ArrayBuffer | null }
export interface CredentialEgressCorePorts {
  credentials: Pick<ManagedCredentialResolver, "outboundTarget" | "forward">;
  /** Direct HTTPS transport. Never use the sandbox's local proxy. */
  send(request: Request): Promise<Response>;
}
/** Injection for an already authorized Session scope, independent of how the caller authenticated. */
export interface CredentialEgressCore {
  /** `{ inject }` for a valid HTTPS target. */
  resolve(scope: CredentialEgressScope, target: string): Promise<Response>;
  forward(scope: CredentialEgressScope, input: CredentialEgressForward): Promise<Response>;
}
export const credentialEgressDenied = (status: number) => new Response("Credential relay request denied", { status });

/** Order is part of the contract: target, Vault match, method, headers, then body. */
function egressCore(ports: CredentialEgressCorePorts) {
  const authorize = async (scope: CredentialEgressScope, target: string) => {
    let url: URL;
    try {
      url = new URL(target);
      if (url.protocol !== "https:" || url.username || url.password || url.hash
        || url.pathname.startsWith(`${EGRESS_RELAY_PATH}/`)) return null;
    } catch { return null; }
    return { url, target: await ports.credentials.outboundTarget(scope, url.hostname) };
  };
  const forward = async (scope: CredentialEgressScope, target: string, method: string,
    input: { headers(): Headers; body(): Promise<ArrayBuffer | null> }) => {
    const authorized = await authorize(scope, target);
    if (authorized === null) return credentialEgressDenied(400);
    // A stale local interception may outlive a Vault removal. Never fall back
    // to sending the placeholder, or turn this endpoint into an open proxy.
    if (authorized.target === null) return credentialEgressDenied(403);
    if (!/^[A-Z]+$/u.test(method) || ["CONNECT", "TRACE"].includes(method)) return credentialEgressDenied(400);
    let inbound: Headers;
    try { inbound = relayHeaders(input.headers()); } catch { return credentialEgressDenied(400); }
    const { url, target: credential } = authorized;
    const body = ["GET", "HEAD"].includes(method) ? null : await input.body();
    const send = (token: string) => ports.send(new Request(url, { method,
      headers: egressRequestHeaders(inbound, { token, stripAuthorization: true, ...(credential.header ? { header: credential.header } : {}) }),
      body, redirect: "manual",
    }));
    const { response } = await ports.credentials.forward(scope.workspaceId, credential, send);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: relayHeaders(response.headers) });
  };
  return {
    async resolve(scope: CredentialEgressScope, target: string) {
      const authorized = await authorize(scope, target);
      return authorized === null ? credentialEgressDenied(400) : Response.json({ inject: authorized.target !== null });
    },
    forward,
  };
}

export function createCredentialEgressCore(ports: CredentialEgressCorePorts): CredentialEgressCore {
  const core = egressCore(ports);
  return { resolve: core.resolve, forward: (scope, input) => core.forward(scope, input.target, input.method, { headers: () => input.headers, body: async () => input.body }) };
}

export interface CredentialEgressRelayPorts extends CredentialEgressCorePorts {
  passes: EgressRelayPasses;
  findSession(claims: Pick<EgressRelayClaims, "workspaceId" | "sessionId">): Promise<{ vaultIds: readonly string[]; archivedAt: string | null } | null>;
}
export interface CredentialEgressRelay { handle(action: "resolve" | "forward", request: Request): Promise<Response> }

/** Public metadata is in outer headers; original upstream headers are a separate JSON envelope. */
export function createCredentialEgressRelay(ports: CredentialEgressRelayPorts): CredentialEgressRelay {
  const core = egressCore(ports);
  return { async handle(action, request) {
    const pass = /^Bearer (\S+)$/u.exec(request.headers.get("authorization") ?? "")?.[1];
    const claims = pass ? await ports.passes.verify(pass) : null;
    if (claims === null) return credentialEgressDenied(401);
    const session = await ports.findSession(claims);
    if (session === null || session.archivedAt !== null) return credentialEgressDenied(403);
    const scope = { workspaceId: claims.workspaceId, sessionId: claims.sessionId, vaultIds: session.vaultIds };
    const target = request.headers.get("x-oma-egress-target") ?? "";
    if (action === "resolve") return core.resolve(scope, target);
    // Decoded lazily so a denied request is never parsed or buffered.
    return core.forward(scope, target, request.headers.get("x-oma-egress-method") ?? "", {
      headers() {
        const envelope: unknown = JSON.parse(request.headers.get("x-oma-egress-headers") ?? "{}");
        if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)
          || Object.values(envelope).some(value => typeof value !== "string")) throw new TypeError("Invalid relay header envelope");
        return new Headers(envelope as Record<string, string>);
      },
      body: () => request.arrayBuffer(),
    });
  } };
}
