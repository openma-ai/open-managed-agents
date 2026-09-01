import type { Dream } from "../domain/dream";
import type { DreamStore, StoredDream } from "@open-managed-agents/dream-store";
import type { DreamCuratorPort, DreamSessionDescriptor } from "./curator";
import type { DreamMemoryWorkspacePort } from "./memory-workspace";
import type {
  DreamExecutionApplicationPort,
  ExecuteDreamCommand,
  ExecuteDreamResult,
} from "./port";
import type { DreamSessionSourcePort } from "./session-source";

export interface DreamExecutionApplicationServiceDependencies {
  workspaceId: string;
  store: DreamStore;
  memories: DreamMemoryWorkspacePort;
  curator: DreamCuratorPort;
  sessions: DreamSessionSourcePort;
  clock: { now(): Date };
}

export class DreamExecutionApplicationService
  implements DreamExecutionApplicationPort
{
  constructor(
    private readonly dependencies: DreamExecutionApplicationServiceDependencies,
  ) {}

  async executeDream(command: ExecuteDreamCommand): Promise<ExecuteDreamResult> {
    const current = await this.dependencies.store.find({
      workspaceId: this.dependencies.workspaceId,
      dreamId: command.dreamId,
    });
    if (current === null) return { type: "not_found" };
    if (current.dream.status !== "pending") {
      return { type: "skipped", dream: current.dream };
    }

    try {
      return await this.executePending(current);
    } catch (error) {
      return this.recordFailure(command.dreamId, error);
    }
  }

  private async executePending(current: StoredDream): Promise<ExecuteDreamResult> {
    const inputMemoryStoreId = current.dream.inputs.find(
      (input) => input.kind === "memory_store",
    )?.memoryStoreId;
    if (inputMemoryStoreId === undefined) {
      throw new Error("Dream has no memory-store input");
    }

    const outputMemoryStoreId = await this.outputMemoryStoreId(
      current.dream,
      inputMemoryStoreId,
    );
    const running: Dream = {
      ...current.dream,
      status: "running",
      outputs: [
        { kind: "memory_store", memoryStoreId: outputMemoryStoreId },
      ],
    };
    const started = await this.dependencies.store.replace({
      workspaceId: this.dependencies.workspaceId,
      dreamId: current.dream.id,
      expectedRevision: current.revision,
      next: running,
    });
    if (started.type === "not_found") return { type: "not_found" };
    if (started.type === "revision_conflict") {
      return this.latestAfterConflict(
        current.dream.id,
        started.actualRevision,
      );
    }

    const inputMemories = await this.dependencies.memories.readAll({
      workspaceId: this.dependencies.workspaceId,
      memoryStoreId: inputMemoryStoreId,
    });
    if (inputMemories.type === "not_found") {
      throw new Error(`Input Memory Store ${inputMemoryStoreId} was not found`);
    }
    const inputSessions = await this.inputSessions(started.record.dream);
    const curated = await this.dependencies.curator.curate({
      inputMemories: inputMemories.memories,
      inputSessions,
      instructions: started.record.dream.instructions,
      model: started.record.dream.model,
    });

    const beforeWrite = await this.dependencies.store.find({
      workspaceId: this.dependencies.workspaceId,
      dreamId: current.dream.id,
    });
    if (beforeWrite === null) return { type: "not_found" };
    if (beforeWrite.dream.status !== "running") {
      return { type: "skipped", dream: beforeWrite.dream };
    }
    const written = await this.dependencies.memories.replaceAll({
      workspaceId: this.dependencies.workspaceId,
      dreamId: current.dream.id,
      memoryStoreId: outputMemoryStoreId,
      memories: curated.memories,
    });
    if (written.type === "not_found") {
      throw new Error(`Output Memory Store ${outputMemoryStoreId} was not found`);
    }
    if (written.type === "rejected") throw new Error(written.message);

    const latest = await this.dependencies.store.find({
      workspaceId: this.dependencies.workspaceId,
      dreamId: current.dream.id,
    });
    if (latest === null) return { type: "not_found" };
    if (latest.dream.status !== "running") {
      return { type: "skipped", dream: latest.dream };
    }
    const completed: Dream = {
      ...latest.dream,
      endedAt: this.dependencies.clock.now().toISOString(),
      status: "completed",
      usage: curated.usage,
    };
    const committed = await this.dependencies.store.replace({
      workspaceId: this.dependencies.workspaceId,
      dreamId: latest.dream.id,
      expectedRevision: latest.revision,
      next: completed,
    });
    if (committed.type === "not_found") return { type: "not_found" };
    if (committed.type === "revision_conflict") {
      return this.latestAfterConflict(
        latest.dream.id,
        committed.actualRevision,
      );
    }
    return { type: "completed", dream: committed.record.dream };
  }

  private async outputMemoryStoreId(
    dream: Dream,
    inputMemoryStoreId: string,
  ): Promise<string> {
    if (dream.outputBehavior.kind === "update_existing") {
      return dream.outputBehavior.memoryStoreId;
    }
    const result = await this.dependencies.memories.createOutput({
      workspaceId: this.dependencies.workspaceId,
      dreamId: dream.id,
      inputMemoryStoreId,
    });
    if (result.type === "rejected") throw new Error(result.message);
    return result.memoryStoreId;
  }

  private async inputSessions(dream: Dream): Promise<DreamSessionDescriptor[]> {
    const input = dream.inputs.find((candidate) => candidate.kind === "sessions");
    if (input === undefined || input.kind !== "sessions") return [];
    const sessions: DreamSessionDescriptor[] = [];
    for (const sessionId of input.sessionIds) {
      const session = await this.dependencies.sessions.find({
        workspaceId: this.dependencies.workspaceId,
        sessionId,
      });
      if (session === null || session.archivedAt !== null) {
        throw new Error(`Input Session ${sessionId} was not found`);
      }
      sessions.push({ id: session.id, title: session.title });
    }
    return sessions;
  }

  private async recordFailure(
    dreamId: string,
    error: unknown,
  ): Promise<ExecuteDreamResult> {
    const current = await this.dependencies.store.find({
      workspaceId: this.dependencies.workspaceId,
      dreamId,
    });
    if (current === null) return { type: "not_found" };
    if (current.dream.status === "canceled" || current.dream.status === "completed") {
      return { type: "skipped", dream: current.dream };
    }
    if (current.dream.status === "failed") {
      return { type: "failed", dream: current.dream };
    }
    const failed: Dream = {
      ...current.dream,
      endedAt: this.dependencies.clock.now().toISOString(),
      error: {
        type: "execution_error",
        message: error instanceof Error ? error.message : "Dream execution failed",
      },
      status: "failed",
    };
    const result = await this.dependencies.store.replace({
      workspaceId: this.dependencies.workspaceId,
      dreamId,
      expectedRevision: current.revision,
      next: failed,
    });
    if (result.type === "replaced") {
      return { type: "failed", dream: result.record.dream };
    }
    if (result.type === "not_found") return { type: "not_found" };
    return this.latestAfterConflict(dreamId, result.actualRevision);
  }

  private async latestAfterConflict(
    dreamId: string,
    actualRevision: number,
  ): Promise<ExecuteDreamResult> {
    const latest = await this.dependencies.store.find({
      workspaceId: this.dependencies.workspaceId,
      dreamId,
    });
    if (latest === null) return { type: "not_found" };
    if (latest.dream.status === "failed") {
      return { type: "failed", dream: latest.dream };
    }
    if (
      latest.dream.status === "canceled" ||
      latest.dream.status === "completed"
    ) {
      return { type: "skipped", dream: latest.dream };
    }
    return {
      type: "conflict",
      message: `Dream changed concurrently at revision ${actualRevision}`,
    };
  }
}
