import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";

import { I18nProvider } from "../i18n";
import { en } from "../i18n/en";
import { zhCN } from "../i18n/zh-CN";
import { issueText, LoopEditPage, LoopsPage, LoopTemplatesPage } from "./Loops";
import { BondLinkPage } from "./Bonds";

const managedApi = {
  agents: { list: vi.fn(async () => ({ data: [{ id: "agent-1", name: "Helpdesk" }] })) },
  environments: { list: vi.fn(async () => ({ data: [{ id: "env_report", name: "Analytics" }] })) },
  vaults: { list: vi.fn(async () => ({ data: [{ id: "vlt_user", display_name: "Analytics keys" }] })) },
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
      sessionScope: { type: "string", enum: ["work-item", "global"], default: "work-item", title: "Scope", "x-oma-widget": "session-scope", "x-oma-section": "session" },
      environmentId: { type: "string", title: "Environment", "x-oma-widget": "environment", "x-oma-section": "session" },
      vaultIds: { type: "array", items: { type: "string" }, default: [], title: "Vaults", "x-oma-widget": "vault", "x-oma-section": "session" },
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

const open = (path = "/loops") =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <I18nProvider>
        <Routes>
          <Route path="/loops" element={<LoopsPage />} />
          <Route path="/loops/new" element={<LoopEditPage />} />
          <Route path="/loops/templates" element={<LoopTemplatesPage />} />
          <Route path="/loops/:id" element={<LoopEditPage />} />
          <Route path="/bonds/new" element={<BondLinkPage />} />
        </Routes>
      </I18nProvider>
    </MemoryRouter>,
  );

describe("LoopsPage", () => {
  it("lists Loops with their Bond, Agent and state", async () => {
    open();
    expect(await screen.findByText("Old bot")).toBeTruthy();
    expect(screen.getByText("Helpdesk")).toBeTruthy();
    expect(screen.getByText(/^(Running|运行中)$/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /New Loop|新建 Loop/ }).getAttribute("href")).toBe("/loops/templates");
    // Every template is in use, so nothing is suggested.
    expect(screen.queryByText(/^(Suggested Loops|推荐的 Loop)$/)).toBeNull();

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "nothing like this" } });
    expect(await screen.findByText(/No Loop matches the filters|没有符合条件的 Loop/)).toBeTruthy();
  });

  it("suggests the templates no Loop uses yet", async () => {
    routes["GET /matter/loops"] = () => json(200, { data: [] });
    open();
    expect(await screen.findByText(/^(Suggested Loops|推荐的 Loop)$/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Feishu bot|飞书机器人/ }).getAttribute("href")).toBe("/loops/new?template=feishu-agent");
    expect(screen.getByRole("link", { name: /View all templates|查看全部模板/ }).getAttribute("href")).toBe("/loops/templates");
  });

  it("lists templates, searchable and filtered by app", async () => {
    open("/loops/templates");
    expect((await screen.findByRole("link", { name: /Feishu bot|飞书机器人/ })).getAttribute("href")).toBe("/loops/new?template=feishu-agent");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "gitlab" } });
    expect(screen.queryByRole("link", { name: /Feishu bot|飞书机器人/ })).toBeNull();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("tab", { name: /^(Feishu|飞书)$/ }));
    expect(screen.getByRole("link", { name: /Feishu bot|飞书机器人/ })).toBeTruthy();
  });


  it("links a new Feishu app on the Bond page, then comes back and saves the Loop on it", async () => {
    routes["GET /matter/loops"] = () => json(200, { data: [] });
    routes["GET /matter/bonds"] = () => json(200, { data: [] });
    routes["POST /matter/connect/feishu/registrations"] = () =>
      json(201, { id: "reg_1", status: { status: "pending", url: "https://open.feishu.cn/x", qrSvg: "<svg/>" } });
    routes["GET /matter/connect/feishu/registrations/reg_1"] = () => {
      routes["GET /matter/bonds"] = () =>
        json(200, { data: [{ ...bond, id: "feishu:cli_new", label: "New bot", loops: 0, setup: { ready: true, problems: [] } }] });
      return json(200, { status: "registered", appId: "cli_new" });
    };
    routes["POST /matter/loops"] = () => json(422, { error: "invalid_config", problems: ["agentId is required"] });

    // Old Feishu links redirect here with the template preselected.
    open("/loops?template=feishu-agent");
    // The Loop form only picks a Bond; linking one is the Bond page's job.
    const link = await screen.findByRole("link", { name: /Link a Feishu app|连接飞书应用/ });
    expect(link.getAttribute("href")).toBe("/bonds/new?provider=feishu&return=%2Floops%2Fnew%3Ftemplate%3Dfeishu-agent");
    expect(screen.queryByRole("button", { name: /Show QR code|生成二维码/ })).toBeNull();
    fireEvent.click(link);

    fireEvent.click(await screen.findByRole("button", { name: /Show QR code|生成二维码/ }));
    await waitFor(() => expect(calls.some((c) => c.url === "/matter/connect/feishu/registrations")).toBe(true));
    expect(calls.find((c) => c.url === "/matter/connect/feishu/registrations")?.body).toEqual({});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });

    // Back on the Loop form with the new Bond chosen.
    expect(await screen.findByText("New bot")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^(Save|保存)$/ }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url === "/matter/loops")).toBe(true));
    expect(calls.find((c) => c.method === "POST" && c.url === "/matter/loops")?.body).toEqual({
      template: "feishu-agent",
      config: { bond: "feishu:cli_new", acknowledge: "Get", sessionScope: "work-item", vaultIds: [] },
    });
    expect(await screen.findByText("agentId is required")).toBeTruthy();
  });

  it("edits a Loop on its page, with the permission quick links of its Bond", async () => {
    routes["PATCH /matter/loops/loop-1"] = () => json(200, loop);
    open("/loops/loop-1");
    expect(await screen.findByText("Add im:resource")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Apply for scopes|申请权限/ }).getAttribute("href")).toBe("https://open.feishu.cn/scopes");
    fireEvent.click(screen.getByRole("button", { name: /^(Save|保存)$/ }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ config: loop.config });
    // Back to the Loops page after saving.
    expect(await screen.findByText("Helpdesk")).toBeTruthy();
  });

  it("edits the repositories cloned into the Loop's sessions, one URL per line", async () => {
    const withRepositories = {
      ...feishuTemplate,
      configSchema: {
        ...feishuTemplate.configSchema,
        properties: {
          ...feishuTemplate.configSchema.properties,
          repositories: { type: "array", items: { type: "string" }, default: [], title: "Repositories", "x-oma-widget": "repositories", "x-oma-section": "session" },
        },
      },
    };
    const saved = { ...loop, config: { ...loop.config, repositories: ["https://gitlab.example.com/g/a.git"] } };
    routes["GET /matter/loop-templates"] = () => json(200, { data: [withRepositories] });
    routes["GET /matter/loops"] = () => json(200, { data: [saved] });
    routes["PATCH /matter/loops/loop-1"] = () => json(200, saved);
    open("/loops/loop-1");
    const field = (await screen.findByLabelText(/^(Repositories|代码仓库)/)) as HTMLTextAreaElement;
    expect(field.value).toBe("https://gitlab.example.com/g/a.git");
    fireEvent.change(field, { target: { value: "https://gitlab.example.com/g/a.git\n" } });
    expect(field.value).toBe("https://gitlab.example.com/g/a.git\n");
    fireEvent.change(field, { target: { value: "https://gitlab.example.com/g/a.git\n\n  https://gitlab.example.com/g/b.git " } });
    fireEvent.click(screen.getByRole("button", { name: /^(Save|保存)$/ }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect((calls.find((c) => c.method === "PATCH")?.body as { config: { repositories: string[] } }).config.repositories).toEqual([
      "https://gitlab.example.com/g/a.git",
      "https://gitlab.example.com/g/b.git",
    ]);
  });

  it("schedules a report Loop in the browser's time zone", async () => {
    const reportTemplate = {
      id: "feishu-scheduled-report",
      version: "1.0.0",
      provider: "feishu",
      description: "Report",
      configSchema: {
        properties: {
          bond: { type: "string", title: "Runs on", "x-oma-widget": "bond", "x-bond-provider": "feishu" },
          agentId: { type: "string", title: "Agent", "x-oma-widget": "agent" },
          task: { type: "string", title: "Task" },
          schedule: { type: "string", title: "Schedule", "x-oma-widget": "cron", "x-oma-section": "trigger" },
          timezone: { type: "string", title: "Time zone", default: "UTC", "x-oma-widget": "timezone", "x-oma-section": "trigger" },
        },
        required: ["bond", "agentId", "task", "schedule"],
      },
    };
    routes["GET /matter/loop-templates"] = () => json(200, { data: [feishuTemplate, reportTemplate] });
    routes["POST /matter/loops"] = () => json(201, loop);
    open("/loops/new?template=feishu-scheduled-report&bond=feishu:cli_old");
    expect(await screen.findByText(/^(Schedule|运行时间)$/)).toBeTruthy();
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect((screen.getByLabelText(/^(Time zone|时区)/) as HTMLInputElement).value).toBe(zone);
    fireEvent.change(screen.getByLabelText(/^(Time|时间)\s*\*?$/), { target: { value: "0 10 * * 1-5" } });
    fireEvent.change(screen.getByLabelText(/^(Task|任务)/), { target: { value: "Daily metrics" } });
    fireEvent.click(screen.getByRole("button", { name: /^(Save|保存)$/ }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url === "/matter/loops")).toBe(true));
    expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({
      template: "feishu-scheduled-report",
      config: { bond: "feishu:cli_old", schedule: "0 10 * * 1-5", timezone: zone, task: "Daily metrics" },
    });
  });

  it("sets the Loop's session: the default environment and the checked vaults", async () => {
    routes["PATCH /matter/loops/loop-1"] = () => json(200, loop);
    open("/loops/loop-1");
    const vault = await screen.findByRole("checkbox", { name: "Analytics keys" });
    expect(screen.getByText(/^(Default environment|默认环境)$/)).toBeTruthy();
    // The template's own session setting sits with the others.
    expect(screen.getByText(/^(Session scope|会话粒度)/)).toBeTruthy();
    // Session settings are not listed with the template's own options.
    expect(screen.queryByLabelText(/^(Vaults|凭证库)$/, { selector: "input" })).toBeNull();
    fireEvent.click(vault);
    fireEvent.click(screen.getByRole("button", { name: /^(Save|保存)$/ }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ config: { ...loop.config, vaultIds: ["vlt_user"] } });
  });
});

describe("issueText", () => {
  it("says a configuration problem in the user's language", () => {
    expect(issueText(zhCN.matter, { field: "agentId", code: "required" })).toBe(`请填写${zhCN.matter.fields.agentId!.title}`);
    expect(issueText(en.matter, { field: "task", code: "max_length", params: { max: 8000 } })).toBe(
      `${en.matter.fields.task!.title} must be at most 8000 characters`,
    );
    expect(issueText(zhCN.matter, { field: "chats", code: "type", params: { expected: "string", item: 2 } })).toBe(
      `${zhCN.matter.fields.chats?.title ?? "chats"}必须是文本（第 2 项）`,
    );
    expect(issueText(zhCN.matter, { field: "sessionScope", code: "enum", params: { options: "request, global" } })).toContain(
      zhCN.matter.options.request!,
    );
    expect(issueText(zhCN.matter, { field: "timezone", code: "timezone_unknown", params: { timezone: "Mars/Base" } })).toBe(
      "未知时区 Mars/Base",
    );
    expect(issueText(en.matter, { code: "something_new" })).toBeUndefined();
  });
});

