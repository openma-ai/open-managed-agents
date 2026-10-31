import { render, screen } from "@testing-library/react";
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

describe("CanonicalSessionTurn queued state", () => {
  const baseTurn: CanonicalChatTurn = {
    id: "turn-queued",
    status: "running",
    userText: "still waiting",
    rawEvents: [],
    render: {
      thoughtText: "",
      currentThoughtText: "",
      assistantText: "",
      tools: [],
      plan: [],
      notes: [],
      timeline: [],
    },
  };

  it("renders a queued canonical user.message, then transitions in place on processed_at", () => {
    const queued: CanonicalChatTurn = {
      ...baseTurn,
      rawEvents: [
        {
          type: "user.message",
          id: "sevt_queued",
          content: [{ type: "text", text: "still waiting" }],
          processed_at: null,
        },
      ],
    };
    const { container, rerender } = render(<CanonicalSessionTurn turn={queued} />);

    expect(container.querySelector('[data-session-turn-status="queued"]')).toBeInTheDocument();
    expect(screen.getByText("queued")).toBeInTheDocument();
    expect(screen.getByText("still waiting")).toBeInTheDocument();

    const processed: CanonicalChatTurn = {
      ...queued,
      rawEvents: [
        {
          ...queued.rawEvents[0],
          processed_at: "2026-10-31T12:00:00.000Z",
        },
      ],
    };
    rerender(<CanonicalSessionTurn turn={processed} />);

    expect(container.querySelector('[data-session-turn-status="queued"]')).toBeNull();
    expect(container.querySelector('[data-session-turn-status="running"]')).toBeInTheDocument();
    expect(screen.queryByText("queued")).toBeNull();
  });
});
