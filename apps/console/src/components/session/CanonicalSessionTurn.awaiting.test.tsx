import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { projectCanonicalChat, type WireSessionEvent } from "@openma/common/session-events/managed";
import { CanonicalSessionTurn, projectCanonicalSessionTurn } from "./CanonicalSessionTurn";
import { ingestManagedWireEvent } from "../../lib/managed-event-bridge";
import { upsertSessionEvent } from "../../lib/session-event-upsert";

// Real session parked on requires_action with 15 queued user.messages.
function e434Events() {
  const raw = JSON.parse(readFileSync(
    resolve(import.meta.dirname, "__fixtures__/session_e434d0ba91be4541bde691a99938fc10.json"),
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
