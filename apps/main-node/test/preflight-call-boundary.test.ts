import { expect, it } from "vitest";
import { hasOpenExecutionCall } from "../../agent/src/runtime/turn-preflight";
it.each(["agent.tool_use", "agent.mcp_tool_use", "agent.custom_tool_use"])("does not terminal an open %s through preflight",type=>{
 const call={type,id:"call",session_thread_id:"sthr_primary"};
 expect(hasOpenExecutionCall([call],"sthr_primary")).toBe(true);
 expect(hasOpenExecutionCall([call,{type:"session.error"}],"sthr_primary")).toBe(true);
 const result=type==="agent.mcp_tool_use"?{type:"agent.mcp_tool_result",mcp_tool_use_id:"call"}:{type:"agent.tool_result",tool_use_id:"call"};
 expect(hasOpenExecutionCall([call,result],"sthr_primary")).toBe(false);
 expect(hasOpenExecutionCall([call],"other-thread")).toBe(false);
});
it("allows genuine preparation with no call and does not count a receipt as consumption",()=>{
 expect(hasOpenExecutionCall([{type:"user.message"}],"sthr_primary")).toBe(false);
 expect(hasOpenExecutionCall([{type:"agent.custom_tool_use",id:"call"},{type:"user.custom_tool_result"}],"sthr_primary")).toBe(true);
});
