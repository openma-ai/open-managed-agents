// Model cards probe their upstream on creation. Validate before any API call.
import { assertAllowedTestModel } from "../../../scripts/lib/test-model-allowlist.mjs";
import { expect, type Page } from "@playwright/test";

/**
 * Shared real-backend Console Deployments flow used by the local
 * (`console-deployments.spec.ts`) and deployed/certification
 * (`deployed-console-deployments.spec.ts`) suites.
 *
 * Nothing here mocks `/v1/deployments*`: the browser drives the real Console
 * against the real Worker, and the API seeder uses the same identity as the
 * browser (session cookie locally, `x-api-key` when deployed).
 */

export type ApiCall = <T = unknown>(method: string, path: string, body?: unknown) => Promise<T>;

export interface DeploymentsFlowOptions {
  page: Page;
  api: ApiCall;
  /** Absolute origin when deployed; empty string for the local baseURL. */
  origin: string;
  model: string;
  /**
   * When set (release certification), register a Model Card pointing at the
   * deterministic mock LLM and use it for the seeded agent, mirroring
   * deployed-console.spec.ts.
   */
  mockModelBaseURL?: string;
}

export async function runDeploymentsFlow({ page, api, origin, model, mockModelBaseURL }: DeploymentsFlowOptions) {
  assertAllowedTestModel(undefined, model);
  assertAllowedTestModel("ant-compatible", "openma-e2e-mock");
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const agentName = `console-e2e-deploy-agent-${suffix}`;
  const environmentName = `console-e2e-deploy-env-${suffix}`;
  const deploymentName = `console-e2e-deployment-${suffix}`;
  const initialMessage = `Reply exactly E2E_DEPLOYMENT_OK ${suffix}.`;

  let environment: { id: string } | undefined;
  let agent: { id: string } | undefined;
  let deploymentId: string | undefined;
  let modelCard: { id: string; model_id: string } | undefined;
  const pageErrors: string[] = [];
  const apiFailures: Array<{ method: string; path: string; status: number }> = [];
  const cleanupErrors: unknown[] = [];

  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith("/v1/") && response.status() >= 400) {
      apiFailures.push({ method: response.request().method(), path: url.pathname, status: response.status() });
    }
  });

  try {
    if (mockModelBaseURL) {
      modelCard = await api<{ id: string; model_id: string }>("POST", "/v1/oma/model_cards", {
        model_id: `console-e2e-deploy-mock-${suffix}`,
        model: "openma-e2e-mock",
        provider: "ant-compatible",
        api_key: "openma-e2e-mock-key",
        base_url: mockModelBaseURL,
      });
    }
    // Prerequisites seeded through the public API (same shape as the
    // managed-agents integration suite): a self-hosted environment needs no
    // sandbox build, so a manual run can start a session immediately.
    environment = await api<{ id: string }>("POST", "/v1/environments", {
      name: environmentName,
      scope: "organization",
      config: { type: "self_hosted" },
    });
    agent = await api<{ id: string }>("POST", "/v1/agents", {
      name: agentName,
      model: modelCard?.model_id ?? model,
      system: "Follow the user's exact response-format instruction.",
    });

    // ── list → create ────────────────────────────────────────────────
    await page.goto(`${origin}/deployments`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1, name: "Deployments" })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Create deployment" }).first().click();
    await page.waitForURL("**/deployments/new");
    await expect(page.getByRole("heading", { level: 1, name: "Create deployment" })).toBeVisible();

    await page.getByLabel("Name").fill(deploymentName);
    await page.getByRole("combobox", { name: "Agent" }).click();
    await page.getByRole("option", { name: new RegExp(escapeRegExp(agentName)) }).click();
    await page.getByRole("combobox", { name: "Environment" }).click();
    await page.getByRole("option", { name: new RegExp(escapeRegExp(environmentName)) }).click();
    await page.getByLabel("Initial message").fill(initialMessage);
    await expect(page.getByRole("tab", { name: "Manual" })).toHaveAttribute("aria-selected", "true");

    const createResponse = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/v1/deployments" && response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Create deployment" }).click();
    const created = await createResponse;
    expect(created.status(), await created.text()).toBeLessThan(300);
    deploymentId = ((await created.json()) as { id: string }).id;
    expect(deploymentId).toMatch(/^depl_/);

    // ── detail ───────────────────────────────────────────────────────
    await page.waitForURL(`**/deployments/${deploymentId}`);
    await expect(page.getByRole("heading", { level: 1, name: deploymentName })).toBeVisible();
    await expect(page.getByTestId("detail-body").getByText(deploymentId, { exact: true })).toBeVisible();
    await expect(page.getByText(initialMessage, { exact: true })).toBeVisible();
    await expect(page.getByText(/No runs yet/)).toBeVisible();

    const persisted = await api<{ name: string; agent: { id: string }; environment_id: string }>(
      "GET",
      `/v1/deployments/${deploymentId}`,
    );
    expect(persisted).toMatchObject({ name: deploymentName, agent: { id: agent.id }, environment_id: environment.id });

    // ── list shows the new deployment and opens it ───────────────────
    await page.goto(`${origin}/deployments`, { waitUntil: "domcontentloaded" });
    await page.getByPlaceholder("Search by name or exact ID").fill(deploymentName);
    const row = page.getByRole("row", { name: new RegExp(escapeRegExp(deploymentName)) });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row.getByText(agentName)).toBeVisible();
    await expect(row.getByText("Manual")).toBeVisible();
    await row.getByText(deploymentName).click();
    await page.waitForURL(`**/deployments/${deploymentId}`);
    await expect(page.getByRole("heading", { level: 1, name: deploymentName })).toBeVisible();

    // ── run now ──────────────────────────────────────────────────────
    const runResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/v1/deployments/${deploymentId}/run` &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Run now" }).click();
    const run = await runResponse;
    expect(run.status(), await run.text()).toBeLessThan(300);
    const runBody = (await run.json()) as { id: string; deployment_id: string };
    expect(runBody).toMatchObject({ id: expect.stringMatching(/^drun_/), deployment_id: deploymentId });
    await expect(page.getByText("Run started")).toBeVisible();
    const runs = page.getByRole("table", { name: "Runs" });
    await expect(runs.getByRole("row").filter({ hasText: "Manual" }).first()).toBeVisible({ timeout: 30_000 });

    // ── pause / resume ───────────────────────────────────────────────
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Run now" })).toBeDisabled();
    expect((await api<{ status?: string; paused_reason?: unknown }>("GET", `/v1/deployments/${deploymentId}`)).paused_reason)
      .toBeTruthy();
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Run now" })).toBeEnabled();

    // ── archive ──────────────────────────────────────────────────────
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "Archive", exact: true }).click();
    await expect(page.getByText("This deployment is archived and no longer runs.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Archive", exact: true })).toBeDisabled();
    const archivedId = deploymentId;
    deploymentId = undefined;

    // Archived deployments drop out of the default list.
    await page.goto(`${origin}/deployments`, { waitUntil: "domcontentloaded" });
    await page.getByPlaceholder("Search by name or exact ID").fill(archivedId);
    await expect(page.getByRole("row", { name: new RegExp(escapeRegExp(deploymentName)) })).toHaveCount(0);

    expect(pageErrors).toEqual([]);
    expect(apiFailures).toEqual([]);
  } finally {
    if (deploymentId) {
      await api("POST", `/v1/deployments/${deploymentId}/archive`).catch((error) => cleanupErrors.push(error));
    }
    if (agent) {
      await api("POST", `/v1/agents/${agent.id}/archive`).catch((error) => cleanupErrors.push(error));
    }
    if (environment) {
      await api("DELETE", `/v1/environments/${environment.id}`).catch((error) => cleanupErrors.push(error));
    }
    if (modelCard) {
      await api("DELETE", `/v1/oma/model_cards/${encodeURIComponent(modelCard.id)}`)
        .catch((error) => cleanupErrors.push(error));
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "Console Deployments E2E cleanup failed");
    }
  }
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Same browser auth as deployed-console.spec.ts: mock only Better Auth's
 * session probe so AppShell renders, and inject the real API key on every
 * `/v1/**` request, which still reaches the real Worker via `route.continue`.
 */
export async function authenticateConsoleWithApiKey(page: Page, apiKey: string) {
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
    await route.continue({ headers: { ...route.request().headers(), "x-api-key": apiKey } });
  });
}

/** fetch-based seeder that authenticates with an API key. */
export function apiKeyClient(baseURL: string, apiKey: string): ApiCall {
  return async (method, path, body) => {
    const response = await fetch(`${baseURL}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        // Same beta the Console and official SDK send for Managed Agents APIs.
        "anthropic-beta": "managed-agents-2026-04-01",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${text}`);
    return (text ? JSON.parse(text) : undefined) as never;
  };
}
