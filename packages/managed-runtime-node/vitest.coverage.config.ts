import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: ["test/**/*.e2e.test.ts"],
    coverage: {
      enabled: true,
      provider: "v8",
      reporter: ["text"],
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "src/create-runtime.ts"],
      thresholds: {
        statements: 68,
        branches: 45,
        functions: 55,
        lines: 70,
      },
    },
  },
});
