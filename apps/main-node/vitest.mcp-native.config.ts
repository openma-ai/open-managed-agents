import {defineConfig} from 'vitest/config';
export default defineConfig({test:{pool:'threads',include:['test/core-custom-mcp-work.native.test.ts'],testTimeout:60000}});
