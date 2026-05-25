// Environments routes — post-GitHub-build replacement.
//
// The legacy `dockerfile` build path (GitHub Actions → per-env worker →
// /build-complete callback) was removed once setup-on-warmup landed
// (apps/agent/src/runtime/setup-on-warmup.ts). Now env create writes a
// D1 row and returns immediately — packages are installed at the FIRST
// session warmup by the SessionDO, not at env-create time.
//
// Removed:
//   - triggerBuild() + GitHub workflow_dispatch
//   - /build-complete callback
//   - image_strategy / pickStrategy
//   - per-env sandbox_worker_name + service-binding plumbing
//
// What stayed:
//   - Standard CRUD (GET / POST / PUT / archive)
//   - Networking + packages config in EnvironmentConfig
//   - Tenant scoping

import { Hono } from "hono";
import type { Env } from "@open-managed-agents/shared";
import type { EnvironmentConfig } from "@open-managed-agents/shared";
import type { Services } from "@open-managed-agents/services";
import {
  toEnvironmentConfig,
  EnvironmentNotFoundError,
} from "@open-managed-agents/environments-store";
import { jsonPage, parsePageQuery } from "../lib/list-page";
import { validateEnvironmentLimits } from "../lib/limits";

const app = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; services: Services };
}>();

// POST /v1/environments — create environment
app.post("/", async (c) => {
  const t = c.get("tenant_id");
  const body = (await c.req.json()) as {
    name: string;
    description?: string;
    config: EnvironmentConfig["config"];
  };

  if (!body.name) {
    return c.json({ error: "name is required" }, 400);
  }

  // Field-size caps (Anthropic-aligned for shared fields; OMA-specific
  // for config.dockerfile / config.packages). See lib/limits.ts.
  const limitCheck = validateEnvironmentLimits(body);
  if (!limitCheck.ok) {
    return c.json({ error: limitCheck.error }, 400);
  }

  const row = await c.var.services.environments.create({
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

// GET /v1/environments — list environments (cursor-paginated)
app.get("/", async (c) => {
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

  const page = await c.var.services.environments.listPage({
    tenantId: c.get("tenant_id"),
    ...parsePageQuery(c),
    ...(status !== undefined ? { status } : {}),
    ...(createdAfterRes.value !== undefined
      ? { createdAfter: createdAfterRes.value }
      : {}),
    ...(createdBeforeRes.value !== undefined
      ? { createdBefore: createdBeforeRes.value }
      : {}),
  });
  return jsonPage(c, page, toEnvironmentConfig);
});

// GET /v1/environments/:id — get environment
app.get("/:id", async (c) => {
  const t = c.get("tenant_id");
  const id = c.req.param("id");
  const row = await c.var.services.environments.get({ tenantId: t, environmentId: id });
  if (!row) return c.json({ error: "Environment not found" }, 404);
  return c.json(toEnvironmentConfig(row));
});

// PUT (and POST) /v1/environments/:id — update environment (re-prepares image if config changed)
// POST alias mirrors Anthropic Managed-Agents SDK convention so users can drop in
// `client.beta.environments.update(...)` from the official @anthropic-ai/sdk unchanged.
app.on(["PUT", "POST"], "/:id", async (c) => {
  const t = c.get("tenant_id");
  const id = c.req.param("id");
  const existing = await c.var.services.environments.get({ tenantId: t, environmentId: id });
  if (!existing) return c.json({ error: "Environment not found" }, 404);

  const body = (await c.req.json()) as {
    name?: string;
    description?: string;
    config?: EnvironmentConfig["config"];
    metadata?: Record<string, unknown>;
  };

  // Field-size caps (Anthropic-aligned for shared fields; OMA-specific
  // for config.dockerfile / config.packages). See lib/limits.ts.
  const limitCheck = validateEnvironmentLimits(body);
  if (!limitCheck.ok) {
    return c.json({ error: limitCheck.error }, 400);
  }

  const patch: Parameters<typeof c.var.services.environments.update>[0] = {
    tenantId: t,
    environmentId: id,
  };
  if (body.name !== undefined) patch.name = body.name;
  if (body.description !== undefined) patch.description = body.description;
  if (body.config !== undefined) patch.config = body.config;
  if (body.metadata !== undefined) patch.metadata = body.metadata;

  // No re-build trigger — packages take effect at the next session
  // warmup via setup-on-warmup's hash-mismatch detection (the marker
  // hash bakes in the new packages list, so ensureSetupApplied falls
  // through to the fresh path automatically).
  const row = await c.var.services.environments.update(patch);
  return c.json(toEnvironmentConfig(row));
});

// POST /v1/environments/:id/archive
app.post("/:id/archive", async (c) => {
  const t = c.get("tenant_id");
  const id = c.req.param("id");
  try {
    const row = await c.var.services.environments.archive({
      tenantId: t,
      environmentId: id,
    });
    return c.json(toEnvironmentConfig(row));
  } catch (err) {
    if (err instanceof EnvironmentNotFoundError) {
      return c.json({ error: "Environment not found" }, 404);
    }
    throw err;
  }
});

// DELETE /v1/environments/:id — hard delete. Pairs with POST archive
// for the two-tier delete UX the console exposes via RowActionsMenu.
app.delete("/:id", async (c) => {
  const t = c.get("tenant_id");
  const id = c.req.param("id");
  try {
    await c.var.services.environments.delete({
      tenantId: t,
      environmentId: id,
    });
    return c.json({ deleted: true });
  } catch (err) {
    if (err instanceof EnvironmentNotFoundError) {
      return c.json({ error: "Environment not found" }, 404);
    }
    throw err;
  }
});

export default app;
