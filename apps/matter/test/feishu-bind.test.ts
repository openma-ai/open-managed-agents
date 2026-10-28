import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { feishuAgentSetup } from "@openma/matter-feishu/bond";
import type { FeishuWsClient, FeishuWsClientParams } from "@openma/matter-feishu/long-connection";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createMatterService,
  loadMatterConfig,
  type MatterConfig,
  type MatterService,
} from "../src/server.js";
import { FakeOma } from "./fake-oma.js";

const APP_ID = "cli_a1b2c3d4e5f60718";
const SECRET = "existing-app-secret";
const ROTATED = "rotated-app-secret";
const TAKEN = "This app is linked in another workspace; unlink it there first";

class FakeWsClient implements FeishuWsClient {
  constructor(readonly params: FeishuWsClientParams) {}
  async start() {
    this.params.onReady();
  }
  close() {}
}

/** open.feishu.cn and open.larksuite.com: tenant tokens for the app's
 * current secret, and the setup check (one scope missing). */
class FakeFeishu {
  secret = SECRET;
  down = false;
  readonly hosts: string[] = [];
  readonly fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    this.hosts.push(url.host);
    if (this.down) throw new TypeError("fetch failed");
    const reply = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/open-apis/auth/v3/tenant_access_token/internal") {
      const body = JSON.parse(String(init?.body)) as { app_id: string; app_secret: string };
      return body.app_id === APP_ID && body.app_secret === this.secret
        ? reply({ code: 0, tenant_access_token: "t-tenant", expire: 7200 })
        : reply({ code: 10014, msg: "app secret invalid" });
    }
    if (url.pathname === "/open-apis/application/v6/scopes") {
      const [, ...granted] = feishuAgentSetup().requirements.scopes;
      return reply({ code: 0, data: { scopes: granted.map((scope_name) => ({ scope_name, grant_status: 1 })) } });
    }
    if (url.pathname === `/open-apis/application/v6/applications/${APP_ID}`) {
      return reply({ code: 0, data: { app: { app_id: APP_ID, online_version_id: "oav_1" } } });
    }
    if (url.pathname === `/open-apis/application/v6/applications/${APP_ID}/app_versions/oav_1`) {
      return reply({
        code: 0,
        data: { app_version: { events: feishuAgentSetup().requirements.events, ability: { bot: {} } } },
      });
    }
    if (url.pathname === "/open-apis/bot/v3/info") return reply({ code: 0, bot: { open_id: "ou_bot" } });
    return reply({ code: 0, data: {} });
  }) as typeof fetch;
}

let dir: string;
let oma: FakeOma;
let feishu: FakeFeishu;
let ws: FakeWsClient[];
let services: MatterService[];
let config: MatterConfig;

const start = async () => {
  const service = await createMatterService(config, {
    omaFetch: oma.fetch as typeof fetch,
    fetch: feishu.fetch,
    feishuConnectFetch: feishu.fetch,
    createWsClient: (params) => {
      const client = new FakeWsClient(params);
      ws.push(client);
      return client;
    },
    onError: () => {},
  });
  services.push(service);
  return service;
};

const as = (tenantId: string) => ({
  "x-matter-proxy-secret": "proxy-secret",
  "x-oma-tenant-id": tenantId,
  "x-oma-user-id": "usr_1",
});

const call = (service: MatterService, method: string, path: string, body?: unknown, tenantId = "tn_a") =>
  service.fetch(
    new Request(`https://matter.test${path}`, {
      method,
      headers: { ...as(tenantId), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

const link = (service: MatterService, body: Record<string, unknown>, tenantId = "tn_a") =>
  call(service, "POST", "/connect/feishu/app", { appId: APP_ID, appSecret: SECRET, brand: "feishu", ...body }, tenantId);

const problem = async (response: Response) => [response.status, ((await response.json()) as { error: string }).error];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "matter-feishu-bind-"));
  oma = new FakeOma();
  // Two workspaces through the trusted headers, no API key.
  oma.trustSecret = "proxy-secret";
  oma.environments = [{ id: "env_ws" }];
  oma.agents.set("agent-1", { id: "agent-1", version: 1, mcp_servers: [], tools: [] });
  feishu = new FakeFeishu();
  ws = [];
  services = [];
  config = loadMatterConfig({
    MATTER_DATA_DIR: dir,
    MATTER_PROXY_SECRET: "proxy-secret",
    MATTER_SECRET_KEY: "a-long-enough-secret-key",
    OMA_URL: "https://oma.test",
    MATTER_MCP_URL: "https://matter.test/mcp",
  });
});

afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("linking an existing Feishu app", () => {
  it("checks the credentials, saves the app like a scanned one and reports its setup", async () => {
    const service = await start();
    const linked = await link(service, { appId: ` ${APP_ID} ` });
    expect(linked.status).toBe(200);
    const text = await linked.text();
    expect(text).not.toContain(SECRET);
    const result = JSON.parse(text) as Record<string, unknown>;
    expect(result).toMatchObject({
      status: "registered",
      appId: APP_ID,
      brand: "feishu",
      setup: { ready: false, missingScopes: [feishuAgentSetup().requirements.scopes[0]] },
    });
    expect((result.setup as { links?: { scopes?: string } }).links?.scopes).toContain(APP_ID);

    expect(await service.db.apps.get(APP_ID)).toMatchObject({
      appId: APP_ID,
      appSecret: SECRET,
      brand: "feishu",
      baseUrl: "https://open.feishu.cn",
      tenantId: "tn_a",
      userId: "usr_1",
      botOpenId: "ou_bot",
    });
    expect(readFileSync(join(dir, "matter.sqlite")).toString("latin1")).not.toContain(SECRET);
    const bonds = await (await call(service, "GET", "/bonds")).text();
    expect(JSON.parse(bonds)).toMatchObject({ data: [{ id: `feishu:${APP_ID}`, setup: { ready: false } }] });
    expect(bonds).not.toContain(SECRET);
  });

  it("asks Lark for a Lark app", async () => {
    const service = await start();
    const linked = await link(service, { brand: "lark" });
    expect(linked.status).toBe(200);
    expect(feishu.hosts[0]).toBe("open.larksuite.com");
    expect(await service.db.apps.get(APP_ID)).toMatchObject({ brand: "lark", baseUrl: "https://open.larksuite.com" });
  });

  it("refuses wrong credentials, an unreachable Feishu and bad requests without saving", async () => {
    const service = await start();
    expect(await problem(await link(service, { appSecret: "wrong" }))).toEqual([400, "Feishu rejected the App ID or App Secret"]);
    feishu.down = true;
    expect(await problem(await link(service, {}))).toEqual([502, "Feishu could not be reached"]);
    feishu.down = false;
    expect(await problem(await link(service, { appId: "" }))).toEqual([400, expect.stringContaining("appId")]);
    expect(await problem(await link(service, { appId: "../x" }))).toEqual([400, expect.stringContaining("appId")]);
    expect(await problem(await link(service, { appId: "cli_short" }))).toEqual([400, expect.stringContaining("appId")]);
    expect(await problem(await link(service, { appSecret: " " }))).toEqual([400, "appSecret is required"]);
    expect(await problem(await link(service, { brand: "slack" }))).toEqual([400, "brand must be feishu or lark"]);
    expect(await service.db.apps.list()).toEqual([]);
    expect(service.host.running()).toEqual([]);
  });

  it("never takes over another workspace's app", async () => {
    const service = await start();
    expect((await link(service, {}, "tn_a")).status).toBe(200);
    // Workspace B has the right secret too: still refused, A's Bond untouched.
    expect(await problem(await link(service, {}, "tn_b"))).toEqual([409, TAKEN]);
    feishu.secret = ROTATED;
    expect(await problem(await link(service, { appSecret: ROTATED }, "tn_b"))).toEqual([409, TAKEN]);
    // Without the secret B does not even learn the app is linked.
    expect(await problem(await link(service, { appSecret: "wrong" }, "tn_b"))).toEqual([400, expect.stringContaining("rejected")]);
    expect(await service.db.apps.get(APP_ID)).toMatchObject({ tenantId: "tn_a", appSecret: SECRET });
    expect(((await (await call(service, "GET", "/bonds", undefined, "tn_b")).json()) as { data: unknown[] }).data).toEqual([]);

    // The database itself does not move the app either.
    const saved = await service.db.apps.save({
      app: { appId: APP_ID, appSecret: "x", brand: "feishu", baseUrl: "https://open.feishu.cn" },
      tenantId: "tn_b",
    });
    expect(saved).toMatchObject({ tenantId: "tn_a", appSecret: SECRET });
  });

  it("replaces the secret of the workspace's own app in place, keeping its Loops", async () => {
    const service = await start();
    expect((await link(service, {})).status).toBe(200);
    const loop = await call(service, "POST", "/loops", {
      template: "feishu-agent",
      config: { bond: `feishu:${APP_ID}`, agentId: "agent-1" },
    });
    expect(loop.status).toBe(201);
    const { id: loopId } = (await loop.json()) as { id: string };
    expect(service.host.running()).toEqual([APP_ID]);
    const started = ws.length;
    expect(ws.at(-1)?.params.appSecret).toBe(SECRET);

    // The secret was reset in the developer console.
    feishu.secret = ROTATED;
    expect(await problem(await link(service, {}))).toEqual([400, "Feishu rejected the App ID or App Secret"]);
    const replaced = await link(service, { appSecret: ROTATED });
    expect(replaced.status).toBe(200);
    expect(await replaced.text()).not.toContain(ROTATED);

    expect(await service.db.apps.list()).toHaveLength(1);
    expect(await service.db.apps.get(APP_ID)).toMatchObject({ tenantId: "tn_a", appSecret: ROTATED });
    expect((await service.db.loops.listForBond("feishu", APP_ID)).map((l) => l.id)).toEqual([loopId]);
    // The connection started again with the new secret.
    expect(ws.length).toBeGreaterThan(started);
    expect(ws.at(-1)?.params.appSecret).toBe(ROTATED);
    expect(service.host.running()).toEqual([APP_ID]);
  });
});
