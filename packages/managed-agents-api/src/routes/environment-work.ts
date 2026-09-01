import { Hono } from "hono";
import {
  resolveApplicationPort,
  type ApplicationPortSource,
} from "../application-port-source";
import { MANAGED_AGENTS_BETA, requireBeta } from "../beta";
import {
  environmentWorkHeartbeatQuerySchema,
  environmentWorkHeartbeatResponseSchema,
  environmentWorkListQuerySchema,
  environmentWorkPageResponseSchema,
  environmentWorkPollQuerySchema,
  environmentWorkQueueStatsResponseSchema,
  environmentWorkResponseSchema,
  environmentWorkStopBodySchema,
  environmentWorkUpdateBodySchema,
} from "../contracts/environment-work";
import { apiError, conflict, invalidRequest, notFound } from "../errors";
import {
  toAcknowledgeEnvironmentWorkCommand,
  toEnvironmentWorkResponse,
  toGetEnvironmentWorkQueueStatsQuery,
  toHeartbeatEnvironmentWorkCommand,
  toListEnvironmentWorkQuery,
  toPollEnvironmentWorkQuery,
  toRetrieveEnvironmentWorkQuery,
  toStopEnvironmentWorkCommand,
  toUpdateEnvironmentWorkCommand,
} from "../mappers/environment-work";
import type { EnvironmentWorkApplicationPort } from "../ports/environment-work";

export function buildEnvironmentWorkRoutes(
  source: ApplicationPortSource<EnvironmentWorkApplicationPort>,
): Hono {
  const app = new Hono();
  app.use("*", requireBeta(MANAGED_AGENTS_BETA));

  app.get("/:environmentId/work", async (c) => {
    const query = environmentWorkListQuerySchema.safeParse({
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

    const result = await resolveApplicationPort(source, c).listEnvironmentWork(
      toListEnvironmentWorkQuery(c.req.param("environmentId"), query.data),
    );
    if (result.type === "not_found") {
      return c.json(
        notFound(`Environment ${c.req.param("environmentId")} was not found`),
        404,
      );
    }
    if (result.type === "invalid_request") {
      return c.json(invalidRequest(result.message), 400);
    }
    const response = environmentWorkPageResponseSchema.safeParse({
      data: result.page.workItems.map(toEnvironmentWorkResponse),
      next_page: result.page.nextCursor,
    });
    if (!response.success) {
      return c.json(apiError("Application returned an invalid work page"), 500);
    }

    return c.json(response.data, 200);
  });

  app.get("/:environmentId/work/poll", async (c) => {
    const query = environmentWorkPollQuerySchema.safeParse({
      block_ms: c.req.query("block_ms"),
      reclaim_older_than_ms: c.req.query("reclaim_older_than_ms"),
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

    const result = await resolveApplicationPort(source, c).pollEnvironmentWork(
      toPollEnvironmentWorkQuery(
        c.req.param("environmentId"),
        query.data,
        c.req.header("Anthropic-Worker-ID"),
      ),
    );
    if (result.type === "not_found") {
      return c.json(
        notFound(`Environment ${c.req.param("environmentId")} was not found`),
        404,
      );
    }
    if (result.type === "empty") return c.json(null, 200);

    const response = environmentWorkResponseSchema.safeParse(
      toEnvironmentWorkResponse(result.work),
    );
    if (!response.success) {
      return c.json(apiError("Application returned invalid work"), 500);
    }
    return c.json(response.data, 200);
  });

  app.get("/:environmentId/work/stats", async (c) => {
    const result = await resolveApplicationPort(source, c).getEnvironmentWorkQueueStats(
      toGetEnvironmentWorkQueueStatsQuery(c.req.param("environmentId")),
    );
    if (result.type === "not_found") {
      return c.json(
        notFound(`Environment ${c.req.param("environmentId")} was not found`),
        404,
      );
    }

    const response = environmentWorkQueueStatsResponseSchema.safeParse({
      depth: result.stats.depth,
      oldest_queued_at: result.stats.oldestQueuedAt,
      pending: result.stats.pending,
      type: "work_queue_stats",
      workers_polling: result.stats.workersPolling,
    });
    if (!response.success) {
      return c.json(
        apiError("Application returned invalid work queue statistics"),
        500,
      );
    }
    return c.json(response.data, 200);
  });

  app.get("/:environmentId/work/:workId", async (c) => {
    const result = await resolveApplicationPort(source, c).retrieveEnvironmentWork(
      toRetrieveEnvironmentWorkQuery(
        c.req.param("environmentId"),
        c.req.param("workId"),
      ),
    );
    if (result.type === "not_found") {
      return c.json(notFound(`Work ${c.req.param("workId")} was not found`), 404);
    }
    const response = environmentWorkResponseSchema.safeParse(
      toEnvironmentWorkResponse(result.work),
    );
    if (!response.success) {
      return c.json(apiError("Application returned invalid work"), 500);
    }

    return c.json(response.data, 200);
  });

  app.post("/:environmentId/work/:workId", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(invalidRequest("Request body must be valid JSON"), 400);
    }
    const parsed = environmentWorkUpdateBodySchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return c.json(
        invalidRequest(
          `Invalid request field ${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid value"}`,
        ),
        400,
      );
    }

    const result = await resolveApplicationPort(source, c).updateEnvironmentWork(
      toUpdateEnvironmentWorkCommand(
        c.req.param("environmentId"),
        c.req.param("workId"),
        parsed.data,
      ),
    );
    if (result.type === "invalid_request") {
      return c.json(invalidRequest(result.message), 400);
    }
    if (result.type === "not_found") {
      return c.json(notFound(`Work ${c.req.param("workId")} was not found`), 404);
    }
    if (result.type === "conflict") {
      return c.json(conflict(result.message), 409);
    }

    const response = environmentWorkResponseSchema.safeParse(
      toEnvironmentWorkResponse(result.work),
    );
    if (!response.success) {
      return c.json(apiError("Application returned invalid work"), 500);
    }
    return c.json(response.data, 200);
  });

  app.post("/:environmentId/work/:workId/ack", async (c) => {
    const result = await resolveApplicationPort(source, c).acknowledgeEnvironmentWork(
      toAcknowledgeEnvironmentWorkCommand(
        c.req.param("environmentId"),
        c.req.param("workId"),
      ),
    );
    if (result.type === "not_found") {
      return c.json(notFound(`Work ${c.req.param("workId")} was not found`), 404);
    }
    if (result.type === "conflict") {
      return c.json(conflict(result.message), 409);
    }
    const response = environmentWorkResponseSchema.safeParse(
      toEnvironmentWorkResponse(result.work),
    );
    if (!response.success) {
      return c.json(apiError("Application returned invalid work"), 500);
    }
    return c.json(response.data, 200);
  });

  app.post("/:environmentId/work/:workId/heartbeat", async (c) => {
    const query = environmentWorkHeartbeatQuerySchema.safeParse({
      desired_ttl_seconds: c.req.query("desired_ttl_seconds"),
      expected_last_heartbeat: c.req.query("expected_last_heartbeat"),
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

    const result = await resolveApplicationPort(source, c).heartbeatEnvironmentWork(
      toHeartbeatEnvironmentWorkCommand(
        c.req.param("environmentId"),
        c.req.param("workId"),
        query.data,
      ),
    );
    if (result.type === "precondition_failed") {
      return c.json(invalidRequest(result.message), 412);
    }
    if (result.type === "not_found") {
      return c.json(notFound(`Work ${c.req.param("workId")} was not found`), 404);
    }

    const response = environmentWorkHeartbeatResponseSchema.safeParse({
      last_heartbeat: result.heartbeat.lastHeartbeat,
      lease_extended: result.heartbeat.leaseExtended,
      state: result.heartbeat.state,
      ttl_seconds: result.heartbeat.ttlSeconds,
      type: "work_heartbeat",
    });
    if (!response.success) {
      return c.json(apiError("Application returned invalid work heartbeat"), 500);
    }
    return c.json(response.data, 200);
  });

  app.post("/:environmentId/work/:workId/stop", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(invalidRequest("Request body must be valid JSON"), 400);
    }
    const parsed = environmentWorkStopBodySchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return c.json(
        invalidRequest(
          `Invalid request field ${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid value"}`,
        ),
        400,
      );
    }

    const result = await resolveApplicationPort(source, c).stopEnvironmentWork(
      toStopEnvironmentWorkCommand(
        c.req.param("environmentId"),
        c.req.param("workId"),
        parsed.data,
      ),
    );
    if (result.type === "not_found") {
      return c.json(notFound(`Work ${c.req.param("workId")} was not found`), 404);
    }
    if (result.type === "conflict") {
      return c.json(conflict(result.message), 409);
    }

    const response = environmentWorkResponseSchema.safeParse(
      toEnvironmentWorkResponse(result.work),
    );
    if (!response.success) {
      return c.json(apiError("Application returned invalid work"), 500);
    }
    return c.json(response.data, 200);
  });

  return app;
}
