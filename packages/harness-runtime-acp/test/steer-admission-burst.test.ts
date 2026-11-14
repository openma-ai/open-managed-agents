import {expect,it} from 'vitest';
import {mkdir} from 'node:fs/promises';
import {lifecycleFixture} from "../../../apps/main-node/test/session-lifecycle-parity-worker.helper";
import {firstNativePrompt} from "../../../apps/main-node/test/session-lifecycle-parity-worker.helper";
import {parityPeer,parityModules} from '../../../apps/main-node/test/session-lifecycle-parity-acp.fixture';
import {runNodeWorkItemCli} from '../src/node-work-item-cli';
import {createNodeAcpHarnessStateIo} from '../src/node';
const gate=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve}};
it('two same-page inputs must serialize permission gates and continue FIFO, not abort as busy',async()=>{
 const f=await lifecycleFixture(),controller=new AbortController(),root=gate(),release=gate(),modeEntered=gate();
 const prompts:string[]=[],steers:string[]=[],receipts:any[]=[];let running:Promise<any>|undefined;let modeCount=0;
 try{
  await f.message('root');await f.claim(false);await f.prepareSandbox();
  const peer=parityPeer({async *prompt(text){prompts.push(text);if(text==='root'||text.endsWith("\n\nroot")){root.resolve();await release.promise}yield {type:'promptComplete'}},async steer(text){steers.push(text);if(steers.length===2)release.resolve()}});
  // Real SDK wire: delay only the first steer's set_config_option response.
  // No product hooks, mode mapping, CAS, or native session objects are mocked.
  const spawner={async spawn(spec:any){const p=await peer.spawn(spec);let buf='';return {...p,stdout:p.stdout.pipeThrough(new TransformStream({async transform(bytes,out){buf+=new TextDecoder().decode(bytes);while(buf.includes('\n')){const i=buf.indexOf('\n'),m=JSON.parse(buf.slice(0,i));buf=buf.slice(i+1);
   if(m.result?.configOptions&&!m.result.sessionId&&++modeCount===2){modeEntered.resolve();await new Promise(r=>setTimeout(r,100));}
   if(m.result?.outcome==='injected')m.result.outcome='promptRequired';
   out.enqueue(new TextEncoder().encode(JSON.stringify(m)+'\n'));
  }}}))}}};
  const workspace=f.root+'/native';await mkdir(workspace,{recursive:true});
  running=runNodeWorkItemCli({hostWorkspacePath:workspace,environment:{ANTHROPIC_ENVIRONMENT_ID:f.scope.environmentId,ANTHROPIC_SESSION_ID:f.scope.sessionId,ANTHROPIC_WORK_ID:f.scope.workId,OPENMA_HARNESS_ID:'acp',OPENMA_ACP_AGENT_ID:'codex-acp',ANTHROPIC_WORK_SECRET:Buffer.from(JSON.stringify({sessions_token:f.token(),api_base_url:f.base})).toString('base64url')},signal:controller.signal,heartbeatIntervalMs:50,runtime:{modules:await parityModules(),spawner,stateIo:createNodeAcpHarnessStateIo({workspacePath:workspace})},fetch:async(raw,init)=>{const action=new URL(String(raw)).pathname.split('/').at(-1)!;const r=await f.nativeFetch(new Request(raw,init));if(['inputs-consume','work-publish'].includes(action))receipts.push({action,status:r.status,body:await r.clone().json()});return r;}}).then(()=>({done:true}),error=>{release.resolve();return {error}});
  await root.promise;
  await f.api('/v1/sessions/'+f.session.id+'/events',{events:[{type:'user.message',content:[{type:'text',text:'a'}]}]});
  await f.api('/v1/sessions/'+f.session.id+'/events',{events:[{type:'user.message',content:[{type:'text',text:'b'}]}]});
  await modeEntered.promise;await new Promise(r=>setTimeout(r,150));release.resolve();
  const observed=await Promise.race([running,new Promise(r=>setTimeout(()=>r({timeout:true}),2000))]);
  console.log('BURST_EVIDENCE',JSON.stringify({prompts,steers,modeCount,receipts,error:String(observed?.error)}));
  expect(observed?.error,'supported FIFO input must not fail closed with permission busy').toBeUndefined();
  await expect.poll(()=>prompts).toEqual([firstNativePrompt('root'),'a','b']);
  await expect.poll(()=>receipts.filter(r=>r.action==='work-publish'&&r.status===200).length).toBe(1);
 }finally{release.resolve();controller.abort();await running;await f.dispose()}
},10000);
