import { beforeEach, describe, expect, it } from "vitest";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type {
  Environment,
  FindSessionExecutionContext,
  Session,
  SessionExecutionContextSourcePort,
} from "@open-managed-agents/managed-agents-application";
import * as sqlAdapters from "../src";

const SCHEMA_SQL = `
CREATE TABLE managed_sessions (
  id text NOT NULL,
  workspace_id text NOT NULL,
  document text NOT NULL,
  revision integer NOT NULL,
  agent_id text NOT NULL,
  agent_version integer NOT NULL,
  environment_id text NOT NULL,
  status text NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  archived_at integer,
  PRIMARY KEY (workspace_id, id)
);
CREATE TABLE managed_environments (
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

const session: Session = {
  id: "session_01",
  agent: {
    id: "agent_01",
    description: null,
    mcpServers: [],
    model: { id: "claude-opus-5" },
    multiagent: null,
    name: "Coding agent",
    skills: [],
    system: null,
    tools: [],
    version: 1,
  },
  archivedAt: null,
  budget: null,
  createdAt: "2026-08-26T00:00:00.000Z",
  environmentId: "env_01",
  metadata: {},
  outcomeEvaluations: [],
  resources: [],
  stats: {},
  status: "running",
  title: null,
  updatedAt: "2026-08-26T01:00:00.000Z",
  usage: {},
  vaultIds: [],
};

const environment: Environment = {
  id: "env_01",
  archivedAt: null,
  config: { type: "self_hosted" },
  createdAt: "2026-08-25T00:00:00.000Z",
  description: null,
  metadata: {},
  name: "Node runtime",
  updatedAt: "2026-08-25T01:00:00.000Z",
};

interface ReadersFactory {
  (client: SqlClient): {
    executionContext: SessionExecutionContextSourcePort;
  };
}

describe("SqlSessionExecutionContextSource", () => {
  let client: SqlClient;

  beforeEach(async () => {
    client = await createBetterSqlite3SqlClient(":memory:");
    await client.exec(SCHEMA_SQL);
  });

  it("loads a complete tenant-scoped context including an archived environment", async () => {
    const createReaders = (
      sqlAdapters as typeof sqlAdapters & {
        createSqlSessionRuntimeReaders?: ReadersFactory;
      }
    ).createSqlSessionRuntimeReaders;
    expect(createReaders).toBeTypeOf("function");
    if (createReaders === undefined) return;

    const archivedAt = "2026-08-26T02:00:00.000Z";
    await client
      .prepare(
        `INSERT INTO managed_environments
          (workspace_id, id, document, revision, created_at, updated_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        "workspace_01",
        environment.id,
        JSON.stringify(environment),
        2,
        Date.parse(environment.createdAt),
        Date.parse(archivedAt),
        Date.parse(archivedAt),
      )
      .run();
    await client
      .prepare(
        `INSERT INTO managed_sessions
          (workspace_id, id, document, revision, agent_id, agent_version,
           environment_id, status, created_at, updated_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        "workspace_01",
        session.id,
        JSON.stringify(session),
        1,
        session.agent.id,
        session.agent.version,
        session.environmentId,
        session.status,
        Date.parse(session.createdAt),
        Date.parse(session.updatedAt),
        null,
      )
      .run();
    const source = createReaders(client).executionContext;
    const find = (workspaceId: string): Promise<unknown> =>
      source.find({
        workspaceId,
        sessionId: session.id,
      } satisfies FindSessionExecutionContext);

    await expect(find("workspace_01")).resolves.toEqual({
      session,
      environment: {
        ...environment,
        archivedAt,
        updatedAt: archivedAt,
      },
      revision: 1,
    });
    await expect(find("workspace_other")).resolves.toBeNull();
  });
});
