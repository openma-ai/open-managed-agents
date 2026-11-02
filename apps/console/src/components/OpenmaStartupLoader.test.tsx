import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { I18nProvider } from "../i18n";
import { EmptyState } from "./EmptyState";
import { Button } from "./ui/button";

it("uses the Backchat SVG for a page loading state, keeping its accessible label", () => {
  render(<I18nProvider><EmptyState loading size="lg" title="Loading agents" /></I18nProvider>);
  const status = screen.getByRole("status", { name: "Loading agents" });
  expect(status.tagName.toLowerCase()).toBe("svg");
  expect(status).toHaveAttribute("viewBox", "240 244 548 454");
  expect(status.querySelectorAll("path")).toHaveLength(3);
  expect(status.querySelectorAll("circle")).toHaveLength(3);
  expect(status).toHaveClass("text-brand");
});

it("keeps button loading compact and distinct from the page loader", () => {
  render(<Button loading>Save</Button>);
  expect(screen.getByRole("button")).toBeDisabled();
  expect(screen.getByRole("status").tagName.toLowerCase()).toBe("span");
});
