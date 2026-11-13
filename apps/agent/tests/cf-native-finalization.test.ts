import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeAll, afterEach, expect, it } from "vitest";
import { cfWorkFinalizationRoutes } from "../../main/src/lib/cf-work-finalization";
import { SessionDO } from "../src/runtime/session-do";
import { setCloudflareSandboxForTest } from "../src/runtime/sandbox";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import { SqlEnvironmentWorkStore } from "@open-managed-agents/environment-work-store-sql";
import { WebCryptoAesGcm } from "@open-managed-agents/integrations-adapters-cf";
import { seedSandboxGatewaySessionRows } from "../../../packages/sandbox-gateway/test/gateway-store-conformance";

// Only remote native container RPC is simulated. D1, SessionDO, route authentication,
// canonical terminal CAS, R2 and the native host implementation execute in workerd.
function nativePort(sessionId:string, environmentId:string, workId:string) {
 const locator={workspaceId:"default",environmentId,sessionId,workId,generation:2,holder:"owner",holderHash:"a".repeat(64),id:"process",epoch:"incarnation",pid:41,startTicks:"123",status:"running",mounts:[{mountPath:"/mnt/session/outputs",keyPrefix:`t/default/session-outputs/${sessionId}`,access:"read-write"}]};
 const files=new Map<string,string>([["/mnt/session/outputs/result.txt","persisted output"]]);
 return { locator, files, snapshots:0, deleted:[] as string[], fail:false, onSnapshot:undefined as undefined|(()=>Promise<void>),
 async inspectWorkProcess(){return structuredClone(locator);},
 async workProcessIO(expected:unknown,op:{type:string;command?:string;path?:string;content?:string}) {
  if(JSON.stringify(expected)!==JSON.stringify(locator) || locator.status!=="running") throw Error("process lost");
  if(op.type==="read") { const v=files.get(op.path!); if(v===undefined)throw Error("missing");return v; }
  if(op.type==="readBytes") { const v=files.get(op.path!); if(v===undefined)throw Error("missing");return new TextEncoder().encode(v); }
  if(op.type==="write") { files.set(op.path!,op.content!);return; }
  if(op.type==="run") {
   let stdout="";const cmd=op.command!;
   if(cmd.includes("find") && cmd.includes("/mnt/session/outputs")) stdout=btoa("./result.txt\0");
   if(cmd.startsWith("cd /workspace &&") && files.has("/workspace/outputs/result.txt")) stdout=btoa("./outputs/result.txt\0");
   const probe=/if \[ -f '([^']+)' \]/.exec(cmd);if(probe)stdout=files.has(probe[1])?"1":"0";
   const scan=/cd '(\/mnt\/memory\/[^']+)' && find/.exec(cmd);
   if(scan)stdout=btoa([...files.keys()].filter(k=>k.startsWith(scan[1]+"/")).map(k=>"./"+k.slice(scan[1].length+1)+"\0").join(""));
   return {exitCode:0,stdout,stderr:""};
  }
  throw Error("unknown operation");
 },
 async checkpointWorkProcess(expected:unknown) {if(JSON.stringify(expected)!==JSON.stringify(locator))throw Error("lost");await this.onSnapshot?.();if(this.fail)throw Error("snapshot failed");return {allocationId:"allocation",backup:{id:`native-${sessionId}-${++this.snapshots}`,dir:"/workspace",size:42,sha256:"a".repeat(64),format:"tar+zstd/1"}};},
 async discardWorkCheckpoint(_expected:unknown,candidate:{backup:{id:string}}){this.deleted.push(candidate.backup.id);},
 };
}
beforeAll(async()=>{ await exports.default.fetch(new Request("http://localhost/health")); });
afterEach(()=>setCloudflareSandboxForTest(undefined));
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
 const configured={...env,PLATFORM_ROOT_SECRET:root,SANDBOX_ADAPTER:"cloudflare",PUBLIC_BASE_URL:"https://control.test"};
 const native = nativePort(sessionId, environmentId, workId);
 // Simulate the provider write to its declared R2 mount, not copy-sync.
 await env.FILES_BUCKET!.put(`t/default/session-outputs/${sessionId}/result.txt`,"persisted output");
 setCloudflareSandboxForTest(native);
 const binding={fetch:async(input:RequestInfo|URL,init?:RequestInit)=>{
  const req=input instanceof Request?input:new Request(input,init),url=new URL(req.url),body=await req.text();
  expect(req.headers.get("x-oma-workspace-id")).toBe("default");
  const result=await runInDurableObject(stub,async(_instance,state)=>{const owner=new SessionDO(state,configured as never);
   const response=await owner.fetch(new Request("https://internal"+url.pathname.replace(`/sessions/${sessionId}`,""),{method:req.method,headers:req.headers,body}));return {status:response.status,body:await response.text()};});
  return new Response(result.body,{status:result.status});
 }};
 const routes=cfWorkFinalizationRoutes({...configured,SANDBOX_sandbox_default:binding} as never);
 const send=(action:string,body:object)=>routes.request(`/${sessionId}/${action}`,{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify(body)});
 return {sql,sessionId,workId,stub,configured,send,token,native,environmentId};
}
it("native sealed route awaits physical storage and checkpoint before terminal CAS",async()=>{
 const f=await fixture();f.native.onSnapshot=async()=>{expect(await (await env.FILES_BUCKET!.get(`t/default/session-outputs/${f.sessionId}/result.txt`))?.text()).toBe("persisted output");expect((await f.sql.prepare("SELECT id FROM managed_session_events WHERE session_id=? AND type='session.status_idle'").bind(f.sessionId).all()).results).toEqual([]);};
 const response=await f.send("work-finalize",{turnId:"input",revision:3,stopReason:{type:"end_turn"}});
 expect(response.status,await response.clone().text()).toBe(200);
 const rows=(await f.sql.prepare("SELECT backup_handle FROM workspace_backups WHERE source_session_id=?").bind(f.sessionId).all<{backup_handle:string}>()).results!;
 expect(rows).toHaveLength(1);expect(JSON.parse(rows[0].backup_handle)).toMatchObject({id:`native-${f.sessionId}-1`,size:42});
});
it.each(["holder","epoch","generation","paused","ttl"])("native refuses %s without checkpoint",async kind=>{
 const f=await fixture();
 if(kind==="holder")f.native.locator.holder="other";
 if(kind==="generation")f.native.locator.generation=1;
 if(kind==="paused")f.native.locator.status="paused";
 if(kind==="epoch")f.native.locator.epoch="";
 if(kind==="ttl")await f.sql.prepare("UPDATE managed_environment_work SET claim_at=0 WHERE id=?").bind(f.workId).run();
 expect((await f.send("work-checkpoint",{turnId:"input",revision:3})).status).not.toBe(200);expect(f.native.snapshots).toBe(0);
});
it("native checkpoint failure never writes a successful terminal",async()=>{const f=await fixture();f.native.fail=true;expect((await f.send("work-finalize",{turnId:"input",revision:3,stopReason:{type:"end_turn"}})).status).not.toBe(200);expect((await f.sql.prepare("SELECT id FROM managed_session_events WHERE session_id=? AND type='session.status_idle' AND json_extract(document,'$.stop_reason.type')='end_turn'").bind(f.sessionId).all()).results).toEqual([]);});
it("native CAS preserves a concurrent winning backup and cleans only its own candidate",async()=>{
 const f=await fixture();f.native.onSnapshot=async()=>{await f.sql.prepare("INSERT INTO workspace_backups(tenant_id,environment_id,source_session_id,backup_handle,created_at,expires_at) VALUES('default',?,?,?,1,9999999999999)").bind(f.environmentId,f.sessionId,JSON.stringify({id:"winner"})).run();};
 expect((await f.send("work-checkpoint",{turnId:"input",revision:3})).status).not.toBe(200);
 const rows=(await f.sql.prepare("SELECT backup_handle FROM workspace_backups WHERE source_session_id=?").bind(f.sessionId).all<{backup_handle:string}>()).results!;expect(rows.map(r=>JSON.parse(r.backup_handle).id)).toEqual(["winner"]);expect(f.native.deleted).toEqual([`native-${f.sessionId}-1`]);
});
it("native holder loss during snapshot never publishes or touches successor",async()=>{
 const f=await fixture();f.native.onSnapshot=async()=>{await f.sql.prepare("UPDATE managed_environment_work SET claim_worker_id='successor' WHERE id=?").bind(f.workId).run();};
 expect((await f.send("work-checkpoint",{turnId:"input",revision:3})).status).not.toBe(200);expect((await f.sql.prepare("SELECT id FROM workspace_backups WHERE source_session_id=?").bind(f.sessionId).all()).results).toEqual([]);expect(f.native.deleted).toEqual([`native-${f.sessionId}-1`]);
});
it("native afterTerminal publishes real artifact bytes once and refuses a forged receipt",async()=>{
 const f=await fixture();const {CfManagedSessionSecretSealer}=await import("../../main/src/lib/cf-managed-session-secret-sealer");
 const metadata={__openai_agents_v1:JSON.stringify({version:1,kind:"session",fields:{sealed:await new CfManagedSessionSecretSealer(f.configured.PLATFORM_ROOT_SECRET).seal(JSON.stringify({agent:{},environment:{type:"openai_hosted"},environmentId:f.environmentId}))}})};
 await f.sql.prepare("UPDATE managed_sessions SET document=json_set(document,'$.metadata',json(?)) WHERE id=?").bind(JSON.stringify(metadata),f.sessionId).run();
 const finalized=await f.send("work-finalize",{turnId:"input",revision:3,stopReason:{type:"end_turn"}});expect(finalized.status,await finalized.clone().text()).toBe(200);
 const receipt=await finalized.json() as {revision:number;terminal:{eventId:string}};
 f.native.files.set("/workspace/outputs/result.txt","native artifact");
 expect((await f.send("work-publish",{turnId:"input",revision:receipt.revision,terminalEventId:"forged"})).status).toBe(409);
 for(let i=0;i<2;i++)expect((await f.send("work-publish",{turnId:"input",revision:receipt.revision,terminalEventId:receipt.terminal.eventId})).status).toBe(200);
 const files=(await f.sql.prepare("SELECT document FROM managed_files WHERE workspace_id='default'").all<{document:string}>()).results!.map(r=>JSON.parse(r.document)).filter(r=>r.origin?.sessionId===f.sessionId);
 expect(files).toHaveLength(1);expect(files[0].origin).toMatchObject({type:"session_output",path:"/workspace/outputs/result.txt"});
});
it("native Memory physical bytes reach canonical reconciler before checkpoint",async()=>{
 const f=await fixture(),storeId="store_"+crypto.randomUUID(),now=new Date().toISOString();
 const root=`.openma-managed-memory-workspaces/default/${f.sessionId}/incarnation/${storeId}`,mountId=root+"/data";
 await f.sql.prepare("INSERT INTO managed_memory_stores VALUES ('default',?,?,1,?,?,NULL)").bind(storeId,JSON.stringify({id:storeId,name:"notes",description:null,metadata:{},createdAt:now,updatedAt:now,archivedAt:null}),Date.now(),Date.now()).run();
 await f.sql.prepare("UPDATE managed_sessions SET document=json_set(document,'$.resources',json(?)) WHERE id=?").bind(JSON.stringify([{id:"resource",type:"memory_store",memoryStoreId:storeId,name:"notes",mountPath:"/mnt/memory/notes",access:"read_write",createdAt:now}]),f.sessionId).run();
 await env.MEMORY_BUCKET!.put(root+"/manifest.json",JSON.stringify({version:1,memories:[]}));
 await env.MEMORY_BUCKET!.put(root+"/data/.openma-memory-store",`openma-memory-store-v1\n${storeId}`);
 f.native.locator.mounts.push({mountPath:"/mnt/memory/notes",keyPrefix:mountId,access:"read-write"});
 await env.MEMORY_BUCKET!.put(mountId+"/note.md","native learning");
 f.native.onSnapshot=async()=>{const rows=(await f.sql.prepare("SELECT document FROM managed_memories WHERE memory_store_id=?").bind(storeId).all<{document:string}>()).results!;expect(rows.map(r=>JSON.parse(r.document))).toMatchObject([{path:"/note.md",content:"native learning"}]);};
 const r=await f.send("work-checkpoint",{turnId:"input",revision:3});expect(r.status,await r.clone().text()).toBe(200);
});
it("native launch derives SQL holder and persists a cold-recoverable exact kernel process",async()=>{
 const f=await fixture();const {OmaSandbox}=await import("../src/oma-sandbox");const {generateSandboxToken,sandboxTokenSha256}=await import("@open-managed-agents/sandbox-gateway");
 const sandboxToken=generateSandboxToken();await f.sql.prepare("UPDATE managed_environment_work SET sandbox_token_hashes=? WHERE id=?").bind(JSON.stringify([{h:await sandboxTokenSha256(sandboxToken),s:"all"}]),f.workId).run();
 const base=Object.getPrototypeOf(OmaSandbox),proto=Object.getPrototypeOf(OmaSandbox.prototype);
 class PlainDO{constructor(readonly ctx:unknown,readonly env:unknown){}}
 Object.setPrototypeOf(OmaSandbox,PlainDO);Object.setPrototypeOf(OmaSandbox.prototype,PlainDO.prototype);
 try {await runInDurableObject(f.stub,async(_o,state)=>{
  state.storage.kv.put("oma_sandbox_plan",{incarnation:"kernel-epoch",mounts:[],autoStart:false});
  const commands:string[][]=[];
  let dead = false;
  let invalidPid = false;
  const container={running:true,monitor:()=>new Promise<void>(()=>{}),destroy:async()=>{},setInactivityTimeout:async()=>{},interceptAllOutboundHttp:async()=>{},interceptOutboundHttps:async()=>{},interceptOutboundHttp:async()=>{},exec:async(argv:string[])=>{commands.push(argv);return {pid:invalidPid?undefined:73,exitCode:Promise.resolve(0),output:async()=>({stdout:new TextEncoder().encode(argv[0]==="cat"?(dead?"73 (node) Z ":"73 (node) S ")+Array(18).fill("0").join(" ")+" 812 0\n":""),stderr:new Uint8Array(),exitCode:0}),kill:()=>{throw Error("must not kill");}};}};
  const ctx={storage:state.storage,container,exports:{DirectoryBackupGateway:()=>({}),OmaOutbound:()=>({})},blockConcurrencyWhile:async<T>(fn:()=>Promise<T>)=>fn()};
  const o=new OmaSandbox(ctx as never,f.configured as never);
  const environment={ANTHROPIC_BASE_URL:"https://control.test",ANTHROPIC_ENVIRONMENT_ID:f.environmentId,ANTHROPIC_SESSION_ID:f.sessionId,ANTHROPIC_WORK_ID:f.workId,OPENMA_WORKSPACE_ID:"default",OPENMA_SANDBOX_TOKEN:sandboxToken,ANTHROPIC_WORK_SECRET:JSON.stringify({version:1,sessionsToken:f.token,apiBaseUrl:"https://control.test"})};
  // Use official Work wire, not an invented bearer envelope.
  environment.ANTHROPIC_WORK_SECRET=btoa(JSON.stringify({sessions_token:f.token,api_base_url:"https://control.test",claim_generation:2})).replaceAll("+","-").replaceAll("/","_").replace(/=+$/,"");
  const beforeCommands=commands.length;
  await expect(o.startNativeWorkProcess("exec /usr/local/bin/runner",environment,{incarnation:"stale",mounts:[]})).rejects.toThrow("resource generation or mounts changed");
  await expect(o.startNativeWorkProcess("exec /usr/local/bin/runner",environment,{incarnation:"kernel-epoch",mounts:[{bucket:"files",mountPath:"/mnt/session/outputs",options:{prefix:"/expected/",endpoint:"https://fixture.invalid",readOnly:false}}]})).rejects.toThrow("resource generation or mounts changed");
  expect(commands).toHaveLength(beforeCommands);
  const handle=await o.startNativeWorkProcess("exec /usr/local/bin/runner",environment);
  expect(handle.pid).toBe(73);expect(commands.some(c=>c[0]==="/usr/bin/env"&&c[1]==="-i")).toBe(true);
  const cold=new OmaSandbox(ctx as never,f.configured as never);
  expect(await cold.inspectWorkProcess()).toMatchObject({holder:"owner",generation:2,epoch:"kernel-epoch",pid:73,startTicks:"812"});
  await expect(cold.startNativeWorkProcess("exec /usr/local/bin/runner",environment)).rejects.toThrow();
  dead=true;
  expect(await handle.getStatus()).toBe("exited");
  expect(await cold.inspectWorkProcess()).toBeNull();
  expect(state.storage.kv.get("oma_work_process")).toMatchObject({status:"exited"});
  dead=false;
  const next=await cold.startNativeWorkProcess("exec /usr/local/bin/runner",environment);
  expect(next.id).not.toBe(handle.id);
  expect(await cold.inspectWorkProcess()).toMatchObject({id:next.id,status:"running",epoch:"kernel-epoch"});
  expect(await state.storage.getAlarm()).toBeLessThanOrEqual(Date.now()+30000);
  dead=true;expect(await cold.inspectWorkProcess()).toBeNull();dead=false;invalidPid=true;
  await expect(cold.startNativeWorkProcess("exec /usr/local/bin/runner",environment)).rejects.toThrow("unconfirmed");
  expect(state.storage.kv.get("oma_work_process")).toMatchObject({status:"starting",pid:0});
  await f.sql.prepare("UPDATE managed_environment_work SET claim_worker_id='successor' WHERE id=?").bind(f.workId).run();
  expect((state.storage.kv.get("oma_work_process") as {holder:string}).holder).toBe("owner");
 });}finally{Object.setPrototypeOf(OmaSandbox,base);Object.setPrototypeOf(OmaSandbox.prototype,proto);}
});
it("native mounted storage requires an awaited fsync barrier and refuses unsupported flush",async()=>{
 const f=await fixture();Object.assign(f.native.locator,{mounts:[{mountPath:"/mnt/session/outputs",keyPrefix:`t/default/session-outputs/${f.sessionId}`,access:"read-write"}]});
 const original=f.native.workProcessIO.bind(f.native);let flushed=false;
 f.native.workProcessIO=async(expected,op)=>{if(op.type==="run"&&op.command?.startsWith("python3")){flushed=true;return {exitCode:1,stdout:"",stderr:"fsync unsupported"};}return original(expected,op);};
 expect((await f.send("work-checkpoint",{turnId:"input",revision:3})).status).not.toBe(200);expect(flushed).toBe(true);expect(f.native.snapshots).toBe(0);
});
it("native exact epoch replacement during snapshot refuses publication",async()=>{const f=await fixture();f.native.onSnapshot=async()=>{f.native.locator.epoch="successor-epoch";};expect((await f.send("work-checkpoint",{turnId:"input",revision:3})).status).not.toBe(200);expect((await f.sql.prepare("SELECT id FROM workspace_backups WHERE source_session_id=?").bind(f.sessionId).all()).results).toEqual([]);});
it("native 200 remains pending until the physical snapshot barrier resolves",async()=>{
 const f=await fixture();let release!:()=>void,entered!:()=>void;
 const barrier=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
 f.native.onSnapshot=async()=>{entered();await barrier;};let settled=false;
 const request=f.send("work-checkpoint",{turnId:"input",revision:3}).then(r=>{settled=true;return r;});
 await started;expect(settled).toBe(false);expect((await f.sql.prepare("SELECT id FROM workspace_backups WHERE source_session_id=?").bind(f.sessionId).all()).results).toEqual([]);
 release();expect((await request).status).toBe(200);
});
