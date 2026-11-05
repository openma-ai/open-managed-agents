import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { EnvironmentDetail } from "./EnvironmentDetail";
import { I18nProvider } from "../i18n";

const update = vi.fn(async (_id: string, _body: unknown) => environment);

const environment = {
  id: "env-rt",
  name: "Laptop",
  description: null,
  config: { type: "self_hosted" },
  type: "environment",
  metadata: {},
  archived_at: null,
  created_at: "2026-11-04T00:00:00.000Z",
  updated_at: "2026-11-04T00:00:00.000Z",
  _oma: { runtime: { runtime_id: "rt_1", env: { NODE_ENV: "development" } } },
};

vi.mock("../lib/api", () => ({ useApi: () => ({ api: vi.fn() }) }));
vi.mock("../lib/useManagedApi", () => ({
  useManagedApi: () => ({ environments: { update } }),
}));
vi.mock("../lib/useApiQuery", () => ({
  useApiQuery: (path: string | null) => {
    if (path === "/v1/oma/runtimes") {
      return {
        data: { runtimes: [{ id: "rt_1", hostname: "mbp", os: "darwin", status: "online" }] },
        error: null,
        isLoading: false,
      };
    }
    if (path === "/v1/environments/env-rt") return { data: environment, error: null };
    return { data: undefined, error: null };
  },
}));

function renderPage() {
  render(
    <MemoryRouter initialEntries={["/environments/env-rt"]}>
      <Routes>
        <Route path="/environments/:id" element={<I18nProvider><EnvironmentDetail /></I18nProvider>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("EnvironmentDetail runtime attachment", () => {
  it("shows the attached runtime and overlay, and saves only the changed attachment", async () => {
    renderPage();
    const overlay = (await screen.findByLabelText(/Env overlay/)) as HTMLTextAreaElement;
    expect(overlay.value).toBe("NODE_ENV=development");
    expect(screen.getByText(/mbp · darwin · online/)).toBeTruthy();

    fireEvent.change(overlay, { target: { value: "NODE_ENV=development\nDEBUG=1" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]![1]).toMatchObject({
      config: { type: "self_hosted" },
      _oma: { runtime: { runtime_id: "rt_1", env: { NODE_ENV: "development", DEBUG: "1" } } },
    });
  });

  it("blocks saving while the overlay has errors", async () => {
    renderPage();
    const overlay = await screen.findByLabelText(/Env overlay/);
    fireEvent.change(overlay, { target: { value: "not a pair" } });
    expect(await screen.findByText("Line 1: expected KEY=value")).toBeTruthy();
    expect((screen.getByRole("button", { name: /save/i }) as HTMLButtonElement).disabled).toBe(true);
  });
});
