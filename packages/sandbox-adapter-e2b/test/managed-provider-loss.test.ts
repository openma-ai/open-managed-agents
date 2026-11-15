import { expect, it, vi } from "vitest";
import { startE2BManagedProcess } from "../src/managed-bootstrap";
function fixture() {
 let request:any; let lost=false;
 const transport=Object.assign(new Error('sandbox transport unavailable'),{name:'SandboxNotRunningError'});
 const box={sandboxId:'exact-provider',getInfo:vi.fn(async()=>({state:'running'})),files:{
  read:async(path:string)=>path.endsWith('/ready')?'oma-managed-v2':JSON.stringify({ok:true,id:'exact-process',epoch:'epoch',pid:42,status:'exited'}),
  write:async(path:string,data:string)=>{if(lost)throw transport;if(path.endsWith('.json'))request=JSON.parse(data);}
 }};
 return {box,transport,lose:()=>{lost=true;}};
}
it('retires an exact managed handle only after control-plane provider absence is confirmed',async()=>{
 const f=fixture();const events:any[]=[];const h=await startE2BManagedProcess(f.box as never,{observe:e=>events.push(e)},{command:'/bin/true',env:{}});
 f.lose();f.box.getInfo.mockRejectedValue(Object.assign(new Error('gone'),{name:'SandboxNotFoundError'}));
 await expect(h.kill('SIGTERM')).resolves.toBeUndefined();await expect(h.getStatus()).resolves.toBe('exited');
 expect(f.box.getInfo).toHaveBeenCalledTimes(2);expect(events.filter(e=>e.stage==='provider.getInfo'&&e.status==='failed')).toHaveLength(2);
 expect(events.filter(e=>e.stage==='provider.absence'&&e.status==='completed')).toHaveLength(2);
});
it.each(['running','paused','unknown'])('does not retire an existing provider in state %s',async state=>{
 const f=fixture();const h=await startE2BManagedProcess(f.box as never,{}, {command:'/bin/true',env:{}});f.lose();f.box.getInfo.mockResolvedValue({state});
 await expect(h.kill('SIGTERM')).rejects.toBe(f.transport);await expect(h.getStatus()).rejects.toBe(f.transport);
});
it.each(['TimeoutError','FileNotFoundError','NotFoundError','AuthenticationError'])('does not turn ambiguous provider error %s into terminal status',async name=>{
 const f=fixture();const h=await startE2BManagedProcess(f.box as never,{}, {command:'/bin/true',env:{}});f.lose();const cause=Object.assign(new Error('lookup failure'),{name});f.box.getInfo.mockRejectedValue(cause);
 await expect(h.kill('SIGTERM')).rejects.toBe(cause);await expect(h.getStatus()).rejects.toBe(cause);
});
it('missing provider lookup cannot certify exit or change launch failure',async()=>{
 const f=fixture();const h=await startE2BManagedProcess(f.box as never,{}, {command:'/bin/true',env:{}});f.lose();delete (f.box as any).getInfo;
 await expect(h.kill('SIGTERM')).rejects.toBe(f.transport);await expect(h.getStatus()).rejects.toBe(f.transport);
 await expect(startE2BManagedProcess(f.box as never,{}, {command:'/bin/true',env:{}})).rejects.toMatchObject({outcome:'unknown'});
});
