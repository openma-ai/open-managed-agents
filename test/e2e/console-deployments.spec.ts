import { test } from "@playwright/test";
import {
  apiKeyClient,
  authenticateConsoleWithApiKey,
  runDeploymentsFlow,
} from "./support/deployments-flow";

/**
 * Local real-backend Console Deployments coverage.
 *
 * Prerequisites (same stack as console.spec.ts / e2e-local.sh):
 *   - wrangler dev on :8787 with D1 migrations applied and the static
 *     workspace key configured, e.g.
 *       wrangler dev -c apps/main/wrangler.jsonc --var API_KEY:dev-test-key-change-me
 *     (or API_KEY in apps/main/.dev.vars; agent worker optional)
 *   - vite dev on :5173 (playwright.config starts `pnpm run dev:console`)
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

test.describe("Console Deployments (local backend)", () => {
  test.skip(Boolean(process.env.OMA_E2E_BASE_URL), "Local suite; deployed runs use deployed-console-deployments.spec.ts");

  test("lists, creates, opens, runs, pauses and archives a Deployment", async ({ page }) => {
    test.setTimeout(120_000);

    const probe = await fetch(`${backendURL}/v1/deployments?limit=1`, { headers: { "x-api-key": apiKey } })
      .then((response) => response.status)
      .catch(() => 0);
    test.skip(probe === 0, `Local backend is not reachable at ${backendURL}`);
    test.skip(probe === 401, "Local backend rejects OMA_E2E_LOCAL_API_KEY (set API_KEY for wrangler dev)");

    await authenticateConsoleWithApiKey(page, apiKey);
    await runDeploymentsFlow({ page, api: apiKeyClient(backendURL, apiKey), origin: "", model });
  });
});
