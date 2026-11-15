import { URL } from "node:url";

import { afterAll, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { serve } from "@hono/node-server";
import { WebCryptoAesGcm } from "../../../packages/integrations-adapters-cf/src/index";
import { SqlEnvironmentWorkStore } from "../../../packages/environment-work-store-sql/src/index";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import { SqlSessionStore } from "../../../packages/session-store-sql/src/index";
import * as inputRoutes from "../../../apps/main/src/lib/cf-work-inputs";
const cleanup:Array<()=>Promise<void>>=[];
afterAll(async()=>{for(const close of cleanup.reverse())await close();});
it("CF production factory serves real HTTP + workerd D1 with sealed Work auth and bootstrap CAS",async()=>{
 expect(typeof inputRoutes.cfWorkInputRoutes).toBe("function");
 const require=createRequire(import.meta.url);const {Miniflare,convertV4MiniflareOptions}=createRequire(require.resolve("wrangler/package.json"))("miniflare");
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:"export default {fetch(){return new Response('ok')}}",compatibilityDate:"2026-11-01",d1Databases:["DB"]}));cleanup.push(()=>mf.dispose());
 const db=await mf.getD1Database("DB");const sql=new CfD1SqlClient(db);
 // Run actual deployment baseline, including the latest validation migration.
 const directory=new URL("../../../apps/main/migrations/",import.meta.url);
 for(const name of (await readdir(directory)).filter(n=>n.endsWith(".sql")).sort()){
  const migration=await readFile(new URL(name,directory),"utf8");
  for(const statement of migration.split("--> statement-breakpoint").map((s:string)=>s.trim()).filter(Boolean)) await sql.exec(statement.replace(/--[^\n]*/g, "").replace(/\s+/g," "));
 }
 const now=new Date().toISOString();const root="work-inputs-cf-test-secret-32-characters";
 const session={id:"s",environmentId:"env",agent:{id:"a",version:1,skills:[]},resources:[],createdAt:now,updatedAt:now,archivedAt:null,status:"idle"};
 await new SqlSessionStore(sql,{seal:async s=>s},{canonicalBootstrap:true}).insert({workspaceId:"ws",session:session as never,initialEvents:[{type:"user.message",content:[{type:"text",text:"first"}]}],resourceSecrets:[]});
 const tokenCrypto=new WebCryptoAesGcm(root,"managed.environment-work.session-token");
 const token="sk-ant-req-v1."+await tokenCrypto.encrypt(JSON.stringify({version:1,workspaceId:"ws",environmentId:"env",sessionId:"s",workId:"w",issuedAt:now,expiresAt:new Date(Date.now()+60000).toISOString(),claimedAt:now,generation:2,skills:[],files:[],memoryStores:[]}));
 const cipher=new WebCryptoAesGcm(root,"managed.environment-work.secret");
 const work=new SqlEnvironmentWorkStore(sql,{seal:async({plaintext})=>({ciphertext:await cipher.encrypt(plaintext)}),open:async({ciphertext})=>({plaintext:await cipher.decrypt(ciphertext)})});
 await work.insert({workspaceId:"ws",record:{work:{id:"w",environmentId:"env",data:{type:"session",id:"s"},state:"active",createdAt:now,acknowledgedAt:now,latestHeartbeatAt:now,startedAt:now,metadata:{},stopRequestedAt:null,stoppedAt:null},secret:{sessionsToken:token},claim:{generation:2,workerId:"cf-worker",claimedAt:now},heartbeatTtlSeconds:90}});
 const routes=inputRoutes.cfWorkInputRoutes({MAIN_DB:db,PLATFORM_ROOT_SECRET:root} as never);
 const server=serve({fetch:routes.fetch,hostname:"127.0.0.1",port:0});cleanup.push(()=>new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve())));
 if(!server.listening)await new Promise<void>(r=>server.once("listening",r));
 const base="http://127.0.0.1:"+(server.address() as {port:number}).port;
 const send=(action:string,body:unknown,bearer=token)=>fetch(base+"/s/"+action,{method:"POST",headers:{authorization:"Bearer "+bearer,"content-type":"application/json"},body:JSON.stringify(body)});
 const response=await send("inputs-read",{cursor:null,limit:1});expect(response.status,await response.clone().text()).toBe(200);
 const page=await response.json() as any;expect(page.rows[0]).toMatchObject({event:{id:"bootstrap_s:0",processedAt:null},position:{revision:1,index:0}});
 const resume=JSON.stringify({id:"resume",type:"session.updated",resume:true,processedAt:null,source_position:{revision:2,index:0}});
 await sql.prepare("INSERT INTO managed_session_events (workspace_id,session_id,id,type,document,processed_at) VALUES ('ws','s','resume','session.updated',?,0)").bind(resume).run();
 const resumed=await send("inputs-read",{cursor:page.cursor,limit:1});expect(resumed.status).toBe(200);
 expect((await resumed.json() as any).rows).toEqual([{event:{id:"resume",type:"session.updated",resume:true,processedAt:null},position:{revision:2,index:0},document:resume}]);
 const input={inputId:"bootstrap_s:0",turnId:"bootstrap_s:0",expectedDocument:page.rows[0].document,boundary:"before_dispatch"};
 expect((await Promise.all([send("inputs-consume",input),send("inputs-consume",input)])).map(r=>r.status).sort()).toEqual([200,409]);
 expect((await send("inputs-read",{cursor:null,limit:1},"admin")).status).toBe(401);
 // Cross-turn ownership over real HTTP, rooted in the actual consumed bootstrap.
 const rootId="bootstrap_s:0";
 const rootBytes=(await sql.prepare("SELECT document FROM managed_session_initial_events WHERE session_id=? AND sequence=0").bind("s").first<{document:string}>())!.document;
 const toolDoc=JSON.stringify({id:"owned-tool",type:"agent.tool_use",evaluatedPermission:"ask",name:"bash",input:{command:"echo yes"},processedAt:now,source_position:{revision:3,index:0,execution_id:rootId,environment_work:{workId:"w",generation:2}}});
 const answerDoc=JSON.stringify({id:"owned-answer",type:"user.tool_confirmation",toolUseId:"owned-tool",result:"allow",processedAt:null,source_position:{revision:4,index:0,execution_id:"answer-dispatch"}});
 for(const [id,type,raw] of [["owned-tool","agent.tool_use",toolDoc],["owned-answer","user.tool_confirmation",answerDoc]])await sql.prepare("INSERT INTO managed_session_events (workspace_id,session_id,id,type,document,processed_at) VALUES (?,?,?,?,?,0)").bind("ws","s",id,type,raw).run();
 await sql.prepare("UPDATE managed_sessions SET revision=4 WHERE id=?").bind("s").run();
 const ownershipBody={inputId:"owned-answer",turnId:"answer-dispatch",consumingTurnId:rootId,rootInputId:rootId,expectedRootDocument:rootBytes,expectedDocument:answerDoc,boundary:"before_dispatch"};
 const owned=await send("inputs-consume",ownershipBody);
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
  await sql.prepare("INSERT INTO managed_session_events (workspace_id,session_id,id,type,document,processed_at) VALUES (?,?,?,?,?,?)").bind("ws","s",id,payload.type,document,Date.parse(now)).run();
  const consume={inputId:id,turnId:"turn_"+id,expectedDocument:document,boundary:"before_dispatch"};
  const result=await send("inputs-consume",consume);
  expect(result.status,await result.clone().text()).toBe(index<3?200:409);
  const stored=JSON.parse((await sql.prepare("SELECT document FROM managed_session_events WHERE workspace_id=? AND session_id=? AND id=?").bind("ws","s",id).first<{document:string}>())!.document);
  expect(stored).toEqual(index<3?{...original,source_position:{...original.source_position,consumed_by_execution_id:"turn_"+id,consumption_claim:{workId:"w",generation:2,holder:"cf-worker"}}}:original);
 }
 for(const change of ["claim_generation=3","claim_at=0","claim_worker_id=NULL"]){
  await sql.exec("UPDATE managed_environment_work SET "+change);
  expect((await send("inputs-read",{cursor:null,limit:1})).status).toBe(401);
  await sql.prepare("UPDATE managed_environment_work SET claim_generation=2,claim_at=?,claim_worker_id='cf-worker'").bind(Date.parse(now)).run();
 }
});
