CREATE TABLE "forum_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"author_id" uuid,
	"body" text NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "forum_item_tags" (
	"item_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	CONSTRAINT "forum_item_tags_item_id_tag_id_pk" PRIMARY KEY("item_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "forum_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"forum_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"priority" text DEFAULT 'MEDIUM' NOT NULL,
	"resolution" text,
	"milestone_id" uuid,
	"assignee_id" uuid,
	"reviewer_id" uuid,
	"reported_by_id" uuid,
	"fixed_at" timestamp with time zone,
	"fixed_by_id" uuid,
	"verified_at" timestamp with time zone,
	"verified_by_id" uuid,
	"closed_at" timestamp with time zone,
	"closed_by_id" uuid,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "forum_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"forum_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "forums" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"icon" text DEFAULT '📋' NOT NULL,
	"kind" text DEFAULT 'CUSTOM' NOT NULL,
	"key_prefix" text NOT NULL,
	"item_label" text DEFAULT 'issue' NOT NULL,
	"position" double precision DEFAULT 0 NOT NULL,
	"counter" integer DEFAULT 0 NOT NULL,
	"settings" jsonb DEFAULT '{"defaultReviewerId":null}'::jsonb NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by_id" uuid,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "item_id" uuid;--> statement-breakpoint
ALTER TABLE "activity_events" ADD COLUMN "item_id" uuid;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "item_id" uuid;--> statement-breakpoint
ALTER TABLE "forum_comments" ADD CONSTRAINT "forum_comments_item_id_forum_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."forum_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_comments" ADD CONSTRAINT "forum_comments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_comments" ADD CONSTRAINT "forum_comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_item_tags" ADD CONSTRAINT "forum_item_tags_item_id_forum_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."forum_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_item_tags" ADD CONSTRAINT "forum_item_tags_tag_id_forum_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."forum_tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_items" ADD CONSTRAINT "forum_items_forum_id_forums_id_fk" FOREIGN KEY ("forum_id") REFERENCES "public"."forums"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_items" ADD CONSTRAINT "forum_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_items" ADD CONSTRAINT "forum_items_milestone_id_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."milestones"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_items" ADD CONSTRAINT "forum_items_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_items" ADD CONSTRAINT "forum_items_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_items" ADD CONSTRAINT "forum_items_reported_by_id_users_id_fk" FOREIGN KEY ("reported_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_items" ADD CONSTRAINT "forum_items_fixed_by_id_users_id_fk" FOREIGN KEY ("fixed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_items" ADD CONSTRAINT "forum_items_verified_by_id_users_id_fk" FOREIGN KEY ("verified_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_items" ADD CONSTRAINT "forum_items_closed_by_id_users_id_fk" FOREIGN KEY ("closed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_tags" ADD CONSTRAINT "forum_tags_forum_id_forums_id_fk" FOREIGN KEY ("forum_id") REFERENCES "public"."forums"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_tags" ADD CONSTRAINT "forum_tags_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forums" ADD CONSTRAINT "forums_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forums" ADD CONSTRAINT "forums_archived_by_id_users_id_fk" FOREIGN KEY ("archived_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forums" ADD CONSTRAINT "forums_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "forum_comments_item_idx" ON "forum_comments" USING btree ("item_id","created_at");--> statement-breakpoint
CREATE INDEX "forum_item_tags_tag_idx" ON "forum_item_tags" USING btree ("tag_id");--> statement-breakpoint
CREATE UNIQUE INDEX "forum_items_forum_number_uq" ON "forum_items" USING btree ("forum_id","number");--> statement-breakpoint
CREATE INDEX "forum_items_forum_status_idx" ON "forum_items" USING btree ("forum_id","status");--> statement-breakpoint
CREATE INDEX "forum_items_project_idx" ON "forum_items" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "forum_items_milestone_idx" ON "forum_items" USING btree ("milestone_id");--> statement-breakpoint
CREATE INDEX "forum_items_assignee_idx" ON "forum_items" USING btree ("assignee_id");--> statement-breakpoint
CREATE INDEX "forum_items_reviewer_idx" ON "forum_items" USING btree ("reviewer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "forum_tags_forum_name_uq" ON "forum_tags" USING btree ("forum_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "forums_project_slug_uq" ON "forums" USING btree ("project_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "forums_project_prefix_uq" ON "forums" USING btree ("project_id","key_prefix");--> statement-breakpoint
CREATE INDEX "forums_project_idx" ON "forums" USING btree ("project_id","position");--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_item_id_forum_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."forum_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_item_id_forum_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."forum_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_item_id_forum_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."forum_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_item_idx" ON "attachments" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "activity_item_created_idx" ON "activity_events" USING btree ("item_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_item_idx" ON "notifications" USING btree ("item_id");--> statement-breakpoint
-- Every project gets its two standard forums: Bugs (keeps the project's bug counter and default
-- bug reviewer) and QA.
INSERT INTO "forums" ("project_id", "slug", "name", "description", "icon", "kind", "key_prefix", "item_label", "position", "counter", "settings", "created_by_id", "created_at")
SELECT p."id", 'bugs', 'Bugs', 'Things that are broken in the game: what happens, where, and who fixes and verifies it.', '🐞', 'BUGS', 'B', 'bug', 0, p."bug_counter",
       jsonb_build_object('defaultReviewerId', COALESCE(p."settings"->'defaultBugReviewerId', 'null'::jsonb)), p."created_by_id", p."created_at"
FROM "projects" p;--> statement-breakpoint
INSERT INTO "forums" ("project_id", "slug", "name", "description", "icon", "kind", "key_prefix", "item_label", "position", "counter", "settings", "created_by_id", "created_at")
SELECT p."id", 'qa', 'QA', 'Checks before an update ships: what to test, what was found, and whether it passed.', '✅', 'QA', 'Q', 'issue', 1024, 0,
       '{"defaultReviewerId":null}'::jsonb, p."created_by_id", p."created_at"
FROM "projects" p;--> statement-breakpoint
-- Existing bugs, tags, comments and files move into each project's Bugs forum, keeping their ids and numbers.
INSERT INTO "forum_items" ("id", "forum_id", "project_id", "number", "title", "description", "status", "priority", "resolution", "milestone_id", "assignee_id", "reviewer_id", "reported_by_id", "fixed_at", "fixed_by_id", "verified_at", "verified_by_id", "closed_at", "closed_by_id", "last_activity_at", "created_at", "updated_at")
SELECT b."id", f."id", b."project_id", b."number", b."title", b."description", b."status", b."priority", b."resolution", b."milestone_id", b."assignee_id", b."reviewer_id", b."reported_by_id", b."fixed_at", b."fixed_by_id", b."verified_at", b."verified_by_id", b."closed_at", b."closed_by_id", b."last_activity_at", b."created_at", b."updated_at"
FROM "bugs" b JOIN "forums" f ON f."project_id" = b."project_id" AND f."kind" = 'BUGS';--> statement-breakpoint
INSERT INTO "forum_tags" ("id", "forum_id", "project_id", "name", "color", "created_at", "updated_at")
SELECT t."id", f."id", t."project_id", t."name", t."color", t."created_at", t."updated_at"
FROM "bug_tags" t JOIN "forums" f ON f."project_id" = t."project_id" AND f."kind" = 'BUGS';--> statement-breakpoint
INSERT INTO "forum_item_tags" ("item_id", "tag_id") SELECT "bug_id", "tag_id" FROM "bug_tag_links";--> statement-breakpoint
INSERT INTO "forum_comments" ("id", "item_id", "project_id", "author_id", "body", "edited_at", "deleted_at", "created_at", "updated_at")
SELECT "id", "bug_id", "project_id", "author_id", "body", "edited_at", "deleted_at", "created_at", "updated_at" FROM "bug_comments";--> statement-breakpoint
UPDATE "attachments" SET "item_id" = "bug_id", "purpose" = 'ITEM' WHERE "bug_id" IS NOT NULL;--> statement-breakpoint
UPDATE "activity_events" SET "item_id" = "bug_id" WHERE "bug_id" IS NOT NULL;--> statement-breakpoint
UPDATE "activity_events" SET "type" = 'item.' || substr("type", 5) WHERE "type" LIKE 'bug.%';--> statement-breakpoint
UPDATE "notifications" SET "item_id" = "bug_id" WHERE "bug_id" IS NOT NULL;--> statement-breakpoint
UPDATE "notifications" SET "type" = 'ITEM_' || substr("type", 5) WHERE "type" LIKE 'BUG\_%';--> statement-breakpoint
UPDATE "notifications" SET "data" = ("data" - 'bugKey' - 'bugTitle') || jsonb_build_object('itemKey', "data"->'bugKey', 'itemTitle', "data"->'bugTitle', 'itemNoun', 'bug') WHERE "data" ? 'bugKey';--> statement-breakpoint
UPDATE "notification_preferences" SET "type" = 'ITEM_' || substr("type", 5) WHERE "type" LIKE 'BUG\_%';--> statement-breakpoint
UPDATE "projects" SET "settings" = "settings" - 'defaultBugReviewerId' WHERE "settings" ? 'defaultBugReviewerId';
