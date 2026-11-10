import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeAll, expect, it, vi } from "vitest";
import { cfWorkFinalizationRoutes } from "../../main/src/lib/cf-work-finalization";
import { SessionDO } from "../src/runtime/session-do";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import { SqlEnvironmentWorkStore } from "@open-managed-agents/environment-work-store-sql";
import { WebCryptoAesGcm } from "@open-managed-agents/integrations-adapters-cf";
import { seedSandboxGatewaySessionRows } from "../../../packages/sandbox-gateway/test/gateway-store-conformance";
import { initialSandboxState } from "@open-managed-agents/session-runtime";

const remote = vi.hoisted(() => ({ snapshots: 0, commands: [] as string[], locator: {} as Record<string, unknown>, files: new Map<string,string>(), failSnapshot: false, onSnapshot: undefined as undefined | (()=>Promise<void>), mutateRecord: false, deleted: [] as string[], drain: undefined as undefined | (()=>Promise<void>), winnerRef: "winner", deleteFails: false }));
vi.mock("e2b", () => {
 class Sandbox {
  static async deleteSnapshot(id:string) { remote.deleted.push(id); if(remote.deleteFails) throw Error("provider delete unavailable"); return true; }
  sandboxId = "physical-finalization";
  files = { read: async (path:string,opts?:{format?:string}) => {
   if(path.endsWith("/ready")) return "oma-managed-v2";
   if(path === "/tmp/.oma-warm") return "incarnation";
   const value=remote.files.get(path) ?? ""; return opts?.format === "bytes" ? new TextEncoder().encode(value) : value;
  }, write: async (path:string, content:string) => {
   remote.files.set(path,content);
   if(!path.endsWith(".go")) return;
   const req=JSON.parse(remote.files.get(path.replace(/\.go$/,".json"))!);
   remote.files.set(path.replace(/\.go$/,".response.json"), JSON.stringify(req.op === "inspect-slot" ? {ok:true,locator:remote.locator} : {ok:true,status:"running"}));
  }};
  commands = { run: async (cmd:string) => {
   remote.commands.push(cmd); let stdout="";
   if(cmd.includes("OMA_RCLONE_DRAIN_V1")) { await remote.drain?.(); return {exitCode:0,stdout:JSON.stringify({type:"drained",version:1}),stderr:""}; }
   if(cmd.startsWith("cd /workspace &&") && remote.files.has("/workspace/outputs/result.txt")) stdout=btoa("./outputs/result.txt\0");
   const probe=/if \[ -f '([^']+)' \]/.exec(cmd); if(probe) stdout=remote.files.has(probe[1])?"1":"0";
   const scan=/cd '(\/mnt\/memory\/[^']+)' && find/.exec(cmd);
   if(scan) stdout=btoa([...remote.files.keys()].filter(k=>k.startsWith(scan[1]+"/")).map(k=>"./"+k.slice(scan[1].length+1)+"\0").join(""));
   return {exitCode:0,stdout,stderr:""};
  } };
  async createSnapshot() { await remote.onSnapshot?.(); if(remote.failSnapshot) throw Error("snapshot failed"); return {snapshotId:`snapshot-${++remote.snapshots}`,names:[]}; }
 }
 return { Sandbox, ConnectionConfig: class {}, ApiClient: class { api={GET:async()=>({data:{sandboxID:"physical-finalization",state:"running",lifecycle:{autoResume:false},envdVersion:"0.3.0",envdAccessToken:"sdk-secret"}})}; } };
});
beforeAll(async()=>{ await exports.default.fetch(new Request("http://localhost/health")); });
async function fixture() {
 const sql=new CfD1SqlClient(env.MAIN_DB!); const sessionId="sess_"+crypto.randomUUID(), environmentId="env_"+crypto.randomUUID(),workId="work_"+crypto.randomUUID();
 const now=new Date(), root="test-platform-root-secret-padded-to-thirtytwo";
 await seedSandboxGatewaySessionRows(sql,"default",{id:sessionId,environmentId,vaultIds:[],agent:{id:"agent",version:1},archivedAt:null});
 const session={id:sessionId,agent:{id:"agent",version:1,name:"Agent"},environmentId,status:"running",createdAt:now.toISOString(),updatedAt:now.toISOString(),archivedAt:null,budget:null,usage:{},outcomeEvaluations:[],resources:[],metadata:{}};
 await sql.prepare("UPDATE managed_sessions SET document=?,revision=3,status='running' WHERE workspace_id='default' AND id=?").bind(JSON.stringify(session),sessionId).run();
 const cipher=new WebCryptoAesGcm(root,"managed.environment-work.secret"), codec=new WebCryptoAesGcm(root,"managed.environment-work.session-token");
 const token="sk-ant-req-v1."+await codec.encrypt(JSON.stringify({version:1,workspaceId:"default",sessionId,environmentId,workId,generation:2,claimedAt:now.toISOString(),issuedAt:now.toISOString(),expiresAt:new Date(+now+3600000).toISOString(),skills:[],files:[],memoryStores:[]}));
 const work=new SqlEnvironmentWorkStore(sql,{seal:async({plaintext})=>({ciphertext:await cipher.encrypt(plaintext)}),open:async({ciphertext})=>({plaintext:await cipher.decrypt(ciphertext)})});
 await work.insert({workspaceId:"default",record:{work:{id:workId,environmentId,data:{type:"session",id:sessionId},state:"active",createdAt:now.toISOString(),metadata:{},acknowledgedAt:now.toISOString(),latestHeartbeatAt:now.toISOString(),startedAt:now.toISOString(),stopRequestedAt:null,stoppedAt:null},secret:{sessionsToken:token},claim:{generation:2,claimedAt:now.toISOString(),workerId:"owner"},heartbeatTtlSeconds:90}});
 await sql.prepare("UPDATE managed_environment_work SET sandbox_token_hashes=? WHERE id=?").bind(JSON.stringify([{h:"a".repeat(64),s:"all"}]),workId).run();
 await sql.prepare("INSERT INTO managed_session_events(workspace_id,session_id,thread_id,id,type,document,processed_at) VALUES ('default',?,NULL,'input','user.message',?,?)").bind(sessionId,JSON.stringify({id:"input",type:"user.message",content:[],processedAt:now.toISOString(),source_position:{revision:2,index:0,consumed_by_execution_id:"input"}}),+now).run();
 const stub=env.SESSION_DO!.get(env.SESSION_DO!.idFromName(JSON.stringify(["default",sessionId])));
 remote.snapshots=0;remote.commands=[];remote.deleted=[];remote.drain=undefined;remote.winnerRef="winner";remote.deleteFails=false;remote.failSnapshot=false;remote.onSnapshot=undefined;remote.mutateRecord=false;remote.files.clear();remote.locator={sandboxId:"physical-finalization",id:"process",epoch:"epoch",pid:41,status:"running",holderHash:"a".repeat(64),identity:{workspaceId:"default",sessionId,workId,attemptId:"environment-work-claim:2"}};
 const configured={...env,PLATFORM_ROOT_SECRET:root,SANDBOX_ADAPTER:"e2b",E2B_API_KEY:"private",PUBLIC_BASE_URL:"https://control.test"};
 await runInDurableObject(stub,async(_instance,state)=>{state.storage.kv.put("e2b_sandbox_state",{...initialSandboxState(),phase:"running",handle:{provider:"e2b",runtimeId:"physical-finalization"},version:1,runStartedAt:Date.now()});});
 const binding={fetch:async(input:RequestInfo|URL,init?:RequestInit)=>{
  const req=input instanceof Request?input:new Request(input,init),url=new URL(req.url),body=await req.text();
  expect(req.headers.get("x-oma-workspace-id")).toBe("default");
  const result=await runInDurableObject(stub,async(_instance,state)=>{const owner=new SessionDO(state,configured as never);
   if(remote.mutateRecord) remote.onSnapshot=async()=>{const prior=state.storage.kv.get("e2b_sandbox_state") as Record<string,unknown>;state.storage.kv.put("e2b_sandbox_state",{...prior,version:9,latestSnapshot:{status:"taken",ref:{provider:"e2b",kind:"snapshot",ref:remote.winnerRef}}});};
   const response=await owner.fetch(new Request("https://internal"+url.pathname.replace(`/sessions/${sessionId}`,""),{method:req.method,headers:req.headers,body}));return {status:response.status,body:await response.text()};});
  return new Response(result.body,{status:result.status});
 }};
 const routes=cfWorkFinalizationRoutes({...configured,SANDBOX_sandbox_default:binding} as never);
 const send=(action:string,body:object)=>routes.request(`/${sessionId}/${action}`,{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify(body)});
 return {sql,sessionId,workId,stub,configured,send,token};
}
it("composes the reachable sealed route through SessionDO and persists a strict real checkpoint before ACK",async()=>{
 const f=await fixture(); const response=await f.send("work-checkpoint",{turnId:"input",revision:3});
 expect(response.status,await response.clone().text()).toBe(200);
 expect(await response.json()).toMatchObject({type:"prepared"});
 await runInDurableObject(f.stub,async(_instance,state)=>{expect(state.storage.kv.get("e2b_sandbox_state")).toMatchObject({version:2,latestSnapshot:{status:"taken",ref:{kind:"snapshot",ref:"snapshot-1"}}});});
 expect((await f.sql.prepare("SELECT id FROM managed_session_events WHERE session_id=? AND type='session.status_idle'").bind(f.sessionId).all()).results).toEqual([]);
});

it.each(["generation","ttl"])("refuses stale %s before touching a physical runtime",async kind=>{
 const f=await fixture();
 await f.sql.prepare(`UPDATE managed_environment_work SET ${kind==="holder"?"claim_worker_id='new'":kind==="generation"?"claim_generation=3":"claim_at=0"} WHERE id=?`).bind(f.workId).run();
 const response=await f.send("work-checkpoint",{turnId:"input",revision:3});
 expect([401,409]).toContain(response.status);expect(remote.snapshots).toBe(0);expect(remote.commands).toEqual([]);
});
it("rejects a body claim instead of allowing it to confer authority",async()=>{
 const f=await fixture();expect((await f.send("work-checkpoint",{turnId:"input",revision:3,claim:{holder:"owner"}})).status).toBe(400);
 expect(remote.snapshots).toBe(0);
});
it("snapshot failure never acknowledges preparation or writes a successful terminal",async()=>{
 const f=await fixture();remote.failSnapshot=true;
 expect((await f.send("work-checkpoint",{turnId:"input",revision:3})).status).toBe(502);
 await runInDurableObject(f.stub,async(_instance,state)=>{expect(state.storage.kv.get("e2b_sandbox_state")).toMatchObject({version:1,latestSnapshot:{status:"none"}});});
 expect((await f.sql.prepare("SELECT id FROM managed_session_events WHERE session_id=? AND type='session.status_idle'").bind(f.sessionId).all()).results).toEqual([]);
});
it("requires the process-bound hash, not just the current SQL Work holder",async()=>{
 const f=await fixture();remote.locator.holderHash="b".repeat(64);
 expect((await f.send("work-checkpoint",{turnId:"input",revision:3})).status).toBe(502);expect(remote.snapshots).toBe(0);
});
it("Cloudflare native cannot use an E2B locator as physical authority",async()=>{
 const f=await fixture();f.configured.SANDBOX_ADAPTER="cloudflare";
 expect((await f.send("work-checkpoint",{turnId:"input",revision:3})).status).toBe(503);expect(remote.snapshots).toBe(0);
});
it("commits only after strict persistence and executes the existing artifact publisher after the terminal",async()=>{
 const f=await fixture();
 const { CfManagedSessionSecretSealer }=await import("../../main/src/lib/cf-managed-session-secret-sealer");
 const metadata={__openai_agents_v1:JSON.stringify({version:1,kind:"session",fields:{sealed:await new CfManagedSessionSecretSealer(f.configured.PLATFORM_ROOT_SECRET).seal(JSON.stringify({agent:{},environment:{type:"openai_hosted"},environmentId:(await f.sql.prepare("SELECT environment_id FROM managed_sessions WHERE id=?").bind(f.sessionId).first<{environment_id:string}>())!.environment_id}))}})};
 await f.sql.prepare("UPDATE managed_sessions SET document=json_set(document,'$.metadata',json(?)) WHERE id=?").bind(JSON.stringify(metadata),f.sessionId).run();
 const finalized=await f.send("work-finalize",{turnId:"input",revision:3,stopReason:{type:"end_turn"}});
 expect(finalized.status,await finalized.clone().text()).toBe(200);
 const receipt=await finalized.json() as {revision:number;terminal:{eventId:string}};
 remote.files.set("/workspace/outputs/result.txt","artifact bytes");
 const published=await f.send("work-publish",{turnId:"input",revision:receipt.revision,terminalEventId:receipt.terminal.eventId});
 expect(published.status,await published.clone().text()).toBe(200);
 const files=(await f.sql.prepare("SELECT document FROM managed_files WHERE workspace_id='default'").all<{document:string}>()).results!.map(row=>JSON.parse(row.document)).filter(row=>row.origin?.sessionId===f.sessionId);
 expect(files).toHaveLength(1);expect(files[0].origin).toMatchObject({type:"session_output",path:"/workspace/outputs/result.txt"});
 expect(remote.snapshots).toBe(1);
 expect((await f.send("work-publish",{turnId:"input",revision:receipt.revision,terminalEventId:receipt.terminal.eventId})).status).toBe(200);
 expect((await f.sql.prepare("SELECT document FROM managed_files WHERE workspace_id='default'").all<{document:string}>()).results!.filter(row=>JSON.parse(row.document).origin?.sessionId===f.sessionId)).toHaveLength(1);
});

it("strict checkpoint CAS refuses a concurrent owner record change without overwriting it",async()=>{
 const f=await fixture();remote.mutateRecord=true;
 expect((await f.send("work-checkpoint",{turnId:"input",revision:3})).status).toBe(502);
 await runInDurableObject(f.stub,async(_instance,state)=>{expect(state.storage.kv.get("e2b_sandbox_state")).toMatchObject({version:9,latestSnapshot:{ref:{ref:"winner"}}});});
});
it("holder loss while provider snapshot is pending rejects publication and preserves the old record",async()=>{
 const f=await fixture();remote.onSnapshot=async()=>{await f.sql.prepare("UPDATE managed_environment_work SET claim_worker_id='replacement' WHERE id=?").bind(f.workId).run();};
 expect((await f.send("work-checkpoint",{turnId:"input",revision:3})).status).toBe(409);
 await runInDurableObject(f.stub,async(_instance,state)=>{expect(state.storage.kv.get("e2b_sandbox_state")).toMatchObject({version:1,latestSnapshot:{status:"none"}});});
});
it.each([false,true])("persists changed Memory through canonical D1 before checkpoint (native=%s)",async native=>{
 const f=await fixture(),storeId="store_"+crypto.randomUUID();
 const root=`.openma-managed-memory-workspaces/default/${f.sessionId}/incarnation/${storeId}`,mountId=root+"/data";
 if(native) nativeConfig(f);
 const now=new Date().toISOString();
 await f.sql.prepare("INSERT INTO managed_memory_stores VALUES ('default',?,?,1,?,?,NULL)").bind(storeId,JSON.stringify({id:storeId,name:"notes",description:null,metadata:{},createdAt:now,updatedAt:now,archivedAt:null}),Date.now(),Date.now()).run();
 await f.sql.prepare("UPDATE managed_sessions SET document=json_set(document,'$.resources',json(?)) WHERE id=?").bind(JSON.stringify([{id:"resource",type:"memory_store",memoryStoreId:storeId,name:"notes",access:"read_write",createdAt:now}]),f.sessionId).run();
 await env.MEMORY_BUCKET!.put(root+"/manifest.json",JSON.stringify({version:1,memories:[]}));
 await env.MEMORY_BUCKET!.put(root+"/data/.openma-memory-store",`openma-memory-store-v1\n${storeId}`);
 await runInDurableObject(f.stub,async(_instance,state)=>{const prior=state.storage.kv.get("e2b_sandbox_state") as Record<string,unknown>;state.storage.kv.put("e2b_sandbox_state",{...prior,stores:[{storeId:mountId,storeName:"notes",readOnly:false}]});});
 remote.files.set(`/workspace/.openma/session-inputs/${f.sessionId}/memory/${encodeURIComponent(mountId)}.json`,JSON.stringify({version:1,memoryStoreId:mountId,mountPath:"/mnt/memory/notes",baseline:[]}));
 remote.files.set("/mnt/memory/notes/.openma-memory-store",`openma-memory-store-v1\n${mountId}`);
 remote.files.set("/mnt/memory/notes/learning.md","actual physical learning");
 if(native) remote.drain=async()=>{await env.MEMORY_BUCKET!.put(root+"/data/learning.md","actual physical learning");};
 remote.onSnapshot=async()=>{const rows=(await f.sql.prepare("SELECT document FROM managed_memories WHERE memory_store_id=?").bind(storeId).all<{document:string}>()).results!;expect(rows.map(r=>JSON.parse(r.document))).toMatchObject([{path:"/learning.md",content:"actual physical learning"}]);};
 const response=await f.send("work-checkpoint",{turnId:"input",revision:3});expect(response.status,await response.clone().text()).toBe(200);
 expect(remote.snapshots).toBe(1);
});
it("revalidates sealed bearer inside the DO and refuses caller-provided claims",async()=>{
 const f=await fixture();await runInDurableObject(f.stub,async(_instance,state)=>{
  const owner=new SessionDO(state,f.configured as never);
  const send=(token:string,body:object)=>owner.fetch(new Request("https://internal/__internal/work/finalization/prepare",{method:"POST",headers:{"x-oma-workspace-id":"default",authorization:`Bearer ${token}`},body:JSON.stringify(body)}));
  expect((await send("forged",{turnId:"input",revision:3})).status).not.toBe(200);
  expect((await send(f.token,{turnId:"input",revision:3,claim:{holder:"owner"}})).status).toBe(400);
 });expect(remote.snapshots).toBe(0);
});
it("leased stopping still completes storage without stopping or renewing the Work itself",async()=>{
 const f=await fixture();await f.sql.prepare("UPDATE managed_environment_work SET state='stopping' WHERE id=?").bind(f.workId).run();
 const before=await f.sql.prepare("SELECT claim_at,claim_generation,claim_worker_id FROM managed_environment_work WHERE id=?").bind(f.workId).first();
 expect((await f.send("work-checkpoint",{turnId:"input",revision:3})).status).toBe(200);
 const after=await f.sql.prepare("SELECT claim_at,claim_generation,claim_worker_id FROM managed_environment_work WHERE id=?").bind(f.workId).first();expect(after).toEqual(before);
});
it("native FUSE without an awaited drain port is explicitly unavailable, not an empty cold sync",async()=>{
 const f=await fixture();Object.assign(f.configured,{R2_ACCESS_KEY_ID:"configured-parent"});
 expect((await f.send("work-checkpoint",{turnId:"input",revision:3})).status).toBe(502);expect(remote.snapshots).toBe(0);
});
it("never publishes artifacts for a forged terminal id",async()=>{
 const f=await fixture();const finalized=await f.send("work-finalize",{turnId:"input",revision:3,stopReason:{type:"end_turn"}});expect(finalized.status).toBe(200);
 expect((await f.send("work-publish",{turnId:"input",revision:4,terminalEventId:"invented"})).status).toBe(409);
});

function nativeConfig(f: Awaited<ReturnType<typeof fixture>>) {
 Object.assign(f.configured,{R2_ACCESS_KEY_ID:"parent",R2_SECRET_ACCESS_KEY:"secret",CLOUDFLARE_ACCOUNT_ID:"account",R2_ENDPOINT:"https://account.r2.cloudflarestorage.com",MEMORY_BUCKET_NAME:"memory",FILES_BUCKET_NAME:"files"});
}
it("native E2B waits for real drain receipt before checkpoint and terminal ACK",async()=>{
 const f=await fixture();nativeConfig(f);
 let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>enter=r),gate=new Promise<void>(r=>release=r);
 remote.drain=async()=>{enter();await gate;};
 let done=false;const pending=f.send("work-finalize",{turnId:"input",revision:3,stopReason:{type:"end_turn"}}).then(r=>{done=true;return r;});
 // No fixed delay: race the observable drain entry with a premature response.
 expect(await Promise.race([entered.then(()=>"entered"),pending.then(()=>"premature")])).toBe("entered");
 expect(done).toBe(false);expect(remote.snapshots).toBe(0);
 expect((await f.sql.prepare("SELECT id FROM managed_session_events WHERE session_id=? AND type='session.status_idle'").bind(f.sessionId).all()).results).toEqual([]);
 release();expect((await pending).status).toBe(200);
 expect(remote.snapshots).toBe(1);expect(remote.deleted).toEqual([]);
});
it("CAS loser deletes only its own newly allocated E2B snapshot",async()=>{
 const f=await fixture();remote.mutateRecord=true;
 expect((await f.send("work-checkpoint",{turnId:"input",revision:3})).status).toBe(502);
 expect(remote.deleted).toEqual(["snapshot-1"]);
 await runInDurableObject(f.stub,async(_instance,state)=>{expect(state.storage.kv.get("e2b_sandbox_state")).toMatchObject({latestSnapshot:{ref:{ref:"winner"}}});});
});
it("holder loss after allocation cleans the exact unreferenced candidate without killing a runtime",async()=>{
 const f=await fixture();remote.onSnapshot=async()=>{await f.sql.prepare("UPDATE managed_environment_work SET claim_worker_id='new' WHERE id=?").bind(f.workId).run();};
 expect((await f.send("work-checkpoint",{turnId:"input",revision:3})).status).toBe(409);expect(remote.deleted).toEqual(["snapshot-1"]);
});
it("native drain failure never creates a snapshot or terminal",async()=>{
 const f=await fixture();nativeConfig(f);remote.drain=async()=>{throw Error("rclone queue still uploading");};
 expect((await f.send("work-checkpoint",{turnId:"input",revision:3})).status).toBe(502);
 expect(remote.snapshots).toBe(0);expect(remote.deleted).toEqual([]);
 expect((await f.sql.prepare("SELECT id FROM managed_session_events WHERE session_id=? AND type='session.status_idle'").bind(f.sessionId).all()).results).toEqual([]);
});
it("holder lost during native upload drain cannot publish checkpoint",async()=>{
 const f=await fixture();nativeConfig(f);remote.drain=async()=>{await f.sql.prepare("UPDATE managed_environment_work SET claim_worker_id='replacement' WHERE id=?").bind(f.workId).run();};
 expect((await f.send("work-checkpoint",{turnId:"input",revision:3})).status).toBe(409);expect(remote.snapshots).toBe(0);
});

it("never deletes a candidate now referenced by the winning record",async()=>{
 const f=await fixture();remote.mutateRecord=true;remote.winnerRef="snapshot-1";
 expect((await f.send("work-checkpoint",{turnId:"input",revision:3})).status).toBe(502);expect(remote.deleted).toEqual([]);
});
it("snapshot allocation uncertainty never guesses an id to delete",async()=>{
 const f=await fixture();remote.failSnapshot=true;
 expect((await f.send("work-checkpoint",{turnId:"input",revision:3})).status).toBe(502);expect(remote.deleted).toEqual([]);
});
it("cleanup transport failure cannot turn a failed CAS into success",async()=>{
 const f=await fixture();remote.mutateRecord=true;remote.deleteFails=true;
 expect((await f.send("work-checkpoint",{turnId:"input",revision:3})).status).toBe(502);expect(remote.deleted).toEqual(["snapshot-1"]);
});
it("native E2B completes publication while Work remains leased stopping",async()=>{
 const f=await fixture();nativeConfig(f);
 await f.sql.prepare("UPDATE managed_environment_work SET state='stopping' WHERE id=?").bind(f.workId).run();
 const before=await f.sql.prepare("SELECT claim_at,claim_generation,claim_worker_id FROM managed_environment_work WHERE id=?").bind(f.workId).first();
 const r=await f.send("work-finalize",{turnId:"input",revision:3,stopReason:{type:"end_turn"}});expect(r.status).toBe(200);
 const receipt=await r.json() as {revision:number;terminal:{eventId:string}};
 expect((await f.send("work-publish",{turnId:"input",revision:receipt.revision,terminalEventId:receipt.terminal.eventId})).status).toBe(200);
 expect(await f.sql.prepare("SELECT claim_at,claim_generation,claim_worker_id FROM managed_environment_work WHERE id=?").bind(f.workId).first()).toEqual(before);
 expect(remote.deleted).toEqual([]);
});
