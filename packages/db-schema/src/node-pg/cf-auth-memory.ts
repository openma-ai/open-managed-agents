// Memory tables (Node-PG variant of cf-auth/memory).

import { bigint, index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

export const memory_stores = pgTable(
  "memory_stores",
  {
    id: text("id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    created_at: bigint("created_at", { mode: "number" }).notNull(),
    updated_at: bigint("updated_at", { mode: "number" }),
    archived_at: bigint("archived_at", { mode: "number" }),
  },
  (t) => [index("idx_memory_stores_tenant").on(t.tenant_id, t.archived_at)],
);

export const memories = pgTable(
  "memories",
  {
    id: text("id").primaryKey().notNull(),
    store_id: text("store_id").notNull(),
    path: text("path").notNull(),
    content_sha256: text("content_sha256").notNull(),
    // PG-side: NOT NULL (per applySchema). CF-side: nullable (the
    // post-0010 backfill leaves nulls until the data migration). Phase 3
    // reconciliation picks a winner; until then both shapes ship.
    etag: text("etag").notNull(),
    size_bytes: bigint("size_bytes", { mode: "number" }).notNull(),
    created_at: bigint("created_at", { mode: "number" }).notNull(),
    updated_at: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [uniqueIndex("idx_memories_store_path").on(t.store_id, t.path)],
);

export const memory_versions = pgTable(
  "memory_versions",
  {
    id: text("id").primaryKey().notNull(),
    memory_id: text("memory_id").notNull(),
    store_id: text("store_id").notNull(),
    operation: text("operation").notNull(),
    // applySchema PG branch declares these NOT NULL; mirror that.
    path: text("path").notNull(),
    content: text("content").notNull(),
    content_sha256: text("content_sha256").notNull(),
    size_bytes: bigint("size_bytes", { mode: "number" }).notNull(),
    actor_type: text("actor_type").notNull(),
    actor_id: text("actor_id").notNull(),
    created_at: bigint("created_at", { mode: "number" }).notNull(),
    // Integer flag, not boolean (matches applySchema source SQL).
    redacted: bigint("redacted", { mode: "number" }).notNull().default(0),
  },
  (t) => [
    index("idx_memory_versions_store").on(t.store_id, t.created_at),
    index("idx_memory_versions_memory").on(t.memory_id, t.created_at),
  ],
);

export const memory_blob_poller_lease = pgTable("memory_blob_poller_lease", {
  store_id: text("store_id").primaryKey().notNull(),
  owner: text("owner").notNull(),
  expires_at: bigint("expires_at", { mode: "number" }).notNull(),
  last_seen_ms: bigint("last_seen_ms", { mode: "number" }).notNull().default(0),
});
