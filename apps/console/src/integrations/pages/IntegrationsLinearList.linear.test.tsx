import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { IntegrationsLinearList } from "./IntegrationsLinearList";

vi.mock("../api/client", () => ({
  IntegrationsApi: class {
    linear = { listPendingPublications: vi.fn(async () => []) };
    listInstallations = vi.fn(async () => []);
    listPublications = vi.fn(async () => []);
  },
}));

describe("integration route density", () => {
  it("uses the shared integration page inset instead of its own scroll frame", async () => {
    render(
      <MemoryRouter>
        <IntegrationsLinearList />
      </MemoryRouter>,
    );

    const route = await screen.findByTestId("integration-route");
    expect(route).toHaveClass("console-integration-route");
    expect(screen.getByTestId("integration-page")).toHaveClass(
      "console-integration-page",
    );
  });
});
