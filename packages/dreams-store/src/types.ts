// Public types for the dreams-store service. Mirrors the D1 schema in
// apps/main/migrations/0017_dreams.sql and the wire shape documented at
// https://platform.claude.com/docs/en/managed-agents/dreams.

/**
 * Dream lifecycle states. Mirrors Anthropic's spec.
 *
 *   pending   → row created, output store not yet provisioned
 *   running   → output store provisioned + (optionally) internal session
 *               spawned; usage updates as the pipeline progresses
 *   completed → terminal; output store carries the curated result
 *   failed    → terminal; `error` is populated; output store left as-is
 *               (partial contents may be present)
 *   canceled  → terminal; output store left as-is
 */
export type DreamStatus = "pending" | "running" | "completed" | "failed" | "canceled";

/** Models accepted during the research preview, per the spec's "Limits" table. */
export const SUPPORTED_DREAM_MODELS = ["claude-opus-4-7", "claude-sonnet-4-6"] as const;
export type DreamModel = (typeof SUPPORTED_DREAM_MODELS)[number];

export const MAX_SESSIONS_PER_DREAM = 100;
export const MAX_DREAM_INSTRUCTIONS_CHARS = 4096;

export interface DreamUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

/**
 * Error.type enum from the spec. Kept open-ended so future error categories
 * can be added without breaking the union. The route layer maps these onto
 * the Anthropic-shaped error envelope.
 */
export type DreamErrorType =
  | "timeout"
  | "internal_error"
  | "memory_store_org_limit_exceeded"
  | "input_memory_store_too_large"
  | "input_memory_store_unavailable"
  | "input_session_unavailable";

export interface DreamError {
  type: DreamErrorType;
  message: string;
}

/** Canonical zero usage row used at create time. */
export const ZERO_USAGE: DreamUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

/**
 * The shape returned by the repo + service. ISO strings on the wire, like
 * sessions / memory_stores. `inputs` is split across two columns in storage
 * but flattened back into the wire-aligned shape at the boundary.
 */
export interface DreamRow {
  id: string;
  tenant_id: string;
  status: DreamStatus;
  input_memory_store_id: string;
  /** 0..100 session ids — never undefined; empty array is the valid no-session case. */
  input_session_ids: string[];
  /** Populated at the pending → running transition. */
  output_memory_store_id: string | null;
  model: DreamModel;
  instructions: string | null;
  /** Set when the internal pipeline session is spawned; null in `pending`. */
  session_id: string | null;
  usage: DreamUsage;
  error: DreamError | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  archived_at: string | null;
}

/** Status sets used by guards across the service + route layers. */
export const NON_TERMINAL_STATUSES: ReadonlyArray<DreamStatus> = ["pending", "running"];
export const TERMINAL_STATUSES: ReadonlyArray<DreamStatus> = ["completed", "failed", "canceled"];

export function isTerminal(s: DreamStatus): boolean {
  return TERMINAL_STATUSES.includes(s);
}

export function isNonTerminal(s: DreamStatus): boolean {
  return NON_TERMINAL_STATUSES.includes(s);
}
