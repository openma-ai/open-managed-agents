import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { expect, it } from "vitest";
import { I18nProvider } from "../i18n";
import { AppBreadcrumb } from "./AppBreadcrumb";

it("keeps the full long ID available and the parent breadcrumb usable", async () => {
  const id = "env_049a3e83d75c4dd792817a7a8bf5f1_audit_boundary";
  const router = createMemoryRouter([{
    path: "environments", handle: { crumb: "Environments" },
    element: <><AppBreadcrumb /><Outlet /></>, children: [
      { index: true, element: <h1>Environment list</h1> },
      { path: ":id", handle: { crumb: id }, element: <h1>Environment detail</h1> },
    ],
  }], { initialEntries: [`/environments/${id}`] });
  render(<I18nProvider><RouterProvider router={router} /></I18nProvider>);
  const current = screen.getByText(id);
  expect(current).toHaveAttribute("title", id);
  expect(current).toHaveAttribute("aria-current", "page");
  await userEvent.click(screen.getByRole("link", { name: "Environments" }));
  expect(await screen.findByRole("heading", { name: "Environment list" })).toBeVisible();
  router.dispose();
});
