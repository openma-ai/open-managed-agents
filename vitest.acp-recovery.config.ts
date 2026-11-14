import { defineConfig } from "vitest/config";

/** Node-side coverage gate for canonical-events to ACP semantic recovery. */
export default defineConfig({
  test: {
    pool: "threads",
    environment: "node",
    include: ["packages/agent-harness/test/acp-recovery.test.ts"],
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["packages/agent-harness/src/acp-recovery.ts"],
      reporter: ["text", "json-summary"],
      reportsDirectory: "coverage/acp-recovery",
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
