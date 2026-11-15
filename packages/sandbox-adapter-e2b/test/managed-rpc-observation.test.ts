import { expect, it, vi } from "vitest";
import { E2BSandboxExecutor } from "../src/e2b";
it("correlates exact pending Files stage and native settlement without logging request secrets",async()=>{
 const events:any[]=[];let request:any;let unblock!:()=>void;let block=false;const wait=new Promise<void>(r=>{unblock=r;});
 const box={sandboxId:"physical-1",files:{read:async(path:string)=>{
  if(path.endsWith('/ready'))return 'oma-managed-v2';
  if(block)await wait;
  return JSON.stringify(request.op==='start'?{ok:true,id:'process-1',epoch:'epoch-1',pid:123}:{ok:true,status:'exited'});
 },write:async(path:string,data:string)=>{if(path.endsWith('.json'))request=JSON.parse(data);}}};
 const adapter=new E2BSandboxExecutor(box as never,{managedBootstrap:{},logger:{warn:(_message,event)=>events.push(event)}});
 const handle=await adapter.startManagedProcess({command:'/bin/true',env:{TOKEN:'PRIVATE_SECRET'}},{workspaceId:'ws',sessionId:'session',workId:'work',attemptId:'attempt'});
 block=true;const kill=handle.kill('SIGTERM');await vi.waitFor(()=>expect(events.some(e=>e.operation==='kill'&&e.stage==='files.read.response'&&e.status==='started')).toBe(true));
 const started=events.find(e=>e.operation==='kill'&&e.stage==='files.read.response'&&e.status==='started');
 expect(started).toMatchObject({sandboxId:'physical-1',target:'process-1',workId:'work',sessionId:'session',attemptId:'attempt'});
 expect(events.some(e=>e.requestId===started.requestId&&e.stage==='files.read.response'&&e.status==='completed')).toBe(false);
 unblock();await kill;
 expect(events.some(e=>e.requestId===started.requestId&&e.stage==='files.read.response'&&e.status==='completed')).toBe(true);
 expect(JSON.stringify(events)).not.toContain('PRIVATE_SECRET');expect(JSON.stringify(events)).not.toContain('TOKEN');
});
it("records native transport type and code but rethrows the original failure without request headers",async()=>{
 const events:any[]=[];const error=Object.assign(new Error('PRIVATE_RESPONSE'),{code:'ECONNRESET',headers:{authorization:'PRIVATE_TOKEN'}});
 const adapter=new E2BSandboxExecutor({sandboxId:'physical',files:{read:async()=>{throw error;}}} as never,{managedBootstrap:{},logger:{warn:(_m,e)=>events.push(e)}});
 await expect(adapter.startManagedProcess({command:'/bin/true',env:{}})).rejects.toBe(error);
 expect(events.at(-1)).toMatchObject({stage:'files.read.ready',status:'failed',errorName:'Error',errorCode:'ECONNRESET'});expect(JSON.stringify(events)).not.toContain('PRIVATE');
});
