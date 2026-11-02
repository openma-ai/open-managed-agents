import { defineConfig } from "vitest/config";

/** Coverage gate for #281 harness web HTTP helpers (not general egress policy). */
export default defineConfig({
  test: {
    pool: "threads",
    environment: "node",
    include: [
      "test/unit/web-fetch-http.test.ts",
      "test/unit/tool-http-fetch.test.ts",
    ],
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: [
        "apps/agent/src/harness/web-fetch-http.ts",
        "apps/agent/src/harness/tool-http-fetch.ts",
      ],
      reporter: ["text", "json-summary", "lcov"],
      reportsDirectory: "coverage/harness-web-http",
      thresholds: {
        perFile: true,
        lines: 100,
        statements: 100,
        functions: 100,
        branches: 100,
      },
    },
  },
});
