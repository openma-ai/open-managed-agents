import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { createPortal } from "react-dom";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { ConsoleShell } from "./ConsoleShell";

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

afterEach(() => {
  window.getSelection()?.removeAllRanges();
});

/** Sidebar stand-in carrying the control shapes that live in real chrome:
 * a TenantSwitcher-like trigger, nav link, search field, and a portal menu
 * and dialog opened from the sidebar (Radix renders both into body). */
function Sidebar() {
  return (
    <aside aria-label="Workspace navigation" className="console-sidebar">
      <button type="button" aria-label="Switch workspace" data-sidebar-overlay-trigger>
        <span>OpenMA Workspace</span>
      </button>
      <nav>
        <a href="/agents">Agents</a>
      </nav>
      <input aria-label="Sidebar filter" />
      {createPortal(
        <div role="menu">
          <div role="menuitem">Other workspace</div>
        </div>,
        document.body,
      )}
      {createPortal(
        <div role="dialog" aria-label="Create workspace">
          <p>Dialog copy</p>
        </div>,
        document.body,
      )}
    </aside>
  );
}

function renderShell() {
  return render(
    <ConsoleShell
      sidebar={<Sidebar />}
      breadcrumb={
        <nav aria-label="Breadcrumb">
          <button type="button">Dashboard</button>
        </nav>
      }
      pageHeaderSlotRef={() => {}}
    >
      <h1>Get started with Managed Agents</h1>
      <input aria-label="Route search" />
    </ConsoleShell>,
  );
}

/** fireEvent returns false when a handler called preventDefault(). */
function mouseDownPrevented(element: Element, init: MouseEventInit = {}) {
  return !fireEvent.mouseDown(element, { button: 0, ...init });
}

function selectRouteTitle() {
  const title = screen.getByRole("heading", { name: /Get started/ });
  const range = document.createRange();
  range.selectNodeContents(title);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  expect(selection.isCollapsed).toBe(false);
  return selection;
}

describe("ConsoleShell chrome pointer guard", () => {
  it("cancels mousedown selection on every sidebar and topbar control", () => {
    renderShell();

    const chromeTargets = [
      screen.getByText("OpenMA Workspace"),
      screen.getByRole("button", { name: "Switch workspace" }),
      screen.getByRole("link", { name: "Agents" }),
      screen.getByRole("complementary", { name: "Workspace navigation" }),
      screen.getByRole("button", { name: "Resize sidebar" }),
      screen.getByRole("button", { name: "Dashboard" }),
      document.querySelector(".console-topbar")!,
      screen.getByRole("menuitem", { name: "Other workspace" }),
    ];
    for (const target of chromeTargets) {
      expect(mouseDownPrevented(target), target.outerHTML).toBe(true);
      // Double and triple clicks are what snap a word/paragraph selection
      // into the adjacent route title.
      expect(mouseDownPrevented(target, { detail: 2 })).toBe(true);
      expect(mouseDownPrevented(target, { detail: 3 })).toBe(true);
    }
  });

  it("guards the collapsed-sidebar hover zone and preview overlay", () => {
    renderShell();
    fireEvent.keyDown(window, { key: "\\", ctrlKey: true });

    const hoverZone = document.querySelector(".console-sidebar-hover-zone")!;
    expect(hoverZone).toHaveAttribute("data-console-chrome");
    expect(mouseDownPrevented(hoverZone)).toBe(true);

    fireEvent.mouseEnter(hoverZone);
    expect(document.querySelector("[data-console-shell]")).toHaveAttribute(
      "data-sidebar-state",
      "desktop-preview",
    );
    expect(mouseDownPrevented(screen.getByText("OpenMA Workspace"))).toBe(true);
    expect(mouseDownPrevented(screen.getByRole("button", { name: "Show sidebar" }))).toBe(true);
  });

  it("clears a lingering route selection when chrome is pressed", () => {
    renderShell();

    const selection = selectRouteTitle();
    fireEvent.mouseDown(screen.getByRole("button", { name: "Switch workspace" }), { button: 0 });
    expect(selection.isCollapsed).toBe(true);

    selectRouteTitle();
    fireEvent.mouseDown(screen.getByRole("button", { name: "Dashboard" }), { button: 0 });
    expect(selection.isCollapsed).toBe(true);
  });

  it("keeps route content, editable fields and dialogs native", () => {
    renderShell();

    const title = screen.getByRole("heading", { name: /Get started/ });
    expect(mouseDownPrevented(title)).toBe(false);
    expect(mouseDownPrevented(title, { detail: 2 })).toBe(false);
    expect(mouseDownPrevented(screen.getByRole("textbox", { name: "Route search" }))).toBe(false);
    expect(mouseDownPrevented(screen.getByRole("textbox", { name: "Sidebar filter" }))).toBe(false);
    expect(mouseDownPrevented(screen.getByText("Dialog copy"))).toBe(false);
    // Secondary buttons keep native context-menu behavior.
    expect(
      mouseDownPrevented(screen.getByRole("link", { name: "Agents" }), { button: 2 }),
    ).toBe(false);

    const selection = selectRouteTitle();
    fireEvent.mouseDown(title, { button: 0 });
    expect(selection.isCollapsed).toBe(false);
  });

  it("marks every shell chrome slot and keeps the CSS contract in sync", () => {
    renderShell();

    expect(document.querySelector('[data-shell-slot="sidebar"]')).toHaveAttribute(
      "data-console-chrome",
    );
    expect(document.querySelector(".console-topbar")).toHaveAttribute("data-console-chrome");
    expect(screen.getByTestId("console-route-surface").closest("[data-console-chrome]")).toBeNull();

    const shell = readFileSync(resolve(process.cwd(), "src/styles/console-shell.css"), "utf8");
    expect(shell).toMatch(
      /\.console-sidebar,\s*\.console-topbar,\s*\[data-console-chrome\]\s*\{[^}]*user-select: none;/,
    );
  });
});
