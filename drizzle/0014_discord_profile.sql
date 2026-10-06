ALTER TABLE "oauth_accounts" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "oauth_accounts" ADD COLUMN "avatar_hash" text;--> statement-breakpoint
ALTER TABLE "oauth_accounts" ADD COLUMN "avatar_key" text;--> statement-breakpoint
ALTER TABLE "oauth_accounts" ADD COLUMN "access_token" text;--> statement-breakpoint
ALTER TABLE "oauth_accounts" ADD COLUMN "refresh_token" text;--> statement-breakpoint
ALTER TABLE "oauth_accounts" ADD COLUMN "token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "oauth_accounts" ADD COLUMN "profile_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "oauth_accounts" ADD COLUMN "sync_error" text;--> statement-breakpoint
ALTER TABLE "oauth_accounts" ADD COLUMN "sync_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_accounts" ADD COLUMN "next_sync_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "oauth_accounts" ADD COLUMN "sync_lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "oauth_accounts" ADD COLUMN "needs_reauth_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "custom_avatar_key" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "avatar_source" text DEFAULT 'custom' NOT NULL;--> statement-breakpoint
-- Existing uploaded photos become the retained "custom" photo (avatar_key stays the picture shown).
UPDATE "users" SET "custom_avatar_key" = "avatar_key" WHERE "avatar_key" IS NOT NULL;--> statement-breakpoint
-- Already-connected Discord members without an uploaded photo use their Discord picture by default.
-- It appears after their first successful profile refresh (until then their initials show, as before).
UPDATE "users" SET "avatar_source" = 'discord' WHERE "avatar_key" IS NULL AND EXISTS (SELECT 1 FROM "oauth_accounts" o WHERE o."user_id" = "users"."id" AND o."provider" = 'discord');
