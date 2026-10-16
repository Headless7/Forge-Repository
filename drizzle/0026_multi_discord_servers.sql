-- A studio can connect several Discord servers: a connection is now one studio and one server.
ALTER TABLE "discord_connections" DROP CONSTRAINT "discord_connections_pkey";--> statement-breakpoint
ALTER TABLE "discord_connections" ADD CONSTRAINT "discord_connections_studio_id_guild_id_pk" PRIMARY KEY("studio_id","guild_id");--> statement-breakpoint
-- Each project posts to one of its studio's servers. Existing projects keep the server their studio has now.
ALTER TABLE "projects" ADD COLUMN "discord_guild_id" text;--> statement-breakpoint
UPDATE "projects" SET "discord_guild_id" = c."guild_id" FROM "discord_connections" c WHERE c."studio_id" = "projects"."studio_id";--> statement-breakpoint
-- Each feed remembers the server its channel is in, so existing feeds keep posting.
ALTER TABLE "discord_routes" ADD COLUMN "guild_id" text;--> statement-breakpoint
UPDATE "discord_routes" SET "guild_id" = c."guild_id" FROM "discord_connections" c WHERE c."studio_id" = "discord_routes"."studio_id";--> statement-breakpoint
-- A feed without a connected server could never post (disconnecting already removed them).
DELETE FROM "discord_routes" WHERE "guild_id" IS NULL;--> statement-breakpoint
ALTER TABLE "discord_routes" ALTER COLUMN "guild_id" SET NOT NULL;
