import { expect,it } from "vitest";
import { createWorkOutputAdapter } from "../src/work-output-adapter";
it("holds ordinary tool publication until permission identity is known and remaps only its actual result",async()=>{
 const batches:unknown[]=[];let canonical:string|undefined;
 const output=createWorkOutputAdapter({publish:async events=>{batches.push(events);},toolUseIdFor:()=>canonical});
 const tool={id:"native",type:"agent.tool_use",processed_at:"now",name:"Read",input:{}};
 await output.projected([tool]);expect(batches).toEqual([]);
 canonical="ask";await output.canonical([{...tool,id:"ask",evaluated_permission:"ask"}]);
 await output.projected([{id:"result",type:"agent.tool_result",processed_at:"later",tool_use_id:"native"}]);
 expect(batches).toEqual([[{...tool,id:"ask",evaluated_permission:"ask"}],[{id:"result",type:"agent.tool_result",processed_at:"later",tool_use_id:"ask"}]]);
});
it("does not swallow failed publication or retry an unknown batch",async()=>{
 let count=0;const output=createWorkOutputAdapter({publish:async()=>{count++;throw new Error("unavailable");},toolUseIdFor:()=>undefined});
 await expect(output.canonical([{id:"x",type:"session.status_running",processed_at:"now"}])).rejects.toThrow();
 await expect(output.canonical([{id:"y",type:"session.status_running",processed_at:"now"}])).rejects.toThrow();expect(count).toBe(1);
});
it("flushes an ordinary tool before its terminal and preserves child lane identities",async()=>{
 const batches:unknown[]=[];const output=createWorkOutputAdapter({publish:async events=>{batches.push(events);},toolUseIdFor:()=>undefined});
 await output.projected([{id:"native",type:"agent.tool_use",processed_at:"now"}]);
 await output.projected([{id:"child",type:"agent.tool_use",processed_at:"now",session_thread_id:"child-lane"}]);
 await output.projected([{id:"idle",type:"session.status_idle",processed_at:"now",stop_reason:{type:"end_turn"}}],true);
 expect(batches).toEqual([[{id:"child",type:"agent.tool_use",processed_at:"now",session_thread_id:"child-lane"}],[{id:"native",type:"agent.tool_use",processed_at:"now"},{id:"idle",type:"session.status_idle",processed_at:"now",stop_reason:{type:"end_turn"}}]]);
});
