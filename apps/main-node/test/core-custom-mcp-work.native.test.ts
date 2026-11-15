import {fork} from 'node:child_process';
import {fileURLToPath,URL} from 'node:url';
import {createServer} from 'node:http';
import {generateSandboxToken} from '../../../packages/sandbox-gateway/src/index';
import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm, mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { loadNodeConfig } from "../src/config.js";
import { nodeDefaults } from "../src/components.js";
import {issueSandboxToken} from "../../../packages/sandbox-gateway/src/index";
import {createSqlEnvironmentWorkSandboxTokenStore,environmentWorkSandboxTokenRef} from "../../../packages/sandbox-gateway-sql/src/index";
import { SqlEnvironmentWorkStore } from "../../../packages/environment-work-store-sql/src/index";
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
for(const order of ['first','last','multiple','transport','later-turn','cancel','cancel-recovery','crash-publication','takeover','crash-ack','crash-precommit-recovery'] as const)it(`official Pi production Core MCP ${order} with HTTP/Work restart`,async()=>{
 const mark=async(stage:string)=>{if(process.env.OMA_WORK_TRACE)await appendFile(process.env.OMA_WORK_TRACE+'.'+order+'.stages.jsonl',JSON.stringify({stage,wall:new Date().toISOString(),monotonic:performance.now()})+'\n');};await mark('fixture-start');
 const transport=order==='transport';const parkRequests=transport?3:2;
 const ids=transport?['recovery-custom']:order==='multiple'?['original-custom','original-second']:['original-custom'];
 await mkdir(join(process.cwd(),".test-artifacts"),{recursive:true});
 const root=await mkdtemp(join(process.cwd(),".test-artifacts/work-inputs-"));cleanup.push(()=>rm(root,{recursive:true,force:true}));
 const configEnv={...(process.env.CORE_MCP_DATABASE_URL?{DATABASE_URL:process.env.CORE_MCP_DATABASE_URL}:{}),NODE_ENV:"test",AUTH_DISABLED:"0",API_KEY:"fixture-admin",PLATFORM_ROOT_SECRET:"test-work-inputs-root-secret-32-characters",OPENMA_TEST_SANDBOX_PROVIDER:"local-subprocess",DATABASE_PATH:join(root,"db.sqlite"),AUTH_DATABASE_PATH:join(root,"auth.sqlite"),MEMORY_BLOB_DIR:join(root,"memory"),SESSION_OUTPUTS_DIR:join(root,"outputs"),SANDBOX_WORKDIR:join(root,"sandbox"),MEMORY_QUEUE:"disabled"};
 let canonicalEvents:any[]=[];const requests:any[]=[];const operations:any[]=[];const nativeEvents:any[]=[];const hostPids:number[]=[];const hostErrors:string[]=[];
 let hostPort=0;
 const startHost=async()=>{
  const child=fork(fileURLToPath(new URL('./fixtures/core-mcp-host-child.ts',import.meta.url)),[],{execArgv:['--import',fileURLToPath(new URL('../../../node_modules/.pnpm/node_modules/tsx/dist/loader.mjs',import.meta.url))],stdio:['ignore','pipe','pipe','ipc']});
  child.stdout!.on('data',()=>{});child.stderr!.on('data',b=>hostErrors.push(String(b)));let stopped=false;
  const stop=async()=>{if(stopped||child.exitCode!==null||child.signalCode!==null)return;stopped=true;const exit=new Promise<void>(r=>child.once('exit',()=>r()));child.send({type:'stop'});await exit;};cleanup.push(stop);
  await new Promise<void>((resolve,reject)=>{child.on('message',(message:any)=>{if(message.type==='ready'){hostPort=message.port;hostPids.push(message.pid);resolve();}if(message.type==='database-error')operations.push(message);if(message.type==='observation'){operations.push(message);if(message.events)nativeEvents.push(...message.events);}if(message.type==='failed')reject(Error(message.message));});child.once('exit',(code,signal)=>{operations.push({path:'fixture/host-exit',pid:child.pid,code,signal});if(!stopped)reject(Error('Host exited '+code));});child.send({type:'start',env:configEnv,port:hostPort,dropCallOnce:transport&&hostPids.length===0,crashPublicationAck:order==='crash-ack'&&hostPids.length===0?join(root,'crash-ack'):null,crashPublication:(order==='crash-publication'||order==='crash-precommit-recovery')&&hostPids.length===0?join(root,'crash-publication'):null});});
  return {stop};
 };
 let host=await startHost();await mark('host-ready');
 const components=await nodeDefaults(loadNodeConfig(configEnv));cleanup.push(async()=>{await components.database.stop?.();});await mark('parent-sql-ready');
 const base='http://127.0.0.1:'+hostPort;
 const post=async(path:string,body:unknown,token?:string)=>fetch(base+path,{method:"POST",headers:{"content-type":"application/json",...(token?{authorization:"Bearer "+token}:{"x-api-key":"fixture-admin"})},body:JSON.stringify(body)});
 const create=async(path:string,body:unknown)=>{const r=await post(path,body);expect(r.status,await r.clone().text()).toBeLessThan(300);return r.json() as Promise<any>;};
 const env=await create("/v1/environments",{name:"inputs",config:{type:"cloud",networking:{type:"unrestricted"}}});
 const agent=await create("/v1/agents",{name:"inputs",model:"test",tools:[{type:"custom",name:"approve",description:"Approval",input_schema:{type:"object",properties:{label:{type:"string"}},required:["label"]}}],_oma:{harness:"acp-sandbox",acp:{agent:{registry:"pi-acp@0.1.8"}}}});
 const session=await create("/v1/sessions",{agent:agent.id,environment_id:env.id,initial_events:[{type:"user.message",content:[{type:"text",text:"first"}]}]});
 const sql=components.database.sql;
 const crypto=components.secrets!.cipherFor("managed.environment-work.session-token");
 const cipher=components.secrets!.cipherFor("managed.environment-work.secret");
 const store=new SqlEnvironmentWorkStore(sql,{seal:async({plaintext})=>({ciphertext:await cipher.encrypt(plaintext)}),open:async({ciphertext})=>({plaintext:await cipher.decrypt(ciphertext)})});
 const now=new Date().toISOString();let workId="http-input-work-"+session.id;let generation=2;let holder="http-worker";
 let token="sk-ant-req-v1."+await crypto.encrypt(JSON.stringify({version:1,workspaceId:"default",environmentId:env.id,sessionId:session.id,workId,issuedAt:now,expiresAt:new Date(Date.now()+300000).toISOString(),claimedAt:now,generation:2,skills:[],files:[],memoryStores:[]}));
 // Remove only the test Session's queued scheduling artifact; install a real claimed Work.
 await sql.prepare("DELETE FROM managed_environment_work WHERE session_id=?").bind(session.id).run();
 await store.insert({workspaceId:"default",record:{work:{id:workId,environmentId:env.id,data:{type:"session",id:session.id},state:"active",createdAt:now,acknowledgedAt:now,latestHeartbeatAt:now,startedAt:now,metadata:{},stopRequestedAt:null,stoppedAt:null},secret:{sessionsToken:token},claim:{generation:2,workerId:"http-worker",claimedAt:now},heartbeatTtlSeconds:300}});

 let scope={workspaceId:'default',environmentId:env.id,sessionId:session.id,workId};
 let sandboxToken=await issueSandboxToken(createSqlEnvironmentWorkSandboxTokenStore(sql),environmentWorkSandboxTokenRef({...scope,generation:2}),{scope:'all'});
 const model=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);requests.push(body);
  const names=body.tools.map((t:any)=>t.name);const custom=names.find((n:string)=>n==='mcp__oma_custom__approve');
  if(requests.length===1&&!names.includes('tool_search')||requests.length===2&&!custom){res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:{type:'invalid_request_error',message:'Standard MCP approve not advertised'}}));return;}
  const ordinary={id:'ordinary',name:'bash',args:{command:`printf 'effect\n' >> '${root}/effect.txt'${order.startsWith('cancel')?' ; sleep 10':''}`}};
  const customs=(transport?['failed-custom']:ids).map(id=>({id,name:custom,args:{label:'same'}}));
  const batch=order==='last'?[ordinary,...customs]:order==='multiple'?[customs[0],ordinary,customs[1]]:[...customs,ordinary];
  const calls=requests.length===1?[{id:'discover',name:'tool_search',args:{query:'approve'}}]:requests.length===2?batch:transport&&requests.length===3?[{id:'recovery-custom',name:custom,args:{label:'same'}}]:order==='cancel-recovery'&&requests.length===3?[{id:'distinct-recovery',name:'bash',args:{command:`printf recovered > '${root}/recovery.txt'`}}]:order==='later-turn'&&requests.length===3?[{id:'rediscover',name:'tool_search',args:{query:'approve'}}]:order==='later-turn'&&requests.length===4?[{id:'later-custom',name:custom,args:{label:'same'}}]:[];
  res.writeHead(200,{'content-type':'text/event-stream'});const send=(type:string,payload:any={})=>res.write(`event: ${type}
data: ${JSON.stringify({type,...payload})}

`);
  send('message_start',{message:{id:'fixture-'+requests.length,type:'message',role:'assistant',model:'test',content:[],stop_reason:null,usage:{input_tokens:10,output_tokens:0}}});
  calls.forEach((c,i)=>{send('content_block_start',{index:i,content_block:{type:'tool_use',id:c.id,name:c.name,input:{}}});send('content_block_delta',{index:i,delta:{type:'input_json_delta',partial_json:JSON.stringify(c.args)}});send('content_block_stop',{index:i});});
  if(!calls.length){send('content_block_start',{index:0,content_block:{type:'text',text:'DONE'}});send('content_block_stop',{index:0});}
  send('message_delta',{delta:{stop_reason:calls.length?'tool_use':'end_turn',stop_sequence:null},usage:{output_tokens:10}});send('message_stop');res.end();
 });await new Promise<void>(r=>model.listen(0,'127.0.0.1',r));cleanup.push(()=>new Promise<void>(r=>model.close(()=>r())));
 const modelBase='http://127.0.0.1:'+(model.address() as {port:number}).port;

 const entry=process.env.OMA_PI_ACP_ENTRY;if(!entry)throw Error('OMA_PI_ACP_ENTRY official pi-acp 0.1.8 required');
 const distribution=JSON.parse(await readFile(new URL('../package.json','file://'+entry),'utf8'));expect(distribution.name).toBe('@openma/pi-acp');expect(distribution.version).toBe('0.1.8');
 const fixtureToken=generateSandboxToken();let failure:unknown;const workPids:number[]=[];const childErrors:string[]=[];
 const startWork=async()=>{
  const child=fork(fileURLToPath(new URL('./fixtures/core-mcp-work-child.ts',import.meta.url)),[],{execArgv:['--import',fileURLToPath(new URL('../../../node_modules/.pnpm/node_modules/tsx/dist/loader.mjs',import.meta.url))],stdio:['ignore','pipe','pipe','ipc']});
  child.stdout!.on('data',()=>{});child.stderr!.on('data',b=>childErrors.push(String(b)));
  let stopped=false;
  const stop=async()=>{if(stopped)return;stopped=true;const exited=new Promise<void>(r=>child.once('exit',()=>r()));child.send({type:'stop'});await exited;};
  cleanup.push(stop);
  await new Promise<void>((resolve,reject)=>{child.on('message',(message:any)=>{if(message.type==='started'){workPids.push(message.pid);resolve();}if(message.type==='failed'){failure=message.message;reject(Error(message.message));}});child.once('exit',code=>{if(!stopped){failure='Work process exited '+code;reject(Error(String(failure)));}});child.send({type:'start',root,scope,token,sandboxToken,base,modelBase,entry,fixtureToken,generation,holder});});
  return {stop};
 };
 let work=await startWork();await mark('work-ready');
 const wait=async(predicate:()=>boolean)=>{const deadline=Date.now()+20000;while(!predicate()){if(failure)throw failure;if(Date.now()>deadline)throw Error('Work boundary wait exceeded');await new Promise(r=>setTimeout(r,50));}};
 try{
 if(order==='crash-publication'||order==='crash-precommit-recovery'){
  const deadline=Date.now()+20000;let reached=false;
  while(Date.now()<deadline){try{await readFile(join(root,'crash-publication'));reached=true;break;}catch{}await new Promise(r=>setTimeout(r,50));}
  expect(reached).toBe(true);operations.push({path:'fixture/precommit-crash',marker:await readFile(join(root,'crash-publication'),'utf8')});
  await new Promise(r=>setTimeout(r,200));
  const receipts=(await sql.prepare('SELECT document FROM managed_custom_invocations WHERE session_id=?').bind(session.id).all<{document:string}>()).results.map(r=>JSON.parse(r.document));
  expect(receipts).toHaveLength(1);expect(receipts[0]).toMatchObject({state:'unbound',nativeCallId:null});
  expect((await sql.prepare("SELECT count(*) AS n FROM managed_session_events WHERE session_id=? AND type='agent.custom_tool_use'").bind(session.id).first<{n:number}>())!.n).toBe(0);
  await work.stop();host=await startHost();expect(hostPids[1]).not.toBe(hostPids[0]);
  const history=await fetch(base+'/v1/sessions/'+session.id+'/events',{headers:{'x-api-key':'fixture-admin',accept:'application/json'}});expect(history.status).toBe(200);expect(await history.text()).not.toContain('original-custom');
  expect(requests).toHaveLength(2);
  if(order==='crash-publication')return;
  failure=undefined;work=await startWork();
  await wait(()=>nativeEvents.some(e=>e.type==='agent.custom_tool_use'&&e.id==='original-custom'));
  await create('/v1/sessions/'+session.id+'/events',{events:[{type:'user.custom_tool_result',custom_tool_use_id:'original-custom',content:[{type:'text',text:'APPROVED-RECOVERED-PUBLICATION'}]}]});
  await wait(()=>operations.some(o=>o.path.endsWith('/work-publish')&&o.body?.terminal?.stopReason?.type==='end_turn'));
  expect(requests).toHaveLength(3);
  const results=requests[2].messages.flatMap((m:any)=>Array.isArray(m.content)?m.content:[]).filter((c:any)=>c.type==='tool_result'&&c.tool_use_id==='original-custom');
  expect(results).toHaveLength(1);expect(JSON.stringify(results)).toContain('APPROVED-RECOVERED-PUBLICATION');expect(JSON.stringify(requests[2])).not.toContain('omaCustomInvocation');
  expect(await readFile(join(root,'effect.txt'),'utf8')).toBe('effect\n');
  canonicalEvents=(await sql.prepare('SELECT document FROM managed_session_events WHERE session_id=?').bind(session.id).all<{document:string}>()).results.map(r=>JSON.parse(r.document));
  expect(canonicalEvents.filter(e=>e.type==='agent.custom_tool_use'&&e.id==='original-custom')).toHaveLength(1);
  expect(canonicalEvents.filter(e=>e.type==='session.status_idle'&&e.stopReason?.type==='end_turn')).toHaveLength(1);
  expect(canonicalEvents.some(e=>e.stopReason?.type==='retries_exhausted')).toBe(false);
  return;
 }
 if(order==='cancel'||order==='cancel-recovery'){
  await wait(()=>nativeEvents.some(e=>e.type==='agent.custom_tool_use'&&e.id==='original-custom'));
  await mark('cancel-post-start');const response=await create('/v1/sessions/'+session.id+'/events',{events:[{type:'user.interrupt'}]});await mark('cancel-post-done');
  expect(response).toBeDefined();
  const receipt=JSON.parse((await sql.prepare('SELECT document FROM managed_custom_invocations WHERE session_id=? AND native_call_id=?').bind(session.id,'original-custom').first<{document:string}>())!.document);
  expect(receipt.state).toBe('cancelled');
  await new Promise(r=>setTimeout(r,700));expect(requests).toHaveLength(2);
  const canonical=(await sql.prepare('SELECT document FROM managed_session_events WHERE session_id=?').bind(session.id).all<{document:string}>()).results.map(r=>JSON.parse(r.document));
  expect(canonical.filter(e=>e.type==='user.interrupt')).toHaveLength(1);
  expect(canonical.some(e=>e.stopReason?.type==='end_turn')).toBe(false);
  if(order==='cancel')return;
  await mark('cancel-stop-start');await work.stop();await mark('cancel-work-stopped');await host.stop();await mark('cancel-host-stopped');failure=undefined;
  host=await startHost();
  await create('/v1/sessions/'+session.id+'/events',{events:[{type:'user.message',content:[{type:'text',text:'Continue after cancellation with a distinct recovery action'}]}]});
  // A fresh scheduler-owned Work fixture; do not alter Session history/status.
  workId='http-recovery-work-'+session.id;scope={...scope,workId};
  const recoveryAt=new Date().toISOString();
  token='sk-ant-req-v1.'+await crypto.encrypt(JSON.stringify({version:1,...scope,issuedAt:recoveryAt,expiresAt:new Date(Date.now()+300000).toISOString(),claimedAt:recoveryAt,generation:2,skills:[],files:[],memoryStores:[]}));
  await store.insert({workspaceId:'default',record:{work:{id:workId,environmentId:env.id,data:{type:'session',id:session.id},state:'active',createdAt:recoveryAt,acknowledgedAt:recoveryAt,latestHeartbeatAt:recoveryAt,startedAt:recoveryAt,metadata:{},stopRequestedAt:null,stoppedAt:null},secret:{sessionsToken:token},claim:{generation:2,workerId:'http-worker',claimedAt:recoveryAt},heartbeatTtlSeconds:300}});
  sandboxToken=await issueSandboxToken(createSqlEnvironmentWorkSandboxTokenStore(sql),environmentWorkSandboxTokenRef({...scope,generation:2}),{scope:'all'});
  work=await startWork();
  await wait(()=>requests.length>=3);
  const observed=requests[2].messages.flatMap((m:any)=>Array.isArray(m.content)?m.content:[]).filter((b:any)=>b.type==='tool_result'&&b.tool_use_id==='original-custom');
  expect(observed).toHaveLength(1);expect(observed[0].is_error).toBe(true);expect(JSON.stringify(observed[0])).toMatch(/cancel|interrupt/i);
  await wait(()=>operations.some(o=>o.path.endsWith('/work-publish')&&o.body?.terminal?.stopReason?.type==='end_turn'));
  expect(requests).toHaveLength(4);
  const recoveredHistory=canonicalEvents=(await sql.prepare('SELECT document FROM managed_session_events WHERE session_id=?').bind(session.id).all<{document:string}>()).results.map(r=>JSON.parse(r.document));
  expect(recoveredHistory.filter(e=>e.type==='agent.tool_result'&&e.toolUseId==='original-custom')).toHaveLength(1);
  expect(recoveredHistory.filter(e=>e.type==='session.status_idle'&&e.stopReason?.type==='end_turn')).toHaveLength(1);
  expect(recoveredHistory.some(e=>e.stopReason?.type==='retries_exhausted')).toBe(false);
  expect(await readFile(join(root,'recovery.txt'),'utf8')).toBe('recovered');
  expect(await readFile(join(root,'effect.txt'),'utf8')).toBe('effect\n');
  expect(nativeEvents.filter(e=>e.type==='agent.custom_tool_use'&&e.id==='original-custom')).toHaveLength(1);
  expect(nativeEvents.some(e=>e.stop_reason?.type==='retries_exhausted')).toBe(false);
  return;
 }
 if(order==='crash-ack'){
  let reached=false;const deadline=Date.now()+20000;
  while(Date.now()<deadline){try{await readFile(join(root,'crash-ack'));reached=true;break;}catch{}await new Promise(r=>setTimeout(r,50));}
  expect(reached).toBe(true);operations.push({path:'fixture/postcommit-crash',marker:await readFile(join(root,'crash-ack'),'utf8')});
  const persisted=(await sql.prepare('SELECT document FROM managed_custom_invocations WHERE session_id=?').bind(session.id).all<{document:string}>()).results.map(r=>JSON.parse(r.document));
  expect(persisted).toHaveLength(1);expect(persisted[0]).toMatchObject({state:'pending',nativeCallId:'original-custom'});
  expect((await sql.prepare("SELECT count(*) AS n FROM managed_session_events WHERE session_id=? AND type='agent.custom_tool_use'").bind(session.id).first<{n:number}>())!.n).toBe(1);
  await work.stop();failure=undefined;host=await startHost();work=await startWork();
  await create('/v1/sessions/'+session.id+'/events',{events:[{type:'user.custom_tool_result',custom_tool_use_id:'original-custom',content:[{type:'text',text:'APPROVED-AFTER-CRASH'}]}]});
  await wait(()=>operations.some(o=>o.path.endsWith('/work-publish')&&o.body?.terminal?.stopReason?.type==='end_turn'));
  expect(requests).toHaveLength(3);const returned=requests[2].messages.flatMap((m:any)=>Array.isArray(m.content)?m.content:[]).filter((c:any)=>c.type==='tool_result'&&c.tool_use_id==='original-custom');
  expect(returned).toHaveLength(1);expect(JSON.stringify(returned)).toContain('APPROVED-AFTER-CRASH');expect(JSON.stringify(requests[2])).not.toContain('omaCustomInvocation');
  expect(await readFile(join(root,'effect.txt'),'utf8')).toBe('effect\n');
  canonicalEvents=(await sql.prepare('SELECT document FROM managed_session_events WHERE session_id=?').bind(session.id).all<{document:string}>()).results.map(r=>JSON.parse(r.document));
  expect(canonicalEvents.filter(e=>e.type==='agent.custom_tool_use'&&e.id==='original-custom')).toHaveLength(1);
  expect(canonicalEvents.filter(e=>e.type==='session.status_idle'&&e.stopReason?.type==='end_turn')).toHaveLength(1);
  expect(canonicalEvents.some(e=>e.stopReason?.type==='retries_exhausted')).toBe(false);
  return;
 }
 await wait(()=>operations.some(o=>o.path.endsWith('/work-publish')&&o.body?.terminal?.stopReason?.type==='requires_action'));
 expect(requests).toHaveLength(parkRequests);expect(await readFile(join(root,'effect.txt'),'utf8')).toBe('effect\n');
 const receipts=(await sql.prepare('SELECT document FROM managed_custom_invocations WHERE session_id=?').bind(session.id).all<{document:string}>()).results.map(r=>JSON.parse(r.document));expect(receipts).toHaveLength(ids.length+(transport?1:0));if(transport)expect(receipts.filter(r=>r.state==='unbound')).toHaveLength(1);for(const id of ids)expect(receipts.find(r=>r.nativeCallId===id)).toMatchObject({state:'pending'});expect(new Set(receipts.map(r=>r.receipt)).size).toBe(receipts.length);
 const uses=nativeEvents.filter(e=>e.type==='agent.custom_tool_use');expect(uses).toHaveLength(ids.length);for(const id of ids)expect(uses.filter(e=>e.id===id)).toHaveLength(1);await mark('parked');
 await work.stop();await host.stop();
 if(order==='takeover'){
  const location={workspaceId:'default',environmentId:env.id,workId};
  const previous=(await store.find(location))!;
  expect((await store.replace({...location,expectedRevision:previous.revision,next:{...previous,claim:{...previous.claim!,claimedAt:new Date(Date.now()-10000).toISOString()},heartbeatTtlSeconds:1}})).type).toBe('replaced');
  holder='replacement-worker';
  const acquired=await store.claimAvailable({...location,workerId:holder,claimedAt:new Date().toISOString(),reclaimBefore:new Date(Date.now()-1000).toISOString(),heartbeatTtlSeconds:300});
  expect(acquired.type).toBe('claimed');if(acquired.type!=='claimed')throw Error('No takeover');
  expect(acquired.record.work.id).toBe(workId);generation=acquired.record.claim!.generation;expect(generation).toBe(3);
  const oldToken=token;
  const claimedAt=acquired.record.claim!.claimedAt;
  token='sk-ant-req-v1.'+await crypto.encrypt(JSON.stringify({version:1,...location,sessionId:session.id,issuedAt:claimedAt,claimedAt,expiresAt:new Date(Date.now()+300000).toISOString(),generation,skills:[],files:[],memoryStores:[]}));
  expect((await store.replace({...location,expectedRevision:acquired.record.revision,next:{...acquired.record,work:{...acquired.record.work,state:'active',acknowledgedAt:claimedAt,latestHeartbeatAt:claimedAt,startedAt:claimedAt},secret:{sessionsToken:token}}})).type).toBe('replaced');
  sandboxToken=await issueSandboxToken(createSqlEnvironmentWorkSandboxTokenStore(sql),environmentWorkSandboxTokenRef({...scope,generation}),{scope:'all'});
  host=await startHost();
  const denied=await post('/v1/oma/sessions/'+session.id+'/work-recovery',{turnId:'stale'},oldToken);expect(denied.status).toBe(401);
  operations.push({path:'fixture/takeover',event:'same-work-takeover',workId,oldGeneration:2,generation,oldTokenStatus:denied.status});
 }else host=await startHost();expect(hostPids).toHaveLength(2);expect(hostPids[0]).not.toBe(hostPids[1]);work=await startWork();expect(workPids).toHaveLength(2);expect(workPids[0]).not.toBe(workPids[1]);await mark('host-and-work-recreated');
 if(ids.length>1){
  await create('/v1/sessions/'+session.id+'/events',{events:[{type:'user.custom_tool_result',custom_tool_use_id:ids[0],content:[{type:'text',text:'APPROVED-FIRST'}]}]});
  await new Promise(r=>setTimeout(r,400));expect(requests).toHaveLength(parkRequests);
 }
 await create('/v1/sessions/'+session.id+'/events',{events:ids.slice(ids.length>1?1:0).map(id=>({type:'user.custom_tool_result',custom_tool_use_id:id,content:[{type:'text',text:'APPROVED-'+id}]}))});
 if(order==='later-turn'){
  await wait(()=>nativeEvents.some(e=>e.type==='agent.custom_tool_use'&&e.id==='later-custom')&&operations.filter(o=>o.path.endsWith('/work-publish')&&o.body?.terminal?.stopReason?.type==='requires_action').length===2);
  expect(requests).toHaveLength(4);
  const recoveredHistory=canonicalEvents=(await sql.prepare('SELECT document FROM managed_session_events WHERE session_id=?').bind(session.id).all<{document:string}>()).results.map(r=>JSON.parse(r.document));
  expect(recoveredHistory.filter(e=>e.type==='agent.tool_result'&&e.toolUseId==='original-custom')).toHaveLength(1);
  expect(recoveredHistory.filter(e=>e.type==='session.status_idle'&&e.stopReason?.type==='end_turn')).toHaveLength(1);
  expect(recoveredHistory.some(e=>e.stopReason?.type==='retries_exhausted')).toBe(false);
  const rows=(await sql.prepare('SELECT document, turn_id FROM managed_custom_invocations WHERE session_id=?').bind(session.id).all<{document:string;turn_id:string}>()).results.map(r=>({...JSON.parse(r.document),turnId:r.turn_id}));
  const original=rows.find(r=>r.nativeCallId==='original-custom');const later=rows.find(r=>r.nativeCallId==='later-custom');
  expect(original.state).toBe('resolved');expect(later.state).toBe('pending');expect(later.turnId).not.toBe(original.turnId);expect(later.receipt).not.toBe(original.receipt);
  await create('/v1/sessions/'+session.id+'/events',{events:[{type:'user.custom_tool_result',custom_tool_use_id:'later-custom',content:[{type:'text',text:'APPROVED-LATER'}]}]});
 }
 await wait(()=>operations.some(o=>o.path.endsWith('/work-publish')&&o.body?.terminal?.stopReason?.type==='end_turn'));
 expect(requests).toHaveLength(parkRequests+(order==='later-turn'?3:1));expect(JSON.stringify(requests[parkRequests].messages)).toContain('APPROVED');expect(JSON.stringify(requests[parkRequests].messages)).not.toContain('omaCustomInvocation');expect(await readFile(join(root,'effect.txt'),'utf8')).toBe('effect\n');
 const canonical=canonicalEvents=(await sql.prepare('SELECT document FROM managed_session_events WHERE session_id=?').bind(session.id).all<{document:string}>()).results.map(r=>JSON.parse(r.document));
 expect(canonical.filter(e=>e.type==='session.status_idle'&&e.stopReason?.type==='end_turn')).toHaveLength(1);
 expect(canonical.some(e=>e.stopReason?.type==='retries_exhausted')).toBe(false);
 expect(operations.filter(o=>o.mcpMethod==='tools/call'&&o.status===200)).toHaveLength(ids.length+(order==='later-turn'?1:0));
 for(const id of ids){const results=requests[parkRequests].messages.flatMap((m:any)=>Array.isArray(m.content)?m.content:[]).filter((b:any)=>b.type==='tool_result'&&b.tool_use_id===id);expect(results).toHaveLength(1);expect(JSON.stringify(results[0])).toContain('APPROVED');}
 if(transport){
  const observedError=requests[2].messages.flatMap((m:any)=>Array.isArray(m.content)?m.content:[]).filter((b:any)=>b.type==='tool_result'&&b.tool_use_id==='failed-custom');expect(observedError).toHaveLength(1);expect(observedError[0].is_error).toBe(true);
  expect(operations.filter(o=>o.faultAfterCommit)).toHaveLength(1);
  expect(nativeEvents.filter(e=>e.type==='agent.custom_tool_use'&&e.id==='failed-custom')).toHaveLength(0);
 }
 }finally{if(process.env.OMA_WORK_TRACE)await writeFile(process.env.OMA_WORK_TRACE+'.'+order+'.json',JSON.stringify({scope,requests,operations,nativeEvents,canonicalEvents,workPids,childErrors,hostPids,hostErrors,failure:String(failure??'')},null,2));}
},60000);
