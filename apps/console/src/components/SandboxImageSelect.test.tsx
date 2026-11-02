import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EnvironmentDetail } from "../pages/EnvironmentDetail";
import { EnvironmentsList } from "../pages/EnvironmentsList";
import { I18nProvider } from "../i18n";

// Radix Select does not run in jsdom; a native <select> keeps the same
// controlled value/onValueChange contract.
vi.mock("./Select", () => ({
  Select: ({ id, value, onValueChange, children, placeholder }: {
    id?: string; value: string; onValueChange: (v: string) => void; children: ReactNode; placeholder?: string;
  }) => (
    <select id={id} aria-label={placeholder} value={value} onChange={(e) => onValueChange(e.target.value)}>
      {children}
    </select>
  ),
  SelectOption: ({ value, children }: { value: string; children: ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));

const state = vi.hoisted(() => ({
  images: [] as unknown[],
  environment: {} as Record<string, unknown>,
  create: vi.fn(),
  update: vi.fn(),
}));

vi.mock("../lib/api", () => ({ useApi: () => ({ api: vi.fn() }) }));

vi.mock("../lib/useManagedApi", () => ({
  useManagedApi: () => ({
    environments: {
      create: state.create,
      update: state.update,
      archive: vi.fn(),
      delete: vi.fn(),
    },
  }),
}));

vi.mock("../lib/useApiQuery", () => ({
  useApiQuery: (path: string | null) => {
    if (path === "/v1/oma/sandbox_images") return { data: { data: state.images }, error: null };
    return { data: state.environment, error: null };
  },
  useInfiniteApiQuery: () => ({
    items: [], isLoading: false, hasMore: false, isLoadingMore: false, loadMore: vi.fn(), refresh: vi.fn(),
  }),
}));

const ANALYTICS = { type: "sandbox_image", alias: "analytics", label: "Analytics", description: "pandas + Claude ACP" };

function cloudEnvironment(extra: Record<string, unknown> = {}) {
  return {
    id: "env-1",
    name: "Development",
    description: null,
    config: {
      type: "cloud",
      networking: { type: "unrestricted" },
      packages: { type: "packages", apt: [], cargo: [], gem: [], go: [], npm: [], pip: [] },
    },
    type: "environment",
    metadata: {},
    archived_at: null,
    created_at: "2026-10-23T00:00:00.000Z",
    updated_at: "2026-10-23T00:00:00.000Z",
    ...extra,
  };
}

function renderDetail() {
  return render(
    <MemoryRouter initialEntries={["/environments/env-1"]}>
      <Routes>
        <Route path="/environments/:id" element={<I18nProvider><EnvironmentDetail /></I18nProvider>} />
      </Routes>
    </MemoryRouter>,
  );
}

function renderList() {
  return render(
    <MemoryRouter><I18nProvider><EnvironmentsList /></I18nProvider></MemoryRouter>,
  );
}

beforeEach(() => {
  state.images = [];
  state.environment = cloudEnvironment();
  state.create.mockReset().mockResolvedValue({});
  state.update.mockReset().mockImplementation(async (_id: string, body: Record<string, unknown>) =>
    cloudEnvironment(body._oma && (body._oma as { sandbox_image: string | null }).sandbox_image
      ? { _oma: body._oma }
      : {}));
});

describe("Environment sandbox image selector", () => {
  it("is hidden on create and edit when the catalog is empty", async () => {
    renderDetail();
    await screen.findByTestId("settings-layout");
    expect(screen.queryByText("Sandbox image")).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Sandbox image" })).toBeNull();
  });

  it("creates with the selected alias and omits _oma for the default image", async () => {
    state.images = [ANALYTICS];
    renderList();
    fireEvent.click(screen.getAllByRole("button", { name: /New environment/i })[0]!);
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "analytics" } });
    const select = screen.getByLabelText("Sandbox image") as HTMLSelectElement;
    expect(select.value).toBe("__default__");
    expect(screen.getByRole("option", { name: "Default image" })).toBeInTheDocument();

    fireEvent.change(select, { target: { value: "analytics" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(state.create).toHaveBeenCalledTimes(1));
    expect(state.create).toHaveBeenLastCalledWith({
      name: "analytics",
      config: { type: "cloud" },
      description: undefined,
      _oma: { sandbox_image: "analytics" },
    });

    fireEvent.click(screen.getAllByRole("button", { name: /New environment/i })[0]!);
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "plain" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(state.create).toHaveBeenCalledTimes(2));
    expect(state.create.mock.calls[1]![0]).not.toHaveProperty("_oma");
  });

  it("edits the selection, sends _oma only when it changed, and clears with null", async () => {
    state.images = [ANALYTICS];
    renderDetail();
    const select = await screen.findByLabelText("Image") as HTMLSelectElement;
    expect(select.value).toBe("__default__");
    expect(screen.getByText("Pre-built image sandboxes start from. Packages below install on top of it.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(state.update).toHaveBeenCalledTimes(1));
    expect(state.update.mock.calls[0]![1]).not.toHaveProperty("_oma");

    fireEvent.change(select, { target: { value: "analytics" } });
    expect(screen.getByText("pandas + Claude ACP")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(state.update).toHaveBeenCalledTimes(2));
    expect(state.update.mock.calls[1]![1]).toMatchObject({ _oma: { sandbox_image: "analytics" } });

    await waitFor(() => expect((screen.getByLabelText("Image") as HTMLSelectElement).value).toBe("analytics"));
    fireEvent.change(screen.getByLabelText("Image"), { target: { value: "__default__" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(state.update).toHaveBeenCalledTimes(3));
    expect(state.update.mock.calls[2]![1]).toMatchObject({ _oma: { sandbox_image: null } });
  });

  it("keeps a since-removed alias visible instead of silently dropping it", async () => {
    state.images = [];
    state.environment = cloudEnvironment({ _oma: { sandbox_image: "retired" } });
    renderDetail();
    const select = await screen.findByLabelText("Image") as HTMLSelectElement;
    expect(select.value).toBe("retired");
    expect(screen.getByRole("option", { name: "retired (unavailable)" })).toBeInTheDocument();
    expect(screen.getByText(/no longer offered by the operator/)).toBeInTheDocument();
  });
});
