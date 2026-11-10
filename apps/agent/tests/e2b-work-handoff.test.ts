import { expect, it } from "vitest";
import { startE2BWorkProcess } from "../src/runtime/e2b-work-handoff";
const delivery={workspaceId:"ws",sessionId:"sess",environmentId:"env",workId:"new",apiBaseUrl:"https://control.test",workSecret:"secret"};
const identity={workspaceId:"ws",sessionId:"sess",workId:"new",attemptId:"environment-work-claim:2"};
const spec={command:"/usr/local/bin/node",args:["/opt/oma-managed/worker/node-e2b-work-item-cli.js"],env:{}};
function fixture(mode:"same"|"old"|"current"|"foreign"|"unknown"|"lost"|"exited"|"unknown-launch"|"other-session"){
 const calls:string[]=[];let starts=0;
 const locator={sandboxId:"physical",id:"exact",epoch:"epoch",pid:19,status:mode==="exited"?"exited":"running",identity:{...identity,...(mode==="foreign"?{workspaceId:"other"}:mode==="same"||mode==="exited"?{}:{workId:"old",attemptId:"environment-work-claim:1"})}};
 const handle={id:"exact",pid:19,kill:async()=>{calls.push("kill");},getStatus:async()=>{calls.push("status");return calls.includes("kill")?"exited":"running";}};
 const runtime={runtimeHandle:()=>({provider:"e2b",runtimeId:"physical"}),startManagedProcess:async()=>{calls.push("start");if(++starts===1)throw Object.assign(new Error(mode==="unknown-launch"?"launch outcome unknown":"management worker busy"),{outcome:mode==="unknown-launch"?"unknown":"rejected"});return handle;},inspectManagedProcessSlot:async()=>{calls.push("inspect");return locator;},restoreManagedProcess:async()=>{calls.push("restore");return handle;}};
 const work={find:async()=>{calls.push("authority");if(mode==="unknown")throw Error("database unavailable");return {work:{data:{id:mode==="other-session"?"another":"sess",type:"session"},state:mode==="current"?"active":"stopped"},claim:{generation:1,claimedAt:new Date().toISOString()},heartbeatTtlSeconds:90};}};
 return {calls,run:()=>startE2BWorkProcess({runtime,work,delivery,generation:2,assertCurrent:async()=>{if(mode==="lost"&&calls.includes("inspect"))throw Error("claim lost");},spec,identity} as never)};
}
it("busy exact current locator reconnects without a duplicate launch or kill",async()=>{const f=fixture("same");expect((await f.run()).id).toBe("exact");expect(f.calls).toEqual(["start","inspect","restore","status"]);});
it("busy obsolete Work retires only its exact locator then makes one fresh launch",async()=>{const f=fixture("old");await f.run();expect(f.calls).toEqual(["start","inspect","authority","restore","kill","status","start"]);});
it.each(["current","foreign","unknown","lost","exited","unknown-launch","other-session"] as const)("busy %s fails closed without kill or retry",async mode=>{const f=fixture(mode);await expect(f.run()).rejects.toThrow();expect(f.calls.filter(c=>c==="start")).toHaveLength(1);expect(f.calls).not.toContain("kill");});
