import { describe, expect, it } from "vitest";
import * as legacyHub from "../src/lib/event-stream-hub";

interface TestFrame {
  sequence: number;
  event: {
    id: string;
    type: "system.message";
    content: Array<{ type: "text"; text: string }>;
    processedAt: string;
  };
}

interface TestWriter {
  closed: boolean;
  write(frame: TestFrame): void;
  close(): void;
}

interface TestRealtimeHub {
  attach(input: {
    workspaceId: string;
    sessionId: string;
    writer: TestWriter;
    replay?: TestFrame[];
  }): () => void;
  publish(input: {
    workspaceId: string;
    sessionId: string;
    frame: TestFrame;
  }): void;
  closeSession(input: { workspaceId: string; sessionId: string }): void;
}

type RealtimeHubFactory = () => TestRealtimeHub;

function frame(sequence: number, text: string): TestFrame {
  return {
    sequence,
    event: {
      id: `event_${sequence}`,
      type: "system.message",
      content: [{ type: "text", text }],
      processedAt: `2026-08-26T0${sequence}:00:00.000Z`,
    },
  };
}

describe("managed Session realtime compatibility", () => {
  it("replays before live delivery and isolates equal Session IDs by workspace", () => {
    const createHub = (
      legacyHub as typeof legacyHub & {
        createManagedSessionRealtimeHub?: RealtimeHubFactory;
      }
    ).createManagedSessionRealtimeHub;
    expect(createHub).toBeTypeOf("function");
    if (createHub === undefined) return;

    const received: TestFrame[] = [];
    const writer: TestWriter = {
      closed: false,
      write(value) { received.push(structuredClone(value)); },
      close() { this.closed = true; },
    };
    const hub = createHub();
    hub.attach({
      workspaceId: "workspace_a",
      sessionId: "session_same",
      writer,
      replay: [frame(1, "replayed")],
    });
    hub.publish({
      workspaceId: "workspace_b",
      sessionId: "session_same",
      frame: frame(2, "wrong tenant"),
    });
    hub.publish({
      workspaceId: "workspace_a",
      sessionId: "session_same",
      frame: frame(3, "live"),
    });

    expect(received).toEqual([
      frame(1, "replayed"),
      frame(3, "live"),
    ]);

    hub.closeSession({
      workspaceId: "workspace_a",
      sessionId: "session_same",
    });
    hub.publish({
      workspaceId: "workspace_a",
      sessionId: "session_same",
      frame: frame(4, "after close"),
    });
    expect(writer.closed).toBe(true);
    expect(received).toHaveLength(2);
  });
});
