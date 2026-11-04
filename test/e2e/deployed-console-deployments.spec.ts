import { test } from "@playwright/test";
import { apiKeyClient, authenticateConsoleWithApiKey, runDeploymentsFlow } from "./support/deployments-flow";

/**
 * Deployed / release-certification Console Deployments coverage.
 *
 * Requires OMA_E2E_BASE_URL + OMA_E2E_API_KEY (same as deployed-console.spec.ts).
 * Only Better Auth's session probe is mocked so AppShell renders; every
 * `/v1/**` request (including `/v1/deployments*`) reaches the real Worker with
 * the real API key injected.
 */

const deployedBaseURL = process.env.OMA_E2E_BASE_URL?.replace(/\/$/, "");
const apiKey = process.env.OMA_E2E_API_KEY;
const model = process.env.OMA_E2E_MODEL ?? "claude-sonnet-4-6";
const mockModelBaseURL = process.env.OMA_E2E_MOCK_MODEL_BASE_URL?.replace(/\/$/, "");

test.describe("deployed Console Deployments", () => {
  test.skip(!deployedBaseURL, "OMA_E2E_BASE_URL is required for deployed smoke");

  test("lists, creates, opens, runs, pauses and archives a Deployment", async ({ page }) => {
    test.skip(!apiKey, "OMA_E2E_API_KEY is required");
    test.setTimeout(120_000);

    const api = apiKeyClient(deployedBaseURL!, apiKey!);
    await authenticateConsoleWithApiKey(page, apiKey!);

    await runDeploymentsFlow({ page, api, origin: deployedBaseURL!, model, mockModelBaseURL });
  });
});
