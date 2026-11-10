import {expect,it} from "vitest";
import {withHostedInferenceBudget} from "../src/usage";
it("does not finish the model response until durable usage commit succeeds",async()=>{
 let release!:()=>void;let recorded=false;
 const pending=new Promise<void>(resolve=>{release=resolve});
 const response=await withHostedInferenceBudget({durable:true,begin:()=>true,complete:async()=>{await pending;recorded=true}},async()=>Response.json({usage:{input_tokens:10000}}));
 let finished=false;const read=response.text().then(()=>{finished=true});
 await Promise.resolve();await Promise.resolve();expect(finished).toBe(false);
 release();await read;expect(recorded).toBe(true);
});
it("propagates durable usage persistence failure to the response stream",async()=>{
 const response=await withHostedInferenceBudget({durable:true,begin:()=>true,complete:async()=>{throw new Error("usage persistence unavailable")}},async()=>Response.json({usage:{input_tokens:1}}));
 await expect(response.text()).rejects.toThrow("usage persistence unavailable");
});

it("merges split Anthropic SSE usage and refuses a successful unmetered response",async()=>{
 let usage:unknown;
 const chunks=['data: {"type":"message_start","message":{"usage":{"input_tokens":4}}}\n','data: {"type":"message_delta","usage":{"output_tokens":3}}\n'];
 const stream=new ReadableStream<Uint8Array>({start(c){for(const text of chunks)c.enqueue(new TextEncoder().encode(text));c.close()}});
 const response=await withHostedInferenceBudget({durable:true,begin:()=>true,complete:u=>{usage=u}},async()=>new Response(stream,{headers:{"content-type":"text/event-stream"}}));
 await response.text();expect(usage).toEqual({input_tokens:4,output_tokens:3});
 const missing=await withHostedInferenceBudget({durable:true,begin:()=>true,complete:()=>{}},async()=>Response.json({ok:true}));
 await expect(missing.text()).rejects.toThrow("no usage");
});
