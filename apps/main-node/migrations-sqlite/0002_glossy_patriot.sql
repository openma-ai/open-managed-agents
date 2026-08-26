CREATE TABLE `feishu_message_events` (
	`delivery_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`group_id` text NOT NULL,
	`event_id` text,
	`event_type` text,
	`received_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`,`event_id`,`group_id`) REFERENCES `group_events`(`tenant_id`,`event_id`,`group_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_feishu_message_events_event` ON `feishu_message_events` (`tenant_id`,`event_id`,`group_id`);--> statement-breakpoint
CREATE TABLE `group_events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`group_id` text NOT NULL,
	`supervisor_session_id` text,
	`status` text NOT NULL,
	`seed_summary` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`concluded_at` integer,
	FOREIGN KEY (`supervisor_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ck_group_events_status" CHECK("status" IN ('pending','discussing','synthesizing','concluded','failed'))
);
--> statement-breakpoint
CREATE INDEX `idx_group_events_tenant_group` ON `group_events` (`tenant_id`,`group_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_group_events_tenant_event_group` ON `group_events` (`tenant_id`,`event_id`,`group_id`);--> statement-breakpoint
CREATE TABLE `memory_confirmations` (
	`confirmation_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`source_session_id` text NOT NULL,
	`custom_tool_use_id` text NOT NULL,
	`event_id` text NOT NULL,
	`group_id` text NOT NULL,
	`memory_store_id` text NOT NULL,
	`memory_path` text NOT NULL,
	`memory_etag` text,
	`status` text NOT NULL,
	`confirmer_type` text,
	`confirmer_id` text,
	`payload` text,
	`last_error` text,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`next_retry_at` integer,
	`created_at` integer NOT NULL,
	`confirmed_at` integer,
	FOREIGN KEY (`tenant_id`,`event_id`,`group_id`) REFERENCES `group_events`(`tenant_id`,`event_id`,`group_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_memory_confirmations_status" CHECK("status" IN ('pending','confirmed','rejected','superseded','retrying')),
	CONSTRAINT "ck_memory_confirmations_confirmer_type" CHECK("confirmer_type" IS NULL OR "confirmer_type" IN ('user','system')),
	CONSTRAINT "ck_memory_confirmations_confirmed_fields" CHECK("status" <> 'confirmed' OR ("confirmer_type" IS NOT NULL AND "confirmer_id" IS NOT NULL AND "confirmed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `idx_memory_confirmations_retry` ON `memory_confirmations` (`status`,`next_retry_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_memory_confirmations_session_tool` ON `memory_confirmations` (`source_session_id`,`custom_tool_use_id`);--> statement-breakpoint
CREATE TABLE `session_threads` (
	`id` text NOT NULL,
	`session_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`agent_name` text,
	`parent_thread_id` text,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`archived_at` integer,
	PRIMARY KEY(`session_id`, `id`),
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`,`parent_thread_id`) REFERENCES `session_threads`(`session_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_session_threads_session` ON `session_threads` (`session_id`);
--> statement-breakpoint
-- ─── SQLite enforcement triggers — COMPLETE declarative-FK mirror ──────────
-- main-node runs SQLite with PRAGMA foreign_keys = OFF (matches D1; see
-- apps/main-node/src/index.ts:184 + better-sqlite3.ts:155), so the FOREIGN KEY
-- clauses above are declarative-only in prod. The triggers below mirror the
-- FULL declarative-FK semantic so integrity is identical under FK=ON and
-- FK=OFF. For every declared FK we cover: child INSERT + UPDATE existence
-- (MATCH SIMPLE), parent DELETE action (CASCADE / SET NULL / NO ACTION), and
-- parent UPDATE action (NO ACTION) on the referenced key. The self-ref
-- session_threads ON DELETE CASCADE walks descendants via a recursive CTE so
-- it terminates without relying on PRAGMA recursive_triggers (OFF by default).
--
-- FK map (declared → trigger-enforced):
--   session_threads.session_id                 → sessions.id             ON DEL cascade   ON UPD no action
--   session_threads.(session_id,parent_thread)→ session_threads.(session_id,id)  ON DEL cascade  ON UPD no action (self-ref)
--   group_events.supervisor_session_id         → sessions.id             ON DEL set null  ON UPD no action
--   feishu_message_events.(tenant,event,group) → group_events(tenant,event,group)  ON DEL no action  ON UPD no action
--   memory_confirmations.(tenant,event,group)  → group_events(tenant,event,group)  ON DEL no action  ON UPD no action
-- memory_confirmations.source_session_id is intentionally NOT covered: it is
-- a plain TEXT snapshot (no FK) whose row must survive session deletion.
--
-- Under FK=ON these triggers stay correct and harmless: the FK acts first, so
-- AFTER DELETE cascade/SET NULL triggers find zero rows and no-op, and the
-- BEFORE triggers re-assert what the FK already enforced.
--
-- child INSERT existence ---------------------------------------------------
CREATE TRIGGER trg_fki_sthr_session
BEFORE INSERT ON session_threads
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'FK: session_threads.session_id not in sessions')
  WHERE NOT EXISTS (SELECT 1 FROM sessions WHERE id = NEW.session_id);
END;
--> statement-breakpoint
CREATE TRIGGER trg_fki_sthr_parent
BEFORE INSERT ON session_threads
FOR EACH ROW
WHEN NEW.parent_thread_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'FK: session_threads.parent_thread_id not found in same session')
  WHERE NOT EXISTS (
    SELECT 1 FROM session_threads st
    WHERE st.session_id = NEW.session_id AND st.id = NEW.parent_thread_id
  );
END;
--> statement-breakpoint
CREATE TRIGGER trg_fki_gev_supervisor
BEFORE INSERT ON group_events
FOR EACH ROW
WHEN NEW.supervisor_session_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'FK: group_events.supervisor_session_id not in sessions')
  WHERE NOT EXISTS (SELECT 1 FROM sessions WHERE id = NEW.supervisor_session_id);
END;
--> statement-breakpoint
CREATE TRIGGER trg_fki_fme_group
BEFORE INSERT ON feishu_message_events
FOR EACH ROW
WHEN NEW.event_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'FK: feishu_message_events (tenant_id,event_id,group_id) not in group_events')
  WHERE NOT EXISTS (
    SELECT 1 FROM group_events ge
    WHERE ge.tenant_id = NEW.tenant_id AND ge.event_id = NEW.event_id AND ge.group_id = NEW.group_id
  );
END;
--> statement-breakpoint
CREATE TRIGGER trg_fki_mc_group
BEFORE INSERT ON memory_confirmations
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'FK: memory_confirmations (tenant_id,event_id,group_id) not in group_events')
  WHERE NOT EXISTS (
    SELECT 1 FROM group_events ge
    WHERE ge.tenant_id = NEW.tenant_id AND ge.event_id = NEW.event_id AND ge.group_id = NEW.group_id
  );
END;
--> statement-breakpoint
-- child UPDATE existence (fire when ANY column of the FK constraint changes,
-- not just one — a composite FK can be broken by changing any single column of
-- the tuple while the others stay put) ----
CREATE TRIGGER trg_fku_sthr_session
BEFORE UPDATE ON session_threads
FOR EACH ROW
WHEN NEW.session_id <> OLD.session_id
BEGIN
  SELECT RAISE(ABORT, 'FK: session_threads.session_id not in sessions')
  WHERE NOT EXISTS (SELECT 1 FROM sessions WHERE id = NEW.session_id);
END;
--> statement-breakpoint
CREATE TRIGGER trg_fku_sthr_parent
BEFORE UPDATE ON session_threads
FOR EACH ROW
WHEN NEW.parent_thread_id IS NOT NULL AND (OLD.parent_thread_id IS NULL OR NEW.parent_thread_id <> OLD.parent_thread_id OR NEW.session_id <> OLD.session_id)
BEGIN
  SELECT RAISE(ABORT, 'FK: session_threads.parent_thread_id not found in same session')
  WHERE NOT EXISTS (
    SELECT 1 FROM session_threads st
    WHERE st.session_id = NEW.session_id AND st.id = NEW.parent_thread_id
  );
END;
--> statement-breakpoint
CREATE TRIGGER trg_fku_gev_supervisor
BEFORE UPDATE ON group_events
FOR EACH ROW
WHEN NEW.supervisor_session_id IS NOT NULL AND (OLD.supervisor_session_id IS NULL OR NEW.supervisor_session_id <> OLD.supervisor_session_id)
BEGIN
  SELECT RAISE(ABORT, 'FK: group_events.supervisor_session_id not in sessions')
  WHERE NOT EXISTS (SELECT 1 FROM sessions WHERE id = NEW.supervisor_session_id);
END;
--> statement-breakpoint
CREATE TRIGGER trg_fku_fme_group
BEFORE UPDATE ON feishu_message_events
FOR EACH ROW
WHEN NEW.event_id IS NOT NULL AND (OLD.event_id IS NULL OR NEW.event_id <> OLD.event_id OR NEW.tenant_id <> OLD.tenant_id OR NEW.group_id <> OLD.group_id)
BEGIN
  SELECT RAISE(ABORT, 'FK: feishu_message_events (tenant_id,event_id,group_id) not in group_events')
  WHERE NOT EXISTS (
    SELECT 1 FROM group_events ge
    WHERE ge.tenant_id = NEW.tenant_id AND ge.event_id = NEW.event_id AND ge.group_id = NEW.group_id
  );
END;
--> statement-breakpoint
CREATE TRIGGER trg_fku_mc_group
BEFORE UPDATE ON memory_confirmations
FOR EACH ROW
WHEN NEW.tenant_id <> OLD.tenant_id OR NEW.event_id <> OLD.event_id OR NEW.group_id <> OLD.group_id
BEGIN
  SELECT RAISE(ABORT, 'FK: memory_confirmations (tenant_id,event_id,group_id) not in group_events')
  WHERE NOT EXISTS (
    SELECT 1 FROM group_events ge
    WHERE ge.tenant_id = NEW.tenant_id AND ge.event_id = NEW.event_id AND ge.group_id = NEW.group_id
  );
END;
--> statement-breakpoint
-- parent DELETE actions ----------------------------------------------------
-- sessions ON DELETE CASCADE session_threads + SET NULL group_events.supervisor.
CREATE TRIGGER trg_fkd_session_sthr
AFTER DELETE ON sessions
FOR EACH ROW
BEGIN
  DELETE FROM session_threads WHERE session_id = OLD.id;
END;
--> statement-breakpoint
CREATE TRIGGER trg_fkd_session_gev
AFTER DELETE ON sessions
FOR EACH ROW
BEGIN
  UPDATE group_events SET supervisor_session_id = NULL WHERE supervisor_session_id = OLD.id;
END;
--> statement-breakpoint
-- session_threads self-ref ON DELETE CASCADE (transitive, recursive CTE).
-- AFTER DELETE so OLD is gone; walks descendants in one statement. The
-- recursive term must JOIN the CTE in its FROM (the self-reference), and the
-- CTE name avoids the reserved word `desc`. With PRAGMA recursive_triggers
-- OFF (default) the inner DELETE does not re-fire this trigger, so it
-- terminates; the CTE supplies the full descent.
CREATE TRIGGER trg_fkd_sthr_parent
AFTER DELETE ON session_threads
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM session_threads WHERE session_id = OLD.session_id AND parent_thread_id = OLD.id)
BEGIN
  DELETE FROM session_threads
  WHERE session_id = OLD.session_id
    AND id IN (
      WITH RECURSIVE children_cte(tid) AS (
        SELECT id FROM session_threads
        WHERE session_id = OLD.session_id AND parent_thread_id = OLD.id
        UNION ALL
        SELECT c.id FROM session_threads c
        JOIN children_cte ON c.parent_thread_id = children_cte.tid
        WHERE c.session_id = OLD.session_id
      )
      SELECT tid FROM children_cte
    );
END;
--> statement-breakpoint
-- group_events ON DELETE NO ACTION — block if any feishu_message_events or
-- memory_confirmations still references it (no orphan rows).
CREATE TRIGGER trg_fkd_gev_refs
BEFORE DELETE ON group_events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'NO ACTION: group_events referenced by feishu_message_events')
  WHERE EXISTS (
    SELECT 1 FROM feishu_message_events
    WHERE tenant_id = OLD.tenant_id AND event_id = OLD.event_id AND group_id = OLD.group_id
  );
  SELECT RAISE(ABORT, 'NO ACTION: group_events referenced by memory_confirmations')
  WHERE EXISTS (
    SELECT 1 FROM memory_confirmations
    WHERE tenant_id = OLD.tenant_id AND event_id = OLD.event_id AND group_id = OLD.group_id
  );
END;
--> statement-breakpoint
-- parent UPDATE actions (ON UPDATE NO ACTION) — reject changing a referenced
-- key while children point at it.
CREATE TRIGGER trg_fku_session_id
BEFORE UPDATE ON sessions
FOR EACH ROW
WHEN NEW.id <> OLD.id
BEGIN
  SELECT RAISE(ABORT, 'NO ACTION: sessions.id referenced by session_threads')
  WHERE EXISTS (SELECT 1 FROM session_threads WHERE session_id = OLD.id);
  SELECT RAISE(ABORT, 'NO ACTION: sessions.id referenced by group_events')
  WHERE EXISTS (SELECT 1 FROM group_events WHERE supervisor_session_id = OLD.id);
END;
--> statement-breakpoint
CREATE TRIGGER trg_fku_sthr_pk
BEFORE UPDATE ON session_threads
FOR EACH ROW
WHEN NEW.session_id <> OLD.session_id OR NEW.id <> OLD.id
BEGIN
  SELECT RAISE(ABORT, 'NO ACTION: session_threads.(session_id,id) referenced by child threads')
  WHERE EXISTS (
    SELECT 1 FROM session_threads WHERE session_id = OLD.session_id AND parent_thread_id = OLD.id
  );
END;
--> statement-breakpoint
CREATE TRIGGER trg_fku_gev_refs
BEFORE UPDATE ON group_events
FOR EACH ROW
WHEN NEW.tenant_id <> OLD.tenant_id OR NEW.event_id <> OLD.event_id OR NEW.group_id <> OLD.group_id
BEGIN
  SELECT RAISE(ABORT, 'NO ACTION: group_events identity referenced by feishu_message_events')
  WHERE EXISTS (
    SELECT 1 FROM feishu_message_events
    WHERE tenant_id = OLD.tenant_id AND event_id = OLD.event_id AND group_id = OLD.group_id
  );
  SELECT RAISE(ABORT, 'NO ACTION: group_events identity referenced by memory_confirmations')
  WHERE EXISTS (
    SELECT 1 FROM memory_confirmations
    WHERE tenant_id = OLD.tenant_id AND event_id = OLD.event_id AND group_id = OLD.group_id
  );
END;