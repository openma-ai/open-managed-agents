import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { Login } from "./Login";

const sendCode = vi.hoisted(() => vi.fn(async () => ({ error: null })));
vi.mock("../lib/auth", () => ({ useAuth: () => ({ isLoading: false, isAuthenticated: false }) }));
vi.mock("../lib/auth-client", () => ({ authClient: { emailOtp: { sendVerificationOtp: sendCode } } }));
vi.mock("../lib/useApiQuery", () => ({ useApiQuery: () => ({
  data: { providers: ["email", "email-otp"], turnstile_site_key: "site-key" },
}) }));
afterEach(() => { delete window.turnstile; });

it("keeps the visible challenge below submit alive while entering an email and waiting to send", async () => {
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
  await waitFor(() => expect(renderWidget).toHaveBeenCalled());
  const countBeforeTyping = renderWidget.mock.calls.length;
  const challenge = renderWidget.mock.calls.at(-1)![1];
  await user.type(screen.getByLabelText("Email"), "person@example.com");
  await user.click(submit);
  expect(renderWidget).toHaveBeenCalledTimes(countBeforeTyping);
  expect(sendCode).not.toHaveBeenCalled();
  await act(async () => { challenge.callback("verified-token"); });
  await waitFor(() => expect(sendCode).toHaveBeenCalledWith({
    email: "person@example.com", type: "sign-in",
    fetchOptions: { headers: { "cf-turnstile-token": "verified-token" } },
  }));
  expect(await screen.findByRole("heading", { name: "Enter your code" })).toBeVisible();
  expect(screen.getByRole("region", { name: "Security verification" })).toBeVisible();
  await waitFor(() => expect(renderWidget).toHaveBeenCalledTimes(countBeforeTyping + 1));
  const resendChallenge = renderWidget.mock.calls.at(-1)![1];
  await user.click(screen.getByRole("button", { name: "Resend" }));
  await act(async () => { resendChallenge.callback("resend-token"); });
  await waitFor(() => expect(sendCode).toHaveBeenCalledTimes(2));
  expect(sendCode).toHaveBeenLastCalledWith({
    email: "person@example.com", type: "sign-in",
    fetchOptions: { headers: { "cf-turnstile-token": "resend-token" } },
  });
});
