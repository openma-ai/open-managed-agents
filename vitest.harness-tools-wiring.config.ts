import { defineConfig } from "vitest/config";

/** Collect V8 coverage for tools.ts wiring (#281 web_fetch / web_search). */
export default defineConfig({
  resolve: {
    alias: [
      { find: "@cloudflare/sandbox", replacement: "./test/sandbox-stub.ts" },
      { find: "@open-managed-agents/shared", replacement: "./packages/shared/src/index.ts" },
      { find: "@open-managed-agents/mcp", replacement: "./packages/mcp/src/index.ts" },
      { find: "@open-managed-agents/markdown", replacement: "./packages/markdown/src/index.ts" },
      { find: "@open-managed-agents/browser-harness", replacement: "./packages/browser-harness/src/index.ts" },
      { find: "@open-managed-agents/sandbox", replacement: "./packages/sandbox/src/index.ts" },
    ],
  },
  test: {
    pool: "threads",
    environment: "node",
    include: ["test/unit/web-fetch-tools.harness.test.ts"],
    testTimeout: 60_000,
    coverage: {
      provider: "v8",
      include: ["apps/agent/src/harness/tools.ts"],
      reporter: ["text", "json", "json-summary", "lcov"],
      reportsDirectory: "coverage/harness-tools-wiring",
    },
  },
});
