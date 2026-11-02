import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../i18n";
import { Login } from "./Login";

const oauth2SignIn = vi.hoisted(() => vi.fn());
const authInfo = vi.hoisted(() => ({
  current: {} as {
    providers?: string[];
    oidc?: { id: string; name: string }[];
    email_password?: boolean;
  },
}));

vi.mock("../lib/auth", () => ({
  useAuth: () => ({ user: null, isLoading: false, isAuthenticated: false }),
}));

vi.mock("../lib/auth-client", () => ({
  authClient: { signIn: { oauth2: oauth2SignIn, social: vi.fn() } },
}));

vi.mock("../lib/useApiQuery", () => ({
  useApiQuery: () => ({
    data: { ...authInfo.current, turnstile_site_key: null },
    error: null,
    isLoading: false,
  }),
}));

function renderLogin(path = "/login") {
  // Login reads ?next= from window.location, not from the router.
  window.history.replaceState(null, "", path);
  return render(
    <MemoryRouter initialEntries={[path]}>
      <I18nProvider>
        <Login />
      </I18nProvider>
    </MemoryRouter>,
  );
}

describe("Login with deployment OIDC providers", () => {
  beforeEach(() => {
    oauth2SignIn.mockReset();
    oauth2SignIn.mockResolvedValue({ data: { url: "https://sso.example/authorize" }, error: null });
  });

  it("shows only the OIDC button when email and password are off", async () => {
    authInfo.current = { providers: [], oidc: [{ id: "corp", name: "Corp SSO" }], email_password: false };
    const user = userEvent.setup();
    renderLogin();

    const options = screen.getByRole("group", { name: "Sign in options" });
    const sso = within(options).getByRole("button", { name: "Continue with Corp SSO" });
    expect(within(options).queryByRole("button", { name: "Continue with email" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign up" })).toBeNull();

    await user.click(sso);
    expect(oauth2SignIn).toHaveBeenLastCalledWith({ providerId: "corp", callbackURL: "/" });
  });

  it("keeps email next to OIDC when the backend lists it", () => {
    authInfo.current = { providers: ["email"], oidc: [{ id: "corp", name: "Corp SSO" }], email_password: true };
    renderLogin();
    const options = screen.getByRole("group", { name: "Sign in options" });
    expect(within(options).getByRole("button", { name: "Continue with Corp SSO" })).toBeTruthy();
    expect(within(options).getByRole("button", { name: "Continue with email" })).toBeTruthy();
  });

  it("returns to the requested page after SSO", async () => {
    authInfo.current = { providers: [], oidc: [{ id: "corp", name: "Corp SSO" }], email_password: false };
    const user = userEvent.setup();
    renderLogin("/login?next=/agents");
    await user.click(screen.getByRole("button", { name: "Continue with Corp SSO" }));
    expect(oauth2SignIn).toHaveBeenLastCalledWith({ providerId: "corp", callbackURL: "/agents" });
  });

  it("shows the provider's error instead of failing silently", async () => {
    authInfo.current = { providers: [], oidc: [{ id: "corp", name: "Corp SSO" }], email_password: false };
    oauth2SignIn.mockResolvedValue({ data: null, error: { message: "Provider unavailable" } });
    const user = userEvent.setup();
    renderLogin();
    await user.click(screen.getByRole("button", { name: "Continue with Corp SSO" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Provider unavailable");
  });
});
