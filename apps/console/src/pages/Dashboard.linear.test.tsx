import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
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
});
