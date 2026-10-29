import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../i18n";
import { VaultDetail } from "./VaultDetail";

const vault = {
  id: "vault-1",
  display_name: "Team credentials",
  type: "vault",
  archived_at: null,
  metadata: {},
  created_at: "2026-08-31T10:00:00.000Z",
  updated_at: "2026-08-31T11:00:00.000Z",
};

const capCredential = {
  id: "vcrd_cap",
  type: "vault_credential",
  vault_id: "vault-1",
  display_name: "GitHub CLI",
  archived_at: null,
  metadata: {},
  created_at: "2026-08-31T10:00:00.000Z",
  updated_at: "2026-08-31T10:00:00.000Z",
  auth: { type: "cap_cli", cli_id: "gh" },
};

const legacyApi = vi.fn();
const managed = {
  vaults: {
    archive: vi.fn(),
    delete: vi.fn(),
    credentials: {
      create: vi.fn(),
      delete: vi.fn(),
      update: vi.fn(),
      capCliDeviceFlow: { start: vi.fn(), poll: vi.fn() },
    },
  },
};

vi.mock("../lib/api", () => ({ useApi: () => ({ api: legacyApi }) }));
vi.mock("../lib/useManagedApi", () => ({ useManagedApi: () => managed }));
vi.mock("../lib/useApiQuery", () => ({
  useApiQuery: (path: string | null) =>
    path === "/v1/vaults/vault-1"
      ? { data: vault, error: null }
      : { data: { data: [] }, isLoading: false, refetch: vi.fn() },
  useInfiniteApiQuery: () => ({
    items: [capCredential],
    isLoading: false,
    hasMore: false,
    isLoadingMore: false,
    loadMore: vi.fn(),
    refresh: vi.fn(),
    error: null,
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("../components/PageHeader", () => ({
  PageHeader: ({ actions }: { actions?: React.ReactNode }) => <div>{actions}</div>,
}));

function renderPage() {
  render(
    <MemoryRouter initialEntries={["/vaults/vault-1"]}>
      <I18nProvider>
        <Routes>
          <Route path="/vaults/:id" element={<VaultDetail />} />
        </Routes>
      </I18nProvider>
    </MemoryRouter>,
  );
}

async function openCliTab() {
  fireEvent.click(await screen.findByRole("button", { name: "+ Add credential" }));
  const dialog = await screen.findByRole("dialog");
  const cliTab = within(dialog).getByRole("tab", { name: "CLI" });
  fireEvent.mouseDown(cliTab);
  fireEvent.click(cliTab);
  return dialog;
}

beforeEach(() => {
  legacyApi.mockReset();
  for (const fn of [
    managed.vaults.credentials.create,
    managed.vaults.credentials.capCliDeviceFlow.start,
    managed.vaults.credentials.capCliDeviceFlow.poll,
  ]) fn.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("VaultDetail cap_cli credentials", () => {
  it("lists cap_cli credentials by CLI", async () => {
    renderPage();
    expect(await screen.findByText("GitHub CLI (gh)")).toBeInTheDocument();
    expect(screen.getByText("CLI")).toBeInTheDocument();
  });

  it("creates a token cap_cli credential through the managed /v1 API", async () => {
    managed.vaults.credentials.create.mockResolvedValue(capCredential);
    renderPage();
    const dialog = await openCliTab();
    fireEvent.change(within(dialog).getByLabelText(/^Token/), {
      target: { value: "gho_manual" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
    });
    expect(managed.vaults.credentials.create).toHaveBeenCalledWith("vault-1", {
      display_name: "GitHub CLI (gh)",
      auth: { type: "cap_cli", cli_id: "gh", token: "gho_manual" },
    });
    expect(legacyApi).not.toHaveBeenCalled();
  });

  it("runs the device flow against /v1, following slow_down's re-sealed token", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    managed.vaults.credentials.capCliDeviceFlow.start.mockResolvedValue({
      type: "cap_cli_device_flow",
      cli_id: "gh",
      flow_token: "sealed-1",
      user_code: "ABCD-1234",
      verification_uri: "https://github.com/login/device",
      interval_seconds: 1,
      expires_at: new Date(Date.now() + 600_000).toISOString(),
    });
    managed.vaults.credentials.capCliDeviceFlow.poll
      .mockResolvedValueOnce({ status: "slow_down", interval_seconds: 2, flow_token: "sealed-2" })
      .mockResolvedValueOnce({ status: "ready", credential_id: "vcrd_new" });
    renderPage();
    const dialog = await openCliTab();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: /Sign in via gh OAuth/ }));
    });
    expect(managed.vaults.credentials.capCliDeviceFlow.start).toHaveBeenCalledWith(
      "vault-1",
      { cli_id: "gh" },
    );
    expect(await within(dialog).findByText("ABCD-1234")).toBeInTheDocument();

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });

    expect(managed.vaults.credentials.capCliDeviceFlow.poll.mock.calls).toEqual([
      ["vault-1", { flow_token: "sealed-1" }],
      ["vault-1", { flow_token: "sealed-2" }],
    ]);
    // Ready: the credential exists, so the modal closes and the list reloads.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(legacyApi).not.toHaveBeenCalled();
  });
});
