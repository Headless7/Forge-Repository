ALTER TABLE "checklist_items" ADD COLUMN "assignee_id" uuid;--> statement-breakpoint
ALTER TABLE "checklist_items" ADD COLUMN "due_on" date;--> statement-breakpoint
ALTER TABLE "checklist_items" ADD CONSTRAINT "checklist_items_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "checklist_items_assignee_idx" ON "checklist_items" USING btree ("assignee_id");