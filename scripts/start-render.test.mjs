import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {promisify} from 'node:util';
import test from 'node:test';
const exec=promisify(execFile);
test('Render start derives its public origin without replacing a custom domain',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'openma-render-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 await mkdir(join(dir,'bin'));
 await writeFile(join(dir,'bin/pnpm'),'#!/bin/sh\nprintf "%s|%s|%s" "$PUBLIC_BASE_URL" "$GATEWAY_ORIGIN" "$*"\n',{mode:0o755});
 const start=env=>exec('bash',[resolve('apps/main-node/scripts/start-render.sh')],{env:{PATH:`${join(dir,'bin')}:${process.env.PATH}`,RENDER_EXTERNAL_URL:'https://openma-test.onrender.com',...env}});
 const result=await start({});
 assert.equal(result.stdout,'https://openma-test.onrender.com|https://openma-test.onrender.com|start');
 assert.equal((await start({PUBLIC_BASE_URL:'https://agents.example.com'})).stdout,'https://agents.example.com|https://agents.example.com|start');
 await assert.rejects(start({RENDER_EXTERNAL_URL:''}),/public.*URL/i);
 await assert.rejects(start({RENDER_EXTERNAL_URL:'https://user:password@example.com'}),/origin/i);
});
