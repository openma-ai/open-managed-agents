import { decodeSessionEventDocument } from "@open-managed-agents/session-runtime-contract/history";
import { expect, it } from "vitest";
import { inspectCanonicalWorkTurn, type CanonicalWorkTurnRow } from "../src/work-finalization/turn-plan";

function row(id: string, revision: number, consumer?: string, type = "user.message"): CanonicalWorkTurnRow {
  const event = type === "session.status_idle"
    ? { id, type: "session.status_idle" as const, processedAt: "2026-11-10T00:00:00.000Z", stopReason: { type: "end_turn" as const } }
    : { id, type: "user.message" as const, content: [], processedAt: consumer ? "2026-11-10T00:00:00.000Z" : null };
  const document = JSON.stringify({...event,source_position:{revision,index:0,
    ...(consumer ? {consumed_by_execution_id:consumer}:{}),
    ...(type === "session.status_idle" ? {execution_id:"root",environment_work:{workId:"work",generation:1}}:{})}});
  return { document, decoded: {
    event, position: { revision, index: 0 },
    ...(consumer ? { consumedByExecutionId: consumer } : {}),
    ...(type === "session.status_idle" ? { executionId: "root", environmentWork: { workId: "work", generation: 1 } } : {}),
  } };
}
const inspect = (rows: CanonicalWorkTurnRow[], turnId = "root") => inspectCanonicalWorkTurn({ rows, revision: 30, turnId, sessionId: "session", workId: "work", generation: 2 });

it("keeps input identity separate from the canonical consuming turn", () => {
  const result = inspect([row("answer", 3, "root"), row("root", 2, "root")]);
  expect(result.type).toBe("turn");
  if (result.type !== "turn") throw new Error("missing turn");
  expect(result.source.decoded.event.id).toBe("root");
  expect(result.consumed).toBe(true);
  expect(result.terminal).toBeNull();
});
it("does not infer absorbed ownership from processing timestamps", () => {
  expect(inspect([row("root", 2, "root"), row("answer", 3, "answer")])).toMatchObject({ type: "turn", successors: [{ inputId: "answer", consumption: "other-turn" }] });
});
it("reports pending successor evidence without conflating it with root identity", () => {
  expect(inspect([row("root", 2, "root"), row("next", 3)])).toMatchObject({ type: "turn", successors: [{ inputId: "next", consumption: "pending" }] });
});
it("returns the immutable source-generation receipt, not the cleanup generation", () => {
  expect(inspect([row("root", 2, "root"), row("idle", 4, undefined, "session.status_idle")])).toMatchObject({
    type: "turn", terminal: { eventId: "idle", turnId: "root", workId: "work", generation: 1, revision: 4 },
  });
});
it("does not accept another turn's consumption as authority", () => {
  expect(inspect([row("root", 2, "other")])).toEqual({ type: "rejected", reason: "canonical_consumption" });
});
it("fails closed on duplicate positions", () => {
  expect(inspect([row("root", 2, "root"), row("duplicate", 2)])).toEqual({ type: "gap", reason: "canonical_position_collision" });
});
it("rejects a terminal followed by a fact owned by the same turn", () => {
  const later = row("later", 5, "root");
  expect(inspect([row("root", 2, "root"), row("idle", 4, undefined, "session.status_idle"), later])).toEqual({ type: "gap", reason: "terminal_not_last_turn_fact" });
});
it("does not mutate the caller's snapshot ordering", () => {
  const rows = [row("idle", 4, undefined, "session.status_idle"), row("root", 2, "root")];
  inspect(rows);
  expect(rows.map(item => item.decoded.event.id)).toEqual(["idle", "root"]);
});

it("represents a completed root and a pending successor independently", () => {
  const result = inspectCanonicalWorkTurn({
    rows: [row("root", 2, "root"), row("idle", 4, undefined, "session.status_idle"), row("next", 5)],
    revision: 9, sessionId: "session", turnId: "root", workId: "work", generation: 2,
  });
  expect(result).toMatchObject({ type: "turn", terminal: { turnId: "root" }, successors: [
    { inputId: "next", dispatchId: "next", consumption: "pending" },
  ] });
});
it("does not hide a successor that was consumed by a different turn", () => {
  const result = inspectCanonicalWorkTurn({
    rows: [row("root", 2, "root"), row("next", 5, "next")],
    revision: 9, sessionId: "session", turnId: "root", workId: "work", generation: 2,
  });
  expect(result).toMatchObject({ type: "turn", successors: [
    { inputId: "next", dispatchId: "next", consumption: "other-turn", consumingTurnId: "next" },
  ] });
});
it("does not classify an absorbed input as a successor execution", () => {
  expect(inspect([row("root", 2, "root"), row("answer", 3, "root")])).toMatchObject({ type: "turn", successors: [] });
});

function pause(id: string, revision: number): CanonicalWorkTurnRow {
  const value = row(id, revision, undefined, "session.status_idle");
  value.decoded.event = { id, type: "session.status_idle", processedAt: "2026-11-10T00:00:00.000Z", stopReason: { type: "requires_action", eventIds: ["tool"] } };
  return value;
}
function running(id: string, revision: number): CanonicalWorkTurnRow {
  const value = row(id, revision, undefined, "session.status_idle");
  value.decoded.event = { id, type: "session.status_running", processedAt: "2026-11-10T00:00:00.000Z" };
  return value;
}
function approvalHistory(repeat = false): CanonicalWorkTurnRow[] {
  const claim = {workId:"work",generation:1,holder:"owner"};
  const make = (event: Record<string, unknown>, revision: number, source: Record<string, unknown>) => {
    const document = JSON.stringify({...event, source_position:{revision,index:0,...source}});
    return {document, decoded: decodeSessionEventDocument(document)};
  };
  const root = make({id:"root",type:"user.message",content:[],processedAt:"2026-11-10T00:00:00Z"},2,
    {consumed_by_execution_id:"root",consumption_claim:claim});
  const facts: CanonicalWorkTurnRow[] = [root];
  for (let index=0; index<(repeat?2:1); index++) {
    const base=3+index*4, tool=`tool-${index}`;
    const owned={execution_id:"root",environment_work:{workId:"work",generation:1}};
    facts.push(make({id:tool,type:"agent.tool_use",name:"read",input:{},evaluatedPermission:"ask",processedAt:"2026-11-10T00:00:00Z"},base,owned));
    facts.push(make({id:`ask-${index}`,type:"session.status_idle",stopReason:{type:"requires_action",eventIds:[tool]},processedAt:"2026-11-10T00:00:00Z"},base+1,owned));
    facts.push(make({id:`answer-${index}`,type:"user.tool_confirmation",toolUseId:tool,result:"allow",processedAt:"2026-11-10T00:00:00Z"},base+2,
      {consumed_by_execution_id:"root",consumption_claim:claim}));
    facts.push(make({id:`resume-${index}`,type:"session.status_running",processedAt:"2026-11-10T00:00:00Z"},base+3,owned));
  }
  return facts;
}
it("a root-attributed running fact resumes an approval pause without completing the turn", () => {
  expect(inspect(approvalHistory()))
    .toMatchObject({ type: "turn", terminal: null, consumed: true });
});
it("allows repeated approval pauses before one immutable final terminal", () => {
  expect(inspect([...approvalHistory(true), row("done", 11, undefined, "session.status_idle")]))
    .toMatchObject({ type: "turn", terminal: { eventId: "done", stopReason: { type: "end_turn" } } });
});
it("retains the latest unresolved approval pause as parked evidence", () => {
  expect(inspect([row("root", 2, "root"), pause("ask", 3), running("resume", 4), pause("ask2", 5)]))
    .toMatchObject({ type: "turn", terminal: { eventId: "ask2", stopReason: { type: "requires_action" } } });
});
it("does not resume a pause with another turn's running fact", () => {
  const other = running("other", 5); other.decoded.executionId = "other";
  expect(inspect([row("root", 2, "root"), pause("ask", 3), other]))
    .toMatchObject({ type: "turn", terminal: { eventId: "ask" } });
});
it("does not let running facts reopen a final completed turn", () => {
  expect(inspect([row("root", 2, "root"), row("done", 3, undefined, "session.status_idle"), running("late", 4)]))
    .toEqual({ type: "gap", reason: "terminal_not_last_turn_fact" });
});
it("cannot resume an old pause with a different Work generation", () => {
  const newer = running("new-owner", 5); newer.decoded.environmentWork = { workId: "work", generation: 2 };
  expect(inspect([row("root", 2, "root"), pause("ask", 3), newer]))
    .toEqual({ type: "gap", reason: "terminal_not_last_turn_fact" });
});
it("still rejects two final completion receipts separated by an approval pause", () => {
  expect(inspect([row("root", 2, "root"), row("done", 3, undefined, "session.status_idle"), pause("ask", 4), row("done2", 5, undefined, "session.status_idle")]))
    .toEqual({ type: "gap", reason: "ambiguous_terminal" });
});
