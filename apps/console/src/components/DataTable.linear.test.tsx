import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { I18nProvider } from "../i18n";
import { DataTable, type ColumnDef } from "./DataTable";

type Row = { id: string; name: string; status: string };

const columns: ColumnDef<Row, unknown>[] = [
  { accessorKey: "name", header: "Name", size: 240, enableHiding: false },
  { accessorKey: "status", header: "Status", size: 120 },
];

function renderTable() {
  return render(
    <MemoryRouter initialEntries={["/agents"]}>
      <I18nProvider>
        <DataTable<Row>
          columns={columns}
          data={[{ id: "agent-1", name: "Researcher", status: "active" }]}
          getRowId={(row) => row.id}
          searchValue=""
          onSearchChange={() => undefined}
        />
      </I18nProvider>
    </MemoryRouter>,
  );
}

describe("DataTable Linear list contract", () => {
  it("freezes the toolbar and column header outside the row scroller", () => {
    const styles = readFileSync(resolve(process.cwd(), "src/styles/console-list.css"), "utf8");
    renderTable();

    const listRoot = screen.getByTestId("data-table-list-root");
    const frozenHeader = within(listRoot).getByTestId("frozen-data-header");
    const toolbar = within(listRoot).getByRole("toolbar");
    const grid = within(listRoot).getByTestId("data-grid-viewport");

    expect(grid.parentElement).toBe(listRoot);
    expect(frozenHeader.parentElement).toBe(listRoot);
    expect(frozenHeader).toContainElement(toolbar);
    expect(frozenHeader.querySelector("thead")).not.toBeNull();
    expect(grid.querySelector("thead")).toBeNull();
    expect(frozenHeader.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(styles).toMatch(/\.console-list-root\s*\{[^}]*overflow: hidden;/);
    expect(styles).toMatch(/\.console-data-grid-viewport\s*\{[^}]*overflow: auto;/);
  });

  it("gives the toolbar extra breathing room above its controls", () => {
    const styles = readFileSync(resolve(process.cwd(), "src/styles/console-list.css"), "utf8");
    const tokens = readFileSync(resolve(process.cwd(), "src/styles/console-tokens.css"), "utf8");

    expect(tokens).toContain("--list-toolbar-pad-top: var(--console-pad-lg);");
    expect(tokens).toContain("--list-toolbar-pad-bottom: var(--console-gap-2xs);");
    expect(tokens).toContain("--list-toolbar-h: calc(var(--density-unit) * 44);");
    expect(styles).toContain(
      "padding-block: var(--list-toolbar-pad-top) var(--list-toolbar-pad-bottom);",
    );
  });

  it("uses matching colgroups for the frozen header and scrolling body", () => {
    const styles = readFileSync(resolve(process.cwd(), "src/styles/console-list.css"), "utf8");
    renderTable();

    const listRoot = screen.getByTestId("data-table-list-root");
    const headerTable = within(listRoot).getByTestId("data-header-table");
    const bodyTable = within(listRoot).getByTestId("data-body-table");
    const headerTrack = headerTable.parentElement;
    const bodyTrack = bodyTable.parentElement;
    const headerWidths = Array.from(headerTable.querySelectorAll("col"), (column) =>
      column.getAttribute("style"),
    );
    const bodyWidths = Array.from(bodyTable.querySelectorAll("col"), (column) =>
      column.getAttribute("style"),
    );

    expect(headerTable.querySelectorAll("thead th")).toHaveLength(2);
    expect(bodyTable.querySelectorAll("tbody tr:first-child td")).toHaveLength(2);
    expect(headerTrack).toHaveClass("console-data-track");
    expect(bodyTrack).toHaveClass("console-data-track");
    expect(headerTrack?.getAttribute("style")).toBe(
      "min-width: calc(360px + var(--list-frame-inset) + var(--list-frame-inset));",
    );
    expect(bodyTrack?.getAttribute("style")).toBe(headerTrack?.getAttribute("style"));
    expect(headerWidths).toEqual(["width: 240px;", "width: 120px;"]);
    expect(bodyWidths).toEqual(headerWidths);
    expect(styles).toMatch(/\.console-list-fixed-header\s*\{[^}]*flex: 0 0 auto;/);
    expect(styles).toMatch(/\.console-data-head-viewport\s*\{[^}]*overflow-x: hidden;/);
  });

  it("mirrors horizontal body scrolling into the frozen header", () => {
    renderTable();

    const frozenHeaderScroll = screen.getByTestId("data-header-scroll");
    const bodyScroll = screen.getByTestId("data-grid-viewport");
    Object.defineProperty(bodyScroll, "scrollLeft", {
      configurable: true,
      writable: true,
      value: 148,
    });

    fireEvent.scroll(bodyScroll);

    expect(frozenHeaderScroll.scrollLeft).toBe(148);
  });

  it("keeps the wireless table directly in the data scroller without generic row borders", () => {
    renderTable();

    const table = screen.getByTestId("data-body-table");
    expect(table.parentElement).toHaveClass("console-data-grid-cushion");

    const dataRow = table.querySelector("tbody tr");
    expect(dataRow).toHaveClass("console-data-row");
    expect(dataRow).not.toHaveClass("border-b");
  });

  it("hides native grid scrollbars without stealing the toolbar alignment track", () => {
    const styles = readFileSync(resolve(process.cwd(), "src/styles/console-list.css"), "utf8");

    expect(styles).toMatch(
      /\.console-data-grid-viewport\s*\{[^}]*overflow: auto;[^}]*scrollbar-width: none;/,
    );
    expect(styles).toMatch(
      /\.console-data-grid-viewport::-webkit-scrollbar\s*\{[^}]*width: 0;[^}]*height: 0;/,
    );
    expect(styles).toMatch(
      /\.console-list-toolbar\s*\{[^}]*padding-inline: var\(--list-frame-inset\);/,
    );
    expect(styles).toMatch(
      /\.console-data-track\s*\{[^}]*box-sizing: border-box;[^}]*padding-inline: var\(--list-frame-inset\);/,
    );
  });

  it("draws each wireless row as one separated pill", () => {
    const styles = readFileSync(resolve(process.cwd(), "src/styles/console-list.css"), "utf8");
    const tokens = readFileSync(resolve(process.cwd(), "src/styles/console-tokens.css"), "utf8");

    expect(tokens).toContain("--data-row-h: calc(var(--density-unit) * 36);");
    expect(tokens).toContain("--data-head-body-gap: var(--console-gap-lg);");
    expect(styles).toContain("border-spacing: 0 var(--data-row-gap)");
    expect(styles).toContain(
      "margin-top: calc(var(--data-head-body-gap) - var(--data-row-gap));",
    );
    expect(styles).toContain("background: var(--data-row-bg)");
    expect(styles).toContain("border-radius: var(--console-radius-row) 0 0 var(--console-radius-row)");
    expect(styles).toContain("border-radius: 0 var(--console-radius-row) var(--console-radius-row) 0");
  });

  it("keeps list controls and column labels out of accidental text selection", () => {
    const styles = readFileSync(resolve(process.cwd(), "src/styles/console-list.css"), "utf8");

    expect(styles).toMatch(
      /\.console-list-toolbar,\s*\.console-data-head\s*\{[^}]*-webkit-user-select: none;[^}]*user-select: none;/,
    );
  });

  it("shows frozen-header separation only while the data grid is scrolled", () => {
    renderTable();

    const frozenHeader = screen.getByTestId("frozen-data-header");
    const grid = screen.getByTestId("data-grid-viewport");
    expect(frozenHeader).toHaveAttribute("data-scrolled", "false");

    Object.defineProperty(grid, "scrollTop", { configurable: true, value: 24 });
    fireEvent.scroll(grid);
    expect(frozenHeader).toHaveAttribute("data-scrolled", "true");

    Object.defineProperty(grid, "scrollTop", { configurable: true, value: 0 });
    fireEvent.scroll(grid);
    expect(frozenHeader).toHaveAttribute("data-scrolled", "false");
  });

  it("opens row actions from the context menu without a visible action column", () => {
    const onEdit = vi.fn();
    render(
      <MemoryRouter initialEntries={["/agents"]}>
        <I18nProvider>
          <DataTable<Row>
            columns={columns}
            data={[{ id: "agent-1", name: "Researcher", status: "active" }]}
            getRowId={(row) => row.id}
            rowActions={() => [{ label: "Edit", onSelect: onEdit }]}
          />
        </I18nProvider>
      </MemoryRouter>,
    );

    const dataRow = screen.getByTestId("data-body-table").querySelector("tbody tr");
    expect(dataRow).not.toBeNull();
    if (!dataRow) throw new Error("Expected a body row");
    expect(dataRow).toHaveAttribute("tabindex", "0");
    fireEvent.contextMenu(dataRow);
    const item = screen.getByRole("menuitem", { name: "Edit" });
    fireEvent.click(item);

    expect(onEdit).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: /Row actions/i })).toBeNull();
  });
});
