import {build} from 'esbuild';
import {mkdir,copyFile,chmod} from 'node:fs/promises';
await build({entryPoints:['src/index.ts'],bundle:true,platform:'node',format:'esm',target:'node22',outfile:'dist/index.js',banner:{js:'#!/usr/bin/env node'}});
await chmod('dist/index.js',0o755);
await mkdir('dist/assets',{recursive:true});
await copyFile('../../scripts/setup-fly.sh','dist/assets/setup-fly.sh');
await copyFile('../../fly.toml','dist/assets/fly.toml');
