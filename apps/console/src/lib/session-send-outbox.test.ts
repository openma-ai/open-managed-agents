/**
 * Regression tests for https://github.com/openma-ai/open-managed-agents/issues/398
 *
 * The Console follows the official Managed Agents send-response path only:
 * POST /events returns the accepted `user.message` in `response.data`, which
 * the Console merges into its canonical event log before clearing the
 * optimistic outbox slot. The optional OpenMA `system.user_message_pending` /
 * `_promoted` / `_cancelled` stream frames are NOT a dependency and are never
 * required as a fallback.
 */
import { describe, expect, it } from "vitest";
import {
  projectCanonicalChatTurns,
  type WireSessionEvent,
} from "@openma/common/session-events/managed";
import { eventKey } from "./session-event-key";
import {
  mergeSendResponseIntoOutbox,
  type SendResponse,
} from "./session-send-outbox";

type WireEvent = WireSessionEvent & { id?: string };
type SendResponseData = NonNullable<NonNullable<SendResponse>["data"]>;

function responseWith(events: WireEvent[]): SendResponse {
  return { data: events as unknown as SendResponseData };
}

/** Minimal production-shaped outbox: addEvent dedupes via eventKey/seenKeys. */
function createOutbox() {
  const seenKeys = new Set<string>();
  const events: WireEvent[] = [];
  const addEvent = (event: Record<string, unknown>) => {
    const wireEvent = event as WireEvent;
    const key = eventKey(wireEvent);
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    events.push(wireEvent);
  };
  return { events, seenKeys, addEvent };
}

function visibleUserTexts(events: WireEvent[], localPending: string | null): string[] {
  const texts: string[] = [];
  if (localPending) texts.push(localPending);
  for (const turn of projectCanonicalChatTurns(events)) {
    if (turn.userText) texts.push(turn.userText);
  }
  return texts;
}

function acceptedUserMessage(text: string, id: string): WireEvent {
  return {
    type: "user.message",
    id,
    content: [{ type: "text", text }],
    processed_at: new Date().toISOString(),
  };
}

describe("mergeSendResponseIntoOutbox (issue #398)", () => {
  it("keeps the user bubble after handoff when no pending SSE arrives", () => {
    const text = "hello from console";
    const accepted = acceptedUserMessage(text, "sevt_outbox_1");
    const outbox = createOutbox();

    const handoff = mergeSendResponseIntoOutbox(
      responseWith([accepted]),
      { localPending: text, optimisticText: text },
      outbox.addEvent,
    );

    expect(handoff.merged).toBe(1);
    expect(handoff.missingData).toBe(false);
    expect(handoff.localPending).toBeNull();
    // The only visible user bubble comes from the merged accepted event.
    expect(visibleUserTexts(outbox.events, handoff.localPending)).toEqual([text]);
  });

  it("merges the accepted event before clearing the optimistic slot", () => {
    const text = "order matters";
    const accepted = acceptedUserMessage(text, "sevt_outbox_order");
    const outbox = createOutbox();
    let localPending: string | null = text;
    const pendingAtMerge: Array<string | null> = [];

    const handoff = mergeSendResponseIntoOutbox(
      responseWith([accepted]),
      { localPending, optimisticText: text },
      (event) => {
        pendingAtMerge.push(localPending);
        outbox.addEvent(event);
      },
    );
    localPending = handoff.localPending;

    expect(pendingAtMerge).toEqual([text]);
    expect(localPending).toBeNull();
    expect(outbox.events).toHaveLength(1);
  });

  it("dedupes the send response event when the stream later redelivers the same id", () => {
    const text = "hello once";
    const accepted = acceptedUserMessage(text, "sevt_outbox_2");
    const outbox = createOutbox();

    const handoff = mergeSendResponseIntoOutbox(
      responseWith([accepted]),
      { localPending: text, optimisticText: text },
      outbox.addEvent,
    );
    // Same accepted event arrives over SSE after the POST handoff.
    outbox.addEvent(accepted);

    expect(outbox.events).toHaveLength(1);
    const visible = visibleUserTexts(outbox.events, handoff.localPending);
    expect(visible.filter((value) => value === text)).toHaveLength(1);
  });

  it.each<[string, SendResponse]>([
    ["undefined", undefined],
    ["null", null],
    ["missing data", {}],
    ["empty data", { data: [] }],
  ])(
    "keeps the optimistic bubble when the response has no accepted events (%s)",
    (_label, response) => {
      const text = "hello without send data";
      const outbox = createOutbox();

      const handoff = mergeSendResponseIntoOutbox(
        response,
        { localPending: text, optimisticText: text },
        outbox.addEvent,
      );

      expect(handoff.merged).toBe(0);
      expect(handoff.missingData).toBe(true);
      // Keep the optimistic bubble: no blank window, and no pending-frame
      // fallback is needed or attempted.
      expect(handoff.localPending).toBe(text);
      expect(outbox.events).toHaveLength(0);
      expect(visibleUserTexts(outbox.events, handoff.localPending)).toEqual([text]);
    },
  );

  it("leaves an unrelated optimistic slot alone", () => {
    const outbox = createOutbox();

    const handoff = mergeSendResponseIntoOutbox(
      { data: [] },
      { localPending: "a different pending message", optimisticText: "this send" },
      outbox.addEvent,
    );

    expect(handoff.merged).toBe(0);
    expect(handoff.missingData).toBe(true);
    expect(handoff.localPending).toBe("a different pending message");
  });
});
