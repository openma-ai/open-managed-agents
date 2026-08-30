import { defineConfig } from "vitest/config";

/**
 * Node-side coverage for deterministic protocol fakes and the runtime-neutral
 * MCP client. The root suite uses workerd, where V8's inspector coverage API
 * is unavailable.
 */
export default defineConfig({
  test: {
    pool: "threads",
    environment: "node",
    include: [
      "test/unit/protocol-fakes.test.ts",
      "test/unit/mcp-http-client.protocol.test.ts",
    ],
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: [
        "test/fakes/scripted-language-model.ts",
        "test/fakes/scripted-mcp-server.ts",
        "packages/mcp/src/http-client.ts",
      ],
      reporter: ["text", "json-summary"],
      reportsDirectory: "coverage/protocol",
      thresholds: {
        perFile: true,
        lines: 95,
        statements: 95,
        functions: 85,
        branches: 70,
      },
    },
  },
});
