import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";

import { I18nProvider } from "../i18n";
import { BondDetailPage, BondsPage } from "./Bonds";

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
});
