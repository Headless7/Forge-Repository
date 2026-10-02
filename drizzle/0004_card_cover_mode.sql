ALTER TABLE "cards" ADD COLUMN "cover_mode" text DEFAULT 'AUTO' NOT NULL;--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "cover_pinned_id" uuid;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_cover_pinned_id_attachments_id_fk" FOREIGN KEY ("cover_pinned_id") REFERENCES "public"."attachments"("id") ON DELETE set null ON UPDATE no action;