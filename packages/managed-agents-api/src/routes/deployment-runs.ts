import { Hono } from "hono";
import {
  resolveApplicationPort,
  type ApplicationPortSource,
} from "../application-port-source";
import { MANAGED_AGENTS_BETA, requireBeta } from "../beta";
import {
  deploymentRunListQuerySchema,
  deploymentRunPageResponseSchema,
  deploymentRunResponseSchema,
} from "../contracts/deployment-runs";
import { apiError, invalidRequest, notFound } from "../errors";
import {
  toDeploymentRunResponse,
  toListDeploymentRunsQuery,
} from "../mappers/deployment-runs";
import type { DeploymentRunsApplicationPort } from "../ports/deployment-runs";

function invalidField(error: { issues: { path: PropertyKey[]; message: string }[] }) {
  const issue = error.issues[0];
  return invalidRequest(
    `Invalid request field ${issue?.path.join(".") || "query"}: ${issue?.message ?? "invalid value"}`,
  );
}

export function buildDeploymentRunRoutes(
  source: ApplicationPortSource<DeploymentRunsApplicationPort>,
): Hono {
  const app = new Hono();
  app.use("*", requireBeta(MANAGED_AGENTS_BETA));

  app.get("/", async (c) => {
    const query = deploymentRunListQuerySchema.safeParse({
      limit: c.req.query("limit"),
      page: c.req.query("page"),
      "created_at[gt]": c.req.query("created_at[gt]"),
      "created_at[gte]": c.req.query("created_at[gte]"),
      "created_at[lt]": c.req.query("created_at[lt]"),
      "created_at[lte]": c.req.query("created_at[lte]"),
      deployment_id: c.req.query("deployment_id"),
      has_error: c.req.query("has_error"),
      trigger_type: c.req.query("trigger_type"),
    });
    if (!query.success) return c.json(invalidField(query.error), 400);

    const result = await resolveApplicationPort(source, c).listDeploymentRuns(
      toListDeploymentRunsQuery(query.data),
    );
    if (result.type === "invalid_request") {
      return c.json(invalidRequest(result.message), 400);
    }
    const response = deploymentRunPageResponseSchema.safeParse({
      data: result.page.runs.map(toDeploymentRunResponse),
      next_page: result.page.nextCursor,
    });
    if (!response.success) {
      return c.json(apiError("Application returned an invalid deployment run page"), 500);
    }
    return c.json(response.data, 200);
  });

  app.get("/:deploymentRunId", async (c) => {
    const result = await resolveApplicationPort(source, c).retrieveDeploymentRun({
      deploymentRunId: c.req.param("deploymentRunId"),
    });
    if (result.type === "not_found") {
      return c.json(
        notFound(`Deployment run ${c.req.param("deploymentRunId")} was not found`),
        404,
      );
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
