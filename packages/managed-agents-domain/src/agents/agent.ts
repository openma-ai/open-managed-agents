import type {
  AgentMcpServer,
  AgentMultiagent,
  AgentSkill,
  AgentTool,
} from "./definition";

export type AgentEffortLevel = "low" | "medium" | "high" | "xhigh" | "max";
export type AgentSpeed = "standard" | "fast";

export interface AgentModel {
  id: string;
  effort?: AgentEffortLevel;
  inferenceGeo?: string;
  speed?: AgentSpeed;
}

export interface Agent {
  id: string;
  archivedAt: string | null;
  createdAt: string;
  description: string | null;
  mcpServers: AgentMcpServer[];
  metadata: Record<string, string>;
  model: AgentModel;
  multiagent: AgentMultiagent | null;
  name: string;
  skills: AgentSkill[];
  system: string | null;
  tools: AgentTool[];
  updatedAt: string;
  version: number;
}
