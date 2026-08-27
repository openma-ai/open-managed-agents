import { Hono } from "hono";
import {
  resolveApplicationPort,
  type ApplicationPortSource,
} from "../application-port-source";
import { MANAGED_AGENTS_BETA, requireBeta } from "../beta";
import {
  credentialCreateBodySchema,
  credentialListQuerySchema,
  credentialPageResponseSchema,
  credentialResponseSchema,
  credentialUpdateBodySchema,
  credentialValidationResponseSchema,
  deletedCredentialResponseSchema,
} from "../contracts/credentials";
import { apiError, conflict, invalidRequest, notFound } from "../errors";
import {
  toArchiveCredentialCommand,
  toCreateCredentialCommand,
  toCredentialResponse,
  toCredentialValidationResponse,
  toDeleteCredentialCommand,
  toListCredentialsQuery,
  toRetrieveCredentialQuery,
  toUpdateCredentialCommand,
  toValidateCredentialCommand,
} from "../mappers/credentials";
import type { CredentialsApplicationPort } from "../ports/credentials";

function invalidField(error: { issues: { path: PropertyKey[]; message: string }[] }) {
  const issue = error.issues[0];
  return invalidRequest(
    `Invalid request field ${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid value"}`,
  );
}

export function buildCredentialRoutes(
  source: ApplicationPortSource<CredentialsApplicationPort>,
): Hono {
  const app = new Hono();
  app.use("*", requireBeta(MANAGED_AGENTS_BETA));

  app.post("/:vaultId/credentials", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(invalidRequest("Request body must be valid JSON"), 400);
    }
    const parsed = credentialCreateBodySchema.safeParse(body);
    if (!parsed.success) return c.json(invalidField(parsed.error), 400);

    const result = await resolveApplicationPort(source, c).createCredential(
      toCreateCredentialCommand(c.req.param("vaultId"), parsed.data),
    );
    if (result.type === "invalid_request") {
      return c.json(invalidRequest(result.message), 400);
    }
    if (result.type === "not_found") {
      return c.json(notFound(`Vault ${c.req.param("vaultId")} was not found`), 404);
    }
    const response = credentialResponseSchema.safeParse(
      toCredentialResponse(result.credential),
    );
    if (!response.success) {
      return c.json(apiError("Application returned an invalid credential"), 500);
    }
    return c.json(response.data, 201);
  });

  app.get("/:vaultId/credentials", async (c) => {
    const query = credentialListQuerySchema.safeParse({
      limit: c.req.query("limit"),
      page: c.req.query("page"),
      include_archived: c.req.query("include_archived"),
    });
    if (!query.success) return c.json(invalidField(query.error), 400);

    const result = await resolveApplicationPort(source, c).listCredentials(
      toListCredentialsQuery(c.req.param("vaultId"), query.data),
    );
    if (result.type === "not_found") {
      return c.json(notFound(`Vault ${c.req.param("vaultId")} was not found`), 404);
    }
    if (result.type === "invalid_request") {
      return c.json(invalidRequest(result.message), 400);
    }
    const response = credentialPageResponseSchema.safeParse({
      data: result.page.credentials.map(toCredentialResponse),
      next_page: result.page.nextCursor,
    });
    if (!response.success) {
      return c.json(apiError("Application returned an invalid credential page"), 500);
    }
    return c.json(response.data, 200);
  });

  app.get("/:vaultId/credentials/:credentialId", async (c) => {
    const result = await resolveApplicationPort(source, c).retrieveCredential(
      toRetrieveCredentialQuery(
        c.req.param("vaultId"),
        c.req.param("credentialId"),
      ),
    );
    if (result.type === "not_found") {
      return c.json(
        notFound(`Credential ${c.req.param("credentialId")} was not found`),
        404,
      );
    }
    const response = credentialResponseSchema.safeParse(
      toCredentialResponse(result.credential),
    );
    if (!response.success) {
      return c.json(apiError("Application returned an invalid credential"), 500);
    }
    return c.json(response.data, 200);
  });

  app.post("/:vaultId/credentials/:credentialId", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(invalidRequest("Request body must be valid JSON"), 400);
    }
    const parsed = credentialUpdateBodySchema.safeParse(body);
    if (!parsed.success) return c.json(invalidField(parsed.error), 400);

    const result = await resolveApplicationPort(source, c).updateCredential(
      toUpdateCredentialCommand(
        c.req.param("vaultId"),
        c.req.param("credentialId"),
        parsed.data,
      ),
    );
    if (result.type === "invalid_request") {
      return c.json(invalidRequest(result.message), 400);
    }
    if (result.type === "version_conflict") {
      return c.json(conflict(result.message), 409);
    }
    if (result.type === "not_found") {
      return c.json(
        notFound(`Credential ${c.req.param("credentialId")} was not found`),
        404,
      );
    }
    const response = credentialResponseSchema.safeParse(
      toCredentialResponse(result.credential),
    );
    if (!response.success) {
      return c.json(apiError("Application returned an invalid credential"), 500);
    }
    return c.json(response.data, 200);
  });

  app.delete("/:vaultId/credentials/:credentialId", async (c) => {
    const result = await resolveApplicationPort(source, c).deleteCredential(
      toDeleteCredentialCommand(
        c.req.param("vaultId"),
        c.req.param("credentialId"),
      ),
    );
    if (result.type === "not_found") {
      return c.json(
        notFound(`Credential ${c.req.param("credentialId")} was not found`),
        404,
      );
    }
    const response = deletedCredentialResponseSchema.safeParse({
      id: result.credentialId,
      type: "vault_credential_deleted",
    });
    if (!response.success) {
      return c.json(
        apiError("Application returned an invalid credential deletion result"),
        500,
      );
    }
    return c.json(response.data, 200);
  });

  app.post("/:vaultId/credentials/:credentialId/archive", async (c) => {
    const result = await resolveApplicationPort(source, c).archiveCredential(
      toArchiveCredentialCommand(
        c.req.param("vaultId"),
        c.req.param("credentialId"),
      ),
    );
    if (result.type === "not_found") {
      return c.json(
        notFound(`Credential ${c.req.param("credentialId")} was not found`),
        404,
      );
    }
    const response = credentialResponseSchema.safeParse(
      toCredentialResponse(result.credential),
    );
    if (!response.success) {
      return c.json(apiError("Application returned an invalid credential"), 500);
    }
    return c.json(response.data, 200);
  });

  app.post(
    "/:vaultId/credentials/:credentialId/mcp_oauth_validate",
    async (c) => {
      const result = await resolveApplicationPort(source, c).validateCredential(
        toValidateCredentialCommand(
          c.req.param("vaultId"),
          c.req.param("credentialId"),
        ),
      );
      if (result.type === "not_found") {
        return c.json(
          notFound(`Credential ${c.req.param("credentialId")} was not found`),
          404,
        );
      }
      const response = credentialValidationResponseSchema.safeParse(
        toCredentialValidationResponse(result.validation),
      );
      if (!response.success) {
        return c.json(
          apiError("Application returned an invalid credential validation"),
          500,
        );
      }
      return c.json(response.data, 200);
    },
  );

  return app;
}
