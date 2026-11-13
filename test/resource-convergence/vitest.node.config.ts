// Node-pool runner for resource-convergence behavior tests. These spawn real
// Node control-plane processes and /bin/sh, which the root workerd project
// cannot host. Files are named `*.node.ts` so the root (workerd) project's
// default `*.test.ts` discovery never collects them.
//
//   pnpm exec vitest run --config test/resource-convergence/vitest.node.config.ts
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  test: {
    pool: "forks",
    include: ["test/resource-convergence/**/*.node.ts"],
    exclude: ["**/*.live-r2.node.ts"],
    testTimeout: 300_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
