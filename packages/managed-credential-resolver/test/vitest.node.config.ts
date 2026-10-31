import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// SQLite needs Node; .test.ts remains covered by the root workerd pool.
export default defineConfig({
  root: fileURLToPath(new URL("..", import.meta.url)),
  test: {
    environment: "node",
    pool: "threads",
    include: ["test/*.node.ts"],
  },
});
