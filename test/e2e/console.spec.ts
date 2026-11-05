import { test, expect, type Page } from "@playwright/test";

/**
 * Local real-backend Console E2E.
 *
 * Prerequisites:
 *   - main-node (or equivalent) on :8787 with Better Auth enabled
 *     (AUTH_DISABLED unset) and a working signup path — email OTP is
 *     NOT required unless AUTH_REQUIRE_EMAIL_VERIFY=1
 *   - vite on :5173 (playwright.config starts `pnpm run dev:console`)
 *
 * When OMA_E2E_REQUIRE_BACKEND=1 (CI), a missing backend fails the suite
 * instead of skipping.
 *
 * Run:
 *   pnpm exec playwright test test/e2e/console.spec.ts
 */

const TEST_PASSWORD = "e2e-testpass-123";
const TEST_NAME = "E2E Tester";
const requireBackend = process.env.OMA_E2E_REQUIRE_BACKEND === "1" || process.env.CI === "true";

async function requireLocalBackend(page: Page) {
  const health = await page.request.get("http://127.0.0.1:8787/health").catch(() => null);
  if (!health?.ok()) {
    const message = "Local backend (main-node on :8787) is not reachable";
    if (requireBackend) throw new Error(message);
    test.skip(true, message);
  }
}

async function signup(page: Page): Promise<string> {
  const email = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.openma.dev`;
  await page.goto("/");
  await page.waitForURL("**/login");

  // Chooser → Sign up (Login.tsx mode="chooser" exposes Sign up directly).
  await page.getByRole("button", { name: "Sign up" }).click();
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();

  await page.getByPlaceholder("Your name").fill(TEST_NAME);
  await page.getByPlaceholder("you@example.com").fill(email);
  await page.getByPlaceholder("Min 8 characters").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();

  await page.waitForURL("**/", { timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "Get started with openma" })).toBeVisible();
  return email;
}

async function signOut(page: Page) {
  // Sign out lives under the sidebar "Account menu" dropdown (UserProfile.tsx).
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await page.waitForURL("**/login", { timeout: 10_000 });
}

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Continue with email" }).click();
  await page.getByPlaceholder("you@example.com").fill(email);
  await page.getByPlaceholder("Min 8 characters").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/", { timeout: 15_000 });
}

test.describe("Console E2E", () => {
  test.skip(Boolean(process.env.OMA_E2E_BASE_URL), "Local suite; deployed runs use deployed-console*.spec.ts");

  test.beforeEach(async ({ page }) => {
    await requireLocalBackend(page);
  });

  test("1. unauthenticated user is redirected to /login", async ({ page }) => {
    await page.goto("/");
    await page.waitForURL("**/login");
    await expect(page.getByRole("heading", { name: "Log in to openma" })).toBeVisible();
  });

  test("2. signup creates account and redirects to dashboard", async ({ page }) => {
    const email = await signup(page);
    // Account menu owns the display name; workspace switcher also contains TEST_NAME ("…'s workspace").
    await expect(page.getByRole("button", { name: "Account menu" })).toContainText(TEST_NAME);
    await expect(page.getByText(email)).toBeVisible();
  });

  test("3. logout returns to login page", async ({ page }) => {
    await signup(page);
    await signOut(page);
    await expect(page.getByRole("heading", { name: "Log in to openma" })).toBeVisible();
  });

  test("4. login with existing account", async ({ page }) => {
    const email = await signup(page);
    await signOut(page);
    await login(page, email);
    await expect(page.getByRole("heading", { name: "Get started with openma" })).toBeVisible();
  });

  // Dropped: "forgot password" needs a configured SEND_EMAIL binding.
  // Without it the Console stays on "Reset password" with "Authentication failed".

  test("6. API Keys page — create and revoke", async ({ page }) => {
    await signup(page);
    await page.getByRole("link", { name: "API Keys" }).click();
    await expect(page.getByRole("navigation", { name: "breadcrumb" }).getByText("API Keys")).toBeVisible();

    await page.getByTestId("frozen-data-header").getByRole("button", { name: "+ New API key" }).click();
    await page.getByPlaceholder("e.g. CLI key, CI/CD").fill("Test E2E Key");
    await page.getByRole("button", { name: "Create" }).click();

    await expect(page.getByText("API Key Created")).toBeVisible();
    await expect(page.locator("code").filter({ hasText: "oma_" })).toBeVisible();
    await page.getByRole("button", { name: "Done" }).click();
    await expect(page.getByText("Test E2E Key")).toBeVisible();

    page.on("dialog", (d) => d.accept());
    // Row actions moved to the row context menu (no inline Revoke button).
    await page.getByRole("row", { name: /Test E2E Key/ }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Revoke" }).click();
    await expect(page.getByText("No API keys yet")).toBeVisible({ timeout: 5_000 });
  });

  test("7. Model Cards page — create with provider selection", async ({ page }) => {
    await signup(page);
    await page.getByRole("link", { name: "Model Cards" }).click();
    await expect(page.getByRole("navigation", { name: "breadcrumb" }).getByText("Model Cards")).toBeVisible();

    await page.getByTestId("frozen-data-header").getByRole("button", { name: "+ New model card" }).click();
    await expect(page.getByRole("heading", { name: "New Model Card" })).toBeVisible();

    await page.getByRole("button", { name: /DeepSeek/ }).click();
    await page.locator("#modelcard-id").fill("e2e-deepseek-chat");
    await page.locator("#modelcard-api-key").fill("sk-test-fake-key-12345678");
    await page.locator("#modelcard-wire-model").fill("deepseek-chat");
    await page.locator("#modelcard-base-url").fill("https://api.deepseek.com/v1");
    await page.getByRole("button", { name: "Create" }).click();

    await expect(page.getByText("e2e-deepseek-chat")).toBeVisible({ timeout: 15_000 });
  });

  test("8. Skills page — Install from URL dialog", async ({ page }) => {
    await signup(page);
    await page.getByRole("link", { name: "Skills" }).click();
    await expect(page.getByRole("navigation", { name: "breadcrumb" }).getByText("Skills")).toBeVisible();

    // ClawHub was removed; Install from URL is the current install entrypoint.
    await page.getByTestId("frozen-data-header").getByRole("button", { name: "Install from URL" }).click();
    await expect(page.getByRole("dialog", { name: "Install skills from a URL" })).toBeVisible();
  });

  test("9. Navigation — all sidebar links work", async ({ page }) => {
    await signup(page);

    // Most list pages no longer render an h1 title; AppBreadcrumb is the
    // stable page identity. Deployments still has an h1 via DataTable subtitle.
    const links = [
      { name: "Agents", crumb: "Agents" },
      { name: "Sessions", crumb: "Sessions" },
      { name: "Deployments", crumb: "Deployments", heading: "Deployments" },
      { name: "Environments", crumb: "Environments" },
      { name: "Credential Vaults", crumb: "Credential Vaults" },
      { name: "Skills", crumb: "Skills" },
      { name: "Memory Stores", crumb: "Memory Stores" },
      { name: "Model Cards", crumb: "Model Cards" },
      { name: "API Keys", crumb: "API Keys" },
    ];

    for (const link of links) {
      await page.getByRole("link", { name: link.name }).click();
      await expect(
        page.getByRole("navigation", { name: "breadcrumb" }).getByText(link.crumb, { exact: true }),
      ).toBeVisible({ timeout: 5_000 });
      if (link.heading) {
        await expect(page.getByRole("heading", { name: link.heading })).toBeVisible();
      }
    }
  });

  test("10. Model Card form always exposes Base URL and Custom Headers", async ({ page }) => {
    await signup(page);
    await page.getByRole("link", { name: "Model Cards" }).click();
    await page.getByTestId("frozen-data-header").getByRole("button", { name: "+ New model card" }).click();
    await expect(page.getByRole("heading", { name: "New Model Card" })).toBeVisible();

    // Provider-gated Base URL / Custom Headers was removed; both are always optional.
    await expect(page.locator("#modelcard-base-url")).toBeVisible();
    await expect(page.getByText("Custom Headers")).toBeVisible();
    await page.getByRole("button", { name: /DeepSeek/ }).click();
    await expect(page.locator("#modelcard-base-url")).toBeVisible();
    await expect(page.getByText("Custom Headers")).toBeVisible();
  });
});
