import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import OpenAI, { APIError } from "openai";
import { describe, expect, it } from "vitest";
import { createScriptedMcpServer } from "../../../test/fakes/scripted-mcp-server";
import { loadNodeConfig } from "../src/config";
import { nodeDefaults } from "../src/components";
import { createNodeControlPlane, type NodeControlPlane } from "../src/control-plane";

// Node conformance baseline for #542 after #541: real workspace credentials,
// routing/application/SQLite/execution, and controlled model/MCP HTTP endpoints.
// No mocked auth resolver or disabled-auth mode; no external model credentials.
// environment:none exercises the real host runtime and Vault-backed MCP proxy.
// Hosted sandbox coverage remains in openai-e2e/resources.test.ts.
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "openai-mcp-auth-"));
  let cp: NodeControlPlane | undefined;
  let modelCalls = 0;
  const mcp = createScriptedMcpServer({
    tools: [{ name: "ping", description: "Return a test value", inputSchema: { type: "object" } }],
    callTool: () => ({ content: [{ type: "text", text: "AUTH_MCP_OK" }] }),
  });
  const server = serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    const path = new URL(request.url).pathname;
    if (path === "/mcp") return mcp.fetch(request);
    if (path === "/model/v1/messages") {
      const input = await request.json() as Record<string, any>;
      const message = { id: "msg_local", type: "message", role: "assistant", model: input.model, content: [], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
      if (!input.stream) return Response.json(message); // Model-card probe.
      modelCalls++;
      const done = JSON.stringify(input.messages).includes("AUTH_MCP_OK");
      const events = [
        { type: "message_start", message: { ...message, stop_reason: null } },
        { type: "content_block_start", index: 0, content_block: done ? { type: "text", text: "" } : { type: "tool_use", id: "call_ping", name: "mcp__lookup__ping", input: {} } },
        { type: "content_block_delta", index: 0, delta: done ? { type: "text_delta", text: "DONE" } : { type: "input_json_delta", partial_json: "{}" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: done ? "end_turn" : "tool_use", stop_sequence: null }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ];
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    }
    return cp ? cp.fetch(request) : new Response(null, { status: 503 });
  } });
  const dispose = async () => {
    try { await cp?.stop("test"); }
    finally {
      if ("closeAllConnections" in server) server.closeAllConnections();
      try { await new Promise<void>(resolve => server.close(() => resolve())); }
      finally { await rm(root, { recursive: true, force: true }); }
    }
  };
  try {
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing local server address");
    const base = `http://127.0.0.1:${address.port}`;
    cp = await createNodeControlPlane(await nodeDefaults(loadNodeConfig({
      NODE_ENV: "test", AUTH_DISABLED: "0", PLATFORM_ROOT_SECRET: "local-mcp-auth-root-secret",
      OPENMA_TEST_SANDBOX_PROVIDER: "local-subprocess", PUBLIC_BASE_URL: base,
      MEMORY_QUEUE: "disabled", LOG_LEVEL: "silent",
      DATABASE_PATH: join(root, "oma.db"), AUTH_DATABASE_PATH: join(root, "auth.db"),
      SANDBOX_WORKDIR: join(root, "sandbox"), MEMORY_BLOB_DIR: join(root, "memory"),
      FILES_BLOB_DIR: join(root, "files"), SESSION_OUTPUTS_DIR: join(root, "outputs"),
    })));
    const sql = cp.components.database.sql;
    for (const tenant of ["owner", "other"]) {
      await sql.prepare("INSERT INTO api_keys (id, tenant_id, name, prefix, hash, credential_type, created_at) VALUES (?, ?, ?, ?, ?, 'workspace', ?)")
        .bind(tenant, tenant, tenant, tenant, createHash("sha256").update(`mcp-test-${tenant}`).digest("hex"), Date.now()).run();
    }
    const client = (tenant: string) => new OpenAI({ apiKey: `mcp-test-${tenant}`, baseURL: `${base}/openai/v1`, maxRetries: 0, timeout: 10_000 });
    const owner = client("owner").beta.agents;
    const other = client("other").beta.agents;
    const card = await fetch(`${base}/v1/oma/model_cards`, {
      method: "POST", headers: { "x-api-key": "mcp-test-owner", "content-type": "application/json" },
      body: JSON.stringify({ model_id: "local-model", model: "claude-sonnet-4-20250514", provider: "anthropic", base_url: `${base}/model`, api_key: "local-model-secret" }),
    });
    expect(card.status, await card.clone().text()).toBeLessThan(300);
    const vault = await owner.vaults.create({ name: "Local MCP credentials" });
    const credential = await owner.vaults.credentials.create(vault.id, { name: "MCP", auth: { type: "static_bearer", mcp_server_url: `${base}/mcp`, token: "local-vault-secret" } });
    expect(JSON.stringify(credential)).not.toContain("local-vault-secret");
    await cp.start();
    return { cp, sql, owner, other, client, mcp, vault, base, dispose, modelCalls: () => modelCalls };
  } catch (error) { await dispose(); throw error; }
}

describe("Session MCP responses with real workspace authentication (#540)", () => {
  for (const source of ["saved", "inline"] as const) {
    it.each(["absent", "empty", "nonempty"] as const)(`${source} agent, %s HTTP headers`, async headerMode => {
      const f = await fixture();
      try {
        const transport: { type: "http"; server_url: string; headers?: Record<string, string> } = { type: "http", server_url: `${f.base}/mcp`, ...(headerMode === "absent" ? {} : { headers: headerMode === "empty" ? {} : { "X-Workspace-Tag": "keep-this-option" } }) };
        const agent = { model: "local-model", tools: [{ type: "mcp" as const, server_label: "lookup", transport }] };
        const saved = source === "saved" ? await f.owner.create(agent) : undefined;
        if (saved) expect((await f.owner.retrieve(saved.id)).tools).toEqual([expect.objectContaining({ transport: { ...transport, headers: transport.headers ?? {} } })]);
        const body = { ...(saved ? { agent_id: saved.id } : { agent }), environment: { type: "none" as const }, vault_ids: [f.vault.id], input: "Call ping once", metadata: { repro_run: randomUUID() } };
        const counts = async () => {
          const tables = ["managed_sessions", "managed_session_initial_events", "managed_session_executions"];
          return Promise.all(tables.map(async table => (await f.sql.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())!.n));
        };
        const before = await counts();
        const beforeCalls = f.mcp.state.counts["tools/call"] ?? 0;
        await expect(f.client("invalid").beta.agents.sessions.create(body)).rejects.toMatchObject({ status: 401 });
        if (saved) await expect(f.other.sessions.create(body)).rejects.toMatchObject({ status: 404 });
        expect(await counts()).toEqual(before);
        if (headerMode === "nonempty") {
          // Existing runtime capability boundary, not a response-mapper failure.
          await expect(f.owner.sessions.create(body)).rejects.toMatchObject({ status: 501, error: { code: "unsupported_feature", param: "agent.tools.0.transport.headers" } });
          if (!saved) {
            const sensitive = { ...body, agent: { ...agent, tools: [{ ...agent.tools[0]!, transport: { ...transport, headers: { Authorization: "inline-private-token" } } }] } };
            const rejected = await f.owner.sessions.create(sensitive).then(() => { throw new Error("Expected rejection"); }, error => error as APIError);
            expect(rejected).toMatchObject({ status: 501, error: { code: "unsupported_feature" } });
            expect(JSON.stringify(rejected.error)).not.toContain("inline-private-token");
            const malformed = await fetch(`${f.base}/openai/v1/agents/sessions`, {
              method: "POST", headers: { authorization: "Bearer mcp-test-owner", "OpenAI-Beta": "agents=v1", "content-type": "application/json" },
              body: JSON.stringify({ ...sensitive, agent: { ...agent, tools: [{ ...agent.tools[0]!, transport: { ...transport, headers: { Authorization: 123 } } }] } }),
            });
            expect(malformed.status).toBe(400);
            expect(await malformed.text()).not.toContain("inline-private-token");
          }
          expect(await counts()).toEqual(before);
          expect(f.modelCalls()).toBe(0);
          expect(f.mcp.state.counts["tools/call"] ?? 0).toBe(beforeCalls);
          if (saved) expect((await f.owner.retrieve(saved.id)).tools).toEqual([expect.objectContaining({ transport })]);
          return;
        }
        const session = await f.owner.sessions.create(body);
        const expected = [expect.objectContaining({ transport: { type: "http", server_url: transport.server_url } })];
        expect(session.agent.tools).toEqual(expected);
        expect((await f.owner.sessions.retrieve(session.id)).agent.tools).toEqual(expected);
        expect((await f.owner.sessions.list({ agent_id: session.agent.id })).data).toEqual([expect.objectContaining({ id: session.id, agent: expect.objectContaining({ tools: expected }) })]);
        const updated = await f.owner.sessions.update(session.id, { metadata: { checked: "yes" } });
        expect(updated.agent.tools).toEqual(expected);
        expect(JSON.stringify([session, updated])).not.toMatch(/headers|local-vault-secret|mcp-test-owner|local-model-secret/);
        await expect.poll(async () => (await f.owner.sessions.turns.list(session.id)).data, { timeout: 30_000 }).toEqual([expect.objectContaining({ status: "completed" })]);
        const items = (await f.owner.sessions.items.list(session.id)).data;
        expect(items.filter(item => item.type === "message" && item.role === "user")).toEqual([expect.objectContaining({ content: [{ type: "input_text", text: body.input }] })]);
        expect(await counts()).toEqual(before.map(n => n + 1));
        expect((f.mcp.state.counts["tools/call"] ?? 0) - beforeCalls).toBe(1);
        expect(f.modelCalls()).toBe(2); // One tool call, then one final response.
        // HTTP requests may also include non-RPC traffic; do not assume the
        // parsed-message and raw-request arrays have matching indices.
        const upstreamCalls = [];
        for (const request of f.mcp.state.requests) {
          if (request.method === "POST" && (await request.clone().json() as { method?: string }).method === "tools/call") upstreamCalls.push(request);
        }
        expect(upstreamCalls).toHaveLength(1);
        const upstream = upstreamCalls[0]!;
        expect(upstream.headers.get("authorization")).toBe("Bearer local-vault-secret");
        expect(JSON.stringify([...upstream.headers])).not.toContain("mcp-test-owner");
        await expect(f.other.sessions.retrieve(session.id)).rejects.toMatchObject({ status: 404 });
        await expect(f.other.sessions.update(session.id, { metadata: { stolen: "yes" } })).rejects.toMatchObject({ status: 404 });
        expect((await f.other.sessions.list()).data).toEqual([]);
        expect((await f.other.sessions.list({ agent_id: session.agent.id })).data).toEqual([]);
        await expect(f.client("invalid").beta.agents.sessions.retrieve(session.id)).rejects.toMatchObject({ status: 401 });
        await expect(f.client("invalid").beta.agents.sessions.list()).rejects.toMatchObject({ status: 401 });
        if (saved) expect((await f.owner.retrieve(saved.id)).tools).toEqual([expect.objectContaining({ transport: { ...transport, headers: {} } })]);
      } finally { await f.dispose(); }
    }, 60_000);
  }
});
