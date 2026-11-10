import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
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
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(withMemory = false) {
 await mkdir(join(process.cwd(),".test-artifacts"),{recursive:true});
 const root=await mkdtemp(join(process.cwd(),".test-artifacts/finalization-host-"));cleanup.push(()=>rm(root,{recursive:true,force:true}));
 const config=loadNodeConfig({NODE_ENV:"test",AUTH_DISABLED:"1",PLATFORM_ROOT_SECRET:"test-finalization-root-secret-32-characters",OPENMA_TEST_SANDBOX_PROVIDER:"local-subprocess",DATABASE_PATH:join(root,"db.sqlite"),AUTH_DATABASE_PATH:join(root,"auth.sqlite"),MEMORY_BLOB_DIR:join(root,"memory"),FILES_BLOB_DIR:join(root,"files"),SESSION_OUTPUTS_DIR:join(root,"outputs"),SANDBOX_WORKDIR:join(root,"sandbox"),MEMORY_QUEUE:"disabled"});
 const components=await nodeDefaults(config);const disposables=new Disposables();cleanup.push(()=>disposables.dispose());
 const runtime=await createNodeRuntime(components,disposables,{current:null});
 expect(runtime.workFinalizationHost, "production runtime must inject a physical Work host").toBeDefined();
 const app=await mountNodeHttp(runtime,disposables,runtime.workFinalizationHost);
 const server=serve({fetch:app.fetch,hostname:"127.0.0.1",port:0});cleanup.push(()=>new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve())));
 if(!server.listening)await new Promise<void>(resolve=>server.once("listening",resolve));
 const base="http://127.0.0.1:"+(server.address() as {port:number}).port;
 const post=(path:string,body:unknown,token?:string)=>fetch(base+path,{method:"POST",headers:{"content-type":"application/json",...(token?{authorization:"Bearer "+token}:{})},body:JSON.stringify(body)});
 const create=async(path:string,body:unknown)=>{const r=await post(path,body);expect(r.status,await r.clone().text()).toBeLessThan(300);return r.json() as Promise<any>;};
 const env=await create("/v1/environments",{name:"finalization",config:{type:"cloud",networking:{type:"unrestricted"}}});
 const agent=await create("/v1/agents",{name:"finalization",model:"test",_oma:{harness:"acp-sandbox",acp:{agent:{registry:"claude-acp@0.94.0"}}}});
 const memoryStore=withMemory ? await create("/v1/memory_stores",{name:"notes"}) : null;
 const s=await create("/v1/sessions",{...(memoryStore?{resources:[{type:"memory_store",memory_store_id:memoryStore.id,access:"read_write"}]}:{}),agent:agent.id,environment_id:env.id,initial_events:[{type:"user.message",content:[{type:"text",text:"report"}]}]});
 const sql=runtime.sql;const now=new Date().toISOString();const cipher=components.secrets!.cipherFor("managed.environment-work.secret");const tokenCipher=components.secrets!.cipherFor("managed.environment-work.session-token");
 const claim={workspaceId:"default",environmentId:env.id,sessionId:s.id,workId:"host-work",generation:1,holder:"host-worker"};
 const token="sk-ant-req-v1."+await tokenCipher.encrypt(JSON.stringify({version:1,...claim,issuedAt:now,expiresAt:new Date(Date.now()+120000).toISOString(),claimedAt:now,skills:[],files:[],memoryStores:[]}));
 await sql.prepare("DELETE FROM managed_environment_work WHERE session_id=?").bind(s.id).run();
 const store=new SqlEnvironmentWorkStore(sql,{seal:async({plaintext})=>({ciphertext:await cipher.encrypt(plaintext)}),open:async({ciphertext})=>({plaintext:await cipher.decrypt(ciphertext)})});
 await store.insert({workspaceId:"default",record:{work:{id:claim.workId,environmentId:env.id,data:{type:"session",id:s.id},state:"active",createdAt:now,acknowledgedAt:now,latestHeartbeatAt:now,startedAt:now,metadata:{},stopRequestedAt:null,stoppedAt:null},secret:{sessionsToken:token},claim:{generation:1,workerId:claim.holder,claimedAt:now},heartbeatTtlSeconds:120}});
 let live=true;let holderHash:string|undefined;
 const session=(await new SqlSessionSource(sql).find(claim))!;const environment=(await new SqlSessionEnvironmentSource(sql).find(claim))!;
 const sandbox=runtime.sessionSandboxes.build({workspaceId:claim.workspaceId,session,environment,workAuthority:{attempt:environmentWorkSandboxTokenRef(claim),holderHash:()=>holderHash,isCurrent:async()=>live,token:physical=>runtime.managedAcpCapabilities.issueWork(claim,session.agent.openma?.harness,physical)}});
 cleanup.push(async()=>{live=false;await sandbox.destroy();});await sandbox.open();holderHash=(await sandboxTokenSha256(await sandbox.workToken()))!;
 const management=await sandbox.startManagedProcess({command:"/bin/sleep",args:["120"],env:{}});cleanup.push(()=>management.kill("SIGKILL"));
 const path="/v1/oma/sessions/"+s.id;const rows=await (await post(path+"/inputs-read",{cursor:null,limit:10},token)).json() as any;const row=rows.rows[0];const turnId=row.event.id;
 expect((await post(path+"/inputs-consume",{inputId:turnId,turnId,expectedDocument:row.document,boundary:"before_dispatch"},token)).status).toBe(200);
 const revision=Number((await sql.prepare("SELECT revision FROM managed_sessions WHERE id=?").bind(s.id).first<{revision:number}>())!.revision);
 const request=(action:string,body:object={})=>post(path+"/work-"+action,{turnId,revision,...body},token);
 const checkpoint=()=>sql.prepare("SELECT candidate_json FROM managed_session_workspace_checkpoints WHERE workspace_id='default' AND session_id=?").bind(s.id).first<{candidate_json:string}>();
 return {memoryStore,runtime,sql,sandbox,claim,session,environment,request,checkpoint,turnId,revision,post,path,token,root,lose:()=>{live=false;}};
}
// Removing host injection yields 503; skipping physical IO leaves no archive.
it("Node HTTP prepares real subprocess storage + strict SQLite/blob checkpoint before terminal",async()=>{
 const f=await fixture();await f.sandbox.writeFile("proof.txt","real Work archive");
 const prepared=await f.request("checkpoint");expect(prepared.status,await prepared.clone().text()).toBe(200);
 const saved=await f.checkpoint();expect(saved).not.toBeNull();const candidate=JSON.parse(saved!.candidate_json);
 expect(await f.runtime.filesBlob.head(candidate.metadata["openma.workspace.blob-key.v1"])).not.toBeNull();
 expect((await f.sql.prepare("SELECT COUNT(*) AS n FROM managed_session_events WHERE type='session.status_idle'").first())!.n).toBe(0);
 const terminal=await f.request("finalize",{stopReason:{type:"end_turn"}});expect(terminal.status,await terminal.clone().text()).toBe(200);const done=await terminal.json() as any;
 const published=await f.request("publish",{revision:done.revision,terminalEventId:done.terminal.eventId});expect(published.status,await published.clone().text()).toBe(200);
 expect((await f.sql.prepare("SELECT COUNT(*) AS n FROM managed_session_executions").first())!.n).toBe(0);
 expect(await f.sandbox.readFile("proof.txt")).toContain("real Work archive");
});

it.each(["scope","holder","generation","expired"])("rejects %s authority before physical publication",async kind=>{
 const f=await fixture();
 if(kind==="scope"){
   const response=await f.post(f.path+"/work-checkpoint",{turnId:f.turnId,revision:f.revision,runtimeId:"attacker"},f.token);expect(response.status).toBe(400);
 } else {
   await f.sql.prepare("UPDATE managed_environment_work SET "+(kind==="holder"?"sandbox_token_hashes='[]'":kind==="generation"?"claim_generation=2":"claim_at=0")+" WHERE id=?").bind(f.claim.workId).run();
   const response=await f.request("checkpoint");expect(response.status).toBe(kind==="holder"?502:401);
 }
 expect(await f.checkpoint()).toBeNull();
});

it("strict archive failure cannot produce success; failed finalization commits exhausted",async()=>{
 const f=await fixture();
 // Real subprocess tar fails because the workspace is removed while the
 // already-open physical runtime remains addressable.
 const root=join(f.root,"sandbox",f.session.id);await rm(root,{recursive:true,force:true});
 const result=await f.request("finalize",{stopReason:{type:"end_turn"}});
 expect(result.status).toBe(502);expect(await result.json()).toMatchObject({type:"failed",terminal:{stopReason:{type:"retries_exhausted"}}});
 expect(await f.checkpoint()).toBeNull();
});

it("checkpoint CAS conflict is a failure, not a best-effort success",async()=>{
 const f=await fixture();
 await f.sql.exec(`CREATE TRIGGER reject_work_checkpoint BEFORE UPDATE ON managed_session_workspace_checkpoints BEGIN SELECT RAISE(IGNORE); END`);
 const result=await f.request("checkpoint");expect(result.status).toBe(502);
 const row=await f.checkpoint();expect(row).toBeNull();
 const events=await f.sql.prepare("SELECT COUNT(*) AS n FROM managed_session_events WHERE type='session.status_idle'").first();expect(events!.n).toBe(0);
});

it("does not publish after claim loss during the physical archive upload",async()=>{
 const f=await fixture(); const put=f.runtime.filesBlob.put.bind(f.runtime.filesBlob);
 f.runtime.filesBlob.put=async(...args)=>{const value=await put(...args);if(args[0].includes("managed-session-workspace-checkpoints"))await f.sql.prepare("UPDATE managed_environment_work SET claim_generation=2 WHERE id=?").bind(f.claim.workId).run();return value;};
 const result=await f.request("checkpoint");expect(result.status).toBe(409);expect(await f.checkpoint()).toBeNull();
});

it("checks physical record identity, not just a matching current claim",async()=>{
 const f=await fixture();
 const key="session_sandbox_state:"+f.session.id;
 const row=(await f.sql.prepare('SELECT value FROM kv_entries WHERE tenant_id=? AND "key"=?').bind("default",key).first<{value:string}>())!;
 const state=JSON.parse(row.value);state.handle.runtimeId="successor-physical-runtime";state.version++;
 await f.sql.prepare('UPDATE kv_entries SET value=? WHERE tenant_id=? AND "key"=?').bind(JSON.stringify(state),"default",key).run();
 const result=await f.request("checkpoint");expect(result.status).toBe(502);expect(await f.checkpoint()).toBeNull();
});

it("keeps a committed success unchanged on artifact failure and retries cleanup idempotently",async()=>{
 const f=await fixture();
 const {encodeResourceMetadata}=await import("../../../packages/openai-agents-compat/src/resource-metadata.js");
 f.session.metadata=encodeResourceMetadata({},"session",{sealed:await f.runtime.openAIAgentsSecrets.seal(JSON.stringify({agent:{},environment:{type:"openai_hosted"},environmentId:f.environment.id}))});
 await f.sandbox.writeFile("outputs/report.txt","durable artifact");
 const result=await f.request("finalize",{stopReason:{type:"end_turn"}});expect(result.status,await result.clone().text()).toBe(200);const done=await result.json() as any;
 const snapshot=await f.sql.prepare("SELECT document FROM managed_session_events WHERE id=?").bind(done.terminal.eventId).first();
 const physical=await f.sandbox.captureWork(environmentWorkSandboxTokenRef(f.claim));const read=physical.sandbox.readFileBytes!.bind(physical.sandbox);
 physical.sandbox.readFileBytes=async()=>{throw new Error("output disk unavailable");};
 const publish=()=>f.request("publish",{revision:done.revision,terminalEventId:done.terminal.eventId});
 const failed=await publish();expect(failed.status,await failed.clone().text()).toBe(502);
 expect(await f.sql.prepare("SELECT document FROM managed_session_events WHERE id=?").bind(done.terminal.eventId).first()).toEqual(snapshot);
 physical.sandbox.readFileBytes=read;
 const retry=await publish();expect(retry.status,await retry.clone().text()).toBe(200);
 expect((await publish()).status).toBe(200);
 const files=await f.runtime.managedPlatform.app({workspaceId:"default"}).port((await import("../../../packages/managed-agents-app/src/managed-agents.js")).managedAgentsPortTokens.files).listFiles({scopeId:f.session.id,pageSize:100});
 expect(files.type).toBe("page");if(files.type!=="page")throw new Error("files missing");
 expect(files.page.files).toHaveLength(1);expect(files.page.files[0]!.origin).toMatchObject({sessionId:f.session.id,path:"/workspace/outputs/report.txt"});
 expect(await f.sandbox.readFile("outputs/report.txt")).toBe("durable artifact");
});

it("synchronizes attached Memory and outputs before the checkpoint becomes visible",async()=>{
 const f=await fixture(true);
 await f.sandbox.writeFile(`/mnt/memory/notes/note.txt`,"physical memory write");
 await f.sandbox.writeFile("/mnt/session/outputs/report.txt","physical output write");
 const result=await f.request("checkpoint");expect(result.status,await result.clone().text()).toBe(200);
 const memories=await f.runtime.managedPlatform.app({workspaceId:"default"}).port((await import("../../../packages/managed-agents-app/src/managed-agents.js")).managedAgentsPortTokens.memories).listMemories({memoryStoreId:f.memoryStore.id,pageSize:100,projection:"full"});
 expect(memories.type).toBe("page");if(memories.type!=="page")throw Error("missing memories");
 expect(memories.page.items).toEqual(expect.arrayContaining([expect.objectContaining({path:"/note.txt",content:"physical memory write"})]));
 const output=await (await import("node:fs/promises")).readFile(join(f.root,"outputs","default",f.session.id,"report.txt"),"utf8");expect(output).toBe("physical output write");
 expect(await f.checkpoint()).not.toBeNull();
});

it("keeps provider maintenance callable across prepare, terminal and repeated cleanup",async()=>{
 const f=await fixture();const put=f.runtime.filesBlob.put.bind(f.runtime.filesBlob);
 let enter!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{enter=r;});const gate=new Promise<void>(r=>{release=r;});
 f.runtime.filesBlob.put=async(...args)=>{if(args[0].includes("managed-session-workspace-checkpoints")){enter();await gate;}return put(...args);};
 const checkpoint=f.request("checkpoint");await started;
 try {await f.sandbox.renewActivityTimeout();expect(await f.sandbox.exec("printf alive")).toBe("alive");}finally{release();}
 expect((await checkpoint).status).toBe(200);
 const terminal=await f.request("finalize",{stopReason:{type:"end_turn"}});const done=await terminal.json() as any;
 await f.sandbox.renewActivityTimeout();
 for(let i=0;i<2;i++)expect((await f.request("publish",{revision:done.revision,terminalEventId:done.terminal.eventId})).status).toBe(200);
 await f.sandbox.renewActivityTimeout();expect(await f.sandbox.exec("printf successor-safe")).toBe("successor-safe");
});

it("stale post-terminal cleanup refuses a successor without terminating its physical runtime",async()=>{
 const f=await fixture();const done=await (await f.request("finalize",{stopReason:{type:"end_turn"}})).json() as any;
 await f.sql.prepare("UPDATE managed_environment_work SET claim_generation=2,claim_worker_id='successor' WHERE id=?").bind(f.claim.workId).run();
 expect((await f.request("publish",{revision:done.revision,terminalEventId:done.terminal.eventId})).status).toBe(401);
 expect(await f.sandbox.exec("printf alive")).toBe("alive");
 expect((await f.sql.prepare("SELECT COUNT(*) AS n FROM managed_session_events WHERE type='session.status_idle'").first())!.n).toBe(1);
});

it("post-terminal publication checks the persisted physical handle too",async()=>{
 const f=await fixture();const done=await (await f.request("finalize",{stopReason:{type:"end_turn"}})).json() as any;
 const key="session_sandbox_state:"+f.session.id;
 const row=(await f.sql.prepare('SELECT value FROM kv_entries WHERE tenant_id=? AND "key"=?').bind("default",key).first<{value:string}>())!;
 const state=JSON.parse(row.value);state.handle.runtimeId="successor";state.version++;
 await f.sql.prepare('UPDATE kv_entries SET value=? WHERE tenant_id=? AND "key"=?').bind(JSON.stringify(state),"default",key).run();
 expect((await f.request("publish",{revision:done.revision,terminalEventId:done.terminal.eventId})).status).toBe(502);
 expect(await f.sandbox.exec("printf alive")).toBe("alive");
});

it("rechecks authority inside checkpoint CAS after the last asynchronous host check",async()=>{
 const f=await fixture();const batch=f.sql.batchChecked!.bind(f.sql);let armed=true;
 f.sql.batchChecked=async(statements,validate)=>{
   if(armed){armed=false;await f.sql.prepare("UPDATE managed_environment_work SET claim_generation=2 WHERE id=?").bind(f.claim.workId).run();}
   return batch(statements,validate);
 };
 const result=await f.request("checkpoint");expect(result.status).toBe(409);expect(await f.checkpoint()).toBeNull();
 expect((await f.sql.prepare("SELECT COUNT(*) AS n FROM managed_session_events WHERE type='session.status_idle'").first())!.n).toBe(0);
});

it.each(["retries_exhausted","budget_reached"] as const)("cleanup preserves %s and does not publish successful-turn artifacts",async type=>{
 const f=await fixture();const {encodeResourceMetadata}=await import("../../../packages/openai-agents-compat/src/resource-metadata.js");
 f.session.metadata=encodeResourceMetadata({},"session",{sealed:await f.runtime.openAIAgentsSecrets.seal(JSON.stringify({agent:{},environment:{type:"openai_hosted"},environmentId:f.environment.id}))});
 await f.sandbox.writeFile("outputs/failure.txt","not a successful output");
 const terminal=type==="retries_exhausted"?await f.request("failed",{phase:"run"}):await f.request("finalize",{stopReason:{type}});
 expect(terminal.status).toBe(200);const done=await terminal.json() as any;
 const result=await f.request("publish",{revision:done.revision,terminalEventId:done.terminal.eventId});expect(result.status).toBe(200);
 expect(await result.json()).toMatchObject({terminal:{stopReason:{type}}});
 const files=await f.runtime.managedPlatform.app({workspaceId:"default"}).port((await import("../../../packages/managed-agents-app/src/managed-agents.js")).managedAgentsPortTokens.files).listFiles({scopeId:f.session.id,pageSize:100});
 expect(files).toMatchObject({type:"page",page:{files:[]}});
});

it("archives workspace data without copying its own checkpoint transfer tar into the workspace",async()=>{
 const f=await fixture();await f.sandbox.writeFile("proof.txt","workspace only");
 expect((await f.request("checkpoint")).status).toBe(200);
 const candidate=JSON.parse((await f.checkpoint())!.candidate_json);
 const blob=(await f.runtime.filesBlob.get(candidate.metadata["openma.workspace.blob-key.v1"]))!;
 const bytes=new Uint8Array(await new Response(blob.body).arrayBuffer());
 const archive=join(f.root,"inspected.tar");await (await import("node:fs/promises")).writeFile(archive,bytes);
 const {execFileSync}=await import("node:child_process");const entries=execFileSync("tar",["-tf",archive],{encoding:"utf8"}).trim().split("\n");
 expect(entries.some(path=>path.includes("checkpoint-transfer"))).toBe(false);
 expect(entries).toContain("./proof.txt");
});
