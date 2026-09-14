import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseOptions,makeCompose,configureDocker,targets} from '../src/installer.ts';
test('strict options reject unknown flags and invalid target, ports, and commands',()=>{
 assert.equal(parseOptions(['install','--target','docker','--port','8989']).port,8989);
 for(const args of [['--target','bad'],['--bogus'],['erase'],['--port','0'],['--port','70000'],['--target'],['--data-mode','invalid'],['--image','ghcrXio/openma-ai/open-managed-agents:edge']]) assert.throws(()=>parseOptions(args));
});
test('image installation contains no build or repository dependency and persists data',()=>{
 const s=makeCompose('ghcr.io/openma-ai/open-managed-agents@sha256:'+'a'.repeat(64),8787,'openma-test');
 assert.doesNotMatch(s,/build:|git clone/);assert.match(s,/127.0.0.1:8787/);assert.match(s,/openma-data:\/app\/data/);assert.match(s,/healthcheck/);
});
test('configuration creates private independent secrets and preserves them on rerun',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'openma-selfhost-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 await configureDocker(dir,'e2b',{E2B_API_KEY:'literal-$-key'});
 const a=JSON.parse(await readFile(join(dir,'environment.json'),'utf8'));
 assert.notEqual(a.BETTER_AUTH_SECRET,a.PLATFORM_ROOT_SECRET);assert.equal(a.E2B_API_KEY,'literal-$-key');
 await configureDocker(dir,'e2b',{E2B_API_KEY:'changed'});
 assert.deepEqual(JSON.parse(await readFile(join(dir,'environment.json'),'utf8')),a);
});
test('template and unsupported platforms never claim unattended installation',()=>{
 assert.equal(targets.docker.mode,'image');assert.equal(targets.fly.mode,'image');
 assert.equal(targets.render.mode,'handoff');assert.equal(targets.vercel.mode,'handoff');assert.equal(targets.cloudflare.mode,'source-required');
});
test('tag resolution records an immutable published digest',async()=>{
 const {resolveImage}=await import('../src/installer.ts');let calls=0;
 const image=await resolveImage('ghcr.io/openma-ai/open-managed-agents:edge',async()=>++calls===1?new Response(JSON.stringify({token:'public-token'})):new Response(null,{headers:{'docker-content-digest':'sha256:'+'b'.repeat(64)}}));
 assert.match(image,/@sha256:b{64}$/);assert.equal(calls,2);
 await assert.rejects(resolveImage('ghcr.io/openma-ai/open-managed-agents:missing',async()=>new Response('',{status:404})),/registry/);
});
test('configuration rejects missing credentials and symlink files',async t=>{
 const {symlink}=await import('node:fs/promises');
 const dir=await mkdtemp(join(tmpdir(),'openma-selfhost-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 await assert.rejects(configureDocker(dir,'e2b',{}),/E2B_API_KEY/);
 await symlink(join(dir,'other'),join(dir,'environment.json'));
 await assert.rejects(configureDocker(dir,'e2b',{E2B_API_KEY:'test'}),/symlink/);
});
test('packaged CLI installs outside the checkout, preserves secrets and records failed attempts',async t=>{
 const {createServer}=await import('node:http');const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');const {writeFile,mkdir,stat}=await import('node:fs/promises');const {fileURLToPath}=await import('node:url');
 const exec=promisify(execFile);const dir=await mkdtemp(join(tmpdir(),'openma-packaged-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const server=createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({status:'ok'}));});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const port=server.address().port;await mkdir(join(dir,'bin'));
 await writeFile(join(dir,'bin/docker'),'#!/bin/sh\nprintf "%s\\n" "$*" >> "$CALL_LOG"\nif [ "$FAIL_PULL" = 1 ] && [ "$6" = pull ]; then exit 17; fi\n',{mode:0o755});
 const cli=fileURLToPath(new URL('../dist/index.js',import.meta.url));
 const args=[cli,'install','--target','docker','--dir',join(dir,'instance'),'--port',String(port),'--image','ghcr.io/openma-ai/open-managed-agents@sha256:'+'a'.repeat(64),'--yes'];
 const env={PATH:join(dir,'bin')+':'+process.env.PATH,CALL_LOG:join(dir,'calls'),E2B_API_KEY:'test-$secret'};
 const result=await exec(process.execPath,args,{cwd:dir,env});assert.match(result.stdout,/healthy/);assert.doesNotMatch(result.stdout,/test-\$secret/);
 const path=join(dir,'instance','environment.json');const before=await readFile(path,'utf8');assert.equal((await stat(path)).mode&0o777,0o600);
 await exec(process.execPath,args,{cwd:dir,env:{...env,E2B_API_KEY:'replacement'}});assert.equal(await readFile(path,'utf8'),before);
 const calls=await readFile(join(dir,'calls'),'utf8');assert.match(calls,/--no-build --wait/);assert.doesNotMatch(calls,/git|--build/);
 await assert.rejects(exec(process.execPath,args,{cwd:dir,env:{...env,FAIL_PULL:'1'}}));
 assert.equal(JSON.parse(await readFile(join(dir,'instance','installation.json'),'utf8')).status,'pending');
 await assert.rejects(exec(process.execPath,[...args,'--data-mode','postgres'],{cwd:dir,env}),/migration/);
 const pgArgs=[...args];pgArgs[pgArgs.indexOf('--dir')+1]=join(dir,'postgres-instance');pgArgs.push('--data-mode','postgres');
 await exec(process.execPath,pgArgs,{cwd:dir,env});
 const pg=JSON.parse(await readFile(join(dir,'postgres-instance','compose.json'),'utf8'));
 assert.equal(pg.services.postgres.ports,undefined);assert.deepEqual(pg.volumes['openma-postgres'],{});
 assert.equal(pg.services['oma-server'].environment.DATABASE_URL,`postgres://oma:${pg.services.postgres.environment.POSTGRES_PASSWORD}@postgres:5432/oma`);
 const config=JSON.parse(await readFile(join(dir,'instance','compose.json'),'utf8'));assert.equal(config.services['oma-server'].environment.E2B_API_KEY,'test-$$secret');
});
