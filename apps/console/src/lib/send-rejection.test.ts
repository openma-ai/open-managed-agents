import { describe, expect, it } from "vitest";
import { settleOnlySendFailureNotice } from "./send-rejection";

describe("settleOnlySendFailureNotice", () => {
  it("keeps composer text for the settle-only 400 (user.message during requires_action)", () => {
    expect(settleOnlySendFailureNotice({
      status: 400,
      code: "invalid_request_error",
      message: "Session is waiting on requires_action; only settle events are accepted (user.tool_confirmation, ...)",
    })).toMatch(/still in the composer/);
    expect(settleOnlySendFailureNotice({ retainComposer: true })).toMatch(/still in the composer/);
  });

  it("ignores unrelated failures", () => {
    expect(settleOnlySendFailureNotice({ status: 500, code: "api_error", message: "boom" })).toBeNull();
    expect(settleOnlySendFailureNotice({ status: 400, code: "invalid_request_error", message: "bad content" })).toBeNull();
    expect(settleOnlySendFailureNotice(new Error("network"))).toBeNull();
  });
});
