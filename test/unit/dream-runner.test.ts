import { describe, expect, it } from "vitest";
import { createInMemoryDreamService } from "@open-managed-agents/dreams-store/test-fakes";
import { createInMemoryMemoryStoreService } from "@open-managed-agents/memory-store/test-fakes";
import {
  DedupOnlyDreamCurator,
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
