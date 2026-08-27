import { Hono } from "hono";
import {
  resolveApplicationPort,
  type ApplicationPortSource,
} from "../application-port-source";
import { MANAGED_AGENTS_BETA, requireBeta } from "../beta";
import {
  deletedSessionResourceResponseSchema,
  sessionResourceAddBodySchema,
  sessionResourceListQuerySchema,
  sessionResourcePageResponseSchema,
  sessionResourceResponseSchema,
  sessionResourceUpdateBodySchema,
} from "../contracts/session-resources";
import { apiError, conflict, invalidRequest, notFound } from "../errors";
import {
  toDeleteSessionResourceCommand,
  toAddSessionFileResourceCommand,
  toListSessionResourcesQuery,
  toRetrieveSessionResourceQuery,
  toSessionResourceResponse,
  toUpdateSessionResourceCommand,
} from "../mappers/session-resources";
import type { SessionResourcesApplicationPort } from "../ports/session-resources";

export function buildSessionResourceRoutes(
  source: ApplicationPortSource<SessionResourcesApplicationPort>,
): Hono {
  const app = new Hono();
  app.use("*", requireBeta(MANAGED_AGENTS_BETA));

  app.get("/:sessionId/resources", async (c) => {
    const query = sessionResourceListQuerySchema.safeParse({
      limit: c.req.query("limit"),
      page: c.req.query("page"),
    });
    if (!query.success) {
      const issue = query.error.issues[0];
      return c.json(
        invalidRequest(
          `Invalid request field ${issue?.path.join(".") || "query"}: ${issue?.message ?? "invalid value"}`,
        ),
        400,
      );
    }

    const result = await resolveApplicationPort(source, c).listSessionResources(
      toListSessionResourcesQuery(c.req.param("sessionId"), query.data),
    );
    if (result.type === "invalid_request") {
      return c.json(invalidRequest(result.message), 400);
    }
    if (result.type === "not_found") {
      return c.json(
        notFound(`Session ${c.req.param("sessionId")} was not found`),
        404,
      );
    }

    const response = sessionResourcePageResponseSchema.safeParse({
      data: result.page.resources.map(toSessionResourceResponse),
      next_page: result.page.nextCursor,
    });
    if (!response.success) {
      return c.json(
        apiError("Application returned an invalid session resource page"),
        500,
      );
    }

    return c.json(response.data, 200);
  });

  app.post("/:sessionId/resources", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(invalidRequest("Request body must be valid JSON"), 400);
    }

    const parsed = sessionResourceAddBodySchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return c.json(
        invalidRequest(
          `Invalid request field ${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid value"}`,
        ),
        400,
      );
    }

    const result = await resolveApplicationPort(source, c).addSessionFileResource(
      toAddSessionFileResourceCommand(c.req.param("sessionId"), parsed.data),
    );
    if (result.type === "invalid_request") {
      return c.json(invalidRequest(result.message), 400);
    }
    if (result.type === "version_conflict") {
      return c.json(conflict(result.message), 409);
    }
    if (result.type === "dependency_not_found") {
      return c.json(notFound(result.message), 404);
    }
    if (result.type === "not_found") {
      return c.json(
        notFound(`Session ${c.req.param("sessionId")} was not found`),
        404,
      );
    }

    const response = sessionResourceResponseSchema.safeParse(
      toSessionResourceResponse(result.resource),
    );
    if (!response.success) {
      return c.json(
        apiError("Application returned an invalid session resource"),
        500,
      );
    }

    return c.json(response.data, 200);
  });

  app.get("/:sessionId/resources/:resourceId", async (c) => {
    const result = await resolveApplicationPort(source, c).retrieveSessionResource(
      toRetrieveSessionResourceQuery(
        c.req.param("sessionId"),
        c.req.param("resourceId"),
      ),
    );
    if (result.type === "not_found") {
      return c.json(
        notFound(`Session resource ${c.req.param("resourceId")} was not found`),
        404,
      );
    }

    const response = sessionResourceResponseSchema.safeParse(
      toSessionResourceResponse(result.resource),
    );
    if (!response.success) {
      return c.json(
        apiError("Application returned an invalid session resource"),
        500,
      );
    }

    return c.json(response.data, 200);
  });

  app.post("/:sessionId/resources/:resourceId", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(invalidRequest("Request body must be valid JSON"), 400);
    }

    const parsed = sessionResourceUpdateBodySchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return c.json(
        invalidRequest(
          `Invalid request field ${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid value"}`,
        ),
        400,
      );
    }

    const result = await resolveApplicationPort(source, c).updateSessionResource(
      toUpdateSessionResourceCommand(
        c.req.param("sessionId"),
        c.req.param("resourceId"),
        parsed.data,
      ),
    );
    if (result.type === "invalid_request") {
      return c.json(invalidRequest(result.message), 400);
    }
    if (result.type === "version_conflict") {
      return c.json(conflict(result.message), 409);
    }
    if (result.type === "not_found") {
      return c.json(
        notFound(`Session resource ${c.req.param("resourceId")} was not found`),
        404,
      );
    }

    const response = sessionResourceResponseSchema.safeParse(
      toSessionResourceResponse(result.resource),
    );
    if (!response.success) {
      return c.json(
        apiError("Application returned an invalid session resource"),
        500,
      );
    }

    return c.json(response.data, 200);
  });

  app.delete("/:sessionId/resources/:resourceId", async (c) => {
    const result = await resolveApplicationPort(source, c).deleteSessionResource(
      toDeleteSessionResourceCommand(
        c.req.param("sessionId"),
        c.req.param("resourceId"),
      ),
    );
    if (result.type === "version_conflict") {
      return c.json(conflict(result.message), 409);
    }
    if (result.type === "not_found") {
      return c.json(
        notFound(`Session resource ${c.req.param("resourceId")} was not found`),
        404,
      );
    }

    const response = deletedSessionResourceResponseSchema.safeParse({
      id: result.resourceId,
      type: "session_resource_deleted",
    });
    if (!response.success) {
      return c.json(
        apiError("Application returned an invalid session resource deletion result"),
        500,
      );
    }

    return c.json(response.data, 200);
  });

  return app;
}
