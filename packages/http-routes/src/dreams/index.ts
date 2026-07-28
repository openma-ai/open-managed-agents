import { Hono } from "hono";
import {
  DreamInputMemoryStoreMissingError,
  DreamInputSessionMissingError,
  DreamInvalidInputError,
  DreamInvalidStateError,
  DreamNotFoundError,
  MAX_SESSIONS_PER_DREAM,
  SUPPORTED_DREAM_MODELS,
  type DreamModel,
  type DreamRow,
} from "@open-managed-agents/dreams-store";
import {
  pickCurator,
  runDream,
  type DreamCuratorEnv,
  type DreamPipelineServices,
} from "@open-managed-agents/dreams-pipeline";
import type { RouteServicesArg } from "../types";
import { resolveServices } from "../types";

const MANAGED_AGENTS_BETA = "managed-agents-2026-04-01";
const DREAMING_BETA = "dreaming-2026-04-21";

interface Vars {
  Variables: { tenant_id: string; user_id?: string };
}

export interface DreamRoutesDeps {
  services: RouteServicesArg;
  curatorEnv: DreamCuratorEnv;
}

interface CreateDreamBody {
  inputs?: Array<
    | { type: "memory_store"; memory_store_id?: string }
    | { type: "sessions"; session_ids?: string[] }
  >;
  model?: string;
  instructions?: string | null;
}

export function buildDreamRoutes(deps: DreamRoutesDeps) {
  const app = new Hono<Vars>();

  app.use("*", requireBetas([MANAGED_AGENTS_BETA, DREAMING_BETA]));

  app.post("/", async (c) => {
    const services = resolveServices(deps.services, c);
    if (!services.dreams) {
      return c.json({ error: { type: "api_error", message: "Dreams service is not configured" } }, 501);
    }
    const tenantId = c.var.tenant_id;
    const body = (await c.req.json().catch(() => ({}))) as CreateDreamBody;
    const { inputMemoryStoreId, inputSessionIds, error: parseError } = parseInputs(body.inputs);
    if (parseError) {
      return c.json({ error: { type: "invalid_request_error", message: parseError } }, 400);
    }
    if (!body.model || !SUPPORTED_DREAM_MODELS.includes(body.model as DreamModel)) {
      return c.json(
        {
          error: {
            type: "invalid_request_error",
            message: `model must be one of: ${SUPPORTED_DREAM_MODELS.join(", ")}`,
          },
        },
        400,
      );
    }

    let dream: DreamRow;
    try {
      dream = await services.dreams.create({
        tenantId,
        inputMemoryStoreId: inputMemoryStoreId!,
        inputSessionIds,
        model: body.model as DreamModel,
        instructions: body.instructions ?? null,
      });
    } catch (err) {
      return mapError(err, c);
    }

    const curator = pickCurator(deps.curatorEnv);
    const pipelineServices: DreamPipelineServices = {
      dreams: services.dreams,
      memory: services.memory,
      sessions: services.sessions ?? null,
      memoryStoreTenantIndex: null,
    };
    services.background.run(
      runDream({
        services: pipelineServices,
        curator,
        tenantId,
        dreamId: dream.id,
      }),
    );

    return c.json(toApiDream(dream), 201);
  });

  app.get("/:id", async (c) => {
    const services = resolveServices(deps.services, c);
    if (!services.dreams) {
      return c.json({ error: { type: "api_error", message: "Dreams service is not configured" } }, 501);
    }
    const dream = await services.dreams.get({
      tenantId: c.var.tenant_id,
      dreamId: c.req.param("id"),
    });
    if (!dream) return c.json({ error: { type: "not_found_error", message: "Dream not found" } }, 404);
    return c.json(toApiDream(dream));
  });

  app.get("/", async (c) => {
    const services = resolveServices(deps.services, c);
    if (!services.dreams) {
      return c.json({ error: { type: "api_error", message: "Dreams service is not configured" } }, 501);
    }
    const includeArchived = c.req.query("include_archived") === "true";
    const limit = parseLimit(c.req.query("limit"));
    const after = parseCursor(c.req.query("page"));
    const result = await services.dreams.list({
      tenantId: c.var.tenant_id,
      includeArchived,
      limit,
      after,
    });
    const items = result.items.map(toApiDream);
    const nextCursor = result.hasMore && result.items.length > 0
      ? encodeCursor(result.items[result.items.length - 1])
      : null;
    return c.json({
      data: items,
      has_more: result.hasMore,
      next_page: nextCursor,
    });
  });

  app.post("/:id/cancel", async (c) => {
    const services = resolveServices(deps.services, c);
    if (!services.dreams) {
      return c.json({ error: { type: "api_error", message: "Dreams service is not configured" } }, 501);
    }
    try {
      const dream = await services.dreams.cancel({
        tenantId: c.var.tenant_id,
        dreamId: c.req.param("id"),
      });
      return c.json(toApiDream(dream));
    } catch (err) {
      return mapError(err, c);
    }
  });

  app.post("/:id/archive", async (c) => {
    const services = resolveServices(deps.services, c);
    if (!services.dreams) {
      return c.json({ error: { type: "api_error", message: "Dreams service is not configured" } }, 501);
    }
    try {
      const dream = await services.dreams.archive({
        tenantId: c.var.tenant_id,
        dreamId: c.req.param("id"),
      });
      return c.json(toApiDream(dream));
    } catch (err) {
      return mapError(err, c);
    }
  });

  return app;
}

function requireBetas(required: string[]) {
  return async (c: Parameters<Parameters<Hono<Vars>["use"]>[1]>[0], next: () => Promise<void>) => {
    const raw = c.req.header("anthropic-beta") ?? "";
    const present = new Set(
      raw
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
    );
    const missing = required.filter((beta) => !present.has(beta));
    if (missing.length > 0) {
      return c.json(
        {
          error: {
            type: "invalid_request_error",
            message: `Missing required anthropic-beta flag(s): ${missing.join(", ")}`,
          },
        },
        400,
      );
    }
    await next();
  };
}

function parseInputs(inputs: CreateDreamBody["inputs"]): {
  inputMemoryStoreId?: string;
  inputSessionIds: string[];
  error?: string;
} {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    return { inputSessionIds: [], error: "inputs[] is required" };
  }
  let storeId: string | undefined;
  let storeSeen = false;
  const sessionIds: string[] = [];
  let sessionsSeen = false;
  for (const entry of inputs) {
    if (!entry || typeof entry !== "object") {
      return { inputSessionIds: [], error: "inputs[] entries must be objects" };
    }
    if (entry.type === "memory_store") {
      if (storeSeen) return { inputSessionIds: [], error: "only one memory_store input permitted" };
      storeSeen = true;
      if (typeof entry.memory_store_id !== "string" || !entry.memory_store_id) {
        return {
          inputSessionIds: [],
          error: "inputs[].memory_store_id is required for memory_store input",
        };
      }
      storeId = entry.memory_store_id;
    } else if (entry.type === "sessions") {
      if (sessionsSeen) return { inputSessionIds: [], error: "only one sessions input permitted" };
      sessionsSeen = true;
      if (!Array.isArray(entry.session_ids)) {
        return { inputSessionIds: [], error: "inputs[].session_ids must be an array" };
      }
      if (entry.session_ids.length > MAX_SESSIONS_PER_DREAM) {
        return {
          inputSessionIds: [],
          error: `sessions per dream capped at ${MAX_SESSIONS_PER_DREAM}`,
        };
      }
      for (const sid of entry.session_ids) {
        if (typeof sid !== "string" || !sid) {
          return { inputSessionIds: [], error: "session_ids[] must contain strings" };
        }
        sessionIds.push(sid);
      }
    } else {
      return {
        inputSessionIds: [],
        error: `unknown inputs[].type: ${(entry as { type?: string }).type}`,
      };
    }
  }
  if (!storeId) {
    return { inputSessionIds: [], error: "inputs[] must include a memory_store entry" };
  }
  return { inputMemoryStoreId: storeId, inputSessionIds: sessionIds };
}

function parseLimit(raw?: string): number {
  if (!raw) return 20;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 20;
  return Math.min(n, 100);
}

function parseCursor(raw?: string): { createdAtMs: number; id: string } | undefined {
  if (!raw) return undefined;
  try {
    const decoded = JSON.parse(atob(raw));
    if (decoded && typeof decoded.t === "number" && typeof decoded.id === "string") {
      return { createdAtMs: decoded.t, id: decoded.id };
    }
  } catch {
    /* bad cursor returns newest-first page */
  }
  return undefined;
}

function encodeCursor(row: DreamRow): string {
  return btoa(JSON.stringify({ t: Date.parse(row.created_at), id: row.id }));
}

function mapError(err: unknown, c: { json: (b: unknown, status: number) => Response }): Response {
  if (err instanceof DreamNotFoundError) {
    return c.json({ error: { type: "not_found_error", message: err.message } }, 404);
  }
  if (err instanceof DreamInvalidStateError) {
    return c.json({ error: { type: "invalid_request_error", message: err.message } }, 400);
  }
  if (err instanceof DreamInvalidInputError) {
    return c.json({ error: { type: "invalid_request_error", message: err.message } }, 400);
  }
  if (err instanceof DreamInputMemoryStoreMissingError) {
    return c.json({ error: { type: "invalid_request_error", message: err.message } }, 400);
  }
  if (err instanceof DreamInputSessionMissingError) {
    return c.json({ error: { type: "invalid_request_error", message: err.message } }, 400);
  }
  throw err;
}

function toApiDream(d: DreamRow): Record<string, unknown> {
  const inputs: Array<Record<string, unknown>> = [
    { type: "memory_store", memory_store_id: d.input_memory_store_id },
  ];
  if (d.input_session_ids.length > 0) {
    inputs.push({ type: "sessions", session_ids: d.input_session_ids });
  }
  const outputs: Array<Record<string, unknown>> = d.output_memory_store_id
    ? [{ type: "memory_store", memory_store_id: d.output_memory_store_id }]
    : [];
  return {
    type: "dream",
    id: d.id,
    status: d.status,
    inputs,
    outputs,
    model: { id: d.model },
    instructions: d.instructions,
    session_id: d.session_id,
    created_at: d.created_at,
    started_at: d.started_at,
    ended_at: d.ended_at,
    archived_at: d.archived_at,
    usage: d.usage,
    error: d.error,
  };
}
