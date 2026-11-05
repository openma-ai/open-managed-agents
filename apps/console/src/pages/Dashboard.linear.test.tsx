import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import { I18nProvider } from "../i18n";
import { Dashboard } from "./Dashboard";

vi.mock("../lib/useApiQuery", () => ({
  useApiQuery: (path: string) =>
    path === "/v1/oma/stats"
      ? {
          data: {
            agents: 1,
            sessions: 2,
            environments: 3,
            vaults: 4,
            skills: 5,
            model_cards: 6,
            api_keys: 7,
          },
          isLoading: false,
        }
      : { data: { data: [] }, isLoading: false },
}));

describe("Dashboard Linear density", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.removeItem("oma-locale");
  });

  it("keeps four primary KPI cards and moves secondary counts into activity content", () => {
    render(
      <MemoryRouter>
        <I18nProvider>
          <Dashboard />
        </I18nProvider>
      </MemoryRouter>,
    );

    const primary = screen.getByTestId("dashboard-primary-kpis");
    expect(within(primary).getAllByRole("button")).toHaveLength(4);
    expect(screen.getByTestId("dashboard-secondary-stats")).toHaveTextContent("5");
    expect(screen.getByTestId("dashboard-secondary-stats")).toHaveTextContent("6");
  });

  it.each(["https://app.openma.ai", "https://oma.example.com:8443"])(
    "displays and copies CLI commands for %s",
    async (origin) => {
      vi.stubGlobal("location", new URL(origin));
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal("navigator", { language: "en", clipboard: { writeText } });
      localStorage.setItem("oma-locale", "en");
      render(<MemoryRouter><I18nProvider><Dashboard /></I18nProvider></MemoryRouter>);

      const custom = origin === "https://oma.example.com:8443";
      const command = `npx -y -p @openma/cli oma${custom ? ` --base-url ${origin}` : ""}`;
      fireEvent.click(screen.getByRole("button", { name: command }));
      await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(command));

      fireEvent.click(screen.getByRole("button", { name: "npm i -g @openma/cli" }));
      await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("npm i -g @openma/cli"));

      if (custom) {
        const envHint = `export OMA_BASE_URL=${origin}`;
        fireEvent.click(screen.getByRole("button", { name: envHint }));
        await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(envHint));
      } else {
        expect(screen.queryByText(/export OMA_BASE_URL=/)).not.toBeInTheDocument();
      }
      expect(screen.getByText("Install CLI, create a key, run a session.")).toBeInTheDocument();
      expect(screen.getByText("Newest sessions in this workspace.")).toBeInTheDocument();
      expect(screen.getByText("No sessions yet.")).toBeInTheDocument();
    },
  );

  it("localizes the quickstart and empty state in Chinese", () => {
    localStorage.setItem("oma-locale", "zh-CN");
    render(<MemoryRouter><I18nProvider><Dashboard /></I18nProvider></MemoryRouter>);

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("开始使用");
    expect(screen.getByText("启动智能体")).toBeInTheDocument();
    expect(screen.getByText("安装 CLI、创建密钥、运行会话。")).toBeInTheDocument();
    expect(screen.getByText("当前工作区的最新会话。")).toBeInTheDocument();
    expect(screen.getByText("暂无会话。")).toBeInTheDocument();
    expect(screen.getByText("步骤 01")).toBeInTheDocument();
    expect(screen.getByText("运行会话")).toBeInTheDocument();
  });
});
