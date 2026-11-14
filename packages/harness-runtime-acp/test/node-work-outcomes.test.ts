import { expect, it } from "vitest";
import * as module from "../src/node-work-outcomes.js";
const outcome={id:"out",description:"write hello",rubric:{type:"text",content:"must say hello"},maxIterations:2};
// The control plane advertises the card's wire protocol. This fixture's model
// speaks OpenAI chat completions (an `openai` card without it routes through
// Pi's Responses API); other protocols are covered by the advertised-protocol test.
const channels={mcpProxy:{gatewayBaseUrl:"https://gateway",sessionsToken:"oma_sbx_fixture"},hostedInference:{gatewayBaseUrl:"https://gateway",sessionsToken:"oma_sbx_fixture",model:{providerId:"openai",baseUrl:null,wireModel:"judge",protocolEndpoints:[{protocol:"openai-chat" as const,proxyPathSegment:"openai/v1",upstreamBaseUrl:"https://must-not-contact"}]}}};
it.each(["satisfied","max","abort","failed"])("shared default outcome grader %s preserves spans, usage and awaited revision",async mode=>{
 const events:any[]=[]; const requests:string[]=[]; const controller=new AbortController(); let grades=0,revisions=0;
 const complete=module.createWorkOutcomeCompletion({sessionId:"s",apiBaseUrl:"https://control",sessionsToken:"work-token",channels:()=>channels,
  fetch:async(raw,init)=>{const url=new URL(String(raw));requests.push(url.pathname);
   if(url.pathname.includes("/events"))return Response.json({data:[{type:"agent.message",content:[{type:"text",text:revisions?"hello":"draft"}]}],next_page:null});
   expect(new Headers(init?.headers).get("authorization")).toBe("Bearer oma_sbx_fixture");
   expect(JSON.parse(String(init?.body)).messages[1].content).toContain(revisions?"hello":"draft");
   grades++;if(mode==="abort"){controller.abort();throw new DOMException("aborted","AbortError");}
   return Response.json({choices:[{message:{content:JSON.stringify({result: mode==="satisfied"&&grades>1?"satisfied":"needs_revision",explanation:"fix hello"})}}],usage:{prompt_tokens:11,completion_tokens:3}});
  }});
 await complete({command:{sessionId:"s",turnId:"root",input:{eventId:"root",event:{},outcome:mode==="failed"?{...outcome,rubric:{type:"text",content:""}}:outcome}},signal:controller.signal,flush:async()=>{},cancel:async()=>{},
  publishOutcomeEvents:async (batch:any[])=>{events.push(...batch);},runRevision:async({turnId,text}:{turnId:string;text:string})=>{expect(turnId).not.toBe("root");expect(text).toContain("fix hello");revisions++;}} as never);
 const ends=events.filter(e=>e.type==="span.outcome_evaluation_end");
 expect(ends.at(-1).result).toBe(mode==="max"?"max_iterations_reached":mode==="abort"?"interrupted":mode==="failed"?"failed":"satisfied");
 expect(revisions).toBe(mode==="satisfied"||mode==="max"?1:0);
 if(grades&&mode!=="abort")expect(ends[0].usage).toMatchObject({input_tokens:11,output_tokens:3});
 expect(events.filter(e=>e.type==="span.outcome_evaluation_start")).toHaveLength(ends.length);
});
it("does not send Work credentials to model when channels are unavailable, and records failure through shared grader",async()=>{
 const events:any[]=[];
 const complete=module.createWorkOutcomeCompletion({sessionId:"s",apiBaseUrl:"https://control",sessionsToken:"work-token",channels:()=>undefined,
  fetch:async(raw)=>{expect(String(raw)).toContain("/events");return Response.json({data:[{id:"m1",type:"agent.message",content:[{type:"text",text:"hello"}]}],next_page:null});}});
 // Empty rubric fails before judge invocation without model capability fallback.
 await complete({command:{sessionId:"s",turnId:"root",input:{eventId:"root",event:{},outcome:{...outcome,rubric:undefined}}},signal:new AbortController().signal,
  flush:async()=>{},cancel:async()=>{},publishOutcomeEvents:async (batch:any[])=>{events.push(...batch);},runRevision:async()=>{throw Error("must not revise");}} as never);
 expect(events.at(-1).result).toBe("failed");
});
it.each(["anthropic-messages","openai-responses","gemini"])("uses advertised %s gateway protocol and preserves model usage",async protocol=>{
 const events:any[]=[];
 const endpoint={protocol,proxyPathSegment:protocol==="gemini"?"gemini":protocol==="anthropic-messages"?"anthropic":"openai/v1",upstreamBaseUrl:"https://must-not-contact"};
 const complete=module.createWorkOutcomeCompletion({sessionId:"s",apiBaseUrl:"https://control",sessionsToken:"work-token",channels:()=>({...channels,hostedInference:{...channels.hostedInference,model:{...channels.hostedInference.model,protocolEndpoints:[endpoint as never]}}}),
 fetch:async(raw,init)=>{const url=new URL(String(raw));if(url.pathname.includes("/events"))return Response.json({data:[{id:"m1",type:"agent.message",content:[{type:"text",text:"hello"}]}],next_page:null});
  expect(url.host).toBe("gateway");expect(new Headers(init?.headers).get("authorization")).toBe("Bearer oma_sbx_fixture");
  const text=JSON.stringify({result:"satisfied",explanation:"ok"});
  return Response.json(protocol==="gemini"?{candidates:[{content:{parts:[{text}]}}],usageMetadata:{promptTokenCount:7,candidatesTokenCount:2}}:protocol==="anthropic-messages"?{content:[{type:"text",text}],usage:{input_tokens:7,output_tokens:2}}:{output:[{content:[{type:"output_text",text}]}],usage:{input_tokens:7,output_tokens:2}});
 }});
 await complete({command:{sessionId:"s",turnId:"root",input:{eventId:"root",event:{},outcome}},signal:new AbortController().signal,flush:async()=>{},cancel:async()=>{},publishOutcomeEvents:async (batch:any[])=>{events.push(...batch);},runRevision:async()=>{throw Error("must not revise");}} as never);
 expect(events.at(-1)).toMatchObject({result:"satisfied",usage:{input_tokens:7,output_tokens:2}});
});
it("an already-cancelled outcome does not start model or fabricate evaluation events",async()=>{
 const controller=new AbortController();controller.abort();const events:any[]=[];
 const complete=module.createWorkOutcomeCompletion({sessionId:"s",apiBaseUrl:"https://control",sessionsToken:"work-token",channels:()=>channels,fetch:async()=>{throw Error("must not fetch");}});
 await complete({command:{sessionId:"s",turnId:"root",input:{eventId:"root",event:{},outcome}},signal:controller.signal,flush:async()=>{},cancel:async()=>{},publishOutcomeEvents:async (batch:any[])=>{events.push(...batch);},runRevision:async()=>{throw Error("must not revise");}} as never);
 expect(events).toEqual([]);
});
it("a real revision failure records linked failed verdict then propagates instead of claiming successful drain",async()=>{
 const events:any[]=[];
 const complete=module.createWorkOutcomeCompletion({sessionId:"s",apiBaseUrl:"https://control",sessionsToken:"work-token",channels:()=>channels,fetch:async(raw)=>String(raw).includes("/events")?Response.json({data:[{id:"m1",type:"agent.message",content:[{type:"text",text:"hello"}]}],next_page:null}):Response.json({choices:[{message:{content:JSON.stringify({result:"needs_revision",explanation:"fix it"})}}],usage:{prompt_tokens:1,completion_tokens:2}})});
 await expect(complete({command:{sessionId:"s",turnId:"root",input:{eventId:"root",event:{},outcome}},signal:new AbortController().signal,flush:async()=>{},cancel:async()=>{},publishOutcomeEvents:async (batch:any[])=>{events.push(...batch);},runRevision:async()=>{throw Error("native revision failed");}} as never)).rejects.toThrow("native revision failed");
 expect(events.at(-1)).toMatchObject({type:"span.outcome_evaluation_end",result:"failed",outcome_evaluation_start_id:events[0].id});
});
it("failure of canonical span publication prevents model execution",async()=>{
 let modelCalls=0;
 const complete=module.createWorkOutcomeCompletion({sessionId:"s",apiBaseUrl:"https://control",sessionsToken:"work-token",channels:()=>channels,fetch:async(raw)=>{if(String(raw).includes("/events"))return Response.json({data:[{id:"m1",type:"agent.message",content:[{type:"text",text:"hello"}]}],next_page:null});modelCalls++;throw Error("model should not run");}});
 await expect(complete({command:{sessionId:"s",turnId:"root",input:{eventId:"root",event:{},outcome}},signal:new AbortController().signal,flush:async()=>{},cancel:async()=>{},publishOutcomeEvents:async()=>{throw Error("claim lost");},runRevision:async()=>{throw Error("must not revise");}} as never)).rejects.toThrow("claim lost");
 expect(modelCalls).toBe(0);
});
it("budget denial is a failed evaluation without grader retry or native revision",async()=>{
 const events:any[]=[];let calls=0;
 const complete=module.createWorkOutcomeCompletion({sessionId:"s",apiBaseUrl:"https://control",sessionsToken:"work-token",channels:()=>channels,fetch:async(raw)=>{if(String(raw).includes("/events"))return Response.json({data:[{id:"m1",type:"agent.message",content:[{type:"text",text:"hello"}]}],next_page:null});calls++;return Response.json({error:"budget_reached"},{status:402});}});
 await complete({command:{sessionId:"s",turnId:"root",input:{eventId:"root",event:{},outcome}},signal:new AbortController().signal,flush:async()=>{},cancel:async()=>{},publishOutcomeEvents:async (batch:any[])=>{events.push(...batch);},runRevision:async()=>{throw Error("must not revise after budget denial");}} as never);
 expect(calls).toBe(1);expect(events.at(-1)).toMatchObject({result:"failed",explanation:expect.stringContaining("budget")});
},15000);
it("missing model capability fails once without dispatching a revision",async()=>{
 const events:any[]=[];
 const complete=module.createWorkOutcomeCompletion({sessionId:"s",apiBaseUrl:"https://control",sessionsToken:"work-token",channels:()=>undefined,fetch:async(raw)=>{expect(String(raw)).toContain("/events");return Response.json({data:[{id:"m1",type:"agent.message",content:[{type:"text",text:"hello"}]}],next_page:null});}});
 await complete({command:{sessionId:"s",turnId:"root",input:{eventId:"root",event:{},outcome}},signal:new AbortController().signal,flush:async()=>{},cancel:async()=>{},publishOutcomeEvents:async(batch:any[])=>{events.push(...batch);},runRevision:async()=>{throw Error("must not revise without channels");}} as never);
 expect(events.at(-1)).toMatchObject({result:"failed",explanation:expect.stringContaining("capability")});
},15000);
it("reads file rubric with scoped Work authorization and gives the shared grader actual file content",async()=>{
 const events:any[]=[];
 const complete=module.createWorkOutcomeCompletion({sessionId:"s",apiBaseUrl:"https://control",sessionsToken:"work-token",channels:()=>channels,fetch:async(raw,init)=>{
  const url=new URL(String(raw));
  if(url.pathname.includes("/events")) return Response.json({data:[{id:"m1",type:"agent.message",content:[{type:"text",text:"hello"}]}],next_page:null});
  if(url.pathname === "/v1/files/file_1/content"){expect(new Headers(init?.headers).get("authorization")).toBe("Bearer work-token");return new Response("file rubric criterion");}
  expect(JSON.parse(String(init?.body)).messages[1].content).toContain("file rubric criterion");
  return Response.json({choices:[{message:{content:JSON.stringify({result:"satisfied",explanation:"matches file"})}}],usage:{prompt_tokens:1,completion_tokens:2}});
 }});
 await complete({command:{sessionId:"s",turnId:"root",input:{eventId:"root",event:{},outcome:{...outcome,rubric:{type:"file",file_id:"file_1"}}}},signal:new AbortController().signal,flush:async()=>{},cancel:async()=>{},publishOutcomeEvents:async(batch:any[])=>{events.push(...batch);},runRevision:async()=>{throw Error("must not revise");}} as never);
 expect(events.at(-1).result).toBe("satisfied");
});
it("does not hide a missing durable outcome end receipt behind a terminal verdict",async()=>{
 let ends=0;
 const complete=module.createWorkOutcomeCompletion({sessionId:"s",apiBaseUrl:"https://control",sessionsToken:"work-token",channels:()=>channels,fetch:async(raw)=>String(raw).includes("/events")?Response.json({data:[{id:"m1",type:"agent.message",content:[{type:"text",text:"hello"}]}],next_page:null}):Response.json({choices:[{message:{content:'{"result":"satisfied","explanation":"ok"}'}}],usage:{prompt_tokens:1,completion_tokens:1}})});
 await expect(complete({command:{sessionId:"s",turnId:"root",input:{eventId:"root",event:{},outcome}},signal:new AbortController().signal,flush:async()=>{},cancel:async()=>{},publishOutcomeEvents:async(batch:any[])=>{if(batch[0].type==="span.outcome_evaluation_end"){ends++;throw Error("end receipt lost");}},runRevision:async()=>{throw Error("must not revise");}} as never)).rejects.toThrow("end receipt lost");
 expect(ends).toBe(1);
});
it("shared rule verifier executes a real workspace script without loading a model and revises until satisfied",async()=>{
 const {createWorkVerifierExec}=await import("../src/node-work-verifier.js");
 const {NodeSpawner}=await import("@open-managed-agents/acp-runtime/node-spawner");
 const {mkdtemp,writeFile,rm}=await import("node:fs/promises");const {tmpdir}=await import("node:os");const {join}=await import("node:path");
 const cwd=await mkdtemp(join(tmpdir(),"outcome-rule-"));const events:any[]=[];let revisions=0;
 try {
 const complete=module.createWorkOutcomeCompletion({sessionId:"s",apiBaseUrl:"https://control",sessionsToken:"work-token",channels:()=>undefined,runExec:createWorkVerifierExec(new NodeSpawner(),cwd),fetch:async(raw)=>{expect(String(raw)).toContain("/events");return Response.json({data:[{id:"m1",type:"agent.message",content:[{type:"text",text:"hello"}]}],next_page:null});}});
 await complete({command:{sessionId:"s",turnId:"root",input:{eventId:"root",event:{verifier:{type:"script",verify_script:"test -f proof",timeout_ms:1000}},outcome}},signal:new AbortController().signal,flush:async()=>{},cancel:async()=>{},publishOutcomeEvents:async(batch:any[])=>{events.push(...batch);},runRevision:async()=>{revisions++;await writeFile(join(cwd,"proof"),"done");}} as never);
 expect(revisions).toBe(1);expect(events.at(-1).result).toBe("satisfied");
 }finally{await rm(cwd,{recursive:true,force:true});}
});
it("runs composite script plus transcript scorer through the existing shared verifier",async()=>{
 const {createWorkVerifierExec}=await import("../src/node-work-verifier.js");const {NodeSpawner}=await import("@open-managed-agents/acp-runtime/node-spawner");const {tmpdir}=await import("node:os");
 const events:any[]=[];
 const complete=module.createWorkOutcomeCompletion({sessionId:"s",apiBaseUrl:"https://control",sessionsToken:"work-token",channels:()=>undefined,runExec:createWorkVerifierExec(new NodeSpawner(),tmpdir()),fetch:async(raw)=>{expect(String(raw)).toContain("/events");return Response.json({data:[{type:"agent.message",content:[{type:"text",text:"hello"}]}],next_page:null});}});
 await complete({command:{sessionId:"s",turnId:"root",input:{eventId:"root",event:{verifier:{type:"composite",components:[{name:"shell",weight:1,verifier:{type:"script",verify_script:"exit 0",timeout_ms:1000}},{name:"text",weight:1,verifier:{type:"verifiable",scorer:"agentMessageContains",opts:{substring:"hello"}}}]}},outcome}},signal:new AbortController().signal,flush:async()=>{},cancel:async()=>{},publishOutcomeEvents:async(batch:any[])=>{events.push(...batch);},runRevision:async()=>{throw Error("should pass");}} as never);
 expect(events.at(-1).result).toBe("satisfied");
});
it("rule script abort retains interrupted verdict instead of treating killed shell as revision feedback",async()=>{
 const {createWorkVerifierExec}=await import("../src/node-work-verifier.js");const {NodeSpawner}=await import("@open-managed-agents/acp-runtime/node-spawner");const {tmpdir}=await import("node:os");
 const events:any[]=[],controller=new AbortController();const exec=createWorkVerifierExec(new NodeSpawner(),tmpdir());
 const complete=module.createWorkOutcomeCompletion({sessionId:"s",apiBaseUrl:"https://control",sessionsToken:"work-token",channels:()=>undefined,runExec:(...args)=>{setTimeout(()=>controller.abort(),20);return exec(...args);},fetch:async()=>Response.json({data:[{id:"m1",type:"agent.message",content:[{type:"text",text:"hello"}]}],next_page:null})});
 await complete({command:{sessionId:"s",turnId:"root",input:{eventId:"root",event:{verifier:{type:"script",verify_script:"sleep 30",timeout_ms:1000}},outcome}},signal:controller.signal,flush:async()=>{},cancel:async()=>{},publishOutcomeEvents:async(batch:any[])=>{events.push(...batch);},runRevision:async()=>{throw Error("must not revise");}} as never);
 expect(events.at(-1).result).toBe("interrupted");
});
it("unconfirmed script exit cannot fall through to revision or successful finalization",async()=>{
 const {WorkVerifierExitUnconfirmedError}=await import("../src/node-work-verifier.js");const events:any[]=[];
 const complete=module.createWorkOutcomeCompletion({sessionId:"s",apiBaseUrl:"https://control",sessionsToken:"work-token",channels:()=>undefined,runExec:async()=>{throw new WorkVerifierExitUnconfirmedError("exit unconfirmed");},fetch:async()=>Response.json({data:[{id:"m1",type:"agent.message",content:[{type:"text",text:"hello"}]}],next_page:null})});
 await expect(complete({command:{sessionId:"s",turnId:"root",input:{eventId:"root",event:{verifier:{type:"script",verify_script:"check"}},outcome}},signal:new AbortController().signal,flush:async()=>{},cancel:async()=>{},publishOutcomeEvents:async(batch:any[])=>{events.push(...batch);},runRevision:async()=>{throw Error("must not revise");}} as never)).rejects.toBeInstanceOf(WorkVerifierExitUnconfirmedError);
 expect(events.at(-1).result).toBe("failed");
});
it("existing reward_model verifier uses its real HTTP implementation against a local peer",async()=>{
 const {createServer}=await import("node:http");const server=createServer(async(req,res)=>{let bytes="";for await(const chunk of req)bytes+=chunk;expect(JSON.parse(bytes).trajectory.schema_version).toBe("oma.trajectory.v1");res.setHeader("content-type","application/json");res.end(JSON.stringify({value:1,pass:true,reasoning:"local scorer passed"}));});
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const events:any[]=[];
 try {
 const complete=module.createWorkOutcomeCompletion({sessionId:"s",apiBaseUrl:"https://control",sessionsToken:"work-token",channels:()=>undefined,fetch:async()=>Response.json({data:[{id:"m1",type:"agent.message",content:[{type:"text",text:"hello"}]}],next_page:null})});
 await complete({command:{sessionId:"s",turnId:"root",input:{eventId:"root",event:{verifier:{type:"reward_model",endpoint:"http://127.0.0.1:"+(server.address() as {port:number}).port}},outcome}},signal:new AbortController().signal,flush:async()=>{},cancel:async()=>{},publishOutcomeEvents:async(batch:any[])=>{events.push(...batch);},runRevision:async()=>{throw Error("must not revise");}} as never);
 expect(events.at(-1)).toMatchObject({result:"satisfied",explanation:"local scorer passed"});
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
