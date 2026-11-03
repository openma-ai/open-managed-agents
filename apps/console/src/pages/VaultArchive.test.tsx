import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { useState } from "react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../i18n";
import { server } from "../mocks/server";
import { VaultDetail } from "./VaultDetail";
import { VaultsList } from "./VaultsList";

const vault = {
  id: "vault-1",
  display_name: "Team credentials",
  type: "vault",
  archived_at: null,
  metadata: {},
  created_at: "2026-08-31T10:00:00.000Z",
  updated_at: "2026-08-31T11:00:00.000Z",
};

function PageShell() {
  const [pageHeaderSlot, setPageHeaderSlot] = useState<HTMLDivElement | null>(null);
  return (
    <>
      <div ref={setPageHeaderSlot} />
      <Outlet context={{ pageHeaderSlot }} />
    </>
  );
}

afterEach(() => vi.restoreAllMocks());

describe("Vault archive confirmation", () => {
  it.each([
    ["detail", "/vaults/vault-1"],
    ["list", "/vaults"],
  ])("explains the non-cascading archive and injection impact from the %s page", async (entry, path) => {
    server.use(
      http.get("*/v1/vaults", () => HttpResponse.json({ data: [vault], next_page: null })),
      http.get("*/v1/vaults/vault-1", () => HttpResponse.json(vault)),
      http.get("*/v1/vaults/vault-1/credentials", () => HttpResponse.json({ data: [], next_page: null })),
    );
    // Observe the browser prompt without consenting to any archive request.
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <I18nProvider>
            <Routes>
              <Route element={<PageShell />}>
                <Route path="/vaults" element={<VaultsList />} />
                <Route path="/vaults/:id" element={<VaultDetail />} />
              </Route>
            </Routes>
          </I18nProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    if (entry === "detail") {
      await screen.findByRole("heading", { name: "Team credentials" });
      fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    } else {
      fireEvent.contextMenu(await screen.findByRole("row", { name: /Team credentials/ }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));
    }

    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/credentials will not be archived/i));
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/vault cannot be used for credential injection after archive/i));
  });
});
