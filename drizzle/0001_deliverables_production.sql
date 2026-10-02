CREATE TABLE "deliverable_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"card_id" uuid NOT NULL,
	"from_id" uuid NOT NULL,
	"to_id" uuid NOT NULL,
	"type" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deliverables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"card_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"asset_type" text DEFAULT '' NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"state" text DEFAULT 'NOT_SUBMITTED' NOT NULL,
	"owner_id" uuid,
	"reviewer_id" uuid,
	"due_at" timestamp with time zone,
	"current_version_id" uuid,
	"approved_version_id" uuid,
	"cover_attachment_id" uuid,
	"canvas_x" real DEFAULT 0 NOT NULL,
	"canvas_y" real DEFAULT 0 NOT NULL,
	"position" double precision NOT NULL,
	"created_by_id" uuid,
	"archived_at" timestamp with time zone,
	"archived_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "production_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"card_id" uuid NOT NULL,
	"actor_id" uuid,
	"from_status" text NOT NULL,
	"to_status" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"snapshot" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roblox_resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"content_id" text NOT NULL,
	"kind" text NOT NULL,
	"attachment_id" uuid NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "asset_versions_card_number_uq";--> statement-breakpoint
ALTER TABLE "user_board_prefs" ADD COLUMN "view" text DEFAULT 'CATEGORY' NOT NULL;--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "production_status" text DEFAULT 'TODO' NOT NULL;--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "production_position" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "completed_by_id" uuid;--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "published_by_id" uuid;--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "production_snapshot" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "asset_versions" ADD COLUMN "deliverable_id" uuid;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "deliverable_id" uuid;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "meta" jsonb;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "preview_config" jsonb;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "deliverable_id" uuid;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "deliverable_id" uuid;--> statement-breakpoint
-- Preserve existing work: every card gets one deliverable that inherits its revisions,
-- review history, file feedback and cover. Nothing is deleted or re-numbered.
INSERT INTO "deliverables" ("card_id", "project_id", "number", "name", "state", "current_version_id", "approved_version_id", "cover_attachment_id", "position", "created_by_id", "created_at", "updated_at")
SELECT c."id", c."project_id", 1, c."title", c."state", c."current_version_id",
  (SELECT v."id" FROM "asset_versions" v WHERE v."card_id" = c."id" AND v."status" = 'APPROVED' ORDER BY v."version_number" DESC LIMIT 1),
  c."cover_attachment_id", 1024, c."created_by_id", c."created_at", now()
FROM "cards" c;--> statement-breakpoint
UPDATE "asset_versions" v SET "deliverable_id" = d."id" FROM "deliverables" d WHERE d."card_id" = v."card_id";--> statement-breakpoint
ALTER TABLE "asset_versions" ALTER COLUMN "deliverable_id" SET NOT NULL;--> statement-breakpoint
UPDATE "attachments" a SET "deliverable_id" = v."deliverable_id" FROM "asset_versions" v WHERE a."version_id" = v."id";--> statement-breakpoint
UPDATE "comments" cm SET "deliverable_id" = v."deliverable_id" FROM "asset_versions" v WHERE cm."version_id" = v."id";--> statement-breakpoint
UPDATE "reviews" r SET "deliverable_id" = d."id" FROM "deliverables" d WHERE d."card_id" = r."card_id";--> statement-breakpoint
-- The production view starts in the same order as the category view.
UPDATE "cards" c SET "production_position" = o.rn * 1024
FROM (
  SELECT c2."id", row_number() OVER (PARTITION BY c2."project_id" ORDER BY col."position", c2."position") AS rn
  FROM "cards" c2 JOIN "board_columns" col ON col."id" = c2."column_id"
) o
WHERE o."id" = c."id";--> statement-breakpoint
ALTER TABLE "deliverable_links" ADD CONSTRAINT "deliverable_links_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverable_links" ADD CONSTRAINT "deliverable_links_from_id_deliverables_id_fk" FOREIGN KEY ("from_id") REFERENCES "public"."deliverables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverable_links" ADD CONSTRAINT "deliverable_links_to_id_deliverables_id_fk" FOREIGN KEY ("to_id") REFERENCES "public"."deliverables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverable_links" ADD CONSTRAINT "deliverable_links_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverables" ADD CONSTRAINT "deliverables_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverables" ADD CONSTRAINT "deliverables_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverables" ADD CONSTRAINT "deliverables_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverables" ADD CONSTRAINT "deliverables_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverables" ADD CONSTRAINT "deliverables_current_version_id_asset_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."asset_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverables" ADD CONSTRAINT "deliverables_approved_version_id_asset_versions_id_fk" FOREIGN KEY ("approved_version_id") REFERENCES "public"."asset_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverables" ADD CONSTRAINT "deliverables_cover_attachment_id_attachments_id_fk" FOREIGN KEY ("cover_attachment_id") REFERENCES "public"."attachments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverables" ADD CONSTRAINT "deliverables_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverables" ADD CONSTRAINT "deliverables_archived_by_id_users_id_fk" FOREIGN KEY ("archived_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_events" ADD CONSTRAINT "production_events_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_events" ADD CONSTRAINT "production_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roblox_resources" ADD CONSTRAINT "roblox_resources_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roblox_resources" ADD CONSTRAINT "roblox_resources_attachment_id_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roblox_resources" ADD CONSTRAINT "roblox_resources_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "deliverable_links_pair_uq" ON "deliverable_links" USING btree ("from_id","to_id","type");--> statement-breakpoint
CREATE INDEX "deliverable_links_card_idx" ON "deliverable_links" USING btree ("card_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deliverables_card_number_uq" ON "deliverables" USING btree ("card_id","number");--> statement-breakpoint
CREATE INDEX "deliverables_card_idx" ON "deliverables" USING btree ("card_id","position");--> statement-breakpoint
CREATE INDEX "deliverables_owner_idx" ON "deliverables" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "production_events_card_idx" ON "production_events" USING btree ("card_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "roblox_resources_project_content_uq" ON "roblox_resources" USING btree ("project_id","content_id","kind");--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_completed_by_id_users_id_fk" FOREIGN KEY ("completed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_published_by_id_users_id_fk" FOREIGN KEY ("published_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_versions" ADD CONSTRAINT "asset_versions_deliverable_id_deliverables_id_fk" FOREIGN KEY ("deliverable_id") REFERENCES "public"."deliverables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_deliverable_id_deliverables_id_fk" FOREIGN KEY ("deliverable_id") REFERENCES "public"."deliverables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_deliverable_id_deliverables_id_fk" FOREIGN KEY ("deliverable_id") REFERENCES "public"."deliverables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_deliverable_id_deliverables_id_fk" FOREIGN KEY ("deliverable_id") REFERENCES "public"."deliverables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cards_project_production_idx" ON "cards" USING btree ("project_id","production_status","production_position");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_versions_deliverable_number_uq" ON "asset_versions" USING btree ("deliverable_id","version_number");--> statement-breakpoint
CREATE INDEX "asset_versions_card_idx" ON "asset_versions" USING btree ("card_id");--> statement-breakpoint
CREATE INDEX "attachments_deliverable_idx" ON "attachments" USING btree ("deliverable_id");--> statement-breakpoint
CREATE INDEX "comments_deliverable_idx" ON "comments" USING btree ("deliverable_id");--> statement-breakpoint
CREATE INDEX "reviews_deliverable_idx" ON "reviews" USING btree ("deliverable_id","created_at");