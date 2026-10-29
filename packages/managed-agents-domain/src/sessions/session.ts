import type { AgentModel, AgentOpenMaExtensions } from "../agents";
import type {
  AgentMcpServer,
  AgentSkill,
  AgentTool,
} from "../agents";
import type { SessionResource } from "./resource";
import type { SessionThreadAgent } from "./thread";

export type SessionStatus = "rescheduling" | "running" | "idle" | "terminated";

export interface MonetaryAmount {
  amountMinor: string;
  currency: "USD";
}

export interface SessionAgent {
  id: string;
  description: string | null;
  mcpServers: AgentMcpServer[];
  /** The Agent's metadata, for the runtime only. Absent on Sessions created
   *  before it was snapshotted. */
  metadata?: Record<string, string>;
  model: AgentModel;
  multiagent: SessionAgentMultiagent | null;
  name: string;
  openma?: AgentOpenMaExtensions;
  skills: AgentSkill[];
  system: string | null;
  tools: AgentTool[];
  version: number;
}

export interface SessionAgentMultiagent {
  type: "multiagent_20261001";
  advisor: { type: "disabled" };
  subagents:
    | { type: "disabled" }
    | {
        type: "enabled";
        inlineAgents: { type: "enabled" } | { type: "disabled" };
        predefinedAgents: SessionThreadAgent[];
      };
  workflows: { type: "disabled" };
}

export interface SessionStats {
  activeSeconds?: number;
  durationSeconds?: number;
}

export interface SessionUsage {
  activeSeconds?: number;
  cacheCreation?: {
    ephemeralOneHourInputTokens?: number;
    ephemeralFiveMinuteInputTokens?: number;
  };
  cacheReadInputTokens?: number;
  inputTokens?: number;
  listCost?: MonetaryAmount | null;
  outputTokens?: number;
  serverToolUse?: {
    webFetchRequests?: number;
    webSearchRequests?: number;
  } | null;
}

export interface SessionOutcomeEvaluation {
  type: "outcome_evaluation";
  completedAt: string | null;
  description: string;
  explanation: string | null;
  iteration: number;
  outcomeId: string;
  result: string;
}

export interface Session {
  id: string;
  agent: SessionAgent;
  archivedAt: string | null;
  budget: MonetaryAmount | null;
  createdAt: string;
  environmentId: string;
  metadata: Record<string, string>;
  outcomeEvaluations: SessionOutcomeEvaluation[];
  resources: SessionResource[];
  stats: SessionStats;
  status: SessionStatus;
  title: string | null;
  updatedAt: string;
  usage: SessionUsage;
  vaultIds: string[];
  deploymentId?: string | null;
}
