import { beforeEach, describe, expect, it } from "vitest";
import type { Agent } from "@openma/core/domain/agents";
import type { Credential } from "@openma/core/domain/credentials";

import {
  createBetterSqlite3SqlClient,
  SqlAgentStore,
  sqlStores,
  type SqlClient,
} from "../src/index";

const SCHEMA = `
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
CREATE TABLE managed_credentials (
  workspace_id text NOT NULL,
  vault_id text NOT NULL,
  id text NOT NULL,
  sealed_document text NOT NULL,
  revision integer NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  archived_at integer,
  PRIMARY KEY (workspace_id, id)
);`;

const agent: Agent = {
  id: "agent_1",
  archivedAt: null,
  createdAt: "2026-11-03T00:00:00.000Z",
  description: null,
  mcpServers: [],
  metadata: {},
  model: { id: "claude-opus-5" },
  multiagent: null,
  name: "SQL Agent",
  skills: [],
  system: null,
  tools: [],
  updatedAt: "2026-11-03T00:00:00.000Z",
  version: 1,
};

const credential: Credential = {
  id: "vcrd_1",
  archivedAt: null,
  auth: { type: "static_bearer", token: "secret", mcpServerUrl: "https://mcp.example.com/sse" },
  createdAt: "2026-11-03T00:00:00.000Z",
  metadata: {},
  updatedAt: "2026-11-03T00:00:00.000Z",
  vaultId: "vlt_1",
};

describe("sqlStores", () => {
  let sql: SqlClient;

  beforeEach(async () => {
    sql = await createBetterSqlite3SqlClient(":memory:");
    await sql.exec(SCHEMA);
  });

  it("binds every storage Port to one SqlClient", async () => {
    const stores = sqlStores(sql);
    expect(stores.agents).toBeInstanceOf(SqlAgentStore);
    await stores.agents.insert({ workspaceId: "workspace_1", agent });
    await expect(stores.agents.findCurrent({
      workspaceId: "workspace_1",
      agentId: agent.id,
    })).resolves.toEqual(agent);
  });

  it("fails closed when a secret-bearing store has no cipher", async () => {
    const stores = sqlStores(sql);
    await expect(stores.credentials.insert({ workspaceId: "workspace_1", credential }))
      .rejects.toThrow("SQL Credential persistence requires a credentialCipher");
  });

  it("seals with the supplied cipher and keeps overrides", async () => {
    const agents = new SqlAgentStore(sql);
    const stores = sqlStores(sql, {
      credentialCipher: {
        seal: async ({ plaintext }) => ({ ciphertext: `sealed:${btoa(plaintext)}` }),
        open: async ({ ciphertext }) => ({ plaintext: atob(ciphertext.slice("sealed:".length)) }),
      },
      overrides: { agents },
    });
    expect(stores.agents).toBe(agents);
    await stores.credentials.insert({ workspaceId: "workspace_1", credential });
    const row = await sql.prepare("SELECT sealed_document FROM managed_credentials").first<{ sealed_document: string }>();
    expect(row?.sealed_document).toMatch(/^sealed:/);
    expect(row?.sealed_document).not.toContain("secret");
  });
});
