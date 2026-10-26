#!/usr/bin/env node

/**
 * Create model cards for a self-hosted OpenMA workspace from a provider key.
 *
 * OpenMA has no platform model key. Every model call (Session turns, Dreams,
 * sub-agents) is paid for with a model card owned by the calling workspace.
 * This script is the self-host quick-start bridge: it takes the provider key
 * an operator used to put in ANTHROPIC_API_KEY and stores it as encrypted
 * model cards through the public /v1/oma/model_cards API. Run it once after
 * the server is up, or add the card in Console → Models instead.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... node scripts/bootstrap-model-card.mjs
 *
 * Environment:
 *   ANTHROPIC_API_KEY         required  provider key stored on the card(s)
 *   ANTHROPIC_BASE_URL        optional  provider endpoint (Anthropic-compatible)
 *   ANTHROPIC_CUSTOM_HEADERS  optional  "Name: value, Other: value"
 *   OMA_MODEL_CARDS           optional  comma-separated model handles
 *                                       (default: claude-sonnet-4-6,claude-opus-4-7)
 *   OMA_MODEL_PROVIDER        optional  card provider id (default: ant)
 *   OMA_BASE_URL              optional  OpenMA URL (default: http://localhost:8787)
 *   OMA_API_KEY               optional  workspace API key or the server's API_KEY;
 *                                       not needed when the server runs AUTH_DISABLED=1
 *   OMA_WORKSPACE_ID          optional  refuse to write unless the credential
 *                                       resolves to this workspace
 *
 * An API key always belongs to exactly one workspace, so the cards land in
 * the workspace of the presented credential (the server's static API_KEY and
 * AUTH_DISABLED both map to the first, "default", workspace). Existing cards
 * with the same model_id are left untouched, so re-running is safe. The
 * provider key is never printed.
 */

import { pathToFileURL } from "node:url";

export const DEFAULT_MODEL_HANDLES = ["claude-sonnet-4-6", "claude-opus-4-7"];

export function parseCustomHeaders(raw) {
  if (!raw) return undefined;
  const headers = {};
  for (const part of String(raw).split(",")) {
    const [name, ...rest] = part.split(":");
    if (!name || !name.trim() || rest.length === 0) continue;
    headers[name.trim()] = rest.join(":").trim();
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

export function parseBootstrapConfig(env = process.env) {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is required: it is the provider key stored on the workspace model card",
    );
  }
  const baseUrl = new URL(env.OMA_BASE_URL?.trim() || "http://localhost:8787");
  if (!["http:", "https:"].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password) {
    throw new Error("OMA_BASE_URL must be an HTTP(S) URL without embedded credentials");
  }
  const models = (env.OMA_MODEL_CARDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return {
    omaBaseUrl: baseUrl.toString().replace(/\/$/, ""),
    omaApiKey: env.OMA_API_KEY?.trim() || undefined,
    workspaceId: env.OMA_WORKSPACE_ID?.trim() || undefined,
    provider: env.OMA_MODEL_PROVIDER?.trim() || "ant",
    providerKey: apiKey,
    providerBaseUrl: env.ANTHROPIC_BASE_URL?.trim().replace(/\/$/, "") || undefined,
    customHeaders: parseCustomHeaders(env.ANTHROPIC_CUSTOM_HEADERS),
    models: [...new Set(models.length > 0 ? models : DEFAULT_MODEL_HANDLES)],
  };
}

/**
 * Ensure one model card per handle exists in the credential's workspace.
 * Returns a JSON-safe report that never contains the provider key.
 */
export async function bootstrapModelCards(config, options = {}) {
  const secrets = [config.providerKey, config.omaApiKey, ...Object.values(config.customHeaders ?? {})]
    .filter((value) => typeof value === "string" && value.length > 0)
    .sort((a, b) => b.length - a.length);
  const redact = (text) => secrets.reduce(
    (result, secret) => result.split(secret).join("[REDACTED]"), String(text),
  );
  try {
    const report = await createWorkspaceModelCards(config, options);
    // Redact strings before serialization so escaping cannot hide a credential.
    return JSON.parse(JSON.stringify(report, (_key, value) =>
      typeof value === "string" ? redact(value) : value,
    ));
  } catch (error) {
    // Do not retain a cause/stack carrying untrusted provider diagnostics.
    throw new Error(redact(error instanceof Error ? error.message : String(error)));
  }
}

async function createWorkspaceModelCards(config, { fetch: fetcher = globalThis.fetch } = {}) {
  const request = async (path, init = {}) => {
    const response = await fetcher(`${config.omaBaseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(config.omaApiKey ? { "x-api-key": config.omaApiKey } : {}),
        ...(init.headers ?? {}),
      },
    });
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: response.status, ok: response.ok, body };
  };
  // Error bodies are untrusted and may echo encoded or partial credentials.
  // Status and operation are sufficient diagnostics for this bootstrap tool.
  const fail = (what, result) => new Error(`${what} failed (HTTP ${result.status})`);

  const me = await request("/v1/oma/me");
  if (!me.ok) throw fail("GET /v1/oma/me", me);
  const workspaceId = me.body?.tenant?.id;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("GET /v1/oma/me did not return a workspace id");
  }
  if (config.workspaceId && config.workspaceId !== workspaceId) {
    throw new Error(
      `The OpenMA credential belongs to workspace ${workspaceId}, not ${config.workspaceId}; ` +
        "use an API key created in the target workspace",
    );
  }

  const existing = [];
  let cursor;
  do {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    const page = await request(`/v1/oma/model_cards${query}`);
    if (!page.ok) throw fail("GET /v1/oma/model_cards", page);
    existing.push(...(Array.isArray(page.body?.data) ? page.body.data : []));
    cursor = page.body?.next_cursor ?? undefined;
  } while (cursor);
  const existingIds = new Set(existing.map((card) => card.model_id));
  let hasDefault = existing.some((card) => card.is_default === true);

  const cards = [];
  for (const modelId of config.models) {
    if (existingIds.has(modelId)) {
      cards.push({ model_id: modelId, status: "exists" });
      continue;
    }
    const created = await request("/v1/oma/model_cards", {
      method: "POST",
      body: JSON.stringify({
        model_id: modelId,
        model: modelId,
        provider: config.provider,
        api_key: config.providerKey,
        ...(config.providerBaseUrl ? { base_url: config.providerBaseUrl } : {}),
        ...(config.customHeaders ? { custom_headers: config.customHeaders } : {}),
        is_default: !hasDefault,
      }),
    });
    if (created.status === 409) {
      cards.push({ model_id: modelId, status: "exists" });
      continue;
    }
    if (!created.ok) throw fail(`POST /v1/oma/model_cards (${modelId})`, created);
    hasDefault = true;
    cards.push({
      model_id: modelId,
      status: "created",
      id: created.body?.id,
      is_default: created.body?.is_default === true,
      probe: created.body?.probe ?? null,
    });
  }
  return { workspace_id: workspaceId, provider: config.provider, cards };
}

async function main() {
  const config = parseBootstrapConfig(process.env);
  const report = await bootstrapModelCards(config);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  const failedProbe = report.cards.find((card) => card.probe && card.probe.ok === false);
  if (failedProbe) {
    process.stderr.write(
      `warning: provider probe for ${failedProbe.model_id} failed: ${failedProbe.probe.message ?? "unknown error"}\n`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`bootstrap-model-card: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
