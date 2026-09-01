import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../i18n";
import { Login } from "./Login";

const socialSignIn = vi.hoisted(() => vi.fn());

vi.mock("../lib/auth", () => ({
  useAuth: () => ({
    user: null,
    isLoading: false,
    isAuthenticated: false,
  }),
}));

vi.mock("../lib/auth-client", () => ({
  authClient: {
    signIn: {
      social: socialSignIn,
    },
  },
}));

vi.mock("../lib/useApiQuery", () => ({
  useApiQuery: () => ({
    data: {
      providers: ["email", "email-otp", "google", "github"],
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

describe("Login OAuth and layout", () => {
  beforeEach(() => {
    socialSignIn.mockReset();
  });

  it("offers configured Google and GitHub sign-in through Better Auth", async () => {
    const user = userEvent.setup();
    renderLogin();

    const signInOptions = screen.getByRole("group", {
      name: "Sign in options",
    });
    const google = within(signInOptions).getByRole("button", {
      name: "Continue with Google",
    });
    const github = within(signInOptions).getByRole("button", {
      name: "Continue with GitHub",
    });

    await user.click(google);
    expect(socialSignIn).toHaveBeenLastCalledWith({
      provider: "google",
      callbackURL: "/",
    });

    await user.click(github);
    expect(socialSignIn).toHaveBeenLastCalledWith({
      provider: "github",
      callbackURL: "/",
    });
  });

  it("reveals the email form only after the user chooses email", async () => {
    const user = userEvent.setup();
    const { container } = renderLogin();

    expect(
      screen.getByRole("heading", { name: "Log in to openma" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("complementary", { name: "Openma platform story" }),
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Continue with email" }),
    );

    expect(
      screen.getByRole("heading", { name: "Log in with email" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();

    const passwordField = container.querySelector(
      '[data-login-field="password"]',
    );
    expect(passwordField).not.toBeNull();
    expect(
      within(passwordField as HTMLElement).getByText("Password").parentElement,
    ).toContainElement(
      within(passwordField as HTMLElement).getByRole("button", {
        name: "Forgot password?",
      }),
    );

    const actions = screen.getByRole("group", { name: "Sign in actions" });
    expect(within(actions).getByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(
      within(actions).getByRole("button", {
        name: "Sign in with email code",
      }),
    ).toBeInTheDocument();

    expect(
      screen.getByRole("button", { name: "Back to sign in options" }),
    ).toBeInTheDocument();
  });

  it("opens account creation from the quiet chooser footer", async () => {
    const user = userEvent.setup();
    renderLogin();

    const footer = screen.getByRole("group", { name: "Account options" });
    expect(within(footer).getByText("Don't have an account?")).toBeInTheDocument();

    await user.click(within(footer).getByRole("button", { name: "Sign up" }));

    expect(
      screen.getByRole("heading", { name: "Create your account" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
  });
});
