import { Hono } from "hono";
import {
  resolveApplicationPort,
  type ApplicationPortSource,
} from "../application-port-source";
import { MANAGED_AGENTS_BETA, requireBeta } from "../beta";
import {
  deploymentCreateBodySchema,
  deploymentListQuerySchema,
  deploymentPageResponseSchema,
  deploymentResponseSchema,
  deploymentUpdateBodySchema,
} from "../contracts/deployments";
import { deploymentRunResponseSchema } from "../contracts/deployment-runs";
import { apiError, conflict, invalidRequest, notFound } from "../errors";
import { toDeploymentRunResponse } from "../mappers/deployment-runs";
import {
  toCreateDeploymentCommand,
  toDeploymentResponse,
  toListDeploymentsQuery,
  toUpdateDeploymentCommand,
} from "../mappers/deployments";
import type { DeploymentsApplicationPort } from "../ports/deployments";

function invalidField(error: { issues: { path: PropertyKey[]; message: string }[] }) {
  const issue = error.issues[0];
  return invalidRequest(
    `Invalid request field ${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid value"}`,
  );
}

function serializeDeployment(deployment: Parameters<typeof toDeploymentResponse>[0]) {
  return deploymentResponseSchema.safeParse(toDeploymentResponse(deployment));
}

async function parseJson(c: { req: { json(): Promise<unknown> } }) {
  try {
    return { type: "parsed" as const, body: await c.req.json() };
  } catch {
    return { type: "invalid" as const };
  }
}

export function buildDeploymentRoutes(
  source: ApplicationPortSource<DeploymentsApplicationPort>,
): Hono {
  const app = new Hono();
  app.use("*", requireBeta(MANAGED_AGENTS_BETA));

  app.post("/", async (c) => {
    const body = await parseJson(c);
    if (body.type === "invalid") {
      return c.json(invalidRequest("Request body must be valid JSON"), 400);
    }
    const parsed = deploymentCreateBodySchema.safeParse(body.body);
    if (!parsed.success) return c.json(invalidField(parsed.error), 400);

    const result = await resolveApplicationPort(source, c).createDeployment(
      toCreateDeploymentCommand(parsed.data),
    );
    if (result.type === "invalid_request") {
      return c.json(invalidRequest(result.message), 400);
    }
    if (result.type === "dependency_not_found") {
      return c.json(notFound(result.message), 404);
    }
    const response = serializeDeployment(result.deployment);
    if (!response.success) {
      return c.json(apiError("Application returned an invalid deployment"), 500);
    }
    return c.json(response.data, 201);
  });

  app.get("/", async (c) => {
    const query = deploymentListQuerySchema.safeParse({
      limit: c.req.query("limit"),
      page: c.req.query("page"),
      agent_id: c.req.query("agent_id"),
      "created_at[gte]": c.req.query("created_at[gte]"),
      "created_at[lte]": c.req.query("created_at[lte]"),
      include_archived: c.req.query("include_archived"),
      status: c.req.query("status"),
    });
    if (!query.success) return c.json(invalidField(query.error), 400);

    const result = await resolveApplicationPort(source, c).listDeployments(
      toListDeploymentsQuery(query.data),
    );
    if (result.type === "invalid_request") {
      return c.json(invalidRequest(result.message), 400);
    }
    const response = deploymentPageResponseSchema.safeParse({
      data: result.page.deployments.map(toDeploymentResponse),
      next_page: result.page.nextCursor,
    });
    if (!response.success) {
      return c.json(apiError("Application returned an invalid deployment page"), 500);
    }
    return c.json(response.data, 200);
  });

  app.get("/:deploymentId", async (c) => {
    const result = await resolveApplicationPort(source, c).retrieveDeployment({
      deploymentId: c.req.param("deploymentId"),
    });
    if (result.type === "not_found") {
      return c.json(
        notFound(`Deployment ${c.req.param("deploymentId")} was not found`),
        404,
      );
    }
    const response = serializeDeployment(result.deployment);
    if (!response.success) {
      return c.json(apiError("Application returned an invalid deployment"), 500);
    }
    return c.json(response.data, 200);
  });

  app.post("/:deploymentId", async (c) => {
    const body = await parseJson(c);
    if (body.type === "invalid") {
      return c.json(invalidRequest("Request body must be valid JSON"), 400);
    }
    const parsed = deploymentUpdateBodySchema.safeParse(body.body);
    if (!parsed.success) return c.json(invalidField(parsed.error), 400);

    const result = await resolveApplicationPort(source, c).updateDeployment(
      toUpdateDeploymentCommand(c.req.param("deploymentId"), parsed.data),
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
        notFound(`Deployment ${c.req.param("deploymentId")} was not found`),
        404,
      );
    }
    const response = serializeDeployment(result.deployment);
    if (!response.success) {
      return c.json(apiError("Application returned an invalid deployment"), 500);
    }
    return c.json(response.data, 200);
  });

  const stateChange = (
    action: "archive" | "pause" | "unpause",
    invoke: (
      port: DeploymentsApplicationPort,
      deploymentId: string,
    ) => ReturnType<DeploymentsApplicationPort["archiveDeployment"]>,
  ) => {
    app.post(`/:deploymentId/${action}`, async (c) => {
      const result = await invoke(
        resolveApplicationPort(source, c),
        c.req.param("deploymentId"),
      );
      if (result.type === "not_found") {
        return c.json(
          notFound(`Deployment ${c.req.param("deploymentId")} was not found`),
          404,
        );
      }
      if (result.type === "conflict") {
        return c.json(conflict(result.message), 409);
      }
      const response = serializeDeployment(result.deployment);
      if (!response.success) {
        return c.json(apiError("Application returned an invalid deployment"), 500);
      }
      return c.json(response.data, 200);
    });
  };

  stateChange("archive", (port, deploymentId) =>
    port.archiveDeployment({ deploymentId }),
  );
  stateChange("pause", (port, deploymentId) =>
    port.pauseDeployment({ deploymentId }),
  );
  stateChange("unpause", (port, deploymentId) =>
    port.unpauseDeployment({ deploymentId }),
  );

  app.post("/:deploymentId/run", async (c) => {
    const result = await resolveApplicationPort(source, c).runDeployment({
      deploymentId: c.req.param("deploymentId"),
    });
    if (result.type === "not_found") {
      return c.json(
        notFound(`Deployment ${c.req.param("deploymentId")} was not found`),
        404,
      );
    }
    if (result.type === "conflict") {
      return c.json(conflict(result.message), 409);
    }
    const response = deploymentRunResponseSchema.safeParse(
      toDeploymentRunResponse(result.run),
    );
    if (!response.success) {
      return c.json(apiError("Application returned an invalid deployment run"), 500);
    }
    return c.json(response.data, 200);
  });

  return app;
}
