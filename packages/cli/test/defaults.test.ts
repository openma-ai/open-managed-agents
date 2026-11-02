import { describe, expect, it } from "vitest";

import {
  DEFAULT_API_BASE_URL,
  DEFAULT_BRIDGE_SERVER_URL,
} from "../src/bridge/lib/defaults.js";

describe("hosted default URLs", () => {
  it("points CLI/API and bridge at the live Console host, not marketing apex", () => {
    expect(DEFAULT_API_BASE_URL).toBe("https://app.openma.ai");
    expect(DEFAULT_BRIDGE_SERVER_URL).toBe(DEFAULT_API_BASE_URL);
    expect(DEFAULT_API_BASE_URL).not.toContain("openma.dev");
    expect(DEFAULT_API_BASE_URL).not.toBe("https://openma.ai");
    expect(DEFAULT_API_BASE_URL).not.toContain("api.openma.");
  });
});
