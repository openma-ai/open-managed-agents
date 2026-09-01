import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../i18n";
import { Login } from "./Login";

vi.mock("../lib/auth", () => ({
  useAuth: () => ({
    user: null,
    isLoading: false,
    isAuthenticated: false,
  }),
}));

vi.mock("../lib/useApiQuery", () => ({
  useApiQuery: () => ({
    data: {
      providers: [],
      turnstile_site_key: null,
    },
    error: null,
    isLoading: false,
  }),
}));

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={["/login"]}>
      <I18nProvider>
        <Login />
      </I18nProvider>
    </MemoryRouter>,
  );
}

function expectMatureFormControls(container: HTMLElement) {
  const inputs = Array.from(container.querySelectorAll("input"));
  const labels = Array.from(container.querySelectorAll("label"));
  const buttons = Array.from(container.querySelectorAll("button"));

  expect(inputs.length).toBeGreaterThan(0);
  expect(labels.length).toBeGreaterThan(0);
  expect(buttons.length).toBeGreaterThan(0);

  for (const input of inputs) expect(input).toHaveAttribute("data-slot", "input");
  for (const label of labels) expect(label).toHaveAttribute("data-slot", "label");
  for (const button of buttons) expect(button).toHaveAttribute("data-slot", "button");
}

function expectMatureButtons(container: HTMLElement) {
  const buttons = Array.from(container.querySelectorAll("button"));
  expect(buttons.length).toBeGreaterThan(0);
  for (const button of buttons) expect(button).toHaveAttribute("data-slot", "button");
}

describe("Login mature component contract", () => {
  it("uses the shared field, input, and button primitives in every v1 auth mode", async () => {
    const user = userEvent.setup();
    const { container } = renderLogin();

    expectMatureButtons(container);
    await user.click(screen.getByRole("button", { name: "Continue with email" }));
    expectMatureFormControls(container);

    await user.click(screen.getByRole("button", { name: "Sign up" }));
    expectMatureFormControls(container);

    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await user.click(screen.getByRole("button", { name: "Sign in with email code" }));
    expectMatureFormControls(container);
  });
});
