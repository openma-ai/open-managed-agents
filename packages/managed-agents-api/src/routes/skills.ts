import { Hono } from "hono";
import {
  resolveApplicationPort,
  type ApplicationPortSource,
} from "../application-port-source";
import { requireBeta, SKILLS_API_BETA } from "../beta";
import {
  deletedSkillResponseSchema,
  skillListQuerySchema,
  skillPageResponseSchema,
  skillResponseSchema,
} from "../contracts/skills";
import { apiError, invalidRequest, notFound } from "../errors";
import {
  toCreateSkillCommand,
  toDeleteSkillCommand,
  toListSkillsQuery,
  toRetrieveSkillQuery,
  toSkillResponse,
  toSkillUploadFiles,
} from "../mappers/skills";
import type { SkillsApplicationPort } from "../ports/skills";

function readFiles(form: FormData): File[] | null {
  const files = form.getAll("files[]");
  if (files.length === 0 || files.some((file) => !(file instanceof File))) {
    return null;
  }
  return files as File[];
}

export function buildSkillRoutes(
  source: ApplicationPortSource<SkillsApplicationPort>,
): Hono {
  const app = new Hono();
  app.use("*", requireBeta(SKILLS_API_BETA));

  app.post("/", async (c) => {
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return c.json(invalidRequest("Request body must be multipart form data"), 400);
    }
    const files = readFiles(form);
    if (files === null) {
      return c.json(invalidRequest("Request field files must contain files"), 400);
    }
    const displayTitleValue = form.get("display_title");
    if (displayTitleValue !== null && typeof displayTitleValue !== "string") {
      return c.json(invalidRequest("Request field display_title must be text"), 400);
    }

    const result = await resolveApplicationPort(source, c).createSkill(
      toCreateSkillCommand(
        await toSkillUploadFiles(files),
        displayTitleValue ?? undefined,
      ),
    );
    if (result.type === "invalid_request") {
      return c.json(invalidRequest(result.message), 400);
    }
    const response = skillResponseSchema.safeParse(toSkillResponse(result.skill));
    if (!response.success) {
      return c.json(apiError("Application returned an invalid skill"), 500);
    }
    return c.json(response.data, 200);
  });

  app.get("/", async (c) => {
    const query = skillListQuerySchema.safeParse({
      limit: c.req.query("limit"),
      page: c.req.query("page"),
      source: c.req.query("source"),
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
    const result = await resolveApplicationPort(source, c).listSkills(
      toListSkillsQuery(query.data),
    );
    if (result.type === "invalid_request") {
      return c.json(invalidRequest(result.message), 400);
    }
    const response = skillPageResponseSchema.safeParse({
      data: result.page.skills.map(toSkillResponse),
      next_page: result.page.nextCursor,
    });
    if (!response.success) {
      return c.json(apiError("Application returned an invalid skill page"), 500);
    }
    return c.json(response.data, 200);
  });

  app.get("/:skillId", async (c) => {
    const result = await resolveApplicationPort(source, c).retrieveSkill(
      toRetrieveSkillQuery(c.req.param("skillId")),
    );
    if (result.type === "not_found") {
      return c.json(notFound(`Skill ${c.req.param("skillId")} was not found`), 404);
    }
    const response = skillResponseSchema.safeParse(toSkillResponse(result.skill));
    if (!response.success) {
      return c.json(apiError("Application returned an invalid skill"), 500);
    }
    return c.json(response.data, 200);
  });

  app.delete("/:skillId", async (c) => {
    const result = await resolveApplicationPort(source, c).deleteSkill(
      toDeleteSkillCommand(c.req.param("skillId")),
    );
    if (result.type === "not_found") {
      return c.json(notFound(`Skill ${c.req.param("skillId")} was not found`), 404);
    }
    const response = deletedSkillResponseSchema.safeParse({
      id: result.skillId,
      type: "skill_deleted",
    });
    if (!response.success) {
      return c.json(apiError("Application returned an invalid skill deletion result"), 500);
    }
    return c.json(response.data, 200);
  });

  return app;
}
