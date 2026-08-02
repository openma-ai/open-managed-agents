// Model cards — CRUD + capability probe.
//
// Sourced from apps/main/src/routes/model-cards.ts. Same wire shape so the
// Console Model Cards page works against CF and main-node without branching.

import { Hono } from "hono";
import {
  ModelCardDuplicateModelIdError,
  ModelCardNotFoundError,
  type ModelCardRow,
  type ModelCardService,
} from "@open-managed-agents/model-cards-store";

interface Vars {
  Variables: { tenant_id: string };
}

function toApiShape(card: ModelCardRow) {
  return {
    id: card.id,
    model_id: card.model_id,
    model: card.model,
    provider: card.provider,
    api_key_preview: card.api_key_preview,
    base_url: card.base_url ?? undefined,
    custom_headers: card.custom_headers ?? undefined,
    is_default: card.is_default,
    created_at: card.created_at,
    updated_at: card.updated_at ?? undefined,
    archived_at: card.archived_at,
  };
}

/**
 * Best-effort capability probe for a freshly-created model card. Calls the
 * provider's smallest available endpoint with the user-supplied api_key /
 * base_url / custom_headers and returns ok=true on 2xx, otherwise ok=false
 * with the upstream's own error message.
 *
 * Bounded to 6s. Failures NEVER roll back the card (it's already persisted).
 */
async function probeModelCard(opts: {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string | null;
  customHeaders: Record<string, string> | null;
}): Promise<{ ok: boolean; message?: string } | { ok: null; reason: "unsupported_provider" }> {
  const provider = opts.provider.toLowerCase();
  const isAnt = /^(ant|anthropic|ant-compatible)$/.test(provider);
  const isOai = /^(oai|openai|oai-compatible)$/.test(provider);
  if (!isAnt && !isOai) return { ok: null, reason: "unsupported_provider" };

  const url = isAnt
    ? `${opts.baseUrl ?? "https://api.anthropic.com"}/v1/messages`
    : `${opts.baseUrl ?? "https://api.openai.com"}/v1/chat/completions`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(opts.customHeaders ?? {}),
  };
  let body: string;
  if (isAnt) {
    headers["x-api-key"] = opts.apiKey;
    headers["anthropic-version"] = "2023-06-01";
    body = JSON.stringify({
      model: opts.model,
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    });
  } else {
    headers["authorization"] = `Bearer ${opts.apiKey}`;
    body = JSON.stringify({
      model: opts.model,
      max_completion_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    });
  }

  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 6000);
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers, body, signal: ac.signal });
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 200 && res.status < 300) return { ok: true };
    const upstream = await res.text().catch(() => "");
    let detail = upstream.slice(0, 240).trim();
    try {
      const j = JSON.parse(upstream) as { error?: { message?: string } | string };
      const m =
        typeof j.error === "string"
          ? j.error
          : typeof j.error === "object" && j.error?.message
            ? j.error.message
            : "";
      if (m) detail = m.slice(0, 240);
    } catch {
      /* keep raw */
    }
    return {
      ok: false,
      message: `Provider returned HTTP ${res.status}${detail ? `: ${detail}` : ""}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `Probe failed: ${msg.slice(0, 120)}` };
  }
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

export interface ModelCardRoutesDeps {
  modelCards: ModelCardService;
}

export function buildModelCardRoutes(deps: ModelCardRoutesDeps) {
  const app = new Hono<Vars>();
  const { modelCards } = deps;

  // POST / — create
  app.post("/", async (c) => {
    const t = c.var.tenant_id;
    const body = await c.req.json<{
      model_id: string;
      model?: string;
      provider: string;
      api_key: string;
      base_url?: string;
      custom_headers?: Record<string, string>;
      is_default?: boolean;
    }>();

    if (!body.model_id || !body.provider || !body.api_key) {
      return c.json({ error: "model_id, provider, and api_key are required" }, 400);
    }
    try {
      const card = await modelCards.create({
        tenantId: t,
        modelId: body.model_id,
        provider: body.provider,
        model: body.model,
        apiKey: body.api_key,
        baseUrl: body.base_url ?? null,
        customHeaders: body.custom_headers ?? null,
        makeDefault: !!body.is_default,
      });
      const probe = await probeModelCard({
        provider: body.provider,
        model: body.model ?? body.model_id,
        apiKey: body.api_key,
        baseUrl: body.base_url ?? null,
        customHeaders: body.custom_headers ?? null,
      });
      return c.json({ ...toApiShape(card), probe }, 201);
    } catch (err) {
      if (err instanceof ModelCardDuplicateModelIdError) {
        return c.json({ error: err.message }, 409);
      }
      throw err;
    }
  });

  // GET / — list (cursor-paginated)
  app.get("/", async (c) => {
    const providerRaw = c.req.query("provider");
    const PROVIDERS = ["ant", "ant-compatible", "oai", "oai-compatible"] as const;
    let provider: (typeof PROVIDERS)[number] | undefined;
    if (providerRaw !== undefined) {
      if ((PROVIDERS as readonly string[]).includes(providerRaw)) {
        provider = providerRaw as (typeof PROVIDERS)[number];
      } else {
        return c.json(
          {
            error: {
              type: "invalid_request_error",
              code: "invalid_provider",
              message: `Invalid provider '${providerRaw}'; expected one of ${PROVIDERS.join("|")}.`,
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
    const createdBeforeRes = parseMs(c.req.query("created_before"), "created_before");
    if (createdBeforeRes.err) return createdBeforeRes.err;

    const page = await modelCards.listPage({
      tenantId: c.var.tenant_id,
      ...parsePageQuery(c),
      ...(provider !== undefined ? { provider } : {}),
      ...(createdAfterRes.value !== undefined
        ? { createdAfter: createdAfterRes.value }
        : {}),
      ...(createdBeforeRes.value !== undefined
        ? { createdBefore: createdBeforeRes.value }
        : {}),
    });
    const filteredItems = page.items.filter((card) => card.archived_at === null);
    const data = filteredItems.map(toApiShape);
    if (!page.nextCursor) return c.json({ data });
    return c.json({
      data,
      next_page: page.nextCursor,
      next_cursor: page.nextCursor,
    });
  });

  // GET /:id
  app.get("/:id", async (c) => {
    const card = await modelCards.get({
      tenantId: c.var.tenant_id,
      cardId: c.req.param("id"),
    });
    if (!card) return c.json({ error: "Model card not found" }, 404);
    return c.json(toApiShape(card));
  });

  // POST /:id — update
  app.post("/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{
      model_id?: string;
      model?: string;
      provider?: string;
      api_key?: string;
      base_url?: string | null;
      custom_headers?: Record<string, string> | null;
      is_default?: boolean;
    }>();
    try {
      const updated = await modelCards.update({
        tenantId: c.var.tenant_id,
        cardId: id,
        modelId: body.model_id,
        model: body.model,
        provider: body.provider,
        baseUrl:
          body.base_url === undefined ? undefined : body.base_url || null,
        customHeaders:
          body.custom_headers === undefined
            ? undefined
            : body.custom_headers || null,
        apiKey: body.api_key,
        isDefault: body.is_default,
      });
      return c.json(toApiShape(updated));
    } catch (err) {
      if (err instanceof ModelCardNotFoundError) {
        return c.json({ error: "Model card not found" }, 404);
      }
      if (err instanceof ModelCardDuplicateModelIdError) {
        return c.json({ error: err.message }, 409);
      }
      throw err;
    }
  });

  // DELETE /:id
  app.delete("/:id", async (c) => {
    const id = c.req.param("id");
    try {
      await modelCards.delete({ tenantId: c.var.tenant_id, cardId: id });
      return c.json({ type: "model_card_deleted", id });
    } catch (err) {
      if (err instanceof ModelCardNotFoundError) {
        return c.json({ error: "Model card not found" }, 404);
      }
      throw err;
    }
  });

  // GET /:id/key — cleartext key (agent / internal consumers)
  app.get("/:id/key", async (c) => {
    const apiKey = await modelCards.getApiKey({
      tenantId: c.var.tenant_id,
      cardId: c.req.param("id"),
    });
    if (apiKey === null) return c.json({ error: "Key not found" }, 404);
    return c.json({ api_key: apiKey });
  });

  return app;
}
