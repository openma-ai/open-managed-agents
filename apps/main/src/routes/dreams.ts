import { Hono } from "hono";
import type { Env } from "@open-managed-agents/shared";
import type { Services } from "@open-managed-agents/services";
import {
  DreamInputMemoryStoreMissingError,
  DreamInputSessionMissingError,
  DreamInvalidInputError,
  DreamInvalidStateError,
  DreamNotFoundError,
  type DreamRow,
  type DreamModel,
  MAX_SESSIONS_PER_DREAM,
  SUPPORTED_DREAM_MODELS,
} from "@open-managed-agents/dreams-store";
import { pickCurator, runDream } from "@open-managed-agents/dreams-pipeline";
import {
  DREAMING_BETA,
  MANAGED_AGENTS_BETA,
  requireBetas,
} from "../lib/beta-header";

// REST surface for Managed Agents Dreams.
// Spec: https://platform.claude.com/docs/en/managed-agents/dreams
//
// All endpoints are gated by the `managed-agents-2026-04-01` + `dreaming-2026-04-21`
// beta headers (per spec). The SDK sets these automatically.
//
// Lifecycle is driven entirely by DreamService + the runner — this file is
// only a thin marshal layer. POST /v1/dreams kicks the runner via
// ctx.waitUntil so the response returns promptly with `status: "pending"`.

const app = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; services: Services };
}>();

app.use("*", requireBetas([MANAGED_AGENTS_BETA, DREAMING_BETA]));

// ============================================================
// POST /v1/dreams — create a dream + kick the pipeline
// ============================================================

interface CreateDreamBody {
  inputs?: Array<
    | { type: "memory_store"; memory_store_id?: string }
    | { type: "sessions"; session_ids?: string[] }
  >;
  model?: string;
  instructions?: string | null;
}

app.post("/", async (c) => {
  const t = c.get("tenant_id");
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
    dream = await c.var.services.dreams.create({
      tenantId: t,
      inputMemoryStoreId: inputMemoryStoreId!,
      inputSessionIds: inputSessionIds,
      model: body.model as DreamModel,
      instructions: body.instructions ?? null,
    });
  } catch (err) {
    return mapError(err, c);
  }

  // Kick the in-process pipeline. ctx.waitUntil keeps the Worker alive
  // past the response. On Worker death mid-flight the cron sweep
  // (cron/dream-recovery.ts) re-invokes runDream for any dream stuck in
  // `running` past the staleness window. Steps are idempotent so re-runs
  // are safe.
  //
  const curator = pickCurator(c.env);
  c.executionCtx.waitUntil(
    runDream({
      services: c.var.services,
      curator,
      tenantId: t,
      dreamId: dream.id,
    }).catch((err) => {
      console.error("runDream uncaught", err);
    }),
  );

  return c.json(toApiDream(dream), 201);
});

// ============================================================
// GET /v1/dreams/:id — retrieve a single dream
// ============================================================

app.get("/:id", async (c) => {
  const t = c.get("tenant_id");
  const dream = await c.var.services.dreams.get({ tenantId: t, dreamId: c.req.param("id") });
  if (!dream) return c.json({ error: { type: "not_found_error", message: "Dream not found" } }, 404);
  return c.json(toApiDream(dream));
});

// ============================================================
// GET /v1/dreams — list (paginated)
// ============================================================

app.get("/", async (c) => {
  const t = c.get("tenant_id");
  const includeArchived = c.req.query("include_archived") === "true";
  const limit = parseLimit(c.req.query("limit"));
  const cursor = c.req.query("page");
  const after = parseCursor(cursor);
  const result = await c.var.services.dreams.list({
    tenantId: t,
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

// ============================================================
// POST /v1/dreams/:id/cancel
// ============================================================

app.post("/:id/cancel", async (c) => {
  const t = c.get("tenant_id");
  const dreamId = c.req.param("id");
  try {
    const dream = await c.var.services.dreams.cancel({
      tenantId: t,
      dreamId,
    });
    // The in-process runner re-reads dream.status before every step;
    // it observes the cancel and unwinds within ~1 step's worth of work.
    // No explicit termination handle needed.
    return c.json(toApiDream(dream));
  } catch (err) {
    return mapError(err, c);
  }
});

// ============================================================
// POST /v1/dreams/:id/archive
// ============================================================

app.post("/:id/archive", async (c) => {
  const t = c.get("tenant_id");
  try {
    const dream = await c.var.services.dreams.archive({
      tenantId: t,
      dreamId: c.req.param("id"),
    });
    return c.json(toApiDream(dream));
  } catch (err) {
    return mapError(err, c);
  }
});

// ============================================================
// Helpers
// ============================================================

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
      if (storeSeen) {
        return { inputSessionIds: [], error: "only one memory_store input permitted" };
      }
      storeSeen = true;
      if (typeof entry.memory_store_id !== "string" || !entry.memory_store_id) {
        return {
          inputSessionIds: [],
          error: "inputs[].memory_store_id is required for memory_store input",
        };
      }
      storeId = entry.memory_store_id;
    } else if (entry.type === "sessions") {
      if (sessionsSeen) {
        return { inputSessionIds: [], error: "only one sessions input permitted" };
      }
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
    if (
      decoded &&
      typeof decoded.t === "number" &&
      typeof decoded.id === "string"
    ) {
      return { createdAtMs: decoded.t, id: decoded.id };
    }
  } catch {
    /* fallthrough — bad cursor returns "newest first" page */
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
    return c.json(
      {
        error: {
          type: "invalid_request_error",
          message: err.message,
        },
      },
      400,
    );
  }
  if (err instanceof DreamInputSessionMissingError) {
    return c.json(
      {
        error: {
          type: "invalid_request_error",
          message: err.message,
        },
      },
      400,
    );
  }
  throw err;
}

/** Wire-shape projection. Aligned with the Dream resource shape in the
 *  Managed Agents Dreams API docs. */
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
    type: "dream" as const,
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

export default app;
