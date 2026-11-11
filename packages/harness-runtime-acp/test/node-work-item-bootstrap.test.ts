import {expect,it,vi} from "vitest";
import {runNodeWorkItemCli} from "../src/node-work-item-cli.js";
const environment={ANTHROPIC_ENVIRONMENT_ID:"env",ANTHROPIC_SESSION_ID:"s",ANTHROPIC_WORK_ID:"w",OPENMA_HARNESS_ID:"test",ANTHROPIC_WORK_SECRET:Buffer.from(JSON.stringify({sessions_token:"secret",api_base_url:"https://host"})).toString("base64url")};
const claim={workspaceId:"trusted-ws",environmentId:"env",sessionId:"s",workId:"w",generation:2,holder:"worker"};
const root={inputId:"i",turnId:"t",position:{revision:1,index:0}};
const terminal={eventId:"idle",turnId:"t",workId:"old",generation:1,revision:2,stopReason:{type:"end_turn"}};
const sleep=async(_ms:number,signal:AbortSignal)=>new Promise<void>((_,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener("abort",()=>reject(signal.reason),{once:true});});
it.each(["cleanup-only","parked"] as const)("default CLI bootstraps %s without caller turnId or supervisor construction",async type=>{
 const calls:string[]=[];const receipt={...terminal,stopReason:{type:type==="parked"?"budget_reached":"end_turn"}};
 await runNodeWorkItemCli({environment,fetch:async(raw,init)=>{const action=new URL(String(raw)).pathname.split('/').at(-1)!;calls.push(action);
  if(action==="ack")return Response.json({});if(action==="heartbeat")return Response.json({last_heartbeat:"one",lease_extended:true,state:"running",ttl_seconds:90});
  if(action==="work-bootstrap"){expect(JSON.parse(String(init?.body))).toEqual({});return Response.json({type,claim,root,revision:3,terminal:receipt});}
  if(action==="work-recovery"){expect(JSON.parse(String(init?.body))).toEqual({turnId:"t"});return Response.json({type:type==="parked"?"parked":"committed",revision:3,terminal:receipt});}
  if(action==="work-publish")return Response.json({type:"published",revision:3,terminal:receipt});throw Error(action);
 },scheduler:{sleep},composition:async()=>{throw Error("cleanup must not compose runtime");}});
 expect(calls).toEqual(["ack","heartbeat","work-bootstrap","work-recovery","work-publish"]);
});
it("idle keeps heartbeat alive until cancellation, without constructing runtime or stopping Work",async()=>{
 const controller=new AbortController();let beats=0,reads=0;const calls:string[]=[];
 await expect(runNodeWorkItemCli({environment,signal:controller.signal,heartbeatIntervalMs:2,bootstrapPollIntervalMs:2,
  composition:async()=>{throw Error("idle constructed runtime");},
  fetch:async(raw)=>{const action=new URL(String(raw)).pathname.split('/').at(-1)!;calls.push(action);
   if(action==="ack")return Response.json({});if(action==="heartbeat"){beats++;return Response.json({last_heartbeat:String(beats),lease_extended:true,state:"running",ttl_seconds:90});}
   if(action==="work-bootstrap"){reads++;if(reads===3)controller.abort(Error("idle cancelled"));return Response.json({type:"idle",claim,root:null,revision:3});}throw Error(action);
  },
 })).rejects.toThrow("idle cancelled");
 expect(reads).toBe(3);expect(beats).toBeGreaterThan(1);expect(calls).not.toContain("stop");
});
it("fails closed before startup when required runtime exports are absent",async()=>{
 vi.resetModules();
 vi.doMock("@openma/common/managed-runtime", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@openma/common/managed-runtime");
  return { ...actual, ManagedHarnessFinalizationError: undefined };
 });
 try {
 const { runNodeWorkItemCli } = await import("../src/node-work-item-cli.js");
 const calls:string[]=[];
 await expect(runNodeWorkItemCli({environment,scheduler:{sleep},fetch:async(raw)=>{const action=new URL(String(raw)).pathname.split('/').at(-1)!;calls.push(action);
  if(action==="ack")return Response.json({});if(action==="heartbeat")return Response.json({last_heartbeat:"one",lease_extended:true,state:"running",ttl_seconds:90});
  if(action==="work-bootstrap")return Response.json({type:"run",claim,root,revision:3});if(action==="work-recovery")return Response.json({type:"run",turnId:"t",revision:3});throw Error(action);
 }})).rejects.toThrow(/common.*required.*capabilities/);
 expect(calls).not.toContain("startup-failed");expect(calls).not.toContain("stop");
 } finally { vi.doUnmock("@openma/common/managed-runtime"); vi.resetModules(); }
});
it.each([["gap","canonical_terminal_root_missing",undefined],["gap","consumed_turn_without_terminal",undefined],["rejected","consumed_turn_without_terminal",root]] as const)("default CLI never dispatches after bootstrap %s %s without a settleable root",async(type,reason,gapRoot)=>{
 const calls:string[]=[];
 await expect(runNodeWorkItemCli({environment,scheduler:{sleep},composition:async()=>{throw Error("must not compose");},fetch:async(raw)=>{
  const action=new URL(String(raw)).pathname.split('/').at(-1)!;calls.push(action);
  if(action==="ack")return Response.json({});if(action==="heartbeat")return Response.json({last_heartbeat:"one",lease_extended:true,state:"running",ttl_seconds:90});
  return Response.json({type,reason,...(gapRoot?{root:gapRoot}:{}),revision:3},{status:409});
 }})).rejects.toThrow(reason);
 expect(calls).toEqual(["ack","heartbeat","work-bootstrap"]);
});
it("default CLI settles a bootstrap consumed-without-terminal gap as exhausted, without composing or redispatching",async()=>{
 const calls:Array<[string,unknown]>=[];const exhausted={...terminal,workId:"w",generation:2,revision:4,stopReason:{type:"retries_exhausted"}};
 await expect(runNodeWorkItemCli({environment,scheduler:{sleep},composition:async()=>{throw Error("must not compose");},
  lifecycleClient:{ack:async()=>({}),heartbeat:async()=>({last_heartbeat:"one",lease_extended:true,state:"running",ttl_seconds:90}),stop:async()=>{throw Error("must not stop resident Work");}},
  fetch:async(raw,init)=>{const action=new URL(String(raw)).pathname.split('/').at(-1)!;calls.push([action,JSON.parse(String(init?.body))]);
  if(action==="work-bootstrap")return Response.json({type:"gap",reason:"consumed_turn_without_terminal",root,revision:3},{status:409});
  if(action==="work-recovery")return Response.json({type:"gap",reason:"consumed_turn_without_terminal",revision:3},{status:409});
  if(action==="work-failed")return Response.json({type:"committed",revision:4,terminal:exhausted});
  if(action==="work-publish")return Response.json({type:"published",revision:4,terminal:exhausted});throw Error(action);
 }})).rejects.toMatchObject({phase:"run",message:expect.stringContaining("retries_exhausted")});
 expect(calls).toEqual([["work-bootstrap",{}],["work-recovery",{turnId:"t"}],["work-failed",{turnId:"t",revision:3,phase:"run"}],["work-publish",{turnId:"t",revision:4,terminalEventId:"idle"}]]);
});
it("a bootstrap consumed-without-terminal gap whose claim is lost before work-failed is neither published nor redispatched",async()=>{
 const calls:string[]=[];
 await expect(runNodeWorkItemCli({environment,scheduler:{sleep},composition:async()=>{throw Error("must not compose");},fetch:async(raw)=>{
  const action=new URL(String(raw)).pathname.split('/').at(-1)!;calls.push(action);
  if(action==="ack")return Response.json({});if(action==="heartbeat")return Response.json({last_heartbeat:"one",lease_extended:true,state:"running",ttl_seconds:90});
  if(action==="work-failed")return Response.json({type:"rejected",reason:"claim"},{status:409});
  return Response.json({type:"gap",reason:"consumed_turn_without_terminal",root,revision:3},{status:409});
 }})).rejects.toThrow("Work finalization rejected: claim");
 expect(calls).toEqual(["ack","heartbeat","work-bootstrap","work-recovery","work-failed"]);
});
it("default E2B CLI cleanup uses bootstrap without loading an isolated agent",async()=>{
 const {runNodeE2BWorkItemCli}=await import("../src/node-e2b-work-item-cli.js");
 const calls:string[]=[];
 await runNodeE2BWorkItemCli({environment:{...environment,OPENMA_ACP_HARNESSES:JSON.stringify([{id:"codex-acp",version:"1.8.0",command:"/opt/oma-harnesses/codex-acp/bin/codex-acp"}])},scheduler:{sleep},fetch:async(raw)=>{
  const action=new URL(String(raw)).pathname.split('/').at(-1)!;calls.push(action);
  if(action==="ack")return Response.json({});if(action==="heartbeat")return Response.json({last_heartbeat:"one",lease_extended:true,state:"running",ttl_seconds:90});
  if(action==="work-bootstrap")return Response.json({type:"cleanup-only",claim,root,revision:3,terminal});
  return Response.json({type:action==="work-recovery"?"committed":"published",revision:3,terminal});
 }});
 expect(calls).toEqual(["ack","heartbeat","work-bootstrap","work-recovery","work-publish"]);
});
it("rejects a composition with no actual drain before resolving any harness",async()=>{
 const calls:string[]=[];
 await expect(runNodeWorkItemCli({environment,scheduler:{sleep},composition:async()=>({control:{runtime:{}},finalization:{}} as never),fetch:async(raw)=>{
  const action=new URL(String(raw)).pathname.split('/').at(-1)!;calls.push(action);
  if(action==="ack")return Response.json({});if(action==="heartbeat")return Response.json({last_heartbeat:"one",lease_extended:true,state:"running",ttl_seconds:90});
  if(action==="work-bootstrap")return Response.json({type:"run",claim,root,revision:3});return Response.json({type:"run",turnId:"t",revision:3});
 }})).rejects.toThrow(/actual drainTurn/);
 expect(calls).toEqual(["ack","heartbeat","work-bootstrap","work-recovery"]);
});
it("does not publish a different terminal than the bootstrap cleanup receipt",async()=>{
 const calls:string[]=[];
 await expect(runNodeWorkItemCli({environment,scheduler:{sleep},fetch:async(raw)=>{
  const action=new URL(String(raw)).pathname.split('/').at(-1)!;calls.push(action);
  if(action==="ack")return Response.json({});if(action==="heartbeat")return Response.json({last_heartbeat:"one",lease_extended:true,state:"running",ttl_seconds:90});
  if(action==="work-bootstrap")return Response.json({type:"cleanup-only",claim,root,revision:3,terminal});
  return Response.json({type:"committed",revision:3,terminal:{...terminal,eventId:"different-terminal"}});
 }})).rejects.toThrow(/receipt.*changed/);
 expect(calls).not.toContain("work-publish");
});
