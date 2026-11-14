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
it("merges only declared same-revision message batch, preserving root CAS and separating next batch",async()=>{
 const rows=[{id:"a",type:"user.message",content:[{type:"text",text:"A"}],processedAt:null,source_position:{revision:2,index:0,input_batch:{rootId:"a",ids:["a","follow"]}}},{id:"follow",type:"user.message",content:[{type:"text",text:"follow"}],processedAt:null,source_position:{revision:2,index:1,input_batch:{rootId:"a",ids:["a","follow"]}}},{id:"b",type:"user.message",content:[{type:"text",text:"B"}],processedAt:null,source_position:{revision:3,index:0}}];
 const reader=createWorkInputReader(createWorkInputsHttpClient({apiBaseUrl:"https://test",sessionId:"s",sessionsToken:"token",fetch:async()=>Response.json({type:"page",rows:rows.map(raw=>{const {source_position,...event}=raw;return {event,position:{revision:source_position.revision,index:source_position.index},document:JSON.stringify(raw)};}),cursor:"tail",hasMore:false})}));
 const page=await reader.read({cursor:null,limit:100,signal:new AbortController().signal});
 expect(page.events.map(event=>event.id)).toEqual(["a","b"]);expect(page.events[0]!.content).toEqual([{type:"text",text:"A\nfollow"}]);expect(reader.input(page.events[0]!).expectedDocument).toBe(JSON.stringify(rows[0]));
});
it("completes a batch crossing page boundary without merging another revision",async()=>{
 const raw=(id:string,index:number)=>({id,type:"user.message",processedAt:null,content:[{type:"text",text:id}],source_position:{revision:8,index,input_batch:{rootId:"a",ids:["a","b"]}}});
 const seen:unknown[]=[];let calls=0;
 const reader=createWorkInputReader(createWorkInputsHttpClient({apiBaseUrl:"https://test",sessionId:"s",sessionsToken:"token",fetch:async(_url,init)=>{
  seen.push(JSON.parse(String(init?.body)));const value=calls++===0?raw("a",0):raw("b",1);const {source_position,...event}=value;
  return Response.json({type:"page",rows:[{event,position:{revision:8,index:source_position.index},document:JSON.stringify(value)}],cursor:calls===1?"a-tail":"b-tail",hasMore:calls===1});
 }}));
 const result=await reader.read({cursor:"before-a",limit:1,signal:new AbortController().signal});
 expect(result.events).toHaveLength(1);expect(result.events[0]!.content).toEqual([{type:"text",text:"a\nb"}]);expect(result.cursor).toBe("b-tail");
 expect(seen).toEqual([{cursor:"before-a",limit:1},{cursor:"a-tail",limit:1}]);
});
it("rejects page membership that claims a message from another accepted revision",async()=>{
 const rows=[{id:"a",type:"user.message",processedAt:null,content:[],source_position:{revision:1,index:0,input_batch:{rootId:"a",ids:["a","b"]}}},{id:"b",type:"user.message",processedAt:null,content:[],source_position:{revision:2,index:0,input_batch:{rootId:"a",ids:["a","b"]}}}];
 const reader=createWorkInputReader(createWorkInputsHttpClient({apiBaseUrl:"https://test",sessionId:"s",sessionsToken:"token",fetch:async()=>Response.json({type:"page",rows:rows.map(value=>{const {source_position,...event}=value;return {event,position:{revision:source_position.revision,index:source_position.index},document:JSON.stringify(value)};}),cursor:"tail",hasMore:false})}));
 await expect(reader.read({cursor:null,limit:100,signal:new AbortController().signal})).rejects.toThrow("Invalid canonical input batch");
});

it("keeps file references wire-compatible when batching image messages", async () => {
 const rows = ["a", "b"].map((id,index) => ({id,type:"user.message",processedAt:null,content:[{type:"image",source:{type:"file",fileId:id}}],source_position:{revision:2,index,input_batch:{rootId:"a",ids:["a","b"]}}}));
 const reader = createWorkInputReader(createWorkInputsHttpClient({apiBaseUrl:"https://test",sessionId:"s",sessionsToken:"token",fetch:async()=>Response.json({type:"page",rows:rows.map(raw=>{const {source_position,...event}=raw;return {event,document:JSON.stringify(raw),position:{revision:2,index:source_position.index}};}),cursor:"tail",hasMore:false})}));
 const result = await reader.read({cursor:null,limit:100,signal:new AbortController().signal});
 expect(result.events[0]!.content).toEqual([{type:"image",source:{type:"file",file_id:"a"}},{type:"text",text:"\n"},{type:"image",source:{type:"file",file_id:"b"}}]);
});

it.each(["processed", "queued", "cancelled", "deferred", "missing", "duplicate"])("refuses inconsistent batch %s before dispatch", async mode => {
 const rows = ["a", "b"].map((id,index) => ({id,type:"user.message",processedAt:null as string|null,content:[],source_position:{revision:2,index,input_batch:{rootId:"a",ids:["a","b"]}}}));
 if(mode === "processed") rows[1]!.processedAt = "2026-11-11T00:00:00Z";
 if(mode === "queued") Object.assign(rows[1]!,{_queued:true});
 if(mode === "cancelled") Object.assign(rows[1]!,{cancelled_at_ms:1});
 if(mode === "deferred") Object.assign(rows[1]!,{deferredUntilToolResults:["tool"]});
 if(mode === "missing") for(const row of rows) row.source_position.input_batch={rootId:"a",ids:["a","b","missing"]};
 if(mode === "duplicate") for(const row of rows) row.source_position.input_batch={rootId:"a",ids:["a","b","b"]};
 const reader = createWorkInputReader(createWorkInputsHttpClient({apiBaseUrl:"https://test",sessionId:"s",sessionsToken:"token",fetch:async()=>Response.json({type:"page",rows:rows.map(raw=>{const {source_position,...event}=raw;return {event,document:JSON.stringify(raw),position:{revision:2,index:source_position.index}};}),cursor:"tail",hasMore:false})}));
 await expect(reader.read({cursor:null,limit:100,signal:new AbortController().signal})).rejects.toThrow(/canonical.*batch/i);
});

it("completes a same-lane batch across an interleaved lane without losing its bounded readback location", async () => {
 const batch={rootId:"a",ids:["a","b"]};
 const rows=[{id:"a",sessionThreadId:"sthr_primary",source_position:{revision:2,index:0,input_batch:batch}}, {id:"child",sessionThreadId:"child-lane",source_position:{revision:2,index:1}}, {id:"b",sessionThreadId:"sthr_primary",source_position:{revision:2,index:2,input_batch:batch}}].map(value=>({...value,type:"user.message",processedAt:null,content:[{type:"text",text:value.id}]}));
 const reads:Array<{cursor:string|null;limit:number}>=[];
 const reader=createWorkInputReader(createWorkInputsHttpClient({apiBaseUrl:"https://test",sessionId:"s",sessionsToken:"token",fetch:async(_url,init)=>{
  const request=JSON.parse(String(init?.body));reads.push(request);
  const start=request.cursor===null?0:Number(request.cursor);
  const slice=rows.slice(start,start+request.limit);
  return Response.json({type:"page",rows:slice.map(raw=>{const {source_position,...event}=raw;return {event,position:{revision:2,index:source_position.index},document:JSON.stringify(raw)};}),cursor:String(start+slice.length),hasMore:start+slice.length<rows.length});
 }}));
 const page=await reader.read({cursor:null,limit:1,signal:new AbortController().signal});
 expect(page.events.map(event=>event.id)).toEqual(["a","child"]);
 expect(page.events[0]!.content).toEqual([{type:"text",text:"a\nb"}]);
 await expect(reader.consumedRoot(page.events[1]!,new AbortController().signal)).rejects.toThrow("Consumed Work root is unavailable");
 expect(reads.at(-1)).toEqual({cursor:"1",limit:1});
});
