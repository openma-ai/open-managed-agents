import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  resolveApplicationPort,
  type ApplicationPortSource,
} from "../application-port-source";
import { MANAGED_AGENTS_BETA, requireBeta } from "../beta";
import {
  sessionEventListQuerySchema,
  sessionEventPageResponseSchema,
  sessionEventSendBodySchema,
  sessionEventSendResponseSchema,
  sessionEventStreamQuerySchema,
  sessionStreamEventResponseSchema,
} from "../contracts/session-events";
import { apiError, invalidRequest, notFound } from "../errors";
import {
  toListSessionEventsQuery,
  toSendSessionEventsCommand,
  toSessionEventResponse,
  toSentSessionEventResponse,
  toStreamSessionEventResponse,
  toStreamSessionEventsQuery,
} from "../mappers/session-events";
import type { SessionEventsApplicationPort } from "../ports/session-events";

export function buildSessionEventRoutes(
  source: ApplicationPortSource<SessionEventsApplicationPort>,
): Hono {
  const app = new Hono();
  app.use("*", requireBeta(MANAGED_AGENTS_BETA));

  app.get("/:sessionId/events", async (c) => {
    const query = sessionEventListQuerySchema.safeParse({
      limit: c.req.query("limit"),
      page: c.req.query("page"),
      "created_at[gt]": c.req.query("created_at[gt]"),
      "created_at[gte]": c.req.query("created_at[gte]"),
      "created_at[lt]": c.req.query("created_at[lt]"),
      "created_at[lte]": c.req.query("created_at[lte]"),
      order: c.req.query("order"),
      types: c.req.queries("types[]"),
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

    const result = await resolveApplicationPort(source, c).listSessionEvents(
      toListSessionEventsQuery(c.req.param("sessionId"), query.data),
    );
    if (result.type === "not_found") {
      return c.json(
        notFound(`Session ${c.req.param("sessionId")} was not found`),
        404,
      );
    }
    if (result.type === "invalid_request") {
      return c.json(invalidRequest(result.message), 400);
    }

    let response: object;
    try {
      response = {
        data: result.page.events.map(toSessionEventResponse),
        next_page: result.page.nextCursor,
      };
    } catch {
      return c.json(apiError("Application returned an invalid session event page"), 500);
    }

    const wire = sessionEventPageResponseSchema.safeParse(response);
    if (!wire.success) {
      return c.json(apiError("Application returned an invalid session event page"), 500);
    }

    return c.json(wire.data, 200);
  });

  app.get("/:sessionId/events/stream", async (c) => {
    const query = sessionEventStreamQuerySchema.safeParse({
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

    const result = await resolveApplicationPort(source, c).streamSessionEvents(
      toStreamSessionEventsQuery(c.req.param("sessionId"), query.data),
    );
    if (result.type === "not_found") {
      return c.json(
        notFound(`Session ${c.req.param("sessionId")} was not found`),
        404,
      );
    }

    return streamSSE(c, async (stream) => {
      for await (const event of result.events) {
        const wire = sessionStreamEventResponseSchema.safeParse(
          toStreamSessionEventResponse(event),
        );
        if (!wire.success) {
          throw new Error("Application returned an invalid streamed session event");
        }
        await stream.writeSSE({
          event: wire.data.type,
          data: JSON.stringify(wire.data),
        });
      }
    });
  });

  app.post("/:sessionId/events", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(invalidRequest("Request body must be valid JSON"), 400);
    }

    const parsed = sessionEventSendBodySchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return c.json(
        invalidRequest(
          `Invalid request field ${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid value"}`,
        ),
        400,
      );
    }

    const result = await resolveApplicationPort(source, c).sendSessionEvents(
      toSendSessionEventsCommand(c.req.param("sessionId"), parsed.data),
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

    let response: object;
    try {
      response = {
        ...(result.events !== undefined && {
          data: result.events.map(toSentSessionEventResponse),
        }),
      };
    } catch {
      return c.json(
        apiError("Application returned invalid sent session events"),
        500,
      );
    }

    const wire = sessionEventSendResponseSchema.safeParse(response);
    if (!wire.success) {
      return c.json(
        apiError("Application returned invalid sent session events"),
        500,
      );
    }

    return c.json(wire.data, 200);
  });


  return app;
}
