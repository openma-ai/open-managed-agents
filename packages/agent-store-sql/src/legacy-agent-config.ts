import type { AgentRecord } from "@open-managed-agents/agent-store";

// Reads the config JSON of the retired `agents` / `agent_versions` tables
// (snake_case from the first OMA agent service, camelCase from the later
// codec) as a domain Agent. Used only by the migration that moves those rows
// to `managed_agents`.
// Only contract keys are renamed; user-owned JSON (schemas, env, provider
// options, metadata) is opaque and must never have its keys rewritten.
const names: Record<string, string> = {
  archivedAt: "archived_at", createdAt: "created_at", updatedAt: "updated_at",
  mcpServers: "mcp_servers", skillId: "skill_id", inferenceGeo: "inference_geo",
  providerOptions: "provider_options", maxTokens: "max_tokens", inputSchema: "input_schema",
  mcpServerName: "mcp_server_name", defaultConfig: "default_config", permissionPolicy: "permission_policy",
  allowedDomains: "allowed_domains", blockedDomains: "blocked_domains", maxContentTokens: "max_content_tokens",
  userLocation: "user_location", inlineAgents: "inline_agents", predefinedAgents: "predefined_agents",
  agentId: "id", auxiliaryModel: "aux_model", appendablePrompts: "appendable_prompts",
  contextManagement: "context_management", openaiModelSettings: "model_settings", compactionWireFormat: "compaction_wire_format",
  runtimeBinding: "runtime_binding", enableGeneralSubagent: "enable_general_subagent",
  runtimeId: "runtime_id", acpAgentId: "acp_agent_id", localSkillBlocklist: "local_skill_blocklist",
  maxRestarts: "max_restarts", windowMs: "window_ms", idleTimeoutMs: "idle_timeout_ms", perTurnTimeoutMs: "per_turn_timeout_ms",
};
const reverse = Object.fromEntries(Object.entries(names).filter(([key]) => key !== "agentId").map(([a,b]) => [b,a]));
// A field is translated only at its declared contract position. Unknown
// fields (including objects) remain opaque, even when their keys resemble ours.
interface Shape { fields: string[]; children?: Record<string, Shape> }
const policy: Shape = { fields: ["type"] };
const model: Shape = { fields: ["id", "speed", "inferenceGeo", "providerOptions", "maxTokens"] };
const toolConfig: Shape = { fields: ["name", "type", "enabled", "permissionPolicy", "allowedDomains", "blockedDomains", "maxContentTokens", "userLocation"], children: { permissionPolicy: policy } };
const tool: Shape = { fields: ["type", "name", "description", "inputSchema", "mcpServerName", "configs", "defaultConfig"], children: { configs: toolConfig, defaultConfig: toolConfig } };
const runtimeBinding: Shape = { fields: ["runtimeId", "acpAgentId", "localSkillBlocklist"] };
const acp: Shape = { fields: ["agent", "restart", "idleTimeoutMs", "perTurnTimeoutMs"], children: {
  restart: { fields: ["mode", "maxRestarts", "windowMs"] },
} };
const multiagent: Shape = { fields: ["type", "advisor", "subagents", "workflows"], children: {
  subagents: { fields: ["type", "inlineAgents", "predefinedAgents"], children: { predefinedAgents: { fields: ["type", "agentId", "id", "version"] } } },
} };
const root: Shape = { fields: ["id", "name", "model", "system", "description", "tools", "skills", "metadata", "multiagent", "mcpServers", "version", "createdAt", "updatedAt", "archivedAt", "auxiliaryModel", "appendablePrompts", "contextManagement", "openaiModelSettings", "compactionWireFormat", "harness", "acp", "runtimeBinding", "enableGeneralSubagent"], children: {
  model, auxiliaryModel: model, tools: tool, skills: { fields: ["skillId", "type", "version"] }, multiagent, acp, runtimeBinding,
} };
function map(value: unknown, encode: boolean, shape: Shape = root): any {
  if (Array.isArray(value)) return value.map((entry) => map(entry, encode, shape));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    const domainKey = encode ? key : reverse[key] ?? key;
    if (!shape.fields.includes(domainKey)) return [key, structuredClone(child)];
    const nested = shape.children?.[domainKey];
    return [encode ? names[key] ?? key : domainKey, nested ? map(child, encode, nested) : structuredClone(child)];
  }));
}
const extensionKeys = ["auxiliaryModel", "appendablePrompts", "contextManagement", "openaiModelSettings", "compactionWireFormat", "harness", "acp", "runtimeBinding", "enableGeneralSubagent"] as const;
const storageKeys = new Set(["id", "name", "model", "system", "description", "tools", "skills", "metadata", "multiagent", "mcp_servers", "version", "created_at", "updated_at", "archived_at", ...extensionKeys.map((key) => names[key] ?? key)]);

export function fromLegacyAgentConfig(config: string | Record<string, unknown>): AgentRecord {
  const raw = typeof config === "string" ? JSON.parse(config) : config;
  const value = map(raw, false);
  const openma: Record<string, unknown> = {};
  for (const key of extensionKeys) {
    if (value[key] !== undefined) { openma[key] = value[key]; delete value[key]; }
  }
  const unknown = Object.fromEntries(Object.entries(raw).filter(([key]) => !storageKeys.has(key)));
  if (Object.keys(unknown).length) openma.compatibility = { storedFields: unknown };
  const multiagent = value.multiagent ?? null;
  if (multiagent !== null) {
    if (multiagent.type !== "multiagent_20261001") throw new Error("Unsupported stored multiagent type");
    if (multiagent.subagents?.type === "enabled") {
      multiagent.subagents.predefinedAgents = multiagent.subagents.predefinedAgents.map((entry: any) => {
        if (entry.type !== "agent" || typeof entry.id !== "string" || !Number.isInteger(entry.version)) throw new Error("Unresolved stored multiagent reference");
        return { type: "agent", agentId: entry.id, version: entry.version };
      });
    }
  }
  return {
    id: value.id, name: value.name, model: typeof value.model === "string" ? { id: value.model } : value.model,
    description: value.description ?? null, system: value.system ?? null,
    mcpServers: value.mcpServers ?? [], metadata: value.metadata ?? {}, multiagent,
    skills: (value.skills ?? []).map((skill: any) => ({ ...skill, version: skill.version ?? "latest" })),
    tools: (value.tools ?? []).map((tool: any) => tool.type === "custom" ? tool : {
      ...tool, configs: tool.configs ?? [], defaultConfig: tool.defaultConfig ?? { enabled: true, permissionPolicy: { type: "always_allow" } },
    }),
    createdAt: value.createdAt, updatedAt: value.updatedAt ?? value.createdAt,
    archivedAt: value.archivedAt ?? null, version: value.version,
    ...(Object.keys(openma).length ? { openma } : {}),
  } as AgentRecord;
}
