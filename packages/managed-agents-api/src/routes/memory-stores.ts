import { Hono } from "hono";
import {
  resolveApplicationPort,
  type ApplicationPortSource,
} from "../application-port-source";
import { AGENT_MEMORY_BETA, requireBeta } from "../beta";
import {
  deletedMemoryStoreResponseSchema,
  memoryStoreCreateBodySchema,
  memoryStoreListQuerySchema,
  memoryStorePageResponseSchema,
  memoryStoreResponseSchema,
  memoryStoreUpdateBodySchema,
} from "../contracts/memory-stores";
import { apiError, conflict, invalidRequest, notFound } from "../errors";
import {
  toArchiveMemoryStoreCommand,
  toCreateMemoryStoreCommand,
  toDeleteMemoryStoreCommand,
  toListMemoryStoresQuery,
  toMemoryStoreResponse,
  toRetrieveMemoryStoreQuery,
  toUpdateMemoryStoreCommand,
} from "../mappers/memory-stores";
import type { MemoryStoresApplicationPort } from "../ports/memory-stores";

function invalidField(error: { issues: { path: PropertyKey[]; message: string }[] }) {
  const issue = error.issues[0];
  return invalidRequest(
    `Invalid request field ${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid value"}`,
  );
}

export function buildMemoryStoreRoutes(
  source: ApplicationPortSource<MemoryStoresApplicationPort>,
): Hono {
  const app = new Hono();
  app.use("*", requireBeta(AGENT_MEMORY_BETA));

  app.post("/", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(invalidRequest("Request body must be valid JSON"), 400);
    }
    const parsed = memoryStoreCreateBodySchema.safeParse(body);
    if (!parsed.success) return c.json(invalidField(parsed.error), 400);
    const result = await resolveApplicationPort(source, c).createMemoryStore(
      toCreateMemoryStoreCommand(parsed.data),
    );
    if (result.type === "invalid_request") {
      return c.json(invalidRequest(result.message), 400);
    }
    const response = memoryStoreResponseSchema.safeParse(
      toMemoryStoreResponse(result.memoryStore),
    );
    if (!response.success) {
      return c.json(apiError("Application returned an invalid memory store"), 500);
    }
    return c.json(response.data, 201);
  });

  app.get("/", async (c) => {
    const query = memoryStoreListQuerySchema.safeParse({
      limit: c.req.query("limit"),
      page: c.req.query("page"),
      "created_at[gte]": c.req.query("created_at[gte]"),
      "created_at[lte]": c.req.query("created_at[lte]"),
      include_archived: c.req.query("include_archived"),
    });
    if (!query.success) return c.json(invalidField(query.error), 400);
    const result = await resolveApplicationPort(source, c).listMemoryStores(
      toListMemoryStoresQuery(query.data),
    );
    if (result.type === "invalid_request") {
      return c.json(invalidRequest(result.message), 400);
    }
    const response = memoryStorePageResponseSchema.safeParse({
      data: result.page.memoryStores.map(toMemoryStoreResponse),
      next_page: result.page.nextCursor,
    });
    if (!response.success) {
      return c.json(apiError("Application returned an invalid memory store page"), 500);
    }
    return c.json(response.data, 200);
  });

  app.get("/:memoryStoreId", async (c) => {
    const result = await resolveApplicationPort(source, c).retrieveMemoryStore(
      toRetrieveMemoryStoreQuery(c.req.param("memoryStoreId")),
    );
    if (result.type === "not_found") {
      return c.json(
        notFound(`Memory store ${c.req.param("memoryStoreId")} was not found`),
        404,
      );
    }
    const response = memoryStoreResponseSchema.safeParse(
      toMemoryStoreResponse(result.memoryStore),
    );
    if (!response.success) {
      return c.json(apiError("Application returned an invalid memory store"), 500);
    }
    return c.json(response.data, 200);
  });

  app.post("/:memoryStoreId", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(invalidRequest("Request body must be valid JSON"), 400);
    }
    const parsed = memoryStoreUpdateBodySchema.safeParse(body);
    if (!parsed.success) return c.json(invalidField(parsed.error), 400);
    const result = await resolveApplicationPort(source, c).updateMemoryStore(
      toUpdateMemoryStoreCommand(c.req.param("memoryStoreId"), parsed.data),
    );
    if (result.type === "invalid_request") {
      return c.json(invalidRequest(result.message), 400);
    }
    if (result.type === "version_conflict") {
      return c.json(conflict(result.message), 409);
    }
    if (result.type === "not_found") {
      return c.json(
        notFound(`Memory store ${c.req.param("memoryStoreId")} was not found`),
        404,
      );
    }
    const response = memoryStoreResponseSchema.safeParse(
      toMemoryStoreResponse(result.memoryStore),
    );
    if (!response.success) {
      return c.json(apiError("Application returned an invalid memory store"), 500);
    }
    return c.json(response.data, 200);
  });

  app.delete("/:memoryStoreId", async (c) => {
    const result = await resolveApplicationPort(source, c).deleteMemoryStore(
      toDeleteMemoryStoreCommand(c.req.param("memoryStoreId")),
    );
    if (result.type === "not_found") {
      return c.json(
        notFound(`Memory store ${c.req.param("memoryStoreId")} was not found`),
        404,
      );
    }
    const response = deletedMemoryStoreResponseSchema.safeParse({
      id: result.memoryStoreId,
      type: "memory_store_deleted",
    });
    if (!response.success) {
      return c.json(
        apiError("Application returned an invalid memory store deletion result"),
        500,
      );
    }
    return c.json(response.data, 200);
  });

  app.post("/:memoryStoreId/archive", async (c) => {
    const result = await resolveApplicationPort(source, c).archiveMemoryStore(
      toArchiveMemoryStoreCommand(c.req.param("memoryStoreId")),
    );
    if (result.type === "not_found") {
      return c.json(
        notFound(`Memory store ${c.req.param("memoryStoreId")} was not found`),
        404,
      );
    }
    const response = memoryStoreResponseSchema.safeParse(
      toMemoryStoreResponse(result.memoryStore),
    );
    if (!response.success) {
      return c.json(apiError("Application returned an invalid memory store"), 500);
    }
    return c.json(response.data, 200);
  });

  return app;
}
