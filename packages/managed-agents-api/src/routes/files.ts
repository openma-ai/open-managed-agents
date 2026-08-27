import { Hono } from "hono";
import {
  resolveApplicationPort,
  type ApplicationPortSource,
} from "../application-port-source";
import { FILES_API_BETA, requireBeta } from "../beta";
import {
  deletedFileResponseSchema,
  fileListQuerySchema,
  fileMetadataResponseSchema,
  filePageResponseSchema,
} from "../contracts/files";
import { apiError, invalidRequest, notFound } from "../errors";
import {
  toDeleteFileCommand,
  toDownloadFileQuery,
  toFileMetadataResponse,
  toListFilesQuery,
  toRetrieveFileMetadataQuery,
  toUploadFileCommand,
} from "../mappers/files";
import type { FilesApplicationPort } from "../ports/files";

export function buildFileRoutes(
  source: ApplicationPortSource<FilesApplicationPort>,
): Hono {
  const app = new Hono();
  app.use("*", requireBeta(FILES_API_BETA));

  app.get("/", async (c) => {
    const query = fileListQuerySchema.safeParse({
      limit: c.req.query("limit"),
      before_id: c.req.query("before_id"),
      after_id: c.req.query("after_id"),
      scope_id: c.req.query("scope_id"),
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

    const result = await resolveApplicationPort(source, c).listFiles(
      toListFilesQuery(query.data),
    );
    if (result.type === "invalid_request") {
      return c.json(invalidRequest(result.message), 400);
    }
    const response = filePageResponseSchema.safeParse({
      data: result.page.files.map(toFileMetadataResponse),
      has_more: result.page.hasMore,
      first_id: result.page.firstId,
      last_id: result.page.lastId,
    });
    if (!response.success) {
      return c.json(apiError("Application returned an invalid file page"), 500);
    }
    return c.json(response.data, 200);
  });

  app.post("/", async (c) => {
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return c.json(invalidRequest("Request body must be multipart form data"), 400);
    }
    const file = form.get("file");
    if (!(file instanceof File)) {
      return c.json(invalidRequest("Request field file must be a file"), 400);
    }

    const result = await resolveApplicationPort(source, c).uploadFile(
      await toUploadFileCommand(file),
    );
    if (result.type === "invalid_request") {
      return c.json(invalidRequest(result.message), 400);
    }
    const response = fileMetadataResponseSchema.safeParse(
      toFileMetadataResponse(result.file),
    );
    if (!response.success) {
      return c.json(apiError("Application returned invalid file metadata"), 500);
    }
    return c.json(response.data, 200);
  });

  app.get("/:fileId/content", async (c) => {
    const result = await resolveApplicationPort(source, c).downloadFile(
      toDownloadFileQuery(c.req.param("fileId")),
    );
    if (result.type === "not_found") {
      return c.json(notFound(`File ${c.req.param("fileId")} was not found`), 404);
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

  app.get("/:fileId", async (c) => {
    const result = await resolveApplicationPort(source, c).retrieveFileMetadata(
      toRetrieveFileMetadataQuery(c.req.param("fileId")),
    );
    if (result.type === "not_found") {
      return c.json(notFound(`File ${c.req.param("fileId")} was not found`), 404);
    }
    const response = fileMetadataResponseSchema.safeParse(
      toFileMetadataResponse(result.file),
    );
    if (!response.success) {
      return c.json(apiError("Application returned invalid file metadata"), 500);
    }
    return c.json(response.data, 200);
  });

  app.delete("/:fileId", async (c) => {
    const result = await resolveApplicationPort(source, c).deleteFile(
      toDeleteFileCommand(c.req.param("fileId")),
    );
    if (result.type === "not_found") {
      return c.json(notFound(`File ${c.req.param("fileId")} was not found`), 404);
    }
    const response = deletedFileResponseSchema.safeParse({
      id: result.fileId,
      type: "file_deleted",
    });
    if (!response.success) {
      return c.json(apiError("Application returned an invalid file deletion result"), 500);
    }
    return c.json(response.data, 200);
  });

  return app;
}
