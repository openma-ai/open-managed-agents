/**
 * Console-side Session list/detail row. Differs from
 * `@open-managed-agents/api-types`' `SessionMeta` (wire-format) — the
 * list endpoint returns `agent: {id, version}` rather than `agent_id`
 * + `agent_version`, and `title` may be null.
 *
 * Lifted out of SessionsList.tsx so SessionDetail and other consumers
 * can share the shape instead of redefining their own.
 */
export interface SessionRecord {
  id: string;
  title?: string | null;
  agent: { id: string; version: number };
  environment_id: string;
  status?: string;
  created_at: string;
  archived_at?: string;
  metadata?: Record<string, unknown>;
}
