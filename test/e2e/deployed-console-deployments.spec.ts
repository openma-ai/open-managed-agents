import { assertTestModelEnvironment } from "../../scripts/lib/test-model-allowlist.mjs";
import { test } from "@playwright/test";
import { apiKeyClient, authenticateConsoleWithApiKey, runDeploymentsFlow } from "./support/deployments-flow";

assertTestModelEnvironment();

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
const requireBackend = process.env.OMA_E2E_REQUIRE_BACKEND === "1" || process.env.CI === "true";

function requireEnv(ok: boolean, message: string) {
  if (ok) return;
  if (requireBackend) throw new Error(message);
  test.skip(true, message);
}

test.describe("deployed Console Deployments", () => {
  requireEnv(Boolean(deployedBaseURL), "OMA_E2E_BASE_URL is required for deployed smoke");

  test("lists, creates, opens, runs, pauses and archives a Deployment", async ({ page }) => {
    requireEnv(Boolean(apiKey), "OMA_E2E_API_KEY is required");
    test.setTimeout(120_000);

    const api = apiKeyClient(deployedBaseURL!, apiKey!);
    await authenticateConsoleWithApiKey(page, apiKey!);

    await runDeploymentsFlow({ page, api, origin: deployedBaseURL!, model, mockModelBaseURL });
  });
});
