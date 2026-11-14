import { defineConfig } from "vitest/config";

// Explicit destructive-test opt-in; the suite itself requires a dedicated
// loopback database and owns only a unique schema created for this run.
export default defineConfig({
  test: {
    pool: "threads",
    include: ["test/work-inputs.pg.test.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
