import { describe, expect, it } from "vitest";
import { planRequiresActionQueue } from "../../../packages/control-plane-node/src/lib/node-managed-session-runtime.js";

// Official CMA (managed-agents-events.md § Interrupt): "Against an
// already-idle session an interrupt is normally a no-op", and while
// requires_action "only settle events are accepted - a user.message there is
// a 400". So [user.interrupt, user.message] while parked is rejected whole.
describe("Node settle-only gate: interrupt + message batch", () => {
  const parked = [
    { id: "c1", type: "agent.custom_tool_use", name: "run", input: {} },
    { id: "idle", type: "session.status_idle", stopReason: { type: "requires_action", eventIds: ["c1"] } },
  ];
  it("rejects [user.interrupt, user.message] during requires_action", () => {
    const plan = planRequiresActionQueue(parked as never, [
      { id: "b1", type: "user.interrupt" },
      { id: "b2", type: "user.message", content: [{ type: "text", text: "next" }] },
    ] as never);
    expect(plan.reject).toContain("requires_action");
  });
  it("still accepts a lone user.interrupt during requires_action", () => {
    const plan = planRequiresActionQueue(parked as never, [{ id: "b1", type: "user.interrupt" }] as never);
    expect(plan.reject).toBeUndefined();
  });
});

import { interruptRequiresActionClosure } from "@open-managed-agents/agent-harness";

describe("Node/CF shared: interruptRequiresActionClosure", () => {
  it("does not clear requires_action (official CMA idle no-op)", () => {
    expect(interruptRequiresActionClosure([
      { type: "agent.custom_tool_use", id: "c1", name: "x", input: {} },
      { type: "session.status_idle", stop_reason: { type: "requires_action", event_ids: ["c1"] } },
    ] as never)).toEqual([]);
  });
});
