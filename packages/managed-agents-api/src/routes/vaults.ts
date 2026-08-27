import { Hono } from "hono";
import {
  resolveApplicationPort,
  type ApplicationPortSource,
} from "../application-port-source";
import { MANAGED_AGENTS_BETA, requireBeta } from "../beta";
import {
  deletedVaultResponseSchema,
  vaultCreateBodySchema,
  vaultListQuerySchema,
  vaultPageResponseSchema,
  vaultResponseSchema,
  vaultUpdateBodySchema,
} from "../contracts/vaults";
import { apiError, conflict, invalidRequest, notFound } from "../errors";
import {
  toArchiveVaultCommand,
  toCreateVaultCommand,
  toDeleteVaultCommand,
  toListVaultsQuery,
  toRetrieveVaultQuery,
  toUpdateVaultCommand,
  toVaultResponse,
} from "../mappers/vaults";
import type { VaultsApplicationPort } from "../ports/vaults";

function invalidField(error: { issues: { path: PropertyKey[]; message: string }[] }) {
  const issue = error.issues[0];
  return invalidRequest(
    `Invalid request field ${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid value"}`,
  );
}

export function buildVaultRoutes(
  source: ApplicationPortSource<VaultsApplicationPort>,
): Hono {
  const app = new Hono();
  app.use("*", requireBeta(MANAGED_AGENTS_BETA));

  app.post("/", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(invalidRequest("Request body must be valid JSON"), 400);
    }
    const parsed = vaultCreateBodySchema.safeParse(body);
    if (!parsed.success) return c.json(invalidField(parsed.error), 400);

    const result = await resolveApplicationPort(source, c).createVault(
      toCreateVaultCommand(parsed.data),
    );
    if (result.type === "invalid_request") {
      return c.json(invalidRequest(result.message), 400);
    }
    const response = vaultResponseSchema.safeParse(
      toVaultResponse(result.vault),
    );
    if (!response.success) {
      return c.json(apiError("Application returned an invalid vault"), 500);
    }
    return c.json(response.data, 201);
  });

  app.get("/", async (c) => {
    const query = vaultListQuerySchema.safeParse({
      limit: c.req.query("limit"),
      page: c.req.query("page"),
      include_archived: c.req.query("include_archived"),
    });
    if (!query.success) return c.json(invalidField(query.error), 400);

    const result = await resolveApplicationPort(source, c).listVaults(
      toListVaultsQuery(query.data),
    );
    if (result.type === "invalid_request") {
      return c.json(invalidRequest(result.message), 400);
    }
    const response = vaultPageResponseSchema.safeParse({
      data: result.page.vaults.map(toVaultResponse),
      next_page: result.page.nextCursor,
    });
    if (!response.success) {
      return c.json(apiError("Application returned an invalid vault page"), 500);
    }
    return c.json(response.data, 200);
  });

  app.get("/:vaultId", async (c) => {
    const result = await resolveApplicationPort(source, c).retrieveVault(
      toRetrieveVaultQuery(c.req.param("vaultId")),
    );
    if (result.type === "not_found") {
      return c.json(notFound(`Vault ${c.req.param("vaultId")} was not found`), 404);
    }
    const response = vaultResponseSchema.safeParse(
      toVaultResponse(result.vault),
    );
    if (!response.success) {
      return c.json(apiError("Application returned an invalid vault"), 500);
    }
    return c.json(response.data, 200);
  });

  app.post("/:vaultId", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(invalidRequest("Request body must be valid JSON"), 400);
    }
    const parsed = vaultUpdateBodySchema.safeParse(body);
    if (!parsed.success) return c.json(invalidField(parsed.error), 400);

    const result = await resolveApplicationPort(source, c).updateVault(
      toUpdateVaultCommand(c.req.param("vaultId"), parsed.data),
    );
    if (result.type === "invalid_request") {
      return c.json(invalidRequest(result.message), 400);
    }
    if (result.type === "version_conflict") {
      return c.json(conflict(result.message), 409);
    }
    if (result.type === "not_found") {
      return c.json(notFound(`Vault ${c.req.param("vaultId")} was not found`), 404);
    }
    const response = vaultResponseSchema.safeParse(
      toVaultResponse(result.vault),
    );
    if (!response.success) {
      return c.json(apiError("Application returned an invalid vault"), 500);
    }
    return c.json(response.data, 200);
  });

  app.delete("/:vaultId", async (c) => {
    const result = await resolveApplicationPort(source, c).deleteVault(
      toDeleteVaultCommand(c.req.param("vaultId")),
    );
    if (result.type === "not_found") {
      return c.json(notFound(`Vault ${c.req.param("vaultId")} was not found`), 404);
    }
    const response = deletedVaultResponseSchema.safeParse({
      id: result.vaultId,
      type: "vault_deleted",
    });
    if (!response.success) {
      return c.json(apiError("Application returned an invalid vault deletion result"), 500);
    }
    return c.json(response.data, 200);
  });

  app.post("/:vaultId/archive", async (c) => {
    const result = await resolveApplicationPort(source, c).archiveVault(
      toArchiveVaultCommand(c.req.param("vaultId")),
    );
    if (result.type === "not_found") {
      return c.json(notFound(`Vault ${c.req.param("vaultId")} was not found`), 404);
    }
    const response = vaultResponseSchema.safeParse(
      toVaultResponse(result.vault),
    );
    if (!response.success) {
      return c.json(apiError("Application returned an invalid vault"), 500);
    }
    return c.json(response.data, 200);
  });

  return app;
}
