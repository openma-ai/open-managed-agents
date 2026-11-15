import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { CustomToolResults } from "./CustomToolResults";
import { pendingCustomResults } from "../../lib/pending-custom-results";
import { ingestManagedWireEvent } from "../../lib/managed-event-bridge";
import { upsertSessionEvent } from "../../lib/session-event-upsert";

it("makes complete custom calls actionable while running and rebuilds after reconnect without reviving answered calls", async () => {
  const call = { type: "agent.custom_tool_use", id: "call", name: "approve", input: { ticket: 1 }, processed_at: "2026-11-12T00:00:00Z" };
  let events: any[] = [];
  const ingest = (wire: any) => {
    const event = ingestManagedWireEvent(wire, { sessionId: "session" });
    if (event) events = upsertSessionEvent(events, event as any).events;
  };
  ingest({ type: "session.status_running", id: "running" });
  ingest(call);
  const submit = vi.fn(async () => {});
  const view = render(<CustomToolResults actions={pendingCustomResults(events, "sthr_primary")} onSubmit={submit} />);
  expect(screen.getByText("Result requested: approve")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Result for approve"), { target: { value: "accepted" } });
  fireEvent.click(screen.getByText("Submit result"));
  await waitFor(() => expect(submit).toHaveBeenCalledWith("call", "accepted"));
  // Reconnect opens stream first; an answer may precede history's old call.
  events = [];
  ingest({ type: "user.custom_tool_result", id: "answer", custom_tool_use_id: "call", content: [{ type: "text", text: "accepted" }], processed_at: "2026-11-12T00:00:01Z" });
  ingest(call); ingest(call);
  ingest({ type: "session.status_idle", id: "idle", stop_reason: { type: "requires_action", event_ids: ["call"] } });
  view.rerender(<CustomToolResults actions={pendingCustomResults(events, "sthr_primary")} onSubmit={submit} />);
  expect(screen.queryByText("Submit result")).toBeNull();
  expect(events.filter(event => event.id === "call")).toHaveLength(1);
});

it("never offers deltas, incomplete inputs, or another thread's call", () => {
  expect(pendingCustomResults([
    { type: "agent.custom_tool_use.delta", id: "preview", name: "approve", input: {} },
    { type: "agent.custom_tool_use", id: "incomplete", name: "approve" },
    { type: "agent.custom_tool_use", id: "other", name: "approve", input: {}, session_thread_id: "child" },
  ] as any, "sthr_primary")).toEqual([]);
});

it("does not revive an unanswered obsolete call after a terminal event arrives before history", () => {
  const wire = [
    { type: "session.status_idle", id: "end", stop_reason: { type: "interrupted" }, processed_at: "2026-11-12T00:00:02Z" },
    { type: "agent.custom_tool_use", id: "old", name: "approve", input: {}, processed_at: "2026-11-12T00:00:01Z" },
  ];
  const events = wire.map(event => ingestManagedWireEvent(event, { sessionId: "s" })!).filter(Boolean);
  expect(pendingCustomResults(events as any, "sthr_primary")).toEqual([]);
});
