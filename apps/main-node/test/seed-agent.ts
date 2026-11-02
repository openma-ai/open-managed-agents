import type { AgentRecord } from "@open-managed-agents/agent-store";
import { SqlAgentStore } from "@open-managed-agents/agent-store-sql";
import type { SqlClient } from "@open-managed-agents/sql-client";
import { generateAgentId } from "@open-managed-agents/shared";

/** Store an agent document, as test setup. Unset fields take the defaults the
 *  Managed Agents application would store. */
export async function seedAgent(
  sql: SqlClient,
  workspaceId: string,
  input: Partial<AgentRecord> & { name: string; model: AgentRecord["model"] },
): Promise<AgentRecord> {
  const now = new Date().toISOString();
  return new SqlAgentStore(sql).insert({
    workspaceId,
    agent: {
      id: generateAgentId(),
      archivedAt: null,
      createdAt: now,
      description: null,
      mcpServers: [],
      metadata: {},
      multiagent: null,
      skills: [],
      system: null,
      tools: [{
        type: "agent_toolset_20260401",
        configs: [],
        defaultConfig: { enabled: true, permissionPolicy: { type: "always_allow" } },
      }],
      updatedAt: now,
      version: 1,
      ...input,
    },
  });
}
