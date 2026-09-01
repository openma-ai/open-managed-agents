import type {
  AgentCreateBody,
  AgentListQuery,
  AgentUpdateBody,
  AgentVersionListQuery,
} from "../contracts/agents";
import type {
  AgentModelInput,
  AgentView,
  CreateAgentCommand,
  ListAgentsQuery,
  ListAgentVersionsQuery,
  UpdateAgentCommand,
} from "../ports";
import {
  fromAgentMcpServerInput,
  fromAgentMultiagentInput,
  fromAgentSkillInput,
  fromAgentToolInput,
  toAgentMcpServerInput,
  toAgentMultiagentInput,
  toAgentSkillInput,
  toAgentToolInput,
} from "./agent-definition";

export function toAgentModelInput(
  model: AgentCreateBody["model"],
): string | AgentModelInput {
  if (typeof model === "string") return model;

  return {
    id: model.id,
    ...(model.effort !== undefined && {
      effort:
        typeof model.effort === "string"
          ? model.effort
          : (model.effort?.type ?? null),
    }),
    ...(model.inference_geo !== undefined && {
      inferenceGeo: model.inference_geo,
    }),
    ...(model.speed !== undefined && { speed: model.speed }),
  };
}

export function toCreateAgentCommand(body: AgentCreateBody): CreateAgentCommand {
  return {
    name: body.name,
    model: toAgentModelInput(body.model),
    ...(body.description !== undefined && { description: body.description }),
    ...(body.mcp_servers !== undefined && {
      mcpServers: body.mcp_servers.map(toAgentMcpServerInput),
    }),
    ...(body.metadata !== undefined && { metadata: body.metadata }),
    ...(body.multiagent !== undefined && {
      multiagent:
        body.multiagent === null
          ? null
          : toAgentMultiagentInput(body.multiagent),
    }),
    ...(body.skills !== undefined && {
      skills: body.skills.map(toAgentSkillInput),
    }),
    ...(body.system !== undefined && { system: body.system }),
    ...(body.tools !== undefined && {
      tools: body.tools.map(toAgentToolInput),
    }),
  };
}

export function toUpdateAgentCommand(
  agentId: string,
  body: AgentUpdateBody,
): UpdateAgentCommand {
  return {
    agentId,
    ...(body.description !== undefined && { description: body.description }),
    ...(body.mcp_servers !== undefined && {
      mcpServers:
        body.mcp_servers === null
          ? null
          : body.mcp_servers.map(toAgentMcpServerInput),
    }),
    ...(body.metadata !== undefined && { metadata: body.metadata }),
    ...(body.model !== undefined && { model: toAgentModelInput(body.model) }),
    ...(body.multiagent !== undefined && {
      multiagent:
        body.multiagent === null
          ? null
          : toAgentMultiagentInput(body.multiagent),
    }),
    ...(body.name !== undefined && { name: body.name }),
    ...(body.skills !== undefined && {
      skills:
        body.skills === null ? null : body.skills.map(toAgentSkillInput),
    }),
    ...(body.system !== undefined && { system: body.system }),
    ...(body.tools !== undefined && {
      tools: body.tools === null ? null : body.tools.map(toAgentToolInput),
    }),
    ...(body.version !== undefined && { expectedVersion: body.version }),
  };
}

export function toListAgentsQuery(query: AgentListQuery): ListAgentsQuery {
  return {
    ...(query.limit !== undefined && { pageSize: query.limit }),
    ...(query.page != null && { cursor: query.page }),
    ...(query["created_at[gte]"] !== undefined && {
      createdAtOrAfter: query["created_at[gte]"],
    }),
    ...(query["created_at[lte]"] !== undefined && {
      createdAtOrBefore: query["created_at[lte]"],
    }),
    ...(query.include_archived !== undefined && {
      includeArchived: query.include_archived,
    }),
  };
}

export function toListAgentVersionsQuery(
  agentId: string,
  query: AgentVersionListQuery,
): ListAgentVersionsQuery {
  return {
    agentId,
    ...(query.limit !== undefined && { pageSize: query.limit }),
    ...(query.page != null && { cursor: query.page }),
  };
}

export function toAgentResponse(agent: AgentView): object {
  return {
    id: agent.id,
    archived_at: agent.archivedAt,
    created_at: agent.createdAt,
    description: agent.description,
    mcp_servers: agent.mcpServers.map(fromAgentMcpServerInput),
    metadata: agent.metadata,
    model: {
      id: agent.model.id,
      ...(agent.model.effort !== undefined && {
        effort: { type: agent.model.effort },
      }),
      ...(agent.model.inferenceGeo !== undefined && {
        inference_geo: agent.model.inferenceGeo,
      }),
      ...(agent.model.speed !== undefined && { speed: agent.model.speed }),
    },
    multiagent:
      agent.multiagent === null
        ? null
        : fromAgentMultiagentInput(agent.multiagent),
    name: agent.name,
    skills: agent.skills.map(fromAgentSkillInput),
    system: agent.system,
    tools: agent.tools.map(fromAgentToolInput),
    type: "agent",
    updated_at: agent.updatedAt,
    version: agent.version,
  };
}
