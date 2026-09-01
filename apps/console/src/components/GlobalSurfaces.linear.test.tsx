import { beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";

import { I18nProvider } from "../i18n";
import { CommandPalette } from "./CommandPalette";
import { Modal } from "./Modal";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

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

describe("Linear global surfaces", () => {
  it("anchors modals to a stable top edge with a transparent backdrop", () => {
    render(
      <Modal open onClose={() => undefined} title="Create agent" footer={<button>Save</button>}>
        Form
      </Modal>,
    );

    const dialog = screen.getByRole("dialog");
    const overlay = document.querySelector('[data-slot="dialog-overlay"]');
    const header = dialog.querySelector('[data-slot="dialog-header"]');
    const footer = dialog.querySelector('[data-slot="dialog-footer"]');

    expect(dialog).toHaveClass("top-[var(--overlay-top)]");
    expect(dialog).not.toHaveClass("-translate-y-1/2");
    expect(overlay).toHaveClass("bg-transparent");
    expect(header?.className).not.toContain("border-b");
    expect(footer?.className).not.toContain("border-t");
    expect(header).toHaveClass("px-6", "py-4");
    expect(dialog.querySelector('[data-console-modal-body]')).toHaveClass("px-6", "py-4");
    expect(footer).toHaveClass("px-6", "py-4");
  });

  it("keeps intent groups stable and does not print shortcut badges", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/agents"]}>
        <I18nProvider>
          <CommandPalette />
        </I18nProvider>
      </MemoryRouter>,
    );

    await user.keyboard("{Control>}k{/Control}");

    const headings = screen.getAllByText(/^(Recent|Actions|Navigate)$/).map((node) => node.textContent);
    expect(headings).toEqual(["Recent", "Actions", "Navigate"]);
    expect(document.querySelector('[data-slot="command-shortcut"]')).toBeNull();
  });

  it("uses the shared Linear action-row and popover geometry for menus", () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Archive</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    expect(document.querySelector('[data-slot="dropdown-menu-content"]'))
      .toHaveClass("rounded-[var(--console-radius-popover)]");
    expect(screen.getByRole("menuitem", { name: "Archive" }))
      .toHaveClass("h-[var(--menu-action-row-h)]");
  });
});
