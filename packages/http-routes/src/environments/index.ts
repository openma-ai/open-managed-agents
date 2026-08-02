// Environments — CRUD + archive.
//
// Sourced from apps/main/src/routes/environments.ts post-setup-on-warmup.
// Same wire shape so the Console Environments page works against CF and
// main-node without branching. Limits validation is optional (CF passes
// its Anthropic-aligned caps; Node may omit).

import { Hono } from "hono";
import type { EnvironmentConfig } from "@open-managed-agents/shared";
import {
  EnvironmentNotFoundError,
  toEnvironmentConfig,
  type EnvironmentService,
} from "@open-managed-agents/environments-store";
import type { SessionService } from "@open-managed-agents/sessions-store";

interface Vars {
  Variables: { tenant_id: string };
}

function parsePageQuery(c: {
  req: { query: (k: string) => string | undefined };
}): {
  limit?: number;
  cursor?: string;
  q?: string;
} {
  const limitParam = c.req.query("limit");
  const cursor = c.req.query("cursor") || c.req.query("page") || undefined;
  const limit = limitParam ? parseInt(limitParam, 10) : undefined;
  const qRaw = c.req.query("q");
  const q = qRaw && qRaw.trim() ? qRaw.trim() : undefined;
  return {
    limit: limit !== undefined && !isNaN(limit) ? limit : undefined,
    cursor,
    q,
  };
}

export interface EnvironmentRoutesDeps {
  environments: EnvironmentService;
  /** When provided, DELETE refuses while sessions still reference the env. */
  sessions?: SessionService;
  /** Optional field-size caps (CF wires apps/main/src/lib/limits). */
  validateLimits?: (body: unknown) => { ok: boolean; error?: string };
}

export function buildEnvironmentRoutes(deps: EnvironmentRoutesDeps) {
  const app = new Hono<Vars>();
  const { environments, sessions, validateLimits } = deps;

  // POST / — create
  app.post("/", async (c) => {
    const t = c.var.tenant_id;
    const body = (await c.req.json()) as {
      name: string;
      description?: string;
      config: EnvironmentConfig["config"];
    };

    if (!body.name) {
      return c.json({ error: "name is required" }, 400);
    }

    if (validateLimits) {
      const limitCheck = validateLimits(body);
      if (!limitCheck.ok) {
        return c.json({ error: limitCheck.error }, 400);
      }
    }

    const row = await environments.create({
      tenantId: t,
      name: body.name,
      description: body.description,
      config: body.config || { type: "cloud" },
      // Setup-on-warmup means env is immediately usable — no async build.
      status: "ready",
      sandboxWorkerName: "sandbox-default",
      imageStrategy: null,
    });

    return c.json(toEnvironmentConfig(row), 201);
  });

  // GET / — list (cursor-paginated)
  app.get("/", async (c) => {
    const statusRaw = c.req.query("status");
    let status: "active" | "archived" | "any" | undefined;
    if (statusRaw !== undefined) {
      if (
        statusRaw === "active" ||
        statusRaw === "archived" ||
        statusRaw === "any"
      ) {
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
    const createdBeforeRes = parseMs(
      c.req.query("created_before"),
      "created_before",
    );
    if (createdBeforeRes.err) return createdBeforeRes.err;

    const page = await environments.listPage({
      tenantId: c.var.tenant_id,
      ...parsePageQuery(c),
      ...(status !== undefined ? { status } : {}),
      ...(createdAfterRes.value !== undefined
        ? { createdAfter: createdAfterRes.value }
        : {}),
      ...(createdBeforeRes.value !== undefined
        ? { createdBefore: createdBeforeRes.value }
        : {}),
    });
    const data = page.items.map(toEnvironmentConfig);
    if (!page.nextCursor) return c.json({ data });
    return c.json({
      data,
      next_page: page.nextCursor,
      next_cursor: page.nextCursor,
    });
  });

  // GET /:id
  app.get("/:id", async (c) => {
    const row = await environments.get({
      tenantId: c.var.tenant_id,
      environmentId: c.req.param("id"),
    });
    if (!row) return c.json({ error: "Environment not found" }, 404);
    return c.json(toEnvironmentConfig(row));
  });

  // POST /:id/archive — register before generic POST /:id update
  app.post("/:id/archive", async (c) => {
    try {
      const row = await environments.archive({
        tenantId: c.var.tenant_id,
        environmentId: c.req.param("id"),
      });
      return c.json(toEnvironmentConfig(row));
    } catch (err) {
      if (err instanceof EnvironmentNotFoundError) {
        return c.json({ error: "Environment not found" }, 404);
      }
      throw err;
    }
  });

  // PUT + POST /:id — update (Anthropic SDK uses POST)
  app.on(["PUT", "POST"], "/:id", async (c) => {
    const t = c.var.tenant_id;
    const id = c.req.param("id");

    const existing = await environments.get({ tenantId: t, environmentId: id });
    if (!existing) return c.json({ error: "Environment not found" }, 404);

    const body = (await c.req.json()) as {
      name?: string;
      description?: string;
      config?: EnvironmentConfig["config"];
      metadata?: Record<string, unknown>;
    };

    if (validateLimits) {
      const limitCheck = validateLimits(body);
      if (!limitCheck.ok) {
        return c.json({ error: limitCheck.error }, 400);
      }
    }

    const patch: Parameters<typeof environments.update>[0] = {
      tenantId: t,
      environmentId: id,
    };
    if (body.name !== undefined) patch.name = body.name;
    if (body.description !== undefined) patch.description = body.description;
    if (body.config !== undefined) patch.config = body.config;
    if (body.metadata !== undefined) patch.metadata = body.metadata;

    const row = await environments.update(patch);
    return c.json(toEnvironmentConfig(row));
  });

  // DELETE /:id
  app.delete("/:id", async (c) => {
    const t = c.var.tenant_id;
    const id = c.req.param("id");
    try {
      if (sessions) {
        const hasActiveSessions = await sessions.hasActiveByEnvironment({
          tenantId: t,
          environmentId: id,
        });
        if (hasActiveSessions) {
          return c.json(
            {
              error:
                "Cannot delete environment with active sessions. Archive or delete sessions first.",
            },
            409,
          );
        }
      }

      await environments.delete({ tenantId: t, environmentId: id });
      return c.json({ type: "environment_deleted", id });
    } catch (err) {
      if (err instanceof EnvironmentNotFoundError) {
        return c.json({ error: "Environment not found" }, 404);
      }
      throw err;
    }
  });

  return app;
}
