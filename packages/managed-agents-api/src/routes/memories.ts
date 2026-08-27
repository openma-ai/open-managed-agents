import { Hono } from "hono";
import {
  resolveApplicationPort,
  type ApplicationPortSource,
} from "../application-port-source";
import { AGENT_MEMORY_BETA, requireBeta } from "../beta";
import {
  deletedMemoryResponseSchema,
  memoryCreateBodySchema,
  memoryDeleteQuerySchema,
  memoryListQuerySchema,
  memoryPageResponseSchema,
  memoryProjectionQuerySchema,
  memoryResponseSchema,
  memoryUpdateBodySchema,
} from "../contracts/memories";
import {
  apiError,
  conflict,
  invalidRequest,
  memoryPathConflict,
  memoryPreconditionFailed,
  notFound,
} from "../errors";
import {
  toCreateMemoryCommand,
  toDeleteMemoryCommand,
  toListMemoriesQuery,
  toMemoryListItemResponse,
  toMemoryResponse,
  toRetrieveMemoryQuery,
  toUpdateMemoryCommand,
} from "../mappers/memories";
import type { MemoriesApplicationPort } from "../ports/memories";

function invalidField(error: { issues: { path: PropertyKey[]; message: string }[] }) {
  const issue = error.issues[0];
  return invalidRequest(
    `Invalid request field ${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid value"}`,
  );
}

export function buildMemoryRoutes(
  source: ApplicationPortSource<MemoriesApplicationPort>,
): Hono {
  const app = new Hono();
  app.use("*", requireBeta(AGENT_MEMORY_BETA));

  app.post("/:memoryStoreId/memories", async (c) => {
    const query = memoryProjectionQuerySchema.safeParse({
      view: c.req.query("view"),
    });
    if (!query.success) return c.json(invalidField(query.error), 400);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(invalidRequest("Request body must be valid JSON"), 400);
    }
    const parsed = memoryCreateBodySchema.safeParse(body);
    if (!parsed.success) return c.json(invalidField(parsed.error), 400);

    const result = await resolveApplicationPort(source, c).createMemory(
      toCreateMemoryCommand(
        c.req.param("memoryStoreId"),
        parsed.data,
        query.data,
      ),
    );
    if (result.type === "invalid_request") {
      return c.json(invalidRequest(result.message), 400);
    }
    if (result.type === "not_found") {
      return c.json(
        notFound(`Memory store ${c.req.param("memoryStoreId")} was not found`),
        404,
      );
    }
    if (result.type === "path_conflict") {
      return c.json(
        memoryPathConflict({
          message: result.conflict.message ?? "Memory path conflict",
          ...(result.conflict.conflictingMemoryId !== undefined && {
            conflictingMemoryId: result.conflict.conflictingMemoryId,
          }),
          ...(result.conflict.conflictingPath !== undefined && {
            conflictingPath: result.conflict.conflictingPath,
          }),
        }),
        409,
      );
    }
    if (result.type === "conflict") {
      return c.json(conflict(result.message ?? "Memory conflict"), 409);
    }
    const response = memoryResponseSchema.safeParse(
      toMemoryResponse(result.memory),
    );
    if (!response.success) {
      return c.json(apiError("Application returned an invalid memory"), 500);
    }
    return c.json(response.data, 201);
  });

  app.get("/:memoryStoreId/memories", async (c) => {
    const query = memoryListQuerySchema.safeParse({
      limit: c.req.query("limit"),
      page: c.req.query("page"),
      depth: c.req.query("depth"),
      path_prefix: c.req.query("path_prefix"),
      view: c.req.query("view"),
    });
    if (!query.success) return c.json(invalidField(query.error), 400);
    const result = await resolveApplicationPort(source, c).listMemories(
      toListMemoriesQuery(c.req.param("memoryStoreId"), query.data),
    );
    if (result.type === "not_found") {
      return c.json(
        notFound(`Memory store ${c.req.param("memoryStoreId")} was not found`),
        404,
      );
    }
    if (result.type === "invalid_request") {
      return c.json(invalidRequest(result.message), 400);
    }
    const response = memoryPageResponseSchema.safeParse({
      data: result.page.items.map(toMemoryListItemResponse),
      next_page: result.page.nextCursor,
    });
    if (!response.success) {
      return c.json(apiError("Application returned an invalid memory page"), 500);
    }
    return c.json(response.data, 200);
  });

  app.get("/:memoryStoreId/memories/:memoryId", async (c) => {
    const query = memoryProjectionQuerySchema.safeParse({
      view: c.req.query("view"),
    });
    if (!query.success) return c.json(invalidField(query.error), 400);
    const result = await resolveApplicationPort(source, c).retrieveMemory(
      toRetrieveMemoryQuery(
        c.req.param("memoryStoreId"),
        c.req.param("memoryId"),
        query.data,
      ),
    );
    if (result.type === "not_found") {
      return c.json(notFound(`Memory ${c.req.param("memoryId")} was not found`), 404);
    }
    const response = memoryResponseSchema.safeParse(
      toMemoryResponse(result.memory),
    );
    if (!response.success) {
      return c.json(apiError("Application returned an invalid memory"), 500);
    }
    return c.json(response.data, 200);
  });

  app.post("/:memoryStoreId/memories/:memoryId", async (c) => {
    const query = memoryProjectionQuerySchema.safeParse({
      view: c.req.query("view"),
    });
    if (!query.success) return c.json(invalidField(query.error), 400);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(invalidRequest("Request body must be valid JSON"), 400);
    }
    const parsed = memoryUpdateBodySchema.safeParse(body);
    if (!parsed.success) return c.json(invalidField(parsed.error), 400);

    const result = await resolveApplicationPort(source, c).updateMemory(
      toUpdateMemoryCommand(
        c.req.param("memoryStoreId"),
        c.req.param("memoryId"),
        parsed.data,
        query.data,
      ),
    );
    if (result.type === "invalid_request") {
      return c.json(invalidRequest(result.message), 400);
    }
    if (result.type === "not_found") {
      return c.json(notFound(`Memory ${c.req.param("memoryId")} was not found`), 404);
    }
    if (result.type === "precondition_failed") {
      return c.json(
        memoryPreconditionFailed(result.message ?? "Memory precondition failed"),
        409,
      );
    }
    if (result.type === "path_conflict") {
      return c.json(
        memoryPathConflict({
          message: result.conflict.message ?? "Memory path conflict",
          ...(result.conflict.conflictingMemoryId !== undefined && {
            conflictingMemoryId: result.conflict.conflictingMemoryId,
          }),
          ...(result.conflict.conflictingPath !== undefined && {
            conflictingPath: result.conflict.conflictingPath,
          }),
        }),
        409,
      );
    }
    if (result.type === "conflict") {
      return c.json(conflict(result.message ?? "Memory conflict"), 409);
    }
    const response = memoryResponseSchema.safeParse(
      toMemoryResponse(result.memory),
    );
    if (!response.success) {
      return c.json(apiError("Application returned an invalid memory"), 500);
    }
    return c.json(response.data, 200);
  });

  app.delete("/:memoryStoreId/memories/:memoryId", async (c) => {
    const query = memoryDeleteQuerySchema.safeParse({
      expected_content_sha256: c.req.query("expected_content_sha256"),
    });
    if (!query.success) return c.json(invalidField(query.error), 400);
    const result = await resolveApplicationPort(source, c).deleteMemory(
      toDeleteMemoryCommand(
        c.req.param("memoryStoreId"),
        c.req.param("memoryId"),
        query.data.expected_content_sha256,
      ),
    );
    if (result.type === "not_found") {
      return c.json(notFound(`Memory ${c.req.param("memoryId")} was not found`), 404);
    }
    if (result.type === "precondition_failed") {
      return c.json(
        memoryPreconditionFailed(result.message ?? "Memory precondition failed"),
        409,
      );
    }
    if (result.type === "conflict") {
      return c.json(conflict(result.message ?? "Memory conflict"), 409);
    }
    const response = deletedMemoryResponseSchema.safeParse({
      id: result.memoryId,
      type: "memory_deleted",
    });
    if (!response.success) {
      return c.json(apiError("Application returned an invalid memory deletion result"), 500);
    }
    return c.json(response.data, 200);
  });

  return app;
}
