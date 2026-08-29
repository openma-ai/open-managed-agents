import { expect, test } from "@playwright/test";
import Anthropic from "@anthropic-ai/sdk";

const deployedBaseURL = process.env.OMA_E2E_BASE_URL?.replace(/\/$/, "");
const apiKey = process.env.OMA_E2E_API_KEY;
const turnModel = process.env.OMA_E2E_MODEL;
const managedAgentsBeta = "managed-agents-2026-04-01";

test.describe("deployed Console smoke", () => {
  test.skip(!deployedBaseURL, "OMA_E2E_BASE_URL is required for deployed smoke");

  test("serves the app and boots without browser errors", async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    const response = await page.goto(`${deployedBaseURL}/login`, {
      waitUntil: "networkidle",
    });
    expect(response?.status()).toBe(200);
    await expect(page.locator("#root")).not.toBeEmpty();
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
    expect(pageErrors).toEqual([]);
  });

  test("keeps API routes on the Worker instead of SPA fallback", async ({ request }) => {
    const response = await request.get(`${deployedBaseURL}/health`);
    expect(response.status()).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "ok" });
  });

  test("sends and renders a real Managed Agents turn", async ({ page }) => {
    test.skip(!apiKey || !turnModel, "OMA_E2E_API_KEY and OMA_E2E_MODEL are required");
    test.setTimeout(120_000);

    const client = new Anthropic({
      apiKey: apiKey!,
      baseURL: deployedBaseURL!,
      maxRetries: 0,
      timeout: 60_000,
    });
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let environment: { id: string } | undefined;
    let agent: { id: string; version: number } | undefined;
    let session: { id: string } | undefined;

    try {
      environment = await client.beta.environments.create({
        name: `console-e2e-environment-${suffix}`,
        scope: "organization",
        config: {
          type: "cloud",
          networking: { type: "unrestricted" },
          packages: { type: "packages" },
        },
      });
      agent = await client.beta.agents.create({
        name: `console-e2e-agent-${suffix}`,
        model: turnModel!,
        system: "Follow the user's exact response-format instruction.",
      });
      session = await client.beta.sessions.create({
        agent: { type: "agent", id: agent.id, version: agent.version },
        environment_id: environment.id,
        title: `console-e2e-session-${suffix}`,
      });

      // The test owns an API key rather than a browser login cookie. Mock only
      // Better Auth's session probe so AppShell renders; every product/API/SSE
      // request still hits the deployed Worker with the real API key.
      await page.route("**/auth/get-session**", async (route) => {
        const now = new Date();
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            session: {
              id: "console-e2e-browser-session",
              token: "console-e2e-browser-token",
              userId: "console-e2e-user",
              createdAt: now.toISOString(),
              updatedAt: now.toISOString(),
              expiresAt: new Date(now.getTime() + 60_000).toISOString(),
            },
            user: {
              id: "console-e2e-user",
              name: "Console E2E",
              email: "console-e2e@openma.test",
              emailVerified: true,
              createdAt: now.toISOString(),
              updatedAt: now.toISOString(),
            },
          }),
        });
      });
      await page.route("**/v1/**", async (route) => {
        await route.continue({
          headers: {
            ...route.request().headers(),
            "anthropic-beta": managedAgentsBeta,
            "x-api-key": apiKey!,
          },
        });
      });

      await page.goto(`${deployedBaseURL}/sessions/${session.id}`, {
        waitUntil: "domcontentloaded",
      });
      const composer = page.getByRole("textbox", { name: "Message" });
      await expect(composer).toBeVisible({ timeout: 30_000 });
      await composer.fill("Reply exactly E2E_UI_OK.");
      await page.getByRole("button", { name: "Send message" }).click();
      await expect(page.getByText("E2E_UI_OK", { exact: true })).toBeVisible({
        timeout: 90_000,
      });
    } finally {
      if (session) await client.beta.sessions.delete(session.id).catch(() => undefined);
      if (agent) await client.beta.agents.archive(agent.id).catch(() => undefined);
      if (environment) await client.beta.environments.delete(environment.id).catch(() => undefined);
    }
  });
});
