/**
 * Console-side Agent record. Wider than `@open-managed-agents/api-types`'
 * `AgentConfig` (the wire-format) — adds the runtime metadata the list
 * and detail endpoints return on top of the config (`version`,
 * `created_at`, `archived_at`) plus the `_oma` console extension.
 *
 * Lifted out of AgentDetail.tsx + AgentsList.tsx where two copies had
 * drifted (AgentDetail had `tools`, AgentsList had `_oma`; both had the
 * common metadata fields).
 */
export interface AgentRecord {
  id: string;
  name: string;
  model: string | { id: string; speed?: string };
  system?: string | null;
  version: number;
  description?: string | null;
  tools?: unknown[];
  skills?: Array<{ skill_id: string; type: string; version?: string }>;
  mcp_servers?: Array<{
    name: string;
    type: string;
    url?: string;
    authorization_token?: string;
    stdio?: {
      command: string;
      args?: string[];
      env?: Record<string, string>;
      port: number;
      sse_path?: string;
      ready_timeout_ms?: number;
    };
  }>;
  multiagent?: {
    type: "coordinator";
    agents: Array<{ type: "agent"; id: string; version: number }>;
  } | null;
  enable_general_subagent?: boolean;
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at?: string;
  archived_at?: string;
  /** Console-only enrichment from the OMA control plane: scratch/aux model
   *  selection, harness binding, appendable prompt presets. Not on the
   *  wire-format AgentConfig (those fields live in OMA-private storage). */
  _oma?: {
    aux_model?: { id: string; speed?: string };
    harness?: string;
    runtime_binding?: {
      runtime_id: string;
      acp_agent_id: string;
      local_skill_blocklist?: string[];
    };
    appendable_prompts?: string[];
  };
}
