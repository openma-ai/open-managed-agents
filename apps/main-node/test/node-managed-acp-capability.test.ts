import { describe, expect, it } from "vitest";
import type { Environment, Session } from "@open-managed-agents/managed-agents-application";
import type { SessionExecution, SessionExecutionFence } from "@open-managed-agents/session-runtime-contract";
import { authenticateEnvironmentWorkSessionBearer, SealedEnvironmentWorkSessionCredentialIssuer } from "@open-managed-agents/managed-agents-adapters-runtime";
import { createNodeManagedAcpCapabilities } from "../../../packages/control-plane-node/src/lib/node-managed-acp-capability";
import { createNodeSecrets } from "../../../packages/control-plane-node/src/secrets";

function fixture() {
  let now = new Date("2026-10-23T08:00:00Z");
  const session: Session = { id: "session", environmentId: "env", agent: { id: "agent", version: 7, name: "pinned", model: { id: "workspace-model" }, mcpServers: [], tools: [], skills: [], system: null, description: null, multiagent: null }, archivedAt: null, budget: null, createdAt: now.toISOString(), updatedAt: now.toISOString(), metadata: {}, outcomeEvaluations: [], resources: [], stats: {}, status: "running", title: null, usage: {}, vaultIds: [] };
  const environment: Environment = { id: "env", config: { type: "self_hosted" }, archivedAt: null, createdAt: now.toISOString(), updatedAt: now.toISOString(), name: "test", description: null, metadata: {} };
  const execution: SessionExecution = { id: "exec", workspaceId: "tenant", sessionId: "session", laneId: "primary", admittedAt: now.toISOString(), events: [], state: "running", attempt: { id: "attempt", ownerId: "owner", generation: 2, claimedAt: now.toISOString(), leaseExpiresAt: "2026-10-23T08:01:00Z" }, attemptCount: 2, maxAttempts: 3, deadlineAt: "2026-10-24T00:00:00Z", interruptRequestedAt: null, settledAt: null, heldAfterExhaustedAt: null, failure: null, revision: 2 };
  const fence: SessionExecutionFence = { executionId: "exec", workspaceId: "tenant", sessionId: "session", attemptId: "attempt", ownerId: "owner", generation: 2, expiresAt: "2026-10-23T08:01:00Z" };
  const deps = { crypto: createNodeSecrets("test-only-root").cipherFor("managed.node-acp.execution-token"), gatewayBaseUrl: "https://service.test", now: () => now, findExecution: async ({ workspaceId, executionId }: { workspaceId: string; executionId: string }) => workspaceId === "tenant" && executionId === "exec" ? execution : null, findSession: async ({ workspaceId, sessionId }: { workspaceId: string; sessionId: string }) => workspaceId === "tenant" && sessionId === "session" ? session : null };
  const capabilities = createNodeManagedAcpCapabilities(deps);
  return { capabilities, deps, execution, session, fence, input: { workspaceId: "tenant", session: structuredClone(session), environment, executionFence: fence }, advance: () => { now = new Date("2026-10-23T08:02:00Z"); } };
}

describe("Node execution-scoped ACP capability", () => {
  it("authorizes only the exact session proxy routes", async () => {
    const f = fixture(); const { sessionsToken: token } = await f.capabilities.issue(f.input);
    for (const path of ["/v1/oma/mcp-proxy/session/maxcompute", "/v1/oma/inference-proxy/session/anthropic/v1/messages"]) expect(await f.capabilities.authenticate({ token, path, method: "POST" })).toMatchObject({ workspaceId: "tenant", sessionId: "session", generation: 2 });
    for (const path of ["/v1/oma/mcp-proxy/other/maxcompute", "/v1/oma/inference-proxy/other/v1/messages", "/v1/agents", "/v1/sessions/session/events", "/v1/environments/env/work/exec/heartbeat", "/v1/oma/sessions/session/runtime-events"]) expect(await f.capabilities.authenticate({ token, path, method: "POST" })).toBeNull();
    expect(await f.capabilities.authenticate({ token: token + "tampered", path: "/v1/oma/mcp-proxy/session/maxcompute", method: "POST" })).toBeNull();
  });
  it("characterization: execution and Work bearers are sealed apart, so resolveBearerToken's order (execution, then Work) only picks the check", async () => {
    const f = fixture(); const { sessionsToken: token } = await f.capabilities.issue(f.input);
    const work = createNodeSecrets("test-only-root").cipherFor("managed.environment-work.session-token");
    const path = "/v1/oma/mcp-proxy/session/maxcompute";
    expect(await authenticateEnvironmentWorkSessionBearer({ token, method: "POST", path, crypto: work, now: f.deps.now })).toBeNull();
    const issuer = new SealedEnvironmentWorkSessionCredentialIssuer({ crypto: work, now: f.deps.now });
    const issued = await issuer.issue({ workspaceId: "tenant", session: f.session, environment: f.input.environment, workId: "work" });
    if (issued.type !== "issued") throw new Error(issued.message);
    const bound = await issuer.bindToClaim({ secret: issued.secret, claimedAt: f.execution.attempt!.claimedAt, generation: 2 });
    expect(await f.capabilities.authenticate({ token: bound.secret.sessionsToken, method: "POST", path })).toBeNull();
    expect(await authenticateEnvironmentWorkSessionBearer({ token: bound.secret.sessionsToken, method: "POST", path, crypto: work, now: f.deps.now })).toMatchObject({ workId: "work" });
  });
  it.each(["completed", "cancelled", "generation", "claim", "lease", "archived", "malformed-lease"] as const)("revokes the bearer when %s", async reason => {
    const f = fixture(); const { sessionsToken: token } = await f.capabilities.issue(f.input);
    if (reason === "completed" || reason === "cancelled") f.execution.state = reason;
    if (reason === "generation") f.execution.attempt!.generation++;
    if (reason === "claim") f.execution.attempt!.claimedAt = "2026-10-23T08:00:01Z";
    if (reason === "lease") f.advance();
    if (reason === "archived") f.session.archivedAt = "2026-10-23T08:00:01Z";
    if (reason === "malformed-lease") f.execution.attempt!.leaseExpiresAt = "invalid";
    expect(await f.capabilities.authenticate({ token, method: "POST", path: "/v1/oma/mcp-proxy/session/maxcompute" })).toBeNull();
  });
  it("issues while the lease row is live although the fence snapshot expired (design §0.0 rule 10: heartbeats renew the row only)", async () => {
    const f = fixture(); f.fence.expiresAt = "2026-10-23T07:59:00Z";
    expect((await f.capabilities.issue(f.input)).sessionsToken).toMatch(/^sk-ant-req-v1\./);
  });
  it.each(["workspace", "session", "agent-version", "owner", "attempt", "generation", "expired-lease", "environment"] as const)("rejects issuing for a mismatched %s", async reason => {
    const f = fixture();
    if (reason === "workspace") f.input.workspaceId = "other";
    if (reason === "session") f.input.session.id = "other";
    if (reason === "agent-version") f.input.session.agent.version++;
    if (reason === "owner") f.fence.ownerId = "other";
    if (reason === "attempt") f.fence.attemptId = "other";
    if (reason === "generation") f.fence.generation++;
    if (reason === "expired-lease") f.advance();
    if (reason === "environment") f.input.environment.id = "other";
    await expect(f.capabilities.issue(f.input)).rejects.toThrow();
  });
  it.each([
    ["missing", /Session session was not found/],
    ["archived", /Session session is archived and cannot receive new events/],
    ["environment", /requires the Session environment/],
    ["agent", /requires the pinned Session agent/],
  ] as const)("names the %s Session failure instead of a generic agent mismatch", async (reason, message) => {
    const f = fixture();
    if (reason === "missing") f.deps.findSession = async () => null;
    if (reason === "archived") f.session.archivedAt = "2026-10-23T08:00:01Z";
    if (reason === "environment") f.session.environmentId = "other";
    if (reason === "agent") f.session.agent.version++;
    await expect(createNodeManagedAcpCapabilities(f.deps).issue(f.input)).rejects.toThrow(message);
  });
  it.each(["crypto", "url", "fence"])("reports missing %s without minting a bearer", async missing => {
    const f = fixture();
    const caps = createNodeManagedAcpCapabilities({ ...f.deps, ...(missing === "crypto" ? { crypto: null } : {}), ...(missing === "url" ? { gatewayBaseUrl: undefined } : {}) });
    await expect(caps.issue({ ...f.input, ...(missing === "fence" ? { executionFence: undefined } : {}) })).rejects.toThrow(/PLATFORM_ROOT_SECRET|PUBLIC_BASE_URL|Execution fence/);
  });
});
