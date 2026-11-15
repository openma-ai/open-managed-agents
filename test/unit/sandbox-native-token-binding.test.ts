import { expect, it } from "vitest";
import { createSandboxPorts } from "../../packages/sandbox-port-kit/src/create-sandbox-ports";
import { relaySandboxToken } from "../../apps/agent/src/runtime/session-sandbox-token";
import { issueCfSandboxTokenResult } from "../../apps/main/src/lib/cf-sandbox-token-rpc";
import type { SandboxTokenStore, SandboxTokenSession } from "../../packages/sandbox-gateway/src/sandbox-token-store";
import type { Env, SandboxTokenIssueRequest } from "../../packages/shared/src/index";
import { handleCredentialEgressRequest } from "../../apps/agent/src/oma-sandbox";
import { executionEgress } from "../../apps/agent/src/runtime/cloudflare-session-sandbox";


it.each(["store unavailable", "Sandbox token Session Execution fence is stale", "Sandbox token scope mismatch"])("does not defer a managed token failure to native egress: %s", async message => {
  let delivered = false;
  const { ports } = createSandboxPorts({ name: "native", lifecycle: {} as never, vendor: {} as never, native: { storage: () => ({} as never), egress: () => ({ port: { attach: async () => { delivered = true; }, update: async () => { delivered = true; }, revoke: async () => {} } }) } }, { storage: {} as never, egress: { gateway: { endpoint: { url: "https://gateway.test" }, issueToken: async () => { throw new Error(message); }, authenticate: async () => null, handle: async () => new Response(null, { status: 403 }) } } });
  const scope = { workspaceId: "ws", sessionId: "session_managed", environmentId: "env", workId: "exec" };
  const input = { runtime: {}, scope, fence: { ...scope, ownerId: "owner", generation: 1, token: "att", expiresAt: "2099-01-01T00:00:00Z" }, policy: null, signal: new AbortController().signal };
  await expect(ports.egress.attach(input)).rejects.toThrow(message);
  await expect(ports.egress.update({ ...input, changedCredentialIds: [] })).rejects.toThrow(message);
  expect(delivered).toBe(false);
});

it("lets native CF egress bind a legacy Session without Vault instead of eagerly failing managed-only token issuance", async () => {
  const warnings: string[] = [], contexts: unknown[] = [];
  const attempt = { workspaceId: "ws", sessionId: "sess-legacy", executionId: "exec", attemptId: "att", ownerId: "owner", generation: 1 };
  // The service response represents a positively identified, unarchived legacy
  // Session with a live lease, not a missing managed row or a raw NotFound.
  const env = { MAIN_MCP: { issueSandboxToken: async (request: SandboxTokenIssueRequest & { resultFormat: "typed" }) => {
    expect(request).toEqual({ tenantId: "ws", sessionId: "sess-legacy", attempt, harness: "acp-sandbox", resultFormat: "typed" });
    const store: SandboxTokenStore = { find: async () => null, findSession: async () => null, replaceTokenHash: async () => { throw new Error("legacy must not mutate a token"); } };
    return JSON.parse(JSON.stringify(await issueCfSandboxTokenResult({ store, legacySession: async () => ({ archivedAt: null }), legacyFenceActive: async () => true, report: () => {} }, request)));
  } } } as unknown as Pick<Env, "MAIN_MCP">;
  const relayToken = () => relaySandboxToken(env, attempt, "acp-sandbox", "box-1");
  const runtime = { describeSandbox: async () => ({ incarnation: "box-1" }), setOutboundContext: async (value: unknown) => { contexts.push(value); } };
  const native = executionEgress({ session: () => ({ tenantId: "ws", sessionId: "sess-legacy" }), fence: () => ({ executionId: "exec", attemptId: "att", ownerId: "owner", generation: 1 }), relayToken, warn: message => { warnings.push(message); } } as never);
  const { ports } = createSandboxPorts({ name: "cf-native", lifecycle: {} as never, vendor: {} as never, native: { storage: () => ({} as never), egress: () => ({ port: native, tokenBinding: "native" }) } }, { storage: {} as never, egress: { gateway: { endpoint: { url: "https://gateway.test" }, issueToken: relayToken, authenticate: async () => null, handle: async () => new Response(null, { status: 403 }) } } });
  const scope = { workspaceId: "ws", sessionId: "sess-legacy", environmentId: "env", workId: "exec" };
  await ports.egress.attach({ runtime: runtime as never, scope, fence: { ...scope, ownerId: "owner", generation: 1, token: "att", expiresAt: "2099-01-01T00:00:00Z" }, policy: null, signal: new AbortController().signal });
  expect(contexts).toEqual([{ tenantId: "ws", sessionId: "sess-legacy" }]);
  const denied = await handleCredentialEgressRequest(new Request("https://vault.example/rpc", { headers: { authorization: "Bearer oma_vault_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ" } }), {} as never, { containerId: "box-1", className: "OmaSandbox", params: contexts[0] } as never);
  expect(denied.status).toBe(403);
  expect(warnings).toEqual(["Vault and GitHub credentials are unavailable this execution: no sandbox token (Legacy Session has no managed sandbox token; Vault and GitHub credentials are unavailable)"]);
});

it.each(["unavailable", "stale_fence", "scope_mismatch"] as const)("native typed caller refuses managed %s without binding a no-token context", async code => {
  const contexts: unknown[] = [], warnings: string[] = [];
  const attempt = { workspaceId: "ws", sessionId: `session-${code}`, executionId: "exec", attemptId: "att", ownerId: "owner", generation: 1 };
  const env = { MAIN_MCP: { issueSandboxToken: async (request: SandboxTokenIssueRequest & { resultFormat: "typed" }) => {
    expect(request.resultFormat).toBe("typed");
    const session: SandboxTokenSession = { workspaceId: "ws", sessionId: attempt.sessionId, archivedAt: null, environmentId: "env", vaultIds: [], agent: {id:"agent",version:1}, skills:[],fileIds:[],memoryStores:[] };
    const store: SandboxTokenStore = { find: async () => null, findSession: async () => session, replaceTokenHash: async () => { if (code === "unavailable") throw new Error("private database failure"); return code === "stale_fence" ? "stale" : "scope_mismatch"; } };
    return JSON.parse(JSON.stringify(await issueCfSandboxTokenResult({ store, legacySession: async () => { throw new Error("managed must not probe legacy"); }, legacyFenceActive: async () => false, report: () => {} }, request)));
  } } } as unknown as Pick<Env, "MAIN_MCP">;
  const native = executionEgress({ session: () => ({ tenantId: "ws", sessionId: attempt.sessionId }), fence: () => attempt, relayToken: () => relaySandboxToken(env, attempt, "acp-sandbox", "box-1"), warn: message => { warnings.push(message); } } as never);
  const runtime = { describeSandbox: async () => ({ incarnation: "box-1" }), setOutboundContext: async (value: unknown) => { contexts.push(value); } };
  await expect(native.attach({ runtime } as never)).rejects.toMatchObject({name:"SandboxTokenAuthorityError",phase:"token_replace",code});
  expect(contexts).toEqual([]);
  expect(warnings).toEqual([]);
});
