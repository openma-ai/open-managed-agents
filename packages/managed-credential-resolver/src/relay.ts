import {
  carriesVaultPlaceholder, scrubVaultValues, substituteVaultPlaceholders, substitutesOnHost,
  type VaultSubstitutionDenyRule, type VaultSubstitutionSecret,
} from "@open-managed-agents/sandbox-gateway/vault-substitution";
import { egressRequestHeaders } from "./egress";
import type { ManagedCredentialResolver } from "./resolver";

export const EGRESS_RELAY_PATH = "/v1/oma/egress";
/** The Session execution attempt a pass is bound to (design §0.0 rule 10). */
export interface EgressRelayFence {
  workspaceId: string;
  sessionId: string;
  executionId: string;
  attemptId: string;
  ownerId: string;
  generation: number;
}
/** A pass dies with its attempt: `expiresAt` only bounds it, the relay's
 * authorize port checks the attempt is still current on every request. */
export interface EgressRelayClaims extends EgressRelayFence { expiresAt: number }
export interface EgressRelayPasses {
  issue(input: EgressRelayFence & { ttlMs: number }): Promise<string>;
  verify(pass: string): Promise<EgressRelayClaims | null>;
}
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
const decode = (text: string) => Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), char => char.charCodeAt(0));

/** WebCrypto only: identical authority on Workers and Node, no platform storage. */
export function createEgressRelayPasses(secret: string, now: () => number): EgressRelayPasses {
  // v2: a pass carries the execution attempt; v1 (Session-only) passes no longer verify.
  const key = crypto.subtle.importKey("raw", new TextEncoder().encode(`credential-relay.v2:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  return {
    async issue(input) {
      if (!input.workspaceId || !input.sessionId || !input.executionId || !input.attemptId || !input.ownerId
        || !Number.isSafeInteger(input.generation) || input.generation < 1 || input.ttlMs <= 0) throw new Error("Invalid relay scope");
      const claims: EgressRelayClaims = {
        workspaceId: input.workspaceId, sessionId: input.sessionId, executionId: input.executionId,
        attemptId: input.attemptId, ownerId: input.ownerId, generation: input.generation, expiresAt: now() + input.ttlMs,
      };
      const payload = encode(new TextEncoder().encode(JSON.stringify(claims)));
      return `${payload}.${encode(new Uint8Array(await crypto.subtle.sign("HMAC", await key, new TextEncoder().encode(payload))))}`;
    },
    async verify(pass) {
      try {
        const [payload, signature, extra] = pass.split(".");
        if (!payload || !signature || extra !== undefined || !await crypto.subtle.verify("HMAC", await key, decode(signature), new TextEncoder().encode(payload))) return null;
        const claims = JSON.parse(new TextDecoder().decode(decode(payload))) as EgressRelayClaims;
        const text = (value: unknown) => typeof value === "string" && value !== "";
        return text(claims.workspaceId) && text(claims.sessionId) && text(claims.executionId) && text(claims.attemptId) && text(claims.ownerId)
          && Number.isSafeInteger(claims.generation) && claims.generation >= 1
          && Number.isFinite(claims.expiresAt) && claims.expiresAt > now() ? claims : null;
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
  /** `sandboxEgress` adds Vault placeholder substitution (design §8.4);
   * without it only cap_cli / MCP targets are injected. */
  credentials: Pick<ManagedCredentialResolver, "outboundTarget" | "forward"> & Partial<Pick<ManagedCredentialResolver, "sandboxEgress">>;
  /** Direct HTTPS transport. Never use the sandbox's local proxy. */
  send(request: Request): Promise<Response>;
  /** Refused placeholders (design §8.4 rule 2): host, rule, Session; never the request. */
  log?: { warn(fields: Record<string, unknown>, message: string): void };
}
/** Injection for an already authorized Session scope, independent of how the caller authenticated. */
export interface CredentialEgressCore {
  /** `{ inject }` for a valid HTTPS target. */
  resolve(scope: CredentialEgressScope, target: string): Promise<Response>;
  forward(scope: CredentialEgressScope, input: CredentialEgressForward): Promise<Response>;
}
export const credentialEgressDenied = (status: number) => new Response("Credential relay request denied", { status });
/** 403 naming the rule (design §8.4b "body 写明被哪条规则拒"). */
export const vaultPlaceholderDenied = (rule: VaultSubstitutionDenyRule) => new Response(`Credential relay request denied: ${rule}`, { status: 403 });

/** Order is part of the contract: target, Vault match, method, headers, then body. */
function egressCore(ports: CredentialEgressCorePorts) {
  const authorize = async (scope: CredentialEgressScope, target: string) => {
    let url: URL;
    try {
      url = new URL(target);
      if (url.protocol !== "https:" || url.username || url.password || url.hash
        || url.pathname.startsWith(`${EGRESS_RELAY_PATH}/`)) return null;
    } catch { return null; }
    const plan = ports.credentials.sandboxEgress !== undefined
      ? await ports.credentials.sandboxEgress(scope, url.hostname)
      : { target: await ports.credentials.outboundTarget(scope, url.hostname), substitutions: [] as VaultSubstitutionSecret[] };
    return { url, ...plan, substitutes: plan.substitutions.some((secret) => substitutesOnHost(secret, url.hostname)) };
  };
  const refuse = (scope: CredentialEgressScope, host: string, rule: VaultSubstitutionDenyRule, credentialId: string | null) => {
    ports.log?.warn({ op: "credential_egress.placeholder_refused", rule, host, credential_id: credentialId,
      workspace_id: scope.workspaceId, session_id: scope.sessionId }, "Vault placeholder refused at egress");
    return vaultPlaceholderDenied(rule);
  };
  const forward = async (scope: CredentialEgressScope, target: string, method: string,
    input: { headers(): Headers; body(): Promise<ArrayBuffer | null> }) => {
    const authorized = await authorize(scope, target);
    if (authorized === null) return credentialEgressDenied(400);
    // A stale local interception may outlive a Vault removal. Never fall back
    // to sending the placeholder, or turn this endpoint into an open proxy.
    if (authorized.target === null && !authorized.substitutes) {
      let carries = false;
      try { carries = carriesVaultPlaceholder(input.headers(), null); } catch { /* still 403 */ }
      if (carries) refuse(scope, authorized.url.hostname, "credential_host_mismatch", null);
      return credentialEgressDenied(403);
    }
    if (!/^[A-Z]+$/u.test(method) || ["CONNECT", "TRACE"].includes(method)) return credentialEgressDenied(400);
    let inbound: Headers;
    try { inbound = relayHeaders(input.headers()); } catch { return credentialEgressDenied(400); }
    const { url, target: credential, substitutions } = authorized;
    const substituted = substituteVaultPlaceholders({
      host: url.hostname, headers: inbound, body: ["GET", "HEAD"].includes(method) ? null : await input.body(), secrets: substitutions,
    });
    if (!substituted.ok) return refuse(scope, url.hostname, substituted.rule, substituted.credentialId);
    const { body } = substituted;
    // Sandbox control headers are stripped (egress.ts) unless they carry a
    // value substituted here: that is the request the Agent meant to send.
    const outbound = (headers: Headers) => {
      for (const name of substituted.substitutedHeaders) if (!headers.has(name)) headers.set(name, substituted.headers.get(name)!);
      return headers;
    };
    const send = (token: string | null) => ports.send(new Request(url, { method,
      headers: outbound(egressRequestHeaders(substituted.headers, token === null
        ? { token: null, stripAuthorization: false }
        : { token, stripAuthorization: true, ...(credential!.header ? { header: credential!.header } : {}) })),
      body, redirect: "manual",
    }));
    const response = credential === null ? await send(null) : (await ports.credentials.forward(scope.workspaceId, credential, send)).response;
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: scrubVaultValues(relayHeaders(response.headers), substitutions) });
  };
  return {
    async resolve(scope: CredentialEgressScope, target: string) {
      const authorized = await authorize(scope, target);
      return authorized === null ? credentialEgressDenied(400) : Response.json({ inject: authorized.target !== null || authorized.substitutes });
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
  /** The pass's attempt is current and its Session usable → the egress
   * scope; otherwise null (403). One shared implementation:
   * @open-managed-agents/sandbox-gateway authorizeSandboxEgress. */
  authorize(claims: EgressRelayClaims): Promise<CredentialEgressScope | null>;
}
export interface CredentialEgressRelay { handle(action: "resolve" | "forward", request: Request): Promise<Response> }

/** Public metadata is in outer headers; original upstream headers are a separate JSON envelope. */
export function createCredentialEgressRelay(ports: CredentialEgressRelayPorts): CredentialEgressRelay {
  const core = egressCore(ports);
  return { async handle(action, request) {
    const pass = /^Bearer (\S+)$/u.exec(request.headers.get("authorization") ?? "")?.[1];
    const claims = pass ? await ports.passes.verify(pass) : null;
    if (claims === null) return credentialEgressDenied(401);
    const scope = await ports.authorize(claims);
    if (scope === null) return credentialEgressDenied(403);
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
