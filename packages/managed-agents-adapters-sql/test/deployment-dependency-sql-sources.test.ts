import { beforeEach, describe, expect, it } from "vitest";
import type { Agent, Vault } from "@open-managed-agents/managed-agents-application";
import {
  createBetterSqlite3SqlClient,
  type SqlClient,
} from "@open-managed-agents/sql-client";
import {
  SqlDeploymentAgentSource,
  SqlDeploymentVaultSource,
} from "../src";

const SCHEMA_SQL = `
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
);
CREATE TABLE managed_vaults (
  workspace_id text NOT NULL,
  id text NOT NULL,
  document text NOT NULL,
  revision integer NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  archived_at integer,
  PRIMARY KEY (workspace_id, id)
);
`;

const agent = (version: number): Agent => ({
  id: "agent_01",
  archivedAt: null,
  createdAt: "2026-08-26T10:00:00.000Z",
  description: null,
  mcpServers: [],
  metadata: {},
  model: { id: "claude-opus-5" },
  multiagent: null,
  name: "Repository agent",
  skills: [],
  system: "Work carefully",
  tools: [],
  updatedAt: "2026-08-26T10:00:00.000Z",
  version,
});

const vault: Vault = {
  id: "vlt_01",
  archivedAt: null,
  createdAt: "2026-08-26T10:00:00.000Z",
  displayName: "Production",
  metadata: {},
  updatedAt: "2026-08-26T10:00:00.000Z",
};

describe("Deployment SQL dependency sources", () => {
  let client: SqlClient;

  beforeEach(async () => {
    client = await createBetterSqlite3SqlClient(":memory:");
    await client.exec(SCHEMA_SQL);
    await client
      .prepare(
        `INSERT INTO managed_agents
          (id, workspace_id, document, version, created_at, updated_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        "agent_01",
        "workspace_01",
        JSON.stringify(agent(3)),
        3,
        Date.parse("2026-08-26T10:00:00.000Z"),
        Date.parse("2026-08-26T10:00:00.000Z"),
        null,
      )
      .run();
    await client
      .prepare(
        `INSERT INTO managed_agent_versions
          (agent_id, workspace_id, version, document, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(
        "agent_01",
        "workspace_01",
        2,
        JSON.stringify(agent(2)),
        Date.parse("2026-08-26T10:00:00.000Z"),
      )
      .run();
    await client
      .prepare(
        `INSERT INTO managed_vaults
          (workspace_id, id, document, revision, created_at, updated_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        "workspace_01",
        "vlt_01",
        JSON.stringify(vault),
        1,
        Date.parse("2026-08-26T10:00:00.000Z"),
        Date.parse("2026-08-26T10:00:00.000Z"),
        null,
      )
      .run();
  });

  it("returns complete latest/versioned Agent and Vault snapshots", async () => {
    const agents = new SqlDeploymentAgentSource(client);
    const vaults = new SqlDeploymentVaultSource(client);

    await expect(
      agents.find({
        workspaceId: "workspace_01",
        selector: { kind: "latest", agentId: "agent_01" },
      }),
    ).resolves.toEqual(agent(3));
    await expect(
      agents.find({
        workspaceId: "workspace_01",
        selector: { kind: "versioned", agentId: "agent_01", version: 2 },
      }),
    ).resolves.toEqual(agent(2));
    await expect(
      vaults.find({ workspaceId: "workspace_01", vaultId: "vlt_01" }),
    ).resolves.toEqual(vault);
    await expect(
      vaults.find({ workspaceId: "other", vaultId: "vlt_01" }),
    ).resolves.toBeNull();
  });

  it("projects current Agent lifecycle state onto a pinned historical version", async () => {
    const archivedAt = "2026-08-26T11:00:00.000Z";
    await client
      .prepare(
        `UPDATE managed_agents
         SET document = ?, archived_at = ?
         WHERE workspace_id = ? AND id = ?`,
      )
      .bind(
        JSON.stringify({ ...agent(3), archivedAt }),
        Date.parse(archivedAt),
        "workspace_01",
        "agent_01",
      )
      .run();

    const agents = new SqlDeploymentAgentSource(client);

    await expect(
      agents.find({
        workspaceId: "workspace_01",
        selector: { kind: "versioned", agentId: "agent_01", version: 2 },
      }),
    ).resolves.toEqual({ ...agent(2), archivedAt });
  });
});
