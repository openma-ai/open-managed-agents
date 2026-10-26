import { afterEach, describe, expect, it, vi } from "vitest";
import { createInMemoryDreamService } from "@open-managed-agents/dreams-store/test-fakes";
import { createInMemoryMemoryStoreService } from "@open-managed-agents/memory-store/test-fakes";
import { createInMemoryModelCardService } from "@open-managed-agents/model-cards-store/test-fakes";
import { resolveWorkspaceModelCredentials } from "@open-managed-agents/model-cards-store";
import {
  DedupOnlyDreamCurator,
  pickCurator,
  runDream,
  type DreamPipelineServices,
} from "@open-managed-agents/dreams-pipeline";

const TENANT = "tenant-1";

async function setup() {
  const memory = createInMemoryMemoryStoreService();
  const inputStore = await memory.service.createStore({
    tenantId: TENANT,
    name: "input",
  });
  await memory.service.writeByPath({
    tenantId: TENANT,
    storeId: inputStore.id,
    path: "/notes.md",
    content: "remember the user's preferred stack",
    actor: { type: "user", id: "usr-1" },
  });

  const dreams = createInMemoryDreamService({
    verifyMemoryStoreExists: async (tenantId, storeId) =>
      !!(await memory.service.getStore({ tenantId, storeId })),
  });
  const services: DreamPipelineServices = {
    dreams: dreams.service,
    memory: memory.service,
    sessions: null,
    memoryStoreTenantIndex: null,
  };
  return { services, dreams: dreams.service, memory: memory.service, inputStore };
}

describe("runDream recovery", () => {
  it("continues a stuck running dream using its existing output memory store", async () => {
    const { services, dreams, memory, inputStore } = await setup();
    const dream = await dreams.create({
      tenantId: TENANT,
      inputMemoryStoreId: inputStore.id,
      inputSessionIds: [],
      model: "claude-sonnet-4-6",
    });
    const outputStore = await memory.createStore({
      tenantId: TENANT,
      name: "dream-output",
    });
    await dreams.markRunning({
      tenantId: TENANT,
      dreamId: dream.id,
      outputMemoryStoreId: outputStore.id,
      sessionId: null,
    });

    const recovered = await runDream({
      services,
      curator: new DedupOnlyDreamCurator(),
      tenantId: TENANT,
      dreamId: dream.id,
    });

    expect(recovered?.status).toBe("completed");
    expect(recovered?.output_memory_store_id).toBe(outputStore.id);
    const outputStores = await memory.listStores({ tenantId: TENANT });
    expect(outputStores.map((s) => s.id).sort()).toEqual([inputStore.id, outputStore.id].sort());
    const outputMemory = await memory.readByPath({
      tenantId: TENANT,
      storeId: outputStore.id,
      path: "/notes.md",
    });
    expect(outputMemory?.content).toBe("remember the user's preferred stack");
  });
});

describe("runDream model-backed curation", () => {
  afterEach(() => vi.unstubAllGlobals());

  function workspaceCardCurator(cards: ReturnType<typeof createInMemoryModelCardService>["service"]) {
    return pickCurator({
      resolveCredentials: async ({ tenantId, modelId }) => {
        const creds = await resolveWorkspaceModelCredentials(cards, tenantId, modelId);
        return {
          wireModel: creds.wireModel,
          apiKey: creds.apiKey,
          baseUrl: creds.baseURL,
          customHeaders: creds.customHeaders,
        };
      },
    });
  }

  it("fails the dream with a model-card reason and never calls a provider when the workspace has no card", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { services, dreams, inputStore } = await setup();
    const cards = createInMemoryModelCardService();
    const dream = await dreams.create({
      tenantId: TENANT,
      inputMemoryStoreId: inputStore.id,
      inputSessionIds: [],
      model: "claude-sonnet-4-6",
    });

    const result = await runDream({
      services,
      curator: workspaceCardCurator(cards.service),
      tenantId: TENANT,
      dreamId: dream.id,
      logger: { warn: () => {}, error: () => {} },
    });

    expect(result?.status).toBe("failed");
    expect(result?.error?.message).toContain('Model "claude-sonnet-4-6" is not configured for this workspace');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("curates with the dream workspace's own card, not another workspace's", async () => {
    const requests: Request[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      return Response.json({
        content: [{ type: "text", text: JSON.stringify({ memories: [{ path: "/curated.md", content: "ok" }] }) }],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    });
    const { services, dreams, inputStore } = await setup();
    const cards = createInMemoryModelCardService();
    await cards.service.create({
      tenantId: "tenant-other",
      modelId: "claude-sonnet-4-6",
      provider: "ant",
      model: "other-wire-model",
      apiKey: "sk-other-workspace",
      baseUrl: "https://other.example",
    });
    await cards.service.create({
      tenantId: TENANT,
      modelId: "claude-sonnet-4-6",
      provider: "ant",
      model: "tenant-wire-model",
      apiKey: "sk-tenant-workspace",
      baseUrl: "https://tenant.example",
    });
    const dream = await dreams.create({
      tenantId: TENANT,
      inputMemoryStoreId: inputStore.id,
      inputSessionIds: [],
      model: "claude-sonnet-4-6",
    });

    const result = await runDream({
      services,
      curator: workspaceCardCurator(cards.service),
      tenantId: TENANT,
      dreamId: dream.id,
    });

    expect(result?.status).toBe("completed");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://tenant.example/v1/messages");
    expect(requests[0]!.headers.get("x-api-key")).toBe("sk-tenant-workspace");
    expect((await requests[0]!.json() as { model: string }).model).toBe("tenant-wire-model");
  });

  it("keeps DREAM_CURATOR_MODE=dedup offline without resolving credentials", async () => {
    const resolveCredentials = vi.fn();
    expect(pickCurator({ DREAM_CURATOR_MODE: "dedup", resolveCredentials })).toBeInstanceOf(DedupOnlyDreamCurator);
    expect(resolveCredentials).not.toHaveBeenCalled();
  });
});
