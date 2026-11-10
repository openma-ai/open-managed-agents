import { expect, it } from "vitest";
import { createWorkInputReader } from "../src/work-input-adapter";
import { createWorkInputsHttpClient } from "../src/work-inputs-http";

it("maps canonical camelCase without losing raw CAS, consumption identity or resume", async () => {
 const raw = {id:"resume",type:"session.updated",processedAt:"2026-11-10T00:00:00Z",resume:true,toolUseId:"tool",sessionThreadId:"primary",source_position:{revision:3,index:0,execution_id:"execution",consumed_by_execution_id:"execution"}};
 const document=JSON.stringify(raw);
 const {source_position,...event}=raw;
 const client=createWorkInputsHttpClient({apiBaseUrl:"https://test",sessionId:"s",sessionsToken:"token",fetch:async()=>Response.json({type:"page",rows:[{event,document,position:{revision:3,index:0}}],cursor:"tail",hasMore:false})});
 const reader=createWorkInputReader(client);
 const page=await reader.read({cursor:null,limit:100,signal:new AbortController().signal});
 expect(page.events[0]).toMatchObject({processed_at:"2026-11-10T00:00:00Z",resume:true,tool_use_id:"tool",session_thread_id:"primary",source_position});
 expect(reader.input(page.events[0]!)).toEqual({inputId:"resume",turnId:"execution",expectedDocument:document});
});
it("never manufactures a processed timestamp for queued inputs",async()=>{
 const raw={id:"queued",type:"user.message",processedAt:null,content:[{type:"image",source:{type:"file",fileId:"file"}}],source_position:{revision:1,index:0}};
 const {source_position,...event}=raw;
 const reader=createWorkInputReader(createWorkInputsHttpClient({apiBaseUrl:"https://test",sessionId:"s",sessionsToken:"token",fetch:async()=>Response.json({type:"page",rows:[{event,document:JSON.stringify(raw),position:source_position}],cursor:"tail",hasMore:false})}));
 const page=await reader.read({cursor:null,limit:100,signal:new AbortController().signal});
 expect(page.events[0]).toMatchObject({processed_at:null,content:[{source:{file_id:"file"}}]});
 expect(()=>reader.input({...page.events[0]!})).toThrow();
});

it("re-reads only the original bounded page to obtain exact server-stamped root bytes",async()=>{
 const original={id:"root",type:"user.message",processedAt:null,content:[],source_position:{revision:8,index:1,execution_id:"dispatch"}};
 const consumed=JSON.stringify({...original,processedAt:"2026-11-10T00:00:00Z",source_position:{...original.source_position,consumed_by_execution_id:"dispatch",consumption_claim:{workId:"work",generation:2,holder:"worker"}}},null,2);
 const calls:unknown[]=[];let read=0;
 const client=createWorkInputsHttpClient({apiBaseUrl:"https://test",sessionId:"s",sessionsToken:"token",fetch:async(_url,init)=>{
  calls.push(JSON.parse(String(init?.body)));const document=read++===0?JSON.stringify(original):consumed;
  const {source_position,...event}=JSON.parse(document);
  return Response.json({type:"page",rows:[{event,position:{revision:8,index:1},document}],cursor:"after-root",hasMore:false});
 }});
 const reader=createWorkInputReader(client);const page=await reader.read({cursor:"before-root",limit:100,signal:new AbortController().signal});
 expect(await reader.consumedRoot(page.events[0]!,new AbortController().signal)).toEqual({inputId:"root",turnId:"dispatch",expectedDocument:consumed});
 expect(calls).toEqual([{cursor:"before-root",limit:100},{cursor:"before-root",limit:1}]);
});
it("refuses an unconsumed readback instead of treating it as post-consumption root evidence",async()=>{
 const raw={id:"root",type:"user.message",processedAt:null,source_position:{revision:1,index:0}};
 const {source_position,...event}=raw;
 const reader=createWorkInputReader(createWorkInputsHttpClient({apiBaseUrl:"https://test",sessionId:"s",sessionsToken:"token",fetch:async()=>Response.json({type:"page",rows:[{event,position:source_position,document:JSON.stringify(raw)}],cursor:"tail",hasMore:false})}));
 const page=await reader.read({cursor:null,limit:1,signal:new AbortController().signal});
 await expect(reader.consumedRoot(page.events[0]!,new AbortController().signal)).rejects.toThrow("Consumed Work root is unavailable");
});
it.each([false,true])("continuation rereads canonical consumer proof without another consume (tampered=%s)",async tampered=>{
 const original={id:"steer",type:"user.message",content:[],processedAt:null,source_position:{revision:2,index:0,execution_id:"steer-dispatch"}};
 const claim={workId:"work",generation:2,holder:"holder"};let reads=0;
 const reader=createWorkInputReader(createWorkInputsHttpClient({apiBaseUrl:"https://test",sessionId:"s",sessionsToken:"token",fetch:async(url)=>{
  expect(String(url)).toContain("inputs-read");
  const raw=reads++===0?original:{...original,processedAt:"2026-11-10T00:00:00Z",source_position:{...original.source_position,consumed_by_execution_id:tampered?"other":"root",consumption_claim:claim}};
  const {source_position,...event}=raw;
  return Response.json({type:"page",rows:[{event,position:{revision:2,index:0},document:JSON.stringify(raw)}],cursor:"tail",hasMore:false});
 }}));
 const event=(await reader.read({cursor:null,limit:1,signal:new AbortController().signal})).events[0]!;
 const check=reader.verifyConsumption(event,{turnId:"root",expectedDocument:JSON.stringify({source_position:{consumption_claim:claim}})},new AbortController().signal);
 if(tampered)await expect(check).rejects.toThrow("consumption changed");else await expect(check).resolves.toBeUndefined();
 expect(reads).toBe(2);
});
