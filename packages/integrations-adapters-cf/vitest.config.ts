import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "threads",
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    coverage: {
      // Only the Feishu adapters under test. Other providers (slack,
      // github, linear) are outside this work package.
      include: ["src/d1/feishu/**/*.ts"],
      reporter: ["text", "html"],
      thresholds: {
        lines: 80,
        branches: 70,
        functions: 70,
        statements: 80,
      },
    },
  },
});
