import { describe, expect, it } from "vitest";
import "../src/index";
import { DefaultHarness } from "../src/harness/default-loop";
import { PiHarness } from "../src/harness/pi-loop";
import { resolveHarness } from "../src/harness/registry";

describe("production harness composition", () => {
  it("keeps the OpenMA AI SDK loop as default and Pi as an explicit harness", () => {
    expect(resolveHarness("default")).toBeInstanceOf(DefaultHarness);
    expect(resolveHarness("pi")).toBeInstanceOf(PiHarness);
  });
});
