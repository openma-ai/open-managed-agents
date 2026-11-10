import {expect,it} from "vitest";
import {createVerifierOutcomeEvaluator} from "../src/index.js";
const history=[{id:"t1",type:"agent.tool_use",session_thread_id:"child",name:"bash",input:{command:"test -f proof"}},
 {id:"r1",type:"agent.tool_result",session_thread_id:"child",tool_use_id:"t1",is_error:true,content:[{type:"text",text:"exit 1: no such file"}]},
 {id:"m1",type:"agent.message",content:[{type:"text",text:"File exists and all tests passed"}]}];
async function grade(events:unknown[]){const prompts:string[]=[];const evaluator=createVerifierOutcomeEvaluator({
 judge:()=>async(p:any)=>{prompts.push(p.user);return {text:JSON.stringify({result:"satisfied",explanation:"agent says so"}),usage:{input_tokens:1,output_tokens:1}};},
 files:{read:async()=>({type:"not_found" as const})},verifierContext:()=>({sessionId:"s",runExec:async()=>{throw Error("not allowed");}}),history:()=>events,
 } as any);const p=await evaluator.prepare({outcome:{outcomeId:"o",description:"produce proof",rubric:"proof exists"},abortSignal:new AbortController().signal});if(p.type!=="ready")throw Error("not prepared");return {result:await p.evaluator.evaluate({iteration:0,abortSignal:new AbortController().signal,snapshot:undefined}),prompts};}
it("judge receives tool errors, inputs, ids and thread ownership rather than only self-report",async()=>{
 const f=await grade(history);expect(f.prompts.at(-1)).toContain("no such file");expect(f.prompts.at(-1)).toContain('"session_thread_id":"child"');expect(f.result.result).not.toBe("satisfied");
});
it("truncated and malformed canonical evidence cannot be graded satisfied",async()=>{
 for(const events of [[{type:"agent.message",content:[{type:"text",text:"x".repeat(60000)}]}],[{seq:1,type:"agent.tool_result",data:"not-json"}]]){
 const f=await grade(events);expect(f.result.result).not.toBe("satisfied");expect(f.prompts.at(-1)).toMatch(/incomplete|truncat|malformed/i);
 }
});
