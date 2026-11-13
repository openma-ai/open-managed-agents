// Combined local Node-hosted Environment Work gate with separate supervisor and ACP processes. Real HTTP authority,
// supervisor/control/finalizer, local subprocess, SQLite/blob persistence and
// output download. Only the ACP agent transport is deterministic; no inference.
// Owner reconstruction reopens SQL/blob adapters and HTTP with a fresh owner ID
// in this test process; it is not an OS crash or a native remote-provider claim.
import { fork, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
const { Parser } = createRequire(new URL("../../../packages/control-plane-node/package.json", import.meta.url))("tar");
import { parseExecResult } from "@open-managed-agents/sandbox";
import { SKILL_FILES, SKILL_MD, EXPECTED_REPORT, MEMORY_FACT, READONLY_SEED } from "../../../test/resource-convergence/resource-agent-fixture.js";
import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { loadNodeConfig } from "../src/config.js";
import { nodeDefaults } from "../src/components.js";
import { createNodeRuntime } from "../../../packages/control-plane-node/src/modules/node-runtime.js";
import { mountNodeHttp } from "../../../packages/control-plane-node/src/modules/node-http.js";
import { Disposables } from "../../../packages/control-plane-node/src/lifecycle.js";
import { SqlEnvironmentWorkStore } from "../../../packages/environment-work-store-sql/src/index.js";
import { SqlSessionSource, SqlSessionEnvironmentSource } from "@open-managed-agents/managed-agents-adapters-sql";
import { environmentWorkSandboxTokenRef } from "../../../packages/sandbox-gateway-sql/src/index.js";
import { sandboxTokenSha256 } from "../../../packages/sandbox-gateway/src/index.js";
const adminFetch=(url:string,init:RequestInit={})=>fetch(url,{...init,headers:{...Object.fromEntries(new Headers(init.headers)),"x-api-key":"test-resource-api"}});
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
 const root=await mkdtemp(join(tmpdir(),"resource-child-gate-"));console.log(JSON.stringify({op:"work.resource.fixture",root}));
 const configEnv={NODE_ENV:"test",AUTH_DISABLED:"0",API_KEY:"test-resource-api",PLATFORM_ROOT_SECRET:"test-finalization-root-secret-32-characters",OPENMA_TEST_SANDBOX_PROVIDER:"local-subprocess",DATABASE_PATH:join(root,"db.sqlite"),AUTH_DATABASE_PATH:join(root,"auth.sqlite"),MEMORY_BLOB_DIR:join(root,"memory"),FILES_BLOB_DIR:join(root,"files"),SESSION_OUTPUTS_DIR:join(root,"outputs"),SANDBOX_WORKDIR:join(root,"sandbox"),MEMORY_QUEUE:"disabled"};let config=loadNodeConfig(configEnv);
 let components=await nodeDefaults(config);let disposables=new Disposables();cleanup.push(()=>disposables.dispose());
 let runtime=await createNodeRuntime(components,disposables,{current:null});
 expect(runtime.workFinalizationHost, "production runtime must inject a physical Work host").toBeDefined();
 let app=await mountNodeHttp(runtime,disposables,runtime.workFinalizationHost);
 let server=serve({fetch:app.fetch,hostname:"127.0.0.1",port:0});cleanup.push(()=>new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve())));
 if(!server.listening)await new Promise<void>(resolve=>server.once("listening",resolve));
 let base="http://127.0.0.1:"+(server.address() as {port:number}).port;
 const post=(path:string,body:unknown,token?:string)=>fetch(base+path,{method:"POST",headers:{"content-type":"application/json",...(token?{authorization:"Bearer "+token}:{"x-api-key":"test-resource-api"})},body:JSON.stringify(body)});
 const create=async(path:string,body:unknown)=>{const r=await post(path,body);expect(r.status,await r.clone().text()).toBeLessThan(300);return r.json() as Promise<any>;};
 const env=await create("/v1/environments",{name:"finalization",config:{type:"cloud",networking:{type:"unrestricted"}}});
 const memoryStore=await create("/v1/memory_stores",{name:"work-notes"});
 const readonlyStore=await create("/v1/memory_stores",{name:"work-policies"});
 await create(`/v1/memory_stores/${readonlyStore.id}/memories`,{path:"/seed.md",content:READONLY_SEED});
 const form=new FormData();for(const file of SKILL_FILES)form.append("files[]",new File([file.content],file.name));
 const skillResponse=await adminFetch(base+"/v1/skills",{method:"POST",body:form});expect(skillResponse.ok).toBe(true);const skill=await skillResponse.json() as any;
 const agent=await create("/v1/agents",{name:"finalization",model:"test",skills:[{type:"custom",skill_id:skill.id,version:"latest"}],_oma:{harness:"acp-sandbox",acp:{agent:{registry:"claude-acp@0.94.0"}}}});
 const s=await create("/v1/sessions",{...(memoryStore?{resources:[{type:"memory_store",memory_store_id:memoryStore.id,access:"read_write"},{type:"memory_store",memory_store_id:readonlyStore.id,access:"read_only"}]}:{}),agent:agent.id,environment_id:env.id,initial_events:[{type:"user.message",content:[{type:"text",text:"report"}]}]});
 let sql=runtime.sql;const now=new Date().toISOString();const cipher=components.secrets!.cipherFor("managed.environment-work.secret");const tokenCipher=components.secrets!.cipherFor("managed.environment-work.session-token");
 const claim={workspaceId:"default",environmentId:env.id,sessionId:s.id,workId:"host-work",generation:1,holder:"host-worker"};
 const bound=(await new SqlSessionSource(sql).find({workspaceId:"default",sessionId:s.id}))!;
 console.log(JSON.stringify({op:"work.resource.canonical_inputs",skills:bound.agent.skills,resources:bound.resources}));
 expect(bound.agent.skills).toHaveLength(1);
 const token="sk-ant-req-v1."+await tokenCipher.encrypt(JSON.stringify({version:1,...claim,issuedAt:now,expiresAt:new Date(Date.now()+120000).toISOString(),claimedAt:now,skills:bound.agent.skills.map(skill=>({skillId:skill.skillId,version:skill.version})),files:[],memoryStores:[{memoryStoreId:memoryStore.id,access:"read_write"},{memoryStoreId:readonlyStore.id,access:"read_only"}]}));
 await sql.prepare("DELETE FROM managed_environment_work WHERE session_id=?").bind(s.id).run();
 const store=new SqlEnvironmentWorkStore(sql,{seal:async({plaintext})=>({ciphertext:await cipher.encrypt(plaintext)}),open:async({ciphertext})=>({plaintext:await cipher.decrypt(ciphertext)})});
 await store.insert({workspaceId:"default",record:{work:{id:claim.workId,environmentId:env.id,data:{type:"session",id:s.id},state:"active",createdAt:now,acknowledgedAt:now,latestHeartbeatAt:now,startedAt:now,metadata:{},stopRequestedAt:null,stoppedAt:null},secret:{sessionsToken:token},claim:{generation:1,workerId:claim.holder,claimedAt:now},heartbeatTtlSeconds:120}});
 let live=true;let holderHash:string|undefined;
 const session=(await new SqlSessionSource(sql).find(claim))!;const environment=(await new SqlSessionEnvironmentSource(sql).find(claim))!;
 let sandbox=runtime.sessionSandboxes.build({workspaceId:claim.workspaceId,session,environment,workAuthority:{attempt:environmentWorkSandboxTokenRef(claim),holderHash:()=>holderHash,isCurrent:async()=>live,token:physical=>runtime.managedAcpCapabilities.issueWork(claim,session.agent.openma?.harness,physical)}});
 cleanup.push(async()=>{live=false;await sandbox.destroy();});await sandbox.open();holderHash=(await sandboxTokenSha256(await sandbox.workToken()))!;
 let management=await sandbox.startManagedProcess({command:"/bin/sleep",args:["120"],env:{}});cleanup.push(()=>management.kill("SIGKILL"));
 const path="/v1/oma/sessions/"+s.id;const response=await post(path+"/inputs-read",{cursor:null,limit:10},token);expect(response.status,await response.clone().text()).toBe(200);const rows=await response.json() as any;const row=rows.rows[0];const turnId=row.event.id;

 const revision=Number((await sql.prepare("SELECT revision FROM managed_sessions WHERE id=?").bind(s.id).first<{revision:number}>())!.revision);
 const request=(action:string,body:object={})=>post(path+"/work-"+action,{turnId,revision,...body},token);
 const checkpoint=()=>sql.prepare("SELECT candidate_json FROM managed_session_workspace_checkpoints WHERE workspace_id='default' AND session_id=?").bind(s.id).first<{candidate_json:string}>();
 const recreateProvider=async()=>{
  const before=await sandbox.captureWork(environmentWorkSandboxTokenRef(claim));
  const saved=await checkpoint();const candidate=JSON.parse(saved!.candidate_json);const blob=await runtime.filesBlob.get(candidate.metadata["openma.workspace.blob-key.v1"]);
  const entries:string[]=[];const parser=new Parser({onReadEntry:(entry:{path:string;resume():void})=>{entries.push(entry.path);entry.resume();}});const parsed=new Promise<void>((resolve,reject)=>{parser.on("end",resolve);parser.on("error",reject);});parser.end(Buffer.from(await new Response(blob!.body as BodyInit).arrayBuffer()));await parsed;
  console.log(JSON.stringify({op:"work.resource.archive_members",resourceEntries:entries.filter(path=>path.startsWith("./.mnt/memory")||path.startsWith("./.mnt/session/outputs"))}));
  await management.kill("SIGKILL");
  // Provider loss is not a Session lifecycle retirement. Keep the durable
  // handle/checkpoint and make the physical adapter report it gone.
  await before.sandbox.destroy!();
  const oldOwner=config.execution.ownerId;
  await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  await disposables.dispose();
  config=loadNodeConfig(configEnv);components=await nodeDefaults(config);disposables=new Disposables();
  runtime=await createNodeRuntime(components,disposables,{current:null});sql=runtime.sql;
  app=await mountNodeHttp(runtime,disposables,runtime.workFinalizationHost);
  server=serve({fetch:app.fetch,hostname:"127.0.0.1",port:0});
  if(!server.listening)await new Promise<void>(resolve=>server.once("listening",resolve));
  base="http://127.0.0.1:"+(server.address() as {port:number}).port;
  expect(config.execution.ownerId).not.toBe(oldOwner);
  console.log(JSON.stringify({op:"work.resource.owner_reopened",oldOwner,newOwner:config.execution.ownerId}));
  sandbox=runtime.sessionSandboxes.build({workspaceId:claim.workspaceId,session,environment,workAuthority:{attempt:environmentWorkSandboxTokenRef(claim),holderHash:()=>holderHash,isCurrent:async()=>live,token:physical=>runtime.managedAcpCapabilities.issueWork(claim,session.agent.openma?.harness,physical)}});
  await sandbox.open();holderHash=(await sandboxTokenSha256(await sandbox.workToken()))!;
  await runtime.sessionSandboxes.restoreWorkCheckpoint(sandbox,environmentWorkSandboxTokenRef(claim));
  management=await sandbox.startManagedProcess({command:"/bin/sleep",args:["120"],env:{}});
  const after=await sandbox.captureWork(environmentWorkSandboxTokenRef(claim));
  console.log(JSON.stringify({op:"work.resource.provider_recreated",before:before.runtimeGeneration,after:after.runtimeGeneration}));
  expect(after.runtimeGeneration).not.toBe(before.runtimeGeneration);
 };
 return {get base(){return base;},skill,readonlyStore,memoryStore,get runtime(){return runtime;},get sql(){return sql;},get sandbox(){return sandbox;},recreateProvider,claim,session,environment,request,checkpoint,turnId,revision,post,path,token,root,lose:()=>{live=false;}};
}

const quote=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'";
it("spawned Work supervisor and ACP child: Skill/script, Memory restart, readonly original-callID and production download",async()=>{
 const f=await fixture();
 const observations:Array<{id:string;output:string;error:boolean}>=[];let promptText="";let phase="write";let activeTurn=f.turnId;let publications=0;
 let published!:()=>void;let failEnvironment!:(error:Error)=>void;const done=new Promise<void>((r,j)=>{published=r;failEnvironment=j;});
 const childPids:number[]=[],agentPids=new Set<number>();
 const resourceEnvironments:Array<{retiredPresent:boolean;ambientPresent:boolean;outputMatchesGuidance:boolean}>=[];
 const ioServer=serve({hostname:"127.0.0.1",port:0,fetch:async request=>{
  try {const input=await request.json() as any;
   if(new URL(request.url).pathname==="/resource-env"){
    resourceEnvironments.push(input);
    console.log(JSON.stringify({op:"child.resource.environment",...input}));
    if(input.retiredPresent||input.ambientPresent||!input.outputMatchesGuidance)failEnvironment(new Error("Spawned agent resource environment disagrees with current mounts/guidance"));
    return Response.json({observed:true});
   }
   if(new URL(request.url).pathname==="/tool"){
    agentPids.add(input.agentPid);const raw=await f.sandbox.exec(input.command);const result=parseExecResult(raw);
    const observation={id:input.id,output:(input.id==="skill-read"||input.id.startsWith("recall-"))&&result.exitCode===0?Buffer.from(result.stdout,"base64").toString("utf8"):result.stdout+result.stderr,error:result.exitCode!==0};observations.push(observation);
    console.log(JSON.stringify({op:"work.child.tool",agentPid:input.agentPid,...observation}));return Response.json(observation);
   }
   const args=input.args;if(input.method==="writeFileBytes")args[1]=Buffer.from(args[1],"base64");
   if(!["readFile","writeFile","writeFileBytes","exec"].includes(input.method))throw Error("Unsupported fixture IO");
   const result=await (f.sandbox as any)[input.method](...args);return Response.json({result});
  }catch(e){return Response.json({error:String(e)},{status:500});}
 }});if(!ioServer.listening)await new Promise<void>(r=>ioServer.once("listening",r));
 cleanup.push(()=>new Promise<void>((r,j)=>ioServer.close(e=>e?j(e):r())));
 const io="http://127.0.0.1:"+(ioServer.address() as any).port;
 const agentFile=join(f.root,"agent.mjs"),supervisorFile=join(f.root,"supervisor.mjs");
 for(const [source,target] of [["resource-acp-agent.ts",agentFile],["resource-work-child.ts",supervisorFile]]){
  execFileSync("../../node_modules/.bin/esbuild",["test/fixtures/"+source,"--bundle","--platform=node","--format=esm","--target=node22","--outfile="+target,'--banner:js=import {createRequire as __fixtureRequire} from "node:module";const require=__fixtureRequire(import.meta.url);'],{stdio:"pipe"});
 }
 const startSupervisor=async()=>{
  const child=fork(supervisorFile,[],{stdio:["ignore","pipe","pipe","ipc"],env:{...process.env,OMA_MEMORY_AMBIENT:"/retired-ambient",RESOURCE_CHILD_FIXTURE:JSON.stringify({io,agent:agentFile,agentSettings:{io,skillId:f.skill.id,rwName:f.memoryStore.name,roName:f.readonlyStore.name},workspace:join(f.root,"sandbox",f.session.id),claim:f.claim,environment:{ANTHROPIC_BASE_URL:f.base,ANTHROPIC_ENVIRONMENT_ID:f.claim.environmentId,ANTHROPIC_SESSION_ID:f.session.id,ANTHROPIC_WORK_ID:f.claim.workId,ANTHROPIC_WORK_SECRET:Buffer.from(JSON.stringify({sessions_token:f.token,api_base_url:f.base})).toString("base64url")}})}});
  childPids.push(child.pid!);console.log(JSON.stringify({op:"work.child.spawn",pid:child.pid,parent:process.pid}));
  child.stdout!.on("data",b=>console.log(String(b)));child.stderr!.on("data",b=>console.log("CHILD STDERR",String(b)));
  const completed=new Promise<void>((resolve,reject)=>{child.once("exit",code=>code===0?resolve():reject(Error("Child exit "+code)));child.once("error",reject);});completed.catch(()=>{});
  child.on("message",(m:any)=>{if(m.type==="published"){publications++;published();}if(m.type==="failed")console.log("CHILD FAILURE",m.error);});
  return {completed,stop:async(_reason:string)=>{if(child.connected)child.send("stop");await completed;},drain:async()=>{},child};
 };
 let started=await startSupervisor();
 started.completed.catch(error=>console.log(JSON.stringify({op:"work.resource.run.failed",error:String(error)})));
 try {
  await Promise.race([done,started.completed.then(()=>{throw Error("Work ended without publication");})]);
  expect(observations[0]?.output).toBe(SKILL_MD);
  expect(observations.at(-1)).toMatchObject({id:"readonly-write",error:true});
  const events=await (await adminFetch(f.base+`/v1/sessions/${f.session.id}/events?limit=1000&order=asc`)).json() as any;
  console.log(JSON.stringify({op:"work.resource.canonical",events:events.data}));
  expect(events.data.filter((e:any)=>e.type==="session.status_idle").map((e:any)=>e.stop_reason.type)).toEqual(["end_turn"]);
  const errors=events.data.filter((e:any)=>e.type==="agent.tool_result"&&e.tool_use_id==="readonly-write");expect(errors).toHaveLength(1);expect(errors[0].is_error).toBe(true);
  const assertAuthoritativeMemory=async()=>{
  for(const [store,filename,bytes] of [[f.memoryStore,"fact.md",MEMORY_FACT],[f.readonlyStore,"seed.md",READONLY_SEED]] as const){
   const page=await(await adminFetch(f.base+`/v1/memory_stores/${store.id}/memories?limit=100`)).json() as any;const item=page.data.find((e:any)=>e.path==="/"+filename);expect(item).toBeDefined();
   const memory=await(await adminFetch(f.base+`/v1/memory_stores/${store.id}/memories/${item.id}?view=full`)).json() as any;expect(memory.content).toBe(bytes);
  }
  };
  await assertAuthoritativeMemory();
  const output=await adminFetch(f.base+`/v1/sessions/${f.session.id}/outputs/skill-report.txt`);expect(output.status).toBe(200);expect(await output.text()).toBe(EXPECTED_REPORT);
  const recall=async(label:string,count:number)=>{
   phase=label;
   const admitted=await adminFetch(f.base+`/v1/sessions/${f.session.id}/events`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({events:[{type:"user.message",content:[{type:"text",text:"recall exact memory "+label}]}]})});expect(admitted.ok,await admitted.clone().text()).toBe(true);
   await expect.poll(()=>publications,{timeout:15000}).toBe(count);
   expect(observations.at(-1)).toEqual({id:"recall-"+label,output:MEMORY_FACT,error:false});
   const after=await(await adminFetch(f.base+`/v1/sessions/${f.session.id}/events?limit=1000&order=asc`)).json() as any;
   expect(after.data.filter((e:any)=>e.type==="session.status_idle").map((e:any)=>e.stop_reason.type)).toEqual(Array(count).fill("end_turn"));
   expect(after.data.filter((e:any)=>e.type==="session.error")).toEqual([]);
   expect(after.data.filter((e:any)=>e.type==="agent.tool_result"&&e.tool_use_id==="readonly-write")).toHaveLength(1);
  };
  await recall("next",2);
  await assertAuthoritativeMemory();
  await started.stop("restart local Work runner");await started.drain();
  await f.recreateProvider();
  phase="restored";started=await startSupervisor();started.completed.catch(()=>{});
  await recall("restored",3);
  await assertAuthoritativeMemory();
  const restored=await adminFetch(f.base+`/v1/sessions/${f.session.id}/outputs/skill-report.txt`);expect(restored.status).toBe(200);expect(await restored.text()).toBe(EXPECTED_REPORT);
  expect(observations.filter(o=>o.id==="skill-script")).toHaveLength(1);
  expect(resourceEnvironments.length).toBeGreaterThanOrEqual(3);
  expect(resourceEnvironments.every(e=>!e.retiredPresent&&!e.ambientPresent&&e.outputMatchesGuidance)).toBe(true);
  expect(childPids).toHaveLength(2);expect(new Set(childPids).size).toBe(2);
  expect(childPids.every(pid=>pid!==process.pid)).toBe(true);
  expect(agentPids.size).toBeGreaterThanOrEqual(2);expect([...agentPids].every(pid=>pid!==process.pid&&!childPids.includes(pid))).toBe(true);
  console.log(JSON.stringify({op:"work.child.process_proof",parent:process.pid,supervisors:childPids,agents:[...agentPids]}));

 } finally {await started.stop("local gate completed");await started.drain();}
},90_000);
