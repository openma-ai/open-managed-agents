import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Conversation, ConversationContent } from "./conversation";

describe("shared conversation shell", () => {
  it("uses the common chat scrollbar viewport", () => {
    vi.stubGlobal("ResizeObserver", class {
      disconnect() {}
      observe() {}
      unobserve() {}
    });

    render(
      <Conversation>
        <ConversationContent>hello</ConversationContent>
      </Conversation>,
    );

    expect(screen.getByRole("log").querySelector(".chat-scrollbar"))
      .toBeInTheDocument();
  });
});
