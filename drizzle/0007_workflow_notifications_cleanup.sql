CREATE TABLE "deliverable_contributors" (
	"deliverable_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"added_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deliverable_contributors_deliverable_id_user_id_pk" PRIMARY KEY("deliverable_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "storage_deletions" (
	"prefix" text PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "deliverable_id" uuid;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "version_id" uuid;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
ALTER TABLE "deliverable_contributors" ADD CONSTRAINT "deliverable_contributors_deliverable_id_deliverables_id_fk" FOREIGN KEY ("deliverable_id") REFERENCES "public"."deliverables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverable_contributors" ADD CONSTRAINT "deliverable_contributors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverable_contributors" ADD CONSTRAINT "deliverable_contributors_added_by_id_users_id_fk" FOREIGN KEY ("added_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deliverable_contributors_user_idx" ON "deliverable_contributors" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "storage_deletions_next_idx" ON "storage_deletions" USING btree ("next_attempt_at");--> statement-breakpoint
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_deliverable_id_deliverables_id_fk" FOREIGN KEY ("deliverable_id") REFERENCES "public"."deliverables"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_version_id_asset_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."asset_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_user_dedupe_uq" ON "notifications" USING btree ("user_id","dedupe_key") WHERE "notifications"."dedupe_key" is not null;