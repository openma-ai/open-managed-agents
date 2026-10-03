// Real Node control plane: listen on HTTP, publish a new MCP server onto an
// existing session, resume, and confirm the next harness turn both sees and
// calls the new tool.

import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import { registerHarness } from "@open-managed-agents/agent/harness/registry";
import type { HarnessContext } from "@open-managed-agents/agent/harness/interface";
import type { UserMessageEvent } from "@open-managed-agents/shared";
import { createScriptedMcpServer } from "../../../test/fakes/scripted-mcp-server";
import { loadNodeConfig } from "../src/config";
import { nodeDefaults } from "../src/components";
import { Disposables } from "../src/lifecycle";
import { NodeInstallBridge } from "../src/lib/node-install-bridge.js";
import { mountNodeHttp } from "../src/modules/node-http";
import { createNodeRuntime } from "../src/modules/node-runtime";

const TENANT = "tn_live_resume";
const USER = "usr_live_resume";
const dir = mkdtempSync(join(tmpdir(), "oma-resume-mcp-"));
const disposables = new Disposables();
let mcpServer: ReturnType<typeof createServer> | null = null;
let httpServer: { close: (cb: () => void) => void; port: number } | null = null;

afterAll(async () => {
  await new Promise<void>((resolve) => {
    if (!httpServer) return resolve();
    httpServer.close(() => resolve());
  });
  await new Promise<void>((resolve) => {
    if (!mcpServer) return resolve();
    mcpServer.close(() => resolve());
  });
  await disposables.dispose();
  rmSync(dir, { recursive: true, force: true });
});

async function startPublishedMcp(): Promise<string> {
  const mcp = createScriptedMcpServer({
    serverInfo: { name: "published-slack", version: "1.0.0" },
    tools: [{
      name: "ping",
      description: "Published ping",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
      },
    }],
    callTool({ arguments: args }) {
      return { content: [{ type: "text", text: `ping:${args?.value}` }] };
    },
  });
  mcpServer = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers.set(key, value);
    }
    const response = await mcp.fetch(new Request(`http://127.0.0.1${req.url ?? "/"}`, {
      method: req.method,
      headers,
      body: body.length > 0 && req.method !== "GET" && req.method !== "HEAD" ? body : undefined,
    }));
    res.statusCode = response.status;
    response.headers.forEach((value, key) => {
      if (key === "content-encoding" || key === "transfer-encoding") return;
      res.setHeader(key, value);
    });
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => mcpServer!.listen(0, "127.0.0.1", resolve));
  const address = mcpServer.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return `http://127.0.0.1:${port}/mcp`;
}

describe("Node service resume applies published MCP tools", () => {
  it("serves HTTP, resumes a session, and the next turn calls the new tool", async () => {
    const publishedUrl = await startPublishedMcp();
    const observed: string[] = [];
    registerHarness("resume-mcp-probe", () => ({
      async run(ctx: HarnessContext) {
        const names = Object.keys(ctx.tools).filter((name) => name.startsWith("mcp__"));
        const ping = ctx.tools["mcp__slack__ping"] as {
          execute?: (args: { value: string }, options: { toolCallId: string; messages: [] }) => Promise<unknown>;
        } | undefined;
        let result = "missing";
        if (ping?.execute) {
          result = JSON.stringify(await ping.execute(
            { value: "from-node" },
            { toolCallId: "call_live", messages: [] },
          ));
        }
        const text = `tools=${names.join(",")} result=${result}`;
        observed.push(text);
        ctx.runtime.broadcast({
          type: "agent.message",
          content: [{ type: "text", text }],
        });
      },
    }));

    const config = loadNodeConfig({
      NODE_ENV: "test",
      AUTH_DISABLED: "1",
      OPENMA_TEST_SANDBOX_PROVIDER: "local-subprocess",
      MEMORY_QUEUE: "disabled",
      DATABASE_PATH: join(dir, "oma.db"),
      AUTH_DATABASE_PATH: join(dir, "auth.db"),
      SANDBOX_WORKDIR: join(dir, "sandbox"),
      MEMORY_BLOB_DIR: join(dir, "memory"),
      FILES_BLOB_DIR: join(dir, "files"),
      SESSION_OUTPUTS_DIR: join(dir, "outputs"),
      ANTHROPIC_API_KEY: "test-key-not-used",
      PLATFORM_ROOT_SECRET: "test-platform-root-secret-padded-to-thirtytwo",
    });
    const components = await nodeDefaults(config);
    const runtime = await createNodeRuntime(components, disposables, { current: null });
    const app = await mountNodeHttp(runtime, disposables);
    const listening = new Promise<number>((resolve) => {
      const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
        httpServer = { close: (cb) => server.close(cb), port: info.port };
        resolve(info.port);
      });
    });
    const port = await listening;
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);
    console.log(`[node-live] health ${health.status} ${JSON.stringify(await health.json())} port=${port}`);

    const now = Date.now();
    await runtime.sql.prepare(
      `INSERT INTO "tenant" (id, name, "createdAt", "updatedAt") VALUES (?, ?, ?, ?)`,
    ).bind(TENANT, "Live", now, now).run();
    await runtime.sql.prepare(
      `INSERT INTO membership (user_id, tenant_id, role, created_at) VALUES (?, ?, 'owner', ?)`,
    ).bind(USER, TENANT, now).run();

    const agent = await runtime.agentsService.create({
      tenantId: TENANT,
      input: {
        name: "Live resume",
        model: "claude-sonnet-4-6",
        system: "frozen system prompt",
        harness: "resume-mcp-probe",
        tools: [{ type: "agent_toolset_20260401", configs: [{ name: "bash", enabled: false }] }],
      },
    });
    const vault = await runtime.vaultService.create({ tenantId: TENANT, name: "slack" });
    await runtime.credentialService.create({
      tenantId: TENANT,
      vaultId: vault.id,
      displayName: "published slack",
      auth: {
        type: "static_bearer",
        mcp_server_url: publishedUrl,
        token: "published-token",
      },
    });

    const bridge = new NodeInstallBridge({
      sql: runtime.sql,
      db: runtime.drizzleDb,
      platformRootSecret: "test-platform-root-secret-padded-to-thirtytwo",
      gatewayOrigin: `http://127.0.0.1:${port}`,
      vaults: runtime.vaultService,
      credentials: runtime.credentialService,
      sessions: runtime.sessionsService,
      agents: runtime.agentsService,
      resolveTenantId: async (userId) => (userId === USER ? TENANT : null),
      appendUserEvent: async (sessionId, tenantId, agentId, event) => {
        const entry = await runtime.sessionRegistry.getOrCreate(sessionId, tenantId);
        await entry.machine.runHarnessTurn(agentId, event as UserMessageEvent);
      },
    });
    const creator = bridge.buildContainers().slack.sessions;
    const created = await creator.create({
      userId: USER,
      agentId: agent.id,
      environmentId: "env-local",
      vaultIds: [vault.id],
      mcpServers: [{ name: "slack", url: "https://old.slack.example/mcp" }],
      metadata: {},
      initialEvent: { type: "user.message", content: [{ type: "text", text: "created" }] },
      additionalSystemPrompt: "FROZEN PROTOCOL",
    });
    await creator.resume(
      USER,
      created.sessionId,
      { type: "user.message", content: [{ type: "text", text: "use the published tool" }] },
      { mcpServers: [{ name: "slack", url: publishedUrl }] },
    );

    const row = await runtime.sessionsService.get({ tenantId: TENANT, sessionId: created.sessionId });
    expect(row?.agent_snapshot?.system).toContain("FROZEN PROTOCOL");
    expect(row?.agent_snapshot?.mcp_servers).toEqual([
      { name: "slack", type: "url", url: publishedUrl },
    ]);
    expect(observed.join("\n")).toContain("mcp__slack__ping");
    expect(observed.join("\n")).toContain("ping:from-node");
    console.log(`[node-live] session=${created.sessionId} ${observed.join(" | ")}`);
  }, 120_000);
});
