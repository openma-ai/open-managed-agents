import {expect, it} from "vitest";
import {acpSandboxExecutionEnv, relaySandboxToken} from "../src/runtime/session-sandbox-token";

it.each(["stale_fence", "scope_mismatch", "unavailable", "session_not_found"])("typed token %s is thrown locally with phase and cause", async code => {
  const env = { MAIN_MCP: { issueSandboxToken: async () => ({ type: "failed", phase: "token_replace", code, message: "safe authority refusal", cause: { name: "AuthorityFailure", code } }) } };
  await expect(relaySandboxToken(env as never, { workspaceId: "ws", sessionId: `typed-${code}`, executionId: "e", attemptId: "a", ownerId: "o", generation: 1 }, null)).rejects.toMatchObject({ message: "safe authority refusal", phase: "token_replace", code, cause: { name: "AuthorityFailure", code } });
});

it("RPC transport rejection is not legacy/no-token", async () => {
  const failure = new Error("transport unavailable");
  await expect(relaySandboxToken({ MAIN_MCP: { issueSandboxToken: async () => { throw failure; } } } as never, { workspaceId: "ws", sessionId: "transport", executionId: "e", attemptId: "a", ownerId: "o", generation: 1 }, null)).rejects.toBe(failure);
});

it("explicit legacy result binds no token and denies Vault placeholders", async () => {
  const { executionEgress } = await import("../src/runtime/cloudflare-session-sandbox");
  const { handleCredentialEgressRequest } = await import("../src/oma-sandbox");
  const bound: unknown[] = [], warnings: string[] = [];
  const attempt = { workspaceId: "ws", sessionId: "sess-typed-legacy", executionId: "e", attemptId: "a", ownerId: "o", generation: 1 };
  const env = { MAIN_MCP: { issueSandboxToken: async () => ({ type: "legacy_without_token", phase: "session_lookup", message: "legacy has no managed token" }) } };
  const port = executionEgress({ session: () => ({ tenantId: "ws", environmentId: "env", sessionId: attempt.sessionId, agentId: null }), fence: () => attempt, relayToken: (ref, sandbox) => relaySandboxToken(env as never, ref, null, sandbox), warn: m => { warnings.push(m); } });
  await port.attach({ runtime: { describeSandbox: async () => ({ incarnation: "physical" }), setOutboundContext: async (value: unknown) => { bound.push(value); } } } as never);
  expect(bound).toEqual([{ tenantId: "ws", sessionId: "sess-typed-legacy" }]);
  expect(warnings).toHaveLength(1);
  const denied = await handleCredentialEgressRequest(new Request("https://vault.example/rpc", { headers: { authorization: "Bearer oma_vault_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ" } }), {} as never, { containerId: "physical", className: "OmaSandbox", params: bound[0] } as never);
  expect(denied.status).toBe(403);
});

it.each(["configuration", "session_lookup", "model_lookup", "token_validation"])("typed channel %s refusal is local and never returns empty configuration", async phase => {
  const env = { MAIN_MCP: { issueSandboxToken: async () => ({ type: "issued", token: "token" }), managedAcpExecutionChannels: async () => ({ type: "failed", phase, code: "unavailable", message: "safe channel refusal", cause: { name: "ChannelAuthorityUnavailable", code: "unavailable" } }) } };
  await expect(acpSandboxExecutionEnv(env as never, { workspaceId: "ws", sessionId: `channel-${phase}`, executionId: "e", attemptId: "a", ownerId: "o", generation: 1
  }, "acp-sandbox")).rejects.toMatchObject({ message: "safe channel refusal", phase, code: "unavailable", cause: { name: "ChannelAuthorityUnavailable", code: "unavailable" } });
});

it.each([{ type: "unknown" }, { type: "ready" }, { type: "ready", channels: {} }])("malformed channels RPC response fails closed instead of empty configuration: %j", async result => {
  const env = { MAIN_MCP: { issueSandboxToken: async () => ({ type: "issued", token: "token" }), managedAcpExecutionChannels: async () => result } };
  await expect(acpSandboxExecutionEnv(env as never, { workspaceId: "ws", sessionId: "channel-malformed", executionId: "e", attemptId: "a", ownerId: "o", generation: 1 }, "acp-sandbox")).rejects.toThrow("Invalid ACP sandbox channel authority response");
});

it("channel failure reaches the caller with no agent-side PUBLIC_BASE_URL prerequisite", async () => {
  const failure = new Error("channel authority refused");
  const env = { MAIN_MCP: {
    issueSandboxToken: async () => ({ type: "issued", token: "token" }),
    managedAcpExecutionChannels: async () => { throw failure; },
  }};
  await expect(acpSandboxExecutionEnv(env as never, {
    workspaceId: "ws", sessionId: "channel-failure", executionId: "e", attemptId: "a", ownerId: "o", generation: 1,
  }, "acp-sandbox")).rejects.toBe(failure);
});
