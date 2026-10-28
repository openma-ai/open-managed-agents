// /matter/* → the OpenMatter service: identity comes from the control plane,
// never from the caller.

import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadNodeConfig } from "../src/config";
import { createNodeControlPlane, type NodeControlPlane } from "../src/control-plane";
import { nodeDefaults } from "../src/components";
import { buildMatterProxyRoutes, buildMatterWebhookRoutes, matterTrustedAuth } from "../../../packages/control-plane-node/src/lib/matter-proxy";
import { matterRepositoryCredentials } from "../../../packages/control-plane-node/src/lib/matter-repository-credentials";

const created: NodeControlPlane[] = [];
const servers: Server[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((cp) => cp.stop("test")));
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const signedIn = (vars: { tenant_id: string; user_id?: string }, fetcher: typeof fetch) => {
  const app = new Hono<{ Variables: { tenant_id: string; user_id?: string } }>();
  app.use("*", async (c, next) => {
    c.set("tenant_id", vars.tenant_id);
    if (vars.user_id) c.set("user_id", vars.user_id);
    await next();
  });
  app.route("/matter", buildMatterProxyRoutes({ url: "http://matter.internal/base", proxySecret: "s3cret", fetcher }));
  return app;
};

describe("buildMatterProxyRoutes", () => {
  it("strips the prefix, swaps the caller's credentials for trusted identity headers", async () => {
    const upstream = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      expect(req.url).toBe("http://matter.internal/base/connect/feishu/registrations?x=1");
      expect(req.method).toBe("POST");
      expect(await req.text()).toBe('{"agentId":"agent_1"}');
      expect(req.headers.get("content-type")).toBe("application/json");
      expect(req.headers.get("x-matter-proxy-secret")).toBe("s3cret");
      expect(req.headers.get("x-oma-tenant-id")).toBe("tn_1");
      expect(req.headers.get("x-oma-user-id")).toBe("usr_1");
      for (const name of ["cookie", "authorization", "x-api-key", "x-active-tenant"]) {
        expect(req.headers.has(name)).toBe(false);
      }
      return new Response('{"id":"r1"}', {
        status: 201,
        headers: { "content-type": "application/json", "set-cookie": "matter=1" },
      });
    });
    const app = signedIn({ tenant_id: "tn_1", user_id: "usr_1" }, upstream as typeof fetch);
    const res = await app.request("/matter/connect/feishu/registrations?x=1", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "session=abc",
        authorization: "Bearer user-token",
        "x-api-key": "oma_key",
        "x-active-tenant": "tn_1",
        // A caller cannot pick its own identity or guess the secret through.
        "x-oma-tenant-id": "tn_other",
        "x-oma-user-id": "usr_other",
        "x-matter-proxy-secret": "guess",
      },
      body: '{"agentId":"agent_1"}',
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: "r1" });
    expect(res.headers.has("set-cookie")).toBe(false);
    expect(upstream).toHaveBeenCalledOnce();
  });

  it("sends no user header for tenant-only callers and maps an unreachable Matter to 502", async () => {
    const seen: Request[] = [];
    const ok = signedIn({ tenant_id: "tn_1" }, (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Request(input, init));
      return new Response("{}", { headers: { "content-type": "application/json" } });
    }) as typeof fetch);
    const spoofed = await ok.request("/matter/connect/feishu/registrations/r1", {
      headers: { "x-oma-user-id": "usr_other" },
    });
    expect(spoofed.status).toBe(200);
    expect(seen[0]?.headers.has("x-oma-user-id")).toBe(false);
    expect(seen[0]?.url).toBe("http://matter.internal/base/connect/feishu/registrations/r1");

    const down = signedIn({ tenant_id: "tn_1" }, (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch);
    const res = await down.request("/matter/connect/feishu");
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "matter_unavailable" });
  });
});

describe("Matter internal routes", () => {
  it("are never reachable through the Console proxy, whatever the spelling", async () => {
    const upstream = vi.fn(async () => new Response('{"token":"leak"}'));
    const app = signedIn({ tenant_id: "tn_1", user_id: "usr_1" }, upstream as unknown as typeof fetch);
    for (const path of ["/matter/internal/repository-credential", "/matter/internal", "/matter/INTERNAL/x",
      "/matter/x/../internal/repository-credential", "/matter/%2e%2e/internal/repository-credential"]) {
      const res = await app.request(path, { method: "POST", headers: { "x-matter-internal-secret": "s3cret" } });
      expect(res.status, path).toBe(404);
    }
    expect(upstream).not.toHaveBeenCalled();
    // A caller's own copy of the internal header is dropped on other routes.
    const seen: Request[] = [];
    const ok = signedIn({ tenant_id: "tn_1" }, (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Request(input, init));
      return new Response("{}");
    }) as typeof fetch);
    await ok.request("/matter/loops", { headers: { "x-matter-internal-secret": "guess" } });
    expect(seen[0]?.headers.has("x-matter-internal-secret")).toBe(false);
  });

  it("asks Matter for a repository's Bond token with the internal secret and passes errors on", async () => {
    const seen: Request[] = [];
    const credentials = matterRepositoryCredentials({
      url: "http://matter.internal",
      proxySecret: "s3cret",
      fetcher: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(input, init);
        seen.push(req);
        const body = (await req.json()) as { url: string };
        return body.url.includes("missing")
          ? Response.json({ error: "No GitLab Bond of this workspace serves gitlab.example.com" }, { status: 404 })
          : Response.json({ token: "glpat-bond" });
      }) as typeof fetch,
    });
    await expect(credentials.repositoryToken({ workspaceId: "tn_1", url: "https://gitlab.example.com/g/app.git" }))
      .resolves.toBe("glpat-bond");
    expect(seen[0]?.url).toBe("http://matter.internal/internal/repository-credential");
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.headers.get("x-matter-internal-secret")).toBe("s3cret");
    expect(seen[0]?.headers.get("x-oma-tenant-id")).toBe("tn_1");
    expect(seen[0]?.headers.has("x-matter-proxy-secret")).toBe(false);
    await expect(credentials.repositoryToken({ workspaceId: "tn_1", url: "https://gitlab.example.com/g/missing.git" }))
      .rejects.toThrow("No Bond credential for repository https://gitlab.example.com/g/missing.git: No GitLab Bond of this workspace serves gitlab.example.com");
    const down = matterRepositoryCredentials({ url: "http://matter.internal", proxySecret: "s3cret",
      fetcher: (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch });
    await expect(down.repositoryToken({ workspaceId: "tn_1", url: "https://x/y.git" })).rejects.toThrow(/could not be reached/);
  });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function boot(env: Record<string, string>, { auth = false } = {}) {
  const dir = tempDir("oma-matter-cp-");
  const config = loadNodeConfig({
    NODE_ENV: "test",
    ...(auth ? { BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret" } : { AUTH_DISABLED: "1" }),
    OPENMA_TEST_SANDBOX_PROVIDER: "local-subprocess",
    MEMORY_QUEUE: "disabled",
    DATABASE_PATH: join(dir, "oma.db"),
    AUTH_DATABASE_PATH: join(dir, "auth.db"),
    SANDBOX_WORKDIR: join(dir, "sandboxes"),
    MEMORY_BLOB_DIR: join(dir, "memories"),
    FILES_BLOB_DIR: join(dir, "files"),
    SESSION_OUTPUTS_DIR: join(dir, "outputs"),
    ANTHROPIC_API_KEY: "unused",
    ...env,
  });
  const cp = await createNodeControlPlane(await nodeDefaults(config));
  created.push(cp);
  return cp;
}

async function fakeMatter(): Promise<{ url: string; seen: { url?: string; headers: Record<string, unknown> }[] }> {
  const seen: { url?: string; headers: Record<string, unknown> }[] = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"status":"pending"}');
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return { url: `http://127.0.0.1:${address.port}`, seen };
}

describe("control plane /matter mount", () => {
  it("answers JSON 404 when Matter is not configured, even with the Console served", async () => {
    const consoleDir = tempDir("oma-console-");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(consoleDir, "index.html"), "<!DOCTYPE html><html></html>");
    const cp = await boot({ CONSOLE_DIR: consoleDir });
    const res = await cp.fetch(new Request("http://localhost/matter/connect/feishu/registrations/r1"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "matter_not_configured" });
  });

  it("lets only signed-in callers through", async () => {
    const matter = await fakeMatter();
    const cp = await boot({ MATTER_URL: matter.url, MATTER_PROXY_SECRET: "s3cret" }, { auth: true });
    const res = await cp.fetch(new Request("http://localhost/matter/connect/feishu/registrations", { method: "POST" }));
    expect(res.status).toBe(401);
    expect(matter.seen).toHaveLength(0);
  });

  it("forwards to MATTER_URL with the resolved tenant", async () => {
    const matter = await fakeMatter();
    const cp = await boot({ MATTER_URL: matter.url, MATTER_PROXY_SECRET: "s3cret" });
    const res = await cp.fetch(new Request("http://localhost/matter/connect/feishu/registrations/r1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "pending" });
    expect(matter.seen).toHaveLength(1);
    expect(matter.seen[0]?.url).toBe("/connect/feishu/registrations/r1");
    expect(matter.seen[0]?.headers["x-matter-proxy-secret"]).toBe("s3cret");
    expect(matter.seen[0]?.headers["x-oma-tenant-id"]).toEqual(expect.any(String));
  });
});

describe("MATTER_* config", () => {
  const base = { NODE_ENV: "test", ANTHROPIC_API_KEY: "unused" };
  it("needs a secret and an http(s) URL", () => {
    expect(() => loadNodeConfig({ ...base, MATTER_URL: "http://matter:4720" })).toThrow(/MATTER_PROXY_SECRET is required/);
    expect(() => loadNodeConfig({ ...base, MATTER_URL: "matter:4720/x y", MATTER_PROXY_SECRET: "s" })).toThrow(/absolute http\(s\) URL/);
    expect(() => loadNodeConfig({ ...base, MATTER_URL: "not a url", MATTER_PROXY_SECRET: "s" })).toThrow(/absolute http\(s\) URL/);
    expect(loadNodeConfig({ ...base, MATTER_URL: "http://matter:4720/", MATTER_PROXY_SECRET: "s" }).http.matter).toEqual({
      url: "http://matter:4720",
      proxySecret: "s",
    });
    expect(loadNodeConfig(base).http.matter).toBeUndefined();
  });
});

describe("matterTrustedAuth", () => {
  const app = () => {
    const a = new Hono<{ Variables: { tenant_id: string; user_id?: string } }>();
    a.use("*", matterTrustedAuth("s3cret", async (c) => c.json({ fallback: true }, 401)));
    a.get("/v1/agents", (c) => c.json({ tenant: c.var.tenant_id }));
    return a;
  };

  it("lets Matter act in the workspace it names with the shared secret", async () => {
    const res = await app().request("/v1/agents", {
      headers: { "x-matter-proxy-secret": "s3cret", "x-oma-tenant-id": "tn_7" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tenant: "tn_7" });
  });

  it("refuses a wrong secret or a missing tenant, and leaves other requests to the normal auth", async () => {
    expect((await app().request("/v1/agents", { headers: { "x-matter-proxy-secret": "nope", "x-oma-tenant-id": "tn_7" } })).status).toBe(401);
    expect((await app().request("/v1/agents", { headers: { "x-matter-proxy-secret": "s3cret" } })).status).toBe(401);
    const plain = await app().request("/v1/agents", { headers: { "x-oma-tenant-id": "tn_7" } });
    expect(await plain.json()).toEqual({ fallback: true });
  });
});

describe("buildMatterWebhookRoutes", () => {
  it("forwards GitLab webhooks to Matter without credentials or trust headers", async () => {
    const upstream = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      expect(req.url).toBe("http://matter.internal/base/webhooks/gitlab/gitlab-1");
      expect(req.headers.get("x-gitlab-token")).toBe("hook-secret");
      expect(req.headers.get("x-gitlab-event")).toBe("Note Hook");
      for (const name of ["cookie", "authorization", "x-matter-proxy-secret", "x-oma-tenant-id"]) {
        expect(req.headers.has(name)).toBe(false);
      }
      expect(await req.text()).toBe('{"object_kind":"note"}');
      return new Response(null, { status: 202 });
    });
    const app = new Hono();
    app.route("/webhooks/gitlab", buildMatterWebhookRoutes({ url: "http://matter.internal/base", proxySecret: "s3cret", fetcher: upstream as typeof fetch }));
    const res = await app.request("/webhooks/gitlab/gitlab-1", {
      method: "POST",
      headers: {
        "x-gitlab-token": "hook-secret",
        "x-gitlab-event": "Note Hook",
        cookie: "session=1",
        "x-matter-proxy-secret": "forged",
        "x-oma-tenant-id": "tn_other",
      },
      body: '{"object_kind":"note"}',
    });
    expect(res.status).toBe(202);
    expect(upstream).toHaveBeenCalledOnce();
  });
});
