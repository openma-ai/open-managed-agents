import { beforeEach, describe, expect, it } from "vitest";

import {
  createBetterSqlite3SqlClient,
  type SqlClient,
} from "@open-managed-agents/sql-client";

import { SqlAgentStore } from "../src";
import { migrateLegacyAgents } from "../src/legacy-agents-migration";

const SCHEMA = `
CREATE TABLE agents (
  id text PRIMARY KEY NOT NULL,
  tenant_id text NOT NULL,
  config text NOT NULL,
  version integer NOT NULL,
  created_at integer NOT NULL,
  updated_at integer,
  archived_at integer
);
CREATE TABLE agent_versions (
  agent_id text NOT NULL,
  tenant_id text NOT NULL,
  version integer NOT NULL,
  snapshot text NOT NULL,
  created_at integer NOT NULL,
  PRIMARY KEY (agent_id, version)
);
CREATE TABLE managed_agents (
  id text PRIMARY KEY NOT NULL,
  workspace_id text NOT NULL,
  document text NOT NULL,
  version integer NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  archived_at integer
);
CREATE TABLE managed_agent_versions (
  agent_id text NOT NULL,
  workspace_id text NOT NULL,
  version integer NOT NULL,
  document text NOT NULL,
  created_at integer NOT NULL,
  PRIMARY KEY (agent_id, version)
);`;

const T0 = Date.parse("2026-09-23T13:10:53.561Z");
const T1 = Date.parse("2026-10-27T10:00:00.000Z");

async function count(client: SqlClient, table: string): Promise<number> {
  return Number((await client.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n);
}

describe("migrateLegacyAgents", () => {
  let client: SqlClient;

  beforeEach(async () => {
    client = await createBetterSqlite3SqlClient(":memory:");
    await client.exec(SCHEMA);
  });

  it("moves snake_case and camelCase rows with their history and empties the legacy tables", async () => {
    // Written by the old AgentService (snake_case, string model, no updated_at).
    await client.prepare("INSERT INTO agents VALUES (?, ?, ?, ?, ?, ?, ?)").bind(
      "agent-old", "ws", JSON.stringify({
        id: "agent-old", name: "old", model: "m", system: "hi",
        tools: [{ type: "agent_toolset_20260401" }],
        runtime_binding: { runtime_id: "rt", acp_agent_id: "claude" },
        version: 1, created_at: "2026-09-23T13:10:53.561Z",
      }), 1, T0, null, null,
    ).run();
    // Written through the codec (camelCase domain document) with history.
    await client.prepare("INSERT INTO agents VALUES (?, ?, ?, ?, ?, ?, ?)").bind(
      "agent-new", "ws", JSON.stringify({
        id: "agent-new", name: "new v2", model: { id: "m" }, mcpServers: [],
        harness: "acp-sandbox", acp: { agent: { registry: "claude-acp@0.94.0" } },
        metadata: { team: "data" }, version: 2,
      }), 2, T0, T1, null,
    ).run();
    await client.prepare("INSERT INTO agent_versions VALUES (?, ?, ?, ?, ?)").bind(
      "agent-new", "ws", 1, JSON.stringify({ id: "agent-new", name: "new v1", model: { id: "m" }, version: 1 }), T0,
    ).run();
    // A stale managed row for the same id loses to the legacy row.
    await client.prepare("INSERT INTO managed_agents VALUES (?, ?, ?, ?, ?, ?, ?)").bind(
      "agent-new", "ws", JSON.stringify({ id: "agent-new", name: "stale" }), 9, T0, T0, null,
    ).run();

    expect(await migrateLegacyAgents(client)).toBe(2);

    const store = new SqlAgentStore(client);
    const old = await store.findCurrent({ workspaceId: "ws", agentId: "agent-old" });
    expect(old).toMatchObject({
      name: "old", model: { id: "m" }, system: "hi", version: 1,
      createdAt: "2026-09-23T13:10:53.561Z", updatedAt: "2026-09-23T13:10:53.561Z", archivedAt: null,
      openma: { runtimeBinding: { runtimeId: "rt", acpAgentId: "claude" } },
      tools: [{ type: "agent_toolset_20260401", configs: [], defaultConfig: { enabled: true } }],
    });
    const current = await store.findCurrent({ workspaceId: "ws", agentId: "agent-new" });
    expect(current).toMatchObject({
      name: "new v2", version: 2, updatedAt: new Date(T1).toISOString(), metadata: { team: "data" },
      openma: { harness: "acp-sandbox", acp: { agent: { registry: "claude-acp@0.94.0" } } },
    });
    expect(await store.findVersion({ workspaceId: "ws", agentId: "agent-new", version: 1 }))
      .toMatchObject({ name: "new v1", version: 1 });
    expect(await count(client, "agents")).toBe(0);
    expect(await count(client, "agent_versions")).toBe(0);

    // Rerunning is a no-op.
    expect(await migrateLegacyAgents(client)).toBe(0);
    expect(await count(client, "managed_agents")).toBe(2);
  });

  it("refuses history rows whose agent is gone", async () => {
    await client.prepare("INSERT INTO agent_versions VALUES (?, ?, ?, ?, ?)").bind(
      "agent-gone", "ws", 1, JSON.stringify({ id: "agent-gone", name: "x", model: "m", version: 1 }), T0,
    ).run();
    await expect(migrateLegacyAgents(client)).rejects.toThrow(/agent_versions has 1 row/);
  });
});
