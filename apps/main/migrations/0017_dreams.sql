-- Migration 0017: Dreams resource — Anthropic Managed Agents Dreams
-- (https://platform.claude.com/docs/en/managed-agents/dreams)
--
-- A `dream` is an async pipeline that takes an existing memory store + 0..N
-- past sessions, and produces a NEW memory store (the input is never mutated).
-- Lifecycle: pending → running → completed | failed | canceled.
--
-- Storage choices:
--   * One D1 row per dream — small payload (a few ids + status fields), no
--     blob component. The curated output bytes live in the OUTPUT memory store
--     (regular memory_stores / memories / R2). The dream row only carries
--     references.
--   * `inputs` is split across two columns so we can index on the input
--     memory_store_id without parsing JSON (lets memory.ts cheaply check
--     "is this store referenced by an in-flight dream?" before allowing
--     archive/delete — see the input_*_unavailable error path in the spec).
--     `input_session_ids` stays JSON because it's a 0..100 array we only ever
--     read whole.
--   * `output_memory_store_id` is NULL until the pipeline provisions the
--     output store (right at the pending → running transition). After that,
--     archiving / deleting the output store while the dream is still active
--     is rejected (see routes/memory.ts guard).
--   * `usage` JSON mirrors the Anthropic Dream resource shape:
--     {input_tokens, output_tokens, cache_creation_input_tokens,
--      cache_read_input_tokens}. Updated incrementally as the pipeline runs.
--   * `error` JSON carries {type, message} on failure; NULL otherwise. The
--     type enum is documented in dreams-store/errors.ts (timeout,
--     internal_error, input_memory_store_too_large, input_memory_store_unavailable,
--     input_session_unavailable, memory_store_org_limit_exceeded).

CREATE TABLE IF NOT EXISTS "dreams" (
  "id"                       TEXT PRIMARY KEY NOT NULL,
  "tenant_id"                TEXT NOT NULL,
  "status"                   TEXT NOT NULL,
  "input_memory_store_id"    TEXT NOT NULL,
  "input_session_ids"        TEXT NOT NULL,  -- JSON array of session ids
  "output_memory_store_id"   TEXT,           -- NULL until provisioned
  "model"                    TEXT NOT NULL,
  "instructions"             TEXT,
  "session_id"               TEXT,           -- NULL until pipeline session spawned
  "usage"                    TEXT NOT NULL,  -- JSON, default {0,0,0,0}
  "error"                    TEXT,           -- JSON {type,message} on failure
  "created_at"               INTEGER NOT NULL,
  "started_at"               INTEGER,
  "ended_at"                 INTEGER,
  "archived_at"              INTEGER
);

-- List endpoint: newest first per tenant, archived filter.
CREATE INDEX IF NOT EXISTS "idx_dreams_tenant_created"
  ON "dreams" ("tenant_id", "created_at" DESC);

-- Reverse lookup from a memory store id to in-flight dreams referencing it.
-- Used by routes/memory.ts to refuse archive/delete of an input or output
-- store while it is bound to a non-terminal dream.
CREATE INDEX IF NOT EXISTS "idx_dreams_input_store"
  ON "dreams" ("input_memory_store_id", "status");

CREATE INDEX IF NOT EXISTS "idx_dreams_output_store"
  ON "dreams" ("output_memory_store_id", "status")
  WHERE "output_memory_store_id" IS NOT NULL;
