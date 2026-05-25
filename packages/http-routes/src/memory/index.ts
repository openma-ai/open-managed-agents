// Memory store routes — REST CRUD on memory_stores + memories. Wraps
// services.memory directly; identical behaviour on CF (R2 + D1) and
// Node (LocalFs/S3 + SqlClient).

import { Hono } from "hono";
import type { RouteServicesArg } from "../types";
import { resolveServices } from "../types";

interface Vars {
  Variables: { tenant_id: string; user_id?: string };
}

export interface MemoryRoutesDeps {
  services: RouteServicesArg;
}

export function buildMemoryRoutes(deps: MemoryRoutesDeps) {
  const app = new Hono<Vars>();

  app.post("/", async (c) => {
    const services = resolveServices(deps.services, c);
    const body = await c.req.json<{ name: string; description?: string }>();
    if (!body.name) return c.json({ error: "name is required" }, 400);
    const row = await services.memory.createStore({
      tenantId: c.var.tenant_id,
      name: body.name,
      description: body.description,
    });
    return c.json(row, 201);
  });

  app.get("/", async (c) => {
    const services = resolveServices(deps.services, c);

    // status: enum filter on archive state. Whitelist strictly — any
    // unknown value is a 400, NOT a silent fallback to "any". Allowing
    // arbitrary strings here would mask client bugs (typo'd "active "
    // returning every row looks like a feature).
    const statusRaw = c.req.query("status");
    let status: "active" | "archived" | "any" | undefined;
    if (statusRaw !== undefined) {
      if (statusRaw === "active" || statusRaw === "archived" || statusRaw === "any") {
        status = statusRaw;
      } else {
        return c.json(
          {
            error: {
              type: "invalid_request_error",
              code: "invalid_status",
              message: `Invalid status '${statusRaw}'; expected one of active|archived|any.`,
            },
          },
          400,
        );
      }
    }

    // created_after / created_before: ISO timestamps → epoch ms. Reject
    // unparseable values explicitly so the client knows it's a malformed
    // request, not just "no results".
    const parseMs = (
      raw: string | undefined,
      field: string,
    ): { value: number | undefined; err?: Response } => {
      if (raw === undefined) return { value: undefined };
      const ms = Date.parse(raw);
      if (Number.isNaN(ms)) {
        return {
          value: undefined,
          err: c.json(
            {
              error: {
                type: "invalid_request_error",
                code: "invalid_timestamp",
                message: `Invalid ${field} '${raw}'; expected ISO-8601 timestamp.`,
              },
            },
            400,
          ),
        };
      }
      return { value: ms };
    };
    const createdAfterRes = parseMs(c.req.query("created_after"), "created_after");
    if (createdAfterRes.err) return createdAfterRes.err;
    const createdBeforeRes = parseMs(c.req.query("created_before"), "created_before");
    if (createdBeforeRes.err) return createdBeforeRes.err;

    // include_archived: legacy back-compat — older console builds sent
    // this checkbox boolean before the 3-way status chip existed.
    // Maps to status=any when the new `status` param isn't set. The
    // service layer keeps both for the same reason.
    const includeArchivedRaw = c.req.query("include_archived");
    const includeArchived = includeArchivedRaw === "true";

    const rows = await services.memory.listStores({
      tenantId: c.var.tenant_id,
      ...(status !== undefined ? { status } : {}),
      ...(includeArchivedRaw !== undefined ? { includeArchived } : {}),
      ...(createdAfterRes.value !== undefined
        ? { createdAfter: createdAfterRes.value }
        : {}),
      ...(createdBeforeRes.value !== undefined
        ? { createdBefore: createdBeforeRes.value }
        : {}),
    });
    return c.json({ data: rows });
  });

  app.get("/:id", async (c) => {
    const services = resolveServices(deps.services, c);
    const row = await services.memory.getStore({
      tenantId: c.var.tenant_id,
      storeId: c.req.param("id"),
    });
    if (!row) return c.json({ error: "Memory store not found" }, 404);
    return c.json(row);
  });

  app.post("/:id/memories", async (c) => {
    const services = resolveServices(deps.services, c);
    const body = await c.req.json<{
      path: string;
      content: string;
      precondition?:
        | { type: "content_sha256"; content_sha256: string }
        | { type: "not_exists" };
    }>();
    if (!body.path || body.content === undefined) {
      return c.json({ error: "path and content are required" }, 400);
    }
    try {
      const row = await services.memory.writeByPath({
        tenantId: c.var.tenant_id,
        storeId: c.req.param("id"),
        path: body.path,
        content: body.content,
        precondition: body.precondition,
        actor: { type: "user", id: c.var.user_id ?? c.var.tenant_id },
      });
      return c.json(row, 201);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.get("/:id/memories", async (c) => {
    const services = resolveServices(deps.services, c);
    const rows = await services.memory.listMemories({
      tenantId: c.var.tenant_id,
      storeId: c.req.param("id"),
      pathPrefix: c.req.query("path_prefix") ?? undefined,
    });
    return c.json({ data: rows });
  });

  app.get("/:id/memories/:mid", async (c) => {
    const services = resolveServices(deps.services, c);
    const row = await services.memory.readById({
      tenantId: c.var.tenant_id,
      storeId: c.req.param("id"),
      memoryId: c.req.param("mid"),
    });
    if (!row) return c.json({ error: "Memory not found" }, 404);
    return c.json(row);
  });

  return app;
}
