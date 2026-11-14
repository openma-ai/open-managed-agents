import {expect,it} from "vitest";
import * as tokens from "../src/environment-work-session-token";
const now=new Date("2026-11-10T00:00:00Z");const crypto={encrypt:async(s:string)=>btoa(s),decrypt:async(s:string)=>atob(s)};
const token="sk-ant-req-v1."+btoa(JSON.stringify({version:1,workspaceId:"ws",environmentId:"env",sessionId:"s",workId:"w",generation:2,claimedAt:now.toISOString(),issuedAt:now.toISOString(),expiresAt:new Date(+now+60000).toISOString(),skills:[],files:[],memoryStores:[]}));
const record={work:{data:{type:"session",id:"s"},state:"active"},secret:{sessionsToken:token},claim:{workerId:"trusted",generation:2,claimedAt:now.toISOString()},heartbeatTtlSeconds:90};
it("admits only exact finalization paths with sealed current holder, including owned stopping cleanup",async()=>{
 expect(typeof tokens.authenticateWorkFinalizationBearer).toBe("function");
 for(const action of ["work-recovery","work-checkpoint","work-finalize","work-publish","work-failed"]){
  const auth=(value=record,path=`/v1/oma/sessions/s/${action}`,method="POST")=>tokens.authenticateWorkFinalizationBearer({token,path,method,crypto,now:()=>now,find:async()=>value});
  expect(await auth()).toEqual({workspaceId:"ws",environmentId:"env",sessionId:"s",workId:"w",generation:2,holder:"trusted"});
  expect(await auth({...record,work:{...record.work,state:"stopping"}})).not.toBeNull();
  for(const path of [`/v1/oma/sessions/other/${action}`,`/v1/oma/sessions/s/${action}/more`,`/v1/oma/sessions/s/${action}/`])expect(await auth(record,path)).toBeNull();
  expect(await auth(record,undefined,"GET")).toBeNull();
  for(const value of [{...record,claim:{...record.claim,generation:3}},{...record,secret:{sessionsToken:"different"}},{...record,work:{...record.work,state:"stopped"}},{...record,claim:{...record.claim,workerId:""}},{...record,claim:{...record.claim,claimedAt:new Date(+now-90000).toISOString()}}])expect(await auth(value)).toBeNull();
 }
});
