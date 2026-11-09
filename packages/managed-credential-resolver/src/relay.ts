import {
  carriesVaultPlaceholder, scrubVaultValues, substituteVaultPlaceholders, substitutesOnHost,
  type VaultSubstitutionDenyRule, type VaultSubstitutionSecret,
} from "@open-managed-agents/sandbox-gateway/vault-substitution";
import { egressRequestHeaders } from "./egress";
import type { ManagedCredentialResolver } from "./resolver";

export const EGRESS_RELAY_PATH = "/v1/oma/egress";
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

/** The sandbox credential's decision (@open-managed-agents/sandbox-gateway
 * authenticateSandboxEgress): 401 only for a definite rejection, 503 when it
 * could not be checked — the forwarder exits on 401 and stays up on 5xx. */
export type CredentialEgressAuthentication =
  | { type: "accepted"; scope: CredentialEgressScope }
  | { type: "rejected" }
  | { type: "unavailable"; error: unknown };
export interface CredentialEgressRelayPorts extends CredentialEgressCorePorts {
  authenticate(authorization: string | null): Promise<CredentialEgressAuthentication>;
}
export interface CredentialEgressRelay { handle(action: "resolve" | "forward", request: Request): Promise<Response> }

/** Public metadata is in outer headers; original upstream headers are a separate JSON envelope. */
export function createCredentialEgressRelay(ports: CredentialEgressRelayPorts): CredentialEgressRelay {
  const core = egressCore(ports);
  return { async handle(action, request) {
    const decision = await ports.authenticate(request.headers.get("authorization"));
    if (decision.type === "rejected") return credentialEgressDenied(401);
    if (decision.type === "unavailable") {
      ports.log?.warn({ op: "credential_egress.authentication_unavailable", error: decision.error instanceof Error ? decision.error.message : String(decision.error) }, "Sandbox credential could not be checked");
      return new Response("Credential relay temporarily unavailable", { status: 503 });
    }
    const scope = decision.scope;
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
