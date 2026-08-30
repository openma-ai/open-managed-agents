import { describe, expect, it } from "vitest";
import { DefaultHarness } from "../src/harness/default-loop";
import { PiHarness } from "../src/harness/pi-loop";
import { registerCoreHarnesses } from "../src/harness/builtins";
import { resolveHarness } from "../src/harness/registry";

describe("production harness composition", () => {
  it("keeps the OpenMA AI SDK loop as default and Pi as an explicit harness", () => {
    registerCoreHarnesses();
    expect(resolveHarness("default")).toBeInstanceOf(DefaultHarness);
    expect(resolveHarness("ai-sdk")).toBeInstanceOf(DefaultHarness);
    expect(resolveHarness("pi")).toBeInstanceOf(PiHarness);
  });
});
