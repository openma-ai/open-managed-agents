-- Fail closed: legacy rows require an explicit operator-led migration. Never infer
-- source order or consumption from processed_at. This CHECK names the prerequisite.
CREATE TABLE work_inputs_source_position_preflight (valid INTEGER CONSTRAINT source_position_required CHECK(valid = 1));
--> statement-breakpoint
INSERT INTO work_inputs_source_position_preflight SELECT 0 FROM managed_session_events WHERE (json_type(document, '$.source_position.revision') IS NOT 'integer' OR json_type(document, '$.source_position.index') IS NOT 'integer' OR json_extract(document, '$.source_position.revision') NOT BETWEEN 1 AND 9007199254740991 OR json_extract(document, '$.source_position.index') NOT BETWEEN 0 AND 9007199254740991) LIMIT 1;
--> statement-breakpoint
CREATE UNIQUE INDEX managed_session_events_source_position ON managed_session_events(workspace_id,session_id,json_extract(document, '$.source_position.revision'),json_extract(document, '$.source_position.index'));
--> statement-breakpoint
CREATE INDEX managed_session_events_source_position_invalid ON managed_session_events(workspace_id,session_id) WHERE (json_type(document, '$.source_position.revision') IS NOT 'integer' OR json_type(document, '$.source_position.index') IS NOT 'integer' OR json_extract(document, '$.source_position.revision') NOT BETWEEN 1 AND 9007199254740991 OR json_extract(document, '$.source_position.index') NOT BETWEEN 0 AND 9007199254740991);
--> statement-breakpoint
CREATE INDEX managed_session_initial_events_source_position_invalid ON managed_session_initial_events(workspace_id,session_id) WHERE (json_extract(document, '$.source_position.revision') IS NOT 1 OR json_type(document, '$.source_position.revision') IS NOT 'integer' OR json_extract(document, '$.source_position.index') IS NOT sequence OR json_type(document, '$.source_position.index') IS NOT 'integer' OR json_extract(document, '$.id') IS NOT ('bootstrap_' || session_id || ':' || sequence));
--> statement-breakpoint
DROP TABLE work_inputs_source_position_preflight;
