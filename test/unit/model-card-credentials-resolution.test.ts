import { describe, expect, it } from "vitest";
import {
  ModelCardNotConfiguredError,
  resolveWorkspaceModelCredentials,
  type ModelCardRow,
} from "@open-managed-agents/model-cards-store";
import { createInMemoryModelCardService } from "@open-managed-agents/model-cards-store/test-fakes";

// There is no platform model key. Every runtime (Node control plane,
// Cloudflare agent worker, Cloudflare main worker) resolves model calls
// through this one policy against the caller's own workspace.

describe("resolveWorkspaceModelCredentials", () => {
  it("returns the workspace card's credentials", async () => {
    const { service } = createInMemoryModelCardService();
    await service.create({
      tenantId: "ws_a",
      modelId: "claude-prod",
      provider: "ant",
      model: "claude-sonnet-4-6",
      apiKey: "sk-ws-a",
      baseUrl: "https://llm.example",
      customHeaders: { "x-team": "a" },
    });
    await expect(resolveWorkspaceModelCredentials(service, "ws_a", "claude-prod")).resolves.toMatchObject({
      wireModel: "claude-sonnet-4-6",
      apiKey: "sk-ws-a",
      baseURL: "https://llm.example",
      provider: "ant",
      customHeaders: { "x-team": "a" },
    });
  });

  it("throws a user-facing error instead of falling back when the workspace has no card", async () => {
    const { service } = createInMemoryModelCardService();
    // Another workspace's card must never satisfy this workspace's lookup.
    await service.create({ tenantId: "ws_other", modelId: "claude-prod", provider: "ant", apiKey: "sk-other" });
    const attempt = resolveWorkspaceModelCredentials(service, "ws_a", "claude-prod");
    await expect(attempt).rejects.toBeInstanceOf(ModelCardNotConfiguredError);
    await expect(attempt).rejects.toThrow(
      'Model "claude-prod" is not configured for this workspace. Add a model card with model_id "claude-prod" in Console → Models.',
    );
  });

  it("treats archived cards and undecryptable keys as not configured", async () => {
    const archived: ModelCardRow = {
      id: "mc_1", tenant_id: "ws_a", model_id: "m", model: "m", provider: "ant",
      base_url: null, custom_headers: null, pi_config: null, api_key_preview: "1234",
      is_default: false, created_at: "2026-01-01T00:00:00.000Z", updated_at: null,
      archived_at: "2026-01-02T00:00:00.000Z",
    };
    let keyReads = 0;
    await expect(resolveWorkspaceModelCredentials({
      findByModelId: async () => archived,
      getApiKey: async () => { keyReads += 1; return "sk"; },
    }, "ws_a", "m")).rejects.toMatchObject({ code: "model_card_not_configured" });
    expect(keyReads).toBe(0);

    await expect(resolveWorkspaceModelCredentials({
      findByModelId: async () => ({ ...archived, archived_at: null }),
      getApiKey: async () => null,
    }, "ws_a", "m")).rejects.toThrow(/no usable API key/);
  });

  it("propagates storage failures instead of masking them with a platform key", async () => {
    await expect(resolveWorkspaceModelCredentials({
      findByModelId: async () => { throw new Error("database unavailable"); },
      getApiKey: async () => null,
    }, "ws_a", "m")).rejects.toThrow("database unavailable");
  });
});
