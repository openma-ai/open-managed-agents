import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { FilterChip } from "./FilterChip";
import { FacetedFilter } from "./FacetedFilter";
import { PopoverContent } from "@/components/ui/popover";

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

describe("FilterChip Linear pill contract", () => {
  it("keeps the active trigger and clear action in one visual pill", () => {
    render(
      <FilterChip label="Status" active display="Active" onClear={vi.fn()}>
        <div>Options</div>
      </FilterChip>,
    );

    const pill = screen.getByTestId("filter-chip");
    expect(pill).toHaveAttribute("data-active", "true");
    expect(pill).toContainElement(screen.getByRole("button", { name: /^Status:Active$/ }));
    expect(pill).toContainElement(screen.getByRole("button", { name: "Clear Status filter" }));
  });

  it("consumes the template's shared pill texture rather than nested button surfaces", () => {
    const styles = readFileSync(resolve(process.cwd(), "src/styles/console-list.css"), "utf8");

    expect(styles).toContain("height: var(--chip-h)");
    expect(styles).toContain("border: 1px solid var(--pill-border)");
    expect(styles).toContain("box-shadow: var(--pill-shadow)");
    expect(styles).toContain(".console-filter-chip > button");
    expect(styles).toContain("background: transparent");
  });

  it("only paints command rows whose selected value is true", () => {
    const command = readFileSync(resolve(process.cwd(), "src/components/ui/command.tsx"), "utf8");

    expect(command).toContain("data-[selected=true]:bg-muted");
    expect(command).not.toContain("data-selected:bg-muted");
  });

  it("uses 28px picker rows inside the shared 14px popover surface", async () => {
    const user = userEvent.setup();
    render(
      <FilterChip label="Status" active={false}>
        <PopoverContent>
          <FacetedFilter
            options={[{ value: "active", label: "Active" }]}
            value=""
            onValueChange={() => undefined}
          />
        </PopoverContent>
      </FilterChip>,
    );

    await user.click(screen.getByRole("button", { name: /^Status$/ }));
    expect(document.querySelector('[data-slot="popover-content"]'))
      .toHaveClass("rounded-[var(--console-radius-popover)]");
    expect(screen.getByRole("option", { name: "Active" }))
      .toHaveClass("h-[var(--menu-picker-row-h)]");
  });
});
