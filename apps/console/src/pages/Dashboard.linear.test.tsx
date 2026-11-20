import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
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

  it("renders origin-bound CLI quickstart commands and a previewable Agent setup prompt", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    const origin = window.location.origin;
    render(
      <MemoryRouter>
        <I18nProvider>
          <Dashboard />
        </I18nProvider>
      </MemoryRouter>,
    );

    expect(
      screen.getByText(`npm i -g @openma/cli && oma auth login --base-url ${origin}`),
    ).toBeInTheDocument();
    expect(
      screen.getByText(`export OMA_BASE_URL=${origin} OMA_API_KEY=<your-api-key>`),
    ).toBeInTheDocument();
    expect(
      screen.getByText("npx skills add openma-ai/open-managed-agents --skill openma"),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("openma-cli");
    expect(document.body.textContent).not.toContain("openma-api");

    fireEvent.click(screen.getByRole("button", { name: "Preview prompt" }));
    expect(
      screen.getByText(
        new RegExp(`Help me connect to and use openma \\(base URL: ${origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`),
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: new RegExp(`Copy Agent setup prompt \\(${origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`) }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining(`base URL: ${origin}`));
  });
});
