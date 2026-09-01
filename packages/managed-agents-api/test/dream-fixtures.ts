import type {
  DreamsApplicationPort,
  Dream,
} from "../src/index";

export const dreamView: Dream = {
  id: "dream_01",
  archivedAt: null,
  createdAt: "2026-08-26T18:00:00.000Z",
  endedAt: null,
  error: null,
  inputs: [
    { kind: "memory_store", memoryStoreId: "memstore_01" },
    { kind: "sessions", sessionIds: ["session_01", "session_02"] },
  ],
  instructions: "Consolidate durable project knowledge",
  model: { modelId: "claude-opus-5", speed: "fast" },
  outputBehavior: {
    kind: "update_existing",
    memoryStoreId: "memstore_01",
  },
  outputs: [{ kind: "memory_store", memoryStoreId: "memstore_01" }],
  sessionId: "session_dream_01",
  status: "running",
  usage: {
    cacheCreationInputTokens: 100,
    cacheReadInputTokens: 200,
    inputTokens: 300,
    outputTokens: 400,
  },
};

export function makeDreamsPort(
  overrides: Partial<DreamsApplicationPort>,
): DreamsApplicationPort {
  return {
    createDream: async () => {
      throw new Error("unexpected createDream application port call");
    },
    retrieveDream: async () => {
      throw new Error("unexpected retrieveDream application port call");
    },
    listDreams: async () => {
      throw new Error("unexpected listDreams application port call");
    },
    archiveDream: async () => {
      throw new Error("unexpected archiveDream application port call");
    },
    cancelDream: async () => {
      throw new Error("unexpected cancelDream application port call");
    },
    ...overrides,
  };
}
