import { Hono } from "hono";
import {
  resolveApplicationPort,
  type ApplicationPortSource,
} from "../application-port-source";
import { AGENT_MEMORY_BETA, requireBeta } from "../beta";
import {
  memoryVersionListQuerySchema,
  memoryVersionPageResponseSchema,
  memoryVersionResponseSchema,
  memoryVersionRetrieveQuerySchema,
} from "../contracts/memory-versions";
import { apiError, conflict, invalidRequest, notFound } from "../errors";
import {
  toListMemoryVersionsQuery,
  toMemoryVersionResponse,
  toRedactMemoryVersionCommand,
  toRetrieveMemoryVersionQuery,
} from "../mappers/memory-versions";
import type { MemoryVersionsApplicationPort } from "../ports/memory-versions";

function invalidField(error: { issues: { path: PropertyKey[]; message: string }[] }) {
  const issue = error.issues[0];
  return invalidRequest(
    `Invalid request field ${issue?.path.join(".") || "query"}: ${issue?.message ?? "invalid value"}`,
  );
}

export function buildMemoryVersionRoutes(
  source: ApplicationPortSource<MemoryVersionsApplicationPort>,
): Hono {
  const app = new Hono();
  app.use("*", requireBeta(AGENT_MEMORY_BETA));

  app.get("/:memoryStoreId/memory_versions", async (c) => {
    const query = memoryVersionListQuerySchema.safeParse({
      limit: c.req.query("limit"),
      page: c.req.query("page"),
      api_key_id: c.req.query("api_key_id"),
      "created_at[gte]": c.req.query("created_at[gte]"),
      "created_at[lte]": c.req.query("created_at[lte]"),
      memory_id: c.req.query("memory_id"),
      operation: c.req.query("operation"),
      service_account_id: c.req.query("service_account_id"),
      session_id: c.req.query("session_id"),
      view: c.req.query("view"),
    });
    if (!query.success) return c.json(invalidField(query.error), 400);
    const result = await resolveApplicationPort(source, c).listMemoryVersions(
      toListMemoryVersionsQuery(c.req.param("memoryStoreId"), query.data),
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
    const response = memoryVersionPageResponseSchema.safeParse({
      data: result.page.versions.map(toMemoryVersionResponse),
      next_page: result.page.nextCursor,
    });
    if (!response.success) {
      return c.json(apiError("Application returned an invalid memory version page"), 500);
    }
    return c.json(response.data, 200);
  });

  app.get("/:memoryStoreId/memory_versions/:memoryVersionId", async (c) => {
    const query = memoryVersionRetrieveQuerySchema.safeParse({
      view: c.req.query("view"),
    });
    if (!query.success) return c.json(invalidField(query.error), 400);
    const result = await resolveApplicationPort(source, c).retrieveMemoryVersion(
      toRetrieveMemoryVersionQuery(
        c.req.param("memoryStoreId"),
        c.req.param("memoryVersionId"),
        query.data,
      ),
    );
    if (result.type === "not_found") {
      return c.json(
        notFound(
          `Memory version ${c.req.param("memoryVersionId")} was not found`,
        ),
        404,
      );
    }
    const response = memoryVersionResponseSchema.safeParse(
      toMemoryVersionResponse(result.version),
    );
    if (!response.success) {
      return c.json(apiError("Application returned an invalid memory version"), 500);
    }
    return c.json(response.data, 200);
  });

  app.post(
    "/:memoryStoreId/memory_versions/:memoryVersionId/redact",
    async (c) => {
      const result = await resolveApplicationPort(source, c).redactMemoryVersion(
        toRedactMemoryVersionCommand(
          c.req.param("memoryStoreId"),
          c.req.param("memoryVersionId"),
        ),
      );
      if (result.type === "not_found") {
        return c.json(
          notFound(
            `Memory version ${c.req.param("memoryVersionId")} was not found`,
          ),
          404,
        );
      }
      if (result.type === "version_conflict") {
        return c.json(conflict(result.message), 409);
      }
      const response = memoryVersionResponseSchema.safeParse(
        toMemoryVersionResponse(result.version),
      );
      if (!response.success) {
        return c.json(
          apiError("Application returned an invalid memory version"),
          500,
        );
      }
      return c.json(response.data, 200);
    },
  );

  return app;
}
