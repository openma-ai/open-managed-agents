-- Reconcile the Node-PG model_cards table with the post-0015 model-card
-- contract used by SqlModelCardRepo. Existing rows retain their old model
-- string (model_id) as the initial provider wire-model value.
ALTER TABLE "model_cards" ADD COLUMN "model" text DEFAULT '' NOT NULL;
--> statement-breakpoint
UPDATE "model_cards" SET "model" = "model_id" WHERE "model" = '';
--> statement-breakpoint
ALTER TABLE "model_cards" DROP COLUMN "display_name";
