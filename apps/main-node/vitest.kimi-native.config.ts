import {defineConfig} from 'vitest/config';
export default defineConfig({test:{pool:'threads',include:['test/core-custom-mcp-kimi.native.test.ts'],testTimeout:40000}});
