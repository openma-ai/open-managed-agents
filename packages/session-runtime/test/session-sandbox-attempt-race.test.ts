import {expect,it} from "vitest";
import {LiveSessionSandbox} from "../src/session-sandbox-live";
import {isolateSandboxAttempt} from "../src/session-sandbox-attempt";
import {initialSandboxState,transition,type SessionSandboxState} from "../src/session-sandbox-state";
import type {SandboxPorts} from "@open-managed-agents/sandbox";
const execution={executionId:"work",attemptId:"new",ownerId:"new-owner",generation:2};
const old={provider:"e2b",runtimeId:"old"};
function fixture(){
 let record:SessionSandboxState={...initialSandboxState(),phase:"running",handle:old,runStartedAt:1,version:2,attemptBinding:{...execution,attemptId:"old",generation:1},latestSnapshot:{status:"taken",ref:{provider:"e2b",ref:"snapshot",kind:"snapshot"}}};
 const released:string[]=[];let current=true;let lookupError=false;let releaseError=false;let race=false;
 const core=new LiveSessionSandbox({compose:async()=>({ports:{sandbox:{handle:"changes",maxLifetimeMs:null,release:async({handle}:{handle:{runtimeId:string}})=>{if(releaseError)throw Error("transport unknown");released.push(handle.runtimeId);}}} as unknown as SandboxPorts<object>}),
 state:{load:async()=>record,save:async(next,expected)=>{if(race){race=false;record=transition(record,{type:"attach",handle:{provider:"e2b",runtimeId:"winner"},at:2});return false;}if(record.version!==expected)return false;record=next;return true;}},
 scope:()=>({workspaceId:"w",sessionId:"s",environmentId:"e",workId:"work"}),execution:()=>execution,isolateExecutionAttempts:()=>true,isCurrent:async()=>{if(lookupError)throw Error("lookup unavailable");return current;},executor:()=>{throw Error("unused");},plan:async()=>{throw Error("unused");},resumeRef:async()=>null,warn:()=>{},outputDurability:()=>null,egressRenewMs:null});
 return {core,get:()=>record,released,lose:()=>{current=false;},unknown:()=>{lookupError=true;},failRelease:()=>{releaseError=true;},retryRelease:()=>{releaseError=false;},race:()=>{race=true;}};
}
it("retirement CAS losing to newer physical publication cannot destroy that winner",async()=>{const f=fixture();f.race();await expect(isolateSandboxAttempt(f.core,f.get())).rejects.toThrow(/CAS lost/);expect(f.released).toEqual([]);expect(f.get()).toMatchObject({handle:{runtimeId:"winner"}});});
it("unknown lookup is not authority loss and authorizes neither CAS nor kill",async()=>{const f=fixture();f.unknown();await expect(isolateSandboxAttempt(f.core,f.get())).rejects.toThrow("lookup unavailable");expect(f.get().version).toBe(2);expect(f.released).toEqual([]);});
it("unconfirmed release stays retired and blocks reuse until explicit retry",async()=>{const f=fixture();f.failRelease();await expect(isolateSandboxAttempt(f.core,f.get())).rejects.toThrow(/unconfirmed/);expect(f.get()).toMatchObject({phase:"lost",requireSnapshot:true,retiredHandles:[{handle:old,released:false}]});f.retryRelease();await isolateSandboxAttempt(f.core,f.get());expect(f.released).toEqual(["old"]);expect(f.get().latestSnapshot).toMatchObject({status:"taken"});});
it("old holder cannot destroy a new holder allocation",async()=>{const f=fixture();f.lose();await expect(isolateSandboxAttempt(f.core,f.get())).rejects.toThrow(/Current execution/);expect(f.released).toEqual([]);expect(f.get().version).toBe(2);});
