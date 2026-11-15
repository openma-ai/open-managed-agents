// Explicit opt-in live task storage runner; never collected by the local suite.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
export default defineConfig({root:fileURLToPath(new URL("../..",import.meta.url)),test:{pool:"forks",include:["test/resource-convergence/*.live-r2.node.ts"],testTimeout:300000,hookTimeout:120000,fileParallelism:false}});
