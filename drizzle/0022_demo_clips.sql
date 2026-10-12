ALTER TABLE "attachments" ADD COLUMN "demo_of_id" uuid;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_demo_of_id_attachments_id_fk" FOREIGN KEY ("demo_of_id") REFERENCES "public"."attachments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_demo_of_idx" ON "attachments" USING btree ("demo_of_id");