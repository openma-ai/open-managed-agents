import {defineConfig} from 'vitest/config';
export default defineConfig({test:{pool:'threads',include:['test/custom-tool-authority.mysql.native.test.ts'],testTimeout:15000}});
