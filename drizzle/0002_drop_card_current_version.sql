ALTER TABLE "cards" DROP CONSTRAINT "cards_current_version_id_asset_versions_id_fk";
--> statement-breakpoint
ALTER TABLE "cards" DROP COLUMN "current_version_id";