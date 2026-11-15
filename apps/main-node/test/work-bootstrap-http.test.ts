import { URL } from "node:url";
import { createRequire } from "node:module";
import { WebCryptoAesGcm } from "../../../packages/integrations-adapters-cf/src/index";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import { SqlSessionStore } from "../../../packages/session-store-sql/src/index";

import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm, mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { loadNodeConfig } from "../src/config.js";
import { nodeDefaults } from "../src/components.js";
import { createNodeControlPlane } from "../src/control-plane.js";
import { SqlEnvironmentWorkStore } from "../../../packages/environment-work-store-sql/src/index";
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
it("production Node bootstrap HTTP supplies sealed persisted claim and canonical root without caller identity",async()=>{
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

 expect((await post(path+"/work-bootstrap",{})).status).toBe(401);
 expect((await post(path+"/work-bootstrap",{turnId:"forged"},token)).status).toBe(400);
 const response=await post(path+"/work-bootstrap",{},token);
 expect(response.status,await response.clone().text()).toBe(200);
 expect(await response.json()).toMatchObject({type:"run",claim:{workId,generation:2,holder:"http-worker",sessionId:session.id},root:{turnId:"bootstrap_"+session.id+":0",position:{revision:1,index:0}}});
 await sql.prepare("DELETE FROM managed_session_initial_events WHERE session_id=?").bind(session.id).run();
 expect(await (await post(path+"/work-bootstrap",{},token)).json()).toMatchObject({type:"idle",root:null,claim:{holder:"http-worker"}});
 expect(await sql.prepare("SELECT state FROM managed_environment_work WHERE id=?").bind(workId).first()).toEqual({state:"active"});
 await sql.prepare("UPDATE managed_environment_work SET claim_generation=3 WHERE id=?").bind(workId).run();
 expect((await post(path+"/work-bootstrap",{},token)).status).toBe(401);
});
it("CF bootstrap factory serves real HTTP + D1 sealed authority and immutable cleanup receipt",async()=>{
 const bootstrapRoutes=await import("../../../apps/main/src/lib/cf-work-bootstrap");
 expect(typeof bootstrapRoutes.cfWorkBootstrapRoutes).toBe("function");
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
 const routes=bootstrapRoutes.cfWorkBootstrapRoutes({MAIN_DB:db,PLATFORM_ROOT_SECRET:root} as never);
 const server=serve({fetch:routes.fetch,hostname:"127.0.0.1",port:0});cleanup.push(()=>new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve())));
 if(!server.listening)await new Promise<void>(r=>server.once("listening",r));
 const base="http://127.0.0.1:"+(server.address() as {port:number}).port;
 const send=(action:string,body:unknown,bearer=token)=>fetch(base+"/s/"+action,{method:"POST",headers:{authorization:"Bearer "+bearer,"content-type":"application/json"},body:JSON.stringify(body)});

 expect((await send("work-bootstrap",{},"admin")).status).toBe(401);
 for(const value of [{holder:"cf-worker"},{generation:2},{turnId:"bootstrap_s:0"},{cursor:null}])expect((await send("work-bootstrap",value)).status).toBe(400);
 for(const url of ["/other/work-bootstrap","/s/work-bootstrap/extra"]){
  const denied=await fetch(base+url,{method:"POST",headers:{authorization:"Bearer "+token,"content-type":"application/json"},body:"{}"});
  expect([401,404]).toContain(denied.status);
 }
 expect((await fetch(base+"/s/work-bootstrap?turnId=forged",{method:"POST",headers:{authorization:"Bearer "+token,"content-type":"application/json"},body:"{}"})).status).toBe(400);
 expect((await fetch(base+"/s/work-bootstrap",{headers:{authorization:"Bearer "+token}})).status).toBe(404);
 const expired="sk-ant-req-v1."+await tokenCrypto.encrypt(JSON.stringify({version:1,workspaceId:"ws",environmentId:"env",sessionId:"s",workId:"w",issuedAt:new Date(Date.now()-120000).toISOString(),expiresAt:new Date(Date.now()-60000).toISOString(),claimedAt:now,generation:2,skills:[],files:[],memoryStores:[]}));
 expect((await send("work-bootstrap",{},expired)).status).toBe(401);
 const response=await send("work-bootstrap",{});expect(response.status,await response.clone().text()).toBe(200);
 expect(await response.json()).toMatchObject({type:"run",claim:{workId:"w",generation:2,holder:"cf-worker"},root:{turnId:"bootstrap_s:0"}});
 await sql.exec("UPDATE managed_session_initial_events SET document=json_set(document,'$.processedAt','2026-11-10T00:00:00Z','$.source_position.consumed_by_execution_id','bootstrap_s:0');UPDATE managed_sessions SET revision=2");
 const unknown=await send("work-bootstrap",{});expect(unknown.status).toBe(409);expect(await unknown.json()).toMatchObject({type:"gap",reason:"consumed_turn_without_terminal",root:{turnId:"bootstrap_s:0"}});
 const terminal={id:"terminal",type:"session.status_idle",processedAt:now,stopReason:{type:"end_turn"},source_position:{revision:3,index:0,execution_id:"bootstrap_s:0",environment_work:{workId:"w",generation:1}}};
 await sql.prepare("INSERT INTO managed_session_events(workspace_id,session_id,id,type,document,processed_at) VALUES ('ws','s','terminal','session.status_idle',?,0)").bind(JSON.stringify(terminal)).run();
 await sql.exec("UPDATE managed_sessions SET revision=3");
 expect(await (await send("work-bootstrap",{})).json()).toMatchObject({type:"cleanup-only",claim:{generation:2},terminal:{eventId:"terminal",generation:1},root:{turnId:"bootstrap_s:0"}});
 await sql.exec("UPDATE managed_environment_work SET claim_at=0");expect((await send("work-bootstrap",{})).status).toBe(401);
});
