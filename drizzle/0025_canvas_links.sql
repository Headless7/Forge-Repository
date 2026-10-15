CREATE TABLE "canvas_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"card_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"target_card_id" uuid NOT NULL,
	"target_deliverable_id" uuid,
	"needed" boolean DEFAULT false NOT NULL,
	"group_id" uuid,
	"canvas_x" real DEFAULT 0 NOT NULL,
	"canvas_y" real DEFAULT 0 NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "canvas_links" ADD CONSTRAINT "canvas_links_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvas_links" ADD CONSTRAINT "canvas_links_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvas_links" ADD CONSTRAINT "canvas_links_target_card_id_cards_id_fk" FOREIGN KEY ("target_card_id") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvas_links" ADD CONSTRAINT "canvas_links_target_deliverable_id_deliverables_id_fk" FOREIGN KEY ("target_deliverable_id") REFERENCES "public"."deliverables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvas_links" ADD CONSTRAINT "canvas_links_group_id_deliverable_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."deliverable_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvas_links" ADD CONSTRAINT "canvas_links_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "canvas_links_card_idx" ON "canvas_links" USING btree ("card_id");--> statement-breakpoint
CREATE INDEX "canvas_links_target_card_idx" ON "canvas_links" USING btree ("target_card_id");--> statement-breakpoint
CREATE INDEX "canvas_links_target_deliverable_idx" ON "canvas_links" USING btree ("target_deliverable_id");--> statement-breakpoint
CREATE INDEX "canvas_links_group_idx" ON "canvas_links" USING btree ("group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "canvas_links_card_uq" ON "canvas_links" USING btree ("card_id","target_card_id") WHERE "canvas_links"."target_deliverable_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "canvas_links_deliverable_uq" ON "canvas_links" USING btree ("card_id","target_deliverable_id") WHERE "canvas_links"."target_deliverable_id" is not null;