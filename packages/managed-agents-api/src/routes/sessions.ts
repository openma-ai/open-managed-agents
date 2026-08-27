import { Hono } from "hono";
import {
  resolveApplicationPort,
  type ApplicationPortSource,
} from "../application-port-source";
import { MANAGED_AGENTS_BETA, requireBeta } from "../beta";
import {
  deletedSessionResponseSchema,
  sessionCreateBodySchema,
  sessionListQuerySchema,
  sessionPageResponseSchema,
  sessionResponseSchema,
  sessionUpdateBodySchema,
} from "../contracts/sessions";
import { apiError, conflict, invalidRequest, notFound } from "../errors";
import {
  toCreateSessionCommand,
  toListSessionsQuery,
  toSessionResponse,
  toUpdateSessionCommand,
} from "../mappers/sessions";
import type { SessionView } from "../ports/sessions";
import type {
  ListSessionsPage,
  SessionsApplicationPort,
} from "../ports/sessions";

function serializeSession(session: SessionView): object | null {
  try {
    const parsed = sessionResponseSchema.safeParse(toSessionResponse(session));
    return parsed.success ? (parsed.data as object) : null;
  } catch {
    return null;
  }
}

function serializeSessionPage(page: ListSessionsPage): object | null {
  try {
    const parsed = sessionPageResponseSchema.safeParse({
      data: page.sessions.map(toSessionResponse),
      next_page: page.nextCursor,
      prev_page: page.previousCursor,
    });
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function buildSessionRoutes(
  source: ApplicationPortSource<SessionsApplicationPort>,
): Hono {
  const app = new Hono();
  app.use("*", requireBeta(MANAGED_AGENTS_BETA));

  app.get("/", async (c) => {
    const query = sessionListQuerySchema.safeParse({
      limit: c.req.query("limit"),
      page: c.req.query("page"),
      agent_id: c.req.query("agent_id"),
      agent_version: c.req.query("agent_version"),
      "created_at[gt]": c.req.query("created_at[gt]"),
      "created_at[gte]": c.req.query("created_at[gte]"),
      "created_at[lt]": c.req.query("created_at[lt]"),
      "created_at[lte]": c.req.query("created_at[lte]"),
      deployment_id: c.req.query("deployment_id"),
      include_archived: c.req.query("include_archived"),
      memory_store_id: c.req.query("memory_store_id"),
      order: c.req.query("order"),
      statuses: c.req.queries("statuses[]"),
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

    const result = await resolveApplicationPort(source, c).listSessions(
      toListSessionsQuery(query.data),
    );
    if (result.type === "invalid_request") {
      return c.json(invalidRequest(result.message), 400);
    }
    const page = serializeSessionPage(result.page);
    if (page === null) {
      return c.json(apiError("Application returned an invalid session page"), 500);
    }

    return c.json(page, 200);
  });

  app.get("/:sessionId", async (c) => {
    const result = await resolveApplicationPort(source, c).retrieveSession({
      sessionId: c.req.param("sessionId"),
    });
    if (result.type === "not_found") {
      return c.json(
        notFound(`Session ${c.req.param("sessionId")} was not found`),
        404,
      );
    }

    const session = serializeSession(result.session);
    if (session === null) {
      return c.json(apiError("Application returned an invalid session resource"), 500);
    }

    return c.json(session, 200);
  });

  app.delete("/:sessionId", async (c) => {
    const result = await resolveApplicationPort(source, c).deleteSession({
      sessionId: c.req.param("sessionId"),
    });
    if (result.type === "not_found") {
      return c.json(
        notFound(`Session ${c.req.param("sessionId")} was not found`),
        404,
      );
    }

    const response = deletedSessionResponseSchema.safeParse({
      id: result.sessionId,
      type: "session_deleted",
    });
    if (!response.success) {
      return c.json(
        apiError("Application returned an invalid session deletion result"),
        500,
      );
    }

    return c.json(response.data, 200);
  });

  app.post("/:sessionId/archive", async (c) => {
    const result = await resolveApplicationPort(source, c).archiveSession({
      sessionId: c.req.param("sessionId"),
    });
    if (result.type === "not_found") {
      return c.json(
        notFound(`Session ${c.req.param("sessionId")} was not found`),
        404,
      );
    }

    const session = serializeSession(result.session);
    if (session === null) {
      return c.json(apiError("Application returned an invalid session resource"), 500);
    }

    return c.json(session, 200);
  });

  app.post("/:sessionId", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(invalidRequest("Request body must be valid JSON"), 400);
    }

    const parsed = sessionUpdateBodySchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return c.json(
        invalidRequest(
          `Invalid request field ${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid value"}`,
        ),
        400,
      );
    }

    const result = await resolveApplicationPort(source, c).updateSession(
      toUpdateSessionCommand(c.req.param("sessionId"), parsed.data),
    );
    if (result.type === "invalid_request") {
      return c.json(invalidRequest(result.message), 400);
    }
    if (result.type === "version_conflict") {
      return c.json(conflict(result.message), 409);
    }
    if (result.type === "not_found") {
      return c.json(
        notFound(`Session ${c.req.param("sessionId")} was not found`),
        404,
      );
    }

    const session = serializeSession(result.session);
    if (session === null) {
      return c.json(apiError("Application returned an invalid session resource"), 500);
    }

    return c.json(session, 200);
  });

  app.post("/", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(invalidRequest("Request body must be valid JSON"), 400);
    }

    const parsed = sessionCreateBodySchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return c.json(
        invalidRequest(
          `Invalid request field ${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid value"}`,
        ),
        400,
      );
    }

    const result = await resolveApplicationPort(source, c).createSession(
      toCreateSessionCommand(parsed.data),
    );
    if (result.type === "invalid_request") {
      return c.json(invalidRequest(result.message), 400);
    }
    if (result.type === "dependency_not_found") {
      return c.json(notFound(result.message), 404);
    }

    const session = serializeSession(result.session);
    if (session === null) {
      return c.json(apiError("Application returned an invalid session resource"), 500);
    }

    return c.json(session, 201);
  });

  return app;
}
