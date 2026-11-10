import type { NodeSessionSandboxContext } from "../../../packages/control-plane-node/src/lib/node-session-sandbox.js";

export function workStorageContext(): NodeSessionSandboxContext {
  const timestamp = "2026-01-01T00:00:00Z";
  return {
    workspaceId: "ws",
    environment: { id: "env", archivedAt: null, config: { type: "cloud", packages: { apt: [], cargo: [], gem: [], go: [], npm: [], pip: [] }, networking: { type: "unrestricted" } }, createdAt: timestamp, updatedAt: timestamp, description: null, name: "test", metadata: {} },
    session: { id: "sess", archivedAt: null, budget: null, createdAt: timestamp, updatedAt: timestamp, environmentId: "env", metadata: {}, outcomeEvaluations: [], resources: [], stats: {}, status: "running", title: null, usage: {}, vaultIds: [],
      agent: { id: "agent", version: 1, description: null, mcpServers: [], model: { id: "test" }, multiagent: null, name: "test", skills: [], system: null, tools: [] },
    },
  };
}
