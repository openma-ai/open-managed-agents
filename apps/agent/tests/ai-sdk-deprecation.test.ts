import { describe, expect, it, vi, afterEach } from "vitest";
import {
  AI_SDK_HARNESS_DEPRECATION_MESSAGE,
  resetAiSdkHarnessDeprecationWarningsForTests,
  warnAiSdkHarnessDeprecatedOnce,
} from "../src/harness/ai-sdk-deprecation";

describe("ai-sdk harness deprecation", () => {
  afterEach(() => {
    resetAiSdkHarnessDeprecationWarningsForTests();
    vi.restoreAllMocks();
  });

  it("warns once per session via log and session.warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const events: Array<{ type: string; source?: string }> = [];

    warnAiSdkHarnessDeprecatedOnce("session_deprecation_test", (event) => {
      events.push(event as { type: string; source?: string });
    });
    warnAiSdkHarnessDeprecatedOnce("session_deprecation_test", (event) => {
      events.push(event as { type: string; source?: string });
    });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain(AI_SDK_HARNESS_DEPRECATION_MESSAGE);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "session.warning",
      source: "harness_deprecated",
      message: AI_SDK_HARNESS_DEPRECATION_MESSAGE,
    });
  });
});
