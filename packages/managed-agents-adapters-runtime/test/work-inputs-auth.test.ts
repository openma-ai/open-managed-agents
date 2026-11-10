import { expect, it } from "vitest";
import * as tokens from "../src/environment-work-session-token";

const now = new Date("2026-11-10T00:00:00Z");
const crypto = { encrypt: async (s:string)=>btoa(s), decrypt: async (s:string)=>atob(s) };
const payload = {version:1,workspaceId:"ws",sessionId:"s",environmentId:"env",workId:"w",issuedAt:now.toISOString(),expiresAt:new Date(+now+60000).toISOString(),claimedAt:now.toISOString(),generation:2,skills:[],files:[],memoryStores:[]};
const token = "sk-ant-req-v1."+btoa(JSON.stringify(payload));
const record = {work:{data:{type:"session",id:"s"},state:"active"},secret:{sessionsToken:token},claim:{workerId:"trusted",generation:2,claimedAt:now.toISOString()},heartbeatTtlSeconds:90};
it("resolves input holder only from the matching live persisted claim",async()=>{
  expect(typeof tokens.authenticateWorkInputBearer).toBe("function");
  const authenticate = (value=record, path="/v1/oma/sessions/s/inputs-read", method="POST") => tokens.authenticateWorkInputBearer({token,path,method,crypto,now:()=>now,find:async()=>value as never});
  expect(await authenticate()).toEqual({workspaceId:"ws",sessionId:"s",environmentId:"env",workId:"w",generation:2,holder:"trusted"});
  for(const value of [ {...record,claim:{...record.claim,generation:3}}, {...record,claim:{...record.claim,workerId:null}}, {...record,claim:{...record.claim,claimedAt:new Date(+now-90000).toISOString()}}, {...record,secret:{sessionsToken:"other"}}, {...record,work:{...record.work,state:"queued"}} ]) expect(await authenticate(value as typeof record)).toBeNull();
  for(const path of ["/v1/oma/sessions/other/inputs-read","/v1/oma/sessions/s/inputs-read/extra","/v1/oma/sessions/s/runtime-events"])expect(await authenticate(record,path)).toBeNull();
  expect(await authenticate(record,undefined,"GET")).toBeNull();
  expect(await authenticate(record,"/v1/oma/sessions/s/inputs-consume")).not.toBeNull();
});
it("does not disguise an unavailable claim database as an invalid credential",async()=>{
 const failure=new Error("database unavailable");
 await expect(tokens.authenticateWorkInputBearer({token,path:"/v1/oma/sessions/s/inputs-read",method:"POST",crypto,now:()=>now,find:async()=>{throw failure;}})).rejects.toBe(failure);
});
