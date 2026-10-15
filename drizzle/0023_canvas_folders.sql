CREATE TABLE "deliverable_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"card_id" uuid NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"color" text,
	"collapsed" boolean DEFAULT false NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deliverables" ADD COLUMN "group_id" uuid;--> statement-breakpoint
ALTER TABLE "deliverable_groups" ADD CONSTRAINT "deliverable_groups_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverable_groups" ADD CONSTRAINT "deliverable_groups_parent_id_deliverable_groups_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."deliverable_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverable_groups" ADD CONSTRAINT "deliverable_groups_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deliverable_groups_card_idx" ON "deliverable_groups" USING btree ("card_id");--> statement-breakpoint
CREATE INDEX "deliverable_groups_parent_idx" ON "deliverable_groups" USING btree ("parent_id");--> statement-breakpoint
ALTER TABLE "deliverables" ADD CONSTRAINT "deliverables_group_id_deliverable_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."deliverable_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deliverables_group_idx" ON "deliverables" USING btree ("group_id");