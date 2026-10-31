import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { projectCanonicalChat, type WireSessionEvent } from "@openma/common/session-events/managed";
import { awaitedToolNames, CanonicalSessionTurn, projectCanonicalSessionTurn } from "./CanonicalSessionTurn";
import type { CanonicalChatTurn } from "@openma/common/session-events/managed";
import { ingestManagedWireEvent } from "../../lib/managed-event-bridge";
import { upsertSessionEvent } from "../../lib/session-event-upsert";

// Real session parked on requires_action with 15 queued user.messages.
function e434Events(name = "session_e434d0ba91be4541bde691a99938fc10") {
  const raw = JSON.parse(readFileSync(
    resolve(import.meta.dirname, `__fixtures__/${name}.json`),
    "utf8",
  )).data as WireSessionEvent[];
  let events: Parameters<typeof upsertSessionEvent>[0] = [];
  for (const wire of raw) {
    const event = ingestManagedWireEvent(wire, { sessionId: "s" });
    if (event) events = upsertSessionEvent(events, event as never).events;
  }
  return events;
}

describe("CanonicalSessionTurn awaiting (e434)", () => {
  const projection = projectCanonicalChat(e434Events() as never, { sessionStatus: "idle" });
  const [turn] = projection.turns;
  const projected = projectCanonicalSessionTurn(turn!, { activeTurnId: projection.activeTurnId });
  const html = renderToStaticMarkup(<CanonicalSessionTurn turn={turn!} projectedTurn={projected} />);

  it("keeps the processed prompt heading the turn and the 15 unprocessed queued", () => {
    expect(projection.turns).toHaveLength(1);
    expect(projection.queued).toHaveLength(15);
    expect(html).toContain("data-session-turn-prompt");
    expect(html).toContain("Scaffold a small Python project");
  });

  it("maps to the shared awaiting status: no 'terminal status unavailable', no spinner", () => {
    expect(projected.status).toBe("awaiting");
    expect(html).toContain('data-session-turn-status="awaiting"');
    expect(html).not.toContain("terminal status unavailable");
    expect(html).not.toContain('data-session-process-state="running"');
    expect(html).toContain("Needs action");
  });

  it("shows the real in-progress duration from event timestamps", () => {
    expect(projected.startedAt).toBe("2026-10-31T15:50:57.835Z");
    expect(projected.endedAt).toBe("2026-10-31T15:51:52.953Z");
    expect(html).toContain("Working for 56s");
    expect(html).not.toContain("Worked for 0s");
  });
});

describe("awaitedToolNames", () => {
  it("e434 names the single blocking call once (latest requires_action event_ids)", () => {
    const projection = projectCanonicalChat(e434Events() as never, { sessionStatus: "idle" });
    expect(projection.awaitingToolCallIds).toHaveLength(1);
    expect(awaitedToolNames(projection.turns[0]!)).toEqual(["run"]);
    const html = renderToStaticMarkup(<CanonicalSessionTurn turn={projection.turns[0]!} />);
    expect(html).toContain("waiting on run<");
    expect(html).not.toContain("run, run");
  });

  it("dedupes rows per call id and counts distinct pending calls", () => {
    const tool = (toolCallId: string) => ({ toolCallId, toolName: "run" });
    const turn = {
      awaitingToolCallIds: ["a", "b"],
      render: { tools: [tool("a"), tool("a"), tool("b"), tool("c")] },
    } as unknown as CanonicalChatTurn;
    expect(awaitedToolNames(turn)).toEqual(["run ×2"]);
  });
});

describe("d852 (212 events) through Console ingest + render", () => {
  it("projects and renders every turn with its prompt, without throwing", () => {
    const events = e434Events("session_d852b9f8b2634477ac2d87ca7a1ebcd8");
    expect(events.length).toBeGreaterThan(100);
    const projection = projectCanonicalChat(events as never, { sessionStatus: "idle" });
    expect(projection.turns.length).toBeGreaterThan(1);
    expect(projection.turns[0]!.status).toBe("interrupted");
    for (const turn of projection.turns) {
      const html = renderToStaticMarkup(
        <CanonicalSessionTurn turn={turn} projectedTurn={projectCanonicalSessionTurn(turn, { activeTurnId: projection.activeTurnId })} />,
      );
      expect(html).toContain("data-session-turn-prompt");
    }
  });
});
