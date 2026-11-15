import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeAll, afterAll, expect, it } from "vitest";
import { OmaSandbox } from "../src/oma-sandbox";
import type { NativeWorkProcess } from "../src/runtime/cf-native-work-process";

// Real SQLite-backed DO state with ONLY the remote Container/SDK IO simulated.
// No production class test-only methods. The DO superclass is replaced because
// workerd requires the genuine container binding to instantiate it otherwise.
class PlainDO { constructor(readonly ctx:unknown,readonly env:unknown){} }
const base=Object.getPrototypeOf(OmaSandbox),proto=Object.getPrototypeOf(OmaSandbox.prototype);
beforeAll(async()=>{await exports.default.fetch(new Request("http://localhost/health"));Object.setPrototypeOf(OmaSandbox,PlainDO);Object.setPrototypeOf(OmaSandbox.prototype,PlainDO.prototype);});
afterAll(()=>{Object.setPrototypeOf(OmaSandbox,base);Object.setPrototypeOf(OmaSandbox.prototype,proto);});
const binding:NativeWorkProcess={workspaceId:"default",environmentId:"env",sessionId:"session",workId:"work",generation:2,holder:"holder",holderHash:"a".repeat(64),id:"exact",epoch:"epoch",pid:41,startTicks:"123",status:"running",mounts:[]};
async function fixture(run:(o:OmaSandbox,state:DurableObjectState,remote:{running:boolean;execs:number;stat:string;timeouts:number[];destroyed:boolean;fail:boolean;code:number;onExec?:()=>Promise<void>})=>Promise<void>){
 const stub=env.SESSION_DO!.get(env.SESSION_DO!.idFromName(crypto.randomUUID()));
 await runInDurableObject(stub,async(_o,state)=>{
  state.storage.kv.put("oma_sandbox_plan",{incarnation:"epoch",mounts:[],autoStart:false});
  state.storage.kv.put("oma_work_process",binding);
  const remote={running:true,execs:0,stat:"41 (node) S "+Array(18).fill("0").join(" ")+" 123 0\n",timeouts:[] as number[],destroyed:false,fail:false,code:0,onExec:undefined as undefined|(()=>Promise<void>)};
  const container={get running(){return remote.running;},setInactivityTimeout:async(ms:number)=>{remote.timeouts.push(ms);},destroy:async()=>{remote.destroyed=true;remote.running=false;},exec:async()=>{remote.execs++;await remote.onExec?.();if(remote.fail)throw Error("transport unknown");return {output:async()=>({stdout:new TextEncoder().encode(remote.stat),stderr:new Uint8Array(),exitCode:remote.code})};}};
  const ctx={storage:state.storage,container,exports:{DirectoryBackupGateway:()=>({})},blockConcurrencyWhile:async<T>(f:()=>Promise<T>)=>f()};
  const sandbox=new OmaSandbox(ctx as never,env);
  await run(sandbox,state,remote);
 });
}

async function seedAuthority(state:DurableObjectState) {
 const id="work_"+crypto.randomUUID(),session="session_"+crypto.randomUUID(),environmentId="env_"+crypto.randomUUID();
 const {CfD1SqlClient}=await import("@open-managed-agents/sql-client/adapters/cf-d1");
 const {seedSandboxGatewaySessionRows}=await import("../../../packages/sandbox-gateway/test/gateway-store-conformance");
 const sql=new CfD1SqlClient(env.MAIN_DB!);
 await seedSandboxGatewaySessionRows(sql,"default",{id:session,environmentId,vaultIds:[],agent:{id:"agent",version:1},archivedAt:null});
 const {SqlEnvironmentWorkStore}=await import("@open-managed-agents/environment-work-store-sql");
 const work=new SqlEnvironmentWorkStore(sql,{seal:async({plaintext})=>({ciphertext:plaintext}),open:async({ciphertext})=>({plaintext:ciphertext})});
 const now=new Date().toISOString();
 await work.insert({workspaceId:"default",record:{work:{id,environmentId,data:{type:"session",id:session},state:"active",createdAt:now,metadata:{},acknowledgedAt:now,latestHeartbeatAt:now,startedAt:now,stopRequestedAt:null,stoppedAt:null},secret:{sessionsToken:"unused"},claim:{generation:2,claimedAt:now,workerId:"holder"},heartbeatTtlSeconds:90}});
 await sql.prepare("UPDATE managed_environment_work SET sandbox_token_hashes=? WHERE id=?").bind(JSON.stringify([{h:binding.holderHash,s:"all"}]),id).run();
 state.storage.kv.put("oma_work_process",{...binding,workId:id,sessionId:session,environmentId});
 return {sql,id};
}
it.each(["active","stopping"])("cold persisted native %s Work survives idle and renews backstop with a durable wake",async status=>{await fixture(async(o,state,r)=>{
 const f=await seedAuthority(state);await f.sql.prepare("UPDATE managed_environment_work SET state=? WHERE id=?").bind(status,f.id).run();
 state.storage.kv.put("oma_last_activity_ms",0);r.timeouts.length=0;
 await o.alarm();expect(r.destroyed).toBe(false);expect(r.timeouts.length).toBeGreaterThan(0);expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now());expect(await state.storage.getAlarm()).toBeLessThanOrEqual(Date.now()+30000);
});});
it.each(["holder","ttl","hash"])("native lost %s does not renew or destroy a whole container",async kind=>{await fixture(async(o,state,r)=>{
 const f=await seedAuthority(state);await f.sql.prepare(`UPDATE managed_environment_work SET ${kind==="holder"?"claim_worker_id='successor'":kind==="ttl"?"claim_at=0":"sandbox_token_hashes='[]'"} WHERE id=?`).bind(f.id).run();
 state.storage.kv.put("oma_last_activity_ms",0);r.timeouts.length=0;await o.alarm();expect(r.destroyed).toBe(false);expect(r.timeouts).toEqual([]);expect(state.storage.kv.get("oma_work_process")).toMatchObject({id:"exact",status:"running"});
});});
it("native process transport error is unknown, not gone or idle",async()=>{await fixture(async(o,state,r)=>{
 await seedAuthority(state);r.fail=true;state.storage.kv.put("oma_last_activity_ms",0);r.timeouts.length=0;
 await o.alarm();expect(r.destroyed).toBe(false);expect(r.timeouts).toEqual([]);expect(state.storage.kv.get("oma_work_process")).toMatchObject({status:"running"});expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now());
});});
it.each(["Z","X"])("confirmed %s exact process retires only its slot",async status=>{await fixture(async(o,state,r)=>{
 r.stat=r.stat.replace(") S ",`) ${status} `);expect(await o.inspectWorkProcess()).toBeNull();expect(state.storage.kv.get("oma_work_process")).toMatchObject({id:"exact",status:"exited"});
});});
it("failed stat without affirmative disappearance does not retire slot",async()=>{await fixture(async(o,state,r)=>{r.code=1;r.stat="";expect(await o.inspectWorkProcess()).toBeNull();expect(state.storage.kv.get("oma_work_process")).toMatchObject({status:"running"});});});
it("exit observation racing replacement cannot clear successor",async()=>{await fixture(async(o,state,r)=>{
 r.stat=r.stat.replace(") S ",") Z ");r.onExec=async()=>{state.storage.kv.put("oma_work_process",{...binding,id:"successor"});};expect(await o.inspectWorkProcess()).toBeNull();expect(state.storage.kv.get("oma_work_process")).toMatchObject({id:"successor",status:"running"});
});});
it("unknown SQL lookup does not grant provider renewal or reclaim container",async()=>{await fixture(async(o,state,r)=>{
 const f=await seedAuthority(state);await f.sql.prepare("UPDATE managed_environment_work SET sandbox_token_hashes='malformed JSON' WHERE id=?").bind(f.id).run();
 state.storage.kv.put("oma_last_activity_ms",0);r.timeouts.length=0;await o.alarm();expect(r.destroyed).toBe(false);expect(r.timeouts).toEqual([]);expect(state.storage.kv.get("oma_work_process")).toMatchObject({status:"running"});
});});
it("starting unknown launch is neither retired nor renewed by alarm",async()=>{await fixture(async(o,state,r)=>{
 await seedAuthority(state);state.storage.kv.put("oma_work_process",{...(state.storage.kv.get("oma_work_process") as object),status:"starting",pid:0,startTicks:""});
 state.storage.kv.put("oma_last_activity_ms",0);r.timeouts.length=0;await o.alarm();expect(r.destroyed).toBe(false);expect(r.timeouts).toEqual([]);expect(state.storage.kv.get("oma_work_process")).toMatchObject({status:"starting"});
});});
it("successor replacement during physical inspection is not renewed by old authority",async()=>{await fixture(async(o,state,r)=>{
 await seedAuthority(state);state.storage.kv.put("oma_last_activity_ms",0);r.timeouts.length=0;
 r.onExec=async()=>{state.storage.kv.put("oma_work_process",{...(state.storage.kv.get("oma_work_process") as object),id:"successor"});};
 await o.alarm();expect(r.destroyed).toBe(false);expect(r.timeouts).toEqual([]);expect(state.storage.kv.get("oma_work_process")).toMatchObject({id:"successor",status:"running"});
});});
it("pending native inspection coalesces warm alarms and arms wake before IO",async()=>{await fixture(async(o,state,r)=>{
 await seedAuthority(state);let release!:()=>void,enter!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{enter=resolve;});r.execs=0;
 r.onExec=async()=>{enter();await pending;};const a=o.alarm();await entered;const b=o.alarm();expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now());expect(r.execs).toBe(1);release();await Promise.all([a,b]);expect(r.execs).toBe(2);expect(r.destroyed).toBe(false);
});});
it("confirmed missing proc retires slot but permission-like failures do not",async()=>{await fixture(async(o,state,r)=>{
 r.code=1;r.stat="";let n=0;r.onExec=async()=>{if(++n===2)r.code=0;};
 expect(await o.inspectWorkProcess()).toBeNull();expect(state.storage.kv.get("oma_work_process")).toMatchObject({status:"exited"});
});});
it("kernel PID reuse retires old exact slot without signaling the reused PID",async()=>{await fixture(async(o,state,r)=>{
 r.stat=r.stat.replace("123","124");expect(await o.inspectWorkProcess()).toBeNull();expect(state.storage.kv.get("oma_work_process")).toMatchObject({status:"exited"});expect(r.destroyed).toBe(false);
});});
