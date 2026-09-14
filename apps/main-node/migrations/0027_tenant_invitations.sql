CREATE TABLE "tenant_invitation" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"role" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"accepted_by" text,
	"claim_id" text,
	CONSTRAINT "tenant_invitation_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE INDEX "idx_tenant_invitation_tenant" ON "tenant_invitation" USING btree ("tenant_id");