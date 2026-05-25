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
  system?: string;
  version: number;
  description?: string;
  tools?: unknown[];
  skills?: unknown[];
  mcp_servers?: unknown[];
  multiagent?: {
    type: "coordinator";
    agents: Array<{ type: "agent"; id: string; version: number }>;
  } | null;
  created_at: string;
  updated_at?: string;
  archived_at?: string;
  /** Console-only enrichment from the OMA control plane: scratch/aux model
   *  selection, harness binding, appendable prompt presets. Not on the
   *  wire-format AgentConfig (those fields live in OMA-private storage). */
  _oma?: {
    aux_model?: { id: string; speed?: string };
    harness?: string;
    runtime_binding?: { runtime_id: string; acp_agent_id: string };
    appendable_prompts?: string[];
  };
}
