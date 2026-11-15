import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeAll, afterAll, expect, it, vi } from "vitest";
import { DirectoryBackup } from "@cloudflare/sandbox";
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
async function fixture(run:(o:OmaSandbox,state:DurableObjectState,remote:{running:boolean;execs:number;stat:string;fail:boolean;onExec?:()=>void;timeouts:number[]})=>Promise<void>){
 const stub=env.SESSION_DO!.get(env.SESSION_DO!.idFromName(crypto.randomUUID()));
 await runInDurableObject(stub,async(_o,state)=>{
  state.storage.kv.put("oma_sandbox_plan",{incarnation:"epoch",mounts:[],autoStart:false});
  state.storage.kv.put("oma_work_process",binding);
  const remote={running:true,execs:0,fail:false,onExec:undefined as undefined|(()=>void),timeouts:[] as number[],stat:"41 (node) S "+Array(18).fill("0").join(" ")+" 123 0\n"};
  const container={get running(){return remote.running;},setInactivityTimeout:async(ms:number)=>{remote.timeouts.push(ms);},exec:async()=>{remote.execs++;remote.onExec?.();if(remote.fail)throw Error("private transport detail");return {output:async()=>({stdout:new TextEncoder().encode(remote.stat),stderr:new Uint8Array(),exitCode:0})};}};
  const ctx={storage:state.storage,container,exports:{DirectoryBackupGateway:()=>({})},blockConcurrencyWhile:async<T>(f:()=>Promise<T>)=>f()};
  const sandbox=new OmaSandbox(ctx as never,env);
  await run(sandbox,state,remote);
 });
}
it("native locator reads persisted process and kernel start ticks, not just session name",async()=>{await fixture(async(o)=>{expect(await o.inspectWorkProcess()).toMatchObject(binding);});});
it.each(["stopped","epoch","pid-reused","paused"])("native exact inspection refuses %s without starting/rebinding",async kind=>{await fixture(async(o,state,r)=>{
 if(kind==="stopped")r.running=false;
 if(kind==="epoch")state.storage.kv.put("oma_sandbox_plan",{incarnation:"new",mounts:[]});
 if(kind==="pid-reused")r.stat=r.stat.replace("123","124");
 if(kind==="paused")r.stat=r.stat.replace(") S ",") T ");
 expect(await o.inspectWorkProcess()).toBeNull();if(kind==="stopped"||kind==="epoch")expect(r.execs).toBe(0);
});});
it("native checkpoint awaits SDK upload and exact cleanup refuses invented/winner allocations",async()=>{await fixture(async(o,state)=>{
 const backup={id:"own",dir:"/workspace",size:42,sha256:"a".repeat(64),format:"tar+zstd/1" as const};
 const create=vi.spyOn(DirectoryBackup.prototype,"backup").mockResolvedValue(backup);
 const remove=vi.spyOn(DirectoryBackup.prototype,"delete").mockResolvedValue();
 try{
  const candidate=await o.checkpointWorkProcess(binding);
  expect(candidate.backup).toEqual(backup);
  await o.discardWorkCheckpoint(binding,{...candidate,backup:{...backup,id:"winner"}});
  expect(remove).not.toHaveBeenCalled();
  state.storage.kv.put("oma_work_process",{...binding,id:"successor"});
  await o.discardWorkCheckpoint(binding,candidate);
  expect(remove).toHaveBeenCalledExactlyOnceWith(backup);
  expect(state.storage.kv.get("oma_work_process")).toMatchObject({id:"successor"});
 }finally{create.mockRestore();remove.mockRestore();}
});});

it("native mount inspection rejects a replaced local directory, not a successful empty flush",async()=>{await fixture(async(o,state)=>{
 const mount={mountPath:"/mnt/session/outputs",bucket:"files",keyPrefix:"t/default/session-outputs/session",access:"read-write",endpoint:"https://r2.test"};
 state.storage.kv.put("oma_sandbox_plan",{incarnation:"epoch",mounts:[mount]});
 state.storage.kv.put("oma_work_process",{...binding,mounts:[mount]});
 const {S3Mount}=await import("@cloudflare/sandbox");
 const previous=Object.getOwnPropertyDescriptor(S3Mount.prototype,"inspect");
 Object.defineProperty(S3Mount.prototype,"inspect",{configurable:true,value:async()=>({mountPath:mount.mountPath,attachment:{status:"absent"}})});
 try {expect(await o.inspectWorkProcess()).toBeNull();}finally{if(previous)Object.defineProperty(S3Mount.prototype,"inspect",previous);else Reflect.deleteProperty(S3Mount.prototype,"inspect");}
});});
it("native allocation receipt cannot delete a backup already referenced by the restore registry",async()=>{await fixture(async(o,state)=>{
 const id="published-"+crypto.randomUUID(),backup={id,dir:"/workspace",size:42,sha256:"b".repeat(64),format:"tar+zstd/1" as const};
 const create=vi.spyOn(DirectoryBackup.prototype,"backup").mockResolvedValue(backup),remove=vi.spyOn(DirectoryBackup.prototype,"delete").mockResolvedValue();
 try{const candidate=await o.checkpointWorkProcess(binding);await env.MAIN_DB!.prepare("INSERT INTO workspace_backups(tenant_id,environment_id,source_session_id,backup_handle,created_at,expires_at) VALUES('default','env','session',?,1,9999999999999)").bind(JSON.stringify(backup)).run();
 await o.discardWorkCheckpoint(binding,candidate);expect(remove).not.toHaveBeenCalled();expect(state.storage.kv.get("oma_work_process")).toMatchObject({id:"exact"});
 }finally{create.mockRestore();remove.mockRestore();}
});});

// Removing the non-mutating observer or reusing inspectWorkProcess (which
// retires dead slots) breaks these invariants. Only remote container IO is fake.
it("operator observation binds exact Work/attempt/holder and strips capability hashes", async () => { await fixture(async (o,state,r) => {
 const before=state.storage.kv.get("oma_work_process");
 const result=await o.observeWorkProcess({workspaceId:"default",environmentId:"env",sessionId:"session",workId:"work",generation:2,holder:"holder"});
 expect(result).toEqual({status:"running",process:{id:"exact",epoch:"epoch",pid:41,startTicks:"123"},work:{workspaceId:"default",environmentId:"env",sessionId:"session",workId:"work",generation:2,holder:"holder",attemptId:"environment-work-claim:2"}});
 expect(state.storage.kv.get("oma_work_process")).toEqual(before);
 expect(r.execs).toBe(2);
}); });
it.each(["holder","generation","workId","sessionId","workspaceId","environmentId"])("operator observation refuses wrong %s before container IO", async key => { await fixture(async(o,state,r)=>{
 const scope={workspaceId:"default",environmentId:"env",sessionId:"session",workId:"work",generation:2,holder:"holder"};
 const before=state.storage.kv.get("oma_work_process");
 const result=await o.observeWorkProcess({...scope,[key]:key==="generation"?3:"foreign"});
 expect(result).toEqual({status:"unknown"});expect(r.execs).toBe(0);expect(state.storage.kv.get("oma_work_process")).toEqual(before);
}); });
it.each(["pid-reused","zombie","paused","stopped","epoch","malformed"])("operator observation never retires or wakes %s", async kind=>{await fixture(async(o,state,r)=>{
 if(kind==="pid-reused")r.stat=r.stat.replace("123","124");
 if(kind==="zombie")r.stat=r.stat.replace(") S ",") Z ");
 if(kind==="paused")r.stat=r.stat.replace(") S ",") T ");
 if(kind==="stopped")r.running=false;
 if(kind==="epoch")state.storage.kv.put("oma_sandbox_plan",{incarnation:"other",mounts:[]});
 if(kind==="malformed")r.stat="broken";
 const before=state.storage.kv.get("oma_work_process");
 expect(await o.observeWorkProcess({workspaceId:"default",environmentId:"env",sessionId:"session",workId:"work",generation:2,holder:"holder"})).toEqual({status:"unknown"});
 expect(state.storage.kv.get("oma_work_process")).toEqual(before);
});});

it("cold native observation leaves alarms and provider timeout untouched", async () => {
 await fixture(async(o,state,r)=>{
  expect(r.timeouts).toEqual([]);
  expect(await state.storage.getAlarm()).toBeNull();
  expect(await o.observeWorkProcess({workspaceId:"default",environmentId:"env",sessionId:"session",workId:"work",generation:2,holder:"holder"})).toMatchObject({status:"running"});
  expect(await state.storage.getAlarm()).toBeNull();
 });
});

it("native observation fails closed on transport failure without echoing errors", async()=>{await fixture(async(o,state,r)=>{
 r.fail=true;const before=state.storage.kv.get("oma_work_process");
 expect(await o.observeWorkProcess({workspaceId:"default",environmentId:"env",sessionId:"session",workId:"work",generation:2,holder:"holder"})).toEqual({status:"unknown"});
 expect(state.storage.kv.get("oma_work_process")).toEqual(before);
});});
it("native observation rejects replacement during kernel sampling", async()=>{await fixture(async(o,state,r)=>{
 r.onExec=()=>{state.storage.kv.put("oma_work_process",{...binding,id:"successor"});};
 expect(await o.observeWorkProcess({workspaceId:"default",environmentId:"env",sessionId:"session",workId:"work",generation:2,holder:"holder"})).toEqual({status:"unknown"});
 expect(state.storage.kv.get("oma_work_process")).toMatchObject({id:"successor"});
});});
