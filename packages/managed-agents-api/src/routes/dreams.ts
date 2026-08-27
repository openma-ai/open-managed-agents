import { Hono } from "hono";
import {
  resolveApplicationPort,
  type ApplicationPortSource,
} from "../application-port-source";
import { DREAMING_BETA, requireBeta } from "../beta";
import {
  dreamCreateBodySchema,
  dreamListQuerySchema,
  dreamPageResponseSchema,
  dreamResponseSchema,
} from "../contracts/dreams";
import { apiError, conflict, invalidRequest, notFound } from "../errors";
import {
  toCreateDreamCommand,
  toDreamResponse,
  toListDreamsQuery,
} from "../mappers/dreams";
import type { DreamsApplicationPort } from "../ports/dreams";

function invalidField(error: { issues: { path: PropertyKey[]; message: string }[] }) {
  const issue = error.issues[0];
  return invalidRequest(
    `Invalid request field ${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid value"}`,
  );
}

function serializeDream(dream: Parameters<typeof toDreamResponse>[0]) {
  return dreamResponseSchema.safeParse(toDreamResponse(dream));
}

export function buildDreamRoutes(
  source: ApplicationPortSource<DreamsApplicationPort>,
): Hono {
  const app = new Hono();
  app.use("*", requireBeta(DREAMING_BETA));

  app.post("/", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(invalidRequest("Request body must be valid JSON"), 400);
    }
    const parsed = dreamCreateBodySchema.safeParse(body);
    if (!parsed.success) return c.json(invalidField(parsed.error), 400);
    const result = await resolveApplicationPort(source, c).createDream(
      toCreateDreamCommand(parsed.data),
    );
    if (result.type === "invalid_request") {
      return c.json(invalidRequest(result.message), 400);
    }
    if (result.type === "dependency_not_found") {
      return c.json(notFound(result.message), 404);
    }
    const response = serializeDream(result.dream);
    if (!response.success) {
      return c.json(apiError("Application returned an invalid dream"), 500);
    }
    return c.json(response.data, 201);
  });

  app.get("/", async (c) => {
    const query = dreamListQuerySchema.safeParse({
      limit: c.req.query("limit"),
      page: c.req.query("page"),
      "created_at[gt]": c.req.query("created_at[gt]"),
      "created_at[lt]": c.req.query("created_at[lt]"),
      include_archived: c.req.query("include_archived"),
      statuses: c.req.queries("statuses[]"),
    });
    if (!query.success) return c.json(invalidField(query.error), 400);
    const result = await resolveApplicationPort(source, c).listDreams(
      toListDreamsQuery(query.data),
    );
    if (result.type === "invalid_request") {
      return c.json(invalidRequest(result.message), 400);
    }
    const response = dreamPageResponseSchema.safeParse({
      data: result.page.dreams.map(toDreamResponse),
      next_page: result.page.nextCursor,
    });
    if (!response.success) {
      return c.json(apiError("Application returned an invalid dream page"), 500);
    }
    return c.json(response.data, 200);
  });

  app.get("/:dreamId", async (c) => {
    const result = await resolveApplicationPort(source, c).retrieveDream({
      dreamId: c.req.param("dreamId"),
    });
    if (result.type === "not_found") {
      return c.json(notFound(`Dream ${c.req.param("dreamId")} was not found`), 404);
    }
    const response = serializeDream(result.dream);
    if (!response.success) {
      return c.json(apiError("Application returned an invalid dream"), 500);
    }
    return c.json(response.data, 200);
  });

  const stateChange = (
    action: "archive" | "cancel",
    invoke: (
      port: DreamsApplicationPort,
      dreamId: string,
    ) => ReturnType<DreamsApplicationPort["archiveDream"]>,
  ) => {
    app.post(`/:dreamId/${action}`, async (c) => {
      const result = await invoke(
        resolveApplicationPort(source, c),
        c.req.param("dreamId"),
      );
      if (result.type === "not_found") {
        return c.json(notFound(`Dream ${c.req.param("dreamId")} was not found`), 404);
      }
      if (result.type === "conflict") {
        return c.json(conflict(result.message), 409);
      }
      const response = serializeDream(result.dream);
      if (!response.success) {
        return c.json(apiError("Application returned an invalid dream"), 500);
      }
      return c.json(response.data, 200);
    });
  };

  stateChange("archive", (port, dreamId) => port.archiveDream({ dreamId }));
  stateChange("cancel", (port, dreamId) => port.cancelDream({ dreamId }));

  return app;
}
