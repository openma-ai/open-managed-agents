import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { I18nProvider } from "../i18n";
import { AppSidebar } from "./AppSidebar";
import { CommandPalette } from "./CommandPalette";

vi.mock("../lib/useApiQuery", () => ({
  useApiQuery: () => ({
    data: {
      data: [{ id: "tenant-1", name: "OpenMA Workspace", role: "owner" }],
    },
  }),
}));

vi.mock("./UserProfile", () => ({ UserProfile: () => null }));

beforeAll(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

function renderSidebar() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/sessions"]}>
        <I18nProvider>
          <AppSidebar />
          <CommandPalette />
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("AppSidebar tracks", () => {
  it("uses the tenant switcher as the first row without a brand row", async () => {
    const { container } = renderSidebar();
    const sidebar = screen.getByRole("complementary", { name: "Workspace navigation" });

    await waitFor(() => expect(screen.getByRole("button", { name: /Switch workspace|切换工作区/ })).toBeEnabled());
    expect(sidebar.firstElementChild).toHaveClass("console-sidebar-tenant");
    expect(container.querySelector(".console-sidebar-brand")).toBeNull();
  });

  it("keeps search beside the tenant switcher and opens the command palette", async () => {
    const user = userEvent.setup();
    const { container } = renderSidebar();

    const trigger = screen.getByRole("button", { name: /Command palette|命令面板/ });
    expect(trigger.closest(".console-sidebar-tenant")).not.toBeNull();
    expect(trigger).toHaveAttribute("data-sidebar-search");
    expect(container.querySelector(".console-sidebar-command")).toBeNull();
    expect(trigger.querySelector("kbd")).toBeNull();
    await user.click(trigger);

    expect(screen.getByRole("dialog", { name: /Command palette|命令面板/ })).toBeInTheDocument();
  });

  it("assigns every sidebar icon and label to the shared two-track grid", () => {
    renderSidebar();
    const sidebar = screen.getByRole("complementary", { name: "Workspace navigation" });
    const trackedRows = [
      screen.getByRole("button", { name: /Switch workspace|切换工作区/ }),
      ...within(sidebar).getAllByRole("link"),
    ];

    for (const row of trackedRows) {
      expect(row.querySelector('[data-sidebar-track="icon"]')).toBeInTheDocument();
      expect(row.querySelector('[data-sidebar-track="label"]')).toBeInTheDocument();
    }
    for (const heading of containerHeadings(sidebar)) {
      expect(heading).toHaveAttribute("data-sidebar-track", "label");
    }
  });

  it("keeps the tenant avatar on the exact shared icon track", () => {
    const tokens = readFileSync(resolve(process.cwd(), "src/styles/console-tokens.css"), "utf8");

    expect(tokens).toContain("--tenant-avatar-optical-x: 0px;");
  });

  it("uses the Linear template's exact sidebar section rhythm", () => {
    const tokens = readFileSync(resolve(process.cwd(), "src/styles/console-tokens.css"), "utf8");
    const shell = readFileSync(resolve(process.cwd(), "src/styles/console-shell.css"), "utf8");

    expect(tokens).toContain("--sidebar-pill-gap: var(--density-unit);");
    expect(tokens).toContain("--sidebar-section-gap: var(--console-pad-md);");
    expect(shell).toContain("padding: var(--console-pad-sm) var(--sidebar-frame-inset) var(--console-pad-md);");
    expect(shell).toContain(".console-sidebar-group-label + .console-sidebar-row");
    expect(shell).toContain("margin-top: var(--sidebar-pill-gap);");
  });

  it("prevents accidental text selection on global app chrome", () => {
    const shell = readFileSync(resolve(process.cwd(), "src/styles/console-shell.css"), "utf8");

    expect(shell).toContain(".console-shell :where(");
    expect(shell).toContain("nav a");
    expect(shell).toMatch(
      /\.console-sidebar,\s*\.console-topbar\s*\{[^}]*-webkit-user-select: none;[^}]*user-select: none;/,
    );
    expect(shell).toContain("-webkit-user-select: none;");
    expect(shell).toContain("user-select: none;");
  });

  it("keeps the primary route flat and labels only the later navigation groups", () => {
    renderSidebar();
    const sidebar = screen.getByRole("complementary", { name: "Workspace navigation" });
    const headings = containerHeadings(sidebar).map((heading) => heading.textContent);

    expect(screen.getByRole("link", { name: /Dashboard|仪表盘/ })).toBeInTheDocument();
    expect(headings).not.toContain("Overview");
    expect(headings).not.toContain("概览");
    expect(headings).toEqual(
      expect.arrayContaining([expect.stringMatching(/Managed Agents|托管智能体/)]),
    );
  });

  it("keeps the workspace menu compact instead of rendering tenant IDs as a second line", async () => {
    const user = userEvent.setup();
    renderSidebar();

    await user.click(
      screen.getByRole("button", { name: /Switch workspace|切换工作区/ }),
    );

    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("OpenMA Workspace")).toBeVisible();
    expect(within(menu).queryByText("tenant-1")).toBeNull();
  });
});

function containerHeadings(sidebar: HTMLElement) {
  return Array.from(sidebar.querySelectorAll(".console-sidebar-group-label"));
}
