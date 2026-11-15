import { expect, it } from "vitest";
import { inspectWorkApprovalResolution } from "../src/session-execution/work-approval-resolution";
const claim={workId:"w",generation:2,holder:"holder"};
const stamp="2026-11-10T00:00:00Z";
const root={inputId:"root",turnId:"turn",expectedDocument:JSON.stringify({id:"root",type:"user.message",processedAt:stamp,source_position:{revision:2,index:0,execution_id:"turn",consumed_by_execution_id:"turn",consumption_claim:claim}})};
function fact(event:object,revision:number,source:object={}){return JSON.stringify({...event,processedAt:stamp,source_position:{revision,index:0,execution_id:"turn",environment_work:{workId:"w",generation:2},...source}});}
const ask=(id:string,revision:number)=>fact({id,type:"agent.tool_use",evaluatedPermission:"ask"},revision);
const pause=fact({id:"pause",type:"session.status_idle",stopReason:{type:"requires_action",eventIds:["a","b"]}},5);
const answer=(patch:object={},source:object={})=>fact({id:"answer",type:"user.tool_confirmation",toolUseId:"a",result:"allow",...patch},6,{execution_id:"answer-turn",consumed_by_execution_id:"turn",consumption_claim:claim,...source});
it("retains every unanswered request despite running, partial pause shrink or agent result",()=>{
 const documents=[ask("a",3),ask("b",4),pause,fact({id:"running",type:"session.status_running"},7),fact({id:"shrink",type:"session.status_idle",stopReason:{type:"requires_action",eventIds:["a"]}},8),fact({id:"fake-result",type:"agent.tool_result",toolUseId:"b"},9)];
 expect(inspectWorkApprovalResolution({root,claim,documents})).toEqual({type:"resolved",pendingRequestIds:["a","b"]});
});
it.each([
 {source:{consumed_by_execution_id:undefined}},
 {source:{consumed_by_execution_id:"other"}},
 {source:{consumption_claim:{...claim,generation:1}}},
 {source:{consumption_claim:{...claim,holder:"other"}}},
 {source:{consumption_claim:{...claim,workId:"other"}}},
 {event:{sessionThreadId:"child"}}, {event:{result:"unknown"}}, {event:{_queued:true}}, {event:{cancelled_at_ms:1}},
 {event:{deferredUntilToolResults:[]}}, {event:{type:"user.tool_result"}},
])("does not count arrival, wrong consumer/claim/lane or invalid answers: %j",({source,event})=>{
 expect(inspectWorkApprovalResolution({root,claim,documents:[ask("a",3),answer(event,source)]})).toEqual({type:"resolved",pendingRequestIds:["a"]});
});
it("only discharges the consumed request, then permits all consumed allow/deny answers",()=>{
 const documents=[ask("a",3),ask("b",4),pause,answer()];
 expect(inspectWorkApprovalResolution({root,claim,documents})).toEqual({type:"resolved",pendingRequestIds:["b"]});
 documents.push(fact({id:"deny-b",type:"user.tool_confirmation",toolUseId:"b",result:"deny"},8,{execution_id:"deny-b",consumed_by_execution_id:"turn",consumption_claim:claim}));
 expect(inspectWorkApprovalResolution({root,claim,documents})).toEqual({type:"resolved",pendingRequestIds:[]});
});
it("leaves startup running and unrelated lanes/generations outside approval accounting",()=>{
 expect(inspectWorkApprovalResolution({root,claim,documents:[fact({id:"start",type:"session.status_running"},3),fact({id:"child",type:"agent.tool_use",evaluatedPermission:"ask",sessionThreadId:"child"},4),fact({id:"old",type:"agent.tool_use",evaluatedPermission:"ask"},5,{environment_work:{workId:"w",generation:1}})]})).toEqual({type:"resolved",pendingRequestIds:[]});
});
it("requires consumed custom results for custom calls, not confirmations or agent results",()=>{
 const custom=fact({id:"c",type:"agent.custom_tool_use"},3);
 expect(inspectWorkApprovalResolution({root,claim,documents:[custom,answer({toolUseId:"c"})]})).toEqual({type:"resolved",pendingRequestIds:["c"]});
 expect(inspectWorkApprovalResolution({root,claim,documents:[custom,answer({type:"user.custom_tool_result",customToolUseId:"c"})]})).toEqual({type:"resolved",pendingRequestIds:[]});
});
it("cannot use an answer before its request or use an invalid root",()=>{
 expect(inspectWorkApprovalResolution({root,claim,documents:[answer(),ask("a",7)]})).toEqual({type:"resolved",pendingRequestIds:["a"]});
 expect(inspectWorkApprovalResolution({root:{...root,turnId:"other"},claim,documents:[]})).toEqual({type:"invalid"});
});
it("never erases a legacy pause whose request evidence is missing",()=>{
 const documents=[pause,fact({id:"running",type:"session.status_running"},7),answer()];
 expect(inspectWorkApprovalResolution({root,claim,documents})).toEqual({type:"resolved",pendingRequestIds:["a","b"]});
});
