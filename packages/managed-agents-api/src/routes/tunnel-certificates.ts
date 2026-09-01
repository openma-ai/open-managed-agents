import { Hono } from "hono";
import {
  resolveApplicationPort,
  type ApplicationPortSource,
} from "../application-port-source";
import { MCP_TUNNELS_BETA, requireBeta } from "../beta";
import {
  tunnelCertificateCreateBodySchema,
  tunnelCertificateListQuerySchema,
  tunnelCertificatePageResponseSchema,
  tunnelCertificateResponseSchema,
} from "../contracts/tunnel-certificates";
import { apiError, conflict, invalidRequest, notFound } from "../errors";
import {
  toCreateTunnelCertificateCommand,
  toListTunnelCertificatesQuery,
  toTunnelCertificateResponse,
} from "../mappers/tunnel-certificates";
import type { TunnelCertificatesApplicationPort } from "../ports/tunnel-certificates";

function invalidField(error: { issues: { path: PropertyKey[]; message: string }[] }) {
  const issue = error.issues[0];
  return invalidRequest(
    `Invalid request field ${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid value"}`,
  );
}

export function buildTunnelCertificateRoutes(
  source: ApplicationPortSource<TunnelCertificatesApplicationPort>,
): Hono {
  const app = new Hono();
  app.use("*", requireBeta(MCP_TUNNELS_BETA));

  app.post("/:tunnelId/certificates", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(invalidRequest("Request body must be valid JSON"), 400);
    }
    const parsed = tunnelCertificateCreateBodySchema.safeParse(body);
    if (!parsed.success) return c.json(invalidField(parsed.error), 400);
    const result = await resolveApplicationPort(source, c).createTunnelCertificate(
      toCreateTunnelCertificateCommand(c.req.param("tunnelId"), parsed.data),
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
    const response = tunnelCertificateResponseSchema.safeParse(
      toTunnelCertificateResponse(result.certificate),
    );
    if (!response.success) {
      return c.json(apiError("Application returned an invalid tunnel certificate"), 500);
    }
    return c.json(response.data, 201);
  });

  app.get("/:tunnelId/certificates", async (c) => {
    const query = tunnelCertificateListQuerySchema.safeParse({
      limit: c.req.query("limit"),
      page: c.req.query("page"),
      include_archived: c.req.query("include_archived"),
    });
    if (!query.success) return c.json(invalidField(query.error), 400);
    const result = await resolveApplicationPort(source, c).listTunnelCertificates(
      toListTunnelCertificatesQuery(c.req.param("tunnelId"), query.data),
    );
    if (result.type === "invalid_request") {
      return c.json(invalidRequest(result.message), 400);
    }
    if (result.type === "not_found") {
      return c.json(notFound(`Tunnel ${c.req.param("tunnelId")} was not found`), 404);
    }
    const response = tunnelCertificatePageResponseSchema.safeParse({
      data: result.page.certificates.map(toTunnelCertificateResponse),
      next_page: result.page.nextCursor,
    });
    if (!response.success) {
      return c.json(apiError("Application returned an invalid tunnel certificate page"), 500);
    }
    return c.json(response.data, 200);
  });

  app.get("/:tunnelId/certificates/:certificateId", async (c) => {
    const result = await resolveApplicationPort(source, c).retrieveTunnelCertificate({
      tunnelId: c.req.param("tunnelId"),
      certificateId: c.req.param("certificateId"),
    });
    if (result.type === "not_found") {
      return c.json(
        notFound(`Tunnel certificate ${c.req.param("certificateId")} was not found`),
        404,
      );
    }
    const response = tunnelCertificateResponseSchema.safeParse(
      toTunnelCertificateResponse(result.certificate),
    );
    if (!response.success) {
      return c.json(apiError("Application returned an invalid tunnel certificate"), 500);
    }
    return c.json(response.data, 200);
  });

  app.post("/:tunnelId/certificates/:certificateId/archive", async (c) => {
    const result = await resolveApplicationPort(source, c).archiveTunnelCertificate({
      tunnelId: c.req.param("tunnelId"),
      certificateId: c.req.param("certificateId"),
    });
    if (result.type === "not_found") {
      return c.json(
        notFound(`Tunnel certificate ${c.req.param("certificateId")} was not found`),
        404,
      );
    }
    if (result.type === "conflict") {
      return c.json(conflict(result.message), 409);
    }
    const response = tunnelCertificateResponseSchema.safeParse(
      toTunnelCertificateResponse(result.certificate),
    );
    if (!response.success) {
      return c.json(apiError("Application returned an invalid tunnel certificate"), 500);
    }
    return c.json(response.data, 200);
  });

  return app;
}
