import { expect, it } from "vitest";
import { createSandboxPorts } from "../../packages/sandbox-port-kit/src/create-sandbox-ports";
import { issueSandboxToken } from "../../packages/sandbox-gateway/src/sandbox-token-authority";
import { handleCredentialEgressRequest } from "../../apps/agent/src/oma-sandbox";
import { executionEgress } from "../../apps/agent/src/runtime/cloudflare-session-sandbox";
import type { SandboxTokenStore } from "../../packages/sandbox-gateway/src/sandbox-token-store";

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
  const store: SandboxTokenStore = { find: async () => null, findSession: async () => null, replaceTokenHash: async () => { throw new Error("must not replace a missing Session token"); } };
  const relayToken = () => issueSandboxToken(store, attempt, { scope: "all" });
  const runtime = { describeSandbox: async () => ({ incarnation: "box-1" }), setOutboundContext: async (value: unknown) => { contexts.push(value); } };
  const native = executionEgress({ session: () => ({ tenantId: "ws", sessionId: "sess-legacy" }), fence: () => ({ executionId: "exec", attemptId: "att", ownerId: "owner", generation: 1 }), relayToken, warn: message => { warnings.push(message); } } as never);
  const { ports } = createSandboxPorts({ name: "cf-native", lifecycle: {} as never, vendor: {} as never, native: { storage: () => ({} as never), egress: () => ({ port: native, tokenBinding: "native" }) } }, { storage: {} as never, egress: { gateway: { endpoint: { url: "https://gateway.test" }, issueToken: relayToken, authenticate: async () => null, handle: async () => new Response(null, { status: 403 }) } } });
  const scope = { workspaceId: "ws", sessionId: "sess-legacy", environmentId: "env", workId: "exec" };
  await ports.egress.attach({ runtime: runtime as never, scope, fence: { ...scope, ownerId: "owner", generation: 1, token: "att", expiresAt: "2099-01-01T00:00:00Z" }, policy: null, signal: new AbortController().signal });
  expect(contexts).toEqual([{ tenantId: "ws", sessionId: "sess-legacy" }]);
  const denied = await handleCredentialEgressRequest(new Request("https://vault.example/rpc", { headers: { authorization: "Bearer oma_vault_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ" } }), {} as never, { containerId: "box-1", className: "OmaSandbox", params: contexts[0] } as never);
  expect(denied.status).toBe(403);
  expect(warnings).toEqual([expect.stringContaining("no sandbox token (Session sess-legacy was not found)")]);
});
