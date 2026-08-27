import type { DreamCreateBody, DreamListQuery } from "../contracts/dreams";
import type {
  CreateDreamCommand,
  Dream,
  DreamInput,
  DreamOutputBehavior,
  ListDreamsQuery,
} from "../ports/dreams";

type WireDreamInput = DreamCreateBody["inputs"][number];

function toDreamInput(input: WireDreamInput): DreamInput {
  return input.type === "memory_store"
    ? { kind: "memory_store", memoryStoreId: input.memory_store_id }
    : { kind: "sessions", sessionIds: input.session_ids };
}

function toOutputBehavior(
  behavior: NonNullable<DreamCreateBody["output_behavior"]>,
): DreamOutputBehavior {
  return behavior.type === "create_new"
    ? { kind: "create_new" }
    : {
        kind: "update_existing",
        memoryStoreId: behavior.memory_store_id,
      };
}

export function toCreateDreamCommand(body: DreamCreateBody): CreateDreamCommand {
  return {
    inputs: body.inputs.map(toDreamInput),
    model:
      typeof body.model === "string"
        ? { modelId: body.model }
        : {
            modelId: body.model.id,
            ...(body.model.speed !== undefined && { speed: body.model.speed }),
          },
    ...(body.instructions !== undefined && {
      instructions: body.instructions,
    }),
    ...(body.output_behavior !== undefined && {
      outputBehavior: toOutputBehavior(body.output_behavior),
    }),
  };
}

export function toListDreamsQuery(query: DreamListQuery): ListDreamsQuery {
  return {
    ...(query.limit !== undefined && { pageSize: query.limit }),
    ...(query.page != null && { cursor: query.page }),
    ...(query["created_at[gt]"] !== undefined && {
      createdAfter: query["created_at[gt]"],
    }),
    ...(query["created_at[lt]"] !== undefined && {
      createdBefore: query["created_at[lt]"],
    }),
    ...(query.include_archived !== undefined && {
      includeArchived: query.include_archived,
    }),
    ...(query.statuses !== undefined && { statuses: query.statuses }),
  };
}

function fromDreamInput(input: DreamInput): object {
  return input.kind === "memory_store"
    ? { type: "memory_store", memory_store_id: input.memoryStoreId }
    : { type: "sessions", session_ids: input.sessionIds };
}

function fromOutputBehavior(behavior: DreamOutputBehavior): object {
  return behavior.kind === "create_new"
    ? { type: "create_new" }
    : {
        type: "update_existing",
        memory_store_id: behavior.memoryStoreId,
      };
}

export function toDreamResponse(dream: Dream): object {
  return {
    id: dream.id,
    archived_at: dream.archivedAt,
    created_at: dream.createdAt,
    ended_at: dream.endedAt,
    error: dream.error,
    inputs: dream.inputs.map(fromDreamInput),
    instructions: dream.instructions,
    model: {
      id: dream.model.modelId,
      ...(dream.model.speed !== undefined && { speed: dream.model.speed }),
    },
    output_behavior: fromOutputBehavior(dream.outputBehavior),
    outputs: dream.outputs.map((output) => ({
      type: "memory_store",
      memory_store_id: output.memoryStoreId,
    })),
    session_id: dream.sessionId,
    status: dream.status,
    type: "dream",
    usage: {
      cache_creation_input_tokens: dream.usage.cacheCreationInputTokens,
      cache_read_input_tokens: dream.usage.cacheReadInputTokens,
      input_tokens: dream.usage.inputTokens,
      output_tokens: dream.usage.outputTokens,
    },
  };
}
