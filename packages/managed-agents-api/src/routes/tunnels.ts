import { Hono } from "hono";
import {
  resolveApplicationPort,
  type ApplicationPortSource,
} from "../application-port-source";
import { MCP_TUNNELS_BETA, requireBeta } from "../beta";
import {
  tunnelCreateBodySchema,
  tunnelListQuerySchema,
  tunnelPageResponseSchema,
  tunnelResponseSchema,
  tunnelRotateTokenBodySchema,
  tunnelTokenResponseSchema,
} from "../contracts/tunnels";
import { apiError, conflict, invalidRequest, notFound } from "../errors";
import {
  toCreateTunnelCommand,
  toListTunnelsQuery,
  toRotateTunnelTokenCommand,
  toTunnelResponse,
  toTunnelTokenResponse,
} from "../mappers/tunnels";
import type { TunnelsApplicationPort } from "../ports/tunnels";

function invalidField(error: { issues: { path: PropertyKey[]; message: string }[] }) {
  const issue = error.issues[0];
  return invalidRequest(
    `Invalid request field ${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid value"}`,
  );
}

async function requestBody(c: { req: { json(): Promise<unknown> } }) {
  try {
    return { type: "parsed" as const, body: await c.req.json() };
  } catch {
    return { type: "invalid" as const };
  }
}

export function buildTunnelRoutes(
  source: ApplicationPortSource<TunnelsApplicationPort>,
): Hono {
  const app = new Hono();
  app.use("*", requireBeta(MCP_TUNNELS_BETA));

  app.post("/", async (c) => {
    const body = await requestBody(c);
    if (body.type === "invalid") {
      return c.json(invalidRequest("Request body must be valid JSON"), 400);
    }
    const parsed = tunnelCreateBodySchema.safeParse(body.body);
    if (!parsed.success) return c.json(invalidField(parsed.error), 400);
    const result = await resolveApplicationPort(source, c).createTunnel(
      toCreateTunnelCommand(parsed.data),
    );
    if (result.type === "invalid_request") {
      return c.json(invalidRequest(result.message), 400);
    }
    const response = tunnelResponseSchema.safeParse(
      toTunnelResponse(result.tunnel),
    );
    if (!response.success) {
      return c.json(apiError("Application returned an invalid tunnel"), 500);
    }
    return c.json(response.data, 201);
  });

  app.get("/", async (c) => {
    const query = tunnelListQuerySchema.safeParse({
      limit: c.req.query("limit"),
      page: c.req.query("page"),
      include_archived: c.req.query("include_archived"),
    });
    if (!query.success) return c.json(invalidField(query.error), 400);
    const result = await resolveApplicationPort(source, c).listTunnels(
      toListTunnelsQuery(query.data),
    );
    if (result.type === "invalid_request") {
      return c.json(invalidRequest(result.message), 400);
    }
    const response = tunnelPageResponseSchema.safeParse({
      data: result.page.tunnels.map(toTunnelResponse),
      next_page: result.page.nextCursor,
    });
    if (!response.success) {
      return c.json(apiError("Application returned an invalid tunnel page"), 500);
    }
    return c.json(response.data, 200);
  });

  app.get("/:tunnelId", async (c) => {
    const result = await resolveApplicationPort(source, c).retrieveTunnel({
      tunnelId: c.req.param("tunnelId"),
    });
    if (result.type === "not_found") {
      return c.json(notFound(`Tunnel ${c.req.param("tunnelId")} was not found`), 404);
    }
    const response = tunnelResponseSchema.safeParse(
      toTunnelResponse(result.tunnel),
    );
    if (!response.success) {
      return c.json(apiError("Application returned an invalid tunnel"), 500);
    }
    return c.json(response.data, 200);
  });

  app.post("/:tunnelId/archive", async (c) => {
    const result = await resolveApplicationPort(source, c).archiveTunnel({
      tunnelId: c.req.param("tunnelId"),
    });
    if (result.type === "not_found") {
      return c.json(notFound(`Tunnel ${c.req.param("tunnelId")} was not found`), 404);
    }
    const response = tunnelResponseSchema.safeParse(
      toTunnelResponse(result.tunnel),
    );
    if (!response.success) {
      return c.json(apiError("Application returned an invalid tunnel"), 500);
    }
    return c.json(response.data, 200);
  });

  app.post("/:tunnelId/reveal_token", async (c) => {
    const result = await resolveApplicationPort(source, c).revealTunnelToken({
      tunnelId: c.req.param("tunnelId"),
    });
    if (result.type === "not_found") {
      return c.json(notFound(`Tunnel ${c.req.param("tunnelId")} was not found`), 404);
    }
    if (result.type === "conflict") {
      return c.json(conflict(result.message), 409);
    }
    const response = tunnelTokenResponseSchema.safeParse(
      toTunnelTokenResponse(result.token),
    );
    if (!response.success) {
      return c.json(apiError("Application returned an invalid tunnel token"), 500);
    }
    return c.json(response.data, 200);
  });

  app.post("/:tunnelId/rotate_token", async (c) => {
    const body = await requestBody(c);
    if (body.type === "invalid") {
      return c.json(invalidRequest("Request body must be valid JSON"), 400);
    }
    const parsed = tunnelRotateTokenBodySchema.safeParse(body.body);
    if (!parsed.success) return c.json(invalidField(parsed.error), 400);
    const result = await resolveApplicationPort(source, c).rotateTunnelToken(
      toRotateTunnelTokenCommand(c.req.param("tunnelId"), parsed.data),
    );
    if (result.type === "invalid_request") {
      return c.json(invalidRequest(result.message), 400);
    }
    if (result.type === "not_found") {
      return c.json(notFound(`Tunnel ${c.req.param("tunnelId")} was not found`), 404);
    }
    if (result.type === "conflict") {
      return c.json(conflict(result.message), 409);
    }
    const response = tunnelTokenResponseSchema.safeParse(
      toTunnelTokenResponse(result.token),
    );
    if (!response.success) {
      return c.json(apiError("Application returned an invalid tunnel token"), 500);
    }
    return c.json(response.data, 200);
  });

  return app;
}
