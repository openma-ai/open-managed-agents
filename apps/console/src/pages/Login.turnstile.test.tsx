import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { Login } from "./Login";

const sendCode = vi.hoisted(() => vi.fn(async () => ({ error: null })));
const signIn = vi.hoisted(() => vi.fn());
vi.mock("../lib/auth", () => ({ useAuth: () => ({ isLoading: false, isAuthenticated: false }) }));
vi.mock("../lib/auth-client", () => ({ authClient: { emailOtp: { sendVerificationOtp: sendCode }, signIn: { email: signIn } } }));
vi.mock("../lib/useApiQuery", () => ({ useApiQuery: () => ({
  data: { providers: ["email", "email-otp"], turnstile_site_key: "site-key" },
}) }));
afterEach(() => { delete window.turnstile; });

it("keeps verification immediately below submit while entering an email and waiting to send", async () => {
  const renderWidget = vi.fn<NonNullable<Window["turnstile"]>["render"]>(() => "widget-1");
  const remove = vi.fn();
  window.turnstile = { render: renderWidget, remove, reset: vi.fn() };
  const user = userEvent.setup();
  render(<MemoryRouter><I18nProvider><Login /></I18nProvider></MemoryRouter>);
  await user.click(screen.getByRole("button", { name: "Continue with email" }));
  await user.click(screen.getByRole("button", { name: "Sign in with email code" }));
  const verification = screen.getByRole("region", { name: "Security verification" });
  const submit = screen.getByRole("button", { name: "Send code" });
  expect(verification).toBeVisible();
  expect(submit.compareDocumentPosition(verification) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(verification.previousElementSibling).toBe(submit);
  expect(verification.closest("form")).toContainElement(submit);
  const accountOptions = screen.getByRole("group", { name: "Account options" });
  expect(verification.compareDocumentPosition(accountOptions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await waitFor(() => expect(renderWidget).toHaveBeenCalled());
  const countBeforeTyping = renderWidget.mock.calls.length;
  const challenge = renderWidget.mock.calls.at(-1)![1];
  await user.type(screen.getByLabelText("Email"), "person@example.com");
  expect(submit).toBeDisabled();
  await act(async () => { challenge.callback("verified-token"); });
  expect(submit).toBeEnabled();
  await user.click(submit);
  expect(renderWidget).toHaveBeenCalledTimes(countBeforeTyping);
  await waitFor(() => expect(sendCode).toHaveBeenCalledWith({
    email: "person@example.com", type: "sign-in",
    fetchOptions: { headers: { "cf-turnstile-token": "verified-token" } },
  }));
  expect(await screen.findByRole("heading", { name: "Enter your code" })).toBeVisible();
  expect(screen.getByRole("region", { name: "Security verification" })).toBeVisible();
  expect(renderWidget).toHaveBeenCalledTimes(countBeforeTyping);
  expect(window.turnstile.reset).toHaveBeenCalled();
  const resend = screen.getByRole("button", { name: "Resend" });
  expect(resend).toBeDisabled();
  await act(async () => { challenge.callback("resend-token"); });
  expect(resend).toBeEnabled();
  await user.click(resend);
  await waitFor(() => expect(sendCode).toHaveBeenCalledTimes(2));
  expect(sendCode).toHaveBeenLastCalledWith({
    email: "person@example.com", type: "sign-in",
    fetchOptions: { headers: { "cf-turnstile-token": "resend-token" } },
  });
});

it.each(["expired-callback", "error-callback", "timeout-callback", "unsupported-callback", "before-interactive-callback"])("disables sending when the official %s invalidates verification", async (event) => {
  const renderWidget = vi.fn<NonNullable<Window["turnstile"]>["render"]>(() => "widget-1");
  window.turnstile = { render: renderWidget, remove: vi.fn(), reset: vi.fn() };
  const user = userEvent.setup();
  render(<MemoryRouter><I18nProvider><Login /></I18nProvider></MemoryRouter>);
  await user.click(screen.getByRole("button", { name: "Continue with email" }));
  await user.click(screen.getByRole("button", { name: "Sign in with email code" }));
  await user.type(screen.getByLabelText("Email"), "person@example.com");
  await waitFor(() => expect(renderWidget).toHaveBeenCalled());
  const options = renderWidget.mock.calls.at(-1)![1];
  const submit = screen.getByRole("button", { name: "Send code" });
  await act(async () => { options.callback("verified-token"); });
  expect(submit).toBeEnabled();
  await act(async () => { (options as Record<string, any>)[event]?.("300030"); });
  expect(submit).toBeDisabled();
});

it("requires a new token for verification email after sign-in consumes its token", async () => {
  const renderWidget = vi.fn<NonNullable<Window["turnstile"]>["render"]>(() => "widget-1");
  window.turnstile = { render: renderWidget, remove: vi.fn(), reset: vi.fn() };
  signIn.mockResolvedValueOnce({ error: { code: "EMAIL_NOT_VERIFIED", message: "Email not verified" } });
  sendCode.mockClear();
  const user = userEvent.setup();
  render(<MemoryRouter><I18nProvider><Login /></I18nProvider></MemoryRouter>);
  await user.click(screen.getByRole("button", { name: "Continue with email" }));
  await user.type(screen.getByLabelText("Email"), "person@example.com");
  await user.type(screen.getByLabelText("Password"), "password1234");
  await waitFor(() => expect(renderWidget).toHaveBeenCalled());
  const options = renderWidget.mock.calls.at(-1)![1];
  await act(async () => options.callback("sign-in-token"));
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  expect(await screen.findByRole("heading", { name: "Verify your email" })).toBeVisible();
  expect(sendCode).not.toHaveBeenCalled();
  const resend = screen.getByRole("button", { name: "Resend" });
  expect(resend).toBeDisabled();
  await act(async () => options.callback("new-email-token"));
  await user.click(resend);
  expect(sendCode).toHaveBeenCalledExactlyOnceWith({ email: "person@example.com", type: "email-verification",
    fetchOptions: { headers: { "cf-turnstile-token": "new-email-token" } },
  });
});

it("does not reuse a prior widget's success after returning through the sign-in chooser", async () => {
  const renderWidget = vi.fn<NonNullable<Window["turnstile"]>["render"]>(() => "widget-1");
  window.turnstile = { render: renderWidget, remove: vi.fn(), reset: vi.fn() };
  const user = userEvent.setup();
  render(<MemoryRouter><I18nProvider><Login /></I18nProvider></MemoryRouter>);
  await user.click(screen.getByRole("button", { name: "Continue with email" }));
  await user.click(screen.getByRole("button", { name: "Sign in with email code" }));
  await user.type(screen.getByLabelText("Email"), "person@example.com");
  await waitFor(() => expect(renderWidget).toHaveBeenCalled());
  await act(async () => renderWidget.mock.calls.at(-1)![1].callback("old-token"));
  expect(screen.getByRole("button", { name: "Send code" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  await user.click(screen.getByRole("button", { name: "Back to sign in options" }));
  await user.click(screen.getByRole("button", { name: "Continue with email" }));
  await user.click(screen.getByRole("button", { name: "Sign in with email code" }));
  expect(screen.getByRole("button", { name: "Send code" })).toBeDisabled();
});
