import {expect,it} from "vitest";
import {createWorkTurnFinalizer} from "../src/work-finalization-input-http";
it("uses current consumed-turn recovery revision, joins checkpoint and terminal ACK before publish",async()=>{
 const calls:unknown[]=[];
 const finalizer=createWorkTurnFinalizer({apiBaseUrl:"https://host",sessionId:"s",sessionsToken:"token",signal:new AbortController().signal,fetch:async(url,init)=>{
  const body=JSON.parse(String(init?.body));calls.push([String(url).split('/').at(-1),body]);
  if(String(url).endsWith("work-recovery"))return Response.json({type:"gap",reason:"consumed_turn_without_terminal",revision:8},{status:409});
  if(String(url).endsWith("work-checkpoint"))return Response.json({type:"prepared",turnId:"turn",revision:8});
  const terminal={eventId:"terminal",turnId:"turn",workId:"w",generation:2,revision:9,stopReason:{type:"end_turn"}};
  return Response.json({type:String(url).endsWith("work-finalize")?"committed":"published",revision:9,terminal});
 }});
 await expect(finalizer.checkpoint("turn")).rejects.toThrow();
 finalizer.admitted("turn");await finalizer.checkpoint("turn");await finalizer.complete("turn");await finalizer.publish("turn");
 expect(calls).toEqual([["work-recovery",{turnId:"turn"}],["work-checkpoint",{turnId:"turn",revision:8}],["work-finalize",{turnId:"turn",revision:8,stopReason:{type:"end_turn"}}],["work-publish",{turnId:"turn",revision:9,terminalEventId:"terminal"}]]);
});
it("uses a newer same-turn revision returned after physical checkpoint IO",async()=>{
 const calls:unknown[]=[];
 const f=createWorkTurnFinalizer({apiBaseUrl:"https://host",sessionId:"s",sessionsToken:"token",signal:new AbortController().signal,fetch:async(url,init)=>{
  const action=String(url).split('/').at(-1)!;const body=JSON.parse(String(init?.body));calls.push([action,body]);
  if(action==="work-recovery")return Response.json({type:"gap",reason:"consumed_turn_without_terminal",revision:8},{status:409});
  if(action==="work-checkpoint")return Response.json({type:"prepared",turnId:"t",revision:9});
  const terminal={eventId:"terminal",turnId:"t",workId:"w",generation:2,revision:9,stopReason:{type:"end_turn"}};
  return Response.json({type:action==="work-finalize"?"committed":"published",revision:9,terminal});
 }});
 f.admitted("t");await f.checkpoint("t");await f.complete("t");await f.publish("t");
 expect(calls).toEqual([["work-recovery",{turnId:"t"}],["work-checkpoint",{turnId:"t",revision:8}],["work-finalize",{turnId:"t",revision:9,stopReason:{type:"end_turn"}}],["work-publish",{turnId:"t",revision:9,terminalEventId:"terminal"}]])
});
it("coalesces a periodic checkpoint that crosses terminal finalization",async()=>{
 const calls:string[]=[];
 const f=createWorkTurnFinalizer({apiBaseUrl:"https://host",sessionId:"s",sessionsToken:"token",signal:new AbortController().signal,fetch:async url=>{
  const action=String(url).split('/').at(-1)!;calls.push(action);
  if(action==="work-recovery")return Response.json({type:"gap",reason:"consumed_turn_without_terminal",revision:8},{status:409});
  if(action==="work-checkpoint")return Response.json({type:"prepared",turnId:"t",revision:8});
  const terminal={eventId:"terminal",turnId:"t",workId:"w",generation:2,revision:9,stopReason:{type:"end_turn"}};
  return Response.json({type:action==="work-finalize"?"committed":"published",revision:9,terminal});
 }});
 f.admitted("t");await f.checkpoint("t");await f.checkpoint("t");await f.complete("t");await f.checkpoint("t");await f.publish("t");
 expect(calls).toEqual(["work-recovery","work-checkpoint","work-finalize","work-publish"]);
});
it("retries a checkpoint only after an unknown response, never a terminal mutation",async()=>{
 const calls:string[]=[];let checkpointAttempts=0;
 const f=createWorkTurnFinalizer({apiBaseUrl:"https://host",sessionId:"s",sessionsToken:"token",signal:new AbortController().signal,requestTimeoutMs:5,fetch:async(url,init)=>{
  const action=String(url).split('/').at(-1)!;calls.push(action);
  if(action==="work-recovery")return Response.json({type:"gap",reason:"consumed_turn_without_terminal",revision:8},{status:409});
  if(action==="work-checkpoint"&&checkpointAttempts++===0)return await new Promise<Response>((_resolve,reject)=>init?.signal?.addEventListener("abort",()=>reject(new Error("snapshot response lost")),{once:true}));
  if(action==="work-checkpoint")return Response.json({type:"prepared",turnId:"t",revision:8});
  const terminal={eventId:"terminal",turnId:"t",workId:"w",generation:2,revision:9,stopReason:{type:"end_turn"}};
  return Response.json({type:action==="work-finalize"?"committed":"published",revision:9,terminal});
 }});
 f.admitted("t");await f.checkpoint("t");await f.complete("t");await f.publish("t");
 expect(calls).toEqual(["work-recovery","work-checkpoint","work-checkpoint","work-finalize","work-publish"]);
});
it.each(["rejected","lost"])("never refreshes or retries a %s terminal mutation",async mode=>{
 let calls=0;const finalizer=createWorkTurnFinalizer({apiBaseUrl:"https://host",sessionId:"s",sessionsToken:"token",signal:new AbortController().signal,fetch:async(url)=>{
 if(String(url).endsWith("work-recovery"))return Response.json({type:"gap",reason:"consumed_turn_without_terminal",revision:2},{status:409});
 if(String(url).endsWith("work-checkpoint"))return Response.json({type:"prepared",turnId:"t",revision:2});
 calls++;if(mode==="lost")throw new Error("lost");return Response.json({type:"rejected",reason:"newer_input"},{status:409});
 }});finalizer.admitted("t");await finalizer.checkpoint("t");await expect(finalizer.complete("t")).rejects.toThrow();expect(calls).toBe(1);
});
it.each(["budget_reached","requires_action"] as const)("retains canonical %s instead of reclassifying a parked ACK as failed",async type=>{
 const terminal={eventId:"parked",turnId:"t",workId:"w",generation:2,revision:9,stopReason:type==="requires_action"?{type,eventIds:["tool"]}:{type}};
 const actions:string[]=[];
 const f=createWorkTurnFinalizer({apiBaseUrl:"https://host",sessionId:"s",sessionsToken:"token",signal:new AbortController().signal,fetch:async url=>{
  const action=String(url).split('/').at(-1)!;actions.push(action);
  if(action==="work-recovery")return Response.json({type:"gap",reason:"consumed_turn_without_terminal",revision:8},{status:409});
  if(action==="work-checkpoint")return Response.json({type:"prepared",turnId:"t",revision:8});
  return Response.json({type:action==="work-finalize"?"parked":"published",revision:9,terminal});
 }});
 f.admitted("t");await f.checkpoint("t");await f.complete("t");await f.publish("t");
 expect(actions).toEqual(["work-recovery","work-checkpoint","work-finalize","work-publish"]);
});

// A Session update (budget raise, metadata, a queued input) that lands between
// terminal ACK and publication advances the Session revision. CI reproduced it
// as "Work work-publish rejected (409)" with reason terminal_revision.
function stalePublishFixture(recovery:(publishes:number)=>Response,publishStatus:(revision:number,publishes:number)=>Response){
 const terminal={eventId:"terminal",turnId:"t",workId:"w",generation:2,revision:9,stopReason:{type:"budget_reached"}};
 const calls:unknown[]=[];let publishes=0;let recoveries=0;
 const finalizer=createWorkTurnFinalizer({apiBaseUrl:"https://host",sessionId:"s",sessionsToken:"token",signal:new AbortController().signal,fetch:async(url,init)=>{
  const action=String(url).split('/').at(-1)!;const body=JSON.parse(String(init?.body));calls.push([action,body]);
  if(action==="work-recovery")return recoveries++===0?Response.json({type:"gap",reason:"consumed_turn_without_terminal",revision:8},{status:409}):recovery(publishes);
  if(action==="work-checkpoint")return Response.json({type:"prepared",turnId:"t",revision:8});
  if(action==="work-finalize")return Response.json({type:"parked",revision:9,terminal});
  publishes++;return publishStatus(body.revision,publishes);
 }});
 return {finalizer,calls,terminal,publishes:()=>publishes};
}
it.each(["terminal_revision","authority_changed"])("republishes the identical committed terminal at the current revision after a concurrent Session update (%s)",async reason=>{
 const fx=stalePublishFixture(()=>Response.json({type:"parked",revision:10,terminal:{eventId:"terminal",turnId:"t",workId:"w",generation:2,revision:9,stopReason:{type:"budget_reached"}}}),
  revision=>revision===9?Response.json({type:"rejected",reason},{status:409}):Response.json({type:"published",revision,terminal:{eventId:"terminal",turnId:"t",workId:"w",generation:2,revision:9,stopReason:{type:"budget_reached"}}}));
 fx.finalizer.admitted("t");await fx.finalizer.checkpoint("t");await fx.finalizer.complete("t");await fx.finalizer.publish("t");
 expect(fx.calls.slice(3)).toEqual([["work-publish",{turnId:"t",revision:9,terminalEventId:"terminal"}],["work-recovery",{turnId:"t"}],["work-publish",{turnId:"t",revision:10,terminalEventId:"terminal"}]]);
 // Published once: a second call has nothing left to publish.
 await expect(fx.finalizer.publish("t")).rejects.toThrow(/terminal ACK required/);
});
const refreshable=["terminal_revision","authority_changed"] as const;
const refreshRefusals=[
 ["a changed terminal",{type:"committed",revision:10,terminal:{eventId:"other",turnId:"t",workId:"w",generation:2,revision:10,stopReason:{type:"end_turn"}}},200],
 ["a terminal from another generation",{type:"parked",revision:10,terminal:{eventId:"terminal",turnId:"t",workId:"w",generation:3,revision:9,stopReason:{type:"budget_reached"}}},200],
 ["a terminal of another Work",{type:"parked",revision:10,terminal:{eventId:"terminal",turnId:"t",workId:"other-work",generation:2,revision:9,stopReason:{type:"budget_reached"}}},200],
 ["a non-advancing revision",{type:"parked",revision:9,terminal:{eventId:"terminal",turnId:"t",workId:"w",generation:2,revision:9,stopReason:{type:"budget_reached"}}},200],
 ["a lost claim",{type:"rejected",reason:"claim"},409],
 ["a newer turn",{type:"rejected",reason:"newer_input"},409],
 ["a consumed turn without terminal",{type:"gap",reason:"consumed_turn_without_terminal",revision:10},409],
] as const;
it.each(refreshable.flatMap(reason=>refreshRefusals.map(([label,recovered,status])=>[reason,label,recovered,status] as const)))("never republishes after a %s refresh returns %s",async(reason,_label,recovered,status)=>{
 const fx=stalePublishFixture(()=>Response.json(recovered,{status}),()=>Response.json({type:"rejected",reason},{status:409}));
 fx.finalizer.admitted("t");await fx.finalizer.checkpoint("t");await fx.finalizer.complete("t");
 await expect(fx.finalizer.publish("t")).rejects.toThrow(/rejected/);
 expect(fx.publishes()).toBe(1);
});
it.each(["newer_input","claim","work_stopping"])("does not refresh a publication rejected for %s",async reason=>{
 const fx=stalePublishFixture(()=>{throw new Error("must not refresh");},()=>Response.json({type:"rejected",reason},{status:409}));
 fx.finalizer.admitted("t");await fx.finalizer.checkpoint("t");await fx.finalizer.complete("t");
 await expect(fx.finalizer.publish("t")).rejects.toThrow("Work work-publish rejected (409)");
 expect(fx.calls.map(c=>(c as [string])[0]).slice(3)).toEqual(["work-publish"]);
});
it.each(refreshable)("bounds refreshes when Session updates keep racing publication (%s)",async reason=>{
 let rev=9;
 const fx=stalePublishFixture(()=>Response.json({type:"parked",revision:++rev,terminal:{eventId:"terminal",turnId:"t",workId:"w",generation:2,revision:9,stopReason:{type:"budget_reached"}}}),
  ()=>Response.json({type:"rejected",reason},{status:409}));
 fx.finalizer.admitted("t");await fx.finalizer.checkpoint("t");await fx.finalizer.complete("t");
 await expect(fx.finalizer.publish("t")).rejects.toThrow("Work work-publish rejected (409)");
 expect(fx.publishes()).toBe(4);
});
it.each([
 ["another Work",{workId:"other-work"}],
 ["another generation",{generation:3}],
 ["another original revision",{revision:10}],
 ["another stop reason",{stopReason:{type:"end_turn"}}],
] as const)("rejects a publication receipt naming %s",async(_label,patch)=>{
 const fx=stalePublishFixture(()=>{throw new Error("must not refresh");},revision=>Response.json({type:"published",revision,terminal:{eventId:"terminal",turnId:"t",workId:"w",generation:2,revision:9,stopReason:{type:"budget_reached"},...patch}}));
 fx.finalizer.admitted("t");await fx.finalizer.checkpoint("t");await fx.finalizer.complete("t");
 await expect(fx.finalizer.publish("t")).rejects.toThrow("Invalid Work publication receipt");
});
