import { it, expect } from "vitest";
import { E2BSandboxExecutor } from "../src/e2b";
import type { E2BManagedLocator } from "../src/managed-bootstrap";
const locator: E2BManagedLocator = {sandboxId:"s",id:"id",epoch:"epoch",pid:12,status:"running",identity:{workspaceId:"w",sessionId:"s",workId:"a",attemptId:"1"}};
it("destroy failure closes new inspect/restore/start before any Files I/O", async()=>{
 let io=0;const adapter=new E2BSandboxExecutor({sandboxId:"s",files:{read:async()=>{io++;throw Error("unexpected files")},write:async()=>{io++}},kill:async()=>{throw Error("kill denied")}} as never,{managedBootstrap:{}});
 await expect(adapter.destroy()).rejects.toThrow("kill denied");
 await expect(adapter.inspectManagedProcessSlot()).rejects.toThrow(/closed/i);
 await expect(adapter.restoreManagedProcess(locator)).rejects.toThrow(/closed/i);
 await expect(adapter.startManagedProcess({command:"/node",env:{}})).rejects.toThrow(/closed/i);
 expect(io).toBe(0);
});
it("destroy waits in-flight restore and discards its handle instead of publishing after close",async()=>{
 let release!:()=>void;const barrier=new Promise<void>(r=>{release=r});let entered!:()=>void;const reached=new Promise<void>(r=>{entered=r});const events:string[]=[];
 const adapter=new E2BSandboxExecutor({sandboxId:"s",files:{read:async(path:string)=>{if(path.endsWith("/ready")){entered();await barrier;return "oma-managed-v2"}return JSON.stringify({ok:true,status:"running"})},write:async()=>{}},kill:async()=>{events.push("kill")}} as never,{managedBootstrap:{}});
 const restoring=adapter.restoreManagedProcess(locator);void restoring.catch(()=>{});await reached;
 const destroying=adapter.destroy();expect(events).toEqual([]);release();
 await expect(restoring).rejects.toThrow(/closed/i);await destroying;expect(events).toEqual(["kill"]);
});

it("unknown dispatch still permits exact recovery, but not another start",async()=>{
 let fail=true;
 const adapter=new E2BSandboxExecutor({sandboxId:"s",files:{read:async(path:string)=>path.endsWith("/ready")?"oma-managed-v2":JSON.stringify({ok:true,status:"running",locator:{...locator,sandboxId:undefined}}),write:async()=>{if(fail){fail=false;throw Error("dispatch lost")}}}} as never,{managedBootstrap:{}});
 await expect(adapter.startManagedProcess({command:"/node",env:{}})).rejects.toThrow(/unknown/i);
 await expect(adapter.startManagedProcess({command:"/node",env:{}})).rejects.toThrow(/closed/i);
 expect((await adapter.inspectManagedProcessSlot()).id).toBe(locator.id);
 expect((await adapter.restoreManagedProcess(locator)).id).toBe(locator.id);
});
it("in-flight inspect is discarded before destroy completes",async()=>{
 let release!:()=>void;const barrier=new Promise<void>(r=>release=r);let entered!:()=>void;const reached=new Promise<void>(r=>entered=r);let killed=false;
 const adapter=new E2BSandboxExecutor({sandboxId:"s",files:{read:async(path:string)=>{if(path.endsWith("/ready")){entered();await barrier;return "oma-managed-v2"}return JSON.stringify({ok:true,locator})},write:async()=>{}},kill:async()=>{killed=true}} as never,{managedBootstrap:{}});
 const inspect=adapter.inspectManagedProcessSlot();void inspect.catch(()=>{});await reached;const destroy=adapter.destroy();expect(killed).toBe(false);release();
 await expect(inspect).rejects.toThrow(/closed/i);await destroy;expect(killed).toBe(true);
});
