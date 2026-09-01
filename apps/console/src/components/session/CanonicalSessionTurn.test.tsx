import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CanonicalChatTurn } from "@openma/common/session-events/managed";
import { CanonicalSessionTurn } from "./CanonicalSessionTurn";

describe("CanonicalSessionTurn", () => {
  it("projects Managed events through the OpenMA Agent UI turn", () => {
    const turn: CanonicalChatTurn = {
      id: "turn-1",
      status: "completed",
      userText: "Inspect the repository",
      rawEvents: [],
      render: {
        thoughtText: "Reading files",
        currentThoughtText: "",
        assistantText: "Everything looks good.",
        tools: [],
        plan: [],
        notes: [],
        timeline: [
          { kind: "thought", messageId: "thought-1", text: "Reading files" },
          { kind: "assistant_text", text: "Everything looks good." },
        ],
      },
    };

    const html = renderToStaticMarkup(<CanonicalSessionTurn turn={turn} />);

    expect(html).toContain('data-session-turn-status="completed"');
    expect(html).toContain('data-session-process-state="complete"');
    expect(html).toContain("Inspect the repository");
    expect(html).toContain("Reading files");
    expect(html).toContain("Everything looks good.");
  });
});
