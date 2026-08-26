import { describe, expect, it } from "vitest";
import { modelCardProbeUrl } from "../src/model-cards/probe-url";

describe("model-card capability probe URL", () => {
  it("does not duplicate /v1 when a compatible base URL already includes it", () => {
    expect(
      modelCardProbeUrl("ant", "https://provider.example/v1"),
    ).toBe("https://provider.example/v1/messages");
    expect(
      modelCardProbeUrl("oai-compatible", "https://provider.example/v1/"),
    ).toBe("https://provider.example/v1/chat/completions");
  });

  it("uses provider defaults when no base URL is supplied", () => {
    expect(modelCardProbeUrl("ant", null)).toBe(
      "https://api.anthropic.com/v1/messages",
    );
    expect(modelCardProbeUrl("oai", null)).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
  });
});
