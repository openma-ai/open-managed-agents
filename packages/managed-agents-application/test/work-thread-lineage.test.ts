import {expect,it} from "vitest";
import {validateWorkThreadLineage} from "../src/session-execution/work-thread-lineage";
import type {RuntimeProducedSessionEvent as Event} from "../src/session-execution/port";
const tool:Event={id:"spawn",type:"agent.tool_use",name:"Agent",input:{},processedAt:"now"};
const child:Event={id:"created",type:"session.thread_created",sessionThreadId:"child",parentToolUseId:"spawn",agentName:"Agent",processedAt:"now"};
const done:Event={id:"child-done",type:"session.thread_status_idle",sessionThreadId:"child",agentName:"Agent",stopReason:{type:"end_turn"},processedAt:"now"};
it("requires ordered canonical parent tool then child creation before child facts",()=>{
 expect(validateWorkThreadLineage({rootLane:"sthr_primary",history:[],events:[tool,child,done]})).toBe(true);
 for(const events of [[child,tool,done],[tool,done],[done],[tool,{...child,parentToolUseId:"foreign"},done]])expect(validateWorkThreadLineage({rootLane:"sthr_primary",history:[],events})).toBe(false);
});
it("rejects root reuse, unknown parent, cross-lane tool borrowing and lineage reparenting",()=>{
 for(const event of [{...child,sessionThreadId:"sthr_primary"},{...child,parentThreadId:"unknown"},{...child,parentThreadId:"child"}])expect(validateWorkThreadLineage({rootLane:"sthr_primary",history:[tool],events:[event]})).toBe(false);
 expect(validateWorkThreadLineage({rootLane:"sthr_primary",history:[tool,child],events:[{...child,id:"rebind",parentToolUseId:"other"}]})).toBe(false);
 expect(validateWorkThreadLineage({rootLane:"sthr_primary",history:[tool,child],events:[{...tool,id:"nested",sessionThreadId:"child"},{...child,id:"grand",sessionThreadId:"grandchild",parentToolUseId:"nested"}]})).toBe(false);
});
it("accepts nested parent/tool chain but rejects reopening a terminated child",()=>{
 const nested:Event={...tool,id:"nested",sessionThreadId:"child"};
 const grand:Event={...child,id:"grand",sessionThreadId:"grandchild",parentThreadId:"child",parentToolUseId:"nested"};
 expect(validateWorkThreadLineage({rootLane:"sthr_primary",history:[tool,child],events:[nested,grand,{...done,sessionThreadId:"grandchild"}]})).toBe(true);
 expect(validateWorkThreadLineage({rootLane:"sthr_primary",history:[tool,child,{id:"closed",type:"session.thread_status_terminated",sessionThreadId:"child",agentName:"Agent",processedAt:"now"}],events:[done]})).toBe(false);
});
it("does not reinterpret root as a child or keep descendants writable after parent termination",()=>{
 expect(validateWorkThreadLineage({rootLane:"sthr_primary",history:[],events:[{...done,sessionThreadId:"sthr_primary"}]})).toBe(false);
 const nested:Event={...tool,id:"nested",sessionThreadId:"child"};
 const grand:Event={...child,id:"grand",sessionThreadId:"grandchild",parentThreadId:"child",parentToolUseId:"nested"};
 expect(validateWorkThreadLineage({rootLane:"sthr_primary",history:[tool,child,nested,grand,{id:"closed",type:"session.thread_status_terminated",sessionThreadId:"child",agentName:"Agent",processedAt:"now"}],events:[{...done,sessionThreadId:"grandchild"}]})).toBe(false);
});
