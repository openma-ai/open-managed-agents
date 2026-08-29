import { describe, expect, it } from "vitest";
import { createPiModelRuntime } from "../src/harness/pi-provider";

describe("createPiModelRuntime", () => {
  it("binds an Anthropic model card to Pi without exposing its credential", async () => {
    const runtime = createPiModelRuntime({
      model: "claude-sonnet-4-6",
      apiKey: "tenant-secret",
      provider: "ant",
    });

    expect(runtime.model).toMatchObject({
      id: "claude-sonnet-4-6",
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
    });
    expect(JSON.stringify(runtime.model)).not.toContain("tenant-secret");
    expect(JSON.stringify(runtime.models.getProvider("anthropic"))).not.toContain(
      "tenant-secret",
    );
    await expect(runtime.models.getAuth(runtime.model)).resolves.toMatchObject({
      auth: { apiKey: "tenant-secret" },
    });
  });

  it("keeps legacy compatible cards as a thin migration mapping", () => {
    const runtime = createPiModelRuntime({
      model: "custom-model",
      apiKey: "secret",
      provider: "oai-compatible",
      baseURL: "https://models.example.test/v1",
      customHeaders: { "x-tenant-model": "custom" },
    });

    expect(runtime.model).toMatchObject({
      id: "custom-model",
      provider: "openai-compatible",
      api: "openai-completions",
      baseUrl: "https://models.example.test/v1",
    });
    expect(runtime.models.getProvider("openai-compatible")?.headers).toEqual({
      "x-tenant-model": "custom",
    });
  });

  it("uses Pi's DeepSeek catalog instead of an OpenMA provider implementation", () => {
    const runtime = createPiModelRuntime({
      model: "deepseek-v4-pro",
      apiKey: "secret",
      provider: "deepseek",
    });

    expect(runtime.model).toMatchObject({
      id: "deepseek-v4-pro",
      provider: "deepseek",
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com",
    });
    expect(runtime.model.contextWindow).toBeGreaterThan(0);
  });
});
