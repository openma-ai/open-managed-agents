import type {
  AgentCreateParams,
  AgentListParams,
  AgentRetrieveParams,
  AgentUpdateParams,
  BetaManagedAgentsAgent,
} from "@anthropic-ai/sdk/resources/beta/agents/agents";
import type { VersionListParams } from "@anthropic-ai/sdk/resources/beta/agents/versions";
import { z } from "zod";
import {
  agentMcpServerInputSchema,
  agentMultiagentInputSchema,
  agentSkillInputSchema,
  agentToolInputSchema,
} from "./agent-input-components";
import {
  agentMcpServerResponseSchema,
  agentModelResponseSchema,
  agentMultiagentResponseSchema,
  agentSkillResponseSchema,
  agentToolResponseSchema,
} from "./agent-response-components";

export type AgentCreateBody = Omit<AgentCreateParams, "betas">;
export type AgentListQuery = Omit<AgentListParams, "betas">;
export type AgentRetrieveQuery = Omit<AgentRetrieveParams, "betas">;
export type AgentUpdateBody = Omit<AgentUpdateParams, "betas">;
export type AgentVersionListQuery = Omit<VersionListParams, "betas">;

type AgentModelConfig = Exclude<AgentCreateBody["model"], string>;

const effortLevelSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);
const modelConfigSchema: z.ZodType<AgentModelConfig> = z
  .object({
    id: z.string().min(1),
    effort: z
      .union([
        effortLevelSchema,
        z.object({ type: effortLevelSchema }).strict(),
      ])
      .nullable()
      .optional(),
    inference_geo: z.string().nullable().optional(),
    speed: z.enum(["standard", "fast"]).nullable().optional(),
  })
  .strict();

export const agentModelInputSchema: z.ZodType<AgentCreateBody["model"]> = z.union([
  z.string().min(1),
  modelConfigSchema,
]);

export const agentCreateBodySchema: z.ZodType<AgentCreateBody> = z
  .object({
    name: z.string().min(1),
    model: agentModelInputSchema,
    description: z.string().nullable().optional(),
    mcp_servers: z.array(agentMcpServerInputSchema).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    multiagent: agentMultiagentInputSchema.nullable().optional(),
    skills: z.array(agentSkillInputSchema).optional(),
    system: z.string().nullable().optional(),
    tools: z.array(agentToolInputSchema).optional(),
  })
  .strict();

export const agentRetrieveQuerySchema = z
  .object({
    version: z.coerce.number().int().min(1).optional(),
  })
  .strict();

export const agentListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).optional(),
    page: z.string().min(1).optional(),
    "created_at[gte]": z.string().min(1).optional(),
    "created_at[lte]": z.string().min(1).optional(),
    include_archived: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .optional(),
  })
  .strict();

export const agentVersionListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).optional(),
    page: z.string().min(1).optional(),
  })
  .strict();

export const agentUpdateBodySchema: z.ZodType<AgentUpdateBody> = z
  .object({
    description: z.string().nullable().optional(),
    mcp_servers: z.array(agentMcpServerInputSchema).nullable().optional(),
    metadata: z
      .record(z.string(), z.string().nullable())
      .nullable()
      .optional(),
    model: agentModelInputSchema.optional(),
    multiagent: agentMultiagentInputSchema.nullable().optional(),
    name: z.string().min(1).optional(),
    skills: z.array(agentSkillInputSchema).nullable().optional(),
    system: z.string().nullable().optional(),
    tools: z.array(agentToolInputSchema).nullable().optional(),
    version: z.number().int().min(1).optional(),
  })
  .strict();

export const agentResponseSchema: z.ZodType<BetaManagedAgentsAgent> = z
  .object({
    id: z.string().min(1),
    archived_at: z.string().nullable(),
    created_at: z.string(),
    description: z.string().nullable(),
    mcp_servers: z.array(agentMcpServerResponseSchema),
    metadata: z.record(z.string(), z.string()),
    model: agentModelResponseSchema,
    multiagent: agentMultiagentResponseSchema.nullable(),
    name: z.string().min(1),
    skills: z.array(agentSkillResponseSchema),
    system: z.string().nullable(),
    tools: z.array(agentToolResponseSchema),
    type: z.literal("agent"),
    updated_at: z.string(),
    version: z.number().int().min(1),
  })
  .strict();

export const agentPageResponseSchema = z
  .object({
    data: z.array(agentResponseSchema),
    next_page: z.string().nullable(),
  })
  .strict();
