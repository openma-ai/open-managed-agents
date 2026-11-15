import { expect,it } from "vitest";
import { buildWorkInputRoutes } from "../../src/work-inputs";
const claim={workspaceId:"ws",sessionId:"s",environmentId:"env",workId:"w",generation:1,holder:"h"};
function fixture() {
 const calls:unknown[]=[];
 const routes=buildWorkInputRoutes({authenticate:async(token,method,path)=>{calls.push({token,method,path});return token==="work"?claim:null;},applicationFor:async()=>({
  read:async input=>{calls.push(input);return {type:"gap",reason:"source_position_index_required"};},
  consume:async input=>{calls.push(input);return {type:"gap",reason:"acceptance_receipt_not_persisted"};},
 })});
 const send=(action:string,body:unknown,token="work",session="s")=>routes.request("/"+session+"/"+action,{method:"POST",headers:{authorization:"Bearer "+token,"content-type":"application/json"},body:JSON.stringify(body)});
 return {send,calls};
}
it("uses exact private path and trusted claim, returns explicit missing prerequisite",async()=>{
 const {send,calls}=fixture();const response=await send("inputs-read",{cursor:null,limit:2});
 expect(response.status).toBe(409);expect(await response.json()).toEqual({type:"gap",reason:"source_position_index_required"});
 expect(calls).toEqual([{token:"work",method:"POST",path:"/v1/oma/sessions/s/inputs-read"},{claim,cursor:null,limit:2}]);
});
it("rejects missing Work credential and wrong Session",async()=>{
 const {send}=fixture();expect((await send("inputs-read",{cursor:null,limit:2},"admin")).status).toBe(401);
 expect((await send("inputs-read",{cursor:null,limit:2},"work","other")).status).toBe(401);
});
it("rejects client-supplied scope and invalid consumption boundary",async()=>{
 const {send}=fixture();
 expect((await send("inputs-read",{cursor:null,limit:2,claim})).status).toBe(400);
 for(const boundary of ["yield","received",null])expect((await send("inputs-consume",{inputId:"i",turnId:"i",expectedDocument:"{}",boundary})).status).toBe(400);
});
it("does not convert unknown acceptance to a successful receipt",async()=>{
 const {send,calls}=fixture();const body={inputId:"i",turnId:"i",expectedDocument:"{}",boundary:"acceptance_unknown"};
 const response=await send("inputs-consume",body);expect(response.status).toBe(409);
 expect(await response.json()).toEqual({type:"gap",reason:"acceptance_receipt_not_persisted"});
 expect(calls[1]).toEqual({...body,claim});
});
it("passes explicit ownership evidence but rejects incomplete or extraneous root claims",async()=>{
 const {send,calls}=fixture();
 const body={inputId:"answer",turnId:"dispatch-answer",expectedDocument:"{}",boundary:"before_dispatch",consumingTurnId:"root-turn",rootInputId:"root",expectedRootDocument:"{\"id\":\"root\"}"};
 expect((await send("inputs-consume",body)).status).toBe(409);expect(calls[1]).toEqual({...body,claim});
 for(const patch of [{rootInputId:undefined},{expectedRootDocument:undefined},{consumingTurnId:"dispatch-answer"},{consumingTurnId:undefined},{consumingTurnId:1},{holder:"forged"}])expect((await send("inputs-consume",{...body,...patch})).status).toBe(400);
});
