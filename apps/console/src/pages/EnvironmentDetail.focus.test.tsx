import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { EnvironmentDetail } from "./EnvironmentDetail";

vi.mock("../lib/api", () => ({
  useApi: () => ({ api: vi.fn() }),
}));

vi.mock("../lib/useApiQuery", () => {
  const data = {
      id: "env-1",
      name: "Development",
      description: "Development environment",
      config: {
        type: "cloud",
        networking: { type: "unrestricted" },
        packages: {
          type: "packages",
          apt: [],
          cargo: [],
          gem: [],
          go: [],
          npm: [],
          pip: [],
        },
      },
      type: "environment",
      metadata: {},
      archived_at: null,
      created_at: "2026-08-30T00:00:00.000Z",
      updated_at: "2026-08-30T00:00:00.000Z",
  };

  return {
    useApiQuery: () => ({ data, error: null }),
  };
});

describe("EnvironmentDetail focus treatment", () => {
  it("does not override the shared one-pixel focus treatment on switches", async () => {
    render(
      <MemoryRouter initialEntries={["/environments/env-1"]}>
        <Routes>
          <Route path="/environments/:id" element={<EnvironmentDetail />} />
        </Routes>
      </MemoryRouter>,
    );

    const toggle = await screen.findByRole("switch", {
      name: "Allow MCP server network access",
    });
    expect(toggle.className).toContain("focus-visible:ring-1");
    expect(toggle.className).not.toContain("focus-visible:ring-2");
    expect(toggle.className).not.toContain("focus-visible:ring-brand");
  });

  it("uses the shared settings stack and compact section-card geometry", async () => {
    render(
      <MemoryRouter initialEntries={["/environments/env-1"]}>
        <Routes>
          <Route path="/environments/:id" element={<EnvironmentDetail />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByTestId("settings-layout")).toHaveClass(
      "console-settings-layout",
    );
    const sections = screen.getAllByTestId("settings-section");
    expect(sections).toHaveLength(3);
    expect(sections[0]).toHaveClass("console-settings-section");
    expect(screen.getByTestId("settings-actions")).toHaveClass(
      "console-settings-actions",
    );
  });
});
