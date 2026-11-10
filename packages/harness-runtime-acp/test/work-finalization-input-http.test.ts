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
