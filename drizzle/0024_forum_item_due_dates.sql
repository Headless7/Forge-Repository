ALTER TABLE "forum_items" ADD COLUMN "due_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "forum_items_due_idx" ON "forum_items" USING btree ("due_at");