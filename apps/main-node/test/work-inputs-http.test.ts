import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { loadNodeConfig } from "../src/config.js";
import { nodeDefaults } from "../src/components.js";
import { createNodeControlPlane } from "../src/control-plane.js";
import { SqlEnvironmentWorkStore } from "../../../packages/environment-work-store-sql/src/index";
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
it("production Node HTTP mounts Work bearer input read/consume including canonical bootstrap",async()=>{
 await mkdir(join(process.cwd(),".test-artifacts"),{recursive:true});
 const root=await mkdtemp(join(process.cwd(),".test-artifacts/work-inputs-"));cleanup.push(()=>rm(root,{recursive:true,force:true}));
 const config=loadNodeConfig({NODE_ENV:"test",AUTH_DISABLED:"1",PLATFORM_ROOT_SECRET:"test-work-inputs-root-secret-32-characters",OPENMA_TEST_SANDBOX_PROVIDER:"local-subprocess",DATABASE_PATH:join(root,"db.sqlite"),AUTH_DATABASE_PATH:join(root,"auth.sqlite"),MEMORY_BLOB_DIR:join(root,"memory"),SESSION_OUTPUTS_DIR:join(root,"outputs"),SANDBOX_WORKDIR:join(root,"sandbox"),MEMORY_QUEUE:"disabled"});
 const components=await nodeDefaults(config);const cp=await createNodeControlPlane(components);cleanup.push(()=>cp.stop("test"));
 const server=serve({fetch:cp.fetch,hostname:"127.0.0.1",port:0});cleanup.push(()=>new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve())));
 if(!server.listening)await new Promise<void>(resolve=>server.once("listening",resolve));
 const base="http://127.0.0.1:"+(server.address() as {port:number}).port;
 const post=async(path:string,body:unknown,token?:string)=>fetch(base+path,{method:"POST",headers:{"content-type":"application/json",...(token?{authorization:"Bearer "+token}:{})},body:JSON.stringify(body)});
 const create=async(path:string,body:unknown)=>{const r=await post(path,body);expect(r.status,await r.clone().text()).toBeLessThan(300);return r.json() as Promise<any>;};
 const env=await create("/v1/environments",{name:"inputs",config:{type:"cloud",networking:{type:"unrestricted"}}});
 const agent=await create("/v1/agents",{name:"inputs",model:"test",_oma:{harness:"acp-sandbox",acp:{agent:{registry:"claude-acp@0.94.0"}}}});
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
 const resume=JSON.stringify({id:"http-resume",type:"session.updated",resume:true,processedAt:null,source_position:{revision:2,index:0}});
 await sql.prepare("INSERT INTO managed_session_events (workspace_id,session_id,id,type,document,processed_at) VALUES ('default',?,'http-resume','session.updated',?,0)").bind(session.id,resume).run();
 const resumed=await post(path+"/inputs-read",{cursor:page.cursor,limit:2},token);
 expect(resumed.status).toBe(200);
 expect((await resumed.json() as any).rows).toEqual([{event:{id:"http-resume",type:"session.updated",resume:true,processedAt:null},position:{revision:2,index:0},document:resume}]);
 const row=page.rows[0];const input={inputId:row.event.id,turnId:row.event.id,expectedDocument:row.document,boundary:"before_dispatch"};
 const results=await Promise.all([post(path+"/inputs-consume",input,token),post(path+"/inputs-consume",input,token)]);
 expect(results.map(r=>r.status).sort()).toEqual([200,409]);
 const stored=await sql.prepare("SELECT document FROM managed_session_initial_events WHERE session_id=? AND sequence=0").bind(session.id).first<{document:string}>();
 expect(JSON.parse(stored!.document).processedAt).not.toBeNull();
 // Cross-turn ownership over real HTTP, rooted in the actual consumed bootstrap.
 const rootId="bootstrap_"+session.id+":0";
 const rootBytes=(await sql.prepare("SELECT document FROM managed_session_initial_events WHERE session_id=? AND sequence=0").bind(session.id).first<{document:string}>())!.document;
 const toolDoc=JSON.stringify({id:"owned-tool",type:"agent.tool_use",evaluatedPermission:"ask",name:"bash",input:{command:"echo yes"},processedAt:now,source_position:{revision:3,index:0,execution_id:rootId,environment_work:{workId:workId,generation:2}}});
 const answerDoc=JSON.stringify({id:"owned-answer",type:"user.tool_confirmation",toolUseId:"owned-tool",result:"allow",processedAt:null,source_position:{revision:4,index:0,execution_id:"answer-dispatch"}});
 for(const [id,type,raw] of [["owned-tool","agent.tool_use",toolDoc],["owned-answer","user.tool_confirmation",answerDoc]])await sql.prepare("INSERT INTO managed_session_events (workspace_id,session_id,id,type,document,processed_at) VALUES (?,?,?,?,?,0)").bind("default",session.id,id,type,raw).run();
 await sql.prepare("UPDATE managed_sessions SET revision=4 WHERE id=?").bind(session.id).run();
 const ownershipBody={inputId:"owned-answer",turnId:"answer-dispatch",consumingTurnId:rootId,rootInputId:rootId,expectedRootDocument:rootBytes,expectedDocument:answerDoc,boundary:"before_dispatch"};
 const owned=await post(path+"/inputs-consume",ownershipBody,token);
 expect(owned.status,await owned.clone().text()).toBe(200);
 expect(await owned.json()).toMatchObject({type:"consumed",turnId:"answer-dispatch",consumingTurnId:rootId});
 for(const [index,payload] of [
  {type:"user.define_outcome",description:"Ship report",rubric:{type:"text",content:"All checks pass"},maxIterations:4,outcomeId:"outcome_http"},
  {type:"user.tool_result",toolUseId:"tool_http",content:[{type:"text",text:"complete"}],isError:false},
  {type:"session.updated",resume:true,budget:{tokens:10000}},
  {type:"session.updated",budget:{tokens:10000}},
  {type:"session.updated",title:"not runnable",resume:"true"},
 ].entries()){
  const id="runnable_"+index;
  const original={...payload,id,processedAt:now,source_position:{revision:10+index,index:0,execution_id:"turn_"+id}};
  const document=JSON.stringify(original);
  await sql.prepare("INSERT INTO managed_session_events (workspace_id,session_id,id,type,document,processed_at) VALUES (?,?,?,?,?,?)").bind("default",session.id,id,payload.type,document,Date.parse(now)).run();
  const consume={inputId:id,turnId:"turn_"+id,expectedDocument:document,boundary:"before_dispatch"};
  const result=await post(path+"/inputs-consume",consume,token);
  expect(result.status,await result.clone().text()).toBe(index<3?200:409);
  const stored=JSON.parse((await sql.prepare("SELECT document FROM managed_session_events WHERE workspace_id=? AND session_id=? AND id=?").bind("default",session.id,id).first<{document:string}>())!.document);
  expect(stored).toEqual(index<3?{...original,source_position:{...original.source_position,consumed_by_execution_id:"turn_"+id,consumption_claim:{workId,generation:2,holder:"http-worker"}}}:original);
 }
 for(const mutation of ["claim_generation=3","claim_at=0","claim_worker_id=NULL"]){
  await sql.prepare("UPDATE managed_environment_work SET "+mutation+" WHERE id=?").bind(workId).run();
  expect((await post(path+"/inputs-read",{cursor:null,limit:2},token)).status).toBe(401);
  await sql.prepare("UPDATE managed_environment_work SET claim_generation=2,claim_at=?,claim_worker_id='http-worker' WHERE id=?").bind(Date.parse(now),workId).run();
 }
});
