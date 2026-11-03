import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { DataTable, type ColumnDef } from "./DataTable";
import { Table, TableBody, TableCell, TableRow } from "./ui/table";

const longText = "A deliberately long shared table label that must stay inside its cell";
afterEach(() => vi.restoreAllMocks());
function geometry() {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(100);
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.textContent === longText ? 300 : 40;
  });
}

describe("shared table text overflow", () => {
  it("TableCell explicitly opts plain strings and numbers in, leaving default content alone", () => {
    geometry();
    render(<Table><TableBody><TableRow>
      <TableCell textOverflow="play">{longText}</TableCell>
      <TableCell textOverflow="play">Short</TableCell>
      <TableCell textOverflow="play">42</TableCell>
      <TableCell>Unmanaged text</TableCell>
    </TableRow></TableBody></Table>);
    expect(screen.getByTitle(longText)).toHaveAttribute("tabindex", "0");
    expect(screen.getByTitle(longText).style.getPropertyValue("--overflow-text-travel")).toBe("-200px");
    expect(screen.getByTitle("Short")).not.toHaveAttribute("tabindex");
    expect(screen.getByTitle("42")).toHaveTextContent("42");
    expect(screen.queryByTitle("Unmanaged text")).toBeNull();
  });

  it("never animates or replaces complex interactive TableCell children", () => {
    geometry();
    const click = vi.fn();
    render(<Table><TableBody><TableRow><TableCell textOverflow="play">
      <button onClick={click}>{longText}</button><input type="checkbox" aria-label="Select item" /><span>active</span>
    </TableCell></TableRow></TableBody></Table>);
    fireEvent.click(screen.getByRole("button", { name: longText }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select item" }));
    expect(click).toHaveBeenCalledOnce();
    expect(screen.getByRole("checkbox")).toBeChecked();
    expect(screen.queryByTitle(longText)).toBeNull();
    expect(screen.getByText("active").closest("[data-overflow]")).toBeNull();
  });

  it("DataTable default text renderer shares overflow behavior for long/short strings and numbers without touching custom nodes", () => {
    geometry();
    type Row = { id: string; name: string; count: number };
    const click = vi.fn();
    const columns: ColumnDef<Row, unknown>[] = [
      { accessorKey: "name", header: "Name" },
      { accessorKey: "count", header: "Count" },
      { id: "actions", cell: () => <button onClick={click}>Inspect</button> },
      { id: "status", cell: () => <span>active</span> },
    ];
    render(<MemoryRouter><I18nProvider><DataTable<Row> columns={columns} data={[
      { id: "long", name: longText, count: 42 }, { id: "short", name: "Short", count: 0 },
    ]} getRowId={(row) => row.id} /></I18nProvider></MemoryRouter>);
    const table = screen.getByTestId("data-body-table");
    expect(within(table).getByTitle(longText)).toHaveAttribute("tabindex", "0");
    expect(within(table).getByTitle("Short")).not.toHaveAttribute("tabindex");
    expect(within(table).getByTitle("42")).toHaveTextContent("42");
    expect(within(table).getByTitle("0")).toHaveTextContent("0");
    fireEvent.click(within(table).getAllByRole("button", { name: "Inspect" })[0]);
    expect(click).toHaveBeenCalledOnce();
    expect(within(table).getAllByRole("button")[0].closest("[data-overflow]")).toBeNull();
    expect(within(table).getAllByText("active")[0].closest("[data-overflow]")).toBeNull();
  });
});
