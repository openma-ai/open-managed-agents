import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: "http://127.0.0.1:4178",
    headless: true,
    launchOptions: process.env.OMA_E2E_BROWSER_EXECUTABLE
      ? { executablePath: process.env.OMA_E2E_BROWSER_EXECUTABLE } : undefined,
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "pnpm exec vite --host 127.0.0.1 --port 4178 --strictPort",
    port: 4178,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
