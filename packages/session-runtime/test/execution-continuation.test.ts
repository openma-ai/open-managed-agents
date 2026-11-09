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
it("closes only unfinished tools and visibly resumes once per attempt", () => {
  const history = [{ id: "done", type: "agent.tool_use" }, { type: "agent.tool_result", tool_use_id: "done" }, { id: "lost", type: "agent.tool_use" }];
  const events = executionContinuationEvents(history, { executionId: "e", attempt: 2, laneId: "sthr_primary" });
  expect(events).toMatchObject([
    { id: "resume:e:lost", type: "agent.tool_result", tool_use_id: "lost", is_error: true, content: "interrupted: the execution was lost before this tool finished; it was not re-run automatically" },
    { id: "resume:e:2", type: "session.warning", source: "execution_resumed", details: { attempt: 2, reason: "lease_lost" } },
  ]);
  expect(executionContinuationEvents([...history, ...events], { executionId: "e", attempt: 2, laneId: "sthr_primary" })).toEqual([]);
});
