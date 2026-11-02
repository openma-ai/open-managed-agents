import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  DEFAULT_MODEL_HANDLES,
  bootstrapModelCards,
  parseBootstrapConfig,
  parseCustomHeaders,
} from "./bootstrap-model-card.mjs";

const PROVIDER_KEY = "sk-provider-secret-value";

/** Minimal /v1/oma surface: workspace lookup plus a paged model-card store. */
async function fakeOpenMA({ workspaceId = "default", existing = [], requireKey } = {}) {
  const cards = existing.map((card, index) => ({ id: `mc_existing_${index}`, is_default: false, ...card }));
  const posts = [];
  const server = createServer(async (request, response) => {
    const send = (status, body) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (requireKey && request.headers["x-api-key"] !== requireKey) return send(401, { error: "Unauthorized" });
    const url = new URL(request.url ?? "/", "http://fixture");
    if (request.method === "GET" && url.pathname === "/v1/oma/me") {
      return send(200, { tenant: { id: workspaceId, name: "" } });
    }
    if (request.method === "GET" && url.pathname === "/v1/oma/model_cards") {
      // One card per page so pagination is exercised.
      const offset = Number(url.searchParams.get("cursor") ?? 0);
      const page = cards.slice(offset, offset + 1);
      const next = offset + 1 < cards.length ? String(offset + 1) : undefined;
      return send(200, { data: page, ...(next ? { next_cursor: next } : {}) });
    }
    if (request.method === "POST" && url.pathname === "/v1/oma/model_cards") {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      posts.push(body);
      if (cards.some((card) => card.model_id === body.model_id)) return send(409, { error: "duplicate" });
      const card = { id: `mc_${cards.length}`, model_id: body.model_id, is_default: body.is_default === true };
      cards.push(card);
      return send(201, { ...card, probe: { ok: true } });
    }
    return send(404, { error: "not found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    cards,
    posts,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("config requires the provider key and defaults to the Dream-supported handles", () => {
  assert.throws(() => parseBootstrapConfig({}), /ANTHROPIC_API_KEY is required/);
  const config = parseBootstrapConfig({
    ANTHROPIC_API_KEY: PROVIDER_KEY,
    ANTHROPIC_BASE_URL: "https://llm.example/",
    ANTHROPIC_CUSTOM_HEADERS: "X-A: 1, X-B: two:parts",
  });
  assert.equal(config.omaBaseUrl, "http://localhost:8787");
  assert.equal(config.providerBaseUrl, "https://llm.example");
  assert.deepEqual(config.customHeaders, { "X-A": "1", "X-B": "two:parts" });
  assert.deepEqual(config.models, DEFAULT_MODEL_HANDLES);
  assert.deepEqual(
    parseBootstrapConfig({ ANTHROPIC_API_KEY: "k", OMA_MODEL_CARDS: "a, b,a" }).models,
    ["a", "b"],
  );
  assert.equal(parseCustomHeaders(""), undefined);
  assert.throws(
    () => parseBootstrapConfig({ ANTHROPIC_API_KEY: "k", OMA_BASE_URL: "http://u:p@host" }),
    /without embedded credentials/,
  );
});

test("creates one card per handle in the credential's workspace and is idempotent", async () => {
  const oma = await fakeOpenMA({
    workspaceId: "tn_first",
    requireKey: "oma-key",
    existing: [{ model_id: "already-there" }],
  });
  try {
    const config = parseBootstrapConfig({
      OMA_BASE_URL: oma.baseUrl,
      OMA_API_KEY: "oma-key",
      OMA_WORKSPACE_ID: "tn_first",
      ANTHROPIC_API_KEY: PROVIDER_KEY,
      ANTHROPIC_BASE_URL: "https://llm.example",
      OMA_MODEL_CARDS: "already-there,claude-sonnet-4-6,claude-opus-4-7",
    });
    const report = await bootstrapModelCards(config);
    assert.equal(report.workspace_id, "tn_first");
    assert.deepEqual(
      report.cards.map((card) => [card.model_id, card.status]),
      [["already-there", "exists"], ["claude-sonnet-4-6", "created"], ["claude-opus-4-7", "created"]],
    );
    assert.deepEqual(oma.posts.map((post) => post.model_id), ["claude-sonnet-4-6", "claude-opus-4-7"]);
    assert.deepEqual(oma.posts[0], {
      model_id: "claude-sonnet-4-6",
      model: "claude-sonnet-4-6",
      provider: "ant",
      api_key: PROVIDER_KEY,
      base_url: "https://llm.example",
      is_default: true,
    });
    assert.equal(oma.posts[1].is_default, false, "only the first created card becomes the default");
    assert.ok(!JSON.stringify(report).includes(PROVIDER_KEY), "report must not echo the provider key");

    const again = await bootstrapModelCards(config);
    assert.ok(again.cards.every((card) => card.status === "exists"));
    assert.equal(oma.posts.length, 2, "re-running creates nothing");
  } finally {
    await oma.close();
  }
});

test("refuses to write into a workspace other than the one requested", async () => {
  const oma = await fakeOpenMA({ workspaceId: "default" });
  try {
    await assert.rejects(
      bootstrapModelCards(parseBootstrapConfig({
        OMA_BASE_URL: oma.baseUrl,
        OMA_WORKSPACE_ID: "tn_other",
        ANTHROPIC_API_KEY: PROVIDER_KEY,
      })),
      /belongs to workspace default, not tn_other/,
    );
    assert.equal(oma.posts.length, 0);
  } finally {
    await oma.close();
  }
});

for (const mode of ["probe", "http", "json-http", "transport"]) {
  test(`redacts echoed credentials from ${mode} diagnostics`, async () => {
    const secrets = ["provider-canary-secret", "workspace-canary-secret", "header-canary-\"secret\\value"];
    const config = parseBootstrapConfig({
      ANTHROPIC_API_KEY: secrets[0], OMA_API_KEY: secrets[1],
      ANTHROPIC_CUSTOM_HEADERS: `Authorization: ${secrets[2]}`,
    });
    const echo = secrets.join(" ");
    const fetch = async (url) => {
      if (mode === "transport") throw new Error(echo);
      if (mode === "http") return new Response(echo, { status: 401 });
      if (mode === "json-http") return Response.json({ error: { message: echo } }, { status: 400 });
      if (url.endsWith("/me")) return Response.json({ tenant: { id: "default" } });
      if (!fetch.listed) { fetch.listed = true; return Response.json({ data: [] }); }
      return Response.json({ id: "card", probe: { ok: false, message: echo } });
    };
    let diagnostic;
    try { diagnostic = JSON.stringify(await bootstrapModelCards(config, { fetch })); }
    catch (error) { diagnostic = error.message; }
    for (const secret of secrets) {
      assert.ok(!diagnostic.includes(secret));
      assert.ok(!diagnostic.includes(JSON.stringify(secret).slice(1, -1)));
    }
    if (mode.includes("http")) assert.match(diagnostic, /HTTP (400|401)/);
    else assert.ok(diagnostic.includes("[REDACTED]"));
  });
}

test("surfaces OpenMA auth failures without leaking the provider key", async () => {
  const oma = await fakeOpenMA({ requireKey: "right-key" });
  try {
    await assert.rejects(
      bootstrapModelCards(parseBootstrapConfig({
        OMA_BASE_URL: oma.baseUrl,
        OMA_API_KEY: "wrong-key",
        ANTHROPIC_API_KEY: PROVIDER_KEY,
      })),
      (error) => /HTTP 401/.test(error.message) && !error.message.includes(PROVIDER_KEY),
    );
  } finally {
    await oma.close();
  }
});
