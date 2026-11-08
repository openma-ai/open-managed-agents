import { describe, expect, it, vi } from "vitest";
import { resolveProtocolEndpointsFromModelCard } from "@open-managed-agents/inference-proxy";
import { resolveSessionModelUpstream } from "../../src/proxy/inference-proxy-model";

const scope = { workspaceId: "ws", sessionId: "sess" };
const card = (extra: Record<string, unknown> = {}) => ({
  id: "card_1", model_id: "handle", model: "wire-model", provider: "anthropic",
  base_url: "https://model.test", custom_headers: { "x-extra": "1" }, pi_config: null, archived_at: null, ...extra,
});

function ports(input: { managed?: unknown; legacy?: unknown; find?: () => Promise<unknown>; key?: string | null }) {
  return {
    sessions: {
      managed: { find: vi.fn(async () => input.managed ?? null) },
      legacy: { get: vi.fn(async () => input.legacy ?? null) },
    },
    modelCards: {
      findByModelId: vi.fn(input.find ?? (async () => card())),
      getApiKey: vi.fn(async () => (input.key === undefined ? "card-key" : input.key)),
    },
    log: { warn: vi.fn() },
  };
}
const managed = (model: unknown, archivedAt: string | null = null) => ({ archivedAt, vaultIds: [], agent: { id: "a", version: 1, model, mcpServers: [] } });
const legacy = (model: unknown) => ({ archived_at: null, vault_ids: [], agent_snapshot: { id: "a", version: 1, model, mcp_servers: [] } });

describe("resolveSessionModelUpstream", () => {
  it("resolves the pinned model of a v1 Session through the workspace's model card", async () => {
    const p = ports({ managed: managed({ id: "handle" }) });
    expect(await resolveSessionModelUpstream(p as never, scope)).toEqual({
      wireModel: "wire-model",
      apiKey: "card-key",
      provider: "anthropic",
      providerId: "anthropic",
      baseURL: "https://model.test",
      customHeaders: { "x-extra": "1" },
      protocolEndpoints: resolveProtocolEndpointsFromModelCard({ providerId: "anthropic", baseUrl: "https://model.test" }),
    });
    expect(p.modelCards.findByModelId).toHaveBeenCalledWith({ tenantId: "ws", modelId: "handle" });
    expect(p.modelCards.getApiKey).toHaveBeenCalledWith({ tenantId: "ws", cardId: "card_1" });
  });

  it("reads a legacy Session's snapshot model and leaves unset card fields out", async () => {
    const p = ports({ legacy: legacy("handle"), find: async () => card({ base_url: null, custom_headers: null }) });
    const upstream = await resolveSessionModelUpstream(p as never, scope);
    expect(upstream).toMatchObject({ wireModel: "wire-model", apiKey: "card-key" });
    expect(upstream).not.toHaveProperty("baseURL");
    expect(upstream).not.toHaveProperty("customHeaders");
  });

  it("refuses an archived, unknown or model-less Session without reading a card", async () => {
    for (const p of [ports({ managed: managed("handle", "2026-11-01T00:00:00.000Z") }), ports({}), ports({ managed: managed("") })]) {
      expect(await resolveSessionModelUpstream(p as never, scope)).toBeNull();
      expect(p.modelCards.findByModelId).not.toHaveBeenCalled();
    }
  });

  it("refuses a workspace without a usable card, silently", async () => {
    for (const p of [
      ports({ managed: managed("handle"), find: async () => null }),
      ports({ managed: managed("handle"), find: async () => card({ archived_at: "2026-11-01" }) }),
      ports({ managed: managed("handle"), key: null }),
    ]) {
      expect(await resolveSessionModelUpstream(p as never, scope)).toBeNull();
      expect(p.log.warn).not.toHaveBeenCalled();
    }
  });

  it("refuses and logs when the card store fails", async () => {
    const p = ports({ managed: managed("handle"), find: async () => { throw new Error("d1 unavailable"); } });
    expect(await resolveSessionModelUpstream(p as never, scope)).toBeNull();
    expect(p.log.warn).toHaveBeenCalledWith(
      { op: "inference_proxy.model_card_lookup_failed", tenant_id: "ws", session_id: "sess", error: "d1 unavailable" },
      "inference_proxy model card lookup failed",
    );
  });
});
