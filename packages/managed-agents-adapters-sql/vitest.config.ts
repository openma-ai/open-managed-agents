import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "threads",
    include: ["test/**/*.test.ts"],
    exclude: ["test/**/*.pg.test.ts"],
    testTimeout: 30_000,
  },
});
