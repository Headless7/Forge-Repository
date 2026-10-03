CREATE TABLE "push_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"notification_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"user_agent" text,
	"last_success_at" timestamp with time zone,
	"failures" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_deliverable_id_deliverables_id_fk";
--> statement-breakpoint
DROP INDEX "boards_project_idx";--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "number" integer;--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "description" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "position" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "archived_by_id" uuid;--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "created_by_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "board_counter" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "deliverable_links" ADD COLUMN "from_point" text;--> statement-breakpoint
ALTER TABLE "deliverable_links" ADD COLUMN "to_point" text;--> statement-breakpoint
ALTER TABLE "deliverables" ADD COLUMN "canvas_w" real;--> statement-breakpoint
ALTER TABLE "deliverables" ADD COLUMN "canvas_h" real;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "notification_id" uuid;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "inbox" boolean DEFAULT true NOT NULL;--> statement-breakpoint
-- Existing boards keep their order (oldest first) and get numbers 1, 2, … per project.
UPDATE "boards" b SET "number" = n.rn, "position" = n.rn * 1024
FROM (SELECT "id", row_number() OVER (PARTITION BY "project_id" ORDER BY "created_at", "id") AS rn FROM "boards") n
WHERE n."id" = b."id";--> statement-breakpoint
ALTER TABLE "boards" ALTER COLUMN "number" SET NOT NULL;--> statement-breakpoint
UPDATE "projects" p SET "board_counter" = COALESCE((SELECT max(b."number") FROM "boards" b WHERE b."project_id" = p."id"), 0);--> statement-breakpoint
-- Member is split into Developer and Contributor. Everyone becomes a Contributor (no automatic access
-- to private projects), keeping explicit project memberships; admins promote trusted developers.
UPDATE "studio_members" SET "role" = 'CONTRIBUTOR' WHERE "role" = 'MEMBER';--> statement-breakpoint
UPDATE "project_members" SET "role" = 'CONTRIBUTOR' WHERE "role" = 'MEMBER';--> statement-breakpoint
UPDATE "invitations" SET "role" = 'CONTRIBUTOR' WHERE "role" = 'MEMBER';--> statement-breakpoint
-- Notifications about a revision belong to that revision's deliverable (the only unambiguous link).
UPDATE "notifications" n SET "deliverable_id" = v."deliverable_id"
FROM "asset_versions" v
WHERE n."version_id" = v."id" AND n."deliverable_id" IS NULL AND v."deliverable_id" IS NOT NULL;--> statement-breakpoint
-- …and so do notifications about a comment scoped to one deliverable. Card-wide comments stay card-wide.
UPDATE "notifications" n SET "deliverable_id" = c."deliverable_id"
FROM "comments" c
WHERE n."comment_id" = c."id" AND n."deliverable_id" IS NULL AND c."deliverable_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "push_deliveries" ADD CONSTRAINT "push_deliveries_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_deliveries" ADD CONSTRAINT "push_deliveries_subscription_id_push_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."push_subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_deliveries" ADD CONSTRAINT "push_deliveries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "push_deliveries_notification_device_uq" ON "push_deliveries" USING btree ("notification_id","subscription_id");--> statement-breakpoint
CREATE INDEX "push_deliveries_due_idx" ON "push_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "push_subscriptions_endpoint_uq" ON "push_subscriptions" USING btree ("endpoint");--> statement-breakpoint
CREATE INDEX "push_subscriptions_user_idx" ON "push_subscriptions" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_archived_by_id_users_id_fk" FOREIGN KEY ("archived_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_deliverable_id_deliverables_id_fk" FOREIGN KEY ("deliverable_id") REFERENCES "public"."deliverables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "boards_project_number_uq" ON "boards" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "notifications_card_idx" ON "notifications" USING btree ("card_id");--> statement-breakpoint
CREATE INDEX "boards_project_idx" ON "boards" USING btree ("project_id","position");