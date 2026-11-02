import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";

import { I18nProvider } from "../i18n";
import { BondDetailPage, BondLinkPage, BondsPage } from "./Bonds";

const managedApi = {
  agents: { list: vi.fn(async () => ({ data: [{ id: "agent-1", name: "Helpdesk" }] })) },
};
vi.mock("../lib/useManagedApi", () => ({ useManagedApi: () => managedApi }));

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const feishuTemplate = {
  id: "feishu-agent",
  version: "1",
  provider: "feishu",
  description: "Answer in Feishu",
  configSchema: {
    properties: {
      bond: { type: "string", title: "Runs on", "x-oma-widget": "bond", "x-bond-provider": "feishu" },
      agentId: { type: "string", title: "Agent", "x-oma-widget": "agent" },
      acknowledge: { type: "string", title: "Acknowledge" },
    },
    required: ["bond", "agentId"],
  },
};

const bond = {
  id: "feishu:cli_old",
  provider: "feishu",
  label: "Old bot",
  connectedAt: "2026-01-01T00:00:00Z",
  running: true,
  loops: 1,
  setup: { ready: false, problems: ["Add im:resource"], links: { scopes: "https://open.feishu.cn/scopes" } },
  details: {},
};

const loop = {
  id: "loop-1",
  template: "feishu-agent",
  provider: "feishu",
  config: { bond: "feishu:cli_old", agentId: "agent-1" },
  enabled: true,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  state: { running: true },
};

type Handler = (init?: RequestInit) => Response;
let calls: { method: string; url: string; body?: unknown }[];
let routes: Record<string, Handler>;

beforeEach(() => {
  calls = [];
  routes = {
    "GET /matter/loop-templates": () => json(200, { data: [feishuTemplate] }),
    "GET /matter/loops": () => json(200, { data: [loop] }),
    "GET /matter/bonds": () => json(200, { data: [bond] }),
  };
  localStorage.clear();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return routes[`${method} ${url}`]?.(init) ?? json(500, {});
    }),
  );
  vi.stubGlobal("confirm", () => true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const open = (path = "/bonds") =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <I18nProvider>
        <Routes>
          <Route path="/bonds" element={<BondsPage />} />
          <Route path="/bonds/new" element={<BondLinkPage />} />
          <Route path="/bonds/:id" element={<BondDetailPage />} />
        </Routes>
      </I18nProvider>
    </MemoryRouter>,
  );

const spare = { ...bond, id: "gitlab:gitlab-1", provider: "gitlab", label: "bot@gitlab.example", loops: 0, setup: undefined, details: { baseUrl: "https://gitlab.example" } };

describe("BondsPage", () => {
  it("lists linked apps with their Loops and setup state", async () => {
    routes["GET /matter/bonds"] = () => json(200, { data: [bond, spare] });
    open();
    expect(await screen.findByText("Old bot")).toBeTruthy();
    expect(screen.getByText("bot@gitlab.example")).toBeTruthy();
    expect(screen.getByText(/^(Needs setup|待配置)$/)).toBeTruthy();
  });

  it("shows an app with its quick links and Loops, and does not unlink it while Loops run on it", async () => {
    open();
    fireEvent.click(await screen.findByText("Old bot"));
    expect(await screen.findByText("Add im:resource")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Apply for scopes|申请权限/ }).getAttribute("href")).toBe("https://open.feishu.cn/scopes");
    expect(screen.getAllByText(/^(Feishu bot|飞书机器人)$/).length).toBeGreaterThan(0);
    expect((screen.getByRole("button", { name: /^(Delete|删除)$/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("unlinks an app no Loop runs on", async () => {
    routes["GET /matter/bonds"] = () => json(200, { data: [spare] });
    routes["GET /matter/loops"] = () => json(200, { data: [] });
    routes["DELETE /matter/bonds/gitlab%3Agitlab-1"] = () => {
      routes["GET /matter/bonds"] = () => json(200, { data: [] });
      return new Response(null, { status: 204 });
    };
    open();
    fireEvent.click(await screen.findByText("bot@gitlab.example"));
    fireEvent.click(await screen.findByRole("button", { name: /^(Delete|删除)$/ }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    expect(calls.find((c) => c.method === "DELETE")?.url).toBe("/matter/bonds/gitlab%3Agitlab-1");
    // Back on the list afterwards.
    expect(await screen.findByText(/No apps linked yet|还没有连接应用/)).toBeTruthy();
  });

  it("links GitLab on an instance it knows without asking for the URL again", async () => {
    routes["GET /matter/connect/gitlab"] = () => json(200, { instances: ["https://git.corp.example"], data: [] });
    routes["POST /matter/connect/gitlab"] = () =>
      json(201, { id: "gitlab-2", webhookUrl: "https://matter.example/webhooks/gitlab/gitlab-2", webhookSecret: "s" });
    open("/bonds/new?provider=gitlab");
    expect((await screen.findByRole("combobox", { name: /GitLab URL|GitLab 地址/ })).textContent).toContain("https://git.corp.example");
    expect(screen.queryByRole("textbox", { name: /GitLab URL|GitLab 地址/ })).toBeNull();
    fireEvent.mouseDown(screen.getByRole("tab", { name: /Paste a bot token|粘贴机器人令牌/ }));
    fireEvent.change(document.getElementById("gitlab-token")!, { target: { value: "glpat-x" } });
    fireEvent.click(screen.getByRole("button", { name: /^(Link|连接)$/ }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ baseUrl: "https://git.corp.example", token: "glpat-x" });
  });

  it("asks for the URL when no instance is known", async () => {
    routes["GET /matter/connect/gitlab"] = () => json(200, { instances: [], data: [] });
    open("/bonds/new?provider=gitlab");
    expect(((await screen.findByRole("textbox", { name: /GitLab URL|GitLab 地址/ })) as HTMLInputElement).value).toBe("https://gitlab.com");
    expect(screen.queryByRole("combobox", { name: /GitLab URL|GitLab 地址/ })).toBeNull();
  });

  it("creates a project bot by default, sending the user's token once", async () => {
    routes["GET /matter/connect/gitlab"] = () => json(200, { instances: ["https://gitlab.example.com"], data: [] });
    let refuse = true;
    routes["POST /matter/connect/gitlab/bot"] = () =>
      refuse
        ? json(400, { error: "GitLab rejected your token or you are not a Maintainer of the project" })
        : json(201, { id: "gitlab-3", webhookUrl: "https://matter.example/webhooks/gitlab/gitlab-3", webhookSecret: "s3" });
    open("/bonds/new?provider=gitlab");
    expect(await screen.findByText(/only and sees nothing else|看不到其他项目/)).toBeTruthy();
    const create = screen.getByRole("button", { name: /^(Create bot|创建机器人)$/ }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    // Read only is the default preset.
    expect(screen.getByRole("radio", { name: /Read only|只读/ }).getAttribute("aria-checked")).toBe("true");
    fireEvent.change(document.getElementById("gitlab-project")!, { target: { value: " group/app " } });
    fireEvent.change(document.getElementById("gitlab-user-token")!, { target: { value: "glpat-mine" } });
    fireEvent.click(create);
    expect((await screen.findByRole("alert")).textContent).toContain("not a Maintainer");
    expect(calls.find((c) => c.url === "/matter/connect/gitlab/bot")?.body).toEqual({
      baseUrl: "https://gitlab.example.com",
      project: "group/app",
      preset: "read",
      userToken: "glpat-mine",
    });

    refuse = false;
    fireEvent.click(screen.getByRole("radio", { name: /Comment on merge requests|在合并请求下评论/ }));
    fireEvent.change(document.getElementById("gitlab-expires")!, { target: { value: "2027-06-30" } });
    fireEvent.click(create);
    expect(await screen.findByDisplayValue("s3")).toBeTruthy();
    expect(calls.filter((c) => c.url === "/matter/connect/gitlab/bot").at(-1)?.body).toEqual({
      baseUrl: "https://gitlab.example.com",
      project: "group/app",
      preset: "comment",
      expiresAt: "2027-06-30",
      userToken: "glpat-mine",
    });
  });

  it("shows a GitLab Bond's token facts and replaces its token in place", async () => {
    const linked = {
      ...spare,
      details: { baseUrl: "https://gitlab.example", username: "bot", tokenScopes: "read_repository, read_api", tokenExpiresAt: "2027-01-31" },
    };
    routes["GET /matter/bonds"] = () => json(200, { data: [linked] });
    routes["GET /matter/loops"] = () => json(200, { data: [] });
    routes["PUT /matter/connect/gitlab/gitlab-1/token"] = () => {
      routes["GET /matter/bonds"] = () => json(200, { data: [{ ...linked, details: { ...linked.details, tokenScopes: "api" } }] });
      return json(200, { id: "gitlab-1", username: "bot", webhookUrl: "/webhooks/gitlab/gitlab-1", tokenScopes: ["api"] });
    };
    open("/bonds/gitlab%3Agitlab-1");
    expect(await screen.findByText("read_repository, read_api")).toBeTruthy();
    expect(screen.getByText(/^(Token scopes|令牌权限)$/)).toBeTruthy();
    expect(screen.getByText("2027-01-31")).toBeTruthy();

    // Mint a new project bot token.
    fireEvent.click(screen.getByRole("button", { name: /^(Replace token|更换令牌)$/ }));
    fireEvent.change(document.getElementById("gitlab-project")!, { target: { value: "42" } });
    fireEvent.change(document.getElementById("gitlab-user-token")!, { target: { value: "glpat-mine" } });
    fireEvent.click(screen.getByRole("button", { name: /^(Replace|更换)$/ }));
    expect(await screen.findByText(/Token replaced|令牌已更换/)).toBeTruthy();
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ project: "42", preset: "read", userToken: "glpat-mine" });
    // The Bond is loaded again with the new token's facts.
    expect(await screen.findByText("api")).toBeTruthy();

    // Or paste one.
    fireEvent.click(screen.getByRole("button", { name: /^(Replace token|更换令牌)$/ }));
    fireEvent.mouseDown(screen.getByRole("tab", { name: /Paste a bot token|粘贴机器人令牌/ }));
    fireEvent.change(document.getElementById("gitlab-token")!, { target: { value: "glpat-new" } });
    fireEvent.click(screen.getByRole("button", { name: /^(Replace|更换)$/ }));
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT")).toHaveLength(2));
    expect(calls.filter((c) => c.method === "PUT")[1]).toEqual({
      method: "PUT",
      url: "/matter/connect/gitlab/gitlab-1/token",
      body: { token: "glpat-new" },
    });
  });

  it("links an existing Feishu app by its credentials and shows what its setup still needs", async () => {
    let refuse = true;
    routes["POST /matter/connect/feishu/app"] = () =>
      refuse
        ? json(409, { error: "This app is linked in another workspace; unlink it there first" })
        : json(200, {
            status: "registered",
            appId: "cli_a1b2c3d4e5f60718",
            brand: "lark",
            setup: { ready: false, problems: ["Subscribe im.message.receive_v1"], links: { events: "https://open.larksuite.com/events" } },
          });
    open("/bonds/new?provider=feishu");
    // Scanning stays the default.
    expect(await screen.findByRole("button", { name: /Show QR code|生成二维码/ })).toBeTruthy();
    fireEvent.mouseDown(screen.getByRole("tab", { name: /Use an existing app|使用已有应用/ }));
    const link = (await screen.findByRole("button", { name: /^(Link|连接)$/ })) as HTMLButtonElement;
    expect(link.disabled).toBe(true);
    fireEvent.change(document.getElementById("feishu-app-id")!, { target: { value: " cli_a1b2c3d4e5f60718 " } });
    fireEvent.change(document.getElementById("feishu-app-secret")!, { target: { value: "app-secret" } });
    fireEvent.click(link);
    expect((await screen.findByRole("alert")).textContent).toContain("another workspace");
    expect(calls.find((c) => c.url === "/matter/connect/feishu/app")?.body).toEqual({
      appId: "cli_a1b2c3d4e5f60718",
      appSecret: "app-secret",
      brand: "feishu",
    });

    refuse = false;
    fireEvent.click(link);
    expect(await screen.findByText("Subscribe im.message.receive_v1")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Subscribe events|订阅事件/ }).getAttribute("href")).toBe("https://open.larksuite.com/events");
    fireEvent.click(screen.getByRole("button", { name: /^(Done|完成)$/ }));
    expect(await screen.findByText(/This app is not linked|找不到这个应用/)).toBeTruthy();
  });

  it("replaces a Feishu app's secret in place", async () => {
    routes["GET /matter/bonds"] = () => json(200, { data: [{ ...bond, details: { appId: "cli_old", brand: "lark" } }] });
    routes["POST /matter/connect/feishu/app"] = () => json(200, { status: "registered", appId: "cli_old", brand: "lark", setupUnavailable: true });
    open("/bonds/feishu%3Acli_old");
    fireEvent.click(await screen.findByRole("button", { name: /^(Replace secret|更换 App Secret)$/ }));
    // The app is known: only the secret is asked.
    expect(document.getElementById("feishu-app-id")).toBeNull();
    fireEvent.change(document.getElementById("feishu-app-secret")!, { target: { value: "new-secret" } });
    fireEvent.click(screen.getByRole("button", { name: /^(Replace|更换)$/ }));
    expect(await screen.findByText(/Secret replaced|App Secret 已更换/)).toBeTruthy();
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ appId: "cli_old", appSecret: "new-secret", brand: "lark" });
    expect(document.getElementById("feishu-app-secret")).toBeNull();
  });
});
