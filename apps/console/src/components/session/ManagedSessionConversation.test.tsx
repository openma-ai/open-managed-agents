import { render, screen } from "@testing-library/react";
import type { CanonicalChatTurn } from "@openma/common/session-events/managed";
import { describe, expect, it, vi } from "vitest";
import { ManagedSessionConversation } from "./ManagedSessionConversation";

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

describe("ManagedSessionConversation", () => {
  it("delegates the conversation column, turn lifecycle, and composer frame to OpenMA UI", () => {
    vi.stubGlobal("ResizeObserver", class {
      disconnect() {}
      observe() {}
      unobserve() {}
    });

    const { container } = render(
      <ManagedSessionConversation
        composer={<button type="button">Send</button>}
        sessionId="session-1"
        turns={[turn]}
      />,
    );

    expect(container.querySelector('[data-chat-surface="console"]')).toBeInTheDocument();
    expect(container.querySelector('[data-chat-column="turns"]')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-chat-column="composer"]')).toHaveLength(1);
    expect(container.querySelector('[data-session-process-state="complete"]')).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
  });
});
