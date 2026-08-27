import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import worker from "../test-worker";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import { SqlAgentPersistence } from "@open-managed-agents/managed-agents-adapters-sql";
import type { AgentRecord } from "@open-managed-agents/managed-agents-application/agents-persistence-port";

function db(): D1Database {
  return (env as { MAIN_DB: D1Database }).MAIN_DB;
}

const agent: AgentRecord = {
  id: "agent_d1_01",
  archivedAt: null,
  createdAt: "2026-08-26T00:00:00.000Z",
  description: null,
  mcpServers: [],
  metadata: {},
  model: { id: "claude-opus-5" },
  multiagent: null,
  name: "D1 agent",
  skills: [],
  system: null,
  tools: [],
  updatedAt: "2026-08-26T00:00:00.000Z",
  version: 1,
};

beforeAll(async () => {
  await worker.fetch(
    new Request("http://localhost/health"),
    env as unknown as Record<string, unknown>,
    {} as ExecutionContext,
  );
});

beforeEach(async () => {
  await db().exec("DELETE FROM managed_agent_versions; DELETE FROM managed_agents;");
});

describe("SqlAgentPersistence on Cloudflare D1", () => {
  it("honors the same insert, atomic CAS, history, and list Port contract", async () => {
    const persistence = new SqlAgentPersistence(new CfD1SqlClient(db()));
    const next = {
      ...agent,
      name: "D1 agent v2",
      updatedAt: "2026-08-26T01:00:00.000Z",
      version: 2,
    };

    await persistence.insert({ workspaceId: "workspace_d1", agent });
    await expect(
      persistence.replaceCurrent({
        workspaceId: "workspace_d1",
        agentId: agent.id,
        expectedVersion: 1,
        next,
      }),
    ).resolves.toEqual({ type: "replaced", agent: next });
    await expect(
      persistence.findVersion({
        workspaceId: "workspace_d1",
        agentId: agent.id,
        version: 1,
      }),
    ).resolves.toEqual(agent);
    await expect(
      persistence.listCurrent({
        workspaceId: "workspace_d1",
        includeArchived: false,
        limit: 10,
      }),
    ).resolves.toEqual([next]);
  });
});
