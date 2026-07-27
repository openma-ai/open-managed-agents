ALTER TABLE "linear_publications" DROP CONSTRAINT "linear_publications_installation_id_linear_installations_id_fk";
--> statement-breakpoint
ALTER TABLE "github_publications" DROP CONSTRAINT "github_publications_installation_id_github_installations_id_fk";
--> statement-breakpoint
ALTER TABLE "slack_publications" DROP CONSTRAINT "slack_publications_installation_id_slack_installations_id_fk";
