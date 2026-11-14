import { expect, it } from "vitest";
import { createNodeManagedAcpWorkItemRunner } from "../src/node-work-item.js";
import { buildWorkFinalizationRoutes } from "../../http-routes/src/work-finalization.js";
import { WorkFinalizationApplication } from "../../managed-agents-application/src/work-finalization/application.js";
const environment = { ANTHROPIC_ENVIRONMENT_ID:"env",ANTHROPIC_SESSION_ID:"s",ANTHROPIC_WORK_ID:"work",OPENMA_HARNESS_ID:"test",ANTHROPIC_WORK_SECRET:Buffer.from(JSON.stringify({sessions_token:"scoped",api_base_url:"https://host"})).toString("base64url") };
const terminal = {eventId:"idle",turnId:"turn",workId:"old-work",generation:1,revision:4,stopReason:{type:"end_turn" as const}};
function fixture(mode:"run"|"committed"|"parked"|"gap", failRun=false, cleanupFails=false) {
 const effects:string[]=[];let consumed=mode!=="run",receipt=mode==="committed"?terminal:mode==="parked"?{...terminal,stopReason:{type:"budget_reached" as const}}:null;
 let currentRevision=receipt?4:3;
 let lostPublication=false;
 const app=new WorkFinalizationApplication({persistence:{
  inspect:async()=>({type:"current",consumed,revision:currentRevision,terminal:receipt}),
  commit:async input=>{currentRevision++;receipt={...terminal,workId:"work",revision:currentRevision,stopReason:input.stopReason} as typeof terminal;effects.push("failure-committed");return {type:"current",consumed,revision:currentRevision,terminal:receipt};},
 },host:{prepare:async()=>{throw Error("unexpected model checkpoint");},publish:async()=>{effects.push("artifacts");return {type:"published"};}}});
 const routes=buildWorkFinalizationRoutes({authenticate:async()=>({workspaceId:"ws",environmentId:"env",sessionId:"s",workId:"work",generation:2,holder:"holder"}),applicationFor:async()=>app});
 const fetch:typeof globalThis.fetch=async(raw,init)=>{
  const req=new Request(raw,init);const action=new URL(req.url).pathname.split('/').at(-1)!;effects.push(action);
  if(action==="startup-boundary")return Response.json({revision:currentRevision});
  const response=await routes.fetch(new Request(req.url.replace('/v1/oma/sessions',''),req));
  if(action==="work-publish"&&lostPublication){lostPublication=false;throw Error("lost response");}
  return response;
 };
 let observer:{admitted(turnId:string):void;published(turnId:string):void}|undefined;
 const runner=createNodeManagedAcpWorkItemRunner({environment,fetch,
  recovery:{resolveTurn:async()=>"turn"},
  supervisorFactory: hooks=>{observer=hooks;return {serve:async()=>{},resolveHarness:async()=>{effects.push("resolve");return {start:async()=>{effects.push("start");consumed=true;observer!.admitted("turn");return {completed:failRun?Promise.reject(Error("model failed")):Promise.resolve({exitCode:0}),drain:async()=>{effects.push("drain");},stop:async()=>{effects.push("stop-model");if(cleanupFails)throw Error("activity drain unconfirmed");}};}};}};},
  lifecycleClient:{ack:async()=>({}),heartbeat:async()=>({last_heartbeat:"one",lease_extended:true,state:"running",ttl_seconds:90}),stop:async()=>{effects.push("work-stop");return {};}},
  scheduler:{sleep:async(_ms,signal)=>new Promise<void>((_,reject)=>signal.addEventListener("abort",()=>reject(signal.reason),{once:true}))},
 });
 return {runner,effects,losePublish:()=>{lostPublication=true;}};
}
it.each(["committed","parked"] as const)("%s recovery only publishes original terminal without resolving a harness or stopping resident Work",async mode=>{
 const f=fixture(mode);await f.runner.run();expect(f.effects).toEqual(["work-recovery","work-publish","artifacts"]);
});
it("settles consumed-without-terminal as exhausted through the current claim, never redispatching the model",async()=>{
 const f=fixture("gap");
 await expect(f.runner.run()).rejects.toMatchObject({phase:"run",message:expect.stringContaining("retries_exhausted")});
 expect(f.effects).toEqual(["work-recovery","work-failed","failure-committed","work-publish","artifacts"]);
});
it("settles an admitted run failure through exact-turn recovery and work-failed, then publishes",async()=>{
 const f=fixture("run",true);await expect(f.runner.run()).rejects.toThrow("model failed");
 expect(f.effects).toEqual(["work-recovery","startup-boundary","resolve","start","stop-model","work-recovery","work-failed","failure-committed","work-publish","artifacts"]);
});
it("reads the exact terminal after an unknown publication response without reentering the model",async()=>{
 const f=fixture("committed");f.losePublish();await expect(f.runner.run()).rejects.toThrow(/response unavailable/);
 expect(f.effects).toEqual(["work-recovery","work-publish","artifacts","work-recovery"]);
});

it("default CLI executes cleanup-only through HTTP without checkpoint injection", async () => {
 const { runNodeWorkItemCli } = await import("../src/node-work-item-cli.js");
 const calls:string[]=[];
 await runNodeWorkItemCli({environment,recovery:{resolveTurn:async()=>"turn"},
  supervisorFactory:()=>{throw Error("cleanup must not construct supervisor");},
  fetch:async(raw)=>{const action=new URL(String(raw)).pathname.split('/').at(-1)!;calls.push(action);
   if(action==="work-recovery")return Response.json({type:"committed",revision:4,terminal});
   if(action==="work-publish")return Response.json({type:"published",revision:4,terminal});
   if(action==="heartbeat")return Response.json({last_heartbeat:"one",lease_extended:true,state:"running",ttl_seconds:90});
   if(action==="ack")return Response.json({});
   throw Error("Unexpected CLI HTTP request: "+action);
  },scheduler:{sleep:async(_ms,signal)=>new Promise<void>((_,reject)=>signal.addEventListener("abort",()=>reject(signal.reason),{once:true}))},
 });
 expect(calls).toEqual(["ack","heartbeat","work-recovery","work-publish"]);
});

it("preserves an exhausted committed outcome after cleanup instead of reporting success", async () => {
 const { runNodeWorkItemCli }=await import("../src/node-work-item-cli.js");
 const calls:string[]=[];const exhausted={...terminal,stopReason:{type:"retries_exhausted"}};
 await expect(runNodeWorkItemCli({environment,recovery:{resolveTurn:async()=>"turn"},
  supervisorFactory:()=>{throw Error("must not run model");},
  lifecycleClient:{ack:async()=>({}),heartbeat:async()=>({last_heartbeat:"one",lease_extended:true,state:"running",ttl_seconds:90}),stop:async()=>{throw Error("must not stop later input");}},
  fetch:async(raw)=>{const action=new URL(String(raw)).pathname.split('/').at(-1)!;calls.push(action);return Response.json({type:action==="work-recovery"?"committed":"published",revision:4,terminal:exhausted});},
  scheduler:{sleep:async(_ms,signal)=>new Promise<void>((_,reject)=>signal.addEventListener("abort",()=>reject(signal.reason),{once:true}))},
 })).rejects.toMatchObject({phase:"run",message:expect.stringContaining("retries_exhausted")});
 expect(calls).toEqual(["work-recovery","work-publish"]);
});

it("runs the E2B cleanup-only CLI without loading the agent spawner", async () => {
 const {runNodeE2BWorkItemCli}=await import("../src/node-e2b-work-item-cli.js");
 const calls:string[]=[];
 await runNodeE2BWorkItemCli({environment:{...environment,OPENMA_ACP_HARNESSES:JSON.stringify([{id:"codex-acp",version:"1.8.0",command:"/home/oma-worker/.oma/installed-agent/codex-acp/1.8.0/acp-launch.sh"}])},recovery:{resolveTurn:async()=>"turn"},
  lifecycleClient:{ack:async()=>({}),heartbeat:async()=>({last_heartbeat:"one",lease_extended:true,state:"running",ttl_seconds:90}),stop:async()=>{throw Error("must not stop later input");}},
  fetch:async(raw)=>{const action=new URL(String(raw)).pathname.split('/').at(-1)!;calls.push(action);return Response.json({type:action==="work-recovery"?"committed":"published",revision:4,terminal});},
  scheduler:{sleep:async(_ms,signal)=>new Promise<void>((_,reject)=>signal.addEventListener("abort",()=>reject(signal.reason),{once:true}))},
 });
 expect(calls).toEqual(["work-recovery","work-publish"]);
});

it("unknown terminal ACK reads the original receipt and publishes without work-failed or model replay", async () => {
 const calls:string[]=[];let admission:{admitted(turnId:string):void}|undefined;
 const unknown=Object.assign(new Error("terminal response lost"),{name:"ManagedHarnessFinalizationError",phase:"terminal",terminalState:"unknown",completion:{type:"session.complete",sessionId:"s",turnId:"turn"}});
 let recovered=false;let stopped=false;
 const runner=createNodeManagedAcpWorkItemRunner({environment,recovery:{resolveTurn:async()=>"turn"},
  supervisorFactory:hooks=>{admission=hooks;return {serve:async()=>{},resolveHarness:async()=>({start:async()=>{calls.push("model");admission!.admitted("turn");recovered=true;return {completed:Promise.reject(unknown),drain:async()=>{},stop:async()=>{calls.push("drained-stop");stopped=true;}};}})};},
  fetch:async(raw)=>{const action=new URL(String(raw)).pathname.split('/').at(-1)!;calls.push(action);
   if(action==="startup-boundary")return Response.json({revision:3});
   if(action==="work-recovery")return Response.json(recovered?{type:"committed",revision:4,terminal}:{type:"run",turnId:"turn",revision:3});
   if(action==="work-publish"&&stopped)throw Error("physical authority was released before terminal publication");
   if(action==="work-publish")return Response.json({type:"published",revision:4,terminal});
   throw Error("unsafe call "+action);
  },
  lifecycleClient:{ack:async()=>({}),heartbeat:async()=>({last_heartbeat:"one",lease_extended:true,state:"running",ttl_seconds:90}),stop:async()=>{throw Error("whole-Work stop");}},
  scheduler:{sleep:async(_ms,signal)=>new Promise<void>((_,reject)=>signal.addEventListener("abort",()=>reject(signal.reason),{once:true}))},
 });
 // The supervisor runtime is the physical fence. The test's `stop` callback
 // marks that fence released; Work publication must precede it.
 await expect(runner.run()).rejects.toMatchObject({phase:"finalization"});
 expect(calls).toEqual(["work-recovery","startup-boundary","model","work-recovery","work-publish","drained-stop"]);
});

it("does not settle or republish after the Work terminal is already published", async () => {
 const calls:string[]=[];let admission:{admitted(turnId:string):void}|undefined;
 const published=Object.assign(new Error("post-publication cleanup failed"),{name:"ManagedHarnessFinalizationError",phase:"after-terminal",terminalState:"published",completion:{type:"session.complete",sessionId:"s",turnId:"turn"}});
 const runner=createNodeManagedAcpWorkItemRunner({environment,recovery:{resolveTurn:async()=>"turn"},
  supervisorFactory:hooks=>{admission=hooks;return {serve:async()=>{},resolveHarness:async()=>({start:async()=>{calls.push("model");admission!.admitted("turn");return {completed:Promise.reject(published),drain:async()=>{},stop:async()=>{calls.push("drained-stop");}};}})};},
  fetch:async(raw)=>{const action=new URL(String(raw)).pathname.split('/').at(-1)!;calls.push(action);
   if(action==="work-recovery")return Response.json({type:"run",turnId:"turn",revision:3});
   if(action==="startup-boundary")return Response.json({revision:3});
   throw Error("published terminal must not be settled again: "+action);
  },
  lifecycleClient:{ack:async()=>({}),heartbeat:async()=>({last_heartbeat:"one",lease_extended:true,state:"running",ttl_seconds:90}),stop:async()=>{throw Error("whole-Work stop");}},
  scheduler:{sleep:async(_ms,signal)=>new Promise<void>((_,reject)=>signal.addEventListener("abort",()=>reject(signal.reason),{once:true}))},
 });
 await expect(runner.run()).rejects.toMatchObject({phase:"finalization"});
 expect(calls).toEqual(["work-recovery","startup-boundary","model","drained-stop"]);
});

it("does not settle a turn until failed-run cleanup has actually drained",async()=>{
 const f=fixture("run",true,true);await expect(f.runner.run()).rejects.toBeInstanceOf(AggregateError);
 expect(f.effects).toEqual(["work-recovery","startup-boundary","resolve","start","stop-model"]);
});

it("routes a resident consumer failure to its second admitted turn, never the already published first", async () => {
 const requests:Array<[string,unknown]>=[];let hooks:{admitted(id:string):void;published(id:string):void}|undefined;
 let started=false;
 const runner=createNodeManagedAcpWorkItemRunner({environment,recovery:{resolveTurn:async()=>"first"},
  supervisorFactory:observer=>{hooks=observer;return {serve:async()=>{},resolveHarness:async()=>({start:async()=>{
   started=true;hooks!.admitted("first");hooks!.published("first");hooks!.admitted("second");
   return {completed:Promise.reject(Error("second failed")),drain:async()=>{},stop:async()=>{}};
  }})};},
  fetch:async(raw,init)=>{const action=new URL(String(raw)).pathname.split('/').at(-1)!;const body=JSON.parse(String(init?.body));requests.push([action,body]);
   if(action==="startup-boundary")return Response.json({revision:3});
   if(action==="work-recovery")return started?Response.json({type:"gap",reason:"consumed_turn_without_terminal",revision:8},{status:409}):Response.json({type:"run",turnId:"first",revision:3});
   const receipt={...terminal,turnId:"second",revision:9,stopReason:{type:"retries_exhausted"}};
   return Response.json({type:action==="work-failed"?"committed":"published",revision:9,terminal:receipt});
  },
  lifecycleClient:{ack:async()=>({}),heartbeat:async()=>({last_heartbeat:"one",lease_extended:true,state:"running",ttl_seconds:90}),stop:async()=>{throw Error("must not stop Work");}},
  scheduler:{sleep:async(_ms,signal)=>new Promise<void>((_,reject)=>signal.addEventListener("abort",()=>reject(signal.reason),{once:true}))},
 });
 await expect(runner.run()).rejects.toThrow("second failed");
 expect(requests.slice(2)).toEqual([["work-recovery",{turnId:"second"}],["work-failed",{turnId:"second",revision:8,phase:"run"}],["work-publish",{turnId:"second",revision:9,terminalEventId:"idle"}]]);
});

it.each([200,409] as const)("routes a run refused before any canonical admission to the startup CAS, never work-failed (startup-failed %s)",async status=>{
 const calls:Array<[string,unknown]>=[];
 const runner=createNodeManagedAcpWorkItemRunner({environment,recovery:{resolveTurn:async()=>"turn"},
  // The dispatch gate refused before consuming: hooks.admitted is never called.
  supervisorFactory:()=>({serve:async()=>{},resolveHarness:async()=>({start:async()=>({completed:Promise.reject(Error("Native permission mode was not verified")),drain:async()=>{},stop:async()=>{calls.push(["stop-model",null]);}})})}),
  fetch:async(raw,init)=>{const action=new URL(String(raw)).pathname.split('/').at(-1)!;calls.push([action,JSON.parse(String(init?.body))]);
   if(action==="work-recovery")return Response.json({type:"run",turnId:"turn",revision:3});
   if(action==="startup-boundary")return Response.json({revision:3});
   if(action==="startup-failed")return Response.json({type:status===200?"committed":"rejected"},{status});
   throw Error("unsafe call "+action);
  },
  lifecycleClient:{ack:async()=>({}),heartbeat:async()=>({last_heartbeat:"one",lease_extended:true,state:"running",ttl_seconds:90}),stop:async()=>{throw Error("whole-Work stop");}},
  scheduler:{sleep:async(_ms,signal)=>new Promise<void>((_,reject)=>signal.addEventListener("abort",()=>reject(signal.reason),{once:true}))},
 });
 const error=await runner.run().catch(error=>error);
 if(status===200)expect(error).toMatchObject({name:"NodeManagedAcpWorkItemFailure",phase:"run",message:"Native permission mode was not verified"});
 else expect(error).toBeInstanceOf(AggregateError); // CAS refused: fail closed, left to exact-turn recovery
 const failed=calls.filter(([action])=>action==="startup-failed");
 expect(failed).toHaveLength(status===200?1:2); // one exact replay on rejection, as for startup
 expect(failed[0]![1]).toEqual({revision:3,processedAt:expect.any(String)});
 expect(calls.map(([action])=>action)).not.toContain("work-failed");
});

it("an admitted-then-published turn followed by a refusal does not fabricate a startup settlement for the published turn",async()=>{
 const calls:string[]=[];let hooks:{admitted(id:string):void;published(id:string):void}|undefined;
 const runner=createNodeManagedAcpWorkItemRunner({environment,recovery:{resolveTurn:async()=>"turn"},
  supervisorFactory:observer=>{hooks=observer;return {serve:async()=>{},resolveHarness:async()=>({start:async()=>{hooks!.admitted("turn");hooks!.published("turn");return {completed:Promise.reject(Error("second refused")),drain:async()=>{},stop:async()=>{}};}})};},
  fetch:async(raw)=>{const action=new URL(String(raw)).pathname.split('/').at(-1)!;calls.push(action);
   if(action==="work-recovery")return Response.json({type:"run",turnId:"turn",revision:3});
   if(action==="startup-boundary")return Response.json({revision:3});
   // The server CAS sees revisions advanced by the published turn and refuses.
   if(action==="startup-failed")return Response.json({type:"rejected"},{status:409});
   throw Error("unsafe call "+action);
  },
  lifecycleClient:{ack:async()=>({}),heartbeat:async()=>({last_heartbeat:"one",lease_extended:true,state:"running",ttl_seconds:90}),stop:async()=>{throw Error("whole-Work stop");}},
  scheduler:{sleep:async(_ms,signal)=>new Promise<void>((_,reject)=>signal.addEventListener("abort",()=>reject(signal.reason),{once:true}))},
 });
 await expect(runner.run()).rejects.toBeInstanceOf(AggregateError);
 expect(calls).not.toContain("work-failed");expect(calls).not.toContain("work-publish");
});
