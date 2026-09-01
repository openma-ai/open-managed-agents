CREATE TABLE "managed_deployment_runs" (
	"workspace_id" text NOT NULL,
	"id" text NOT NULL,
	"deployment_id" text NOT NULL,
	"document" text NOT NULL,
	"revision" bigint NOT NULL,
	"has_error" bigint NOT NULL,
	"trigger_type" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "managed_deployment_runs_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "managed_deployments" (
	"workspace_id" text NOT NULL,
	"id" text NOT NULL,
	"document" text NOT NULL,
	"sealed_resource_secrets" text NOT NULL,
	"revision" bigint NOT NULL,
	"agent_id" text NOT NULL,
	"status" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"archived_at" bigint,
	CONSTRAINT "managed_deployments_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE INDEX "idx_managed_deployment_runs_workspace_created_id" ON "managed_deployment_runs" USING btree ("workspace_id","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_managed_deployment_runs_workspace_deployment_created_id" ON "managed_deployment_runs" USING btree ("workspace_id","deployment_id","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_managed_deployments_workspace_created_id" ON "managed_deployments" USING btree ("workspace_id","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_managed_deployments_workspace_agent_created_id" ON "managed_deployments" USING btree ("workspace_id","agent_id","created_at","id");