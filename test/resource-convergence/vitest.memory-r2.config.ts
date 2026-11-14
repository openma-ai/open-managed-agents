import base from "../../vitest.config";
import { defineConfig } from "vitest/config";
export default defineConfig({...base,test:{...base.test,include:["test/integration/resource-work-cf-e2b.live-r2.ts"],fileParallelism:false}});
