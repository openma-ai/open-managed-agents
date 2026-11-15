import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
const temp = await mkdtemp(join(tmpdir(), 'oma-loader-gate-'));
try {
  const output = join(temp, 'gate.mjs');
  await build({entryPoints:[new URL('./check-official-harness-loaders.ts',import.meta.url).pathname],outfile:output,bundle:true,platform:'node',format:'esm'});
  const child=spawn(process.execPath,[output,...process.argv.slice(2)],{stdio:'inherit'});
  process.exitCode=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>resolve(code??1));});
} finally {await rm(temp,{recursive:true,force:true});}
