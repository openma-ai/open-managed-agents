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
async function fixture(run:(o:OmaSandbox,state:DurableObjectState,remote:{running:boolean;execs:number;stat:string})=>Promise<void>){
 const stub=env.SESSION_DO!.get(env.SESSION_DO!.idFromName(crypto.randomUUID()));
 await runInDurableObject(stub,async(_o,state)=>{
  state.storage.kv.put("oma_sandbox_plan",{incarnation:"epoch",mounts:[],autoStart:false});
  state.storage.kv.put("oma_work_process",binding);
  const remote={running:true,execs:0,stat:"41 (node) S "+Array(18).fill("0").join(" ")+" 123 0\n"};
  const container={get running(){return remote.running;},setInactivityTimeout:async()=>{},exec:async()=>{remote.execs++;return {output:async()=>({stdout:new TextEncoder().encode(remote.stat),stderr:new Uint8Array(),exitCode:0})};}};
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
