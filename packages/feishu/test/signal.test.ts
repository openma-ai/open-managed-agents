import { describe, expect, it } from "vitest";
import { FEISHU_SIGNAL_PROTOCOL_PROMPT } from "../src/signal";

describe("signal protocol prompt", () => {
  it("is a non-empty string", () => {
    expect(typeof FEISHU_SIGNAL_PROTOCOL_PROMPT).toBe("string");
    expect(FEISHU_SIGNAL_PROTOCOL_PROMPT.length).toBeGreaterThan(0);
  });

  it("opens and closes with <oma_feishu_signal_protocol> tags", () => {
    expect(FEISHU_SIGNAL_PROTOCOL_PROMPT.startsWith("<oma_feishu_signal_protocol>")).toBe(true);
    expect(FEISHU_SIGNAL_PROTOCOL_PROMPT.endsWith("</oma_feishu_signal_protocol>")).toBe(true);
  });

  it("documents every signal kind the runner emits", () => {
    expect(FEISHU_SIGNAL_PROTOCOL_PROMPT).toContain("direct_invocation");
    expect(FEISHU_SIGNAL_PROTOCOL_PROMPT).toContain("reaction_on_bot_message");
    expect(FEISHU_SIGNAL_PROTOCOL_PROMPT).toContain("bot_added");
    expect(FEISHU_SIGNAL_PROTOCOL_PROMPT).toContain("bot_removed");
  });

  it("does not mention Slack-specific concepts", () => {
    // Sentinel: thread_ts is a Slack artifact and would confuse Feishu sessions.
    expect(FEISHU_SIGNAL_PROTOCOL_PROMPT).not.toContain("thread_ts");
    expect(FEISHU_SIGNAL_PROTOCOL_PROMPT).not.toContain("channel_scan_armed");
  });
});
