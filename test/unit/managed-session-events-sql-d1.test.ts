import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import worker from "../test-worker";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import {
  SqlSessionEventPersistence,
  SqlSessionPersistence,
} from "@open-managed-agents/managed-agents-adapters-sql";
import type {
  SentSessionEvent,
  Session,
} from "@open-managed-agents/managed-agents-application";

function db(): D1Database {
  return (env as { MAIN_DB: D1Database }).MAIN_DB;
}

const event: SentSessionEvent = {
  id: "event_d1_contract",
  type: "system.message",
  content: [{ type: "text", text: "D1 contract" }],
  processedAt: "2026-08-26T08:00:00.000Z",
};

const session: Session = {
  id: "session_d1_events",
  agent: {
    id: "agent_d1_events",
    description: null,
    mcpServers: [],
    model: { id: "claude-opus-5" },
    multiagent: null,
    name: "D1 event agent",
    skills: [],
    system: null,
    tools: [],
    version: 1,
  },
  archivedAt: null,
  budget: null,
  createdAt: "2026-08-26T07:00:00.000Z",
  environmentId: "env_d1_events",
  metadata: {},
  outcomeEvaluations: [],
  resources: [],
  stats: {},
  status: "running",
  title: null,
  updatedAt: "2026-08-26T08:00:00.000Z",
  usage: {},
  vaultIds: [],
};

beforeAll(async () => {
  await worker.fetch(
    new Request("http://localhost/health"),
    env as unknown as Record<string, unknown>,
    {} as ExecutionContext,
  );
});

describe("SqlSessionEventPersistence on Cloudflare D1", () => {
  it("appends and lists on the deployed migration schema", async () => {
    const client = new CfD1SqlClient(db());
    await new SqlSessionPersistence(client, {
      seal: async (value: string) => value,
    }).insert({
      workspaceId: "workspace_d1_events",
      session,
      initialEvents: [],
      resourceSecrets: [],
    });
    const persistence = new SqlSessionEventPersistence(client);

    await persistence.append({
      workspaceId: "workspace_d1_events",
      sessionId: session.id,
      expectedRevision: 1,
      events: [event],
      nextSession: session,
    });
    await expect(
      persistence.list({
        workspaceId: "workspace_d1_events",
        sessionId: session.id,
        limit: 10,
        order: "asc",
      }),
    ).resolves.toEqual([event]);
  });
});
