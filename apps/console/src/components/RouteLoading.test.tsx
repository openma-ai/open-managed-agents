import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { expect, it } from "vitest";
import { RouteLoadError, RouteLoading } from "./RouteLoading";
import { I18nProvider } from "../i18n";

it("shows loading then a usable recovery screen when a route chunk fails", async () => {
  let rejectLoad!: (reason: Error) => void;
  const loading = new Promise<never>((_, reject) => { rejectLoad = reject; });
  const router = createMemoryRouter([{
    path: "/test-page",
    lazy: () => loading,
    ErrorBoundary: RouteLoadError,
    HydrateFallback: RouteLoading,
  }], { initialEntries: ["/test-page"] });
  render(<I18nProvider><RouterProvider router={router} /></I18nProvider>);
  expect(screen.getByRole("status", { name: "Loading page" })).toBeVisible();
  rejectLoad(new Error("Failed to fetch dynamically imported module"));
  expect(await screen.findByRole("heading", { name: "Couldn’t load this page" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Reload page" })).toBeEnabled();
  expect(screen.getByRole("link", { name: "Back to sign in" })).toHaveAttribute("href", "/login");
  router.dispose();
});
