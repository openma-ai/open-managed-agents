import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Input } from "./input";
import { InputGroup, InputGroupInput } from "./input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select";
import { Textarea } from "./textarea";

describe("form control focus treatment", () => {
  it("uses a restrained one-pixel halo instead of the heavy three-pixel ring", () => {
    render(
      <>
        <Input aria-label="Email" />
        <Textarea aria-label="Notes" />
        <Select defaultValue="one">
          <SelectTrigger aria-label="Choice">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="one">One</SelectItem>
          </SelectContent>
        </Select>
        <InputGroup>
          <InputGroupInput aria-label="Search" />
        </InputGroup>
      </>,
    );

    for (const control of [
      screen.getByRole("textbox", { name: "Email" }),
      screen.getByRole("textbox", { name: "Notes" }),
      screen.getByRole("combobox", { name: "Choice" }),
    ]) {
      expect(control.className).toContain("focus-visible:ring-1");
      expect(control.className).not.toContain("focus-visible:ring-3");
    }

    const inputGroup = screen
      .getByRole("textbox", { name: "Search" })
      .closest('[data-slot="input-group"]');
    expect(inputGroup).toHaveClass(
      "has-[[data-slot=input-group-control]:focus-visible]:ring-1",
    );
    expect(inputGroup?.className).not.toContain(
      "has-[[data-slot=input-group-control]:focus-visible]:ring-3",
    );
  });
});
