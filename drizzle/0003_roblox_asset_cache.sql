CREATE TABLE "roblox_asset_cache" (
	"studio_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"asset_id" text NOT NULL,
	"storage_key" text NOT NULL,
	"converted_key" text,
	"format" text NOT NULL,
	"filename" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roblox_asset_cache_studio_id_kind_asset_id_pk" PRIMARY KEY("studio_id","kind","asset_id")
);
--> statement-breakpoint
ALTER TABLE "roblox_asset_cache" ADD CONSTRAINT "roblox_asset_cache_studio_id_studios_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "roblox_asset_cache_last_accessed_idx" ON "roblox_asset_cache" USING btree ("last_accessed_at");--> statement-breakpoint
-- Assets fetched from Roblox used to be stored as permanent project resources. They now live
-- in roblox_asset_cache (freed after 7 days unused): drop those mappings so they are re-fetched
-- into the cache when next needed. Files people uploaded themselves are untouched.
DELETE FROM "roblox_resources" r USING "attachments" a WHERE a."id" = r."attachment_id" AND a."meta"->>'source' = 'roblox';--> statement-breakpoint
UPDATE "attachments" SET "archived_at" = now() WHERE "purpose" = 'RESOURCE' AND "meta"->>'source' = 'roblox' AND "archived_at" IS NULL;
