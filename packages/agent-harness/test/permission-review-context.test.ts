import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@open-managed-agents/shared";
import {
  buildPermissionReviewTranscript,
  PERMISSION_REVIEW_CONTEXT_LIMITS,
} from "../src/permission-review-context";

const text = (value: string) => [{ type: "text" as const, text: value }];

describe("permission review context", () => {
  it("keeps authorization evidence and drops transport noise", () => {
    const events: SessionEvent[] = [
      { type: "user.message", content: text("inspect the repository") },
      { type: "agent.thinking", text: "private reasoning" },
      { type: "agent.tool_use", id: "call-1", name: "read", input: { path: "README.md" } },
      { type: "agent.tool_result", tool_use_id: "call-1", content: "read-only result" },
      { type: "aux.model_call", model_id: "judge", task: "permission_judge", duration_ms: 1, tokens: { input: 1, output: 1 }, status: "ok" },
      { type: "span.model_request_end", model: "main" },
      { type: "user.tool_confirmation", tool_use_id: "call-1", result: "allow" },
    ];

    const transcript = buildPermissionReviewTranscript(events);

    expect(transcript).toContain('"type":"user.message"');
    expect(transcript).toContain('"type":"agent.tool_use"');
    expect(transcript).toContain('"type":"agent.tool_result"');
    expect(transcript).toContain('"type":"user.tool_confirmation"');
    expect(transcript).not.toContain("private reasoning");
    expect(transcript).not.toContain("permission_judge");
    expect(transcript).not.toContain("span.model_request_end");
  });

  it("starts at the latest persisted compaction summary", () => {
    const events: SessionEvent[] = [
      { type: "user.message", content: text("old instruction") },
      { type: "agent.message", content: text("old answer") },
      {
        type: "agent.thread_context_compacted",
        original_message_count: 2,
        compacted_message_count: 1,
        summary: text("summary of the earlier turn"),
      },
      { type: "agent.tool_use", id: "call-2", name: "bash", input: { command: "pwd" } },
    ];

    const transcript = buildPermissionReviewTranscript(events);

    expect(transcript).toContain("summary of the earlier turn");
    expect(transcript).toContain('"id":"call-2"');
    expect(transcript).not.toContain("old instruction");
    expect(transcript).not.toContain("old answer");
  });

  it("keeps the initiating instruction and latest evidence within the budget", () => {
    const events: SessionEvent[] = [
      { type: "user.message", content: text("initial authorization context") },
      ...Array.from({ length: 10 }, (_, index): SessionEvent => ({
        type: "agent.message",
        content: text(`middle-${index}-${"x".repeat(80)}`),
      })),
      { type: "agent.tool_result", tool_use_id: "call-latest", content: "latest result" },
    ];

    const transcript = buildPermissionReviewTranscript(events, { maxEntries: 4, maxEntryChars: 500, maxChars: 500 });

    expect(transcript).toContain("initial authorization context");
    expect(transcript).toContain("latest result");
    expect(transcript.length).toBeLessThanOrEqual(500 + 100);
    expect(transcript).toContain("review entries omitted by the context budget");
  });

  it("omits binary content while retaining its content type", () => {
    const events: SessionEvent[] = [{
      type: "user.message",
      content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "secret-bytes" } }],
    }];

    const transcript = buildPermissionReviewTranscript(events);

    expect(transcript).toContain("binary content omitted");
    expect(transcript).not.toContain("secret-bytes");
    expect(transcript.length).toBeLessThan(PERMISSION_REVIEW_CONTEXT_LIMITS.maxEntryChars);
  });
});
