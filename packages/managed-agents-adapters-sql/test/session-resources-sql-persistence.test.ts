import { beforeEach, describe, expect, it } from "vitest";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type {
  Session,
  SessionResource,
} from "@open-managed-agents/managed-agents-application";
import { SqlSessionResourcePersistence } from "../src";

const SCHEMA_SQL = `
CREATE TABLE managed_sessions (
  id text PRIMARY KEY NOT NULL,
  workspace_id text NOT NULL,
  document text NOT NULL,
  revision integer NOT NULL,
  agent_id text NOT NULL,
  agent_version integer NOT NULL,
  environment_id text NOT NULL,
  deployment_id text,
  status text NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  archived_at integer
);
CREATE TABLE managed_session_resource_secrets (
  workspace_id text NOT NULL,
  session_id text NOT NULL,
  resource_id text NOT NULL,
  secret_type text NOT NULL,
  sealed_value text NOT NULL,
  updated_at integer NOT NULL,
  PRIMARY KEY (workspace_id, session_id, resource_id)
);
CREATE TABLE managed_session_memory_stores (
  session_id text NOT NULL,
  workspace_id text NOT NULL,
  memory_store_id text NOT NULL,
  PRIMARY KEY (session_id, workspace_id, memory_store_id)
);
`;

const githubResource: SessionResource = {
  id: "sesrsc_repo_01",
  type: "github_repository",
  createdAt: "2026-08-26T09:00:00.000Z",
  mountPath: "/workspace/openma",
  updatedAt: "2026-08-26T09:00:00.000Z",
  url: "https://github.com/openma-ai/open-managed-agents",
};

const session: Session = {
  id: "session_01",
  agent: {
    id: "agent_01",
    description: null,
    mcpServers: [],
    model: { id: "claude-opus-5" },
    multiagent: null,
    name: "Agent",
    skills: [],
    system: null,
    tools: [],
    version: 1,
  },
  archivedAt: null,
  budget: null,
  createdAt: "2026-08-26T09:00:00.000Z",
  environmentId: "env_01",
  metadata: {},
  outcomeEvaluations: [],
  resources: [githubResource],
  stats: {},
  status: "running",
  title: null,
  updatedAt: "2026-08-26T09:00:00.000Z",
  usage: {},
  vaultIds: [],
};

describe("SqlSessionResourcePersistence", () => {
  let client: SqlClient;

  beforeEach(async () => {
    client = await createBetterSqlite3SqlClient(":memory:");
    await client.exec(SCHEMA_SQL);
    await client
      .prepare(
        `INSERT INTO managed_sessions
          (id, workspace_id, document, revision, agent_id, agent_version,
           environment_id, deployment_id, status, created_at, updated_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        session.id,
        "workspace_01",
        JSON.stringify(session),
        3,
        session.agent.id,
        session.agent.version,
        session.environmentId,
        null,
        session.status,
        Date.parse(session.createdAt),
        Date.parse(session.updatedAt),
        null,
      )
      .run();
  });

  it("atomically CASes the public snapshot and sealed GitHub token", async () => {
    const persistence = new SqlSessionResourcePersistence(client, {
      seal: async (value: string) => `sealed:${value}`,
    });
    const updatedResource: SessionResource = {
      ...githubResource,
      updatedAt: "2026-08-26T10:00:00.000Z",
    };

    await expect(
      persistence.replaceCurrent({
        workspaceId: "workspace_01",
        sessionId: session.id,
        expectedRevision: 3,
        resources: [updatedResource],
        updatedAt: "2026-08-26T10:00:00.000Z",
        secretChanges: [
          {
            type: "store_github_token",
            resourceId: githubResource.id,
            authorizationToken: "ghp_current",
          },
        ],
      }),
    ).resolves.toEqual({
      type: "replaced",
      record: { resources: [updatedResource], revision: 4 },
    });
    await expect(
      persistence.replaceCurrent({
        workspaceId: "workspace_01",
        sessionId: session.id,
        expectedRevision: 3,
        resources: [],
        updatedAt: "2026-08-26T11:00:00.000Z",
        secretChanges: [
          {
            type: "store_github_token",
            resourceId: githubResource.id,
            authorizationToken: "ghp_stale",
          },
        ],
      }),
    ).resolves.toEqual({ type: "revision_conflict", actualRevision: 4 });
    await expect(
      client
        .prepare(
          `SELECT sealed_value FROM managed_session_resource_secrets
            WHERE workspace_id = ? AND session_id = ? AND resource_id = ?`,
        )
        .bind("workspace_01", session.id, githubResource.id)
        .first<{ sealed_value: string }>(),
    ).resolves.toEqual({ sealed_value: "sealed:ghp_current" });
    const stored = await client
      .prepare("SELECT document FROM managed_sessions WHERE id = ?")
      .bind(session.id)
      .first<{ document: string }>();
    expect(stored?.document).not.toContain("ghp_current");
    expect(stored?.document).not.toContain("ghp_stale");
  });
});
