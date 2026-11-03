import { act, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../i18n";
import { VaultDetail } from "./VaultDetail";

const longName = "Production deployment credential with a deliberately long display name";
const longId = "vcrd_0123456789abcdefghijklmnopqrstuvwxyz0123456789";
const longTarget = "https://mcp.example.test/organizations/production/team/deployment/mcp";
const vault = {
  id: "vault-1", display_name: "Team credentials", type: "vault",
  archived_at: null, metadata: {},
  created_at: "2026-08-31T10:00:00.000Z", updated_at: "2026-08-31T11:00:00.000Z",
};
const credential = {
  id: longId, vault_id: vault.id, type: "vault_credential", display_name: longName,
  archived_at: null, metadata: {}, created_at: vault.created_at, updated_at: vault.updated_at,
  auth: { type: "static_bearer", mcp_server_url: longTarget },
};

vi.mock("../lib/api", () => ({ useApi: () => ({ api: vi.fn() }) }));
vi.mock("../lib/useManagedApi", () => ({ useManagedApi: () => ({}) }));
vi.mock("../lib/useApiQuery", () => ({
  useApiQuery: () => ({ data: vault, error: null }),
  useInfiniteApiQuery: () => ({ items: [credential], isLoading: false, refresh: vi.fn() }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("../components/PageHeader", () => ({
  PageHeader: ({ actions }: { actions?: React.ReactNode }) => <div>{actions}</div>,
}));

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/vaults/vault-1"]}>
      <I18nProvider>
        <Routes><Route path="/vaults/:id" element={<VaultDetail />} /></Routes>
      </I18nProvider>
    </MemoryRouter>,
  );
}

afterEach(() => { vi.restoreAllMocks(); });

describe("Vault credential overflow", () => {
  // Removing a text viewport must lose the full title/focus target, not merely change a CSS class.
  it("preserves full name, ID and target in individually titled text viewports", () => {
    renderPage();
    const table = screen.getByRole("table");
    for (const text of [longName, longId, longTarget]) {
      expect(within(table).getByTitle(text)).toHaveTextContent(text);
    }
    expect(within(table).getByRole("button", { name: "Edit" })).toBeEnabled();
    expect(within(table).getByRole("button", { name: "Delete" })).toBeEnabled();
  });

  // JSDOM has no layout: supply only the browser geometry, keeping the real component and observer behavior.
  it("only makes actually overflowing text keyboard-focusable and remeasures on resize", () => {
    let availableWidth = 100;
    const callbacks = new Set<ResizeObserverCallback>();
    class GeometryObserver {
      constructor(callback: ResizeObserverCallback) { callbacks.add(callback); }
      observe() {}
      disconnect() {}
      unobserve() {}
    }
    vi.stubGlobal("ResizeObserver", GeometryObserver);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.title ? availableWidth : 0;
    });
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.textContent === longName ? 340 : 60;
    });
    try {
      renderPage();
      const name = screen.getByTitle(longName);
      const id = screen.getByTitle(longId);
      expect(name).toHaveAttribute("tabindex", "0");
      expect(name).toHaveAttribute("data-overflow", "true");
      expect(id).not.toHaveAttribute("tabindex");
      expect(id).toHaveAttribute("data-overflow", "false");
      // 240px of hidden text at 40px/s: independent literal expectations.
      expect(name.style.getPropertyValue("--overflow-text-travel")).toBe("-240px");
      expect(name.style.getPropertyValue("--overflow-text-duration")).toBe("6s");
      availableWidth = 400;
      act(() => {
        for (const callback of callbacks) callback([], {} as ResizeObserver);
      });
      expect(name).not.toHaveAttribute("tabindex");
      expect(name).toHaveAttribute("data-overflow", "false");
      expect(name.style.getPropertyValue("--overflow-text-travel")).toBe("0px");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
