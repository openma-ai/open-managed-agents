import { defineConfig } from "@playwright/test";

const deployedBaseURL = process.env.OMA_E2E_BASE_URL;
const browserExecutable = process.env.OMA_E2E_BROWSER_EXECUTABLE;

export default defineConfig({
  testDir: "./test/e2e",
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: deployedBaseURL ?? "http://localhost:5173",
    headless: true,
    launchOptions: browserExecutable
      ? { executablePath: browserExecutable }
      : undefined,
    screenshot: "only-on-failure",
  },
  webServer: deployedBaseURL
    ? undefined
    : {
        command: "pnpm run dev:console",
        port: 5173,
        reuseExistingServer: true,
        timeout: 15_000,
      },
});
