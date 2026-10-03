// Cloudflare runtime: a published integration MCP server is absent from the
// create-time snapshot. Resume must refresh it via sessions.update() before
// the event, and the next SessionDO turn must actually call the new tool.
// A non-idle session fails fast and does not receive the event.

import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultHarness } from "../../apps/agent/src/harness/default-loop";
import { registerHarness } from "../../apps/agent/src/harness/registry";
import type { HarnessContext } from "../../apps/agent/src/harness/interface";
import {
  createScriptedLanguageModel,
  finishChunk,
  streamStep,
  textChunks,
  toolCallChunks,
} from "../fakes/scripted-language-model";
import { createScriptedMcpServer } from "../fakes/scripted-mcp-server";

const SECRET = "test-internal-secret";
const H = { "x-api-key": "test-key", "content-type": "application/json" };
const MCP_ORIGIN = "https://resume-mcp.example.test";
const HARNESS = "resume-mcp-refresh";

let turnModel: ReturnType<typeof createScriptedLanguageModel> | null = null;

registerHarness(HARNESS, () => {
  const harness = new DefaultHarness();
  return {
    async run(ctx: HarnessContext) {
      if (!turnModel) throw new Error("resume MCP fake LLM was not installed");
      await harness.run({ ...ctx, model: turnModel.model });
    },
  };
});

function api(path: string, init?: RequestInit) {
  return exports.default.fetch(new Request(`http://localhost${path}`, init));
}
function post(path: string, body: unknown, headers: Record<string, string> = H) {
  return api(path, { method: "POST", headers, body: JSON.stringify(body) });
}

function usage() {
  return {
    inputTokens: { total: 11, noCache: 11, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 7, text: 7, reasoning: 0 },
  };
}

function installMcp() {
  const originalFetch = globalThis.fetch;
  const seenUrls: string[] = [];
  const mcp = createScriptedMcpServer({
    sessionId: "resume-mcp-session",
    serverInfo: { name: "published-slack", version: "1.0.0" },
    tools: [{
      name: "ping",
      description: "Published slack ping",
      inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
    }],
    callTool({ arguments: args }) {
      return { content: [{ type: "text", text: `ping:${args?.value}` }] };
    },
  });
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).origin !== MCP_ORIGIN) return originalFetch(input, init);
    seenUrls.push(request.url);
    if (request.headers.get("authorization") !== "Bearer published-token") {
      return new Response("missing bearer", { status: 401 });
    }
    return mcp.fetch(request);
  };
  return {
    seenUrls,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

afterEach(() => {
  turnModel = null;
});

async function seedUser(userId: string) {
  const now = Date.now();
  // The combined test worker's D1 does not always materialize better-auth's
  // `user` table. resolveTenantId reads it, so create the production shape
  // when this file is the first thing to touch it.
  await env.MAIN_DB.prepare(
    `CREATE TABLE IF NOT EXISTS "user" (
      id text PRIMARY KEY NOT NULL,
      name text NOT NULL,
      email text NOT NULL,
      emailVerified integer DEFAULT 0 NOT NULL,
      image text,
      tenantId text,
      role text DEFAULT 'member' NOT NULL,
      createdAt integer NOT NULL,
      updatedAt integer NOT NULL
    )`,
  ).run();
  await env.MAIN_DB.prepare(
    `INSERT INTO "user" (id, name, email, emailVerified, tenantId, role, createdAt, updatedAt)
     VALUES (?, ?, ?, 1, 'default', 'member', ?, ?)`,
  ).bind(userId, "Resume", `${userId}@example.test`, now, now).run();
}

describe("Cloudflare session resume picks up published MCP tools", () => {
  it("calls the MCP tool published after the session was created", async () => {
    const external = installMcp();
    const toolChunks = toolCallChunks({
      id: "mcp-call-resume",
      toolName: "mcp__slack__ping",
      inputDeltas: ['{"value":', '"published"}'],
    });
    const finalChunks = textChunks("text-resume", ["published ping ", "done"]);
    turnModel = createScriptedLanguageModel([
      streamStep([
        toolChunks[0],
        { type: "response-metadata", id: "mock-resume-tool" },
        ...toolChunks.slice(1),
        finishChunk("tool-calls", usage()),
      ]),
      streamStep([
        finalChunks[0],
        { type: "response-metadata", id: "mock-resume-final" },
        ...finalChunks.slice(1),
        finishChunk("stop", usage()),
      ]),
    ], { provider: "openma-e2e-mock", modelId: "resume-mcp-mock" });

    const userId = `usr_${crypto.randomUUID()}`;
    await seedUser(userId);
    const vault = await post("/v1/oma/vaults", { name: `resume-vault-${userId}` });
    expect(vault.status).toBe(201);
    const vaultId = ((await vault.json()) as { id: string }).id;
    const cred = await post(`/v1/oma/vaults/${vaultId}/credentials`, {
      display_name: "published slack",
      auth: {
        type: "static_bearer",
        mcp_server_url: `${MCP_ORIGIN}/mcp`,
        token: "published-token",
      },
    });
    expect(cred.status).toBe(201);

    const agentRes = await post("/v1/oma/agents", {
      name: `Resume MCP ${userId}`,
      model: "resume-mcp-mock",
      system: "frozen system prompt",
      harness: HARNESS,
      tools: [{ type: "agent_toolset_20260401", configs: [{ name: "bash", enabled: false }] }],
    });
    expect(agentRes.status).toBe(201);
    const agentId = ((await agentRes.json()) as { id: string }).id;
    const envRes = await post("/v1/oma/environments", {
      name: `resume-env-${userId}`,
      config: { type: "cloud", networking: { type: "unrestricted" } },
    });
    expect(envRes.status).toBe(201);
    const environmentId = ((await envRes.json()) as { id: string }).id;

    const created = await post("/v1/oma/internal/sessions", {
      action: "create",
      userId,
      agentId,
      environmentId,
      vaultIds: [vaultId],
      additionalSystemPrompt: "FROZEN PROTOCOL",
    }, { "content-type": "application/json", "x-internal-secret": SECRET });
    expect(created.status).toBe(200);
    const sessionId = ((await created.json()) as { sessionId: string }).sessionId;

    const before = await env.MAIN_DB.prepare(
      `SELECT agent_snapshot, status FROM sessions WHERE id = ?`,
    ).bind(sessionId).first<{ agent_snapshot: string; status: string }>();
    const beforeSnapshot = JSON.parse(before!.agent_snapshot);
    expect((beforeSnapshot.mcp_servers ?? []).some((server: { name: string }) => server.name === "slack")).toBe(false);
    expect(before!.status).toBe("idle");

    const resumed = await post(`/v1/oma/internal/sessions/${sessionId}/events`, {
      userId,
      mcpServers: [{ name: "slack", url: `${MCP_ORIGIN}/mcp` }],
      event: { type: "user.message", content: [{ type: "text", text: "use the new tool" }] },
    }, { "content-type": "application/json", "x-internal-secret": SECRET });
    expect(resumed.status).toBe(200);

    const afterRow = await env.MAIN_DB.prepare(
      `SELECT agent_snapshot FROM sessions WHERE id = ?`,
    ).bind(sessionId).first<{ agent_snapshot: string }>();
    const after = JSON.parse(afterRow!.agent_snapshot);
    expect(after.system).toContain("FROZEN PROTOCOL");
    expect(after.system).toContain("frozen system prompt");
    expect(after.mcp_servers).toEqual([
      { name: "slack", type: "url", url: `${MCP_ORIGIN}/mcp` },
    ]);
    expect(after.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "mcp_toolset", mcp_server_name: "slack" }),
      expect.objectContaining({ type: "agent_toolset_20260401" }),
    ]));

    let sawTool = false;
    for (let attempt = 0; attempt < 80 && !sawTool; attempt += 1) {
      const events = await api(`/v1/oma/sessions/${sessionId}/events?limit=100&order=asc`, { headers: H });
      const body = await events.json() as { data: Array<Record<string, unknown>> };
      const text = JSON.stringify(body.data);
      sawTool = text.includes("mcp__slack__ping") && text.includes("ping:published");
      if (!sawTool) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(sawTool).toBe(true);
    expect(external.seenUrls.some((url) => url.startsWith(`${MCP_ORIGIN}/mcp`))).toBe(true);
    external.restore();
  }, 60_000);

  it("fails fast when the session is not idle and does not append the event", async () => {
    const userId = `usr_${crypto.randomUUID()}`;
    await seedUser(userId);
    const agentRes = await post("/v1/oma/agents", {
      name: `Resume idle ${userId}`,
      model: "claude-sonnet-4-6",
      system: "stay frozen",
      harness: "noop-test",
    });
    expect(agentRes.status).toBe(201);
    const agentId = ((await agentRes.json()) as { id: string }).id;
    const envRes = await post("/v1/oma/environments", {
      name: `resume-idle-env-${userId}`,
      config: { type: "cloud" },
    });
    const environmentId = ((await envRes.json()) as { id: string }).id;
    const created = await post("/v1/oma/internal/sessions", {
      action: "create",
      userId,
      agentId,
      environmentId,
      vaultIds: [],
    }, { "content-type": "application/json", "x-internal-secret": SECRET });
    expect(created.status).toBe(200);
    const sessionId = ((await created.json()) as { sessionId: string }).sessionId;
    await env.MAIN_DB.prepare(`UPDATE sessions SET status = 'running' WHERE id = ?`).bind(sessionId).run();

    const resumed = await post(`/v1/oma/internal/sessions/${sessionId}/events`, {
      userId,
      mcpServers: [{ name: "slack", url: `${MCP_ORIGIN}/mcp` }],
      event: { type: "user.message", content: [{ type: "text", text: "should not land" }] },
    }, { "content-type": "application/json", "x-internal-secret": SECRET });
    expect(resumed.status).toBe(409);
    const body = await resumed.json() as { error?: { message?: string }; message?: string };
    expect(body.error?.message ?? body.message).toContain("session_not_idle");

    const row = await env.MAIN_DB.prepare(
      `SELECT agent_snapshot, status FROM sessions WHERE id = ?`,
    ).bind(sessionId).first<{ agent_snapshot: string; status: string }>();
    const snapshot = JSON.parse(row!.agent_snapshot);
    expect((snapshot.mcp_servers ?? []).some((server: { name: string }) => server.name === "slack")).toBe(false);
    expect(row!.status).toBe("running");
  });
});
