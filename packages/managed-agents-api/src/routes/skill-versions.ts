import { Hono } from "hono";
import {
  resolveApplicationPort,
  type ApplicationPortSource,
} from "../application-port-source";
import { requireBeta, SKILLS_API_BETA } from "../beta";
import {
  deletedSkillVersionResponseSchema,
  skillVersionListQuerySchema,
  skillVersionPageResponseSchema,
  skillVersionResponseSchema,
} from "../contracts/skill-versions";
import { apiError, conflict, invalidRequest, notFound } from "../errors";
import {
  toCreateSkillVersionCommand,
  toDeleteSkillVersionCommand,
  toDownloadSkillVersionQuery,
  toListSkillVersionsQuery,
  toRetrieveSkillVersionQuery,
  toSkillVersionResponse,
  toSkillVersionUploadFiles,
} from "../mappers/skill-versions";
import type { SkillVersionsApplicationPort } from "../ports/skill-versions";

function readFiles(form: FormData): File[] | null {
  const files = form.getAll("files[]");
  if (files.length === 0 || files.some((file) => !(file instanceof File))) {
    return null;
  }
  return files as File[];
}

export function buildSkillVersionRoutes(
  source: ApplicationPortSource<SkillVersionsApplicationPort>,
): Hono {
  const app = new Hono();
  app.use("*", requireBeta(SKILLS_API_BETA));

  app.post("/:skillId/versions", async (c) => {
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

    const result = await resolveApplicationPort(source, c).createSkillVersion(
      toCreateSkillVersionCommand(
        c.req.param("skillId"),
        await toSkillVersionUploadFiles(files),
      ),
    );
    if (result.type === "invalid_request") {
      return c.json(invalidRequest(result.message), 400);
    }
    if (result.type === "not_found") {
      return c.json(notFound(`Skill ${c.req.param("skillId")} was not found`), 404);
    }
    if (result.type === "version_conflict") {
      return c.json(conflict(result.message), 409);
    }
    const response = skillVersionResponseSchema.safeParse(
      toSkillVersionResponse(result.version),
    );
    if (!response.success) {
      return c.json(apiError("Application returned an invalid skill version"), 500);
    }
    return c.json(response.data, 200);
  });

  app.get("/:skillId/versions", async (c) => {
    const query = skillVersionListQuerySchema.safeParse({
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
    const result = await resolveApplicationPort(source, c).listSkillVersions(
      toListSkillVersionsQuery(c.req.param("skillId"), query.data),
    );
    if (result.type === "not_found") {
      return c.json(notFound(`Skill ${c.req.param("skillId")} was not found`), 404);
    }
    if (result.type === "invalid_request") {
      return c.json(invalidRequest(result.message), 400);
    }
    const response = skillVersionPageResponseSchema.safeParse({
      data: result.page.versions.map(toSkillVersionResponse),
      next_page: result.page.nextCursor,
    });
    if (!response.success) {
      return c.json(apiError("Application returned an invalid skill version page"), 500);
    }
    return c.json(response.data, 200);
  });

  app.get("/:skillId/versions/:version/content", async (c) => {
    const result = await resolveApplicationPort(source, c).downloadSkillVersion(
      toDownloadSkillVersionQuery(
        c.req.param("skillId"),
        c.req.param("version"),
      ),
    );
    if (result.type === "not_found") {
      return c.json(
        notFound(`Skill version ${c.req.param("version")} was not found`),
        404,
      );
    }
    const headers = new Headers({ "Content-Type": result.file.mimeType });
    if (result.file.filename !== undefined) {
      headers.set(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(result.file.filename)}`,
      );
    }
    return new Response(Uint8Array.from(result.file.content).buffer, {
      status: 200,
      headers,
    });
  });

  app.get("/:skillId/versions/:version", async (c) => {
    const result = await resolveApplicationPort(source, c).retrieveSkillVersion(
      toRetrieveSkillVersionQuery(
        c.req.param("skillId"),
        c.req.param("version"),
      ),
    );
    if (result.type === "not_found") {
      return c.json(
        notFound(`Skill version ${c.req.param("version")} was not found`),
        404,
      );
    }
    const response = skillVersionResponseSchema.safeParse(
      toSkillVersionResponse(result.version),
    );
    if (!response.success) {
      return c.json(apiError("Application returned an invalid skill version"), 500);
    }
    return c.json(response.data, 200);
  });

  app.delete("/:skillId/versions/:version", async (c) => {
    const result = await resolveApplicationPort(source, c).deleteSkillVersion(
      toDeleteSkillVersionCommand(
        c.req.param("skillId"),
        c.req.param("version"),
      ),
    );
    if (result.type === "not_found") {
      return c.json(
        notFound(`Skill version ${c.req.param("version")} was not found`),
        404,
      );
    }
    if (result.type === "version_conflict") {
      return c.json(conflict(result.message), 409);
    }
    const response = deletedSkillVersionResponseSchema.safeParse({
      id: result.version,
      type: "skill_version_deleted",
    });
    if (!response.success) {
      return c.json(
        apiError("Application returned an invalid skill version deletion result"),
        500,
      );
    }
    return c.json(response.data, 200);
  });

  return app;
}
