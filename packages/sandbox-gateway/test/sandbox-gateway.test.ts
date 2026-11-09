import { describe, expect, it, vi } from "vitest";
import {
  authenticateSandboxBearer, authenticateSandboxEgress, authenticateSandboxTokenRequest, authorizeSandboxEgress,
  generateSandboxToken, isSandboxTokenScope, legacyRelayPassCheck, parseSandboxBasicCredential, sandboxBasicCredential,
  sandboxHarnessPlacement, sandboxTokenRandomPart, sandboxTokenScopeAdmits, sandboxTokenScopeFor, SANDBOX_TOKEN_LENGTH,
  UNFENCED_SANDBOX_TOKEN,
  type SandboxBearerCodec, type SandboxGatewaySession, type SandboxTokenStore, type SessionExecutionLease,
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
  const fence = { workspaceId: "ws", sessionId: "sess", executionId: "exe", attemptId: "att", ownerId: "owner", generation: 2, expiresAt: new Date(NOW - 1).toISOString() };
  return { lease, session, stores, fence };
}

describe("sandbox token format", () => {
  it("is oma_sbx_ + 43 base62 + 6 base62 CRC32, 57 chars, random each time", () => {
    const a = generateSandboxToken(); const b = generateSandboxToken();
    expect(a).toMatch(/^oma_sbx_[0-9A-Za-z]{49}$/u);
    expect(a.length).toBe(SANDBOX_TOKEN_LENGTH); expect(SANDBOX_TOKEN_LENGTH).toBe(57);
    expect(a).not.toBe(b);
    expect(sandboxTokenRandomPart(a)).toBe(a.slice(8, 51));
  });
  it("refuses any one-character change, truncation or extension (checksum)", () => {
    const token = generateSandboxToken();
    for (let index = 8; index < token.length; index++) {
      const replacement = token[index] === "0" ? "1" : "0";
      expect(sandboxTokenRandomPart(token.slice(0, index) + replacement + token.slice(index + 1))).toBeNull();
    }
    expect(sandboxTokenRandomPart(token.slice(0, -1))).toBeNull();
    expect(sandboxTokenRandomPart(token + "0")).toBeNull();
    expect(sandboxTokenRandomPart(UNFENCED_SANDBOX_TOKEN)).toBeNull();
  });
  it("carries the Session id beside it (Basic), never inside", () => {
    const token = generateSandboxToken();
    expect(token).not.toContain("sess");
    expect(parseSandboxBasicCredential(sandboxBasicCredential("sess", token))).toEqual({ sessionId: "sess", token });
    expect(() => sandboxBasicCredential("a:b", token)).toThrow();
  });
});

describe("sandbox token scope", () => {
  it("has exactly two values, fixed by harness placement", () => {
    expect(sandboxHarnessPlacement("acp-sandbox")).toBe("in_sandbox");
    for (const harness of ["default", "pi", null, undefined, ""]) expect(sandboxHarnessPlacement(harness)).toBe("outside_sandbox");
    expect(sandboxTokenScopeFor("in_sandbox")).toBe("all");
    expect(sandboxTokenScopeFor("outside_sandbox")).toBe("egress");
    expect(() => sandboxTokenScopeFor("elsewhere" as never)).toThrow();
    expect([isSandboxTokenScope("all"), isSandboxTokenScope("egress"), isSandboxTokenScope("admin"), isSandboxTokenScope(undefined)]).toEqual([true, true, false, false]);
  });
  it("api requires all; egress takes all or egress; anything else is refused", () => {
    expect(sandboxTokenScopeAdmits("all", "api")).toBe(true);
    expect(sandboxTokenScopeAdmits("egress", "api")).toBe(false);
    expect(sandboxTokenScopeAdmits("all", "egress")).toBe(true);
    expect(sandboxTokenScopeAdmits("egress", "egress")).toBe(true);
    for (const scope of [undefined, null, "", "ALL", "admin", 1]) {
      expect(sandboxTokenScopeAdmits(scope, "api")).toBe(false);
      expect(sandboxTokenScopeAdmits(scope, "egress")).toBe(false);
    }
  });
});

describe("sandbox token presentation (no store reads for a malformed request)", () => {
  const untouched = (): SandboxTokenStore => ({
    find: vi.fn(async () => { throw new Error("must not read"); }),
    findSession: vi.fn(async () => { throw new Error("must not read"); }),
    appendTokenHash: vi.fn(async () => { throw new Error("must not write"); }),
  });
  it("is absent for other credentials, rejected without a Session id or with two different ones", async () => {
    const store = untouched(); const token = generateSandboxToken();
    const request = (r: Partial<{ path: string; authorization: string | null; apiKey: string | null }>) =>
      authenticateSandboxTokenRequest(store, { method: "GET", path: r.path ?? "/v1/files/f", authorization: r.authorization ?? null, apiKey: r.apiKey ?? null }, now);
    expect(await request({ authorization: "Bearer sk-ant-req-v1.x" })).toEqual({ type: "absent" });
    expect(await request({ apiKey: "omak_workspace" })).toEqual({ type: "absent" });
    expect(await request({ authorization: `Bearer ${token}` })).toEqual({ type: "rejected" }); // sandbox API needs the Basic Session id
    expect(await request({ path: "/v1/oma/mcp-proxy/a/s", authorization: sandboxBasicCredential("b", token) })).toEqual({ type: "rejected" });
    expect(await request({ path: "/v1/oma/mcp-proxy/a/s", authorization: `Bearer ${token}`, apiKey: generateSandboxToken() })).toEqual({ type: "rejected" });
    expect(await request({ path: "/v1/oma/mcp-proxy/a/s", authorization: `Bearer ${UNFENCED_SANDBOX_TOKEN}` })).toEqual({ type: "rejected" });
    expect(store.find).not.toHaveBeenCalled();
  });
  it("reports a store with no configuration as unavailable, not rejected", async () => {
    expect(await authenticateSandboxTokenRequest(null, { method: "POST", path: "/v1/oma/mcp-proxy/a/s", authorization: `Bearer ${generateSandboxToken()}`, apiKey: null }))
      .toMatchObject({ type: "unavailable" });
  });
  it("egress takes Basic only (Bearer = legacy pass); a store error is unavailable", async () => {
    const failing: SandboxTokenStore = { ...untouched(), find: async () => { throw new Error("db down"); } };
    expect(await authenticateSandboxEgress(failing, sandboxBasicCredential("s", generateSandboxToken()), { now })).toMatchObject({ type: "unavailable" });
    expect(await authenticateSandboxEgress(failing, `Bearer ${generateSandboxToken()}`, { now })).toEqual({ type: "rejected" });
    expect(await authenticateSandboxEgress(failing, null, { now })).toEqual({ type: "rejected" });
  });
});

// ---- DEPLOY TRANSITION (verify-only; removed in the next release) ----

/** Token = "<kind>:" + JSON claim; stands in for the sealed codecs. */
const codec = (kind: string): SandboxBearerCodec => ({
  async open(request, isCurrent) {
    if (!request.token.startsWith(`${kind}:`)) return null;
    const claim = JSON.parse(request.token.slice(kind.length + 1));
    return await isCurrent({ ...claim, ...request }) ? claim : null;
  },
});
const claim = { workspaceId: "ws", environmentId: "env", sessionId: "sess", workId: "exe", claimedAt: new Date(NOW - 1000).toISOString(), generation: 2 };

describe("characterization (transition): pre-#561 sealed execution token", () => {
  it("opens on proxy routes only while its attempt runs, then the Work token", async () => {
    const f = fixture();
    const isCurrentClaim = vi.fn(async () => true);
    const authority = { execution: { codec: codec("exec"), stores: f.stores }, work: { codec: codec("work"), isCurrentClaim }, now };
    const token = `exec:${JSON.stringify(claim)}`;
    expect(await authenticateSandboxBearer(authority, { token, method: "POST", path: "/v1/oma/inference-proxy/sess/v1/messages" })).toEqual({ type: "resolved", resolution: claim });
    expect(await authenticateSandboxBearer(authority, { token, method: "POST", path: "/v1/oma/mcp-proxy/sess/server" })).toEqual({ type: "resolved", resolution: claim });
    expect(await authenticateSandboxBearer(authority, { token, method: "GET", path: "/v1/sessions/sess" })).toEqual({ type: "none" });
    expect(isCurrentClaim).not.toHaveBeenCalled();
    const work = `work:${JSON.stringify({ ...claim, workId: "work" })}`;
    expect(await authenticateSandboxBearer(authority, { token: work, method: "GET", path: "/v1/oma/mcp-proxy/sess/server" })).toMatchObject({ type: "resolved", resolution: { workId: "work" } });
    expect(await authenticateSandboxBearer({ execution: null, work: null }, { token: work, method: "GET", path: "/x" })).toEqual({ type: "none" });
  });
  it.each(["completed", "generation", "claim", "lease", "archived", "environment"] as const)("refuses it when %s", async (reason) => {
    const f = fixture();
    if (reason === "completed") f.lease.state = "completed";
    if (reason === "generation") f.lease.generation = 3;
    if (reason === "claim") f.lease.claimedAtMs = NOW;
    if (reason === "lease") f.lease.leaseExpiresAtMs = NOW;
    if (reason === "archived") f.session.archivedAt = "2026-11-08T00:00:00Z";
    if (reason === "environment") f.session.environmentId = "other";
    const authority = { execution: { codec: codec("exec"), stores: f.stores }, work: null, now };
    expect(await authenticateSandboxBearer(authority, { token: `exec:${JSON.stringify(claim)}`, method: "POST", path: "/v1/oma/mcp-proxy/sess/s" })).toEqual({ type: "none" });
  });
  it("a database error while checking is unavailable, not a rejection", async () => {
    const f = fixture();
    const broken = async () => ({ leases: { find: async () => { throw new Error("db down"); } }, findSession: f.stores });
    const authority = { execution: { codec: codec("exec"), stores: broken as never }, work: null, now };
    expect(await authenticateSandboxBearer(authority, { token: `exec:${JSON.stringify(claim)}`, method: "POST", path: "/v1/oma/mcp-proxy/sess/s" })).toMatchObject({ type: "unavailable" });
  });
});

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
/** The pre-#561 signer (credential-relay.v2), reproduced: nothing issues these any more. */
async function legacyPass(secret: string, claims: Record<string, unknown>) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(`credential-relay.v2:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const payload = b64url(new TextEncoder().encode(JSON.stringify(claims)));
  return `${payload}.${b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))))}`;
}

describe("characterization (transition): pre-#561 HMAC relay pass", () => {
  const claims = { workspaceId: "ws", sessionId: "sess", executionId: "exe", attemptId: "att", ownerId: "owner", generation: 2, expiresAt: NOW + 60_000 };
  it("verifies only while its attempt is the running one, checked on every request", async () => {
    const f = fixture();
    const check = legacyRelayPassCheck("root", f.stores, now);
    const pass = await legacyPass("root", claims);
    expect(await check(pass)).toEqual({ type: "accepted", scope: { workspaceId: "ws", sessionId: "sess", vaultIds: ["vlt"] } });
    expect(await authenticateSandboxEgress({} as SandboxTokenStore, `Bearer ${pass}`, { legacyPass: check, now })).toMatchObject({ type: "accepted" });
    f.lease.state = "completed";
    expect(await check(pass)).toEqual({ type: "rejected" });
    expect(await check(await legacyPass("other-secret", claims))).toEqual({ type: "rejected" });
    expect(await check(await legacyPass("root", { ...claims, expiresAt: NOW }))).toEqual({ type: "rejected" });
  });
});

describe("authorizeSandboxEgress (native egress binding, fence-checked)", () => {
  it("scopes egress to the current attempt and denies without one", async () => {
    const f = fixture();
    expect(await authorizeSandboxEgress(f.stores, f.fence, now)).toEqual({ workspaceId: "ws", sessionId: "sess", vaultIds: ["vlt"] });
    expect(await authorizeSandboxEgress(f.stores, null, now)).toBeNull();
    expect(await authorizeSandboxEgress(f.stores, { ...f.fence, ownerId: "other" }, now)).toBeNull();
    f.lease.state = "completed";
    expect(await authorizeSandboxEgress(f.stores, f.fence, now)).toBeNull();
    f.lease.state = "running"; f.session.archivedAt = "x";
    expect(await authorizeSandboxEgress(f.stores, f.fence, now)).toBeNull();
  });
});
