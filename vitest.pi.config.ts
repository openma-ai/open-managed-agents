import { defineConfig } from "vitest/config";

/** Node-side coverage gate for the Pi harness compaction policy. */
export default defineConfig({
  test: {
    pool: "threads",
    environment: "node",
    include: [
      "packages/agent-harness/test/pi-loop.test.ts",
      "packages/agent-harness/test/pi-compaction.test.ts",
      "packages/agent-harness/test/default-loop.span-lifecycle.test.ts",
      "apps/main-node/test/pi-sandbox-harness.e2e.test.ts",
    ],
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["packages/agent-harness/src/pi-compaction.ts"],
      reporter: ["text", "json-summary"],
      reportsDirectory: "coverage/pi",
      thresholds: {
        perFile: true,
        lines: 85,
        statements: 85,
        functions: 80,
        branches: 70,
      },
    },
  },
});
