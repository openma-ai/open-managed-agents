import { describe, expect, it } from "vitest";
import { DEFAULT_BRIDGE_SERVER_URL } from "../../packages/cli/src/bridge/lib/defaults";

describe("CLI bridge defaults", () => {
  it("uses the app origin so exchange POSTs do not cross the apex redirect", () => {
    expect(DEFAULT_BRIDGE_SERVER_URL).toBe("https://app.openma.dev");
    expect(new URL(DEFAULT_BRIDGE_SERVER_URL).hostname).not.toBe("openma.dev");
  });
});
