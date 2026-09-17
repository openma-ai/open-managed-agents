import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renderServiceSpec} from '../src/render.ts';
test('Render deploys a pinned public image with disk and provider secrets, without a Git repo',()=>{
 const spec=renderServiceSpec({owner:'tea-test',name:'openma',region:'oregon',image:'ghcr.io/openma-ai/open-managed-agents@sha256:'+'a'.repeat(64)}, {SANDBOX_PROVIDER:'sprites',SPRITES_TOKEN:'private'});
 assert.equal(spec.repo,undefined);assert.match(spec.image.imagePath,/@sha256:/);
 assert.equal(spec.serviceDetails.disk.mountPath,'/app/data');assert.equal(spec.serviceDetails.numInstances,1);
 assert.ok(spec.envVars.some(x=>x.key==='SPRITES_TOKEN'&&x.value==='private'));
 assert.match(spec.serviceDetails.envSpecificDetails.dockerCommand,/RENDER_EXTERNAL_URL/);
});
test('Render login continues into creation, persists service identity, and resumes without duplicates',async t=>{
 const {mkdtemp,mkdir,writeFile,readFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {main}=await import('../src/installer.ts');
 const root=await mkdtemp(join(tmpdir(),'openma-render-'));const env={...process.env};const fetchBefore=globalThis.fetch;
 t.after(async()=>{globalThis.fetch=fetchBefore;process.env=env;await rm(root,{recursive:true,force:true});});
 await mkdir(join(root,'bin'));await writeFile(join(root,'bin','render'),'#!/bin/sh\nexit 0\n',{mode:0o755});
 process.env.PATH=join(root,'bin')+':'+env.PATH;process.env.RENDER_API_KEY='test-render-token';process.env.SPRITES_TOKEN='test-sandbox-token';process.env.RENDER_CLI_CONFIG_DIR=root;
 let creations=0;let live=false;
 globalThis.fetch=async(url,init)=>{
  const u=new URL(url);assert.ok(['api.render.com','test.onrender.com'].includes(u.hostname));
  if(u.hostname==='test.onrender.com')return Response.json({status:'ok'});
  assert.equal(init.headers.Authorization,'Bearer test-render-token');
  if(u.pathname==='/v1/services'&&init.method==='POST'){
   const spec=JSON.parse(init.body);assert.equal(spec.repo,undefined);assert.equal(spec.image.ownerId,'tea-test');creations++;return Response.json({service:{id:'srv-test'}});
  }
  if(u.pathname==='/v1/services')return Response.json([]);
  if(u.pathname.endsWith('/deploys'))return Response.json([{deploy:{status:live?'live':'update_failed'}}]);
  return Response.json({id:'srv-test',serviceDetails:{url:'https://test.onrender.com'}});
 };
 const args=['install','--target','render','--provider','sprites','--workspace','tea-test','--dir',join(root,'instance'),'--image','ghcr.io/openma-ai/open-managed-agents@sha256:'+'a'.repeat(64),'--yes'];
 await assert.rejects(main(args),/update_failed/);
 const pending=JSON.parse(await readFile(join(root,'instance/installation.json'),'utf8'));assert.equal(pending.serviceId,'srv-test');assert.equal(pending.status,'pending');
 live=true;await main(args);assert.equal(creations,1);
 const saved=JSON.parse(await readFile(join(root,'instance/installation.json'),'utf8'));assert.equal(saved.status,'installed');assert.equal(saved.url,'https://test.onrender.com');
});
