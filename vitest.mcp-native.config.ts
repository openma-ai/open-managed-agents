import {defineConfig,mergeConfig} from 'vitest/config';
import base from './vitest.config';
// Explicit official-process gate. The driver starts the localhost forwarder
// before invoking this config; no conditional skip or fake harness fallback.
export default mergeConfig(base,defineConfig({test:{include:['test/integration/core-custom-mcp-native-work.gate.ts']}}));
