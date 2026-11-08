import { describe, expect, it } from "vitest";
import { createCredentialEgressCore, createCredentialEgressRelay, createEgressRelayPasses, type CredentialEgressCorePorts } from "../src/relay";

const scope = { workspaceId: "ws", sessionId: "session", vaultIds: ["vault"] };
const DENIED = "Credential relay request denied";

function fixture(respond: (request: Request) => Response = () => new Response("ok")) {
  const sent: Request[] = [];
  const lookups: Array<{ scope: unknown; hostname: string }> = [];
  const credentials = {
    outboundTarget: async (lookupScope: unknown, hostname: string) => {
      lookups.push({ scope: lookupScope, hostname });
      return hostname === "upstream.example" ? { upstreamUrl: "https://upstream.example", upstreamToken: "real-token" } : null;
    },
    forward: async (_workspaceId: string, target: { upstreamToken: string }, send: (token: string) => Promise<Response>) => ({ response: await send(target.upstreamToken) }),
  } as unknown as CredentialEgressCorePorts["credentials"];
  const ports = { credentials, send: async (request: Request) => { sent.push(request); return respond(request); } };
  return { core: createCredentialEgressCore(ports), ports, sent, lookups };
}
const input = (overrides: Partial<{ target: string; method: string; headers: Headers; body: ArrayBuffer | null }> = {}) => ({
  target: "https://upstream.example/a%2Fb?q=1", method: "POST", headers: new Headers({ authorization: "Bearer __cap_managed__" }),
  body: new Uint8Array([0, 255, 128]).buffer, ...overrides,
});
async function expectDenied(response: Response, status: number) {
  expect(response.status).toBe(status); expect(await response.text()).toBe(DENIED);
}
const invalidTargets = ["http://upstream.example/", "https://user@upstream.example/", "https://:secret@upstream.example/",
  "https://upstream.example/#fragment", "https://upstream.example/v1/oma/egress/forward", "not a url", ""];

describe("credential egress core", () => {
  it("resolves whether the Session has a Vault target for the hostname", async () => {
    const f = fixture();
    const injected = await f.core.resolve(scope, "https://upstream.example/path");
    expect(injected.status).toBe(200); expect(await injected.json()).toEqual({ inject: true });
    expect(await (await f.core.resolve(scope, "https://public.example/")).json()).toEqual({ inject: false });
    expect(f.lookups).toEqual([{ scope, hostname: "upstream.example" }, { scope, hostname: "public.example" }]);
    expect(f.sent).toHaveLength(0);
  });

  it.each(invalidTargets)("rejects target %j with 400 before any Vault lookup", async target => {
    const f = fixture();
    await expectDenied(await f.core.resolve(scope, target), 400);
    await expectDenied(await f.core.forward(scope, input({ target })), 400);
    expect(f.lookups).toHaveLength(0); expect(f.sent).toHaveLength(0);
  });

  it.each(["", "get", "PO ST", "P0ST", "CONNECT", "TRACE"])("rejects method %j with 400", async method => {
    const f = fixture();
    await expectDenied(await f.core.forward(scope, input({ method })), 400);
    expect(f.sent).toHaveLength(0);
  });

  it("refuses with 403 when no Vault target matches, before validating the method", async () => {
    const f = fixture();
    await expectDenied(await f.core.forward(scope, input({ target: "https://public.example/" })), 403);
    await expectDenied(await f.core.forward(scope, input({ target: "https://public.example/", method: "TRACE" })), 403);
    expect(f.sent).toHaveLength(0);
  });

  it("injects the real token and strips hop, proxy and relay headers on the way out", async () => {
    const f = fixture();
    const headers = new Headers({
      authorization: "Bearer __cap_managed__", connection: "x-hop, keep-alive", "x-hop": "strip", "keep-alive": "timeout=5",
      "proxy-authorization": "strip", "proxy-connection": "strip", te: "trailers", trailer: "x-t", upgrade: "h2c",
      "x-oma-egress-target": "strip", "x-client": "keep", "content-type": "application/octet-stream",
    });
    const response = await f.core.forward(scope, input({ headers }));
    expect(response.status).toBe(200);
    const request = f.sent[0]!;
    expect(request.url).toBe("https://upstream.example/a%2Fb?q=1");
    expect(request.method).toBe("POST"); expect(request.redirect).toBe("manual");
    expect(request.headers.get("authorization")).toBe("Bearer real-token");
    expect(request.headers.get("x-client")).toBe("keep");
    expect(request.headers.get("content-type")).toBe("application/octet-stream");
    for (const name of ["connection", "x-hop", "keep-alive", "proxy-authorization", "proxy-connection", "te", "trailer", "upgrade", "x-oma-egress-target"]) {
      expect(request.headers.has(name), name).toBe(false);
    }
    expect(new Uint8Array(await request.arrayBuffer())).toEqual(new Uint8Array([0, 255, 128]));
    expect(headers.get("x-hop")).toBe("strip");
  });

  it("rejects inbound headers it cannot sanitize with 400", async () => {
    const f = fixture();
    await expectDenied(await f.core.forward(scope, input({ headers: new Headers({ connection: "bad name" }) })), 400);
    expect(f.sent).toHaveLength(0);
  });

  it("strips hop and relay headers from the upstream response and forwards status, statusText and body", async () => {
    const f = fixture(() => new Response(new Uint8Array([1, 255]), { status: 418, statusText: "Teapot", headers: {
      connection: "x-hop", "x-hop": "strip", "proxy-authenticate": "strip", "transfer-encoding": "chunked",
      "x-oma-egress-head-content-length": "9", "x-upstream": "keep",
    } }));
    const response = await f.core.forward(scope, input());
    expect(response.status).toBe(418); expect(response.statusText).toBe("Teapot");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 255]));
    expect(response.headers.get("x-upstream")).toBe("keep");
    for (const name of ["connection", "x-hop", "proxy-authenticate", "transfer-encoding", "x-oma-egress-head-content-length"]) {
      expect(response.headers.has(name), name).toBe(false);
    }
  });

  it.each(["GET", "HEAD"])("sends no body for %s even when one is supplied", async method => {
    const f = fixture();
    expect((await f.core.forward(scope, input({ method }))).status).toBe(200);
    expect(f.sent[0]!.method).toBe(method); expect(f.sent[0]!.body).toBeNull();
  });

  it("sends a null body for other methods when none is supplied", async () => {
    const f = fixture();
    expect((await f.core.forward(scope, input({ method: "DELETE", body: null }))).status).toBe(200);
    expect(f.sent[0]!.method).toBe("DELETE"); expect(f.sent[0]!.body).toBeNull();
  });
});

describe("credential egress relay envelope over the core", () => {
  async function relayFixture(session: { vaultIds: string[]; archivedAt: string | null } | null = { vaultIds: ["vault"], archivedAt: null }) {
    const f = fixture();
    const passes = createEgressRelayPasses("relay-core-secret", Date.now);
    const relay = createCredentialEgressRelay({ ...f.ports, passes, findSession: async () => session });
    const pass = await passes.issue({ workspaceId: "ws", sessionId: "session", ttlMs: 60000 });
    const request = (headers: Record<string, string>, authorization = `Bearer ${pass}`) => new Request("https://control.example/forward", {
      method: "POST", headers: { authorization, "x-oma-egress-method": "POST", ...headers }, body: new Uint8Array([7, 8]),
    });
    return { ...f, relay, request };
  }

  it("authenticates the pass and Session before the core", async () => {
    const f = await relayFixture();
    await expectDenied(await f.relay.handle("resolve", f.request({ "x-oma-egress-target": "https://upstream.example/" }, "")), 401);
    await expectDenied(await f.relay.handle("forward", f.request({ "x-oma-egress-target": "https://upstream.example/" }, "Bearer forged.pass")), 401);
    for (const session of [null, { vaultIds: ["vault"], archivedAt: "now" }]) {
      const g = await relayFixture(session);
      await expectDenied(await g.relay.handle("forward", g.request({ "x-oma-egress-target": "https://upstream.example/" })), 403);
    }
    expect(f.lookups).toHaveLength(0);
  });

  it("keeps the Vault 403 ahead of envelope errors and never buffers a denied body", async () => {
    const f = await relayFixture();
    const bad = { "x-oma-egress-headers": "[\"not-an-object\"]" };
    const noTarget = f.request({ "x-oma-egress-target": "https://public.example/", ...bad });
    await expectDenied(await f.relay.handle("forward", noTarget), 403);
    expect(noTarget.bodyUsed).toBe(false);
    for (const envelope of ["[\"x\"]", "null", "{\"a\":1}", "not json", "{\"bad name\":\"v\"}"]) {
      const denied = f.request({ "x-oma-egress-target": "https://upstream.example/", "x-oma-egress-headers": envelope });
      await expectDenied(await f.relay.handle("forward", denied), 400);
      expect(denied.bodyUsed).toBe(false);
    }
    expect(await (await f.relay.handle("resolve", f.request({ "x-oma-egress-target": "https://upstream.example/", ...bad }))).json()).toEqual({ inject: true });
    expect(f.sent).toHaveLength(0);
    expect((await f.relay.handle("forward", f.request({ "x-oma-egress-target": "https://upstream.example/" }))).status).toBe(200);
    expect(new Uint8Array(await f.sent[0]!.arrayBuffer())).toEqual(new Uint8Array([7, 8]));
  });
});
