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
it.each(["running","idle","answer-first","rollback","rollback-result","stale-generation","cancel-before-publication"])("production Node HTTP custom cancellation %s",async(mode)=>{
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
 const mcp=await fetch(base+path+'/custom-tools/'+encodeURIComponent(row.event.id)+'/mcp',{method:'POST',headers:{authorization:'Bearer '+sandboxToken,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:7,method:'tools/call',params:{name:'approve',arguments:{label:'same'}}})});
 expect(mcp.status,await mcp.clone().text()).toBe(200);
 const receipt=(await mcp.json() as any).result.structuredContent.omaCustomInvocation.receipt;
 if(mode==='cancel-before-publication')expect((await post('/v1/sessions/'+session.id+'/events',{events:[{type:'user.interrupt'}]})).status).toBeLessThan(300);
 const publication=await post(path+'/runtime-events',{root:{inputId:row.event.id,turnId:row.event.id,expectedDocument:rootBytes},customInvocations:[{receipt,nativeCallId:'native-approve'}],events:[{id:'native-approve',type:'agent.custom_tool_use',name:'approve',input:{label:'same'},processed_at:now},...(mode==='idle'?[{id:'park',type:'session.status_idle',stop_reason:{type:'requires_action',event_ids:['native-approve']},processed_at:now}]:[])]},token);
 if(mode==='cancel-before-publication'){
  expect(publication.status).toBe(401); // interrupt revokes the Work bearer before projection
  const stored=JSON.parse((await sql.prepare('SELECT document FROM managed_custom_invocations WHERE receipt=?').bind(receipt).first<{document:string}>())!.document);
  expect(stored).toMatchObject({state:'unbound',nativeCallId:null});
  expect((await sql.prepare("SELECT count(*) AS n FROM managed_session_events WHERE session_id=? AND type='agent.custom_tool_use'").bind(session.id).first<{n:number}>())!.n).toBe(0);return;
 }
 expect(publication.status,await publication.clone().text()).toBe(200);
 const readReceipt=async()=>JSON.parse((await sql.prepare('SELECT document FROM managed_custom_invocations WHERE receipt=?').bind(receipt).first<{document:string}>())!.document);
 expect(await readReceipt()).toMatchObject({state:'pending',nativeCallId:'native-approve'});
 if(mode==='answer-first')expect((await post('/v1/sessions/'+session.id+'/events',{events:[{type:'user.custom_tool_result',custom_tool_use_id:'native-approve',content:[{type:'text',text:'first answer'}]}]})).status).toBeLessThan(300);
 if(mode==='stale-generation')await sql.prepare('UPDATE managed_environment_work SET claim_generation=3 WHERE id=?').bind(workId).run();
 if(mode==='rollback')await sql.prepare("CREATE TRIGGER cancellation_fault AFTER UPDATE ON managed_custom_invocations BEGIN SELECT RAISE(ABORT,'controlled cancellation transaction fault'); END").run();
 if(mode==='rollback-result')await sql.prepare("CREATE TRIGGER cancellation_result_fault BEFORE INSERT ON managed_session_events WHEN NEW.type='agent.tool_result' BEGIN SELECT RAISE(ABORT,'controlled result persistence fault'); END").run();
 const interrupted=await post('/v1/sessions/'+session.id+'/events',{events:[{type:'user.interrupt'}]});
 if(mode==='rollback'||mode==='rollback-result'){
  expect(interrupted.status).toBe(500);
  expect((await sql.prepare("SELECT count(*) AS n FROM managed_session_events WHERE session_id=? AND type='user.interrupt'").bind(session.id).first<{n:number}>())!.n).toBe(0);
  expect(await readReceipt()).toMatchObject({state:'pending'});
  expect((await sql.prepare("SELECT count(*) AS n FROM managed_session_events WHERE session_id=? AND type='agent.tool_result'").bind(session.id).first<{n:number}>())!.n).toBe(0);return;
 }
 expect(interrupted.status,await interrupted.clone().text()).toBeLessThan(300);
 const accepted=(await sql.prepare("SELECT document FROM managed_session_events WHERE session_id=? AND type='user.interrupt'").bind(session.id).first<{document:string}>())!;
 expect(JSON.parse(accepted.document).environmentWorkId).toBe(mode==='idle'?null:workId);
 expect(await readReceipt()).toMatchObject({state:mode==='running'?'cancelled':'pending',nativeCallId:'native-approve',result:null});
 const closures=async()=>(await sql.prepare("SELECT document FROM managed_session_events WHERE session_id=? AND type='agent.tool_result'").bind(session.id).all<{document:string}>()).results.map(r=>JSON.parse(r.document)).filter(e=>e.toolUseId==='native-approve');
 expect(await closures()).toHaveLength(mode==='running'?1:0);
 if(mode==='running'){
  expect((await closures())[0]).toMatchObject({isError:true,content:[{type:'text',text:'Tool execution interrupted by user'}]});
  expect((await post('/v1/sessions/'+session.id+'/events',{events:[{type:'user.interrupt'}]})).status).toBeLessThan(300);
  expect(await closures()).toHaveLength(1);
 }
 console.info(JSON.stringify({mode,sessionId:session.id,workId,receipt,interrupt:JSON.parse(accepted.document).id,state:(await readReceipt()).state}));
});
