// @ts-nocheck
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  denyCredentialEgressRequest,
  githubAuthHandler,
  handleCredentialEgressRequest,
  handleOpenmaControlPlaneRequest,
} from "../../apps/agent/src/oma-sandbox";
import { CloudflareSandbox } from "../../apps/agent/src/runtime/sandbox";

const TOKEN_SHA = "a".repeat(64);
/** A Session sandbox binding with its current sandbox token (digest). */
const session = { tenantId: "tenant-1", sessionId: "session-1", tokenSha256: TOKEN_SHA };
const context = {
  containerId: "container-1",
  className: "OmaSandbox",
  params: { ...session, environmentId: "environment-1", workId: "work-1", required: true },
};

describe("Cloudflare credential egress handler", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("fails closed when the live token check is unavailable", async () => {
    globalThis.fetch = vi.fn(async () => new Response("unexpected"));
    const response = await handleCredentialEgressRequest(
      new Request("https://mcp.example.test/rpc", {
        headers: { authorization: "Bearer sandbox-secret" },
      }),
      {
        MAIN_MCP: {
          credentialEgress: vi.fn(async () => {
            throw new Error("store unavailable");
          }),
        },
      },
      context,
    );

    expect(response.status).toBe(502);
    expect(await response.text()).toContain("credential egress unavailable");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("a required binding without a sandbox token lets nothing out", async () => {
    const lookup = vi.fn();
    globalThis.fetch = vi.fn(async () => new Response("unexpected"));
    const response = await handleCredentialEgressRequest(
      new Request("https://mcp.example.test/rpc"),
      { MAIN_MCP: { credentialEgress: lookup } },
      { ...context, params: { tenantId: "tenant-1", sessionId: "session-1", required: true } },
    );

    expect(response.status).toBe(403);
    expect(lookup).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("relays the request without receiving the real Vault token in the native adapter", async () => {
    const relay = vi.fn(async (scope, action, request) => {
      expect(scope).toEqual(session);
      if (action === "resolve") return Response.json({ inject: true });
      expect(request.headers.get("authorization")).toBe("Bearer __cap_managed__");
      expect(new Uint8Array(await request.arrayBuffer())).toEqual(new Uint8Array([0,255,128]));
      return new Response(new Uint8Array([1,255]), { status: 201 });
    });
    globalThis.fetch = vi.fn();
    const response = await handleCredentialEgressRequest(new Request("https://mcp.example.test/rpc", {
      method: "POST", body: new Uint8Array([0,255,128]), headers: { authorization: "Bearer __cap_managed__" },
    }), { MAIN_MCP: { credentialEgress: relay } }, context);
    expect(response.status).toBe(201);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1,255]));
    expect(relay).toHaveBeenCalledTimes(2);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  // Design §0.0 rule 10: between turns the binding holds no token.
  it("a Session binding without a sandbox token gets no Vault: the request goes out uninjected", async () => {
    const relay = vi.fn();
    globalThis.fetch = vi.fn(async () => new Response("direct", { status: 200 }));
    const response = await handleCredentialEgressRequest(new Request("https://mcp.example.test/rpc"),
      { MAIN_MCP: { credentialEgress: relay } }, { ...context, params: { tenantId: "tenant-1", sessionId: "session-1" } });
    expect(response.status).toBe(200);
    expect(relay).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("binds Vault egress to the sandbox token; once it is not current a background process keeps only ordinary egress", async () => {
    let current = true;
    const relay = vi.fn(async (scope, action) => {
      expect(scope).toEqual(session);
      if (!current) return new Response("Credential relay request denied", { status: 401 });
      return action === "resolve" ? Response.json({ inject: true }) : new Response("relayed", { status: 201 });
    });
    globalThis.fetch = vi.fn(async (request) => {
      // Ordinary egress as before: only the sandbox's own placeholder, never a Vault token.
      expect(request.headers.get("authorization")).toBe("Bearer __cap_managed__");
      return new Response("direct", { status: 200 });
    });
    const call = () => handleCredentialEgressRequest(new Request("https://mcp.example.test/rpc", { headers: { authorization: "Bearer __cap_managed__" } }),
      { MAIN_MCP: { credentialEgress: relay } }, { ...context, params: session });
    expect((await call()).status).toBe(201);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    current = false; // the turn ended
    const after = await call();
    expect(after.status).toBe(200);
    expect(await after.text()).toBe("direct");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  // §0.0b B.5: no "inject nothing and send it anyway" for Vault traffic.
  it("a rejected token never sends a Vault placeholder on; any failure other than 401 is returned, not degraded", async () => {
    globalThis.fetch = vi.fn(async () => new Response("must not be reached"));
    const call = (status: number, headers: Record<string, string>, params: object = session) => handleCredentialEgressRequest(
      new Request("https://mcp.example.test/rpc", { headers }),
      { MAIN_MCP: { credentialEgress: vi.fn(async () => new Response("denied", { status })) } },
      { ...context, params },
    );
    expect((await call(401, { authorization: `Bearer oma_vault_${"A".repeat(43)}` })).status).toBe(401);
    expect((await call(503, {})).status).toBe(503);
    expect((await call(403, {})).status).toBe(403);
    expect((await call(401, {}, { ...session, required: true })).status).toBe(401);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("GitHub: a token check that fails is an error (502), never an unauthenticated fallback; a bound token is what main checks", async () => {
    globalThis.fetch = vi.fn(async () => new Response("must not be reached"));
    const lookup = vi.fn(async () => { throw new Error("sandbox token could not be checked"); });
    const response = await githubAuthHandler(new Request("https://api.github.com/user"),
      { MAIN_MCP: { lookupGithubCredential: lookup, credentialEgress: vi.fn() } }, { ...context, params: session });
    expect(response.status).toBe(502);
    expect(lookup).toHaveBeenCalledWith({ ...session, hostname: "api.github.com", pathname: "/user" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("passes plain HTTP through without the credential relay (apt over http://)", async () => {
    const relay = vi.fn(async () => new Response("https only", { status: 400 }));
    globalThis.fetch = vi.fn(async (request: Request) => {
      expect(request.url).toBe("http://deb.debian.org/debian/dists/bookworm/InRelease");
      expect(request.headers.has("authorization")).toBe(false);
      return new Response("Release", { status: 200 });
    });
    const response = await handleCredentialEgressRequest(
      new Request("http://deb.debian.org/debian/dists/bookworm/InRelease", { headers: { authorization: "Bearer sandbox-secret" } }),
      { MAIN_MCP: { credentialEgress: relay } },
      context,
    );
    expect(response.status).toBe(200);
    expect(relay).not.toHaveBeenCalled();
  });

  it("drops unmanaged sandbox authorization even when a public host has no Vault match", async () => {
    globalThis.fetch = vi.fn(async (request: Request) => {
      expect(request.headers.has("authorization")).toBe(false);
      expect(request.headers.has("x-api-key")).toBe(false);
      expect(request.headers.has("cookie")).toBe(false);
      return new Response("public", { status: 200 });
    });
    const response = await handleCredentialEgressRequest(
      new Request("https://public.example.test/", {
        headers: {
          authorization: "Bearer sandbox-secret",
          "x-api-key": "openma-control-key",
          cookie: "openma-session=must-not-leak",
        },
      }),
      { MAIN_MCP: { credentialEgress: vi.fn(async () => Response.json({ inject: false })) } },
      context,
    );

    expect(response.status).toBe(200);
  });

  it("denies every request after the binding is revoked", async () => {
    globalThis.fetch = vi.fn(async () => new Response("unexpected"));
    const response = await denyCredentialEgressRequest(
      new Request("https://mcp.example.test/rpc"),
      {},
      { ...context, params: { workId: "work-1", generation: 2, reason: "lease_lost" } },
    );

    expect(response.status).toBe(403);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  // §0.0b B.4: the sealed Work token only on a Work runtime's binding; no
  // pre-#561 execution token on a Session binding.
  it("refuses a sk-ant-req-v1 bearer on a Session binding (no workId); the sandbox token passes", async () => {
    globalThis.fetch = vi.fn(async () => new Response("ok"));
    const bound = { ...context, params: { ...session, controlPlaneOrigin: "https://api.openma.test" } };
    const call = (authorization: string) => handleOpenmaControlPlaneRequest(
      new Request("https://api.openma.test/v1/oma/inference-proxy/session-1/v1/messages", { method: "POST", headers: { authorization }, body: "{}" }), {}, bound);
    expect((await call("Bearer sk-ant-req-v1.legacy")).status).toBe(403);
    expect((await call("Bearer oma_sbx_x")).status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalledOnce();
  });

  it("passes the Work capability only to the bound OpenMA origin", async () => {
    globalThis.fetch = vi.fn(async (request: Request) => {
      expect(request.headers.get("authorization")).toBe("Bearer sk-ant-req-v1.current");
      expect(request.headers.has("cookie")).toBe(false);
      expect(request.redirect).toBe("manual");
      return new Response("ok");
    });
    const response = await handleOpenmaControlPlaneRequest(
      new Request("https://api.openma.test/v1/oma/mcp-proxy/session-1/linear", {
        method: "POST",
        headers: {
          authorization: "Bearer sk-ant-req-v1.current",
          cookie: "console-session=must-not-leak",
        },
        body: "{}",
      }),
      {},
      {
        ...context,
        params: {
          ...context.params,
          controlPlaneOrigin: "https://api.openma.test",
        },
      },
    );

    expect(response.status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalledOnce();
  });

  it("lets the scoped Work client reach every attached resource API family", async () => {
    const forwarded: string[] = [];
    globalThis.fetch = vi.fn(async (request: Request) => {
      forwarded.push(new URL(request.url).pathname);
      return new Response("ok");
    });
    const boundContext = {
      ...context,
      params: {
        ...context.params,
        controlPlaneOrigin: "https://api.openma.test",
      },
    };

    for (const path of [
      "/v1/sessions/session-1",
      "/v1/sessions/session-1/events",
      "/v1/skills/skill-1/versions",
      "/v1/skills/skill-1/versions/1759178010641129/content",
      "/v1/memory_stores/memory-store-1/memories",
      "/v1/files/file-1",
      "/v1/files/file-1/content",
    ]) {
      const response = await handleOpenmaControlPlaneRequest(
        new Request(`https://api.openma.test${path}`, {
          headers: { authorization: "Bearer sk-ant-req-v1.current" },
        }),
        {},
        boundContext,
      );
      expect(response.status, path).toBe(200);
    }

    expect(forwarded).toEqual([
      "/v1/sessions/session-1",
      "/v1/sessions/session-1/events",
      "/v1/skills/skill-1/versions",
      "/v1/skills/skill-1/versions/1759178010641129/content",
      "/v1/memory_stores/memory-store-1/memories",
      "/v1/files/file-1",
      "/v1/files/file-1/content",
    ]);
  });

  it("rejects a Work capability sent to another origin or unrelated path", async () => {
    globalThis.fetch = vi.fn(async () => new Response("unexpected"));
    const wrongOrigin = await handleOpenmaControlPlaneRequest(
      new Request("https://attacker.test/v1/oma/mcp-proxy/session-1/linear", {
        headers: { authorization: "Bearer sk-ant-req-v1.current" },
      }),
      {},
      { ...context, params: { ...context.params, controlPlaneOrigin: "https://api.openma.test" } },
    );
    const wrongPath = await handleOpenmaControlPlaneRequest(
      new Request("https://api.openma.test/collect", {
        headers: { authorization: "Bearer sk-ant-req-v1.current" },
      }),
      {},
      { ...context, params: { ...context.params, controlPlaneOrigin: "https://api.openma.test" } },
    );

    expect(wrongOrigin.status).toBe(403);
    expect(wrongPath.status).toBe(403);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("refuses a required binding when the credential control plane is absent", async () => {
    const sandbox = new CloudflareSandbox({ SANDBOX: {} } as any, "session-1") as any;
    sandbox.sandboxPromise = Promise.resolve({
      setOutboundHandler: vi.fn(async () => undefined),
      setOutboundByHost: vi.fn(async () => undefined),
    });

    await expect(sandbox.setOutboundContext({
      tenantId: "tenant-1",
      environmentId: "environment-1",
      sessionId: "session-1",
      workId: "work-1",
      required: true,
      controlPlaneBaseUrl: "https://api.openma.test",
    })).rejects.toThrow("MAIN_MCP");
  });
});
