import {expect,it} from "vitest";
import {buildWorkFinalizationRoutes} from "../../src/work-finalization";
const claim={workspaceId:"ws",environmentId:"env",sessionId:"s",workId:"w",generation:2,holder:"trusted"};
function fixture(){
 const calls:unknown[]=[];
 const handle=async(input:unknown)=>{calls.push(input);return {type:"unavailable",phase:"finalization"};};
 const routes=buildWorkFinalizationRoutes({authenticate:async(token,method,path)=>{calls.push({token,method,path});return token==="work"?claim:null;},applicationFor:async()=>({recover:handle,checkpoint:handle,finalize:handle,publish:handle,fail:handle})});
 const send=(action:string,body:unknown,token="work",session="s")=>routes.request(`/${session}/${action}`,{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify(body)});
 return {send,calls};
}
it("authenticates exact path and passes only trusted scope, never acknowledges missing host",async()=>{
 const f=fixture();const r=await f.send("work-checkpoint",{turnId:"input",revision:3});expect(r.status).toBe(503);expect(await r.json()).toEqual({type:"unavailable",phase:"finalization"});
 expect(f.calls).toEqual([{token:"work",method:"POST",path:"/v1/oma/sessions/s/work-checkpoint"},{claim,turnId:"input",revision:3}]);
});
it("rejects authority/completion/runtime injection and diagnostic-only terminal flags",async()=>{
 const f=fixture();for(const extra of [{claim},{holder:"evil"},{runtimeId:"r"},{completed:true},{terminalState:"published"},{checkpointReceipt:"fake"}])expect((await f.send("work-finalize",{turnId:"i",revision:3,stopReason:{type:"end_turn"},...extra})).status).toBe(400);
 expect(f.calls.every(c=>!(c as object).hasOwnProperty("claim"))).toBe(true);
});
it("rejects admin/session credential, session mismatch, malformed JSON and startup failure relabeling",async()=>{
 const f=fixture();expect((await f.send("work-recovery",{turnId:"i"},"admin")).status).toBe(401);expect((await f.send("work-recovery",{turnId:"i"},"work","other")).status).toBe(401);
 expect((await f.send("work-failed",{turnId:"i",revision:3,phase:"startup"})).status).toBe(400);
 expect((await f.send("work-finalize",{turnId:"i",revision:3,stopReason:{type:"requires_action",eventIds:[]}})).status).toBe(400);
});
it("returns no terminal ACK until application persistence resolves",async()=>{
 let release!:(value:object)=>void;const gate=new Promise<object>(r=>{release=r;});let answered=false;
 const handle=async()=>gate;
 const app=buildWorkFinalizationRoutes({authenticate:async()=>claim,applicationFor:async()=>({recover:handle,checkpoint:handle,finalize:handle,publish:handle,fail:handle})});
 const pending=Promise.resolve(app.request('/s/work-finalize',{method:"POST",headers:{authorization:"Bearer work","content-type":"application/json"},body:JSON.stringify({turnId:"i",revision:3,stopReason:{type:"end_turn"}})})).then(r=>{answered=true;return r;});
 await Promise.resolve();expect(answered).toBe(false);release({type:"committed",revision:4,terminal:{eventId:"exact"}});expect((await pending).status).toBe(200);
});
