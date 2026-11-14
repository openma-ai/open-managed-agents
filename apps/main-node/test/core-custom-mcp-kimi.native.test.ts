import {spawn} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { loadNodeConfig } from "../src/config.js";
import { nodeDefaults } from "../src/components.js";
import { createNodeControlPlane } from "../src/control-plane.js";
import {issueSandboxToken} from "../../../packages/sandbox-gateway/src/index";
import {createSqlEnvironmentWorkSandboxTokenStore,environmentWorkSandboxTokenRef} from "../../../packages/sandbox-gateway-sql/src/index";
import { SqlEnvironmentWorkStore } from "../../../packages/environment-work-store-sql/src/index";
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
it("official Kimi invokes Core approve and observes the canonical external answer",async()=>{
 await mkdir(join(process.cwd(),".test-artifacts"),{recursive:true});
 const root=await mkdtemp(join(process.cwd(),".test-artifacts/work-inputs-"));cleanup.push(()=>rm(root,{recursive:true,force:true}));
 const config=loadNodeConfig({NODE_ENV:"test",AUTH_DISABLED:"0",API_KEY:"fixture-admin",PLATFORM_ROOT_SECRET:"test-work-inputs-root-secret-32-characters",OPENMA_TEST_SANDBOX_PROVIDER:"local-subprocess",DATABASE_PATH:join(root,"db.sqlite"),AUTH_DATABASE_PATH:join(root,"auth.sqlite"),MEMORY_BLOB_DIR:join(root,"memory"),SESSION_OUTPUTS_DIR:join(root,"outputs"),SANDBOX_WORKDIR:join(root,"sandbox"),MEMORY_QUEUE:"disabled"});
 const components=await nodeDefaults(config);const cp=await createNodeControlPlane(components);cleanup.push(()=>cp.stop("test"));
 const server=serve({fetch:cp.fetch,hostname:"127.0.0.1",port:0});cleanup.push(()=>new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve())));
 if(!server.listening)await new Promise<void>(resolve=>server.once("listening",resolve));
 const base="http://127.0.0.1:"+(server.address() as {port:number}).port;
 const post=async(path:string,body:unknown,token?:string)=>fetch(base+path,{method:"POST",headers:{"content-type":"application/json",...(token?{authorization:"Bearer "+token}:{"x-api-key":"fixture-admin"})},body:JSON.stringify(body)});
 const create=async(path:string,body:unknown)=>{const r=await post(path,body);expect(r.status,await r.clone().text()).toBeLessThan(300);return r.json() as Promise<any>;};
 const env=await create("/v1/environments",{name:"inputs",config:{type:"cloud",networking:{type:"unrestricted"}}});
 const agent=await create("/v1/agents",{name:"inputs",model:"test",tools:[{type:"custom",name:"approve",description:"Approval",input_schema:{type:"object",properties:{label:{type:"string"}},required:["label"]}}],_oma:{harness:"acp-sandbox",acp:{agent:{registry:"claude-acp@0.94.0"}}}});
 const session=await create("/v1/sessions",{agent:agent.id,environment_id:env.id,initial_events:[{type:"user.message",content:[{type:"text",text:"first"}]}]});
 const sql=components.database.sql;
 const crypto=components.secrets!.cipherFor("managed.environment-work.session-token");
 const cipher=components.secrets!.cipherFor("managed.environment-work.secret");
 const store=new SqlEnvironmentWorkStore(sql,{seal:async({plaintext})=>({ciphertext:await cipher.encrypt(plaintext)}),open:async({ciphertext})=>({plaintext:await cipher.decrypt(ciphertext)})});
 const now=new Date().toISOString();const workId="http-input-work";
 const token="sk-ant-req-v1."+await crypto.encrypt(JSON.stringify({version:1,workspaceId:"default",environmentId:env.id,sessionId:session.id,workId,issuedAt:now,expiresAt:new Date(Date.now()+60000).toISOString(),claimedAt:now,generation:2,skills:[],files:[],memoryStores:[]}));
 // Remove only the test Session's queued scheduling artifact; install a real claimed Work.
 await sql.prepare("DELETE FROM managed_environment_work WHERE session_id=?").bind(session.id).run();
 await store.insert({workspaceId:"default",record:{work:{id:workId,environmentId:env.id,data:{type:"session",id:session.id},state:"active",createdAt:now,acknowledgedAt:now,latestHeartbeatAt:now,startedAt:now,metadata:{},stopRequestedAt:null,stoppedAt:null},secret:{sessionsToken:token},claim:{generation:2,workerId:"http-worker",claimedAt:now},heartbeatTtlSeconds:90}});
 const path="/v1/oma/sessions/"+session.id;
 expect((await post(path+"/inputs-read",{cursor:null,limit:2})).status).toBe(401);
 const response=await post(path+"/inputs-read",{cursor:null,limit:2},token);
 expect(response.status,await response.clone().text()).toBe(200);
 const page=await response.json() as any;expect(page.rows[0]).toMatchObject({event:{id:"bootstrap_"+session.id+":0",processedAt:null},position:{revision:1,index:0}});

 const row=page.rows[0];const input={inputId:row.event.id,turnId:row.event.id,expectedDocument:row.document,boundary:"before_dispatch"};
 expect((await post(path+'/inputs-consume',input,token)).status).toBe(200);
 const rootBytes=(await sql.prepare('SELECT document FROM managed_session_initial_events WHERE session_id=? AND sequence=0').bind(session.id).first<{document:string}>())!.document;
 const sandboxToken=await issueSandboxToken(createSqlEnvironmentWorkSandboxTokenStore(sql),environmentWorkSandboxTokenRef({workspaceId:'default',environmentId:env.id,sessionId:session.id,workId,generation:2}),{scope:'all'});

 let granted:string|null=null,used=false,receipt:string|null=null;
 let pendingResolve!:()=>void;const pending=new Promise<void>(r=>pendingResolve=r);
 let release!:()=>void;const answered=new Promise<void>(r=>release=r);
 const readReceipt=async()=>JSON.parse((await sql.prepare('SELECT document FROM managed_custom_invocations WHERE receipt=?').bind(receipt).first<{document:string}>())!.document);
 const observations:any[]=[];
 // A fixture-owned permission dispatcher serializes one native grant. It never
 // infers identity from arguments or JSON-RPC IDs. This is not production Work
 // integration or a general concurrent-grant/restart implementation.
 const bridge=serve({hostname:'127.0.0.1',port:0,fetch:async request=>{
  const body=await request.json() as any;
  if(new URL(request.url).pathname==='/permission'){
   if(granted||body.title!=='mcp__oma__approve'||typeof body.toolCallId!=='string')return new Response('invalid grant',{status:409});
   granted=body.toolCallId;observations.push({phase:'grant',nativeCallId:granted});return Response.json({ok:true});
  }
  if(!granted||used)return new Response('no unique native grant',{status:409});used=true;
  observations.push({phase:'mcp-tools-call',parameters:body,nativeCallId:granted});
  const mcp=await fetch(base+path+'/custom-tools/'+encodeURIComponent(row.event.id)+'/mcp',{method:'POST',headers:{authorization:'Bearer '+sandboxToken,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:917,method:'tools/call',params:body})});
  if(mcp.status!==200)return new Response('Core rejected',{status:500});
  receipt=(await mcp.json() as any).result.structuredContent.omaCustomInvocation.receipt;
  const publication=await post(path+'/runtime-events',{root:{inputId:row.event.id,turnId:row.event.id,expectedDocument:rootBytes},customInvocations:[{receipt,nativeCallId:granted}],events:[{id:granted,type:'agent.custom_tool_use',name:'approve',input:body.arguments,processed_at:now},{id:'park',type:'session.status_idle',stop_reason:{type:'requires_action',event_ids:[granted]},processed_at:now}]},token);
  observations.push({phase:'publication',status:publication.status,receipt,nativeCallId:granted});
  if(publication.status!==200)return new Response('publication rejected',{status:500});
  pendingResolve();await answered;
  const result=await readReceipt();return Response.json(result.result);
 }});
 if(!bridge.listening)await new Promise<void>(r=>bridge.once('listening',r));
 cleanup.push(()=>new Promise<void>(r=>bridge.close(()=>r())));
 const evidence=process.env.KIMI_BEHAVIOR_EVIDENCE!;if(!evidence)throw Error('KIMI_BEHAVIOR_EVIDENCE is required');
 const executable=process.env.KIMI_OFFICIAL_EXECUTABLE;
 if(!executable)throw Error('KIMI_OFFICIAL_EXECUTABLE for official @moonshot-ai/kimi-code 2.6.0 is required');
 const metadata=JSON.parse(await readFile(join(executable,'../../package.json'),'utf8'));
 expect(metadata.name).toBe('@moonshot-ai/kimi-code');expect(metadata.version).toBe('2.6.0');
 const home=join(root,'kimi');await mkdir(home);
 const trace=join(evidence,process.env.KIMI_BEHAVIOR_LABEL!+'.native.json');
 const child=spawn('python3',[join(process.cwd(),'test/fixtures/kimi-core-native.py')],{env:{...process.env,KIMI_TEST_HOME:home,KIMI_TEST_TRACE:trace,CORE_BRIDGE:'http://127.0.0.1:'+(bridge.address() as {port:number}).port},stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
 const exited=new Promise<number|null>(r=>child.once('exit',r));cleanup.push(async()=>{release();if(child.exitCode===null)child.kill();await exited;});
 await Promise.race([pending,exited.then(()=>{throw Error('Official Kimi exited before Core pending: '+output);}),new Promise((_,reject)=>setTimeout(()=>reject(Error('No canonical pending')),25000))]);
 const pendingRecord=await readReceipt();
 expect(pendingRecord).toMatchObject({state:'pending',nativeCallId:'0:original_alpha'});
 observations.push({phase:'durable-pending',record:pendingRecord});
 const external=await post('/v1/sessions/'+session.id+'/events',{events:[{type:'user.custom_tool_result',custom_tool_use_id:granted,content:[{type:'text',text:'APPROVED-CANONICAL-2052'}]}]});
 expect(external.status).toBeLessThan(300);
 const admitted=(await sql.prepare("SELECT document FROM managed_session_events WHERE session_id=? AND type='user.custom_tool_result'").bind(session.id).first<{document:string}>())!;
 const answer=JSON.parse(admitted.document);
 const consumed=await post(path+'/inputs-consume',{inputId:answer.id,turnId:answer.source_position.execution_id??answer.id,expectedDocument:admitted.document,boundary:'before_dispatch'},token);
 expect(consumed.status).toBe(200);
 expect(await readReceipt()).toMatchObject({state:'resolved',nativeCallId:granted,result:{content:[{type:'text',text:'APPROVED-CANONICAL-2052'}],isError:false}});
 release();expect(await exited,output).toBe(0);
 const native=JSON.parse(await readFile(trace,'utf8'));
 expect(JSON.stringify(native.requests.slice(1))).toContain('APPROVED-CANONICAL-2052');
 const results=native.requests.flatMap((r:any)=>r.messages??[]).flatMap((m:any)=>Array.isArray(m.content)?m.content:[]).filter((c:any)=>c.type==='tool_result'&&c.tool_use_id==='original_alpha');
 expect(JSON.stringify(results)).toContain('APPROVED-CANONICAL-2052');
 expect(native.events.filter((e:any)=>e.id===3&&e.result?.stopReason==='end_turn')).toHaveLength(1);
 expect(observations.filter(x=>x.phase==='publication')).toHaveLength(1);
 await writeFile(join(evidence,process.env.KIMI_BEHAVIOR_LABEL!+'.canonical.json'),JSON.stringify({sessionId:session.id,workId,receipt,observations,record:await readReceipt(),output},null,2));
},40000);
