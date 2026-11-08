import { describe, expect, it, vi } from "vitest";
import {
  authenticateSandboxBearer, authorizeExecutionCredential, authorizeSandboxEgress, issueExecutionSessionsToken, issueSandboxRelayPass, UNFENCED_RELAY_PASS,
  type SandboxBearerCodec, type SandboxGatewaySession, type SessionExecutionLease,
} from "../src/index";

const NOW = Date.UTC(2026, 10, 8, 12);
const now = () => NOW;
function fixture() {
  const lease: SessionExecutionLease = { executionId: "exe", sessionId: "sess", state: "running", attemptId: "att", ownerId: "owner", generation: 2, claimedAtMs: NOW - 1000, leaseExpiresAtMs: NOW + 1000 };
  const session: SandboxGatewaySession = { archivedAt: null, environmentId: "env", vaultIds: ["vlt"], agent: { id: "agent", version: 7 } };
  const stores = async (workspaceId: string) => ({
    leases: { find: async (input: { executionId: string }) => workspaceId === "ws" && input.executionId === "exe" ? lease : null },
    findSession: async (input: { sessionId: string }) => workspaceId === "ws" && input.sessionId === "sess" ? session : null,
  });
  // The fence snapshot expired; the row (renewed by heartbeat) is still live.
  const fence = { workspaceId: "ws", sessionId: "sess", executionId: "exe", attemptId: "att", ownerId: "owner", generation: 2, expiresAt: new Date(NOW - 1).toISOString() };
  return { lease, session, stores, fence };
}
/** Token = "<kind>:" + JSON claim; stands in for the sealed codecs. */
const codec = (kind: string): SandboxBearerCodec => ({
  async open(request, isCurrent) {
    if (!request.token.startsWith(`${kind}:`)) return null;
    const claim = JSON.parse(request.token.slice(kind.length + 1));
    return await isCurrent({ ...claim, ...request }) ? claim : null;
  },
});
const claim = { workspaceId: "ws", environmentId: "env", sessionId: "sess", workId: "exe", claimedAt: new Date(NOW - 1000).toISOString(), generation: 2 };

describe("authenticateSandboxBearer", () => {
  it("tries the execution token on proxy routes only, then the Work token", async () => {
    const f = fixture();
    const isCurrentClaim = vi.fn(async () => true);
    const authority = { execution: { codec: codec("exec"), stores: f.stores }, work: { codec: codec("work"), isCurrentClaim }, now };
    const token = `exec:${JSON.stringify(claim)}`;
    expect(await authenticateSandboxBearer(authority, { token, method: "POST", path: "/v1/oma/inference-proxy/sess/v1/messages" })).toEqual(claim);
    expect(await authenticateSandboxBearer(authority, { token, method: "POST", path: "/v1/oma/mcp-proxy/sess/server" })).toEqual(claim);
    expect(await authenticateSandboxBearer(authority, { token, method: "GET", path: "/v1/sessions/sess" })).toBeNull();
    expect(isCurrentClaim).not.toHaveBeenCalled();
    const work = `work:${JSON.stringify({ ...claim, workId: "work" })}`;
    expect(await authenticateSandboxBearer(authority, { token: work, method: "GET", path: "/v1/oma/mcp-proxy/sess/server" })).toMatchObject({ workId: "work" });
    expect(isCurrentClaim).toHaveBeenCalledTimes(1);
    expect(await authenticateSandboxBearer({ execution: null, work: null }, { token: work, method: "GET", path: "/x" })).toBeNull();
  });

  it.each(["completed", "generation", "claim", "lease", "archived", "environment"] as const)("revokes the execution token when %s", async (reason) => {
    const f = fixture();
    if (reason === "completed") f.lease.state = "completed";
    if (reason === "generation") f.lease.generation = 3;
    if (reason === "claim") f.lease.claimedAtMs = NOW;
    if (reason === "lease") f.lease.leaseExpiresAtMs = NOW;
    if (reason === "archived") f.session.archivedAt = "2026-11-08T00:00:00Z";
    if (reason === "environment") f.session.environmentId = "other";
    const authority = { execution: { codec: codec("exec"), stores: f.stores }, work: null, now };
    expect(await authenticateSandboxBearer(authority, { token: `exec:${JSON.stringify(claim)}`, method: "POST", path: "/v1/oma/mcp-proxy/sess/s" })).toBeNull();
  });
});

describe("issueExecutionSessionsToken", () => {
  const expected = { workspaceId: "ws", sessionId: "sess", environmentId: "env", agent: { id: "agent", version: 7 } };

  it("mints only for the live attempt, bound to its claim", async () => {
    const f = fixture();
    const mint = vi.fn(async (claim: { executionId: string; claimedAt: string; generation: number }) => `token:${claim.executionId}:${claim.generation}`);
    await expect(issueExecutionSessionsToken(f.stores, f.fence, expected, mint, now)).resolves.toBe("token:exe:2");
    expect(mint).toHaveBeenCalledWith({ executionId: "exe", claimedAt: new Date(NOW - 1000).toISOString(), generation: 2 });
  });

  it("never mints for a stale fence", async () => {
    const f = fixture();
    const mint = vi.fn(async () => "token");
    await expect(issueExecutionSessionsToken(f.stores, { ...f.fence, attemptId: "other" }, expected, mint, now)).rejects.toThrow(/stale/);
    await expect(issueExecutionSessionsToken(f.stores, undefined, expected, mint, now)).rejects.toThrow(/fence/);
    expect(mint).not.toHaveBeenCalled();
  });
});

describe("authorizeExecutionCredential", () => {
  const expected = { workspaceId: "ws", sessionId: "sess", environmentId: "env", agent: { id: "agent", version: 7 } };
  it("trusts the lease row, not the fence snapshot's expiry, and returns the lease to bind", async () => {
    const f = fixture();
    expect(await authorizeExecutionCredential(f.stores, f.fence, expected, now)).toEqual(f.lease);
  });
  it.each([
    ["missing fence", (f: ReturnType<typeof fixture>) => ({ fence: undefined }), /requires a current Session Execution fence/],
    ["other session", (f: ReturnType<typeof fixture>) => ({ fence: { ...f.fence, sessionId: "other" } }), /requires a current Session Execution fence/],
    ["stale attempt", (f: ReturnType<typeof fixture>) => ({ fence: { ...f.fence, attemptId: "old" } }), /fence is stale/],
    ["expired row", (f: ReturnType<typeof fixture>) => { f.lease.leaseExpiresAtMs = NOW; return {}; }, /fence is stale/],
    ["archived", (f: ReturnType<typeof fixture>) => { f.session.archivedAt = "x"; return {}; }, /archived and cannot receive new events/],
    ["environment", (f: ReturnType<typeof fixture>) => { f.session.environmentId = "other"; return {}; }, /requires the Session environment/],
    ["agent", (f: ReturnType<typeof fixture>) => { f.session.agent.version = 8; return {}; }, /requires the pinned Session agent/],
  ] as const)("rejects %s", async (_name, mutate, message) => {
    const f = fixture();
    const override = mutate(f) as { fence?: typeof f.fence };
    await expect(authorizeExecutionCredential(f.stores, "fence" in override ? override.fence : f.fence, expected, now)).rejects.toThrow(message);
  });
});

describe("authorizeSandboxEgress", () => {
  it("scopes egress to the current attempt and denies without one", async () => {
    const f = fixture();
    expect(await authorizeSandboxEgress(f.stores, f.fence, now)).toEqual({ workspaceId: "ws", sessionId: "sess", vaultIds: ["vlt"] });
    expect(await authorizeSandboxEgress(f.stores, null, now)).toBeNull();
    expect(await authorizeSandboxEgress(f.stores, { ...f.fence, ownerId: "other" }, now)).toBeNull();
    f.lease.state = "completed"; // between turns
    expect(await authorizeSandboxEgress(f.stores, f.fence, now)).toBeNull();
    f.lease.state = "running"; f.session.archivedAt = "x";
    expect(await authorizeSandboxEgress(f.stores, f.fence, now)).toBeNull();
  });
});

describe("issueSandboxRelayPass", () => {
  it("binds the pass to the attempt and hands out an unverifiable pass without one", async () => {
    const f = fixture();
    const issue = vi.fn(async () => "signed");
    expect(await issueSandboxRelayPass(issue, f.fence, 1000)).toBe("signed");
    expect(issue).toHaveBeenCalledWith({ workspaceId: "ws", sessionId: "sess", executionId: "exe", attemptId: "att", ownerId: "owner", generation: 2, ttlMs: 1000 });
    expect(await issueSandboxRelayPass(issue, undefined, 1000)).toBe(UNFENCED_RELAY_PASS);
    expect(issue).toHaveBeenCalledTimes(1);
  });
});
