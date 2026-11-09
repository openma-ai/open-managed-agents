import { expect, it } from "vitest";
import { executionContinuationEvents } from "../src/execution-continuation";
it("ignores queued and cancelled calls and results before pairing unfinished tools", () => {
  const history = [
    { id: "queued", type: "agent.tool_use", _queued: true },
    { id: "cancelled", type: "agent.tool_use", cancelled_at_ms: 1 },
    { id: "live", type: "agent.tool_use" },
    { type: "agent.tool_result", tool_use_id: "live", _queued: true },
  ];
  expect(executionContinuationEvents(history, { executionId: "e", attempt: 2, laneId: "sthr_primary" }).map(e => e.id))
    .toEqual(["resume:e:live", "resume:e:2"]);
});
it("never interrupts tools owned by another lane", () => {
  const history = [
    { id: "primary", type: "agent.tool_use" },
    { id: "other", type: "agent.mcp_tool_use", session_thread_id: "sthr_other" },
    { id: "mine", type: "agent.tool_use", session_thread_id: "sthr_mine" },
  ];
  const events = executionContinuationEvents(history, { executionId: "e", attempt: 2, laneId: "sthr_mine" });
  expect(events.map(event => event.id)).toEqual(["resume:e:mine", "resume:e:2"]);
  const primary = executionContinuationEvents(history, { executionId: "p", attempt: 2, laneId: "sthr_primary" });
  expect(primary.map(event => event.id)).toEqual(["resume:p:primary", "resume:p:2"]);
});
it("parks an interrupted dispatched tool on a new frozen retry request instead of reusing its closed id", () => {
  const history=[{id:"effect",type:"agent.tool_use",name:"bash",input:{command:"external-effect"}}];
  const resumed=executionContinuationEvents(history,{executionId:"e",attempt:2,laneId:"sthr_primary"});
  expect(resumed).toContainEqual(expect.objectContaining({id:"retry:effect",type:"agent.tool_use",name:"bash",input:{command:"external-effect"},evaluated_permission:"ask"}));
  expect(resumed).toContainEqual(expect.objectContaining({type:"session.warning",source:"tool_outcome_unknown",details:{outcome:"dispatched_unknown",tool_use_id:"effect",retry_request_id:"retry:effect"}}));
  expect(executionContinuationEvents([...history,...resumed],{executionId:"e",attempt:3,laneId:"sthr_primary"})).not.toContainEqual(expect.objectContaining({tool_use_id:"retry:effect"}));
});

it("parks a new retry after an authorized retry loses its terminal result", () => {
  const history=[{id:"effect",type:"agent.tool_use",name:"bash",input:{command:"external-effect"}}];
  const resumed=executionContinuationEvents(history,{executionId:"e",attempt:2,laneId:"sthr_primary"});
  const confirmed=[...history,...resumed,{type:"user.tool_confirmation",tool_use_id:"retry:effect",result:"allow"}];
  const second=executionContinuationEvents(confirmed,{executionId:"e",attempt:3,laneId:"sthr_primary"});
  expect(second).toContainEqual(expect.objectContaining({type:"agent.tool_result",tool_use_id:"retry:effect",is_error:true}));
  expect(second).toContainEqual(expect.objectContaining({id:"retry:retry:effect",type:"agent.tool_use",input:{command:"external-effect"}}));
});
it("repairs a crash between the unknown warning and its retry request", () => {
  const history=[{id:"effect",type:"agent.tool_use",name:"bash",input:{command:"external-effect"}}];
  const resumed=executionContinuationEvents(history,{executionId:"e",attempt:2,laneId:"sthr_primary"});
  const partial=[...history,...resumed.filter(e=>e.id!=="retry:effect")];
  const repaired=executionContinuationEvents(partial,{executionId:"e",attempt:3,laneId:"sthr_primary"});
  expect(repaired).toContainEqual(expect.objectContaining({id:"retry:effect",type:"agent.tool_use",input:{command:"external-effect"}}));
});
it("never creates a retry after an authorized call was interrupted by the user", () => {
  const history=[{id:"effect",type:"agent.tool_use",name:"bash",input:{command:"external-effect"}}];
  const resumed=executionContinuationEvents(history,{executionId:"e",attempt:2,laneId:"sthr_primary"});
  const stopped=[...history,...resumed,{type:"user.tool_confirmation",tool_use_id:"retry:effect",result:"allow"},{type:"user.interrupt"}];
  const next=executionContinuationEvents(stopped,{executionId:"e",attempt:3,laneId:"sthr_primary"});
  expect(next.some(event=>event.type==="agent.tool_use")).toBe(false);
});
it("closes only unfinished tools and visibly resumes once per attempt", () => {
  const history = [{ id: "done", type: "agent.tool_use" }, { type: "agent.tool_result", tool_use_id: "done" }, { id: "lost", type: "agent.tool_use" }];
  const events = executionContinuationEvents(history, { executionId: "e", attempt: 2, laneId: "sthr_primary" });
  expect(events).toMatchObject([
    { id: "resume:e:lost", type: "agent.tool_result", tool_use_id: "lost", is_error: true, content: "interrupted: the execution was lost before this tool finished; it was not re-run automatically" },
    { id: "resume:e:2", type: "session.warning", source: "execution_resumed", details: { attempt: 2, reason: "lease_lost" } },
  ]);
  expect(executionContinuationEvents([...history, ...events], { executionId: "e", attempt: 2, laneId: "sthr_primary" })).toEqual([]);
});
