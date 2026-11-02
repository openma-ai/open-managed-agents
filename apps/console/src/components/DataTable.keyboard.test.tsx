import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { DataTable } from "./DataTable";

function setup() {
  const open = vi.fn();
  const nestedAction = vi.fn();
  render(<MemoryRouter><I18nProvider><DataTable
    columns={[
      { accessorKey: "name", header: "Name" },
      { id: "action", header: "Action", cell: () => <button onClick={nestedAction}>Inspect</button> },
    ]}
    data={[{ id: "env-1", name: "Development" }]}
    getRowId={(item) => item.id}
    onRowClick={open}
  /></I18nProvider></MemoryRouter>);
  return { open, nestedAction, row: screen.getByText("Development").closest("tr")! };
}

describe("DataTable keyboard activation", () => {
  it.each(["{Enter}", " "])("opens a focused row once with %s, even without a context menu", async (key) => {
    const { row, open } = setup();
    expect(row).toHaveAttribute("tabindex", "0");
    row.focus();
    await userEvent.keyboard(key);
    expect(open).toHaveBeenCalledExactlyOnceWith({ id: "env-1", name: "Development" });
  });

  it("does not treat a child control's keydown or a held key as row activation", () => {
    const { row, open } = setup();
    fireEvent.keyDown(screen.getByRole("button", { name: "Inspect" }), { key: "Enter" });
    fireEvent.keyDown(row, { key: "Enter", repeat: true });
    fireEvent.keyDown(row, { key: "ArrowDown" });
    expect(open).not.toHaveBeenCalled();
  });

  it("keeps a child button's native Enter click from opening the row", async () => {
    const { open, nestedAction } = setup();
    screen.getByRole("button", { name: "Inspect" }).focus();
    await userEvent.keyboard("{Enter}");
    expect(nestedAction).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
  });
});
