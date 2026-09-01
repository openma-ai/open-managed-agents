import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { AppShell } from "./AppShell";

vi.mock("../lib/auth", () => ({
  useAuth: () => ({ isAuthenticated: true, isLoading: false }),
}));

vi.mock("./AppSidebar", () => ({
  AppSidebar: () => (
    <aside aria-label="Workspace navigation" data-sidebar="sidebar">
      Navigation
      <button
        type="button"
        aria-label="Sidebar portal menu"
        aria-expanded="false"
        data-sidebar-overlay-trigger
        onClick={(event) => event.currentTarget.setAttribute("aria-expanded", "true")}
      >
        Menu
      </button>
    </aside>
  ),
}));

vi.mock("./AppBreadcrumb", () => ({
  AppBreadcrumb: () => <nav aria-label="Breadcrumb">Agents</nav>,
}));

vi.mock("./CommandPalette", () => ({ CommandPalette: () => null }));
vi.mock("./NavigationProgress", () => ({ NavigationProgress: () => null }));

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

function renderShell() {
  return render(
    <MemoryRouter initialEntries={["/agents"]}>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="agents" element={<div>Agent list</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("AppShell Linear composition", () => {
  it("starts at Linear's 236px desktop navigation width", () => {
    renderShell();

    expect(document.querySelector("[data-console-shell]")).toHaveStyle({
      "--shell-sidebar-current-w": "236px",
    });
  });

  it("gives the tenant and breadcrumb track a shared 44px header rhythm", () => {
    const tokens = readFileSync(resolve(process.cwd(), "src/styles/console-tokens.css"), "utf8");
    const shell = readFileSync(resolve(process.cwd(), "src/styles/console-shell.css"), "utf8");

    expect(tokens).toContain("--shell-top-h: calc(var(--density-unit) * 44);");
    expect(shell).toContain("height: var(--shell-top-h);");
    expect(shell).toContain("flex: 0 0 var(--shell-top-h);");
  });

  it("gives breadcrumb text a distinct 14px medium header hierarchy", () => {
    const breadcrumb = readFileSync(resolve(process.cwd(), "src/components/ui/breadcrumb.tsx"), "utf8");

    expect(breadcrumb).toContain("gap-1.5 text-base");
    expect(breadcrumb).toContain('cn("font-medium text-foreground"');
  });

  it("places the breadcrumb on the shell header above the route surface", () => {
    renderShell();

    const surface = screen.getByTestId("console-route-surface");
    const workspace = surface.parentElement;
    const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(workspace).toHaveAttribute("data-shell-slot", "workspace");
    expect(screen.getByRole("complementary", { name: "Workspace navigation" }).closest("[data-shell-slot]"))
      .toHaveAttribute("data-shell-slot", "sidebar");
    expect(breadcrumb.closest(".console-topbar")?.parentElement).toBe(workspace);
    expect(surface.contains(breadcrumb)).toBe(false);
    expect(
      breadcrumb.closest(".console-topbar")?.compareDocumentPosition(surface) ?? 0,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(within(surface).getByText("Agent list")).toBeInTheDocument();
  });

  it("reveals one external restore control after the sidebar is hidden", async () => {
    const user = userEvent.setup();
    renderShell();

    expect(screen.queryByRole("button", { name: "Show sidebar" })).not.toBeInTheDocument();
    await user.keyboard("{Control>}\\{/Control}");

    expect(screen.getByRole("button", { name: "Show sidebar" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Show sidebar" })).toHaveLength(1);
  });

  it("keeps the hover preview open while a portaled sidebar menu is expanded", async () => {
    const user = userEvent.setup();
    renderShell();

    const shell = document.querySelector("[data-console-shell]");
    await user.keyboard("{Control>}\\{/Control}");
    await user.hover(document.querySelector(".console-sidebar-hover-zone") as HTMLElement);
    expect(shell).toHaveAttribute("data-sidebar-state", "desktop-preview");

    await user.click(screen.getByRole("button", { name: "Sidebar portal menu" }));
    fireEvent.mouseLeave(document.querySelector(".console-sidebar-rail") as HTMLElement);

    expect(shell).toHaveAttribute("data-sidebar-state", "desktop-preview");
  });

  it("latches the hover preview while a tenant trigger is opening its portaled menu", async () => {
    const user = userEvent.setup();
    renderShell();

    const shell = document.querySelector("[data-console-shell]");
    const rail = document.querySelector(".console-sidebar-rail") as HTMLElement;
    const trigger = screen.getByRole("button", { name: "Sidebar portal menu" });

    await user.keyboard("{Control>}\\{/Control}");
    await user.hover(document.querySelector(".console-sidebar-hover-zone") as HTMLElement);
    expect(shell).toHaveAttribute("data-sidebar-state", "desktop-preview");

    fireEvent.pointerDown(trigger);
    fireEvent.mouseLeave(rail);
    await user.click(trigger);

    expect(shell).toHaveAttribute("data-sidebar-state", "desktop-preview");
  });

  it("opens the folded sidebar from the left segment of the route topbar", async () => {
    const user = userEvent.setup();
    renderShell();

    const shell = document.querySelector("[data-console-shell]");
    await user.keyboard("{Control>}\\{/Control}");
    expect(shell).toHaveAttribute("data-sidebar-state", "desktop-hidden");

    fireEvent.pointerMove(document.querySelector("[data-top-row]") as HTMLElement, {
      clientX: 100,
    });

    expect(shell).toHaveAttribute("data-sidebar-state", "desktop-preview");
  });

  it("dims the workspace behind an open hover preview", async () => {
    const user = userEvent.setup();
    renderShell();

    const scrim = screen.getByTestId("sidebar-preview-scrim");
    expect(scrim).toHaveAttribute("data-open", "false");

    await user.keyboard("{Control>}\\{/Control}");
    await user.hover(document.querySelector(".console-sidebar-hover-zone") as HTMLElement);

    expect(scrim).toHaveAttribute("aria-hidden", "true");
    expect(scrim).toHaveAttribute("data-open", "true");
  });

  it("uses Linear's shortened hover-preview geometry instead of an even inset", () => {
    const tokens = readFileSync(resolve(process.cwd(), "src/styles/console-tokens.css"), "utf8");
    const shell = readFileSync(resolve(process.cwd(), "src/styles/console-shell.css"), "utf8");

    expect(tokens).toContain("--sidebar-preview-radius: var(--console-radius-sm)");
    expect(tokens).toContain("--sidebar-preview-top: calc(");
    expect(tokens).toContain("--sidebar-preview-left: calc(");
    expect(shell).toContain(
      "inset: var(--sidebar-preview-top) auto var(--sidebar-preview-bottom) var(--sidebar-preview-left)",
    );
    expect(shell).toContain('data-sidebar-state="desktop-full"] .console-sidebar');
    expect(shell).toContain("padding-block: var(--shell-stage-gap)");
    expect(shell).toContain("border-left: 1px solid var(--border-chrome)");
    expect(shell).toContain("grid-template-rows: minmax(0, 1fr)");
  });

  it("preserves horizontal browser history gestures across the route and data grid", () => {
    const shell = readFileSync(resolve(process.cwd(), "src/styles/console-shell.css"), "utf8");
    const list = readFileSync(resolve(process.cwd(), "src/styles/console-list.css"), "utf8");

    expect(shell).not.toContain("overscroll-behavior: contain;");
    expect(list).not.toContain("overscroll-behavior: contain;");
    expect(shell).toContain("overscroll-behavior-y: contain;");
    expect(list).toContain("overscroll-behavior-y: contain;");
  });

  it("does not reserve a hidden scrollbar gutter on the route canvas", () => {
    const shell = readFileSync(resolve(process.cwd(), "src/styles/console-shell.css"), "utf8");

    expect(shell).toMatch(
      /\.console-route-main\s*\{[^}]*overflow-y: auto;[^}]*scrollbar-width: none;/,
    );
    expect(shell).not.toContain("scrollbar-gutter: stable;");
    expect(shell).toMatch(
      /\.console-route-main::-webkit-scrollbar\s*\{[^}]*width: 0;[^}]*height: 0;/,
    );
  });
});
