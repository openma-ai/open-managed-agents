import { describe, expect, it } from "vitest";
import { ManagedCredentialResolver } from "../../../packages/managed-credential-resolver/src/resolver";
import { createSpecRegistry, builtinSpecs } from "../../../packages/cap/src/index";
import { createCredentialEgressRelay } from "../../../packages/managed-credential-resolver/src/relay";
import { buildCredentialEgressRoutes } from "../../../packages/managed-agents-adapters-http/src/credential-egress";
import type { StoredCredential, CredentialStore } from "../../../packages/credential-store/src/index";
import { sandboxBasicCredential } from "../../../packages/sandbox-gateway/src/index";
import { memorySandboxTokens } from "../../../packages/sandbox-gateway/test/memory-sandbox-token-store";

function fixture(cliId?: string) {
  let vaultIds = ["vault"];
  const now = 1000;
  let status = 200;
  let refreshOk = true;
  const seen: Request[] = [];
  let refreshes = 0;
  let row: StoredCredential = { revision: 1, credential: {
    id: "credential", vaultId: "vault", displayName: "test", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", archivedAt: null, metadata: {},
    auth: { type: "mcp_oauth", mcpServerUrl: "https://upstream.example/mcp", accessToken: "real-token", refresh: { refreshToken: "refresh-token", tokenEndpoint: "https://auth.example/token", clientId: "client", tokenEndpointAuth: { type: "none" } } },
  } };
  if (cliId) row.credential.auth = { type: "cap_cli", cliId, token: "real-token" };
  const credentials: CredentialStore = {
    list: async ({ vaultId }) => vaultId === "vault" ? [row] : [],
    find: async () => row,
    replace: async ({ next }) => { row = { revision: row.revision + 1, credential: next }; return { type: "replaced", record: row }; },
    insert: async () => { throw new Error("unused"); }, archive: async () => ({ type: "not_found" }), delete: async () => ({ type: "not_found" }),
  };
  const resolver = new ManagedCredentialResolver({ credentials, vaults: { find: async () => ({ vault: { archivedAt: null } }) }, clock: { now: () => new Date(now) }, log: { warn() {} }, fetch: async () => {
    refreshes++;
    return refreshOk ? Response.json({ access_token: "fresh-token" }) : new Response("refused", { status: 400 });
  } }, createSpecRegistry(builtinSpecs));
  const tokens = memorySandboxTokens({ vaultIds: () => vaultIds });
  const relay = createCredentialEgressRelay({
    authenticate: tokens.authenticate,
    credentials: resolver,
    send: async request => {
      seen.push(request);
      const responseStatus = status === 401 && request.headers.get("authorization") === "Bearer fresh-token" ? 200 : status;
      const empty = request.method === "HEAD" || [204, 205, 304].includes(responseStatus);
      return new Response(empty ? null : new Uint8Array([0, 255, 128]), { status: responseStatus, headers: {
        "content-type": "application/octet-stream", ...(request.method === "HEAD" || responseStatus === 304 ? { "content-length": "123" } : {}),
      } });
    },
  });
  return { tokens, relay, seen, get refreshes() { return refreshes; }, setVaults: (ids: string[]) => { vaultIds = ids; }, archive: () => tokens.archive(), settle: () => tokens.settle(), setStatus: (value: number) => { status = value; }, failRefresh: () => { refreshOk = false; } };
}

async function call(f: ReturnType<typeof fixture>, path: string, opts: { authorization?: string; target?: string; headers?: Record<string, string>; body?: Uint8Array; method?: string } = {}) {
  const authorization = opts.authorization ?? sandboxBasicCredential("session", await f.tokens.issue());
  const app = buildCredentialEgressRoutes(() => f.relay);
  return app.request(`https://control.example${path}`, { method: "POST", headers: {
    authorization, "x-oma-egress-target": opts.target ?? "https://upstream.example/a%2Fb?q=one%20two",
    "x-oma-egress-method": opts.method ?? "POST", "x-oma-egress-headers": JSON.stringify(opts.headers ?? { authorization: "Bearer __cap_managed__", "content-type": "application/octet-stream" }),
  }, body: opts.body ?? new Uint8Array([0, 255, 1, 128]) });
}

describe("credential relay shared HTTP contract", () => {
  it("injects only at the control plane, preserves binary payload/path/query and streams response bytes", async () => {
    const f = fixture();
    const response = await call(f, "/forward", { headers: { authorization: "Bearer __cap_managed__", "proxy-authorization": "must-strip", connection: "x-hop", "x-hop": "must-strip", "x-oma-egress-target": "must-strip", "x-client": "keep" } });
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0, 255, 128]));
    const request = f.seen[0]!;
    expect(request.url).toBe("https://upstream.example/a%2Fb?q=one%20two");
    expect(request.method).toBe("POST");
    expect(new Uint8Array(await request.arrayBuffer())).toEqual(new Uint8Array([0, 255, 1, 128]));
    expect(request.headers.get("authorization")).toBe("Bearer real-token");
    expect(request.headers.get("x-client")).toBe("keep");
    for (const header of ["proxy-authorization", "connection", "x-hop", "x-oma-egress-target"]) expect(request.headers.has(header)).toBe(false);
  });

  it.each([
    { cliId: "glab", target: "https://gitlab.com/api/v4/user", alias: "PRIVATE-TOKEN" },
    { cliId: "gh", target: "https://api.github.com/user", alias: "X-Github-Token" },
  ])("applies $cliId spec header stripping before injecting the real token", async ({ cliId, target, alias }) => {
    const f = fixture(cliId);
    const response = await call(f, "/forward", { target, headers: { [alias]: "__cap_managed__", authorization: "Bearer __cap_managed__", "x-client": "keep" } });
    expect(response.status).toBe(200);
    expect(f.seen[0]!.headers.get("authorization")).toBe("Bearer real-token");
    expect(f.seen[0]!.headers.has(alias)).toBe(false);
    expect(f.seen[0]!.headers.get("x-client")).toBe("keep");
  });

  it("separates HEAD representation length from POST transport framing without changing native responses", async () => {
    const f = fixture();
    const response = await call(f, "/forward", { method: "HEAD" });
    expect(response.status).toBe(200); expect(await response.text()).toBe("");
    expect(response.headers.has("content-length")).toBe(false);
    expect(response.headers.get("x-oma-egress-head-content-length")).toBe("123");
    const native = await f.relay.handle("forward", new Request("https://control.example/forward", { method: "POST", headers: {
      authorization: sandboxBasicCredential("session", await f.tokens.issue()),
      "x-oma-egress-target": "https://upstream.example/", "x-oma-egress-method": "HEAD",
    } }));
    expect(native.body).toBeNull(); expect(native.headers.get("content-length")).toBe("123");
    expect(native.headers.has("x-oma-egress-head-content-length")).toBe(false);
  });

  it.each([204, 205, 304])("keeps %s body null through the shared core and HTTP boundary", async status => {
    const f = fixture(); f.setStatus(status);
    const response = await call(f, "/forward", { method: "GET" });
    expect(response.status).toBe(status); expect(response.body).toBeNull();
    if (status === 304) expect(response.headers.get("content-length")).toBe("123");
  });

  it("revalidates vault bindings for every resolve and forward", async () => {
    const f = fixture();
    expect(await (await call(f, "/resolve")).json()).toEqual({ inject: true });
    f.setVaults([]);
    expect(await (await call(f, "/resolve")).json()).toEqual({ inject: false });
    expect((await call(f, "/forward")).status).toBe(403);
    expect(f.seen).toHaveLength(0);
    f.setVaults(["vault"]);
    expect((await call(f, "/forward")).status).toBe(200);
  });

  it("takes the sandbox token as Basic <sessionId>:<token> only (design §0.0 rule 10, #561)", async () => {
    const f = fixture();
    const token = await f.tokens.issue();
    expect((await call(f, "/forward", { authorization: `Bearer ${token}` })).status).toBe(401);
    expect((await call(f, "/forward", { authorization: sandboxBasicCredential("other", token) })).status).toBe(401);
    expect((await call(f, "/forward", { authorization: "Bearer unfenced" })).status).toBe(401);
    expect(f.seen).toHaveLength(0);
  });

  it.each(["archive", "settle"] as const)("denies requests (401, a definite rejection) after %s", async action => {
    const f = fixture();
    const authorization = sandboxBasicCredential("session", await f.tokens.issue());
    f[action]();
    expect((await call(f, "/forward", { authorization })).status).toBe(401);
    expect(f.seen).toHaveLength(0);
  });

  it("answers 503 when the token cannot be checked, never 401", async () => {
    const f = fixture();
    const authorization = sandboxBasicCredential("session", await f.tokens.issue());
    f.tokens.fail();
    expect((await call(f, "/forward", { authorization })).status).toBe(503);
    expect(f.seen).toHaveLength(0);
  });

  it("replays the complete binary body exactly once only after a successful 401 refresh", async () => {
    const f = fixture(); f.setStatus(401);
    expect((await call(f, "/forward")).status).toBe(200);
    expect(f.refreshes).toBe(1); expect(f.seen).toHaveLength(2);
    for (const request of f.seen) expect(new Uint8Array(await request.arrayBuffer())).toEqual(new Uint8Array([0, 255, 1, 128]));
    expect(f.seen.map(request => request.headers.get("authorization"))).toEqual(["Bearer real-token", "Bearer fresh-token"]);
  });

  it.each([401, 403])("never replays a %s when refresh fails or is forbidden", async status => {
    const f = fixture(); f.setStatus(status); f.failRefresh();
    expect((await call(f, "/forward")).status).toBe(status);
    expect(f.seen).toHaveLength(1); expect(f.refreshes).toBe(status === 401 ? 1 : 0);
  });

  it("rejects malformed passes, plaintext targets and relay loops before dialing", async () => {
    const f = fixture();
    expect((await call(f, "/forward", { authorization: "Basic bad" })).status).toBe(401);
    expect((await call(f, "/forward", { target: "http://upstream.example/" })).status).toBe(400);
    expect((await call(f, "/forward", { target: "https://control.example/v1/oma/egress/forward" })).status).toBe(400);
    expect(f.seen).toHaveLength(0);
  });
});
