import type {
  CurateDream,
  CuratedDream,
  DreamCuratorPort,
} from "@open-managed-agents/managed-agents-application";

export class DeduplicatingDreamCurator implements DreamCuratorPort {
  async curate(input: CurateDream): Promise<CuratedDream> {
    const byPath = new Map<string, string>();
    for (const memory of input.inputMemories) {
      byPath.set(memory.path, memory.content);
    }
    return {
      memories: Array.from(byPath, ([path, content]) => ({ path, content }))
        .sort((left, right) => left.path.localeCompare(right.path)),
      usage: {
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
      },
    };
  }
}
