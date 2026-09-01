import { Hono } from "hono";
import {
  resolveApplicationPort,
  type ApplicationPortSource,
} from "../application-port-source";
import {
  modelListQuerySchema,
  modelPageResponseSchema,
  modelResponseSchema,
} from "../contracts/models";
import { apiError, invalidRequest, notFound } from "../errors";
import { toListModelsQuery, toModelResponse } from "../mappers/models";
import type { ModelsApplicationPort } from "../ports/models";

export function buildModelRoutes(
  source: ApplicationPortSource<ModelsApplicationPort>,
): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    const query = modelListQuerySchema.safeParse({
      after_id: c.req.query("after_id"),
      before_id: c.req.query("before_id"),
      limit: c.req.query("limit"),
    });
    if (!query.success) {
      return c.json(invalidRequest("Invalid Models list query"), 400);
    }
    const result = await resolveApplicationPort(source, c).listModels(
      toListModelsQuery(query.data),
    );
    if (result.type === "invalid_request") {
      return c.json(invalidRequest(result.message), 400);
    }
    const first = result.page.models[0]?.id ?? null;
    const last = result.page.models.at(-1)?.id ?? null;
    const response = modelPageResponseSchema.safeParse({
      data: result.page.models.map(toModelResponse),
      first_id: first,
      has_more: result.page.hasMore,
      last_id: last,
    });
    if (!response.success) {
      return c.json(apiError("Application returned an invalid Models page"), 500);
    }
    return c.json(response.data, 200);
  });

  app.get("/:modelId", async (c) => {
    const result = await resolveApplicationPort(source, c).retrieveModel({
      modelId: c.req.param("modelId"),
    });
    if (result.type === "not_found") {
      return c.json(notFound(`Model ${c.req.param("modelId")} was not found`), 404);
    }
    const response = modelResponseSchema.safeParse(toModelResponse(result.model));
    if (!response.success) {
      return c.json(apiError("Application returned an invalid Model"), 500);
    }
    return c.json(response.data, 200);
  });

  return app;
}
