import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../i18n";
import { Login } from "../pages/Login";
import { Logo } from "../components/Logo";
import { DEFAULT_BRANDING, loadBranding, parseBranding, resetBrandingForTests, useBranding } from "./branding";

vi.mock("./auth", () => ({
  useAuth: () => ({ user: null, isLoading: false, isAuthenticated: false }),
}));
vi.mock("./useApiQuery", () => ({
  useApiQuery: () => ({
    data: { providers: ["email"], turnstile_site_key: null },
    error: null,
    isLoading: false,
  }),
}));

const ACME = {
  product_name: "Acme Agents",
  logo_url: "/branding/logo.svg",
  logo_dark_url: "/branding/logo-dark.svg",
  favicon_url: "/branding/favicon.png",
  stylesheet_url: "/branding/theme.css",
  login_title: "Sign in to Acme",
  login_subtitle: "Use your Acme account",
};

beforeEach(() => {
  document.head.innerHTML = '<title>Open Managed Agents</title><link rel="icon" href="/logo.svg" />';
  resetBrandingForTests();
});
afterEach(() => resetBrandingForTests());

function ProductName() {
  return <span data-testid="product">{useBranding().productName}</span>;
}

describe("console branding", () => {
  it("keeps same-origin paths only and falls back to the defaults", () => {
    const b = parseBranding({ ...ACME, logo_url: "https://evil.example/x.svg", favicon_url: "//evil.example/f.png" });
    expect(b.productName).toBe("Acme Agents");
    expect(b.logoUrl).toBeNull();
    expect(b.faviconUrl).toBeNull();
    expect(b.stylesheetUrl).toBe("/branding/theme.css");
    expect(parseBranding(null)).toEqual(DEFAULT_BRANDING);
    expect(parseBranding({}).productName).toBe("openma");
  });

  it("reads server-injected settings without a request", async () => {
    document.head.insertAdjacentHTML(
      "beforeend",
      `<meta name="oma-branding" content='${JSON.stringify(ACME)}' />`,
    );
    const fetchImpl = vi.fn();
    render(<ProductName />);
    await loadBranding(fetchImpl as never);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await screen.findByText("Acme Agents")).toBeInTheDocument();
  });

  it("fetches branding.json and applies title, favicon, and stylesheet", async () => {
    const fetchImpl = vi.fn(async () => Response.json(ACME));
    await loadBranding(fetchImpl as never);
    expect(fetchImpl).toHaveBeenCalledWith("/branding/branding.json", expect.anything());
    expect(document.title).toBe("Acme Agents");
    expect(document.querySelector('link[rel="icon"]')?.getAttribute("href")).toBe("/branding/favicon.png");
    expect(document.querySelectorAll('link[rel="icon"]')).toHaveLength(1);
    expect(document.querySelector("link[data-oma-branding]")?.getAttribute("href")).toBe("/branding/theme.css");
  });

  it("keeps the defaults when the deployment has no branding", async () => {
    await loadBranding((async () => Response.json({ error: "not found" }, { status: 404 })) as never);
    expect(document.title).toBe("Open Managed Agents");
    render(<ProductName />);
    expect(screen.getByTestId("product")).toHaveTextContent("openma");
    render(<Logo />);
    expect(screen.getByRole("img", { name: "openma" }).tagName.toLowerCase()).toBe("svg");
  });

  it("brands the logo and the sign-in page", () => {
    resetBrandingForTests(parseBranding(ACME));
    render(
      <MemoryRouter initialEntries={["/login"]}>
        <I18nProvider>
          <Login />
        </I18nProvider>
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { name: "Sign in to Acme" })).toBeInTheDocument();
    expect(screen.getByText("Use your Acme account")).toBeInTheDocument();
    const logos = screen.getAllByRole("img", { name: "Acme Agents" });
    expect(logos.map((l) => l.getAttribute("src"))).toEqual(["/branding/logo.svg", "/branding/logo-dark.svg"]);
    expect(logos[1]).toHaveClass("hidden", "dark:block");
  });

  it("uses the product name when no login copy is set", () => {
    resetBrandingForTests(parseBranding({ product_name: "Acme Agents" }));
    render(
      <MemoryRouter initialEntries={["/login"]}>
        <I18nProvider>
          <Login />
        </I18nProvider>
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { name: "Log in to Acme Agents" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Acme Agents" }).tagName.toLowerCase()).toBe("svg");
  });
});
