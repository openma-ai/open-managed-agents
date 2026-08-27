import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import worker from "../test-worker";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import {
  SqlSessionPersistence,
  SqlSessionResourcePersistence,
  SqlSessionRuntimeProjectionPersistence,
} from "@open-managed-agents/managed-agents-adapters-sql";
import type {
  Session,
  SessionResource,
} from "@open-managed-agents/managed-agents-application";

function db(): D1Database {
  return (env as { MAIN_DB: D1Database }).MAIN_DB;
}

const session: Session = {
  id: "session_d1_contract",
  agent: {
    id: "agent_d1_contract",
    description: null,
    mcpServers: [],
    model: { id: "claude-opus-5" },
    multiagent: null,
    name: "D1 Agent",
    skills: [],
    system: null,
    tools: [],
    version: 1,
  },
  archivedAt: null,
  budget: null,
  createdAt: "2026-08-26T00:00:00.000Z",
  environmentId: "env_d1",
  metadata: {},
  outcomeEvaluations: [],
  resources: [],
  stats: {},
  status: "running",
  title: "D1 session",
  updatedAt: "2026-08-26T00:00:00.000Z",
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

describe("SqlSessionPersistence on Cloudflare D1", () => {
  it("honors insert and revision CAS on the deployed migration schema", async () => {
    const persistence = new SqlSessionPersistence(new CfD1SqlClient(db()), {
      seal: async (value: string) => `sealed:${value}`,
    });
    const next = {
      ...session,
      title: "D1 session updated",
      updatedAt: "2026-08-26T01:00:00.000Z",
    };

    await persistence.insert({
      workspaceId: "workspace_d1",
      session,
      initialEvents: [],
      resourceSecrets: [],
    });
    await expect(
      persistence.replaceCurrent({
        workspaceId: "workspace_d1",
        sessionId: session.id,
        expectedRevision: 1,
        next,
      }),
    ).resolves.toEqual({
      type: "replaced",
      record: { session: next, revision: 2 },
    });

    const resource: SessionResource = {
      id: "sesrsc_d1_contract",
      type: "github_repository",
      createdAt: "2026-08-26T02:00:00.000Z",
      mountPath: "/workspace/openma",
      updatedAt: "2026-08-26T02:00:00.000Z",
      url: "https://github.com/openma-ai/open-managed-agents",
    };
    const resources = new SqlSessionResourcePersistence(
      new CfD1SqlClient(db()),
      { seal: async (value: string) => `sealed:${value}` },
    );
    await expect(
      resources.replaceCurrent({
        workspaceId: "workspace_d1",
        sessionId: session.id,
        expectedRevision: 2,
        resources: [resource],
        updatedAt: "2026-08-26T02:00:00.000Z",
        secretChanges: [
          {
            type: "store_github_token",
            resourceId: resource.id,
            authorizationToken: "ghp_d1_contract",
          },
        ],
      }),
    ).resolves.toEqual({
      type: "replaced",
      record: { resources: [resource], revision: 3 },
    });

    const projection = new SqlSessionRuntimeProjectionPersistence(
      new CfD1SqlClient(db()),
    );
    const current = await projection.findCurrent({
      workspaceId: "workspace_d1",
      sessionId: session.id,
    });
    if (current === null) throw new Error("expected D1 session projection source");
    const runtimeEvent = {
      id: "event_d1_runtime",
      type: "session.status_idle" as const,
      processedAt: "2026-08-26T03:00:00.000Z",
      stopReason: { type: "end_turn" as const },
    };
    await expect(
      projection.project({
        workspaceId: "workspace_d1",
        sessionId: session.id,
        expectedRevision: 3,
        events: [runtimeEvent],
        next: {
          ...current.session,
          status: "idle",
          updatedAt: runtimeEvent.processedAt,
        },
      }),
    ).resolves.toMatchObject({
      type: "projected",
      record: {
        revision: 4,
        session: { status: "idle", updatedAt: runtimeEvent.processedAt },
      },
    });
  });
});
