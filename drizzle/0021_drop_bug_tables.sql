ALTER TABLE "bug_comments" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "bug_tag_links" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "bug_tags" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "bugs" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "bug_comments" CASCADE;--> statement-breakpoint
DROP TABLE "bug_tag_links" CASCADE;--> statement-breakpoint
DROP TABLE "bug_tags" CASCADE;--> statement-breakpoint
DROP TABLE "bugs" CASCADE;--> statement-breakpoint
ALTER TABLE "attachments" DROP CONSTRAINT IF EXISTS "attachments_bug_id_bugs_id_fk";
--> statement-breakpoint
ALTER TABLE "activity_events" DROP CONSTRAINT IF EXISTS "activity_events_bug_id_bugs_id_fk";
--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT IF EXISTS "notifications_bug_id_bugs_id_fk";
--> statement-breakpoint
DROP INDEX IF EXISTS "attachments_bug_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "activity_bug_created_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "notifications_bug_idx";--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "bug_counter";--> statement-breakpoint
ALTER TABLE "attachments" DROP COLUMN "bug_id";--> statement-breakpoint
ALTER TABLE "activity_events" DROP COLUMN "bug_id";--> statement-breakpoint
ALTER TABLE "notifications" DROP COLUMN "bug_id";