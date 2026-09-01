import type {
  MemoriesApplicationPort,
  MemoryStoreView,
  MemoryStoresApplicationPort,
  MemoryVersionView,
  MemoryVersionsApplicationPort,
  MemoryView,
} from "../src/index";

export const memoryStoreView: MemoryStoreView = {
  id: "memstore_01",
  createdAt: "2026-08-26T14:00:00.000Z",
  name: "Project memory",
  updatedAt: "2026-08-26T14:00:00.000Z",
  archivedAt: null,
  description: "Project facts",
  metadata: { project: "openma" },
};

export const memoryView: MemoryView = {
  kind: "memory",
  id: "mem_01",
  contentSha256: "a".repeat(64),
  contentSizeBytes: 5,
  createdAt: "2026-08-26T14:10:00.000Z",
  memoryStoreId: "memstore_01",
  memoryVersionId: "memver_01",
  path: "/notes/one.md",
  updatedAt: "2026-08-26T14:10:00.000Z",
  content: "hello",
};

export const memoryVersionView: MemoryVersionView = {
  id: "memver_01",
  createdAt: "2026-08-26T14:10:00.000Z",
  memoryId: "mem_01",
  memoryStoreId: "memstore_01",
  operation: "created",
  content: "hello",
  contentSha256: "a".repeat(64),
  contentSizeBytes: 5,
  createdBy: { kind: "api", apiKeyId: "apikey_01" },
  path: "/notes/one.md",
  redactedAt: null,
};

export function makeMemoryStoresPort(
  overrides: Partial<MemoryStoresApplicationPort>,
): MemoryStoresApplicationPort {
  return {
    createMemoryStore: async () => {
      throw new Error("unexpected createMemoryStore application port call");
    },
    retrieveMemoryStore: async () => {
      throw new Error("unexpected retrieveMemoryStore application port call");
    },
    updateMemoryStore: async () => {
      throw new Error("unexpected updateMemoryStore application port call");
    },
    listMemoryStores: async () => {
      throw new Error("unexpected listMemoryStores application port call");
    },
    deleteMemoryStore: async () => {
      throw new Error("unexpected deleteMemoryStore application port call");
    },
    archiveMemoryStore: async () => {
      throw new Error("unexpected archiveMemoryStore application port call");
    },
    ...overrides,
  };
}

export function makeMemoriesPort(
  overrides: Partial<MemoriesApplicationPort>,
): MemoriesApplicationPort {
  return {
    createMemory: async () => {
      throw new Error("unexpected createMemory application port call");
    },
    retrieveMemory: async () => {
      throw new Error("unexpected retrieveMemory application port call");
    },
    updateMemory: async () => {
      throw new Error("unexpected updateMemory application port call");
    },
    listMemories: async () => {
      throw new Error("unexpected listMemories application port call");
    },
    deleteMemory: async () => {
      throw new Error("unexpected deleteMemory application port call");
    },
    ...overrides,
  };
}

export function makeMemoryVersionsPort(
  overrides: Partial<MemoryVersionsApplicationPort>,
): MemoryVersionsApplicationPort {
  return {
    retrieveMemoryVersion: async () => {
      throw new Error("unexpected retrieveMemoryVersion application port call");
    },
    listMemoryVersions: async () => {
      throw new Error("unexpected listMemoryVersions application port call");
    },
    redactMemoryVersion: async () => {
      throw new Error("unexpected redactMemoryVersion application port call");
    },
    ...overrides,
  };
}
