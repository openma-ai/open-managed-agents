import {defineConfig} from 'vitest/config';
// Explicit official-distribution gate; requires OMA_PI_ACP_ENTRY. No package
// auto-install and no silent skip when the audited distribution is missing.
export default defineConfig({test:{pool:'threads',include:['test/pi-mcp-barrier.native.test.ts'],testTimeout:60000}});
