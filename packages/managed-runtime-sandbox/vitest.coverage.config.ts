import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      enabled: true,
      provider: "v8",
      reporter: ["text"],
      include: ["src/provider-runtime.ts"],
      thresholds: {
        statements: 74,
        branches: 55,
        functions: 60,
        lines: 75,
      },
    },
  },
});
