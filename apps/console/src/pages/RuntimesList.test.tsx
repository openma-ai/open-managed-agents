import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import { I18nProvider } from "../i18n";
import { RuntimesList } from "./RuntimesList";

vi.mock("../lib/useApiQuery", () => ({
  useApiQuery: () => ({
    data: { runtimes: [] },
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

vi.mock("../lib/api", () => ({
  useApi: () => ({ api: vi.fn() }),
}));

describe("RuntimesList bridge onboarding", () => {
  it("includes the current Console origin in bridge setup commands", () => {
    const expected = `npx -y -p @openma/cli oma bridge setup --server-url=${window.location.origin}`;
    render(
      <MemoryRouter>
        <I18nProvider>
          <RuntimesList />
        </I18nProvider>
      </MemoryRouter>,
    );

    expect(screen.getByText(expected)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "+ Connect machine" }));
    expect(screen.getAllByText(expected).length).toBeGreaterThanOrEqual(2);
  });
});
