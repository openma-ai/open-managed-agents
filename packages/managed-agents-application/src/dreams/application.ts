import type { Dream } from "../domain/dream";
import type {
  DreamStore,
  ReplaceDreamRecordResult,
  StoredDream,
} from "@open-managed-agents/dream-store";
import type {
  ChangeDreamStateResult,
  CreateDreamCommand,
  CreateDreamResult,
  DreamsApplicationPort,
  ListDreamsQuery,
  ListDreamsResult,
  RetrieveDreamQuery,
  RetrieveDreamResult,
} from "../ports/dreams";
import type { DreamExecutionSchedulerPort } from "./execution-scheduler";
import type { DreamMemoryStoreSourcePort } from "./memory-store-source";
import type { DreamSessionSourcePort } from "./session-source";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function cursorPart(value: string): string {
  return btoa(encodeURIComponent(value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeCursorPart(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
  try {
    const decoded = decodeURIComponent(atob(padded));
    return cursorPart(decoded) === value ? decoded : null;
  } catch {
    return null;
  }
}

function encodeCursor(record: StoredDream): string {
  return [
    "dream",
    cursorPart(record.dream.createdAt),
    cursorPart(record.dream.id),
  ].join(".");
}

function decodeCursor(
  value: string,
): { createdAt: string; dreamId: string } | null {
  const [scope, encodedCreatedAt, encodedDreamId, extra] = value.split(".");
  if (
    scope !== "dream" ||
    encodedCreatedAt === undefined ||
    encodedDreamId === undefined ||
    extra !== undefined
  ) return null;
  const createdAt = decodeCursorPart(encodedCreatedAt);
  const dreamId = decodeCursorPart(encodedDreamId);
  if (
    createdAt === null ||
    dreamId === null ||
    dreamId.length === 0 ||
    Number.isNaN(Date.parse(createdAt)) ||
    new Date(createdAt).toISOString() !== createdAt
  ) return null;
  return { createdAt, dreamId };
}

function canonicalTimestamp(value: string): boolean {
  return !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}

function changed(
  result: ReplaceDreamRecordResult,
): ChangeDreamStateResult {
  if (result.type === "not_found") return { type: "not_found" };
  if (result.type === "revision_conflict") {
    return {
      type: "conflict",
      message: `Dream changed concurrently at revision ${result.actualRevision}`,
    };
  }
  return { type: "changed", dream: result.record.dream };
}

export interface DreamsApplicationServiceDependencies {
  workspaceId: string;
  store: DreamStore;
  memoryStores: DreamMemoryStoreSourcePort;
  sessions: DreamSessionSourcePort;
  execution: DreamExecutionSchedulerPort;
  clock: { now(): Date };
  ids: { nextDreamId(): string };
}

export class DreamsApplicationService implements DreamsApplicationPort {
  constructor(
    private readonly dependencies: DreamsApplicationServiceDependencies,
  ) {}

  async createDream(command: CreateDreamCommand): Promise<CreateDreamResult> {
    const memoryInputs = command.inputs.filter(
      (input) => input.kind === "memory_store",
    );
    const sessionInputs = command.inputs.filter(
      (input) => input.kind === "sessions",
    );
    if (memoryInputs.length !== 1 || sessionInputs.length > 1) {
      return {
        type: "invalid_request",
        message: "A Dream requires exactly one memory-store input and at most one Sessions input",
      };
    }
    const memoryStoreId = memoryInputs[0]!.memoryStoreId;
    if (
      command.outputBehavior?.kind === "update_existing" &&
      command.outputBehavior.memoryStoreId !== memoryStoreId
    ) {
      return {
        type: "invalid_request",
        message: "An update_existing output must target the Dream input memory store",
      };
    }

    for (const input of command.inputs) {
      if (input.kind === "memory_store") {
        const store = await this.dependencies.memoryStores.find({
          workspaceId: this.dependencies.workspaceId,
          memoryStoreId: input.memoryStoreId,
        });
        if (store === null || store.archivedAt !== null) {
          return {
            type: "dependency_not_found",
            message: `Memory store ${input.memoryStoreId} was not found`,
          };
        }
        continue;
      }
      const uniqueSessionIds = new Set(input.sessionIds);
      if (
        input.sessionIds.length === 0 ||
        uniqueSessionIds.size !== input.sessionIds.length
      ) {
        return {
          type: "invalid_request",
          message: "Dream Session inputs must be non-empty and unique",
        };
      }
      for (const sessionId of input.sessionIds) {
        const session = await this.dependencies.sessions.find({
          workspaceId: this.dependencies.workspaceId,
          sessionId,
        });
        if (session === null) {
          return {
            type: "dependency_not_found",
            message: `Session ${sessionId} was not found`,
          };
        }
      }
    }

    const createdAt = this.dependencies.clock.now().toISOString();
    const dream: Dream = {
      id: this.dependencies.ids.nextDreamId(),
      archivedAt: null,
      createdAt,
      endedAt: null,
      error: null,
      inputs: structuredClone(command.inputs),
      instructions: command.instructions ?? null,
      model: {
        modelId: command.model.modelId,
        ...(command.model.speed != null && { speed: command.model.speed }),
      },
      outputBehavior: command.outputBehavior ?? { kind: "create_new" },
      outputs: [],
      sessionId: null,
      status: "pending",
      usage: {
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
      },
    };
    const inserted = await this.dependencies.store.insert({
      workspaceId: this.dependencies.workspaceId,
      dream,
    });
    const scheduled = await this.dependencies.execution.schedule({
      workspaceId: this.dependencies.workspaceId,
      dream: inserted.dream,
    });
    if (scheduled.type === "scheduled") {
      return { type: "created", dream: inserted.dream };
    }
    const failed: Dream = {
      ...inserted.dream,
      endedAt: this.dependencies.clock.now().toISOString(),
      error: { type: "scheduling_error", message: scheduled.message },
      status: "failed",
    };
    const replacement = await this.dependencies.store.replace({
      workspaceId: this.dependencies.workspaceId,
      dreamId: inserted.dream.id,
      expectedRevision: inserted.revision,
      next: failed,
    });
    if (replacement.type !== "replaced") {
      throw new Error(`Dream ${inserted.dream.id} changed while recording a scheduling failure`);
    }
    return { type: "created", dream: replacement.record.dream };
  }

  async retrieveDream(query: RetrieveDreamQuery): Promise<RetrieveDreamResult> {
    const record = await this.dependencies.store.find({
      workspaceId: this.dependencies.workspaceId,
      dreamId: query.dreamId,
    });
    return record === null
      ? { type: "not_found" }
      : { type: "found", dream: record.dream };
  }

  async listDreams(query: ListDreamsQuery): Promise<ListDreamsResult> {
    if (
      (query.createdAfter !== undefined &&
        !canonicalTimestamp(query.createdAfter)) ||
      (query.createdBefore !== undefined &&
        !canonicalTimestamp(query.createdBefore))
    ) {
      return {
        type: "invalid_request",
        message: "Dream timestamps must be canonical RFC 3339 values",
      };
    }
    const position = query.cursor === undefined
      ? undefined
      : decodeCursor(query.cursor);
    if (query.cursor !== undefined && position === null) {
      return { type: "invalid_request", message: "Invalid Dream page cursor" };
    }
    const pageSize = Math.min(
      Math.max(query.pageSize ?? DEFAULT_PAGE_SIZE, 1),
      MAX_PAGE_SIZE,
    );
    const records = await this.dependencies.store.list({
      workspaceId: this.dependencies.workspaceId,
      includeArchived: query.includeArchived ?? false,
      limit: pageSize + 1,
      ...(query.statuses !== undefined && query.statuses.length > 0 && {
        statuses: query.statuses,
      }),
      ...(query.createdAfter !== undefined && {
        createdAfter: query.createdAfter,
      }),
      ...(query.createdBefore !== undefined && {
        createdBefore: query.createdBefore,
      }),
      ...(position !== undefined && position !== null && { position }),
    });
    const page = records.slice(0, pageSize);
    return {
      type: "page",
      page: {
        dreams: page.map((record) => record.dream),
        nextCursor:
          records.length > pageSize && page.length > 0
            ? encodeCursor(page[page.length - 1]!)
            : null,
      },
    };
  }

  async cancelDream(command: { dreamId: string }): Promise<ChangeDreamStateResult> {
    const current = await this.dependencies.store.find({
      workspaceId: this.dependencies.workspaceId,
      dreamId: command.dreamId,
    });
    if (current === null) return { type: "not_found" };
    if (current.dream.status === "canceled") {
      return { type: "changed", dream: current.dream };
    }
    if (
      current.dream.status === "completed" ||
      current.dream.status === "failed"
    ) {
      return {
        type: "conflict",
        message: `Dream ${command.dreamId} cannot be canceled from ${current.dream.status}`,
      };
    }
    return changed(
      await this.dependencies.store.replace({
        workspaceId: this.dependencies.workspaceId,
        dreamId: command.dreamId,
        expectedRevision: current.revision,
        next: {
          ...current.dream,
          endedAt: this.dependencies.clock.now().toISOString(),
          status: "canceled",
        },
      }),
    );
  }

  async archiveDream(command: { dreamId: string }): Promise<ChangeDreamStateResult> {
    const current = await this.dependencies.store.find({
      workspaceId: this.dependencies.workspaceId,
      dreamId: command.dreamId,
    });
    if (current === null) return { type: "not_found" };
    if (current.dream.archivedAt !== null) {
      return { type: "changed", dream: current.dream };
    }
    if (
      current.dream.status === "pending" ||
      current.dream.status === "running"
    ) {
      return {
        type: "conflict",
        message: `Dream ${command.dreamId} must be terminal before it is archived`,
      };
    }
    return changed(
      await this.dependencies.store.replace({
        workspaceId: this.dependencies.workspaceId,
        dreamId: command.dreamId,
        expectedRevision: current.revision,
        next: {
          ...current.dream,
          archivedAt: this.dependencies.clock.now().toISOString(),
        },
      }),
    );
  }
}
