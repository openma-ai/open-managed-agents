import {defineConfig,mergeConfig} from 'vitest/config';
import base from './vitest.config';
import {fileURLToPath} from 'node:url';
const config=mergeConfig(base,defineConfig({test:{include:['test/integration/cf-sdk-capability.gate.ts']}}));
// This probe must load the installed official SDK, never the broad-suite stub.
config.resolve!.alias=(config.resolve!.alias as Array<{find:unknown}>).filter(a=>a.find!=='@cloudflare/sandbox');
(config.resolve!.alias as Array<{find:string;replacement:string}>).push({find:'@cloudflare/sandbox',replacement:fileURLToPath(new URL('./apps/agent/node_modules/@cloudflare/sandbox/dist/index.mjs',import.meta.url))});
export default config;
