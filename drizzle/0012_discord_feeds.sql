CREATE TABLE "discord_connections" (
	"studio_id" uuid PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"guild_name" text NOT NULL,
	"guild_icon" text,
	"connected_by_id" uuid,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lost_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "discord_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"route_id" uuid NOT NULL,
	"event" jsonb NOT NULL,
	"dedupe_key" text NOT NULL,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"error" text,
	"message_id" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discord_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"studio_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"board_id" uuid,
	"channel_id" text NOT NULL,
	"channel_name" text NOT NULL,
	"events" text[] NOT NULL,
	"private_confirmed_at" timestamp with time zone,
	"private_confirmed_by_id" uuid,
	"created_by_id" uuid,
	"last_sent_at" timestamp with time zone,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "discord_connections" ADD CONSTRAINT "discord_connections_studio_id_studios_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_connections" ADD CONSTRAINT "discord_connections_connected_by_id_users_id_fk" FOREIGN KEY ("connected_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_deliveries" ADD CONSTRAINT "discord_deliveries_route_id_discord_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."discord_routes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_routes" ADD CONSTRAINT "discord_routes_studio_id_studios_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_routes" ADD CONSTRAINT "discord_routes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_routes" ADD CONSTRAINT "discord_routes_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_routes" ADD CONSTRAINT "discord_routes_private_confirmed_by_id_users_id_fk" FOREIGN KEY ("private_confirmed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_routes" ADD CONSTRAINT "discord_routes_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "discord_connections_guild_idx" ON "discord_connections" USING btree ("guild_id");--> statement-breakpoint
CREATE UNIQUE INDEX "discord_deliveries_route_key_uq" ON "discord_deliveries" USING btree ("route_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "discord_deliveries_due_idx" ON "discord_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "discord_routes_project_idx" ON "discord_routes" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "discord_routes_studio_idx" ON "discord_routes" USING btree ("studio_id");