import { describe, expect, it } from "vitest";
import {
  DEFAULT_EMAIL_FROM,
  resolveEmailFrom,
} from "../../apps/main/src/auth-config";

describe("resolveEmailFrom", () => {
  it("defaults to the openma.dev sender when EMAIL_FROM is unset", () => {
    expect(resolveEmailFrom({})).toBe(DEFAULT_EMAIL_FROM);
    expect(DEFAULT_EMAIL_FROM).toBe("openma <noreply@openma.dev>");
  });

  it("treats blank EMAIL_FROM as unset", () => {
    expect(resolveEmailFrom({ EMAIL_FROM: "   " })).toBe(DEFAULT_EMAIL_FROM);
  });

  it("uses EMAIL_FROM when set", () => {
    expect(resolveEmailFrom({ EMAIL_FROM: " openma <noreply@openma.ai> " })).toBe(
      "openma <noreply@openma.ai>",
    );
  });
});
