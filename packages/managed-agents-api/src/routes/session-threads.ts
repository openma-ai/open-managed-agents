import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  resolveApplicationPort,
  type ApplicationPortSource,
} from "../application-port-source";
import { MANAGED_AGENTS_BETA, requireBeta } from "../beta";
import {
  sessionEventPageResponseSchema,
  sessionStreamEventResponseSchema,
} from "../contracts/session-events";
import {
  sessionThreadEventListQuerySchema,
  sessionThreadEventStreamQuerySchema,
} from "../contracts/session-thread-events";
import {
  sessionThreadListQuerySchema,
  sessionThreadPageResponseSchema,
  sessionThreadResponseSchema,
} from "../contracts/session-threads";
import { apiError, invalidRequest, notFound } from "../errors";
import {
  toSessionEventResponse,
  toStreamSessionEventResponse,
} from "../mappers/session-events";
import {
  toListSessionThreadEventsQuery,
  toStreamSessionThreadEventsQuery,
} from "../mappers/session-thread-events";
import {
  toArchiveSessionThreadCommand,
  toListSessionThreadsQuery,
  toSessionThreadResponse,
  toRetrieveSessionThreadQuery,
} from "../mappers/session-threads";
import type { SessionThreadsApplicationPort } from "../ports/session-threads";
import type { SessionThreadEventsApplicationPort } from "../ports/session-thread-events";

export function buildSessionThreadRoutes(
  source: ApplicationPortSource<SessionThreadsApplicationPort>,
  eventSource: ApplicationPortSource<SessionThreadEventsApplicationPort>,
): Hono {
  const app = new Hono();
  app.use("*", requireBeta(MANAGED_AGENTS_BETA));

  app.get("/:sessionId/threads", async (c) => {
    const query = sessionThreadListQuerySchema.safeParse({
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

    const result = await resolveApplicationPort(source, c).listSessionThreads(
      toListSessionThreadsQuery(c.req.param("sessionId"), query.data),
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

    const response = sessionThreadPageResponseSchema.safeParse({
      data: result.page.threads.map(toSessionThreadResponse),
      next_page: result.page.nextCursor,
    });
    if (!response.success) {
      return c.json(
        apiError("Application returned an invalid session thread page"),
        500,
      );
    }

    return c.json(response.data, 200);
  });

  app.get("/:sessionId/threads/:threadId", async (c) => {
    const result = await resolveApplicationPort(source, c).retrieveSessionThread(
      toRetrieveSessionThreadQuery(
        c.req.param("sessionId"),
        c.req.param("threadId"),
      ),
    );
    if (result.type === "not_found") {
      return c.json(
        notFound(`Session thread ${c.req.param("threadId")} was not found`),
        404,
      );
    }

    const response = sessionThreadResponseSchema.safeParse(
      toSessionThreadResponse(result.thread),
    );
    if (!response.success) {
      return c.json(
        apiError("Application returned an invalid session thread"),
        500,
      );
    }

    return c.json(response.data, 200);
  });

  app.post("/:sessionId/threads/:threadId/archive", async (c) => {
    const result = await resolveApplicationPort(source, c).archiveSessionThread(
      toArchiveSessionThreadCommand(
        c.req.param("sessionId"),
        c.req.param("threadId"),
      ),
    );
    if (result.type === "not_found") {
      return c.json(
        notFound(`Session thread ${c.req.param("threadId")} was not found`),
        404,
      );
    }

    const response = sessionThreadResponseSchema.safeParse(
      toSessionThreadResponse(result.thread),
    );
    if (!response.success) {
      return c.json(
        apiError("Application returned an invalid session thread"),
        500,
      );
    }

    return c.json(response.data, 200);
  });

  app.get("/:sessionId/threads/:threadId/events", async (c) => {
    const query = sessionThreadEventListQuerySchema.safeParse({
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

    const result = await resolveApplicationPort(
      eventSource,
      c,
    ).listSessionThreadEvents(
      toListSessionThreadEventsQuery(
        c.req.param("sessionId"),
        c.req.param("threadId"),
        query.data,
      ),
    );
    if (result.type === "invalid_request") {
      return c.json(invalidRequest(result.message), 400);
    }
    if (result.type === "not_found") {
      return c.json(
        notFound(`Session thread ${c.req.param("threadId")} was not found`),
        404,
      );
    }

    const response = sessionEventPageResponseSchema.safeParse({
      data: result.page.events.map(toSessionEventResponse),
      next_page: result.page.nextCursor,
    });
    if (!response.success) {
      return c.json(
        apiError("Application returned an invalid session thread event page"),
        500,
      );
    }

    return c.json(response.data, 200);
  });

  app.get("/:sessionId/threads/:threadId/stream", async (c) => {
    const query = sessionThreadEventStreamQuerySchema.safeParse({
      event_deltas: c.req.queries("event_deltas[]"),
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

    const result = await resolveApplicationPort(
      eventSource,
      c,
    ).streamSessionThreadEvents(
      toStreamSessionThreadEventsQuery(
        c.req.param("sessionId"),
        c.req.param("threadId"),
        query.data,
      ),
    );
    if (result.type === "not_found") {
      return c.json(
        notFound(`Session thread ${c.req.param("threadId")} was not found`),
        404,
      );
    }

    return streamSSE(c, async (stream) => {
      for await (const event of result.events) {
        const wire = sessionStreamEventResponseSchema.safeParse(
          toStreamSessionEventResponse(event),
        );
        if (!wire.success) {
          throw new Error("Application returned an invalid streamed session thread event");
        }
        await stream.writeSSE({
          event: wire.data.type,
          data: JSON.stringify(wire.data),
        });
      }
    });
  });

  return app;
}
