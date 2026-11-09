import { describe, expect, it, vi } from "vitest";
import {
  authenticateSandboxBearer, authenticateSandboxEgress, authenticateSandboxTokenRequest,
  generateSandboxToken, isSandboxTokenScope, parseSandboxBasicCredential, sandboxBasicCredential,
  sandboxHarnessPlacement, sandboxTokenRandomPart, sandboxTokenScopeAdmits, sandboxTokenScopeFor, SANDBOX_TOKEN_LENGTH,
  UNFENCED_SANDBOX_TOKEN,
  type SandboxBearerCodec, type SandboxTokenStore,
} from "../src/index";

const NOW = Date.UTC(2026, 10, 8, 12);
const now = () => NOW;

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
    replaceTokenHash: vi.fn(async () => { throw new Error("must not write"); }),
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
  it("egress takes the sandbox token as Basic only: any Bearer (a pre-#561 relay pass included) is rejected unread; a store error is unavailable", async () => {
    const failing: SandboxTokenStore = { ...untouched(), find: async () => { throw new Error("db down"); } };
    expect(await authenticateSandboxEgress(failing, sandboxBasicCredential("s", generateSandboxToken()), { now })).toMatchObject({ type: "unavailable" });
    const store = untouched();
    for (const header of [`Bearer ${generateSandboxToken()}`, "Bearer eyJ3b3Jrc3BhY2VJZCI6IndzIn0.c2ln", "Bearer sk-ant-req-v1.sealed", null]) {
      expect(await authenticateSandboxEgress(store, header, { now })).toEqual({ type: "rejected" });
    }
    expect(store.find).not.toHaveBeenCalled();
  });
});

/** Token = "<kind>:" + JSON claim; stands in for the sealed codec. */
const codec = (kind: string): SandboxBearerCodec => ({
  async open(request, isCurrent) {
    if (!request.token.startsWith(`${kind}:`)) return null;
    const claim = JSON.parse(request.token.slice(kind.length + 1));
    return await isCurrent({ ...claim, ...request }) ? claim : null;
  },
});
const claim = { workspaceId: "ws", environmentId: "env", sessionId: "sess", workId: "work", claimedAt: new Date(NOW - 1000).toISOString(), generation: 2 };

describe("sealed bearer: the ADR 0005 Work token only (design §0.0b B.4)", () => {
  it("opens a Work token while its claim is current, on any route the codec admits", async () => {
    const isCurrentClaim = vi.fn(async () => true);
    const token = `work:${JSON.stringify(claim)}`;
    for (const path of ["/v1/oma/inference-proxy/sess/v1/messages", "/v1/oma/mcp-proxy/sess/server", "/v1/sessions/sess"]) {
      expect(await authenticateSandboxBearer({ work: { codec: codec("work"), isCurrentClaim } }, { token, method: "POST", path })).toEqual({ type: "resolved", resolution: claim });
    }
    isCurrentClaim.mockResolvedValue(false);
    expect(await authenticateSandboxBearer({ work: { codec: codec("work"), isCurrentClaim } }, { token, method: "POST", path: "/v1/sessions/sess" })).toEqual({ type: "none" });
    expect(await authenticateSandboxBearer({ work: null }, { token, method: "GET", path: "/x" })).toEqual({ type: "none" });
  });
  it("there is no execution-token branch: a token the Work codec does not open is none on the proxy routes", async () => {
    const isCurrentClaim = vi.fn(async () => true);
    const executionToken = `exec:${JSON.stringify({ ...claim, workId: "exe" })}`;
    expect(await authenticateSandboxBearer({ work: { codec: codec("work"), isCurrentClaim } }, { token: executionToken, method: "POST", path: "/v1/oma/inference-proxy/sess/v1/messages" })).toEqual({ type: "none" });
    expect(isCurrentClaim).not.toHaveBeenCalled();
  });
  it("a database error while checking the claim is unavailable, not a rejection", async () => {
    const isCurrentClaim = vi.fn(async () => { throw new Error("db down"); });
    expect(await authenticateSandboxBearer({ work: { codec: codec("work"), isCurrentClaim } }, { token: `work:${JSON.stringify(claim)}`, method: "POST", path: "/v1/oma/mcp-proxy/sess/s" })).toMatchObject({ type: "unavailable" });
  });
});
