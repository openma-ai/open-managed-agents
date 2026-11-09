import { expect, it } from "vitest";
import { executionContinuationEvents } from "../src/execution-continuation";
it("closes only unfinished tools and visibly resumes once per attempt", () => {
  const history = [{ id: "done", type: "agent.tool_use" }, { type: "agent.tool_result", tool_use_id: "done" }, { id: "lost", type: "agent.tool_use" }];
  const events = executionContinuationEvents(history, { executionId: "e", attempt: 2, laneId: "sthr_primary" });
  expect(events).toMatchObject([
    { id: "resume:e:lost", type: "agent.tool_result", tool_use_id: "lost", is_error: true, content: "interrupted: the execution was lost before this tool finished; it was not re-run automatically" },
    { id: "resume:e:2", type: "session.warning", source: "execution_resumed", details: { attempt: 2, reason: "lease_lost" } },
  ]);
  expect(executionContinuationEvents([...history, ...events], { executionId: "e", attempt: 2, laneId: "sthr_primary" })).toEqual([]);
});
