// Resume must refresh integration MCP servers and toolsets on the frozen
// session snapshot before the next event is delivered. A session that is
// not idle fails fast and the event is not appended.
//
// On main, before the fix, resume only appends the event. This test fails
// there: the published server/toolset never lands, and a running session
// still accepts the event.

import { afterEach, describe, expect, it } from "vitest";
import { createSqliteAgentService } from "@open-managed-agents/agents-store";
import { createSqliteCredentialService } from "@open-managed-agents/credentials-store";
import { createSqliteSessionService } from "@open-managed-agents/sessions-store";
import { createSqliteVaultService } from "@open-managed-agents/vaults-store";
import { SessionResumeNotIdleError } from "@open-managed-agents/integrations-core";
import { NodeInstallBridge } from "../src/lib/node-install-bridge.js";
import { bootstrapTestDb } from "./_helpers/bootstrap-test-db";

const SECRET = "test-platform-root-secret-padded-to-thirtytwo";
const TENANT = "tn_resume_mcp";
const USER = "usr_resume_mcp";
const cleanups = new Set<() => void>();

afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups.clear();
});

async function setup() {
  const { sql, db, cleanup } = await bootstrapTestDb();
  cleanups.add(cleanup);
  await sql
    .prepare(`INSERT INTO "tenant" (id, name, "createdAt", "updatedAt") VALUES (?, ?, ?, ?)`)
    .bind(TENANT, "Resume", Date.now(), Date.now())
    .run();
  await sql
    .prepare(`INSERT INTO membership (user_id, tenant_id, role, created_at) VALUES (?, ?, 'owner', ?)`)
    .bind(USER, TENANT, Date.now())
    .run();
  const agents = createSqliteAgentService({ db });
  const sessions = createSqliteSessionService({ db });
  const appended: string[] = [];
  const bridge = new NodeInstallBridge({
    sql,
    db,
    platformRootSecret: SECRET,
    gatewayOrigin: "https://gateway.test",
    vaults: createSqliteVaultService({ db }),
    credentials: createSqliteCredentialService({ db }),
    sessions,
    agents,
    resolveTenantId: async (userId) => (userId === USER ? TENANT : null),
    appendUserEvent: async (sessionId) => {
      appended.push(sessionId);
    },
  });
  const agent = await agents.create({
    tenantId: TENANT,
    input: {
      name: "Published agent",
      model: "claude-sonnet-4-6",
      system: "frozen system prompt",
      tools: [
        { type: "agent_toolset_20260401", configs: [{ name: "bash", enabled: false }] },
      ],
      mcp_servers: [{ name: "notion", type: "url", url: "https://notion.example/mcp" }],
    },
  });
  return { agents, sessions, bridge, agent, appended };
}

function toolsetNames(tools: unknown): string[] {
  return (tools as Array<{ type?: string; mcp_server_name?: string }> | undefined ?? [])
    .filter((tool) => tool.type === "mcp_toolset")
    .map((tool) => tool.mcp_server_name ?? "");
}

describe("session resume refreshes integration MCP", () => {
  it("writes the published MCP server and toolset before delivering the event", async () => {
    const { sessions, bridge, agent, appended } = await setup();
    const creator = bridge.buildContainers().slack.sessions;
    const created = await creator.create({
      userId: USER,
      agentId: agent.id,
      environmentId: "env-local",
      vaultIds: [],
      mcpServers: [{ name: "slack", url: "https://old.slack.example/mcp" }],
      metadata: { slack: { channel: "C1" } },
      initialEvent: { type: "user.message", content: [{ type: "text", text: "hello" }] },
      additionalSystemPrompt: "FROZEN PROTOCOL",
    });

    const stale = await sessions.get({ tenantId: TENANT, sessionId: created.sessionId });
    expect(stale?.agent_snapshot?.system).toContain("FROZEN PROTOCOL");
    const withoutToolset = {
      ...stale!.agent_snapshot!,
      mcp_servers: [
        ...(stale!.agent_snapshot!.mcp_servers ?? []).filter((server) => server.name !== "slack"),
        { name: "slack", type: "url" as const, url: "https://old.slack.example/mcp" },
      ],
      tools: (stale!.agent_snapshot!.tools ?? []).filter(
        (tool) => (tool as { type?: string }).type !== "mcp_toolset",
      ),
    };
    await sessions.update({
      tenantId: TENANT,
      sessionId: created.sessionId,
      agentSnapshot: withoutToolset,
    });

    await creator.resume(
      USER,
      created.sessionId,
      { type: "user.message", content: [{ type: "text", text: "again" }] },
      { mcpServers: [{ name: "slack", url: "https://mcp.slack.com/mcp" }] },
    );

    const resumed = await sessions.get({ tenantId: TENANT, sessionId: created.sessionId });
    const snapshot = resumed?.agent_snapshot;
    expect(snapshot?.system).toContain("FROZEN PROTOCOL");
    expect(snapshot?.system).toContain("frozen system prompt");
    expect(snapshot?.mcp_servers).toEqual(expect.arrayContaining([
      { name: "notion", type: "url", url: "https://notion.example/mcp" },
      { name: "slack", type: "url", url: "https://mcp.slack.com/mcp" },
    ]));
    expect(snapshot?.mcp_servers?.some((server) => server.url === "https://old.slack.example/mcp")).toBe(false);
    expect(toolsetNames(snapshot?.tools)).toEqual(["slack"]);
    const bash = (snapshot?.tools ?? []).find((tool) => tool.type === "agent_toolset_20260401");
    expect(bash).toMatchObject({ configs: [{ name: "bash", enabled: false }] });
    expect(appended).toEqual([created.sessionId]);
  });

  it("fails fast when the session is not idle and does not deliver the event", async () => {
    const { sessions, bridge, agent, appended } = await setup();
    const creator = bridge.buildContainers().slack.sessions;
    const created = await creator.create({
      userId: USER,
      agentId: agent.id,
      environmentId: "env-local",
      vaultIds: [],
      mcpServers: [{ name: "slack", url: "https://old.slack.example/mcp" }],
      metadata: {},
      initialEvent: { type: "user.message", content: [{ type: "text", text: "hello" }] },
    });
    await sessions.update({
      tenantId: TENANT,
      sessionId: created.sessionId,
      status: "running",
    });
    const before = await sessions.get({ tenantId: TENANT, sessionId: created.sessionId });

    await expect(creator.resume(
      USER,
      created.sessionId,
      { type: "user.message", content: [{ type: "text", text: "while running" }] },
      { mcpServers: [{ name: "slack", url: "https://mcp.slack.com/mcp" }] },
    )).rejects.toBeInstanceOf(SessionResumeNotIdleError);

    const after = await sessions.get({ tenantId: TENANT, sessionId: created.sessionId });
    expect(after?.agent_snapshot).toEqual(before?.agent_snapshot);
    expect(after?.status).toBe("running");
    expect(appended).toEqual([]);
  });
});
