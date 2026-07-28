import { Hono } from "hono";
import type { Env } from "@open-managed-agents/shared";
import {
  ModelCardDuplicateModelIdError,
  ModelCardNotFoundError,
  type ModelCardRow,
} from "@open-managed-agents/model-cards-store";
import type { Services } from "@open-managed-agents/services";
import { jsonPage, parsePageQuery } from "../lib/list-page";

const app = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; services: Services };
}>();

/**
 * Adapt a `ModelCardRow` to the public API shape. Drops the row's internal
 * `tenant_id` and converts NULL → undefined for optional fields. Field names
 * are 1:1 with the row otherwise.
 */
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
 * Bounded to 6s. Failures NEVER roll back the card (it's already persisted)
 * — purpose is "tell the user upfront whether their key / endpoint works"
 * rather than discovering at first agent run.
 *
 * Provider routing:
 *   - "ant" / "anthropic" / "ant-compatible"  → POST {base}/v1/messages with
 *       max_tokens: 1, model: <model>, messages: [{role:user, content:"hi"}]
 *   - "oai" / "openai" / "oai-compatible"     → POST {base}/v1/chat/completions
 *       with max_completion_tokens: 1, model: <model>
 *   - anything else                            → ok=null (skipped, can't probe)
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
    // Try to extract the structured error.message; fall back to raw body.
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

// POST /v1/model_cards — create
app.post("/", async (c) => {
  const t = c.get("tenant_id");
  const body = await c.req.json<{
    /** User-facing handle, UNIQUE per tenant. */
    model_id: string;
    /** LLM string sent to provider. Defaults to model_id when omitted. */
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
    const card = await c.var.services.modelCards.create({
      tenantId: t,
      modelId: body.model_id,
      provider: body.provider,
      model: body.model,
      apiKey: body.api_key,
      baseUrl: body.base_url ?? null,
      customHeaders: body.custom_headers ?? null,
      makeDefault: !!body.is_default,
    });
    // Probe the model with a minimal request so the user finds out NOW
    // whether the api_key + base_url + custom_headers actually work,
    // instead of at first agent run. Probe is best-effort: card is
    // already persisted and never rolled back. Result rides on the API
    // response so the Console can toast immediately.
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

// GET /v1/model_cards — list (cursor-paginated)
app.get("/", async (c) => {
  // provider: enum filter. Whitelist strictly — any unknown value is a
  // 400, NOT a silent fallback to "all". The enum mirrors what the
  // Console + agent worker recognize (api-types/src/types.ts:9).
  // Allowing arbitrary strings here would mask client bugs (typo'd
  // "ant " returning nothing looks like "no rows for that provider").
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

  const page = await c.var.services.modelCards.listPage({
    tenantId: c.get("tenant_id"),
    ...parsePageQuery(c),
    ...(provider !== undefined ? { provider } : {}),
    ...(createdAfterRes.value !== undefined
      ? { createdAfter: createdAfterRes.value }
      : {}),
    ...(createdBeforeRes.value !== undefined
      ? { createdBefore: createdBeforeRes.value }
      : {}),
  });
  // Hide archived cards (forward-compat with soft-delete; today archived_at
  // is always null but the legacy KV path also filtered, so preserve parity).
  const filteredItems = page.items.filter((card) => card.archived_at === null);
  return jsonPage(c, { items: filteredItems, nextCursor: page.nextCursor }, toApiShape);
});

// GET /v1/model_cards/:id — get single
app.get("/:id", async (c) => {
  const t = c.get("tenant_id");
  const card = await c.var.services.modelCards.get({
    tenantId: t,
    cardId: c.req.param("id"),
  });
  if (!card) return c.json({ error: "Model card not found" }, 404);
  return c.json(toApiShape(card));
});

// POST /v1/model_cards/:id — update
app.post("/:id", async (c) => {
  const t = c.get("tenant_id");
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
    const updated = await c.var.services.modelCards.update({
      tenantId: t,
      cardId: id,
      modelId: body.model_id,
      model: body.model,
      provider: body.provider,
      // Empty string from the form means "clear"; undefined means "leave alone".
      baseUrl: body.base_url === undefined
        ? undefined
        : (body.base_url || null),
      customHeaders: body.custom_headers === undefined
        ? undefined
        : (body.custom_headers || null),
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

// DELETE /v1/model_cards/:id — delete
app.delete("/:id", async (c) => {
  const t = c.get("tenant_id");
  const id = c.req.param("id");
  try {
    await c.var.services.modelCards.delete({ tenantId: t, cardId: id });
    return c.json({ type: "model_card_deleted", id });
  } catch (err) {
    if (err instanceof ModelCardNotFoundError) {
      return c.json({ error: "Model card not found" }, 404);
    }
    throw err;
  }
});

// GET /v1/model_cards/:id/key — internal: get actual API key (used by agent worker)
app.get("/:id/key", async (c) => {
  const t = c.get("tenant_id");
  const id = c.req.param("id");
  const apiKey = await c.var.services.modelCards.getApiKey({ tenantId: t, cardId: id });
  if (apiKey === null) return c.json({ error: "Key not found" }, 404);
  return c.json({ api_key: apiKey });
});

export default app;
