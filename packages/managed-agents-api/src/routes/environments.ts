import { Hono } from "hono";
import {
  resolveApplicationPort,
  type ApplicationPortSource,
} from "../application-port-source";
import { MANAGED_AGENTS_BETA, requireBeta } from "../beta";
import {
  deletedEnvironmentResponseSchema,
  environmentCreateBodySchema,
  environmentListQuerySchema,
  environmentPageResponseSchema,
  environmentResponseSchema,
  environmentUpdateBodySchema,
} from "../contracts/environments";
import { apiError, conflict, invalidRequest, notFound } from "../errors";
import {
  toArchiveEnvironmentCommand,
  toDeleteEnvironmentCommand,
  toCreateEnvironmentCommand,
  toEnvironmentResponse,
  toListEnvironmentsQuery,
  toRetrieveEnvironmentQuery,
  toUpdateEnvironmentCommand,
} from "../mappers/environments";
import type { EnvironmentsApplicationPort } from "../ports/environments";

export function buildEnvironmentRoutes(
  source: ApplicationPortSource<EnvironmentsApplicationPort>,
): Hono {
  const app = new Hono();
  app.use("*", requireBeta(MANAGED_AGENTS_BETA));

  app.post("/", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(invalidRequest("Request body must be valid JSON"), 400);
    }

    const parsed = environmentCreateBodySchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return c.json(
        invalidRequest(
          `Invalid request field ${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid value"}`,
        ),
        400,
      );
    }

    const result = await resolveApplicationPort(source, c).createEnvironment(
      toCreateEnvironmentCommand(parsed.data),
    );
    if (result.type === "invalid_request") {
      return c.json(invalidRequest(result.message), 400);
    }

    const response = environmentResponseSchema.safeParse(
      toEnvironmentResponse(result.environment),
    );
    if (!response.success) {
      return c.json(apiError("Application returned an invalid environment"), 500);
    }

    return c.json(response.data, 201);
  });

  app.get("/", async (c) => {
    const query = environmentListQuerySchema.safeParse({
      limit: c.req.query("limit"),
      page: c.req.query("page"),
      include_archived: c.req.query("include_archived"),
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

    const result = await resolveApplicationPort(source, c).listEnvironments(
      toListEnvironmentsQuery(query.data),
    );
    if (result.type === "invalid_request") {
      return c.json(invalidRequest(result.message), 400);
    }
    const response = environmentPageResponseSchema.safeParse({
      data: result.page.environments.map(toEnvironmentResponse),
      next_page: result.page.nextCursor,
    });
    if (!response.success) {
      return c.json(
        apiError("Application returned an invalid environment page"),
        500,
      );
    }

    return c.json(response.data, 200);
  });

  app.get("/:environmentId", async (c) => {
    const result = await resolveApplicationPort(source, c).retrieveEnvironment(
      toRetrieveEnvironmentQuery(c.req.param("environmentId")),
    );
    if (result.type === "not_found") {
      return c.json(
        notFound(`Environment ${c.req.param("environmentId")} was not found`),
        404,
      );
    }

    const response = environmentResponseSchema.safeParse(
      toEnvironmentResponse(result.environment),
    );
    if (!response.success) {
      return c.json(apiError("Application returned an invalid environment"), 500);
    }

    return c.json(response.data, 200);
  });

  app.post("/:environmentId", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(invalidRequest("Request body must be valid JSON"), 400);
    }

    const parsed = environmentUpdateBodySchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return c.json(
        invalidRequest(
          `Invalid request field ${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid value"}`,
        ),
        400,
      );
    }

    const result = await resolveApplicationPort(source, c).updateEnvironment(
      toUpdateEnvironmentCommand(c.req.param("environmentId"), parsed.data),
    );
    if (result.type === "invalid_request") {
      return c.json(invalidRequest(result.message), 400);
    }
    if (result.type === "version_conflict") {
      return c.json(conflict(result.message), 409);
    }
    if (result.type === "not_found") {
      return c.json(
        notFound(`Environment ${c.req.param("environmentId")} was not found`),
        404,
      );
    }

    const response = environmentResponseSchema.safeParse(
      toEnvironmentResponse(result.environment),
    );
    if (!response.success) {
      return c.json(apiError("Application returned an invalid environment"), 500);
    }

    return c.json(response.data, 200);
  });

  app.delete("/:environmentId", async (c) => {
    const result = await resolveApplicationPort(source, c).deleteEnvironment(
      toDeleteEnvironmentCommand(c.req.param("environmentId")),
    );
    if (result.type === "not_found") {
      return c.json(
        notFound(`Environment ${c.req.param("environmentId")} was not found`),
        404,
      );
    }

    const response = deletedEnvironmentResponseSchema.safeParse({
      id: result.environmentId,
      type: "environment_deleted",
    });
    if (!response.success) {
      return c.json(
        apiError("Application returned an invalid environment deletion result"),
        500,
      );
    }

    return c.json(response.data, 200);
  });

  app.post("/:environmentId/archive", async (c) => {
    const result = await resolveApplicationPort(source, c).archiveEnvironment(
      toArchiveEnvironmentCommand(c.req.param("environmentId")),
    );
    if (result.type === "not_found") {
      return c.json(
        notFound(`Environment ${c.req.param("environmentId")} was not found`),
        404,
      );
    }

    const response = environmentResponseSchema.safeParse(
      toEnvironmentResponse(result.environment),
    );
    if (!response.success) {
      return c.json(apiError("Application returned an invalid environment"), 500);
    }

    return c.json(response.data, 200);
  });

  return app;
}
