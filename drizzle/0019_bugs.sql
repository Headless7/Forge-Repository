CREATE TABLE "bug_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bug_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"author_id" uuid,
	"body" text NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bug_tag_links" (
	"bug_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	CONSTRAINT "bug_tag_links_bug_id_tag_id_pk" PRIMARY KEY("bug_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "bug_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bugs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
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
ALTER TABLE "attachments" ALTER COLUMN "card_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "bug_counter" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "bug_id" uuid;--> statement-breakpoint
ALTER TABLE "activity_events" ADD COLUMN "bug_id" uuid;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "bug_id" uuid;--> statement-breakpoint
ALTER TABLE "bug_comments" ADD CONSTRAINT "bug_comments_bug_id_bugs_id_fk" FOREIGN KEY ("bug_id") REFERENCES "public"."bugs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bug_comments" ADD CONSTRAINT "bug_comments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bug_comments" ADD CONSTRAINT "bug_comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bug_tag_links" ADD CONSTRAINT "bug_tag_links_bug_id_bugs_id_fk" FOREIGN KEY ("bug_id") REFERENCES "public"."bugs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bug_tag_links" ADD CONSTRAINT "bug_tag_links_tag_id_bug_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."bug_tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bug_tags" ADD CONSTRAINT "bug_tags_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bugs" ADD CONSTRAINT "bugs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bugs" ADD CONSTRAINT "bugs_milestone_id_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."milestones"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bugs" ADD CONSTRAINT "bugs_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bugs" ADD CONSTRAINT "bugs_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bugs" ADD CONSTRAINT "bugs_reported_by_id_users_id_fk" FOREIGN KEY ("reported_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bugs" ADD CONSTRAINT "bugs_fixed_by_id_users_id_fk" FOREIGN KEY ("fixed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bugs" ADD CONSTRAINT "bugs_verified_by_id_users_id_fk" FOREIGN KEY ("verified_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bugs" ADD CONSTRAINT "bugs_closed_by_id_users_id_fk" FOREIGN KEY ("closed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bug_comments_bug_idx" ON "bug_comments" USING btree ("bug_id","created_at");--> statement-breakpoint
CREATE INDEX "bug_tag_links_tag_idx" ON "bug_tag_links" USING btree ("tag_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bug_tags_project_name_uq" ON "bug_tags" USING btree ("project_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "bugs_project_number_uq" ON "bugs" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "bugs_project_status_idx" ON "bugs" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "bugs_milestone_idx" ON "bugs" USING btree ("milestone_id");--> statement-breakpoint
CREATE INDEX "bugs_assignee_idx" ON "bugs" USING btree ("assignee_id");--> statement-breakpoint
CREATE INDEX "bugs_reviewer_idx" ON "bugs" USING btree ("reviewer_id");--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_bug_id_bugs_id_fk" FOREIGN KEY ("bug_id") REFERENCES "public"."bugs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_bug_id_bugs_id_fk" FOREIGN KEY ("bug_id") REFERENCES "public"."bugs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_bug_id_bugs_id_fk" FOREIGN KEY ("bug_id") REFERENCES "public"."bugs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_bug_idx" ON "attachments" USING btree ("bug_id");--> statement-breakpoint
CREATE INDEX "activity_bug_created_idx" ON "activity_events" USING btree ("bug_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_bug_idx" ON "notifications" USING btree ("bug_id");