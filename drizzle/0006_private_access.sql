CREATE TABLE "activation_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key_hash" text NOT NULL,
	"hint" text NOT NULL,
	"label" text NOT NULL,
	"email" text,
	"created_by_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"claimed_by_id" uuid,
	"claimed_at" timestamp with time zone,
	"redeemed_at" timestamp with time zone,
	"studio_id" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "access" text DEFAULT 'STUDIO' NOT NULL;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "project_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "studio_members" ADD COLUMN "access" text DEFAULT 'STUDIO' NOT NULL;--> statement-breakpoint
ALTER TABLE "activation_keys" ADD CONSTRAINT "activation_keys_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activation_keys" ADD CONSTRAINT "activation_keys_claimed_by_id_users_id_fk" FOREIGN KEY ("claimed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activation_keys" ADD CONSTRAINT "activation_keys_studio_id_studios_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "activation_keys_hash_uq" ON "activation_keys" USING btree ("key_hash");