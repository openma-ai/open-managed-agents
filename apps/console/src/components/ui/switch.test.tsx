import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Switch } from "./switch";

describe("Switch", () => {
  it("exposes its label and toggles using mouse, Space and Enter without submitting", async () => {
    const submit = vi.fn();
    function Example() {
      const [checked, setChecked] = useState(false);
      return <form onSubmit={submit}><label>Network access<Switch checked={checked} onCheckedChange={setChecked} /></label></form>;
    }
    render(<Example />);
    const user = userEvent.setup();
    const control = screen.getByRole("switch", { name: "Network access" });
    expect(control).toHaveAttribute("aria-checked", "false");
    await user.click(control);
    expect(control).toHaveAttribute("aria-checked", "true");
    await user.keyboard(" ");
    expect(control).toHaveAttribute("aria-checked", "false");
    await user.keyboard("{Enter}");
    expect(control).toHaveAttribute("aria-checked", "true");
    expect(submit).not.toHaveBeenCalled();
  });

  it("blocks state changes and keyboard focus when disabled", async () => {
    const change = vi.fn();
    render(<Switch aria-label="Disabled access" checked disabled onCheckedChange={change} />);
    const control = screen.getByRole("switch", { name: "Disabled access" });
    expect(control).toBeDisabled();
    await userEvent.click(control);
    await userEvent.tab();
    expect(control).not.toHaveFocus();
    expect(change).not.toHaveBeenCalled();
  });
});
