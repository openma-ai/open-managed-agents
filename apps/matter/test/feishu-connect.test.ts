import { feishuAgentSetup } from "@openma/matter-feishu/bond";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createFeishuConnectHandler,
  FeishuConnectService,
  memoryRegistrationStore,
  type FeishuConnection,
  type RegisteredFeishuApp,
  trustedProxyPrincipal,
} from "../src/feishu-connect.js";

/** A stand-in for accounts.feishu.cn and open.feishu.cn. */
class FakeFeishu {
  polls: { status: number; body: unknown }[] = [];
  beginStatus = 200;
  granted: readonly string[] = feishuAgentSetup().requirements.scopes;
  readonly calls: string[] = [];

  readonly fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    this.calls.push(`${url.host}${url.pathname}`);
    const reply = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (url.pathname === "/oauth/v1/app/registration") {
      const action = new URLSearchParams(String(init?.body)).get("action");
      if (action === "begin") {
        return reply(this.beginStatus, {
          device_code: "dc-secret",
          user_code: "UC-1",
          verification_uri: "https://open.feishu.cn/page/launcher",
          verification_uri_complete: "https://open.feishu.cn/page/launcher?user_code=UC-1",
          expires_in: 300,
          interval: 3,
        });
      }
      const next = this.polls.shift() ?? { status: 400, body: { error: "authorization_pending" } };
      return reply(next.status, next.body);
    }
    if (url.pathname === "/open-apis/auth/v3/tenant_access_token/internal") {
      return reply(200, { code: 0, tenant_access_token: "t-test", expire: 7200 });
    }
    if (url.pathname === "/open-apis/application/v6/scopes") {
      return reply(200, {
        code: 0,
        data: { scopes: this.granted.map((scope_name) => ({ scope_name, grant_status: 1 })) },
      });
    }
    if (url.pathname === "/open-apis/application/v6/applications/cli_new") {
      return reply(200, { code: 0, data: { app: { app_id: "cli_new", online_version_id: "oav_1" } } });
    }
    if (url.pathname === "/open-apis/application/v6/applications/cli_new/app_versions/oav_1") {
      return reply(200, {
        code: 0,
        data: {
          app_version: {
            events: feishuAgentSetup().requirements.events,
            ability: { bot: {} },
          },
        },
      });
    }
    if (url.pathname === "/open-apis/bot/v3/info") {
      return reply(200, { code: 0, bot: { open_id: "ou_bot" } });
    }
    return reply(404, {});
  }) as typeof fetch;
}

const REGISTERED = {
  status: 200,
  body: {
    client_id: "cli_new",
    client_secret: "app-secret",
    user_info: { open_id: "ou_confirmer", tenant_brand: "feishu" },
  },
};

const ME = { principal: { tenantId: "t1", userId: "u1" } };

let feishu: FakeFeishu;
let scheduled: { task: () => void; ms: number }[];
let saved: RegisteredFeishuApp[];
let connections: FeishuConnection[];
let clock: number;

const service = (
  options: { onRegistered?: (connection: FeishuConnection) => Promise<void> } = {},
) =>
  new FeishuConnectService({
    onRegistered:
      options.onRegistered ??
      (async (connection) => {
        saved.push(connection.app);
        connections.push(connection);
      }),
    fetch: feishu.fetch,
    schedule: (task, ms) => scheduled.push({ task, ms }),
    now: () => clock,
  });

/** Run the next scheduled poll and wait for it and any follow-up check. */
const tick = async (svc: FeishuConnectService, id: string) => {
  const next = scheduled.shift();
  expect(next).toBeDefined();
  clock += next!.ms;
  await svc.poll(id);
  await new Promise((resolve) => setTimeout(resolve, 0));
};

beforeEach(() => {
  feishu = new FakeFeishu();
  scheduled = [];
  saved = [];
  connections = [];
  clock = Date.now();
});

describe("FeishuConnectService", () => {
  it("shows a QR code, polls in the background and saves the new app", async () => {
    const svc = service();
    const { id, status } = await svc.begin(ME);
    expect(status).toMatchObject({
      status: "pending",
      url: expect.stringContaining("user_code=UC-1"),
    });
    expect(status.status === "pending" && status.qrSvg.startsWith("<svg")).toBe(true);
    expect(JSON.stringify(status)).not.toContain("dc-secret");
    expect(scheduled.map((s) => s.ms)).toEqual([3000]);

    feishu.polls = [
      { status: 400, body: { error: "slow_down" } },
      REGISTERED,
    ];
    await tick(svc, id);
    expect((await svc.status(id, "t1"))?.status).toBe("pending");
    expect(scheduled.map((s) => s.ms)).toEqual([8000]);

    await tick(svc, id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(saved).toEqual([
      {
        appId: "cli_new",
        appSecret: "app-secret",
        brand: "feishu",
        baseUrl: "https://open.feishu.cn",
        openId: "ou_confirmer",
      },
    ]);
    const done = (await svc.status(id, "t1"));
    expect(done).toMatchObject({
      status: "registered",
      appId: "cli_new",
      brand: "feishu",
      setup: { ready: true, problems: [] },
    });
    expect(JSON.stringify(done)).not.toContain("app-secret");
    expect(scheduled).toHaveLength(0);
  });

  it("asks the platform for the agent preset and a new app only", async () => {
    const svc = service();
    const { status } = await svc.begin(ME);
    const url = new URL(status.status === "pending" ? status.url : "");
    expect(url.searchParams.get("createOnly")).toBe("true");
    expect(url.searchParams.get("source")).toBe("openmatter/openma");
    expect(url.searchParams.get("name")).toBe("OpenMA Agent");
    expect(url.searchParams.get("addons")).toBeTruthy();
  });

  it("reports missing setup as fixes", async () => {
    feishu.granted = [];
    const svc = service();
    const { id } = await svc.begin(ME);
    feishu.polls = [REGISTERED];
    await tick(svc, id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const status = (await svc.status(id, "t1"));
    expect(status?.status === "registered" && status.setup?.ready).toBe(false);
    expect(status?.status === "registered" && status.setup?.missingScopes.length).toBeGreaterThan(0);
  });

  it("ends on denial and on expiry without saving", async () => {
    const svc = service();
    const denied = await svc.begin(ME);
    feishu.polls = [{ status: 400, body: { error: "access_denied" } }];
    await tick(svc, denied.id);
    expect((await svc.status(denied.id, "t1"))).toEqual({ status: "denied" });

    const expired = await svc.begin(ME);
    clock += 301_000;
    await tick(svc, expired.id);
    expect((await svc.status(expired.id, "t1"))).toEqual({ status: "expired" });
    expect(saved).toEqual([]);
    expect(scheduled).toHaveLength(0);
  });

  it("keeps polling after a transient platform error", async () => {
    const svc = service();
    const { id } = await svc.begin(ME);
    feishu.polls = [{ status: 500, body: {} }, REGISTERED];
    await tick(svc, id);
    expect((await svc.status(id, "t1"))?.status).toBe("pending");
    expect(scheduled).toHaveLength(1);
    await tick(svc, id);
    expect((await svc.status(id, "t1"))?.status).toBe("registered");
  });

  it("hands the host the tenant, user and chosen Agent with the app", async () => {
    const svc = service();
    const { id } = await svc.begin({ ...ME, agentId: "agent_1" });
    feishu.polls = [REGISTERED];
    await tick(svc, id);
    expect(connections).toEqual([
      { app: saved[0], tenantId: "t1", userId: "u1", agentId: "agent_1" },
    ]);
  });

  it("hides a registration from other tenants", async () => {
    const svc = service();
    const { id } = await svc.begin(ME);
    expect((await svc.status(id, "t1"))?.status).toBe("pending");
    expect((await svc.status(id, "t2"))).toBeUndefined();
  });

  it("reports a failure when the host cannot save the app", async () => {
    const svc = service({
      onRegistered: async () => {
        throw new Error("disk full");
      },
    });
    const { id } = await svc.begin(ME);
    feishu.polls = [REGISTERED];
    await tick(svc, id);
    expect((await svc.status(id, "t1"))).toMatchObject({ status: "failed" });
    expect(JSON.stringify((await svc.status(id, "t1")))).not.toContain("disk full");
  });

  it("lets another replica take over a poll its starter abandoned", async () => {
    const store = memoryRegistrationStore();
    const make = (ownerId: string) =>
      new FeishuConnectService({
        onRegistered: async (connection) => {
          saved.push(connection.app);
        },
        store,
        ownerId,
        leaseMs: 30_000,
        fetch: feishu.fetch,
        schedule: (task, ms) => scheduled.push({ task, ms }),
        now: () => clock,
      });
    const first = make("replica-a");
    const second = make("replica-b");
    const { id } = await first.begin(ME);
    // Replica B reads the status the browser asks for.
    expect((await second.status(id, "t1"))?.status).toBe("pending");
    // Not due yet: nobody polls.
    await second.sweep();
    expect(feishu.calls.filter((c) => c.endsWith("/oauth/v1/app/registration"))).toHaveLength(1);
    // Replica A takes the poll and dies holding it.
    clock += 3_000;
    expect(await store.claim(id, "replica-a", clock, clock + 30_000)).toBeDefined();
    feishu.polls = [REGISTERED];
    await second.sweep();
    expect(saved).toHaveLength(0);
    // Its lease runs out; replica B polls and saves the app.
    clock += 30_000;
    await second.sweep();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(saved.map((app) => app.appId)).toEqual(["cli_new"]);
    expect((await first.status(id, "t1"))?.status).toBe("registered");
  });

  it("marks the setup check unavailable when it cannot run", async () => {
    // Registration works; every Open Platform call afterwards fails.
    const offline = (async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes("/open-apis/")
        ? Promise.reject(new Error("offline"))
        : feishu.fetch(input, init)) as typeof fetch;
    const svc = new FeishuConnectService({
      onRegistered: async (connection) => {
        saved.push(connection.app);
      },
      fetch: offline,
      schedule: (task, ms) => scheduled.push({ task, ms }),
      now: () => clock,
    });
    const { id } = await svc.begin(ME);
    feishu.polls = [REGISTERED];
    await tick(svc, id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(saved).toHaveLength(1);
    expect((await svc.status(id, "t1"))).toMatchObject({ status: "registered", setupUnavailable: true });
  });
});

describe("createFeishuConnectHandler", () => {
  const request = (path: string, init?: RequestInit) =>
    new Request(`https://matter.test${path}`, init);

  it("serves the page, starts a registration and reports its status", async () => {
    const svc = service();
    const handler = createFeishuConnectHandler({ service: svc, authorize: async () => ({ tenantId: "t1" }) });
    const page = await handler(request("/connect/feishu"));
    expect(page?.status).toBe(200);
    expect(page?.headers.get("content-type")).toContain("text/html");
    expect(page?.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = (await page?.text()) ?? "";
    expect(html).toContain('const base = "/connect/feishu"');
    expect(html).toContain('<html lang="en">');
    const zh = await handler(
      request("/connect/feishu", { headers: { "accept-language": "zh-CN,zh;q=0.9,en;q=0.8" } }),
    );
    const zhHtml = (await zh?.text()) ?? "";
    expect(zhHtml).toContain('<html lang="zh-CN">');
    expect(zhHtml).toContain("连接飞书");

    const started = await handler(request("/connect/feishu/registrations", { method: "POST" }));
    expect(started?.status).toBe(201);
    const body = (await started?.json()) as { id: string; status: { status: string } };
    expect(body.status.status).toBe("pending");

    const status = await handler(request(`/connect/feishu/registrations/${body.id}`));
    expect(((await status?.json()) as { status: string }).status).toBe("pending");
    expect((await handler(request("/connect/feishu/registrations/nope")))?.status).toBe(404);
  });

  it("refuses unauthorized callers and ignores other paths", async () => {
    const handler = createFeishuConnectHandler({ service: service(), authorize: async () => null });
    expect((await handler(request("/connect/feishu")))?.status).toBe(401);
    expect((await handler(request("/connect/feishu/registrations", { method: "POST" })))?.status).toBe(401);
    expect(await handler(request("/mcp"))).toBeUndefined();
    expect(await handler(request("/connect/feishuX"))).toBeUndefined();
  });

  it("passes the chosen Agent through and rejects a bad one", async () => {
    const svc = service();
    const handler = createFeishuConnectHandler({
      service: svc,
      authorize: async () => ({ tenantId: "t1" }),
    });
    const post = (body: string) =>
      handler(
        request("/connect/feishu/registrations", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        }),
      );
    expect((await post(JSON.stringify({ agentId: "" })))?.status).toBe(400);
    expect((await post(JSON.stringify({ agentId: 7 })))?.status).toBe(400);
    const started = await post(JSON.stringify({ agentId: "agent_1" }));
    expect(started?.status).toBe(201);
    const { id } = (await started?.json()) as { id: string };
    feishu.polls = [REGISTERED];
    await tick(svc, id);
    expect(connections).toEqual([{ app: saved[0], tenantId: "t1", agentId: "agent_1" }]);
  });

  it("keeps one tenant's registration from another", async () => {
    let tenantId = "t1";
    const handler = createFeishuConnectHandler({
      service: service(),
      authorize: async () => ({ tenantId }),
    });
    const started = await handler(request("/connect/feishu/registrations", { method: "POST" }));
    const { id } = (await started?.json()) as { id: string };
    tenantId = "t2";
    expect((await handler(request(`/connect/feishu/registrations/${id}`)))?.status).toBe(404);
    tenantId = "t1";
    expect((await handler(request(`/connect/feishu/registrations/${id}`)))?.status).toBe(200);
  });

  it("reports a failed start as a bad gateway", async () => {
    feishu.beginStatus = 500;
    const handler = createFeishuConnectHandler({ service: service(), authorize: async () => ({ tenantId: "t1" }) });
    const response = await handler(request("/connect/feishu/registrations", { method: "POST" }));
    expect(response?.status).toBe(502);
  });
});

describe("trustedProxyPrincipal", () => {
  const authorize = trustedProxyPrincipal("proxy-secret");
  const withHeaders = (headers: Record<string, string>) =>
    authorize(new Request("https://matter.test/connect/feishu", { headers }));

  it("trusts the tenant and user only with the shared secret", async () => {
    expect(
      await withHeaders({
        "x-matter-proxy-secret": "proxy-secret",
        "x-oma-tenant-id": "t1",
        "x-oma-user-id": "u1",
      }),
    ).toEqual({ tenantId: "t1", userId: "u1" });
    expect(
      await withHeaders({ "x-matter-proxy-secret": "proxy-secret", "x-oma-tenant-id": "t1" }),
    ).toEqual({ tenantId: "t1" });
    expect(await withHeaders({ "x-matter-proxy-secret": "wrong", "x-oma-tenant-id": "t1" })).toBeNull();
    expect(await withHeaders({ "x-oma-tenant-id": "t1" })).toBeNull();
    expect(await withHeaders({ "x-matter-proxy-secret": "proxy-secret" })).toBeNull();
    expect(
      await withHeaders({ "x-matter-proxy-secret": "proxy-secret", "x-oma-tenant-id": "" }),
    ).toBeNull();
  });

  it("refuses everyone when no secret is configured", async () => {
    const open = trustedProxyPrincipal("");
    expect(
      await open(
        new Request("https://matter.test/", {
          headers: { "x-matter-proxy-secret": "", "x-oma-tenant-id": "t1" },
        }),
      ),
    ).toBeNull();
  });
});
