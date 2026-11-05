import { assertTestModelEnvironment } from "../../scripts/lib/test-model-allowlist.mjs";
import { test } from "@playwright/test";

assertTestModelEnvironment();
import {
  apiKeyClient,
  authenticateConsoleWithApiKey,
  runDeploymentsFlow,
} from "./support/deployments-flow";

/**
 * Local real-backend Console Deployments coverage.
 *
 * Prerequisites (same ports as console.spec.ts):
 *   - a backend on :8787 that accepts a workspace API key, e.g. main-node:
 *       API_KEY=oma-local-e2e-key PLATFORM_ROOT_SECRET=<32+ chars> PORT=8787 \
 *         pnpm --filter @open-managed-agents/main-node start
 *     (wrangler dev also works once its API_KEY / PLATFORM_ROOT_SECRET reach
 *     the Worker env)
 *   - vite dev on :5173 (playwright.config starts `pnpm run dev:console`)
 *   - OMA_E2E_LOCAL_API_KEY=<that key> (defaults to dev-test-key-change-me,
 *     the key used by e2e-local.sh); OMA_E2E_LOCAL_API_URL overrides :8787
 *
 * Local signup requires an emailed OTP, so the browser uses the same auth as
 * deployed-console.spec.ts: only `/auth/get-session` is mocked and the
 * workspace API key is injected on real `/v1/**` calls through the vite proxy.
 * `/v1/deployments*` is never mocked.
 *
 * Run:
 *   pnpm exec playwright test test/e2e/console-deployments.spec.ts
 */

const backendURL = (process.env.OMA_E2E_LOCAL_API_URL ?? "http://localhost:8787").replace(/\/$/, "");
const apiKey = process.env.OMA_E2E_LOCAL_API_KEY ?? "dev-test-key-change-me";
const model = process.env.OMA_E2E_MODEL ?? "claude-sonnet-4-6";
const requireBackend = process.env.OMA_E2E_REQUIRE_BACKEND === "1" || process.env.CI === "true";

test.describe("Console Deployments (local backend)", () => {
  test.skip(Boolean(process.env.OMA_E2E_BASE_URL), "Local suite; deployed runs use deployed-console-deployments.spec.ts");

  test("lists, creates, opens, runs, pauses and archives a Deployment", async ({ page }) => {
    test.setTimeout(120_000);

    const probe = await fetch(`${backendURL}/v1/deployments?limit=1`, { headers: { "x-api-key": apiKey } })
      .then((response) => response.status)
      .catch(() => 0);
    if (probe === 0) {
      const message = `Local backend is not reachable at ${backendURL}`;
      if (requireBackend) throw new Error(message);
      test.skip(true, message);
    }
    if (probe === 401) {
      const message = "Local backend rejects OMA_E2E_LOCAL_API_KEY (set API_KEY for the backend)";
      if (requireBackend) throw new Error(message);
      test.skip(true, message);
    }

    await authenticateConsoleWithApiKey(page, apiKey);
    await runDeploymentsFlow({ page, api: apiKeyClient(backendURL, apiKey), origin: "", model });
  });
});
