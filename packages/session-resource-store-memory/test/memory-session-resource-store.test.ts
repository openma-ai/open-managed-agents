import { describe, expect, it } from "vitest";
import type { Session } from "@open-managed-agents/domain/sessions";
import { MemorySessionStore } from "../../session-store-memory/src/index";
import { MemorySessionResourceStore } from "../src/index";

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
  createdAt: "2026-08-26T01:00:00.000Z",
  environmentId: "environment_01",
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

describe("MemorySessionResourceStore", () => {
  it("projects the Session aggregate and preserves revision CAS", async () => {
    const sessions = new MemorySessionStore();
    await sessions.insert({
      workspaceId: "workspace_01",
      session,
      initialEvents: [],
      resourceSecrets: [],
    });
    const store = new MemorySessionResourceStore(sessions);
    const resource = {
      id: "sesrsc_file_01",
      type: "file" as const,
      createdAt: "2026-08-26T02:00:00.000Z",
      fileId: "file_01",
      mountPath: "/mnt/session/uploads/file_01",
      updatedAt: "2026-08-26T02:00:00.000Z",
    };

    await expect(store.findCurrent({
      workspaceId: "workspace_02",
      sessionId: session.id,
    })).resolves.toBeNull();
    await expect(store.replaceCurrent({
      workspaceId: "workspace_01",
      sessionId: session.id,
      expectedRevision: 1,
      resources: [resource],
      updatedAt: resource.updatedAt,
      secretChanges: [{
        type: "store_github_token",
        resourceId: "sesrsc_repo_01",
        authorizationToken: "ghp_never_in_session_document",
      }],
    })).resolves.toEqual({
      type: "replaced",
      record: { resources: [resource], revision: 2 },
    });
    await expect(store.replaceCurrent({
      workspaceId: "workspace_01",
      sessionId: session.id,
      expectedRevision: 1,
      resources: [],
      updatedAt: "2026-08-26T03:00:00.000Z",
      secretChanges: [],
    })).resolves.toEqual({ type: "revision_conflict", actualRevision: 2 });

    const stored = await sessions.findCurrent({
      workspaceId: "workspace_01",
      sessionId: session.id,
    });
    expect(stored).toMatchObject({
      revision: 2,
      session: { resources: [resource], updatedAt: resource.updatedAt },
    });
    expect(JSON.stringify(stored)).not.toContain("ghp_never_in_session_document");

    const projection = await store.findCurrent({
      workspaceId: "workspace_01",
      sessionId: session.id,
    });
    projection?.resources.splice(0);
    await expect(store.findCurrent({
      workspaceId: "workspace_01",
      sessionId: session.id,
    })).resolves.toEqual({ resources: [resource], revision: 2 });
  });
});
