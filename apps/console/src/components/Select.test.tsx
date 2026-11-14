import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, expect, it, vi } from "vitest";
import { Select, SelectOption } from "./Select";

beforeAll(() => { HTMLElement.prototype.scrollIntoView = vi.fn(); });

function LanguageSelect({ explicitLabel, disabled = false }: { explicitLabel?: string; disabled?: boolean }) {
  const [language, setLanguage] = useState("en");
  return <>
    <Select value={language} onValueChange={setLanguage} placeholder="Language" aria-label={explicitLabel} disabled={disabled}>
      <SelectOption value="en">English</SelectOption>
      <SelectOption value="zh">中文</SelectOption>
    </Select>
    <output aria-label="Selected language">{language}</output>
  </>;
}

it("preserves placeholder labelling and controlled selection for existing non-ACP consumers", async () => {
  render(<LanguageSelect />);
  const trigger = screen.getByRole("combobox", { name: "Language" });
  expect(trigger).toHaveTextContent("English");
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("option", { name: "中文" }));
  expect(trigger).toHaveTextContent("中文");
  expect(screen.getByLabelText("Selected language")).toHaveTextContent("zh");
});

it("uses an explicit accessible name without replacing the visible selected value", async () => {
  render(<LanguageSelect explicitLabel="Interface language" />);
  const trigger = screen.getByRole("combobox", { name: "Interface language" });
  expect(trigger).toHaveTextContent("English");
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("option", { name: "中文" }));
  expect(screen.getByLabelText("Selected language")).toHaveTextContent("zh");
});

it("preserves external label association and validation attributes when no placeholder is provided", () => {
  render(<>
    <label htmlFor="region">Region</label>
    <p id="region-help">Choose a region</p>
    <Select id="region" value="eu" onValueChange={() => {}} aria-describedby="region-help" aria-invalid>
      <SelectOption value="eu">Europe</SelectOption>
    </Select>
  </>);
  const trigger = screen.getByRole("combobox", { name: "Region" });
  expect(trigger).toHaveAccessibleDescription("Choose a region");
  expect(trigger).toHaveAttribute("aria-invalid", "true");
  expect(trigger).toHaveTextContent("Europe");
});

it("keeps disabled non-ACP selectors unavailable", () => {
  render(<LanguageSelect disabled />);
  expect(screen.getByRole("combobox", { name: "Language" })).toBeDisabled();
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Selected language")).toHaveTextContent("en");
});
