import {expect,it} from "vitest";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {LiveSessionSandbox} from "../src/session-sandbox-live";
import {isolateSandboxAttempt} from "../src/session-sandbox-attempt";
import {initialSandboxState,type SessionSandboxState} from "../src/session-sandbox-state";
import type {SandboxPorts} from "@open-managed-agents/sandbox";

it.skipIf(process.platform==="win32")("physical retirement kills a real detached descendant that survives managed process-group kill",async()=>{
 const node=process.env.npm_node_execpath ?? process.execPath;
 const leader=spawn(node,["--input-type=commonjs","-e",'const {spawn}=require("node:child_process");const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached:true,stdio:"ignore"});child.unref();process.stdout.write(String(child.pid));setInterval(()=>{},1000);'],{detached:true,stdio:["ignore","pipe","pipe"]});
 let diagnostic="";leader.stderr!.on("data",chunk=>{diagnostic+=String(chunk);});
 let escaped=0;
 try {
  const [chunk]=await Promise.race([once(leader.stdout!,"data"),once(leader,"exit").then(([code])=>{throw Error("leader exited before reporting descendant: "+code+" "+diagnostic);}),new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(Error("leader did not report descendant")),2000);timer.unref();})]);escaped=Number(String(chunk).trim());expect(escaped).toBeGreaterThan(1);
  const exited=once(leader,"exit");process.kill(-leader.pid!,"SIGKILL");await exited;
  expect(()=>process.kill(escaped,0)).not.toThrow();
  const attempt={executionId:"work",attemptId:"new",ownerId:"owner",generation:2};
  let record:SessionSandboxState={...initialSandboxState(),phase:"running",handle:{provider:"local-containment-fixture",runtimeId:String(escaped)},runStartedAt:0,version:1,attemptBinding:{...attempt,attemptId:"old"},latestSnapshot:{status:"taken",ref:{provider:"local-containment-fixture",ref:"disk-only",kind:"snapshot"}}};
  const releases:string[]=[];
  const core=new LiveSessionSandbox({compose:async()=>({ports:{sandbox:{handle:"changes",maxLifetimeMs:null,release:async({handle}:{handle:{runtimeId:string}})=>{releases.push(handle.runtimeId);process.kill(Number(handle.runtimeId),"SIGKILL");for(let n=0;n<100;n++){try{process.kill(Number(handle.runtimeId),0);}catch{return;}await new Promise(r=>setTimeout(r,10));}throw Error("descendant exit unconfirmed");}}} as unknown as SandboxPorts<object>}),state:{load:async()=>record,save:async(next,v)=>{if(record.version!==v)return false;record=next;return true;}},scope:()=>({workspaceId:"w",sessionId:"s",environmentId:"e",workId:"work"}),execution:()=>attempt,isCurrent:async()=>true,isolateExecutionAttempts:()=>true,executor:()=>{throw Error("no old runtime exec");},plan:async()=>{throw Error("unused");},resumeRef:async()=>null,warn:()=>{},outputDurability:()=>null,egressRenewMs:null});
  await isolateSandboxAttempt(core,record);
  expect(releases).toEqual([String(escaped)]);expect(()=>process.kill(escaped,0)).toThrow();expect(record).toMatchObject({phase:"lost",requireSnapshot:true,latestSnapshot:{status:"taken"},retiredHandles:[{released:true}]});
 } finally {if(leader.pid){try{process.kill(-leader.pid,"SIGKILL");}catch{}}if(escaped){try{process.kill(escaped,"SIGKILL");}catch{}}}
});
